import { describe, expect, it } from 'vitest'
import { createConversation, createTask, type QuestionAnswer } from '../src/types.ts'
import {
  StateError, activateConversation, statusConcludesTurn, appendOutlineSubject, classifyWorkerTurnEnd,
  failConversation, interruptTaskForRevision, reviseConversation, canTransition, failTask, interruptTaskAfterRestart,
  isTerminal, resumeTaskWithAnswers, settleConversation, transitionTask,
} from '../src/state-machine.ts'

function pair() {
  let conv = createConversation({ id: 'c1', childSessionId: 'child', parentSessionId: 'p', title: 't' })
  let task = createTask({
    id: 't1', parentSessionId: 'p', conversationId: 'c1', predecessorTaskId: null,
    subject: 's', prompt: 'do',
  })
  conv = activateConversation(conv, task.id)
  task = { ...task, status: 'running' }
  return { conv, task }
}

function bgTask() {
  return createTask({
    id: 't', parentSessionId: 'p', conversationId: 'c', predecessorTaskId: null,
    subject: 's', prompt: 'p',
  })
}

describe('Worker turn/end 原因分类', () => {
  it('把用户手动停止和父级改单中断区分开', () => {
    expect(classifyWorkerTurnEnd({ kind: 'aborted', reason: { kind: 'user' } })).toBe('manual_stop')
    expect(classifyWorkerTurnEnd({ kind: 'aborted', reason: { kind: 'parent' } })).toBe('revision')
  })

  it('崩溃修复标记和空原因不应当作用户手动停止', () => {
    expect(classifyWorkerTurnEnd({ kind: 'interrupted' })).toBeUndefined()
    expect(classifyWorkerTurnEnd(undefined)).toBeUndefined()
    expect(classifyWorkerTurnEnd({ kind: 'aborted', reason: { kind: 'disposed' } })).toBeUndefined()
  })
})

describe('任务状态机', () => {
  it('终态不能再次迁移', () => {
    let { task } = pair()
    task = transitionTask(task, { status: 'completed', result: 'done' })
    expect(() => transitionTask(task, { status: 'running' })).toThrow(/cannot move/)
  })

  it('成功完成会释放 Conversation', () => {
    let { conv, task } = pair()
    task = transitionTask(task, { status: 'completed', result: '晴' })
    conv = settleConversation(conv, task)
    expect(conv.state).toBe('idle')
    expect(conv.activeTaskId).toBeNull()
  })

  it('Worker/任务失败后持久工作流仍可复用；Host 致命错误才标记会话失败', () => {
    let { conv, task } = pair()
    task = transitionTask(task, { status: 'failed', error: '构建失败' })
    conv = settleConversation(conv, task)
    expect(task.status).toBe('failed')
    expect(conv.state).toBe('idle')
    const fatalTask = failTask(bgTask(), '子会话启动失败')
    const fatalConv = failConversation(settleConversation(createConversation({
      id: 'c2', childSessionId: 'child2', parentSessionId: 'p', title: 't',
    }), fatalTask))
    expect(fatalConv.state).toBe('failed')
  })

  it('同一工作流同时只能有一个活动任务', () => {
    const { conv } = pair()
    expect(() => activateConversation(conv, 't2')).toThrow(/already runs task t1/)
  })

  it('路由卡摘要保留最近主题链（去重、保序、最多 5 个）', () => {
    const { conv } = pair()
    let next = appendOutlineSubject(conv, '查天气')
    next = appendOutlineSubject(next, '查机票')
    next = appendOutlineSubject(next, '查天气')
    next = appendOutlineSubject(next, '查酒店')
    expect(next.outline.summary).toBe('查机票｜查天气｜查酒店')
    expect(next.revision).toBe(conv.revision + 4)
  })
})

describe('statusConcludesTurn', () => {
  it('仅 completed 和 failed 结束本轮', () => {
    for (const status of ['completed', 'failed'] as const) {
      expect(statusConcludesTurn(status)).toBe(true)
    }
    for (const status of ['running', 'input_required', 'input_required_answered', 'interrupted', undefined]) {
      expect(statusConcludesTurn(status)).toBe(false)
    }
  })
})

