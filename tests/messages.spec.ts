import { describe, expect, it } from 'vitest'
import { deliveryNotice, todoStatusSection } from '../src/messages.ts'
import { createConversation, createTask, type ConversationRecord, type TaskRecord } from '../src/types.ts'
import { LEAD_PROMPT, rosterSummarySegment, WORKER_PROMPT } from '../src/messages.ts'

describe('roster 摘要段', () => {
  it('空摘要/纯空白不产生片段', () => {
    expect(rosterSummarySegment(undefined)).toBe('')
    expect(rosterSummarySegment('   ')).toBe('')
  })

  it('60 字以内原样输出，超长截断并加省略号', () => {
    expect(rosterSummarySegment('做一个飞机大战游戏')).toBe('｜摘要 做一个飞机大战游戏')
    const long = '长'.repeat(80)
    expect(rosterSummarySegment(long)).toBe(`｜摘要 ${'长'.repeat(60)}…`)
  })
})

describe('deliveryNotice 用户待办段', () => {
  const baseTask = (): TaskRecord => ({
    ...createTask({ id: 't1', parentSessionId: 'p1', conversationId: 'c1', predecessorTaskId: null, subject: '查距离', prompt: 'p' }),
    status: 'completed',
    report: { result: '安贞最近' },
  })

  it('有待办时附带 pending 清单与代办指引；无待办不带该段', () => {
    const conv: ConversationRecord = {
      ...createConversation({ id: 'c1', childSessionId: 's1', parentSessionId: 'p1', title: '体检' }),
      todos: [{
        id: 'todo_1', title: '拨打预约电话', remark: '工作日 8:00-17:00', dueDate: '2026-10-27',
        status: 'pending', priority: 'P3' as const, links: [], attachments: [], contacts: [], createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
      }, {
        id: 'todo_2', title: '已完成事项', status: 'done', completedBy: 'user', priority: 'P3' as const, links: [], attachments: [], contacts: [],
        createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
      }],
    }
    const text = deliveryNotice(baseTask(), conv)
    expect(text).toContain('用户待办')
    expect(text).toContain('[todo_1] 拨打预约电话')
    expect(text).toContain('截止 2026-10-27')
    expect(text).toContain("userTodos.update")
    expect(text).not.toContain('todo_2')
    const without = deliveryNotice(baseTask(), { ...conv, todos: [] })
    expect(without).not.toContain('用户待办')
  })
})

describe('todoStatusSection 投递附言', () => {
  const base = {
    createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
  }
  it('pending 全列含 id；用户标完成的列出防重复代办；worker 标完成与 cancelled 不提', () => {
    const text = todoStatusSection([
      { ...base, id: 'todo_1', title: '买火车票', dueDate: '2026-10-25', status: 'pending', priority: 'P3' as const, links: [], attachments: [], contacts: [] },
      { ...base, id: 'todo_2', title: '取快递', status: 'done', priority: 'P3' as const, links: [], attachments: [], contacts: [], completedBy: 'user' as const },
      { ...base, id: 'todo_3', title: '已代办的', status: 'done', priority: 'P3' as const, links: [], attachments: [], contacts: [], completedBy: 'worker' as const },
      { ...base, id: 'todo_4', title: '作废的', status: 'cancelled', priority: 'P3' as const, links: [], attachments: [], contacts: [] },
    ])
    expect(text).toContain('[todo_1] 买火车票（截止 2026-10-25） — 待处理')
    expect(text).toContain('[todo_2] 取快递 — 用户已自行标记完成，不要重复代办')
    expect(text).not.toContain('todo_3')
    expect(text).not.toContain('todo_4')
  })
  it('空清单或全无可提项时不产生片段', () => {
    expect(todoStatusSection([])).toBe('')
    expect(todoStatusSection([{ ...base, id: 'todo_1', title: 'x', status: 'cancelled', priority: 'P3' as const, links: [], attachments: [], contacts: [] }])).toBe('')
  })
})

describe('prompt 编排约定', () => {
  it('Lead prompt 约定一事一会、定时任务编排与 subject 改名', () => {
    expect(LEAD_PROMPT).toContain('schedule_create 绑定它自己的会话')
    expect(LEAD_PROMPT).toContain('subject 写成新主题')
    expect(LEAD_PROMPT).toContain('一事一会')
    expect(LEAD_PROMPT).toContain('复用它的 conversationId')
  })

  it('Worker prompt 约定 progressNote 拟人化幽默风格', () => {
    expect(WORKER_PROMPT).toContain('拟人口吻')
    expect(WORKER_PROMPT).toContain('不许编造')
  })

  it('Worker prompt 约定重复模式主动建议定时任务', () => {
    expect(WORKER_PROMPT).toContain('反复定期出现')
    expect(WORKER_PROMPT).toContain('schedule_create 绑定本会话')
  })
})
