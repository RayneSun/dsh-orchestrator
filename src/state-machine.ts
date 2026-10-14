import type { ConversationRecord, OutlinePatch, TaskRecord, TaskStatus } from './types.ts'
import { terminalTaskStatuses } from './types.ts'

export class StateError extends Error {
  constructor(public code: string, message: string) {
    super(message)
    this.name = 'StateError'
  }
}

const transitions: Record<TaskStatus, readonly TaskStatus[]> = {
  queued: ['running', 'blocked', 'completed', 'failed', 'cancelled'],
  running: ['running', 'blocked', 'completed', 'failed', 'cancelled'],
  blocked: [],
  completed: [],
  failed: [],
  cancelled: [],
}

export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return transitions[from].includes(to)
}

export function isTerminal(status: TaskStatus): boolean {
  return (terminalTaskStatuses as readonly TaskStatus[]).includes(status)
}

function touch<T extends { revision: number; updatedAt: string }>(value: T, at: string): T {
  return { ...value, revision: value.revision + 1, updatedAt: at }
}

/** V1 状态只在单进程串行队列中修改；该 helper 让存储层仍可做乐观锁检查。 */
export function assertRevision(current: { revision: number }, expected: number | undefined): void {
  if (expected !== undefined && current.revision !== expected) {
    throw new StateError('revision_conflict', `expected revision ${expected}, found ${current.revision}`)
  }
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
    : task.status === 'blocked'
      ? 'blocked'
      : task.status === 'failed'
        ? 'failed'
        : conv.state
  return { ...touch(conv, at), state, activeTaskId: null, lastTaskId: task.id }
}

function uniqueList(values: readonly string[]): string[] {
  return [...new Set(values.map(item => item.trim()).filter(Boolean))]
}

function mergeList(current: readonly string[], patch: readonly string[] | undefined, append: boolean): string[] {
  if (patch === undefined) return [...current]
  return append ? uniqueList([...current, ...patch]) : uniqueList(patch)
}

export function applyOutlinePatch(
  conv: ConversationRecord,
  patch: OutlinePatch,
  at = new Date().toISOString(),
): ConversationRecord {
  const next = touch(conv, at)
  return {
    ...next,
    title: patch.title?.trim() || conv.title,
    outline: {
      summary: patch.summary ?? conv.outline.summary,
      keyFacts: mergeList(conv.outline.keyFacts, patch.keyFacts, true),
      entities: mergeList(conv.outline.entities, patch.entities, true),
      tags: mergeList(conv.outline.tags, patch.tags, true),
      artifacts: mergeList(conv.outline.artifacts, patch.artifacts, true),
      openQuestions: mergeList(conv.outline.openQuestions, patch.openQuestions, false),
    },
  }
}

export interface TaskUpdateInput {
  status: Extract<TaskStatus, 'running' | 'blocked' | 'completed' | 'failed'>
  progressNote?: string
  userAnswer?: string
  resultSummary?: string
  error?: string
  outlinePatch?: OutlinePatch
}

export function transitionTask(task: TaskRecord, input: TaskUpdateInput, at = new Date().toISOString()): TaskRecord {
  if (!canTransition(task.status, input.status)) {
    throw new StateError('invalid_task_transition', `task cannot move from ${task.status} to ${input.status}`)
  }
  const userAnswer = input.userAnswer ?? task.userAnswer
  const error = input.error ?? task.error
  if (input.status === 'completed' && !userAnswer?.trim()) {
    throw new StateError('missing_user_answer', 'completed task_update requires userAnswer')
  }
  if (input.status === 'failed' && !error?.trim()) {
    throw new StateError('missing_error', 'failed task_update requires error')
  }
  if (input.status === 'blocked' && !(error ?? input.progressNote ?? task.progressNote)?.trim()) {
    throw new StateError('missing_blocked_reason', 'blocked task_update requires error or progressNote')
  }
  const terminal = isTerminal(input.status)
  return {
    ...touch(task, at),
    status: input.status,
    ...input.progressNote !== undefined ? { progressNote: input.progressNote } : {},
    ...input.userAnswer !== undefined ? { userAnswer: input.userAnswer } : {},
    ...input.resultSummary !== undefined
      ? { resultSummary: input.resultSummary }
      : input.status === 'completed' && !task.resultSummary && userAnswer
        ? { resultSummary: userAnswer.slice(0, 180) }
        : {},
    ...input.error !== undefined ? { error: input.error } : {},
    ...input.outlinePatch !== undefined ? { outlinePatch: input.outlinePatch } : {},
    ...terminal ? { endedAt: at } : { startedAt: task.startedAt ?? at },
  }
}

export function failTask(task: TaskRecord, error: string, at = new Date().toISOString()): TaskRecord {
  if (isTerminal(task.status)) return task
  return {
    ...touch(task, at),
    status: 'failed',
    error,
    endedAt: at,
    ...task.responseMode === 'background' ? { delivery: { state: 'pending', attempts: 0 } } : {},
  }
}

export function failTaskWithoutTerminalReport(task: TaskRecord, at = new Date().toISOString()): TaskRecord {
  return failTask(task, '子会话结束前未提交终态 task_update', at)
}

export function interruptTaskAfterRestart(task: TaskRecord, at = new Date().toISOString()): TaskRecord {
  if (isTerminal(task.status)) return task
  return {
    ...touch(task, at),
    status: 'blocked',
    progressNote: '重启时任务仍在运行，已暂停等待 Lead 决定是否重新派发',
    error: '进程重启中断了未完成任务，且未收到终态上报',
    endedAt: at,
    ...task.responseMode === 'background' ? { delivery: { state: 'pending', attempts: 0 } } : {},
  }
}
