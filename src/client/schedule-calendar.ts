import type { EventInput } from '@fullcalendar/react'
import type { ScheduleSnapshot } from '../types.ts'

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/
const PRIORITY_COLORS: Record<ScheduleSnapshot['priority'], string> = {
  P0: '#d5483f', P1: '#d97706', P2: '#a87900', P3: '#2f8f57',
}

const pad2 = (value: number): string => String(value).padStart(2, '0')

/** 本地时区日历日；全天纯日期不得先转 UTC。 */
export const dateKey = (date: Date): string =>
  `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`

export function dayKeyOf(raw: string): string | undefined {
  if (DATE_ONLY_RE.test(raw)) return raw
  const timestamp = Date.parse(raw)
  return Number.isNaN(timestamp) ? undefined : dateKey(new Date(timestamp))
}

/** 日程在日历上的包含式日期范围。 */
export function scheduleDayRange(schedule: ScheduleSnapshot): { start: string; end: string } | undefined {
  if (!schedule.startAt || schedule.status === 'cancelled') return undefined
  const start = dayKeyOf(schedule.startAt)
  if (!start) return undefined
  const end = schedule.endAt ? dayKeyOf(schedule.endAt) : undefined
  return { start, end: end ?? start }
}

export function scheduleEndMs(schedule: ScheduleSnapshot): number | undefined {
  if (!schedule.endAt) return undefined
  if (DATE_ONLY_RE.test(schedule.endAt)) return new Date(`${schedule.endAt}T23:59:59.999`).getTime()
  const timestamp = Date.parse(schedule.endAt)
  return Number.isNaN(timestamp) ? undefined : timestamp
}

/** FullCalendar 的全天 end 为排他日期；插件协议的全天 endAt 为包含日期。 */
function calendarEnd(schedule: ScheduleSnapshot): string | undefined {
  if (!schedule.endAt) return undefined
  if (!schedule.allDay || !DATE_ONLY_RE.test(schedule.endAt)) return schedule.endAt
  const date = new Date(`${schedule.endAt}T00:00:00`)
  date.setDate(date.getDate() + 1)
  return dateKey(date)
}

export function toCalendarEvent(schedule: ScheduleSnapshot): EventInput | undefined {
  if (!scheduleDayRange(schedule)) return undefined
  return {
    id: schedule.id,
    title: schedule.title,
    start: schedule.startAt!,
    end: calendarEnd(schedule),
    allDay: schedule.allDay,
    color: PRIORITY_COLORS[schedule.priority],
    contrastColor: '#fff',
    extendedProps: {
      priority: schedule.priority,
      priorityRank: Number(schedule.priority.slice(1)),
      status: schedule.status,
    },
  }
}

/** 无开始时间的待办进入底部“未安排”：优先级优先，同级近期创建在前。 */
export function unscheduledItems(schedules: ScheduleSnapshot[]): ScheduleSnapshot[] {
  return schedules
    .filter(schedule => !schedule.startAt && schedule.status !== 'cancelled')
    .sort((a, b) => a.priority.localeCompare(b.priority) || b.createdAt.localeCompare(a.createdAt))
}
