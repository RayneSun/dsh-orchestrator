import { describe, expect, it, vi } from 'vitest'
import { OrchestratorService } from '../src/service.ts'
import { PendingAnswers } from '../src/pending-answers.ts'
import { createConversation, createTask, type ConversationRecord, type TaskRecord } from '../src/types.ts'

function scheduledMessage(scheduleIds: string[]) {
  const text = scheduleIds.length === 1
    ? `[SCHEDULE REMINDER]\nschedule_id_json: ${JSON.stringify(scheduleIds[0])}\nprompt: 执行`
    : `[SCHEDULE REMINDER BATCH]\nreminders_json: ${JSON.stringify(scheduleIds.map(schedule_id => ({ schedule_id })))}`
  return { source: { kind: 'schedule' }, content: [{ type: 'text', text }] }
}

function createResult(callId: string, scheduleId?: string, isError = false) {
  return { message: {
    toolCallId: callId,
    isError,
    content: [{ type: 'text', text: scheduleId ? JSON.stringify({ id: scheduleId }) : '创建失败' }],
  } }
}

function doneTask(id: string, scheduleIds: string[] = []): TaskRecord {
  return {
    ...createTask({
      id, parentSessionId: 'lead', conversationId: 'conversation', predecessorTaskId: null,
      subject: id, prompt: '定时执行',
    }),
    status: 'completed', result: `${id} 旧结果`, scheduleIds,
    startedAt: '2026-11-12T07:00:00.000Z', endedAt: '2026-11-12T07:00:01.000Z',
    delivery: { state: 'delivered', deliveredAt: '2026-11-12T07:00:02.000Z', messageId: 'old' },
  }
}

function harness(initialTasks: TaskRecord[] = [doneTask('task-a', ['schedule-a'])]) {
  const conversation: ConversationRecord = {
    ...createConversation({ id: 'conversation', childSessionId: 'worker', parentSessionId: 'lead', title: '定时演示' }),
    state: 'idle', lastTaskId: initialTasks[0]?.id ?? null,
  }
  const conversations = new Map([[conversation.id, conversation]])
  const tasks = new Map(initialTasks.map(task => [task.id, task]))
  const tables = { conversations, tasks, schedules: new Map() }
  const service = Object.create(OrchestratorService.prototype)
  const scheduleList = vi.fn(async (): Promise<Array<{ id: string }>> => [])
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
    latestModels: new Map(), scheduledTurns: new Map(), activeScheduleIds: new Map(), pendingScheduleCalls: new Map(),
    todoTimers: new Map(), pendingTodoSteps: new Map(),
    pendingAnswers: new PendingAnswers(), revisionTurnEnds: new Map(),
    emitChanged: vi.fn(), deliverPendingTask: vi.fn(), queueScheduleMarkSync: vi.fn(),
  })
  const call = (method: string, ...args: unknown[]) => service[method](...args)
  const fire = async (scheduleIds: string[]) => {
    await call('onWorkerSessionEvent', 'worker', { type: 'user/message', data: scheduledMessage(scheduleIds) })
  }
  return { service, call, fire, conversation, conversations, tasks, scheduleList }
}

