import { describe, expect, it } from 'vitest'
import { planScheduleChanges } from '../src/schedule-changes.ts'
import { createConversation, scheduleObjectSchema, taskTodoInputSchema } from '../src/types.ts'

const conversation = createConversation({ id: 'conversation', childSessionId: 'worker', parentSessionId: 'lead', title: '演示' })
const existing = scheduleObjectSchema.parse({
  id: 'schedule', parentSessionId: 'lead', conversationId: 'conversation', title: '原始',
  startAt: '2026-11-06T10:00:00+08:00', createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
})

describe('日程变更规划', () => {
  it('同一条日程的多次 patch 按顺序合并', () => {
    const input = taskTodoInputSchema.parse({ update: [
      { id: 'schedule', title: '改名' }, { id: 'schedule', priority: 'P0', status: 'done' },
    ] })
    expect(planScheduleChanges(conversation, input, [existing])).toEqual([
      expect.objectContaining({ title: '改名', priority: 'P0', status: 'done', completedBy: 'worker' }),
    ])
    expect(existing.title).toBe('原始')
  })

  it('更新必须归属当前会话', () => {
    const input = taskTodoInputSchema.parse({ update: [{ id: 'schedule', title: '改名' }] })
    expect(() => planScheduleChanges(conversation, input, [{ ...existing, conversationId: 'other' }])).toThrow('schedule not found')
  })

  it('合并后的时间冲突在任何写入前报错', () => {
    const input = taskTodoInputSchema.parse({
      create: [{ title: '新增' }], update: [{ id: 'schedule', endAt: '2026-11-05T10:00:00+08:00' }],
    })
    expect(() => planScheduleChanges(conversation, input, [existing])).toThrow('schedule schedule:')
  })
})
