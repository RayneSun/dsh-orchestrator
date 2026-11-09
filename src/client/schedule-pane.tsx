import React, { useMemo, useState } from 'react'
import type { ScheduleSnapshot } from '../types.ts'
import { ScheduleList } from './schedule-list.tsx'
import { sortSchedules } from './schedule-ordering.ts'

const PRIORITY_COLORS: Record<ScheduleSnapshot['priority'], string> = { P0: '#d5483f', P1: '#e08300', P2: '#b59a00', P3: '#3d9a50' }

const pad2 = (n: number): string => String(n).padStart(2, '0')

/** 本地时区 YYYY-MM-DD（与月历/日列表共用）。 */
const dateKey = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const

const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/

/** 时间值 → 本地日历日 YYYY-MM-DD：全天纯日期原样返回（不经 Date.parse，避免时区平移），时刻值转本地日。 */
function dayKeyOf(raw: string): string | undefined {
  if (DATE_ONLY_RE.test(raw)) return raw
  const t = Date.parse(raw)
  return Number.isNaN(t) ? undefined : dateKey(new Date(t))
}

/** 日程结束毫秒：全天纯日期按当日 23:59:59.999（尾日包含），时刻值按时间戳。 */
function scheduleEndMs(schedule: ScheduleSnapshot): number | undefined {
  if (!schedule.endAt) return undefined
  if (DATE_ONLY_RE.test(schedule.endAt)) return new Date(`${schedule.endAt}T23:59:59.999`).getTime()
  const t = Date.parse(schedule.endAt)
  return Number.isNaN(t) ? undefined : t
}

/** 日程页：月历（优先级色点）+ 选中日列表（过期置顶组），行组件与看板共用。 */
export function SchedulePane({ schedules, onToggle, onOpenAttachment, showToast }: {
  schedules: ScheduleSnapshot[]
  onToggle: (schedule: ScheduleSnapshot) => void
  onOpenAttachment: (schedule: ScheduleSnapshot, path: string) => void
  showToast: (text: string) => void
}): React.ReactElement {
  const now = useMemo(() => new Date(), [schedules])
  const [view, setView] = useState(() => ({ y: now.getFullYear(), m: now.getMonth() }))
  const [selected, setSelected] = useState<string>(() => dateKey(now))

  // 只索引当前月，长日程按月裁剪；无开始时间的日程只留在会话页。
  const byDay = useMemo(() => {
    const map = new Map<string, ScheduleSnapshot[]>()
    const monthStart = dateKey(new Date(view.y, view.m, 1))
    const monthEnd = dateKey(new Date(view.y, view.m + 1, 0))
    for (const schedule of schedules) {
      if (!schedule.startAt || schedule.status === 'cancelled') continue
      const start = dayKeyOf(schedule.startAt)
      if (!start) continue
      const end = (schedule.endAt ? dayKeyOf(schedule.endAt) : undefined) ?? start
      const cursor = new Date(`${start > monthStart ? start : monthStart}T00:00:00`)
      const last = end < monthEnd ? end : monthEnd
      while (dateKey(cursor) <= last) {
        const key = dateKey(cursor)
        map.set(key, [...(map.get(key) ?? []), schedule])
        cursor.setDate(cursor.getDate() + 1)
      }
    }
    for (const [key, list] of map) map.set(key, sortSchedules(list))
    return map
  }, [schedules, view.y, view.m])

  const firstDow = (new Date(view.y, view.m, 1).getDay() + 6) % 7 // 周一起始
  const daysInMonth = new Date(view.y, view.m + 1, 0).getDate()
  const todayKey = dateKey(now)
  const daySchedules = (byDay.get(selected) ?? [])
    .filter(schedule => schedule.status !== 'cancelled')
  const overdue = daySchedules.filter(schedule =>
    schedule.status === 'pending' && (end => end !== undefined && end < now.getTime())(scheduleEndMs(schedule)))
  const current = daySchedules.filter(schedule => !overdue.includes(schedule))
  const selDate = new Date(`${selected}T00:00:00`)

  const shiftMonth = (delta: number): void => {
    const d = new Date(view.y, view.m + delta, 1)
    setView({ y: d.getFullYear(), m: d.getMonth() })
    setSelected(dateKey(d))
  }
  const gotoToday = (): void => {
    setView({ y: now.getFullYear(), m: now.getMonth() })
    setSelected(todayKey)
  }

  const dayList = (group: ScheduleSnapshot[], label?: string, overdueGroup = false) => <>
    {label && <div className={`dsho-groupLabel${overdueGroup ? ' overdue' : ''}`}>{label}</div>}
    <ScheduleList schedules={group} onToggle={onToggle} onOpenAttachment={onOpenAttachment} showToast={showToast} boxed={false} showSource />
  </>

  return <div>
    <div className="dsho-cal">
      <div className="dsho-calHead">
        <span className="dsho-calTitle">{view.y} 年 {view.m + 1} 月</span>
        <span className="dsho-calNav">
          <button type="button" onClick={() => shiftMonth(-1)} aria-label="上个月">‹</button>
          <button type="button" className="wide" onClick={gotoToday}>今天</button>
          <button type="button" onClick={() => shiftMonth(1)} aria-label="下个月">›</button>
        </span>
      </div>
      <div className="dsho-calGrid">
        {['一', '二', '三', '四', '五', '六', '日'].map(dow => <div key={dow} className="dsho-dow">{dow}</div>)}
        {Array.from({ length: firstDow }, (_, i) => <div key={`blank-${i}`} />)}
        {Array.from({ length: daysInMonth }, (_, i) => {
          const key = `${view.y}-${pad2(view.m + 1)}-${pad2(i + 1)}`
          const dayPending = sortSchedules(byDay.get(key) ?? []).filter(s => s.status === 'pending')
          const dots = dayPending.slice(0, 3)
          const total = dayPending.length
          return <div key={key}
            className={`dsho-day${key === todayKey ? ' today' : ''}${key === selected ? ' sel' : ''}`}
            onClick={() => setSelected(key)}>
            {i + 1}
            {dots.length > 0 && <span className="dsho-dayDots">
              {dots.map(s => <span key={s.id} className="dsho-dayDot" style={{ background: PRIORITY_COLORS[s.priority] }} />)}
            </span>}
            {total > 3 && <span className="dsho-dayMore">+{total - 3}</span>}
          </div>
        })}
      </div>
    </div>
    <div className="dsho-dayTitle">
      {`${selDate.getMonth() + 1} 月 ${selDate.getDate()} 日 周${WEEKDAYS[selDate.getDay()]}`}
      {daySchedules.length > 0 && <span className="cnt">· {daySchedules.length} 条</span>}
    </div>
    {daySchedules.length === 0 && <p className="dsho-empty" style={{ padding: 12 }}>这一天没有日程。</p>}
    {overdue.length > 0 && dayList(overdue, `已过期 ${overdue.length}`, true)}
    {current.length > 0 && dayList(current)}
  </div>
}
