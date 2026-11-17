import { describe, expect, it, vi } from 'vitest'
import { OrchestratorService } from '../src/service.ts'
import { PendingAnswers } from '../src/pending-answers.ts'
import { activateConversation } from '../src/state-machine.ts'
import { createConversation, createTask, taskTodoInputSchema, type ConversationRecord, type TaskRecord } from '../src/types.ts'

it('创建 Worker 时先挂载预设，而不只写入 session header', async () => {
  const mount = vi.fn(async () => ({ id: 'may-orchestrator-worker' }))
  const create = vi.fn(async (options: { setup: (ctx: object) => Promise<void> }) => {
    await options.setup({})
    return { agent: { session: { id: 'worker' } } }
  })
  const service = Object.create(OrchestratorService.prototype)
  Object.assign(service, {
    hostCtx: {
      agents: { withoutInitiator: (run: () => Promise<void>) => run(), create },
      agentPresets: { mount },
      sessionTitle: { rename: vi.fn() },
    },
    workerModelOptions: vi.fn(async () => ({})),
    syncedTitles: new Map(),
  })
  await service.createWorkerAgent('worker', '/tmp/worker', {}, '测试')
  expect(create).toHaveBeenCalledWith(expect.objectContaining({
    meta: { cwd: '/tmp/worker', agentPreset: 'may-orchestrator-worker' },
    setup: expect.any(Function),
  }))
  expect(mount).toHaveBeenCalledWith({}, 'may-orchestrator-worker')
})

function harness() {
  const conversation = activateConversation(createConversation({
    id: 'conversation', childSessionId: 'worker', parentSessionId: 'lead', title: '演示',
  }), 'task')
  const task = { ...createTask({
    id: 'task', conversationId: conversation.id, parentSessionId: 'lead', predecessorTaskId: null,
    subject: '演示', prompt: '执行',
  }), status: 'running' as const, scheduleIds: ['schedule'] }
  const conversations = new Map<string, ConversationRecord>([[conversation.id, conversation]])
  const tasks = new Map<string, TaskRecord>([[task.id, task]])
  const tables = { conversations, tasks, schedules: new Map() }
  const service = Object.create(OrchestratorService.prototype)
  const scheduleList = vi.fn(async () => [])
  Object.assign(service, {
    ready: Promise.resolve(), chain: Promise.resolve(),
    domain: { table: (name: keyof typeof tables) => ({
      entries: () => tables[name].entries(),
      get: (id: string) => tables[name].get(id),
      put: async (id: string, value: never) => { tables[name].set(id, value) },
    }) },
    hostCtx: {
      get: (name: string) => name === 'schedule' ? { list: scheduleList } : undefined,
      logger: { warn: vi.fn(), info: vi.fn() },
    },
    pendingAnswers: new PendingAnswers(), revisionTurnEnds: new Map(),
    latestModels: new Map(), scheduledTurns: new Map(), activeScheduleIds: new Map(), pendingScheduleCalls: new Map(),
    emitChanged: vi.fn(), deliverPendingTask: vi.fn(),
    withAgent: async (_id: string, operation: (agent: unknown) => Promise<unknown>) => operation({ model: { current: () => undefined } }),
    interruptWorker: vi.fn(), deliverToWorker: vi.fn(), renameWorkerSession: vi.fn(),
  })
  const call = (method: string, ...args: unknown[]) => service[method](...args)
  const waitForQuestions = async () => vi.waitFor(() => expect(tasks.get('task')?.status).toBe('input_required'))
  return { service, call, conversation, task, conversations, tasks, tables, scheduleList, waitForQuestions }
}

describe('Worker 轮次结束结算', () => {
  it('仍有活动定时任务时保留当前任务，等待后续轮次继续上报', async () => {
    const fixture = harness()
    fixture.scheduleList.mockResolvedValue([{ id: 'schedule' }])
    await fixture.call('onWorkerTurnEnd', 'worker', undefined)
    expect(fixture.tasks.get('task')?.status).toBe('running')
    expect(fixture.conversations.get('conversation')).toEqual(fixture.conversation)
    expect(fixture.service.deliverPendingTask).not.toHaveBeenCalled()
  })

  it('没有活动定时任务时仍按未提交终态判定失败', async () => {
    const fixture = harness()
    await fixture.call('onWorkerTurnEnd', 'worker', undefined)
    expect(fixture.tasks.get('task')).toMatchObject({ status: 'failed', error: '子会话结束前未提交终态上报' })
    expect(fixture.conversations.get('conversation')).toMatchObject({ state: 'failed', activeTaskId: null })
  })

  it('等待作答时不因活动定时任务保留已结束轮次', async () => {
    const fixture = harness()
    fixture.scheduleList.mockResolvedValue([{ id: 'schedule' }])
    const waiting = fixture.call('reportFromWorker', 'input_required', { questions: [{ question: '继续吗？' }] }, 'worker')
    const rejected = expect(waiting).rejects.toThrow('轮次已结束')
    await fixture.waitForQuestions()
    await fixture.call('onWorkerTurnEnd', 'worker', undefined)
    await rejected
    expect(fixture.tasks.get('task')).toMatchObject({ status: 'failed', error: '子会话结束前未提交终态上报' })
    expect(fixture.conversations.get('conversation')).toMatchObject({ state: 'failed', activeTaskId: null })
    expect(fixture.service.pendingAnswers.signal('task')).toBeUndefined()
  })
})

