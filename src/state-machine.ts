import type { BlockReasonCode, ConversationRecord, DeliveryToggles, QuestionAnswer, QuestionItem, TaskFail, TaskRecord, TaskReport, TaskStatus } from './types.ts'
import { defaultDeliveryToggles, deliverableTaskStatuses, taskUpdateFieldAllowList, terminalTaskStatuses } from './types.ts'

export class StateError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'StateError'
  }
}

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['running', 'input_required', 'completed', 'failed', 'interrupted'],
  running: ['running', 'input_required', 'completed', 'failed', 'interrupted'],
  input_required: [],
  completed: [],
  failed: [],
  interrupted: [],
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to)
}

export function isTerminal(status: TaskStatus): boolean {
  return (terminalTaskStatuses as readonly TaskStatus[]).includes(status)
}

export type WorkerTurnEndCause = 'manual_stop' | 'revision'

/**
 * Distinguish durable cancellation causes recorded on turn/end. A user stop
 * must notify Lead; an ancestor cancellation is an orchestrator revision.
 */
export function classifyWorkerTurnEnd(reason: unknown): WorkerTurnEndCause | undefined {
  if (!reason || typeof reason !== 'object') return undefined
  const aborted = reason as { kind?: unknown; reason?: unknown }
  if (aborted.kind !== 'aborted' || !aborted.reason || typeof aborted.reason !== 'object') return undefined
  const cause = (aborted.reason as { kind?: unknown }).kind
  if (cause === 'user') return 'manual_stop'
  if (cause === 'parent') return 'revision'
  return undefined
}

function touch<T extends { revision: number; updatedAt: string }>(value: T, at: string): T {
  return { ...value, revision: value.revision + 1, updatedAt: at }
}

export function startConversation(conv: ConversationRecord, at = new Date().toISOString()): ConversationRecord {
  if (conv.state !== 'provisioning') throw new StateError('invalid_conversation_transition', 'conversation is not provisioning')
  return { ...touch(conv, at), state: 'running' }
}

export function failConversation(conv: ConversationRecord, at = new Date().toISOString()): ConversationRecord {
  if (conv.state === 'failed') return conv
  return { ...touch(conv, at), state: 'failed' }
}

export function activateConversation(conv: ConversationRecord, taskId: string, at = new Date().toISOString()): ConversationRecord {
  if (conv.activeTaskId && conv.activeTaskId !== taskId) {
    throw new StateError('conversation_busy', `conversation ${conv.id} already runs task ${conv.activeTaskId}`)
  }
  if (conv.state === 'failed') throw new StateError('conversation_failed', `conversation ${conv.id} has failed`)
  if (conv.state === 'provisioning') return { ...touch(conv, at), activeTaskId: taskId, lastTaskId: taskId }
  return { ...touch(conv, at), state: 'running', activeTaskId: taskId, lastTaskId: taskId }
}

export function settleConversation(
  conv: ConversationRecord,
  task: TaskRecord,
  at = new Date().toISOString(),
): ConversationRecord {
  const state = task.status === 'completed' || task.status === 'failed' || task.status === 'interrupted'
    // Worker 上报失败/中断时，持久子会话本身仍可复用；Host 致命错误会再 failConversation。
    ? 'idle'
    : task.status === 'input_required'
      ? 'input_required'
      : conv.state
  return { ...touch(conv, at), state, activeTaskId: null, lastTaskId: task.id }
}

/**
 * 会话路由卡摘要改由 Host 维护：每次 dispatch 把 subject 追加进最近主题链
 * （去重、保序、最多 5 个），不再依赖 Worker 上报 summary。
 */
export function appendOutlineSubject(
  conv: ConversationRecord,
  subject: string,
  at = new Date().toISOString(),
): ConversationRecord {
  const text = subject.trim()
  if (!text) return conv
  const history = conv.outline.summary.split('｜').map(item => item.trim()).filter(Boolean)
  const next = [...history.filter(item => item !== text), text].slice(-5)
  const summary = next.join('｜')
  if (summary === conv.outline.summary) return conv
  return { ...touch(conv, at), outline: { ...conv.outline, summary } }
}

/** Worker 上报的终态自动挂起投递；静默任务与 interrupted 不投递。 */
function withTerminalDelivery(task: TaskRecord, status: TaskStatus): TaskRecord['delivery'] {
  return !task.silent && (deliverableTaskStatuses as readonly TaskStatus[]).includes(status)
    ? { state: 'pending', attempts: 0 }
    : undefined
}

/**
 * 投递开关判定（设置页，volatile 即时生效）：关闭的终态不投递。
 * toggles 缺失（未注入配置）时按默认值处理（inputRequired 默认关，其余开）。
 */
export function deliveryEnabledFor(toggles: DeliveryToggles | undefined, status: TaskStatus): boolean {
  if (!toggles) return defaultDeliveryEnabled(status)
  switch (status) {
    case 'input_required': return toggles.inputRequired
    case 'completed': return toggles.completed
    case 'failed': return toggles.failed
    case 'interrupted': return toggles.interrupted
    default: return true
  }
}

function defaultDeliveryEnabled(status: TaskStatus): boolean {
  switch (status) {
    case 'input_required': return defaultDeliveryToggles.inputRequired
    case 'completed': return defaultDeliveryToggles.completed
    case 'failed': return defaultDeliveryToggles.failed
    case 'interrupted': return defaultDeliveryToggles.interrupted
    default: return true
  }
}