describe('schedule_create 与 Task 持久关联', () => {
  it('同一 Task 创建多个定时任务时逐个关联并去重', async () => {
    const task = { ...doneTask('task-a'), status: 'running' as const, delivery: undefined }
    const fixture = harness([task])
    fixture.conversations.set('conversation', { ...fixture.conversation, state: 'running', activeTaskId: task.id })
    for (const [callId, scheduleId] of [['call-a', 'schedule-a'], ['call-b', 'schedule-b'], ['call-c', 'schedule-b']] as const) {
      fixture.call('onWorkerSessionEvent', 'worker', { type: 'tool/call', data: { name: 'schedule_create', callId } })
      await fixture.call('bindScheduleCreateResult', createResult(callId, scheduleId))
    }
    expect(fixture.tasks.get(task.id)?.scheduleIds).toEqual(['schedule-a', 'schedule-b'])
    expect(fixture.service.pendingScheduleCalls.size).toBe(0)
  })

  it('创建失败不关联，turn/end 清理未返回的调用', async () => {
    const task = { ...doneTask('task-a', ['schedule-a']), status: 'running' as const }
    const fixture = harness([task])
    fixture.conversations.set('conversation', { ...fixture.conversation, state: 'running', activeTaskId: task.id })
    fixture.call('onWorkerSessionEvent', 'worker', { type: 'tool/call', data: { name: 'schedule_create', callId: 'failed' } })
    await fixture.call('bindScheduleCreateResult', createResult('failed', undefined, true))
    fixture.call('onWorkerSessionEvent', 'worker', { type: 'tool/call', data: { name: 'schedule_create', callId: 'orphan' } })
    fixture.call('onWorkerSessionEvent', 'worker', { type: 'turn/end', data: {} })
    expect(fixture.tasks.get(task.id)?.scheduleIds).toEqual(['schedule-a'])
    expect(fixture.service.pendingScheduleCalls.size).toBe(0)
  })

  it('定时轮次无活动 Task 时，新 schedule 关联回本轮唯一来源 Task', async () => {
    const fixture = harness()
    await fixture.fire(['schedule-a'])
    fixture.call('onWorkerSessionEvent', 'worker', { type: 'tool/call', data: { name: 'schedule_create', callId: 'call-b' } })
    await fixture.call('bindScheduleCreateResult', createResult('call-b', 'schedule-b'))
    expect(fixture.tasks.get('task-a')?.scheduleIds).toEqual(['schedule-a', 'schedule-b'])
  })

  it('普通轮次无活动 Task 时不猜测关联到 lastTaskId', async () => {
    const fixture = harness()
    fixture.call('onWorkerSessionEvent', 'worker', { type: 'tool/call', data: { name: 'schedule_create', callId: 'call-b' } })
    await fixture.call('bindScheduleCreateResult', createResult('call-b', 'schedule-b'))
    expect(fixture.tasks.get('task-a')?.scheduleIds).toEqual(['schedule-a'])
  })

  it('定时轮次有其他 activeTask 时仍关联本轮来源 Task', async () => {
    const active = { ...doneTask('task-b', ['schedule-b']), status: 'running' as const }
    const fixture = harness([doneTask('task-a', ['schedule-a']), active])
    fixture.conversations.set('conversation', { ...fixture.conversation, state: 'running', activeTaskId: active.id })
    await fixture.fire(['schedule-a'])
    fixture.call('onWorkerSessionEvent', 'worker', { type: 'tool/call', data: { name: 'schedule_create', callId: 'call-c' } })
    await fixture.call('bindScheduleCreateResult', createResult('call-c', 'schedule-c'))
    expect(fixture.tasks.get('task-a')?.scheduleIds).toEqual(['schedule-a', 'schedule-c'])
    expect(fixture.tasks.get('task-b')?.scheduleIds).toEqual(['schedule-b'])
  })
})