describe('task_* header', () => {
  it('header 随状态迁移更新，未提供时保留旧值', () => {
    let task = bgTask()
    task = transitionTask(task, { status: 'running', header: '开始抓取' })
    expect(task.header).toBe('开始抓取')
    task = transitionTask(task, { status: 'running', progressNote: '抓到一半' })
    expect(task.header).toBe('开始抓取')
    task = transitionTask(task, { status: 'completed', header: '抓取完成', result: '答案' })
    expect(task.header).toBe('抓取完成')
  })
})

describe('状态迁移和修订号', () => {
  it('failed 上报写入拍平存储', () => {
    const queued = bgTask()
    expect(transitionTask(queued, { status: 'failed', error: 'boom' }).status).toBe('failed')
  })

  it('状态迁移会清理不属于新状态的上下文字段', () => {
    const failed = transitionTask({ ...bgTask(), status: 'running', questions: [{ id: 'q1', question: '旧问题' }] }, {
      status: 'failed',
      error: '权限不足',
      reasonCode: 'permission_denied',
    })
    expect(failed.questions).toBeUndefined()
    expect(failed.error).toBe('权限不足')
    expect(failed.reasonCode).toBe('permission_denied')

    const completed = transitionTask({ ...bgTask(), status: 'running', error: '旧错误' }, {
      status: 'completed',
      result: '已完成',
    })
    expect(completed.error).toBeUndefined()
    expect(completed.result).toBe('已完成')
  })

  it('queued 可直接完成，完成后修订号递增且不能继续迁移', () => {
    const task = bgTask()
    const done = transitionTask(task, { status: 'completed', result: '答案' })
    expect(done.revision).toBe(1)
    expect(done.endedAt).toBe(done.updatedAt)
    expect(canTransition(done.status, 'running')).toBe(false)
  })

  it('后台任务进入可投递终态时自动挂起投递；interrupted 不投递', () => {
    expect(transitionTask(bgTask(), { status: 'completed', result: 'ok' }).delivery)
      .toEqual({ state: 'pending', attempts: 0 })
    expect(transitionTask(bgTask(), {
      status: 'input_required',
      questions: [{ id: 'q1', question: 'q?' }],
    }).delivery).toEqual({ state: 'pending', attempts: 0 })
    expect(transitionTask(bgTask(), {
      status: 'failed',
      error: '权限被拒绝',
      reasonCode: 'permission_denied',
    }).delivery).toEqual({ state: 'pending', attempts: 0 })
    expect(interruptTaskForRevision(bgTask(), '改单').delivery).toBeUndefined()
  })

  it('静默任务进入任何终态都不挂投递', () => {
    const silent = { ...bgTask(), silent: true }
    expect(transitionTask(silent, { status: 'completed', result: 'ok' }).delivery).toBeUndefined()
    expect(transitionTask(silent, {
      status: 'input_required',
      questions: [{ id: 'q1', question: 'q?' }],
    }).delivery).toBeUndefined()
    expect(transitionTask(silent, {
      status: 'failed', error: 'e', reasonCode: 'network',
    }).delivery).toBeUndefined()
    expect(failTask(silent, 'boom').delivery).toBeUndefined()
  })

  it('终态任务再次失败时保持原记录不变', () => {
    const { task } = pair()
    const done = transitionTask(task, { status: 'completed', result: 'done' })
    expect(failTask(done, 'later')).toBe(done)
  })

  it('重启恢复把后台活动任务标记 interrupted 且不主动投递', () => {
    const paused = interruptTaskAfterRestart(bgTask())
    expect(paused.status).toBe('interrupted')
    expect(paused.cancelledReason).toContain('重启')
    expect(paused.delivery).toBeUndefined()
  })
})

describe('用户回答后重开任务', () => {
  it('input_required 任务可由 Host 原子恢复为 running，并保留问题与作答留痕', () => {
    let task = bgTask()
    task = transitionTask(task, { status: 'running', header: '等待确认' })
    task = transitionTask(task, {
      status: 'input_required',
      questions: [{ id: 'q1', question: '选 A 还是 B？' }],
    })
    const answers: QuestionAnswer[] = [{ id: 'q1', selected: ['A'] }]
    task = resumeTaskWithAnswers(task, answers)
    expect(task.status).toBe('running')
    expect(task.answers).toEqual(answers)
    expect(task.questions?.[0]?.question).toBe('选 A 还是 B？')
    expect(task.endedAt).toBeUndefined()
    expect(task.delivery).toBeUndefined()
    expect(task.progressNote).toContain('回答')
    expect(() => resumeTaskWithAnswers(transitionTask(bgTask(), {
      status: 'completed', result: 'done',
    }), answers)).toThrow(/not awaiting user input/)
  })
})

