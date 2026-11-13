import type { z } from 'zod'

const pad2 = (n: number) => String(n).padStart(2, '0')

/** Date → 本地 ISO 8601（带 ±HH:mm 偏移，比 UTC Z 形式更可读）。 */
function toLocalIso(d: Date): string {
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
}

/** 宽松时间点解析：模型友好简写 → 归一化为带时区的完整 ISO 8601。
 * 合法输入："10-28 18:00"（省略年份=最近未来）、"2026-10-28 18:00"、"2026-10-28T18:00"、
 * "2026-10-28"（当日 00:00）、完整 ISO 8601（Z 或 ±HH:mm）。自然语言（"明天下午"）拒绝。 */
export function normalizeTimePoint(raw: string): string | undefined {
  const match = raw.trim().match(/^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:\d{2})?$/)
  if (!match) return undefined
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr, zone] = match
  const month = Number(monthStr), day = Number(dayStr)
  const hour = hourStr === undefined ? 0 : Number(hourStr)
  const minute = minuteStr === undefined ? 0 : Number(minuteStr)
  const second = secondStr === undefined ? 0 : Number(secondStr)
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined
  if (zone) {
    const full = `${yearStr ?? String(new Date().getFullYear())}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}${zone}`
    const parsed = new Date(full)
    return Number.isNaN(parsed.getTime()) ? undefined : toLocalIso(parsed)
  }
  const now = new Date()
  let year = yearStr ? Number(yearStr) : now.getFullYear()
  let local = new Date(year, month - 1, day, hour, minute, second)
  // 校验日期真实存在（2-30 会被 Date 滑到 3 月，回读比对拒绝）
  if (local.getMonth() !== month - 1 || local.getDate() !== day) return undefined
  if (!yearStr && local.getTime() < now.getTime()) {
    year += 1
    local = new Date(year, month - 1, day, hour, minute, second)
  }
  return toLocalIso(local)
}

/** 纯日期（全天待办/日程）：完整 YYYY-MM-DD、真实存在、不落时区。 */
export function normalizeDateOnly(raw: string): string | undefined {
  const match = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (!match) return undefined
  const [, y, m, d] = match
  const date = new Date(Number(y), Number(m) - 1, Number(d))
  return date.getFullYear() === Number(y) && date.getMonth() === Number(m) - 1 && date.getDate() === Number(d)
    ? `${y}-${m}-${d}`
    : undefined
}

export const isDateOnly = (value: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(value.trim())

/**
 * 日程时间字段按 allDay 分叉解析，返回可直接并入记录的规范化字段：
 * - allDay=true：startAt 必填纯日期 YYYY-MM-DD（不省略年、不带时刻）；endAt 可选、尾日包含、≥ startAt。
 * - allDay=false：startAt/endAt 可选但必须带时刻（纯日期拒绝，提示改用 allDay），走宽松简写归一化。
 * - patch 模式（update 条目）：显式改 allDay 必须同时给 startAt；未声明 allDay 时按普通待办/日程解析。
 *   service 合并整条记录后用 scheduleConsistencyError 校验最终一致性。
 * 输出只包含 patch 实际带来的字段，避免合并时把缺省值覆盖到旧记录上。
 */
export function resolveScheduleTimes(
  value: { allDay?: boolean, startAt?: string, endAt?: string },
  ctx: z.RefinementCtx,
  patchMode = false,
): { allDay?: boolean, startAt?: string, endAt?: string } | undefined {
  const issue = (field: string, message: string): undefined => {
    ctx.addIssue({ code: 'custom', path: [field], message })
    return undefined
  }
  if (patchMode && value.allDay !== undefined && value.startAt === undefined) {
    return issue('startAt', '切换全天状态必须同时提供新格式的 startAt（原子切换，禁止只改 allDay）')
  }
  const normalizeTimed = (raw: string): string | undefined => {
    // 普通待办/日程必须带时刻（"2026-11-04"、"10-25" 等纯日期一律拒绝，强制模型用 allDay 表态）
    if (isDateOnly(raw) || !/[T ]\d{1,2}:\d{2}/.test(raw)) return undefined
    return normalizeTimePoint(raw)
  }
  if (value.allDay ?? false) {
    if (!value.startAt) return issue('startAt', '全天待办/日程必须提供 startAt（YYYY-MM-DD 纯日期）')
    const start = normalizeDateOnly(value.startAt)
    if (!start) return issue('startAt', '全天待办/日程 startAt 必须是完整 YYYY-MM-DD 纯日期（不省略年、不带时刻）')
    let end: string | undefined
    if (value.endAt !== undefined) {
      end = normalizeDateOnly(value.endAt)
      if (!end) return issue('endAt', '全天待办/日程 endAt 必须是完整 YYYY-MM-DD 纯日期（尾日包含当天）')
      if (end < start) return issue('endAt', 'endAt（尾日包含）不能早于 startAt')
    }
    return { allDay: true, startAt: start, ...end !== undefined ? { endAt: end } : {} }
  }
  const start = value.startAt !== undefined ? normalizeTimed(value.startAt) : undefined
  if (value.startAt !== undefined && !start) {
    return issue('startAt', '普通待办/日程时间必须带时刻（如 "10-28 09:00"）；纯日期属于全天事项，请设置 allDay: true')
  }
  const end = value.endAt !== undefined ? normalizeTimed(value.endAt) : undefined
  if (value.endAt !== undefined && !end) {
    return issue('endAt', '普通待办/日程时间必须带时刻（如 "10-28 22:00"）；纯日期属于全天事项，请设置 allDay: true')
  }
  if (start && end && Date.parse(start) > Date.parse(end)) {
    return issue('startAt', 'startAt 不能晚于 endAt')
  }
  if (patchMode) {
    return {
      ...(value.allDay !== undefined ? { allDay: false } : {}),
      ...start !== undefined ? { startAt: start } : {},
      ...end !== undefined ? { endAt: end } : {},
    }
  }
  return { allDay: false, ...start !== undefined ? { startAt: start } : {}, ...end !== undefined ? { endAt: end } : {} }
}

/** 持久化日程整体一致性校验（service 合并 update patch 后调用）：allDay 与 startAt/endAt 格式必须互洽。 */
export function scheduleConsistencyError(record: { allDay?: boolean, startAt?: string, endAt?: string }): string | undefined {
  if (record.allDay) {
    if (!record.startAt || !isDateOnly(record.startAt)) {
      return '待办/日程为全天（allDay），startAt 必须是 YYYY-MM-DD 纯日期；切换时间格式需同时更新 allDay 与 startAt'
    }
    if (record.endAt !== undefined) {
      if (!isDateOnly(record.endAt)) return '全天待办/日程 endAt 必须是 YYYY-MM-DD 纯日期'
      if (record.endAt < record.startAt) return 'endAt（尾日包含）不能早于 startAt'
    }
    return undefined
  }
  if (record.startAt && isDateOnly(record.startAt)) return 'startAt 为纯日期需 allDay: true'
  if (record.endAt && isDateOnly(record.endAt)) return 'endAt 为纯日期需 allDay: true'
  if (record.startAt && record.endAt && Date.parse(record.startAt) > Date.parse(record.endAt)) return 'startAt 不能晚于 endAt'
  return undefined
}
