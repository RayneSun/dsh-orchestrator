import type { BlockReasonCode, ConversationRecord, DeliveryToggles, TaskRecord, TaskReport, TaskStatus } from './types.ts'
import { deliverableTaskStatuses, taskUpdateFieldAllowList, terminalTaskStatuses } from './types.ts'

export class StateError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'StateError'
  }
}

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['running', 'input_required', 'blocked', 'completed', 'failed', 'interrupted'],
  running: ['running', 'input_required', 'blocked', 'completed', 'failed', 'interrupted'],
  input_required: [],
  blocked: [],
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
  const state = task.status === 'completed'
    ? 'idle'
    : task.status === 'input_required'
      ? 'input_required'
      : task.status === 'failed' || task.status === 'blocked'
        // Worker 主动上报失败/受阻时，持久子会话本身仍可复用；Host 致命错误会再 failConversation。
        ? 'idle'
        : task.status === 'interrupted'
          // 手动停止/改单都保留可继续的工作流，不能进入 failed。
          ? 'idle'
          : conv.state
  return { ...touch(conv, at), state, activeTaskId: null, lastTaskId: task.id }
}

/** Worker 通过 task_update 的 summary 维护路由卡一句话摘要（其余 outline 字段保留兼容，不再写入）。 */
export function updateOutlineSummary(
  conv: ConversationRecord,
  summary: string,
  at = new Date().toISOString(),
): ConversationRecord {
  const next = touch(conv, at)
  return { ...next, outline: { ...next.outline, summary } }
}

/** Worker 上报的终态自动挂起投递；静默任务与 interrupted 不投递。 */
function withTerminalDelivery(task: TaskRecord, status: TaskStatus): TaskRecord['delivery'] {
  return !task.silent && (deliverableTaskStatuses as readonly TaskStatus[]).includes(status)
    ? { state: 'pending', attempts: 0 }
    : undefined
}

/**
 * 投递开关判定（设置页，volatile 即时生效）：关闭的终态不投递。
 * toggles 缺失（未注入配置）时按默认全开处理，与历史行为一致。
 */
export function deliveryEnabledFor(toggles: DeliveryToggles | undefined, status: TaskStatus): boolean {
  if (!toggles) return true
  switch (status) {
    case 'input_required': return toggles.inputRequired
    case 'blocked': return toggles.blocked
    case 'completed': return toggles.completed
    case 'failed': return toggles.failed
    case 'interrupted': return toggles.interrupted
    default: return true
  }
}

/**
 * 投递开关在服务层的统一闸门：开关关闭的终态剥掉 pending（与 silent 同效）。
 * 只影响"消息是否回投主会话"，任务状态/摘要/待办的持久化与 roster、看板更新不受影响。
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
  status: Extract<TaskStatus, 'running' | 'input_required' | 'blocked' | 'completed' | 'failed'>
  title?: string
  progressNote?: string
  summary?: string
  report?: TaskReport
  error?: string
  question?: string
  reasonCode?: BlockReasonCode
  remediation?: string
}

export function transitionTask(task: TaskRecord, input: TaskTransitionInput, at = new Date().toISOString()): TaskRecord {
  if (!canTransition(task.status, input.status)) {
    throw new StateError('invalid_task_transition', `task cannot move from ${task.status} to ${input.status}`)
  }
  const error = input.error ?? task.error
  if (input.status === 'completed' && !(input.report ?? task.report)?.result?.trim()) {
    throw new StateError('missing_report', 'completed task_update requires report.result')
  }
  if ((input.status === 'failed' || input.status === 'blocked') && !error?.trim()) {
    throw new StateError('missing_error', `${input.status} task_update requires error`)
  }
  if (input.status === 'input_required' && !input.question?.trim()) {
    throw new StateError('missing_question', 'input_required task_update requires question')
  }
  const allowedFields = new Set(taskUpdateFieldAllowList[input.status])
  for (const [field, value] of Object.entries(input) as Array<[string, unknown]>) {
    if (field !== 'status' && value !== undefined && !allowedFields.has(field)) {
      throw new StateError('invalid_task_update_fields', `${field} is not allowed on a ${input.status} task_update`)
    }
  }

  const isInputRequired = input.status === 'input_required'
  const isBlocked = input.status === 'blocked'
  const isFailed = input.status === 'failed'
  const isCompleted = input.status === 'completed'
  const terminal = isTerminal(input.status)
  return {
    ...touch(task, at),
    status: input.status,
    title: input.title ?? task.title,
    progressNote: input.progressNote ?? task.progressNote,
    report: isCompleted ? (input.report ?? task.report) : undefined,
    error: isBlocked || isFailed ? (input.error ?? task.error) : undefined,
    question: isInputRequired ? input.question : undefined,
    reasonCode: isBlocked ? input.reasonCode : undefined,
    remediation: isBlocked ? input.remediation : undefined,
    ...terminal
      ? { endedAt: at, delivery: withTerminalDelivery(task, input.status) }
      : { startedAt: task.startedAt ?? at },
  }
}

export function failTask(task: TaskRecord, error: string, at = new Date().toISOString()): TaskRecord {
  if (isTerminal(task.status)) return task
  return {
    ...touch(task, at),
    status: 'failed',
    error,
    endedAt: at,
    ...task.silent ? {} : { delivery: { state: 'pending' as const, attempts: 0 } },
  }
}

/** Host 确认系统/环境阻碍时使用；任务停止但持久子会话仍保留，用户处理后可复用。 */
export function blockTask(
  task: TaskRecord,
  error: string,
  options: { reasonCode?: BlockReasonCode; remediation?: string } = {},
  at = new Date().toISOString(),
): TaskRecord {
  if (isTerminal(task.status)) return task
  return {
    ...touch(task, at),
    status: 'blocked',
    error,
    ...options.reasonCode ? { reasonCode: options.reasonCode } : {},
    ...options.remediation ? { remediation: options.remediation } : {},
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