describe('改单中断与 Worker 提问', () => {
  it('等待用户作答的任务仍可停止、失败和重启中断', () => {
    const waiting = transitionTask(bgTask(), { status: 'input_required', questions: [{ id: 'q1', question: '继续吗？' }] })
    expect(interruptTaskForRevision(waiting, '新需求').status).toBe('interrupted')
    expect(interruptTaskAfterRestart(waiting).status).toBe('interrupted')
    expect(failTask(waiting, '轮次结束').status).toBe('failed')
  })
  it('活动任务可被新需求中断并记录原因，且不保留后台失败投递', () => {
    const { task, conv } = pair()
    const interrupted = interruptTaskForRevision(task, '被新需求取代')
    expect(interrupted.status).toBe('interrupted')
    expect(interrupted.cancelledReason).toContain('新需求')
    expect(interrupted.delivery).toBeUndefined()
    expect(isTerminal(interrupted.status)).toBe(true)
    const revised = reviseConversation(conv, 'task_new')
    expect(revised.state).toBe('running')
    expect(revised.activeTaskId).toBe('task_new')
    // interrupted 是终态：不可再迁移，也不能在失败会话上改单
    expect(canTransition('interrupted', 'running')).toBe(false)
    expect(() => reviseConversation({ ...revised, state: 'failed' }, 'task_x')).toThrow()
    // 终态任务重复中断保持幂等
    const again = interruptTaskForRevision(interrupted, '再次中断')
    expect(again).toBe(interrupted)
  })

  it('手动停止的任务进入 interrupted，工作流回到 idle 可继续派发', () => {
    let { conv, task } = pair()
    const stopped = interruptTaskForRevision(task, '子会话执行被手动停止')
    expect(stopped.delivery).toBeUndefined()
    conv = settleConversation(conv, stopped)
    expect(conv.state).toBe('idle')
    expect(conv.activeTaskId).toBeNull()
    // idle 工作流可以接收新任务（不撞 busy / failed 校验）
    const revived = activateConversation(conv, 't2')
    expect(revived.state).toBe('running')
    expect(revived.activeTaskId).toBe('t2')
  })

  it('input_required 携带结构化问题并把工作流置为待补充', () => {
    let { conv } = pair()
    const waiting = transitionTask(bgTask(), {
      status: 'input_required',
      questions: [{ id: 'q1', question: '要做 PvP 还是 PvE？' }],
    })
    expect(waiting.questions?.[0]?.question).toBe('要做 PvP 还是 PvE？')
    expect(waiting.delivery).toEqual({ state: 'pending', attempts: 0 })
    conv = settleConversation(conv, waiting)
    expect(conv.state).toBe('input_required')
  })

  it('failed 任务把工作流置回 idle', () => {
    let { conv } = pair()
    const failed = transitionTask(bgTask(), { status: 'failed', error: '缺少 bsk' })
    conv = settleConversation(conv, failed)
    expect(conv.state).toBe('idle')
  })
})

describe('card 字段', () => {
  const base = () => createTask({ id: 't1', parentSessionId: 'p1', conversationId: 'c1', predecessorTaskId: null, subject: '查距离', prompt: 'p' })

  it('completed 时 card 随 transitionTask 持久化', () => {
    const card = { title: '对比', items: [{ type: 'table', columns: ['a'], rows: [['1']] }] }
    const task = transitionTask({ ...base(), status: 'running' }, { status: 'completed', result: 'ok', card })
    expect(task.card).toEqual(card)
  })

  it('running 迁移不携带终态字段（输入类型已收敛）', () => {
    const task = transitionTask({ ...base(), status: 'queued' }, { status: 'running', progressNote: 'x' })
    expect(task.result).toBeUndefined()
    expect(task.card).toBeUndefined()
    expect(task.error).toBeUndefined()
  })

  it('cardValidationError：非 object / 超 16KB / 含三反引号', async () => {
    const { cardValidationError } = await import('../src/types.ts')
    expect(cardValidationError('string')).toContain('expected object')
    expect(cardValidationError([1])).toContain('expected object')
    expect(cardValidationError({ big: 'x'.repeat(16385) })).toContain('exceeds 16384')
    expect(cardValidationError({ ok: true })).toBeUndefined()
    expect(cardValidationError({ fence: '```dsh-ui' })).toContain('fence marker')
  })
})