describe('定时完成按 scheduleId 覆盖原 Task', () => {
  it('定时轮次支持 running 后再 completed，仍覆盖同一个 Task', async () => {
    const fixture = harness([doneTask('task-a', ['schedule-a']), doneTask('task-b', ['schedule-b'])])
    await fixture.fire(['schedule-a'])
    await fixture.call('reportFromWorker', 'running', { progressNote: 'A 本轮执行中' }, 'worker')
    expect(fixture.tasks.size).toBe(2)
    expect(fixture.tasks.get('task-a')).toMatchObject({
      status: 'running', result: undefined, progressNote: 'A 本轮执行中', lastScheduleId: 'schedule-a',
    })
    expect(fixture.tasks.get('task-b')?.result).toBe('task-b 旧结果')
    expect(fixture.conversations.get('conversation')).toMatchObject({ state: 'running', activeTaskId: 'task-a' })

    await fixture.call('reportFromWorker', 'completed', { result: 'A 本轮完成' }, 'worker')
    expect(fixture.tasks.size).toBe(2)
    expect(fixture.tasks.get('task-a')).toMatchObject({ status: 'completed', result: 'A 本轮完成' })
    expect(fixture.conversations.get('conversation')).toMatchObject({ state: 'idle', activeTaskId: null })
  })

  it('定时轮次支持 failed，并复用原 Task 投递失败', async () => {
    const fixture = harness()
    await fixture.fire(['schedule-a'])
    await fixture.call('reportFromWorker', 'failed', { error: '本轮失败', reasonCode: 'network' }, 'worker')
    expect(fixture.tasks.size).toBe(1)
    expect(fixture.tasks.get('task-a')).toMatchObject({
      status: 'failed', error: '本轮失败', reasonCode: 'network', result: undefined, lastScheduleId: 'schedule-a',
    })
    expect(fixture.service.deliverPendingTask).toHaveBeenCalledWith('task-a')
  })

  it('未关联 schedule 可先 running 创建 ad-hoc，再 completed 同一 Task', async () => {
    const fixture = harness([])
    await fixture.fire(['schedule-new'])
    await fixture.call('reportFromWorker', 'running', { progressNote: '首次执行中' }, 'worker')
    expect(fixture.tasks.size).toBe(1)
    const task = [...fixture.tasks.values()][0]
    expect(task).toMatchObject({ status: 'running', scheduleIds: ['schedule-new'] })
    await fixture.call('reportFromWorker', 'completed', { result: '首次完成' }, 'worker')
    expect(fixture.tasks.size).toBe(1)
    expect(fixture.tasks.get(task.id)).toMatchObject({ status: 'completed', result: '首次完成' })
  })

  it('定时 input_required 支持作答后继续完成', async () => {
    const fixture = harness()
    await fixture.fire(['schedule-a'])
    const waiting = fixture.call('reportFromWorker', 'input_required', {
      questions: [{ question: '本轮继续吗？', options: [{ label: '继续' }] }],
    }, 'worker')
    await vi.waitFor(() => expect(fixture.tasks.get('task-a')?.status).toBe('input_required'))
    expect(fixture.conversations.get('conversation')).toMatchObject({ state: 'input_required', activeTaskId: 'task-a' })
    expect(await fixture.service.answerTaskQuestions({
      childSessionId: 'worker', taskId: 'task-a', answers: [{ id: 'q1', selected: ['继续'] }],
    })).toEqual({ ok: true, taskId: 'task-a' })
    expect(await waiting).toMatchObject({ status: 'input_required_answered' })
    expect(fixture.tasks.get('task-a')).toMatchObject({ status: 'running' })
    await fixture.call('reportFromWorker', 'completed', { result: '作答后完成' }, 'worker')
    expect(fixture.tasks.get('task-a')).toMatchObject({ status: 'completed', result: '作答后完成' })
  })

  it('定时来源不是 activeTask 时，todo 进度仍写入来源 Task', async () => {
    const active = { ...doneTask('task-b', ['schedule-b']), status: 'running' as const, delivery: undefined }
    const fixture = harness([doneTask('task-a', ['schedule-a']), active])
    fixture.conversations.set('conversation', {
      ...fixture.conversation, state: 'running', activeTaskId: active.id, lastTaskId: active.id,
    })
    await fixture.fire(['schedule-a'])
    await fixture.call('reportFromWorker', 'running', { progressNote: 'A 执行中' }, 'worker')
    fixture.call('onWorkerSessionEvent', 'worker', {
      type: 'todo/write', data: { todos: [{ content: 'A 的步骤', status: 'in_progress' }] },
    })
    await fixture.call('flushTodoProgress', 'worker')
    expect(fixture.tasks.get('task-a')?.progressSteps).toEqual([{ content: 'A 的步骤', status: 'in_progress' }])
    expect(fixture.tasks.get('task-b')?.progressSteps).toEqual([])
  })

  it('另一个 activeTask 并存时，定时问题按 taskId 作答且不抢占 activeTask', async () => {
    const active = { ...doneTask('task-b', ['schedule-b']), status: 'running' as const, delivery: undefined }
    const fixture = harness([doneTask('task-a', ['schedule-a']), active])
    fixture.conversations.set('conversation', {
      ...fixture.conversation, state: 'running', activeTaskId: active.id, lastTaskId: active.id,
    })
    await fixture.fire(['schedule-a'])
    const waiting = fixture.call('reportFromWorker', 'input_required', {
      questions: [{ question: '定时问题', options: [{ label: '确认' }] }],
    }, 'worker')
    await vi.waitFor(() => expect(fixture.tasks.get('task-a')?.status).toBe('input_required'))
    expect(await fixture.service.answerTaskQuestions({
      childSessionId: 'worker', taskId: 'task-a', answers: [{ id: 'q1', selected: ['确认'] }],
    })).toEqual({ ok: true, taskId: 'task-a' })
    expect(await waiting).toMatchObject({ status: 'input_required_answered' })
    expect(fixture.tasks.get('task-a')?.status).toBe('running')
    expect(fixture.tasks.get('task-b')?.status).toBe('running')
    expect(fixture.conversations.get('conversation')).toMatchObject({ state: 'running', activeTaskId: 'task-b', lastTaskId: 'task-b' })
  })

  it('同一会话两个定时任务分别触发，只更新各自 Task 且不新增任务', async () => {
    const fixture = harness([doneTask('task-a', ['schedule-a']), doneTask('task-b', ['schedule-b'])])
    await fixture.fire(['schedule-a'])
    await fixture.call('reportFromWorker', 'completed', { result: 'A 新结果' }, 'worker')
    expect(fixture.tasks.size).toBe(2)
    expect(fixture.tasks.get('task-a')).toMatchObject({ result: 'A 新结果', lastScheduleId: 'schedule-a' })
    expect(fixture.tasks.get('task-b')?.result).toBe('task-b 旧结果')

    await fixture.fire(['schedule-b'])
    await fixture.call('reportFromWorker', 'completed', { result: 'B 新结果' }, 'worker')
    expect(fixture.tasks.size).toBe(2)
    expect(fixture.tasks.get('task-a')?.result).toBe('A 新结果')
    expect(fixture.tasks.get('task-b')).toMatchObject({ result: 'B 新结果', lastScheduleId: 'schedule-b' })
  })

  it('一个 Task 的多个 schedule 都回写同一 Task，并记录最近来源', async () => {
    const fixture = harness([doneTask('task-a', ['schedule-a', 'schedule-b'])])
    await fixture.fire(['schedule-b'])
    await fixture.call('reportFromWorker', 'completed', { result: '第二次执行' }, 'worker')
    expect(fixture.tasks.size).toBe(1)
    expect(fixture.tasks.get('task-a')).toMatchObject({ result: '第二次执行', lastScheduleId: 'schedule-b', scheduleIds: ['schedule-a', 'schedule-b'] })
  })

  it('未关联 schedule 首次创建 ad-hoc，后续触发覆盖同一 Task', async () => {
    const fixture = harness([])
    await fixture.fire(['schedule-new'])
    await fixture.call('reportFromWorker', 'completed', { result: '第一次' }, 'worker')
    expect(fixture.tasks.size).toBe(1)
    const task = [...fixture.tasks.values()][0]
    expect(task.scheduleIds).toEqual(['schedule-new'])
    await fixture.fire(['schedule-new'])
    await fixture.call('reportFromWorker', 'completed', { result: '第二次' }, 'worker')
    expect(fixture.tasks.size).toBe(1)
    expect(fixture.tasks.get(task.id)?.result).toBe('第二次')
  })

  it('批量消息必须显式传当前消息内的 scheduleId', async () => {
    const fixture = harness([doneTask('task-a', ['schedule-a']), doneTask('task-b', ['schedule-b'])])
    await fixture.fire(['schedule-a', 'schedule-b'])
    await expect(fixture.call('reportFromWorker', 'completed', { result: '缺少来源' }, 'worker'))
      .rejects.toThrow('scheduleId is required')
    await expect(fixture.call('reportFromWorker', 'completed', { result: '错误来源', scheduleId: 'schedule-c' }, 'worker'))
      .rejects.toThrow('not present')
    await fixture.call('reportFromWorker', 'completed', { result: 'B 批量结果', scheduleId: 'schedule-b' }, 'worker')
    expect(fixture.tasks.get('task-a')?.result).toBe('task-a 旧结果')
    expect(fixture.tasks.get('task-b')?.result).toBe('B 批量结果')
  })

  it('更新定时 Task 不错误结算同会话另一个活动 Task', async () => {
    const active = { ...doneTask('task-b', ['schedule-b']), status: 'running' as const, delivery: undefined }
    const fixture = harness([doneTask('task-a', ['schedule-a']), active])
    fixture.conversations.set('conversation', { ...fixture.conversation, state: 'running', activeTaskId: active.id, lastTaskId: active.id })
    await fixture.fire(['schedule-a'])
    await fixture.call('reportFromWorker', 'completed', { result: 'A 新结果' }, 'worker')
    expect(fixture.tasks.get('task-a')?.result).toBe('A 新结果')
    expect(fixture.tasks.get('task-b')?.status).toBe('running')
    expect(fixture.conversations.get('conversation')).toMatchObject({ state: 'running', activeTaskId: 'task-b', lastTaskId: 'task-b' })
  })

  it('畸形定时消息不得回退成普通完成并误结算 activeTask', async () => {
    const active = { ...doneTask('task-b', ['schedule-b']), status: 'running' as const, delivery: undefined }
    const fixture = harness([active])
    fixture.conversations.set('conversation', { ...fixture.conversation, state: 'running', activeTaskId: active.id })
    fixture.call('onWorkerSessionEvent', 'worker', { type: 'user/message', data: {
      source: { kind: 'schedule' }, content: [{ type: 'text', text: '[SCHEDULE REMINDER]\nschedule_id_json: 畸形' }],
    } })
    await expect(fixture.call('reportFromWorker', 'completed', { result: '错误归属' }, 'worker'))
      .rejects.toThrow('scheduleId is required')
    expect(fixture.tasks.get(active.id)?.status).toBe('running')
    expect(fixture.conversations.get('conversation')?.activeTaskId).toBe(active.id)
  })

  it('批量轮次结束优先清理唯一的阻塞提问，不影响其他运行任务', async () => {
    const fixture = harness([doneTask('task-a', ['schedule-a']), doneTask('task-b', ['schedule-b'])])
    await fixture.fire(['schedule-a', 'schedule-b'])
    await fixture.call('reportFromWorker', 'running', { scheduleId: 'schedule-a', progressNote: 'A 执行中' }, 'worker')
    const waiting = fixture.call('reportFromWorker', 'input_required', {
      scheduleId: 'schedule-b', questions: [{ question: 'B 继续吗？' }],
    }, 'worker')
    const rejected = expect(waiting).rejects.toThrow('轮次已结束')
    await vi.waitFor(() => expect(fixture.tasks.get('task-b')?.status).toBe('input_required'))
    await fixture.call('onWorkerTurnEnd', 'worker', undefined)
    await rejected
    expect(fixture.tasks.get('task-a')?.status).toBe('running')
    expect(fixture.tasks.get('task-b')?.status).toBe('failed')
  })

  it('其他 Task 的活动 schedule 不阻止当前 Task 在 turn/end 失败结算', async () => {
    const active = { ...doneTask('task-b', ['schedule-b']), status: 'running' as const, delivery: undefined }
    const fixture = harness([active])
    fixture.conversations.set('conversation', { ...fixture.conversation, state: 'running', activeTaskId: active.id })
    fixture.scheduleList.mockResolvedValue([{ id: 'schedule-a' }])
    await fixture.call('onWorkerTurnEnd', 'worker', undefined)
    expect(fixture.tasks.get(active.id)?.status).toBe('failed')
  })

  it('定时 A 已完成后的 turn/end 不误判同会话 activeTask B', async () => {
    const active = { ...doneTask('task-b', ['schedule-b']), status: 'running' as const, delivery: undefined }
    const fixture = harness([doneTask('task-a', ['schedule-a']), active])
    fixture.conversations.set('conversation', {
      ...fixture.conversation, state: 'running', activeTaskId: active.id, lastTaskId: active.id,
    })
    await fixture.fire(['schedule-a'])
    await fixture.call('reportFromWorker', 'completed', { result: 'A 已完成' }, 'worker')
    await fixture.call('onWorkerTurnEnd', 'worker', undefined)
    expect(fixture.tasks.get('task-a')).toMatchObject({ status: 'completed', result: 'A 已完成' })
    expect(fixture.tasks.get('task-b')?.status).toBe('running')
    expect(fixture.conversations.get('conversation')).toMatchObject({ state: 'running', activeTaskId: 'task-b' })
  })

  it('重启恢复同时中断 activeTask 与非 active 的定时提问 Task', async () => {
    const waiting = { ...doneTask('task-a', ['schedule-a']), status: 'input_required' as const, delivery: undefined }
    const active = { ...doneTask('task-b', ['schedule-b']), status: 'running' as const, delivery: undefined }
    const fixture = harness([waiting, active])
    fixture.conversations.set('conversation', {
      ...fixture.conversation, state: 'running', activeTaskId: active.id, lastTaskId: active.id,
    })
    await fixture.call('recoverRuntimeState')
    expect(fixture.tasks.get('task-a')?.status).toBe('interrupted')
    expect(fixture.tasks.get('task-b')?.status).toBe('interrupted')
  })
})

