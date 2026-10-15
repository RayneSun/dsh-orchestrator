import { describe, expect, it } from 'vitest'
import { createConversation, createTask } from '../src/types.ts'
import {
  StateError, activateConversation, applyOutlinePatch, assertRevision,
  interruptTaskForRevision, reviseConversation, canTransition, failTask, failTaskWithoutTerminalReport, interruptTaskAfterRestart,
  isTerminal, settleConversation, startConversation, transitionTask,
} from '../src/state-machine.ts'

function pair() {
  let conv = createConversation({ id: 'c1', childSessionId: 'child', parentSessionId: 'p', title: 't' })
  let task = createTask({
    id: 't1', parentSessionId: 'p', conversationId: 'c1', predecessorTaskId: null,
    subject: 's', prompt: 'do', responseMode: 'wait',
  })
  conv = activateConversation(conv, task.id)
  task = { ...task, status: 'running' }
  return { conv, task }
}

describe('任务状态机', () => {
  it('completed 缺少 userAnswer 时拒绝', () => {
    const { task } = pair()
    expect(() => transitionTask(task, { status: 'completed' })).toThrowError(StateError)
  })

  it('终态不能再次迁移', () => {
    let { task } = pair()
    task = transitionTask(task, { status: 'completed', userAnswer: 'done' })
    expect(() => transitionTask(task, { status: 'running' })).toThrow(/cannot move/)
  })

  it('成功完成会释放 Conversation', () => {
    let { conv, task } = pair()
    task = transitionTask(task, { status: 'completed', userAnswer: '晴' })
    conv = settleConversation(conv, task)
    expect(conv.state).toBe('idle')
    expect(conv.activeTaskId).toBeNull()
  })

  it('缺少终态上报会把结束轮次标记失败', () => {
    let { conv, task } = pair()
    task = failTaskWithoutTerminalReport(task)
    conv = settleConversation(conv, task)
    expect(task.status).toBe('failed')
    expect(conv.state).toBe('failed')
  })

  it('同一工作流同时只能有一个活动任务', () => {
    const { conv } = pair()
    expect(() => activateConversation(conv, 't2')).toThrow(/already runs task t1/)
  })

  it('outline patch 合并去重标签和实体', () => {
    const { conv } = pair()
    const next = applyOutlinePatch(conv, { tags: ['天气', '天气', '穿衣'], entities: ['温度'] })
    expect(next.outline.tags).toEqual(['天气', '穿衣'])
    expect(next.outline.entities).toEqual(['温度'])
  })
})


describe('状态迁移和修订号', () => {
  it('blocked 必须说明原因，failed 必须带 error', () => {
    const queued = createTask({
      id: 't', parentSessionId: 'p', conversationId: 'c', predecessorTaskId: null,
      subject: 's', prompt: 'p', responseMode: 'wait',
    })
    expect(() => transitionTask(queued, { status: 'blocked' })).toThrow(/blocked/)
    expect(() => transitionTask(queued, { status: 'failed' })).toThrow(/failed/)
    expect(transitionTask(queued, { status: 'failed', error: 'boom' }).status).toBe('failed')
  })

  it('queued 可直接完成，完成后修订号递增且不能继续迁移', () => {
    const task = createTask({
      id: 't', parentSessionId: 'p', conversationId: 'c', predecessorTaskId: null,
      subject: 's', prompt: 'p', responseMode: 'wait',
    })
    const done = transitionTask(task, { status: 'completed', userAnswer: '答案' })
    expect(done.revision).toBe(1)
    expect(done.endedAt).toBe(done.updatedAt)
    expect(canTransition(done.status, 'running')).toBe(false)
  })

  it('终态任务再次失败时保持原记录不变', () => {
    const { task } = pair()
    const done = transitionTask(task, { status: 'completed', userAnswer: 'done' })
    expect(failTask(done, 'later')).toBe(done)
  })

  it('expected revision 不一致时拒绝乐观更新', () => {
    const conv = createConversation({
      id: 'c', childSessionId: 'child', parentSessionId: 'p',
      title: 't',
    })
    expect(() => assertRevision(conv, 3)).toThrowError(StateError)
    expect(() => assertRevision(conv, 0)).not.toThrow()
    expect(startConversation(conv).state).toBe('running')
  })

  it('重启恢复会把后台活动任务转 blocked 并保留待投递 outbox', () => {
    const task = createTask({
      id: 't', parentSessionId: 'p', conversationId: 'c', predecessorTaskId: null,
      subject: 's', prompt: 'p', responseMode: 'background',
    })
    const blocked = interruptTaskAfterRestart(task)
    expect(blocked.status).toBe('blocked')
    expect(blocked.delivery).toEqual({ state: 'pending', attempts: 0 })
  })
})

describe('改单中断与 Worker 提问', () => {
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

  it('blocked 可携带给用户的问题', () => {
    const task = createTask({
      id: 't', parentSessionId: 'p', conversationId: 'c', predecessorTaskId: null,
      subject: 's', prompt: 'p', responseMode: 'background',
    })
    const blocked = transitionTask(task, { status: 'blocked', question: '要做 PvP 还是 PvE？' })
    expect(blocked.blockedQuestion).toBe('要做 PvP 还是 PvE？')
  })

  it('blocked 只有问题没有 error/progressNote 也合法', () => {
    const task = createTask({
      id: 't', parentSessionId: 'p', conversationId: 'c', predecessorTaskId: null,
      subject: 's', prompt: 'p', responseMode: 'background',
    })
    expect(() => transitionTask(task, { status: 'blocked', question: 'q?' })).not.toThrow()
  })
})
