import { describe, expect, it } from 'vitest'
import { createConversation, createTask } from '../src/types.ts'
import {
  StateError, activateConversation, applyOutlinePatch, failTaskWithoutTerminalReport,
  settleConversation, transitionTask,
} from '../src/state-machine.ts'

function pair() {
  let conv = createConversation({ id: 'c1', childSessionId: 'child', parentSessionId: 'p', scene: 'code', title: 't' })
  let task = createTask({
    id: 't1', parentSessionId: 'p', conversationId: 'c1', predecessorTaskId: null,
    subject: 's', prompt: 'do', scene: 'code', responseMode: 'wait',
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
