import React, { useMemo, useRef, useState } from 'react'
import FullCalendar from '@fullcalendar/react'
import dayGridPlugin from '@fullcalendar/react/daygrid'
import interactionPlugin from '@fullcalendar/react/interaction'
import breezyThemePlugin from '@fullcalendar/react/themes/breezy'
import type { CalendarRef, EventInput } from '@fullcalendar/react'
import type { ScheduleSnapshot } from '../types.ts'
import { ScheduleList } from './schedule-list.tsx'
import { sortSchedules } from './schedule-ordering.ts'
import { dateKey, scheduleDayRange, scheduleEndMs, toCalendarEvent, unscheduledItems } from './schedule-calendar.ts'

const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'] as const

/** 日程页：Breezy 月历色条 + 选中日列表 + 未安排待办，行组件与看板共用。 */
export function SchedulePane({ schedules, onToggle, onOpenAttachment, showToast }: {
  schedules: ScheduleSnapshot[]
  onToggle: (schedule: ScheduleSnapshot) => void
  onOpenAttachment: (schedule: ScheduleSnapshot, path: string) => void
  showToast: (text: string) => void
}): React.ReactElement {
  const now = useMemo(() => new Date(), [schedules])
  const todayKey = dateKey(now)
  const [viewTitle, setViewTitle] = useState(`${now.getFullYear()} 年 ${now.getMonth() + 1} 月`)
  const [selected, setSelected] = useState(todayKey)
  const calendarRef = useRef<CalendarRef>(null)
  const calendarRootRef = useRef<HTMLDivElement>(null)

  const events = useMemo(() => schedules
    .map(toCalendarEvent)
    .filter((event): event is EventInput => Boolean(event)), [schedules])
  const unscheduled = useMemo(() => unscheduledItems(schedules), [schedules])
  const daySchedules = useMemo(() => sortSchedules(schedules.filter(schedule => {
    const range = scheduleDayRange(schedule)
    return range && range.start <= selected && range.end >= selected
  })), [schedules, selected])
  const overdue = daySchedules.filter(schedule =>
    schedule.status === 'pending' && (end => end !== undefined && end < now.getTime())(scheduleEndMs(schedule)))
  const current = daySchedules.filter(schedule => !overdue.includes(schedule))
  const selectedDate = new Date(`${selected}T00:00:00`)

  const selectDate = (key: string): void => {
    const api = calendarRef.current?.getApi()
    if (api && key.slice(0, 7) !== dateKey(api.getDate()).slice(0, 7)) api.gotoDate(key)
    setSelected(key)
  }
  const shiftMonth = (delta: number): void => {
    const current = calendarRef.current?.getApi().getDate() ?? now
    const next = new Date(current.getFullYear(), current.getMonth() + delta, 1)
    setViewTitle(`${next.getFullYear()} 年 ${next.getMonth() + 1} 月`)
    selectDate(dateKey(next))
  }
  const dateAtPoint = (x: number, y: number): string | undefined => {
    const cells = calendarRootRef.current?.querySelectorAll<HTMLElement>('.dsho-day[data-date]') ?? []
    for (const cell of cells) {
      const rect = cell.getBoundingClientRect()
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return cell.dataset.date
    }
    return undefined
  }
  const dayList = (group: ScheduleSnapshot[], label?: string, overdueGroup = false) => <>
    {label && <div className={`dsho-groupLabel${overdueGroup ? ' overdue' : ''}`}>{label}</div>}
    <ScheduleList schedules={group} onToggle={onToggle} onOpenAttachment={onOpenAttachment} showToast={showToast} boxed={false} showSource />
  </>

  return <div>
    <section className="dsho-cal">
      <div className="dsho-calHead">
        <div className="dsho-calHeading">
          <span className="dsho-calTitle">{viewTitle}</span>
          <span className="dsho-calSubtitle">待办 / 日程</span>
        </div>
        <span className="dsho-calNav">
          <button type="button" onClick={() => shiftMonth(-1)} aria-label="上个月">‹</button>
          <button type="button" className="wide" onClick={() => selectDate(todayKey)}>今天</button>
          <button type="button" onClick={() => shiftMonth(1)} aria-label="下个月">›</button>
        </span>
      </div>
      <div className="dsho-calMonth" ref={calendarRootRef}>
        <FullCalendar
          ref={calendarRef}
          plugins={[dayGridPlugin, interactionPlugin, breezyThemePlugin]}
          initialView="dayGridMonth"
          initialDate={now}
          now={now}
          locale="zh-cn"
          firstDay={1}
          fixedWeekCount={false}
          height="auto"
          headerToolbar={false}
          borderless
          dayMaxEventRows={5}
          dayHeaderClass="dsho-dowCell"
          dayHeaderContent={info => <span className={`dsho-dow${info.dow === 0 || info.dow === 6 ? ' weekend' : ''}`}>{WEEKDAYS[info.dow]}</span>}
          viewClass="dsho-calView"
          dayRowClass="dsho-calWeek"
          dayCellClass={info => {
            const key = dateKey(info.date)
            return ['dsho-day', info.isOther && 'dim', key === todayKey && 'today', key === selected && 'sel'].filter(Boolean).join(' ')
          }}
          dayCellInnerClass="dsho-dayInner"
          dayCellTopClass="dsho-dayTop"
          dayCellTopContent={info => <span className="dsho-dayNum">{info.date.getDate()}</span>}
          events={events}
          eventOrder="priorityRank,title"
          eventClass={info => [
            'dsho-calEvent',
            `dsho-calEvent-${info.event.extendedProps.priority}`,
            info.event.extendedProps.status === 'done' && 'done',
            info.isStart && 'start',
            info.isEnd && 'end',
          ].filter(Boolean).join(' ')}
          eventInnerClass="dsho-calEventInner"
          eventContent={info => info.event.title}
          eventDidMount={info => {
            info.el.title = info.event.title
            info.el.setAttribute('aria-label', info.event.title)
          }}
          moreLinkClass="dsho-calMore"
          moreLinkContent={info => `展开 ${info.num} 项`}
          moreLinkClick="popover"
          dateClick={info => selectDate(info.dateStr)}
          eventClick={info => {
            info.jsEvent.preventDefault()
            selectDate(dateAtPoint(info.jsEvent.clientX, info.jsEvent.clientY) ?? dateKey(info.event.start!))
          }}
          datesSet={info => {
            const date = info.view.currentStart
            setViewTitle(`${date.getFullYear()} 年 ${date.getMonth() + 1} 月`)
          }}
        />
      </div>
      <div className="dsho-calLegend">
        {(['P0', 'P1', 'P2', 'P3'] as const).map(priority => <span key={priority}><i className={`dsho-calLegend-${priority}`} />{priority}</span>)}
        <span className="dsho-calLegendHint">点击日期查看当日事项</span>
      </div>
    </section>

    <section className="dsho-dayPanel">
      <div className="dsho-dayTitle">
        {`${selectedDate.getMonth() + 1} 月 ${selectedDate.getDate()} 日 周${WEEKDAYS[selectedDate.getDay()]}`}
        <span className="cnt">· {daySchedules.length} 项</span>
        {selected === todayKey && <span className="dsho-todayTag">今天</span>}
      </div>
      {daySchedules.length === 0 && <p className="dsho-dayEmpty">这一天没有待办/日程</p>}
      {overdue.length > 0 && dayList(overdue, `已过期 ${overdue.length}`, true)}
      {current.length > 0 && dayList(current)}
    </section>

    {unscheduled.length > 0 && <section className="dsho-unscheduled">
      <div className="dsho-unscheduledHead">
        <span className="dsho-unscheduledTitle">未安排</span>
        <span className="dsho-unscheduledCount">{unscheduled.length}</span>
        <span className="dsho-unscheduledRule">优先级优先 · 同级近期创建在前</span>
      </div>
      <ScheduleList schedules={unscheduled} onToggle={onToggle} onOpenAttachment={onOpenAttachment} showToast={showToast} boxed={false} showSource />
    </section>}
  </div>
}