describe('任务模型元数据落库', () => {
  it('终态任务保存本轮最后一次推理的传入与返回模型', async () => {
    const fixture = harness()
    fixture.service.latestModels.set('worker', { requestedModel: 'moma/auto', responseModel: 'abc' })
    await fixture.call('reportFromWorker', 'completed', { result: '完成' }, 'worker')
    expect(fixture.tasks.get('task')).toMatchObject({ requestedModel: 'moma/auto', responseModel: 'abc' })
    expect(fixture.service.latestModels.has('worker')).toBe(false)
  })

  it('无活动任务的定时上报也继承当前轮模型信息', async () => {
    const fixture = harness()
    fixture.conversations.set('conversation', { ...fixture.conversation, activeTaskId: null })
    fixture.service.latestModels.set('worker', { requestedModel: 'moma/auto' })
    await fixture.call('reportFromWorker', 'completed', { result: '定时结果' }, 'worker')
    const created = [...fixture.tasks.values()].find(item => item.id !== 'task')
    expect(created).toMatchObject({ requestedModel: 'moma/auto', responseModel: undefined })
  })
})

describe('阻塞问答生命周期', () => {
  it('Worker 弹窗作答后同轮返回答案', async () => {
    const fixture = harness()
    const waiting = fixture.call('reportFromWorker', 'input_required', { questions: [{ question: '继续吗？', options: [{ label: 'A' }] }] }, 'worker')
    await fixture.waitForQuestions()
    expect(await fixture.service.answerTaskQuestions({ childSessionId: 'worker', answers: [{ id: 'q1', selected: ['o1'] }] })).toMatchObject({ ok: true })
    expect(await waiting).toEqual({ ok: true, status: 'input_required_answered', answers: [{ id: 'q1', selected: ['o1'] }] })
    expect(fixture.tasks.get('task')?.status).toBe('running')
    expect(fixture.service.pendingAnswers.signal('task')).toBeUndefined()
  })

  it('已取消的旧问题答案不会答入下一次提问', async () => {
    const fixture = harness()
    const abort = new AbortController()
    const waiting = fixture.call('reportFromWorker', 'input_required', { questions: [{ question: '旧问题？' }] }, 'worker', abort.signal)
    const rejected = expect(waiting).rejects.toThrow('任务已中断')
    await fixture.waitForQuestions()
    abort.abort()
    await rejected
    const next = { ...fixture.task, id: 'next', status: 'input_required' as const, questions: [{ id: 'q1', question: '新问题？' }] }
    fixture.tasks.set(next.id, next)
    fixture.conversations.set('conversation', { ...fixture.conversation, lastTaskId: next.id, activeTaskId: next.id })
    expect((await fixture.service.answerTaskQuestions({ childSessionId: 'worker', taskId: 'task', answers: [{ id: 'other', custom: '旧答案' }] })).ok).toBe(false)
    expect(fixture.tasks.get(next.id)?.status).toBe('input_required')
  })

  it('看板作答唤醒同一工具调用', async () => {
    const fixture = harness()
    const waiting = fixture.call('reportFromWorker', 'input_required', { questions: [{ question: '选哪个？' }] }, 'worker')
    await fixture.waitForQuestions()
    expect(await fixture.service.answerTaskQuestions({ childSessionId: 'worker', answers: [{ id: 'q1', custom: 'A' }] }))
      .toEqual({ ok: true, taskId: 'task' })
    expect(await waiting).toEqual({ ok: true, status: 'input_required_answered', answers: [{ id: 'q1', selected: [], custom: 'A' }] })
    expect(fixture.tasks.get('task')?.status).toBe('running')
    expect(fixture.service.pendingAnswers.signal('task')).toBeUndefined()
  })

  it('等待时手动停止结算任务、清理问题卡且拒绝过期答案', async () => {
    const fixture = harness()
    const waiting = fixture.call('reportFromWorker', 'input_required', { questions: [{ question: '继续吗？' }] }, 'worker')
    const rejected = expect(waiting).rejects.toThrow('轮次已结束')
    await fixture.waitForQuestions()
    await fixture.call('onWorkerTurnEnd', 'worker', 'manual_stop')
    await rejected
    expect(fixture.tasks.get('task')?.status).toBe('interrupted')
    expect(fixture.conversations.get('conversation')?.state).toBe('idle')
    expect((await fixture.service.answerTaskQuestions({ childSessionId: 'worker', answers: [{ id: 'q1' }] })).ok).toBe(false)
  })

  it('等待时改单中断旧任务并向同一工作流派发新任务', async () => {
    const fixture = harness()
    const waiting = fixture.call('reportFromWorker', 'input_required', { questions: [{ question: '继续吗？' }] }, 'worker')
    const rejected = expect(waiting).rejects.toThrow('新需求接管')
    await fixture.waitForQuestions()
    const result = await fixture.call('dispatch', { conversationId: 'conversation', subject: '新需求', prompt: '继续处理' }, { session: { id: 'lead' } })
    await rejected
    expect(result).toEqual({ ok: true, status: 'background', conversationId: 'conversation' })
    expect(fixture.tasks.get('task')?.status).toBe('interrupted')
    expect(fixture.conversations.get('conversation')?.activeTaskId).not.toBe('task')
    expect(fixture.service.interruptWorker).toHaveBeenCalledWith('worker')
  })

  it('工具取消信号及时释放等待，不等 turn/end 才取消问题卡', async () => {
    const fixture = harness()
    const abort = new AbortController()
    const waiting = fixture.call('reportFromWorker', 'input_required', { questions: [{ question: '继续吗？' }] }, 'worker', abort.signal)
    const rejected = expect(waiting).rejects.toThrow('任务已中断')
    await fixture.waitForQuestions()
    abort.abort()
    await rejected
    expect(fixture.service.pendingAnswers.signal('task')).toBeUndefined()
  })

  it('服务停止释放全部等待', async () => {
    const fixture = harness()
    const waiting = fixture.call('reportFromWorker', 'input_required', { questions: [{ question: '继续吗？' }] }, 'worker')
    const rejected = expect(waiting).rejects.toThrow('编排服务已停止')
    await fixture.waitForQuestions()
    fixture.service.pendingAnswers.close()
    await rejected
  })

  it.each([true, false])('重启中断等待任务，兼容 activeTaskId 是否保留：%s', async (hasActiveTask) => {
    const fixture = harness()
    fixture.tasks.set('task', { ...fixture.task, status: 'input_required', questions: [{ id: 'q1', question: '继续吗？' }] })
    fixture.conversations.set('conversation', { ...fixture.conversation, state: 'input_required', activeTaskId: hasActiveTask ? 'task' : null })
    await fixture.call('recoverRuntimeState')
    expect(fixture.tasks.get('task')?.status).toBe('interrupted')
    expect(fixture.tasks.get('task')?.delivery).toBeUndefined()
    expect(fixture.conversations.get('conversation')?.activeTaskId).toBeNull()
    expect(fixture.conversations.get('conversation')?.state).toBe('idle')
    expect((await fixture.service.answerTaskQuestions({ childSessionId: 'worker', answers: [{ id: 'q1' }] })).ok).toBe(false)
  })

  it('问题持久化后立即作答也不会留下无法唤醒的等待', async () => {
    const fixture = harness()
    const answers = [{ id: 'q1', selected: ['A'] }]
    const waitingTask: TaskRecord = { ...fixture.task, status: 'input_required', questions: [{ id: 'q1', question: '继续吗？' }] }
    fixture.tasks.set('task', { ...waitingTask, status: 'running', answers })
    expect(await fixture.call('blockAndWaitForAnswers', waitingTask, 'worker')).toEqual(answers)
  })
})