describe('看板定时标记投影', () => {
  it('Task 只看自己的活动关联，Conversation 保留所有原生活动 schedule', async () => {
    const legacy = { ...doneTask('task-legacy'), scheduled: true }
    const fixture = harness([doneTask('task-a', ['schedule-a']), doneTask('task-b', ['schedule-b']), legacy])
    fixture.scheduleList.mockResolvedValue([{ id: 'schedule-a' }, { id: 'unlinked' }])
    await fixture.call('syncScheduleMarks')
    let snapshot = fixture.call('snapshotFor', 'lead')
    expect(snapshot.conversations[0].hasActiveSchedule).toBe(true)
    expect(snapshot.tasks.find((task: TaskRecord) => task.id === 'task-a')?.hasActiveSchedule).toBe(true)
    expect(snapshot.tasks.find((task: TaskRecord) => task.id === 'task-b')?.hasActiveSchedule).toBe(false)
    expect(snapshot.tasks.find((task: TaskRecord) => task.id === 'task-legacy')?.hasActiveSchedule).toBe(false)

    fixture.scheduleList.mockResolvedValue([])
    await fixture.call('syncScheduleMarks')
    snapshot = fixture.call('snapshotFor', 'lead')
    expect(snapshot.conversations[0].hasActiveSchedule).toBe(false)
    expect(snapshot.tasks.find((task: TaskRecord) => task.id === 'task-a')?.hasActiveSchedule).toBe(false)
  })
})

