import type { ScheduleSnapshot } from '../types.ts'

/** 由近及远排序：有 startAt 的按开始时间升序（纯日期按本地零点），无时间沉底，同组按创建时间稳定排序。 */
function scheduleStartMs(schedule: ScheduleSnapshot): number {
  if (!schedule.startAt) return Number.MAX_SAFE_INTEGER
  const dateOnly = schedule.startAt.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dateOnly) return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])).getTime()
  const t = Date.parse(schedule.startAt)
  return Number.isNaN(t) ? Number.MAX_SAFE_INTEGER : t
}

export const sortSchedules = (list: ScheduleSnapshot[]): ScheduleSnapshot[] =>
  [...list].sort((a, b) => scheduleStartMs(a) - scheduleStartMs(b) || a.createdAt.localeCompare(b.createdAt))