/**
 * 投递开关在服务层的统一闸门：开关关闭的终态剥掉 pending（与 silent 同效）。
 * 只影响"消息是否回投主会话"，任务状态/进度/待办的持久化与 roster、看板更新不受影响。
 */
export function gateTaskDelivery(task: TaskRecord, toggles: DeliveryToggles | undefined): TaskRecord {
  if (task.delivery?.state !== 'pending' || deliveryEnabledFor(toggles, task.status)) return task
  const { delivery: _dropped, ...rest } = task
  return rest
}

/** task_update 成功后是否直接结束本轮推理：终态全部结束，仅 running 继续。 */
export function statusConcludesTurn(status: string | undefined): boolean {
  return status !== undefined && status !== 'running'
}

export interface TaskTransitionInput {
  status: Extract<TaskStatus, 'running' | 'input_required' | 'completed' | 'failed'>
  header?: string
  progressNote?: string
  report?: TaskReport
  questions?: QuestionItem[]
  fail?: TaskFail
}

export function transitionTask(task: TaskRecord, input: TaskTransitionInput, at = new Date().toISOString()): TaskRecord {
  if (!canTransition(task.status, input.status)) {
    throw new StateError('invalid_task_transition', `task cannot move from ${task.status} to ${input.status}`)
  }
  if (input.status === 'completed' && !(input.report ?? task.report)?.result?.trim()) {
    throw new StateError('missing_report', 'completed task_update requires report.result')
  }
  if (input.status === 'failed' && !(input.fail ?? task.fail)?.error?.trim()) {
    throw new StateError('missing_error', 'failed task_update requires fail.error')
  }
  if (input.status === 'input_required' && !(input.questions?.length)) {
    throw new StateError('missing_questions', 'input_required task_update requires questions')
  }
  const allowedFields = new Set(taskUpdateFieldAllowList[input.status])
  for (const [field, value] of Object.entries(input) as Array<[string, unknown]>) {
    if (field !== 'status' && value !== undefined && !allowedFields.has(field)) {
      throw new StateError('invalid_task_update_fields', `${field} is not allowed on a ${input.status} task_update`)
    }
  }

  const isInputRequired = input.status === 'input_required'
  const isFailed = input.status === 'failed'
  const isCompleted = input.status === 'completed'
  const terminal = isTerminal(input.status)
  return {
    ...touch(task, at),
    status: input.status,
    header: input.header ?? task.header,
    progressNote: input.progressNote ?? task.progressNote,
    report: isCompleted ? (input.report ?? task.report) : undefined,
    questions: isInputRequired ? input.questions : undefined,
    answers: isInputRequired ? task.answers : undefined,
    fail: isFailed ? (input.fail ?? task.fail) : undefined,
    ...terminal
      ? { endedAt: at, delivery: withTerminalDelivery(task, input.status) }
      : { startedAt: task.startedAt ?? at },
  }
}

/**
 * 用户作答后 Host 重开同一 TaskRun（input_required → running，不走普通 transition 校验）：
 * 保留原任务的进展与轮次，看板上表现为同一轮继续执行。
 */
export function resumeTaskWithAnswers(
  task: TaskRecord,
  answers: QuestionAnswer[],
  at = new Date().toISOString(),
): TaskRecord {
  if (task.status !== 'input_required') {
    throw new StateError('task_not_awaiting_input', `task ${task.id} is not awaiting user input`)
  }
  return {
    ...touch(task, at),
    status: 'running',
    questions: task.questions,
    answers,
    endedAt: undefined,
    delivery: undefined,
    progressNote: '收到回答，继续执行',
  }
}

export function failTask(
  task: TaskRecord,
  error: string,
  at = new Date().toISOString(),
  options: { reasonCode?: BlockReasonCode } = {},
): TaskRecord {
  if (isTerminal(task.status)) return task
  return {
    ...touch(task, at),
    status: 'failed',
    fail: { error, ...options.reasonCode ? { reasonCode: options.reasonCode } : {} },
    endedAt: at,
    ...task.silent ? {} : { delivery: { state: 'pending' as const, attempts: 0 } },
  }
}

/** 进程重启时任务仍在运行：保留进展并标记中断，不冒充用户提问；恢复后可在同一子会话继续。 */
export function interruptTaskAfterRestart(task: TaskRecord, at = new Date().toISOString()): TaskRecord {
  if (isTerminal(task.status)) return task
  return {
    ...touch(task, at),
    status: 'interrupted',
    cancelledReason: '服务重启导致执行中断，已有进展已保留',
    endedAt: at,
  }
}

/** 改单/补充需求时旧任务进入 interrupted；手动停止若需通知，由调用方补 delivery。 */
export function interruptTaskForRevision(task: TaskRecord, reason: string, at = new Date().toISOString()): TaskRecord {
  if (isTerminal(task.status)) return task
  return {
    ...touch(task, at),
    status: 'interrupted',
    cancelledReason: reason,
    delivery: undefined,
    endedAt: at,
  }
}

/** 把 Conversation 从旧活动任务原子切换到改单后的新任务；不能走普通 activate 的 busy 校验。 */
export function reviseConversation(
  conv: ConversationRecord,
  nextTaskId: string,
  at = new Date().toISOString(),
): ConversationRecord {
  if (conv.state === 'failed') throw new StateError('conversation_failed', `conversation ${conv.id} has failed`)
  return {
    ...touch(conv, at),
    state: 'running',
    activeTaskId: nextTaskId,
    lastTaskId: nextTaskId,
  }
}