describe('日程先校验再写入', () => {
  it('create 搭配不存在的 update 时不留下新增记录', async () => {
    const fixture = harness()
    const input = taskTodoInputSchema.parse({ create: [{ title: '新增' }], update: [{ id: 'missing', status: 'done' }] })
    await expect(fixture.call('todoFromWorker', input, 'worker')).rejects.toThrow('schedule not found')
    expect(fixture.tables.schedules.size).toBe(0)
  })
})

describe('执行模式与恢复', () => {
  it('复用省略 mode 与显式 general 都沿用已有工作区和会话', async () => {
    const f = harness()
    for (const mode of [undefined, 'general']) {
      await f.call('provisionDispatch', { conversationId: 'conversation', subject: '补充', prompt: '继续', mode }, { session: { id: 'lead' } }, 'lead')
      expect(f.conversations.get('conversation')?.mode).toBe('general')
      expect(f.conversations.get('conversation')?.childSessionId).toBe('worker')
    }
  })

  it('被移除模式冷恢复明确失败，结算活动任务并保留已有终态 outbox', async () => {
    const f = harness()
    f.conversations.set('conversation', { ...f.conversation, mode: 'removed' })
    f.tasks.set('finished', { ...f.task, id: 'finished', status: 'completed', result: '旧结果', delivery: { state: 'pending', attempts: 0 } } as TaskRecord)
    await f.call('recoverRuntimeState')
    expect(f.conversations.get('conversation')).toMatchObject({ mode: 'removed', state: 'failed', activeTaskId: null })
    expect(f.tasks.get('task')).toMatchObject({ status: 'failed', reasonCode: 'configuration', error: expect.stringContaining('removed') })
    expect(f.tasks.get('finished')).toMatchObject({ status: 'completed', result: '旧结果', delivery: { state: 'pending' } })
  })
})
