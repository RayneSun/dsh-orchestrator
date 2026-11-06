import React, { useState } from 'react'
import type { ScheduleSnapshot } from '../types.ts'

/** ISO 8601 时间点或全天纯日期 → { date: 'MM-DD', time: ' HH:mm'（整点/23:59 省略）, t }。
 * endOfDay 用于全天 endAt 的过期判定（按当日 23:59:59.999，整日有效）。 */
function parseTimePoint(raw: string, endOfDay = false): { date: string; time: string; t: number } | undefined {
  const dateOnly = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (dateOnly) {
    const [, y, m, d] = dateOnly
    const t = endOfDay
      ? new Date(Number(y), Number(m) - 1, Number(d), 23, 59, 59, 999).getTime()
      : new Date(Number(y), Number(m) - 1, Number(d)).getTime()
    return { date: `${m}-${d}`, time: '', t }
  }
  const t = Date.parse(raw)
  if (Number.isNaN(t)) return undefined
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const hh = d.getHours(), mm = d.getMinutes()
  // 00:00 视为纯日期、23:59 视为"当日内"（旧 dueDate 迁移值），都不展示时刻
  const time = (hh === 0 && mm === 0) || (hh === 23 && mm === 59) ? '' : ` ${pad(hh)}:${pad(mm)}`
  return { date, time, t }
}

type ScheduleTimeTone = 'neutral' | 'active' | 'soon' | 'over'

/** startAt/endAt → 时间胶囊文本与状态色。 */
function timeRange(schedule: ScheduleSnapshot): { text: string; tone: ScheduleTimeTone } | undefined {
  if (!schedule.startAt && !schedule.endAt) return undefined
  const start = schedule.startAt ? parseTimePoint(schedule.startAt) : undefined
  const end = schedule.endAt ? parseTimePoint(schedule.endAt, true) : undefined
  if ((schedule.startAt && !start) || (schedule.endAt && !end)) {
    return { text: [schedule.startAt, schedule.endAt].filter(Boolean).join(' → '), tone: 'neutral' }
  }
  const now = Date.now()
  const tone: ScheduleTimeTone =
    end && now > end.t ? 'over'
    : start && now >= start.t && (!end || now <= end.t) ? 'active'
    : end && end.t - now <= 3 * 24 * 3600 * 1000 ? 'soon'
    : 'neutral'
  let text: string
  if (start && end) {
    text = start.date === end.date
      ? `${start.date}${start.time}${end.time ? ` →${end.time}` : ''}`
      : `${start.date}${start.time} → ${end.date}${end.time}`
  } else if (end) {
    text = tone === 'over' ? `已过期 ${end.date}` : `结束 ${end.date}${end.time}`
  } else {
    text = `${start!.date}${start!.time} 起`
  }
  return { text, tone }
}

