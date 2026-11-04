import { describe, expect, it } from 'vitest'
import { OrchestratorService } from '../src/service.ts'
import { createConversation, createTask, type ConversationRecord, type TaskRecord } from '../src/types.ts'
import { activateConversation } from '../src/state-machine.ts'

/**
 * updateFromWorker 是 OrchestratorService 的私有方法；这里用最小桩宿主直接调用真实实现，
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
    conversationById: () => conv,
    taskById: (id: string) => id === 'task_1' ? task : undefined,
    taskToolSteps: new Map(),
    applyUpdateSideEffects: async () => {},
    schedulesOf: () => [],
    deliveryToggles: () => ({ completed: true, failed: true, inputRequired: false, interrupted: true }),
    putPair: async (c: ConversationRecord, t?: TaskRecord) => { saved.push({ conv: c, task: t }) },
    blockAndWaitForAnswers: async () => [{ id: 'q1', selected: ['A'] }],
    deliverPendingTask: async () => {},
    hostCtx: { logger: { warn() {}, info() {} }, emit() {} },
  }
  const call = (args: unknown) =>
    (OrchestratorService.prototype as unknown as Record<string, (a: unknown, c: string) => Promise<any>>).updateFromWorker!
      .call(fake, args, 'child-1')
  return { call, saved }
}

describe('updateFromWorker：活动任务上报后的 Conversation 状态同步', () => {
  it('input_required 上报后 Conversation.state 同步为 input_required 且保留 activeTaskId', async () => {
    const { call, saved } = harness()
    const result = await call({
      status: 'input_required',
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
    await call({ status: 'completed', report: { result: '完成' } })
    expect(saved[0].task?.status).toBe('completed')
    expect(saved[0].conv.state).toBe('idle')
    expect(saved[0].conv.activeTaskId).toBeNull()
  })
})
