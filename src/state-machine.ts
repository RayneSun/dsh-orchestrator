import type { BlockReasonCode, ConversationRecord, DeliveryToggles, QuestionAnswer, QuestionItem, TaskRecord, TaskStatus, TaskRunningInput, TaskCompletedInput, TaskFailedInput, TaskInputRequiredInput } from './types.ts'
import { defaultDeliveryToggles, terminalTaskStatuses } from './types.ts'
import { isUnfinishedTask } from './task-lifecycle.ts'

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

/**
 * input_required 阻塞等待作答：会话聚合状态同步为待决策（消费方约定非 idle 会话读 Conversation.state），
 * 但轮次未结束——activeTaskId 保留，作答后由 answerTaskQuestions 回 running 并重开同一 TaskRun。
 */
export function awaitingConversation(conv: ConversationRecord, at = new Date().toISOString()): ConversationRecord {
  return { ...touch(conv, at), state: 'input_required' }
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
 * API 的最近派发主题链：去重、保序、最多 5 个。
 * Roster 不读取此字段，而是实时投影任务记录。
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
  return !task.silent && isTerminal(status)
    ? { state: 'pending', attempts: 0 }
    : undefined
}

/**
 * 投递开关判定（设置页，volatile 即时生效）：关闭的终态不投递。
 * toggles 缺失（未注入配置）时按默认值处理（仅三种终态可投递）。
 */
export function deliveryEnabledFor(toggles: DeliveryToggles | undefined, status: TaskStatus): boolean {
  const resolved = toggles ?? defaultDeliveryToggles
  switch (status) {
    case 'input_required': return false
    case 'completed': return resolved.completed
    case 'failed': return resolved.failed
    case 'interrupted': return resolved.interrupted
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

/** 状态上报成功后是否直接结束本轮推理：终态（completed/failed）全部结束，其余继续。 */
export function statusConcludesTurn(status: string | undefined): boolean {
  return status === 'completed' || status === 'failed'
}

/** 四个状态上报工具的输入（已拍平，与存储同形）：必填差异字段收敛到 1 个。 */
export type TaskTransitionInput =
  | ({ status: 'running' } & TaskRunningInput)
  | ({ status: 'input_required', questions: QuestionItem[] } & Omit<TaskInputRequiredInput, 'questions'>)
  | ({ status: 'completed' } & TaskCompletedInput)
  | ({ status: 'failed' } & TaskFailedInput)

export function transitionTask(task: TaskRecord, input: TaskTransitionInput, at = new Date().toISOString()): TaskRecord {
  if (!canTransition(task.status, input.status)) {
    throw new StateError('invalid_task_transition', `task cannot move from ${task.status} to ${input.status}`)
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
    // 拍平存储：终态字段整体重写，非对应终态字段清空（同一 TaskRun 只保留最后一份终态数据）。
    result: isCompleted ? input.result : undefined,
    artifacts: isCompleted ? input.artifacts : undefined,
    card: isCompleted ? input.card : undefined,
    questions: isInputRequired ? input.questions : task.answers?.length ? task.questions : undefined,
    answers: isInputRequired ? undefined : task.answers,
    error: isFailed ? input.error : undefined,
    reasonCode: isFailed ? input.reasonCode : undefined,
    ...terminal
      ? { endedAt: at, delivery: withTerminalDelivery(task, input.status) }
      : { startedAt: task.startedAt ?? at },
  }
}

/** 同一原生定时任务再次触发时覆盖它已有的完成结果，不开放通用的 completed → completed。 */
export function overwriteScheduledCompletion(
  task: TaskRecord,
  input: TaskCompletedInput,
  options: { scheduleId: string; startedAt: string },
  at = new Date().toISOString(),
): TaskRecord {
  if (task.status !== 'completed' || !task.scheduleIds.includes(options.scheduleId)) {
    throw new StateError('invalid_scheduled_completion', `task ${task.id} cannot accept completion for schedule ${options.scheduleId}`)
  }
  return {
    ...touch(task, at),
    // 每一次定时触发都是新执行；未上报新标题/进展时清除上一轮文案，折叠态直接展示本次结果。
    header: input.header,
    progressNote: input.progressNote,
    result: input.result,
    artifacts: input.artifacts,
    card: input.card,
    questions: undefined,
    answers: undefined,
    progressSteps: [],
    error: undefined,
    reasonCode: undefined,
    cancelledReason: undefined,
    lastScheduleId: options.scheduleId,
    startedAt: options.startedAt,
    endedAt: at,
    delivery: withTerminalDelivery(task, 'completed'),
  }
}

/** 定时来源的完整状态机：允许新一轮 running/input_required/completed/failed，且只作用于关联 Task。 */
export function transitionScheduledTask(
  task: TaskRecord,
  input: TaskTransitionInput,
  options: { scheduleId: string; startedAt: string },
  at = new Date().toISOString(),
): TaskRecord {
  if (!task.scheduleIds.includes(options.scheduleId)) {
    throw new StateError('invalid_scheduled_transition', `task ${task.id} cannot accept update for schedule ${options.scheduleId}`)
  }
  if (task.status === 'completed' && input.status === 'completed') {
    return overwriteScheduledCompletion(task, input, options, at)
  }
  if (task.status === 'input_required') {
    throw new StateError('invalid_scheduled_transition', `task ${task.id} is still awaiting user input`)
  }
  if (isTerminal(task.status)) {
    // 上一次定时执行已经结束：先重开同一 Task，再应用本次上报，不产生新的任务记录。
    const reopened: TaskRecord = {
      ...task,
      status: 'running',
      header: undefined,
      progressNote: undefined,
      result: undefined,
      artifacts: undefined,
      card: undefined,
      questions: undefined,
      answers: undefined,
      progressSteps: [],
      error: undefined,
      reasonCode: undefined,
      cancelledReason: undefined,
      lastScheduleId: options.scheduleId,
      startedAt: options.startedAt,
      endedAt: undefined,
      delivery: undefined,
    }
    return transitionTask(reopened, input, at)
  }
  return transitionTask({
    ...task,
    lastScheduleId: options.scheduleId,
    startedAt: options.startedAt,
  }, input, at)
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
  if (!isUnfinishedTask(task.status)) return task
  return {
    ...touch(task, at),
    status: 'failed',
    error,
    ...options.reasonCode ? { reasonCode: options.reasonCode } : {},
    endedAt: at,
    ...task.silent ? {} : { delivery: { state: 'pending' as const, attempts: 0 } },
  }
}

/** 进程重启时任务仍在运行：保留进展并标记中断，不冒充用户提问；恢复后可在同一子会话继续。 */
export function interruptTaskAfterRestart(task: TaskRecord, at = new Date().toISOString()): TaskRecord {
  if (!isUnfinishedTask(task.status)) return task
  return {
    ...touch(task, at),
    status: 'interrupted',
    cancelledReason: '服务重启导致执行中断，已有进展已保留',
    endedAt: at,
    delivery: undefined,
  }
}

/** 改单/补充需求时旧任务进入 interrupted；手动停止若需通知，由调用方补 delivery。 */
export function interruptTaskForRevision(task: TaskRecord, reason: string, at = new Date().toISOString()): TaskRecord {
  if (!isUnfinishedTask(task.status)) return task
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