describe('定时结果覆盖期间的 outbox 并发', () => {
  function deliveryHarness() {
    const task: TaskRecord = {
      ...doneTask('task-a', ['schedule-a']),
      result: '旧结果', revision: 7,
      delivery: { state: 'pending', attempts: 0 },
    }
    const conversation = createConversation({ id: 'conversation', childSessionId: 'worker', parentSessionId: 'lead', title: '定时演示' })
    const tables = {
      conversations: new Map([[conversation.id, conversation]]),
      tasks: new Map([[task.id, task]]),
      schedules: new Map(),
    }
    const service = Object.create(OrchestratorService.prototype)
    const followup = vi.fn()
    const flush = vi.fn(async () => true)
    Object.assign(service, {
      chain: Promise.resolve(), delivering: new Map(), deliveryRerun: new Set(),
      domain: { table: (name: keyof typeof tables) => ({
        entries: () => tables[name].entries(),
        get: (id: string) => tables[name].get(id),
        put: async (id: string, value: never) => { tables[name].set(id, value) },
      }) },
      hostCtx: { sessions: { flush }, logger: { warn: vi.fn(), info: vi.fn() } },
      withAgent: async (_id: string, operation: (agent: unknown) => Promise<unknown>) => operation({ followup }),
      emitChanged: vi.fn(),
    })
    return { service, task, tasks: tables.tasks, followup, flush, call: (method: string, ...args: unknown[]) => service[method](...args) }
  }

  it('旧 revision 的成功回写不吞掉新 pending，并继续投递最新结果', async () => {
    const fixture = deliveryHarness()
    let release!: (flushed: boolean) => void
    fixture.flush.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const first = fixture.call('deliverPendingTask', fixture.task.id)
    await vi.waitFor(() => expect(fixture.followup).toHaveBeenCalledTimes(1))
    const current = fixture.tasks.get(fixture.task.id)!
    fixture.tasks.set(fixture.task.id, {
      ...current, result: '新结果', revision: current.revision + 1,
      delivery: { state: 'pending', attempts: 0 },
    })
    await fixture.call('deliverPendingTask', fixture.task.id)
    release(true)
    await first
    await vi.waitFor(() => expect(fixture.followup).toHaveBeenCalledTimes(2))
    expect(fixture.tasks.get(fixture.task.id)).toMatchObject({ result: '新结果', delivery: { state: 'delivered' } })
  })

  it('旧 revision 的失败回写也不增加新结果的 attempts', async () => {
    const fixture = deliveryHarness()
    let rejectFlush!: (error: Error) => void
    fixture.flush.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFlush = reject }))
    const first = fixture.call('deliverPendingTask', fixture.task.id)
    await vi.waitFor(() => expect(fixture.followup).toHaveBeenCalledTimes(1))
    const current = fixture.tasks.get(fixture.task.id)!
    fixture.tasks.set(fixture.task.id, {
      ...current, result: '新结果', revision: current.revision + 1,
      delivery: { state: 'pending', attempts: 0 },
    })
    await fixture.call('deliverPendingTask', fixture.task.id)
    rejectFlush(new Error('旧投递失败'))
    await first
    await vi.waitFor(() => expect(fixture.followup).toHaveBeenCalledTimes(2))
    expect(fixture.tasks.get(fixture.task.id)).toMatchObject({ result: '新结果', delivery: { state: 'delivered' } })
    const delivery = fixture.tasks.get(fixture.task.id)?.delivery
    expect(delivery && 'attempts' in delivery).toBe(false)
  })

  it('投递状态没有变化时不增加 revision', async () => {
    const fixture = deliveryHarness()
    const revision = fixture.task.revision
    expect(await fixture.call('patchDelivery', fixture.task.id, revision, (current: TaskRecord) => current.delivery)).toBe(true)
    expect(fixture.tasks.get(fixture.task.id)?.revision).toBe(revision)
  })

  it('同 revision 的重复投递请求不触发额外重试', async () => {
    const fixture = deliveryHarness()
    let release!: (flushed: boolean) => void
    fixture.flush.mockImplementationOnce(() => new Promise(resolve => { release = resolve }))
    const first = fixture.call('deliverPendingTask', fixture.task.id)
    await vi.waitFor(() => expect(fixture.followup).toHaveBeenCalledTimes(1))
    await fixture.call('deliverPendingTask', fixture.task.id)
    release(true)
    await first
    await new Promise(resolve => setImmediate(resolve))
    expect(fixture.followup).toHaveBeenCalledTimes(1)
  })
})
