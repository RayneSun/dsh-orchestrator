import { describe, expect, it, vi } from 'vitest'
import { OrchestratorService } from '../src/service.ts'
import { createConversation, createTask, type ConversationRecord, type TaskRecord } from '../src/types.ts'
import { activateConversation } from '../src/state-machine.ts'

/**
 * reportFromWorker 是 OrchestratorService 的私有方法；这里用最小桩宿主直接调用真实实现，
 * 验证活动任务上报后的 Conversation/Task 持久化契约（issue #15 的状态同步缺口）。
 */
function harness() {
  const conv = activateConversation(
    createConversation({ id: 'conv_1', childSessionId: 'child-1', parentSessionId: 'parent-1', title: '演示会话' }),
    'task_1',
  )
  const task: TaskRecord = { ...createTask({
    id: 'task_1', parentSessionId: 'parent-1', conversationId: 'conv_1', predecessorTaskId: null,
    subject: '演示任务', prompt: 'do',
  }), status: 'running', startedAt: conv.updatedAt }
  const saved: Array<{ conv: ConversationRecord, task?: TaskRecord }> = []
  const fake: Record<string, unknown> = {
    serialize: (fn: () => Promise<unknown>) => fn(),
    conversationByChild: () => conv,
    taskById: (id: string) => id === 'task_1' ? task : undefined,
    schedulesOf: () => [],
    deliveryToggles: () => ({ completed: true, failed: true, interrupted: true }),
    putPair: async (c: ConversationRecord, t?: TaskRecord) => { saved.push({ conv: c, task: t }) },
    latestModels: new Map(),
    scheduledTurns: new Map(),
    blockAndWaitForAnswers: async () => [{ id: 'q1', selected: ['A'] }],
    deliverPendingTask: async () => {},
    hostCtx: { logger: { warn() {}, info() {} }, emit() {} },
  }
  const call = (args: unknown, status = 'input_required') =>
    (OrchestratorService.prototype as unknown as Record<string, (...args: unknown[]) => Promise<any>>).reportFromWorker!
      .call(fake, status, args, 'child-1')
  return { call, saved }
}

describe('reportFromWorker：活动任务上报后的 Conversation 状态同步', () => {
  it('input_required 上报后 Conversation.state 同步为 input_required 且保留 activeTaskId', async () => {
    const { call, saved } = harness()
    const result = await call({
      questions: [{ id: 'q1', question: '选 A 还是 B？' }],
    })
    expect(saved).toHaveLength(1)
    expect(saved[0].task?.status).toBe('input_required')
    expect(saved[0].conv.state).toBe('input_required')
    // 轮次未结束：activeTaskId 保留，作答入口按 lastTaskId/activeTaskId 反查同一 TaskRun。
    expect(saved[0].conv.activeTaskId).toBe('task_1')
    expect(saved[0].conv.lastTaskId).toBe('task_1')
    expect(result.status).toBe('input_required_answered')
  })

  it('completed 上报后 Conversation 回 idle（既有聚合不被破坏）', async () => {
    const { call, saved } = harness()
    await call({ result: '完成' }, 'completed')
    expect(saved[0].task?.status).toBe('completed')
    expect(saved[0].conv.state).toBe('idle')
    expect(saved[0].conv.activeTaskId).toBeNull()
  })
})


describe('task_todo 独立更新', () => {
  it('创建待办/日程写库后广播一次变更，回执使用 todos，校验失败不写库不广播', async () => {
    const service = Object.create(OrchestratorService.prototype)
    const conv = createConversation({ id: 'c', childSessionId: 'child', parentSessionId: 'p', title: '日程' })
    const put = vi.fn()
    const emitChanged = vi.fn()
    Object.assign(service, {
      serialize: (fn: () => Promise<unknown>) => fn(), conversationByChild: () => conv,
      schedulesOf: () => [], schedules: () => ({ put }), emitChanged,
    })
    const result = await service.todoFromWorker({ create: [{ title: '事项' }] }, 'child')
    expect(result).toEqual({ ok: true, todos: [] })
    expect(result).not.toHaveProperty('schedules')
    expect(put).toHaveBeenCalledOnce()
    expect(emitChanged).toHaveBeenCalledOnce()
    await expect(service.todoFromWorker({ update: [{ id: 'missing', status: 'done' }] }, 'child')).rejects.toThrow()
    expect(put).toHaveBeenCalledOnce()
    expect(emitChanged).toHaveBeenCalledOnce()
  })
})
