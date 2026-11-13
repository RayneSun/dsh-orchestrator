import { describe, expect, it } from 'vitest'
import { scheduleObjectSchema, type ScheduleSnapshot } from '../src/types.ts'
import { dayKeyOf, scheduleDayRange, scheduleEndMs, toCalendarEvent, unscheduledItems } from '../src/client/schedule-calendar.ts'

function schedule(patch: Partial<ScheduleSnapshot>): ScheduleSnapshot {
  return {
    ...scheduleObjectSchema.parse({
      id: 'sch_base', parentSessionId: 'lead', conversationId: 'conv', title: '事项',
      createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-01T00:00:00Z',
    }),
    conversationTitle: '来源会话',
    ...patch,
  }
}

describe('看板月历事件适配', () => {
  it('全天包含式尾日转换为 FullCalendar 排他尾日，并保留优先级颜色', () => {
    const event = toCalendarEvent(schedule({
      allDay: true, startAt: '2026-11-10', endAt: '2026-11-13', priority: 'P0',
    }))
    expect(event).toMatchObject({
      start: '2026-11-10', end: '2026-11-14', allDay: true, color: '#d5483f', contrastColor: '#fff',
    })
    expect(scheduleDayRange(schedule({ allDay: true, startAt: '2026-11-10', endAt: '2026-11-13' })))
      .toEqual({ start: '2026-11-10', end: '2026-11-13' })
  })

  it('普通日程保留绝对时间，缺少结束日时按单日展示', () => {
    const startAt = '2026-11-13T09:00:00+08:00'
    const endAt = '2026-11-13T10:30:00+08:00'
    expect(toCalendarEvent(schedule({ startAt, endAt }))).toMatchObject({ start: startAt, end: endAt, allDay: false })
    expect(toCalendarEvent(schedule({ startAt }))).toMatchObject({ start: startAt, end: undefined })
  })

  it('无开始时间、非法时间和已作废日程不进入月历', () => {
    expect(toCalendarEvent(schedule({ endAt: '2026-11-13T10:30:00+08:00' }))).toBeUndefined()
    expect(toCalendarEvent(schedule({ startAt: 'invalid' }))).toBeUndefined()
    expect(toCalendarEvent(schedule({ startAt: '2026-11-13', allDay: true, status: 'cancelled' }))).toBeUndefined()
  })

  it('全天过期判定覆盖整个尾日', () => {
    const item = schedule({ allDay: true, startAt: '2026-11-10', endAt: '2026-11-13' })
    expect(scheduleEndMs(item)).toBe(new Date('2026-11-13T23:59:59.999').getTime())
    expect(dayKeyOf(item.endAt!)).toBe('2026-11-13')
  })

  it('未安排按优先级和创建时间倒序排列，只有结束时间也保留', () => {
    const items = unscheduledItems([
      schedule({ id: 'p3-old', priority: 'P3', createdAt: '2026-11-01T00:00:00Z' }),
      schedule({ id: 'p1', priority: 'P1', createdAt: '2026-11-02T00:00:00Z' }),
      schedule({ id: 'p3-new', priority: 'P3', createdAt: '2026-11-03T00:00:00Z' }),
      schedule({ id: 'end-only', priority: 'P0', endAt: '2026-11-04T10:00:00+08:00' }),
      schedule({ id: 'cancelled', status: 'cancelled' }),
      schedule({ id: 'scheduled', startAt: '2026-11-13T09:00:00+08:00' }),
    ])
    expect(items.map(item => item.id)).toEqual(['end-only', 'p1', 'p3-new', 'p3-old'])
  })
})