/** ISO 8601 提醒时间 → "M-D HH:mm" 展示。 */
function remindLabel(remindAt: string): string | undefined {
  const time = Date.parse(remindAt)
  if (Number.isNaN(time)) return undefined
  const d = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 链接显示名：label 缺省回退域名。 */
function linkLabel(link: ScheduleSnapshot["links"][number]): string {
  if (link.label) return link.label
  try { return new URL(link.url).hostname } catch { return link.url }
}

/** 日程行列表：看板会话页与日程页共用同一组件（showSource 时多一行「来自 xx」回链）。 */
export function ScheduleList({ schedules, onToggle, onOpenAttachment, showToast, showSource = false, boxed = true }: {
  schedules: ReadonlyArray<ScheduleSnapshot>
  onToggle: (schedule: ScheduleSnapshot) => void
  onOpenAttachment: (schedule: ScheduleSnapshot, path: string) => void
  showToast: (text: string) => void
  /** 日程页展示来源回链（conversationTitle）。 */
  showSource?: boolean
  /** 看板会话页带框（dsho-todos + 汇总头）；日程页裸列表。 */
  boxed?: boolean
}): React.ReactElement {
  const [openId, setOpenId] = useState<string>()
  const pending = schedules.filter(schedule => schedule.status === 'pending').length
  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text).then(() => showToast(`已复制${what}：${text}`), () => showToast(`${what}：${text}`))
  }
  const rows = schedules.map(schedule => {
    const done = schedule.status === 'done'
    const cancelled = schedule.status === 'cancelled'
    const time = timeRange(schedule)
    const remind = schedule.remindAt ? remindLabel(schedule.remindAt) : undefined
    const hasDetail = Boolean(schedule.remark || schedule.links.length || schedule.attachments.length || schedule.contacts.length || schedule.location)
    return <div key={schedule.id} className={`dsho-todo${done ? ' dsho-todo-done' : ''}${cancelled ? ' dsho-todo-cancelled' : ''}${openId === schedule.id ? ' dsho-todo-open' : ''}`}>
      <button
        type="button"
        className="dsho-todoCheck"
        title={cancelled ? '已作废' : done ? '取消完成' : '标记完成'}
        disabled={cancelled}
        onClick={event => { event.stopPropagation(); onToggle(schedule) }}
      >{done ? '✓' : cancelled ? '×' : ''}</button>
      <div className="dsho-todoBody" onClick={() => hasDetail && setOpenId(openId === schedule.id ? undefined : schedule.id)}>
        <div className="dsho-todoLine">
          <span className="dsho-todoTitle">{schedule.title}{cancelled && <span className="dsho-todoCancelledTag">已作废</span>}</span>
          <span className={`dsho-todoPriority dsho-todoPriority-${schedule.priority}`}>{schedule.priority}</span>
          <span className={`dsho-todoTime dsho-todoTime-${time?.tone ?? 'neutral'}`}>{time?.text}</span>
          {remind && <span className="dsho-todoTime">⏰ {remind}</span>}
        </div>
        {openId === schedule.id && <div className="dsho-todoDetail">
          {schedule.remark && <div className="dsho-dRow"><span className="dsho-dIcon">📝</span><span className="dsho-dText">{schedule.remark}</span></div>}
          {schedule.links.length > 0 && <div className="dsho-dRow"><span className="dsho-dIcon">🔗</span><span className="dsho-dChips">
            {schedule.links.map(link => <button key={link.url} type="button" className="dsho-chip dsho-chip-link" title={link.url}
              onClick={event => { event.stopPropagation(); window.open(link.url, '_blank', 'noopener') }}>{linkLabel(link)}</button>)}
          </span></div>}
          {schedule.attachments.length > 0 && <div className="dsho-dRow"><span className="dsho-dIcon">📎</span><span className="dsho-dChips">
            {schedule.attachments.map(attachment => <button key={attachment.path} type="button" className="dsho-chip dsho-chip-file"
              title={attachment.path} onClick={event => { event.stopPropagation(); onOpenAttachment(schedule, attachment.path) }}>{attachment.name ?? attachment.path}</button>)}
          </span></div>}
          {schedule.contacts.length > 0 && <div className="dsho-dRow"><span className="dsho-dIcon">👤</span><span className="dsho-dChips">
            {schedule.contacts.map(contact => {
              const action = contact.phone ?? contact.email
              const what = contact.phone ? '电话' : '邮箱'
              return <button key={`${contact.name}-${action ?? ''}`} type="button" className="dsho-chip dsho-chip-person"
                title={`${contact.name}${action ? ` ${action}` : ''}${contact.note ? `（${contact.note}）` : ''}${action ? '，点击复制' : ''}`}
                onClick={event => { event.stopPropagation(); if (action) copy(action, what) }}>
                <b>{contact.name}</b>{action && <em>{action}</em>}
              </button>
            })}
          </span></div>}
          {schedule.location && <div className="dsho-dRow"><span className="dsho-dIcon">📍</span><span className="dsho-dChips">
            <span className="dsho-chip dsho-chip-place">{schedule.location.name}{schedule.location.address ? ` · ${schedule.location.address}` : ''}</span>
          </span></div>}
          {showSource && <div className="dsho-src">来自 {schedule.conversationTitle ?? '子会话'}</div>}
        </div>}
      </div>
      {/* 折叠态：来源回链第二行；展开态：并入详情最后一行（结构上仍是 todoBody 之后的兄弟行） */}
      {showSource && openId !== schedule.id && <div className="dsho-src">来自 {schedule.conversationTitle ?? '子会话'}</div>}
    </div>
  })
  if (!boxed) return <div>{rows}</div>
  return <div className="dsho-todos">
    <div className="dsho-todosHead">日程 <span className="dsho-todosCount">{pending > 0 ? `${pending} 项待处理` : '全部完成'}</span></div>
    {rows}
  </div>
}
