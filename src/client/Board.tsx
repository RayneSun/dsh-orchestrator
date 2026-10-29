import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { activeTaskStatuses } from '../types.ts'
import type { ConversationRecord, ProgressStep, QuestionItem, Snapshot, TaskRecord, UserTodo } from '../types.ts'

interface BoardProps {
  sessionId?: string
  useTabInfo?: () => { tab: { navigation?: { params?: unknown } } }
  orchestrator: {
    snapshot(request: { parentSessionId: string }): Promise<{ ok: true; value: Snapshot } | { ok: false; error?: { message?: string } }>
    setTodoStatus(request: { todoId: string; status: 'pending' | 'done' }): Promise<{ ok: true }>
    answerTaskQuestions(request: { childSessionId: string; answers: Array<{ id: string; selected?: string[]; custom?: string }> }): Promise<{ ok: boolean; error?: string }>
  }
  remoteEvents: {
    $on(event: string, listener: () => void): () => void
    session?: {
      openWorkspacePath?(request: { path: string; action?: 'reveal' }): Promise<{ ok: boolean; error?: { message?: string } }>
    }
  }
  uiWorkspace: any
}

/** Material do_not_disturb_on：静默标识（与 DSH 应用内图标同源，内联避免依赖应用内部 alias）。 */
function SilentIcon(): React.ReactElement {
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11H7v-2h10v2z" /></svg>
}
/** Material schedule：定时标识。 */
function ScheduleIcon(): React.ReactElement {
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z" /></svg>
}
function FileIcon(): React.ReactElement {
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z" /></svg>
}

function TagChip(props: { kind: 'silent' | 'scheduled'; title: string }): React.ReactElement {
  return <span className={`dsho-tag dsho-tag-${props.kind}`} title={props.title} aria-label={props.title}>
    {props.kind === 'silent' ? <SilentIcon /> : <ScheduleIcon />}
  </span>
}

function time(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

/** 看板内的时间统一用短格式：10-29 09:31，避免整串年份挤占窄栏。 */
function shortTime(value?: string): string {
  const t = Date.parse(value ?? '')
  if (Number.isNaN(t)) return value ?? '—'
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function durationText(task: TaskRecord, nowMs: number): string {
  const start = Date.parse(task.startedAt ?? task.createdAt)
  if (Number.isNaN(start)) return ''
  const end = task.endedAt ? Date.parse(task.endedAt) : nowMs
  if (Number.isNaN(end) || end < start) return ''
  const seconds = Math.floor((end - start) / 1000)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes > 0) return `耗时 ${minutes}m${String(rest).padStart(2, '0')}s`
  return `耗时 ${rest}s`
}

function tabSessionId(useTabInfo?: BoardProps['useTabInfo']): string | undefined {
  try {
    const params = useTabInfo?.().tab.navigation?.params as { sessionId?: string } | undefined
    return typeof params?.sessionId === 'string' ? params.sessionId : undefined
  } catch {
    return undefined
  }
}

const taskStatusLabels: Record<string, string> = {
  queued: '排队中', running: '进行中', input_required: '待你操作', completed: '已完成',
  failed: '失败', interrupted: '已中断',
}
const blockReasonLabels: Record<string, string> = {
  permission_denied: '权限', configuration: '配置', dependency: '依赖',
  network: '网络', resource: '资源', runtime: '运行时',
}
const convStateLabels: Record<string, string> = {
  provisioning: '启动中', running: '进行中', idle: '空闲', input_required: '待你操作', failed: '失败',
}

function firstLine(text: string | undefined): string {
  return (text ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? ''
}

/** 折叠态时间行 / 兜底标题文本。 */
function taskHeadline(task: TaskRecord): string {
  switch (task.status) {
    case 'running':
      return task.progressNote ?? ''
    case 'input_required':
      return firstLine(task.questions?.[0]?.question) || '等待用户操作'
    case 'completed':
      return firstLine(task.report?.result) || '已完成'
    case 'failed':
      return firstLine(task.fail?.error) || '执行失败'
    case 'interrupted':
      return task.cancelledReason || '已中断'
    case 'queued':
      return '排队等待执行'
    default:
      return ''
  }
}

/** ISO 8601 时间点 → { date: 'MM-DD', time: ' HH:mm'（整点/23:59 省略）, t }。 */
function fmtTimePoint(iso: string): { date: string; time: string; t: number } | undefined {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return undefined
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  const date = `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const hh = d.getHours(), mm = d.getMinutes()
  // 00:00 视为纯日期、23:59 视为"当日内"（旧 dueDate 迁移值），都不展示时刻
  const time = (hh === 0 && mm === 0) || (hh === 23 && mm === 59) ? '' : ` ${pad(hh)}:${pad(mm)}`
  return { date, time, t }
}

type TodoTimeTone = 'neutral' | 'active' | 'soon' | 'over'

/** startAt/endAt → 时间胶囊文本与状态色。 */
function timeRange(todo: UserTodo): { text: string; tone: TodoTimeTone } | undefined {
  if (!todo.startAt && !todo.endAt) return undefined
  const start = todo.startAt ? fmtTimePoint(todo.startAt) : undefined
  const end = todo.endAt ? fmtTimePoint(todo.endAt) : undefined
  if ((todo.startAt && !start) || (todo.endAt && !end)) {
    return { text: [todo.startAt, todo.endAt].filter(Boolean).join(' → '), tone: 'neutral' }
  }
  const now = Date.now()
  const tone: TodoTimeTone =
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
function linkLabel(link: UserTodo['links'][number]): string {
  if (link.label) return link.label
  try { return new URL(link.url).hostname } catch { return link.url }
}

/** 会话级用户待办框：折叠/展开都显示，用户画勾走 setTodoStatus RPC，点行展开详情。 */
function TodoList({ todos, onToggle, onOpenAttachment, showToast }: {
  todos: UserTodo[]
  onToggle: (todo: UserTodo) => void
  onOpenAttachment: (path: string) => void
  showToast: (text: string) => void
}): React.ReactElement {
  const [openId, setOpenId] = useState<string>()
  const pending = todos.filter(todo => todo.status === 'pending').length
  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text).then(() => showToast(`已复制${what}：${text}`), () => showToast(`${what}：${text}`))
  }
  return <div className="dsho-todos">
    <div className="dsho-todosHead">待办 <span className="dsho-todosCount">{pending > 0 ? `${pending} 项待处理` : '全部完成'}</span></div>
    {todos.map(todo => {
      const done = todo.status === 'done'
      const cancelled = todo.status === 'cancelled'
      const time = timeRange(todo)
      const remind = todo.remindAt ? remindLabel(todo.remindAt) : undefined
      const hasDetail = Boolean(todo.remark || todo.links.length || todo.attachments.length || todo.contacts.length || todo.location)
      return <div key={todo.id} className={`dsho-todo${done ? ' dsho-todo-done' : ''}${cancelled ? ' dsho-todo-cancelled' : ''}${openId === todo.id ? ' dsho-todo-open' : ''}`}>
        <button
          type="button"
          className="dsho-todoCheck"
          title={cancelled ? '已作废' : done ? '取消完成' : '标记完成'}
          disabled={cancelled}
          onClick={event => { event.stopPropagation(); onToggle(todo) }}
        >{done ? '✓' : cancelled ? '×' : ''}</button>
        <div className="dsho-todoBody" onClick={() => hasDetail && setOpenId(openId === todo.id ? undefined : todo.id)}>
          <div className="dsho-todoLine">
            <span className="dsho-todoTitle">{todo.title}{cancelled && <span className="dsho-todoCancelledTag">已作废</span>}</span>
            <span className={`dsho-todoTime dsho-todoTime-${time?.tone ?? 'neutral'}`}>{time?.text}</span>
            {remind && <span className="dsho-todoTime">⏰ {remind}</span>}
          </div>
          {openId === todo.id && <div className="dsho-todoDetail">
            {todo.remark && <div className="dsho-dRow"><span className="dsho-dIcon">📝</span><span className="dsho-dText">{todo.remark}</span></div>}
            {todo.links.length > 0 && <div className="dsho-dRow"><span className="dsho-dIcon">🔗</span><span className="dsho-dChips">
              {todo.links.map(link => <button key={link.url} type="button" className="dsho-chip dsho-chip-link" title={link.url}
                onClick={event => { event.stopPropagation(); window.open(link.url, '_blank', 'noopener') }}>{linkLabel(link)}</button>)}
            </span></div>}
            {todo.attachments.length > 0 && <div className="dsho-dRow"><span className="dsho-dIcon">📎</span><span className="dsho-dChips">
              {todo.attachments.map(attachment => <button key={attachment.path} type="button" className="dsho-chip dsho-chip-file"
                title={attachment.path} onClick={event => { event.stopPropagation(); onOpenAttachment(attachment.path) }}>{attachment.name ?? attachment.path}</button>)}
            </span></div>}
            {todo.contacts.length > 0 && <div className="dsho-dRow"><span className="dsho-dIcon">👤</span><span className="dsho-dChips">
              {todo.contacts.map(contact => {
                const action = contact.phone ?? contact.email
                const what = contact.phone ? '电话' : '邮箱'
                return <button key={`${contact.name}-${action ?? ''}`} type="button" className="dsho-chip dsho-chip-person"
                  title={`${contact.name}${action ? ` ${action}` : ''}${contact.note ? `（${contact.note}）` : ''}${action ? '，点击复制' : ''}`}
                  onClick={event => { event.stopPropagation(); if (action) copy(action, what) }}>
                  <b>{contact.name}</b>{action && <em>{action}</em>}
                </button>
              })}
            </span></div>}
            {todo.location && <div className="dsho-dRow"><span className="dsho-dIcon">📍</span><span className="dsho-dChips">
              <span className="dsho-chip dsho-chip-place">{todo.location.name}{todo.location.address ? ` · ${todo.location.address}` : ''}</span>
            </span></div>}
          </div>}
        </div>
      </div>
    })}
  </div>
}

function StepList({ steps }: { steps: ProgressStep[] }): React.ReactElement | null {
  if (steps.length === 0) return null
  return <ul className="dsho-steps">
    {steps.map((step, index) => <li key={`${index}-${step.content}`} className={`dsho-step-${step.status}`}>
      <span className="dsho-stepIcon">
        {step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '●' : ''}
      </span>
      <span>{step.content}</span>
    </li>)}
  </ul>
}

/** 问题卡：看板侧的作答入口（子会话工具行卡与主会话原生卡共用同一 RPC 路由）。 */
function AskCard({ task, onSubmit }: {
  task: TaskRecord
  onSubmit: (answers: Array<{ id: string; selected?: string[]; custom?: string }>) => Promise<void>
}): React.ReactElement {
  const questions = task.questions ?? []
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [customs, setCustoms] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()
  const togglePick = (item: QuestionItem, label: string): void => {
    setPicked(prev => {
      const current = prev[item.id] ?? []
      if (item.multi_select) {
        return { ...prev, [item.id]: current.includes(label) ? current.filter(v => v !== label) : [...current, label] }
      }
      return { ...prev, [item.id]: current.includes(label) ? [] : [label] }
    })
  }
  const submit = async (): Promise<void> => {
    if (submitting) return
    const answers = questions.map(item => ({
      id: item.id,
      ...(picked[item.id]?.length ? { selected: picked[item.id] } : {}),
      ...(customs[item.id]?.trim() ? { custom: customs[item.id]!.trim() } : {}),
    })).filter(answer => (answer.selected?.length ?? 0) > 0 || answer.custom !== undefined)
    if (answers.length === 0) { setError('请先选择或填写至少一项回答'); return }
    setSubmitting(true)
    setError(undefined)
    try {
      await onSubmit(answers)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }
  return <div className="dsho-ask">
    <div className="dsho-askHead"><span className="dsho-askIcon">?</span>子会话向你提问 · {task.subject}</div>
    {questions.map(item => <div key={item.id} className="dsho-askItem">
      <div className="dsho-askQ">{item.header ? <b>{item.header}：</b> : null}{item.question}</div>
      {item.detail && <div className="dsho-askDetail">{item.detail}</div>}
      {item.options && item.options.length > 0 && <div className="dsho-askOpts">
        {item.options.map(option => {
          const selected = picked[item.id]?.includes(option.label) ?? false
          return <button key={option.label} type="button"
            className={`dsho-opt${selected ? ' dsho-opt-sel' : ''}`}
            title={option.description}
            onClick={() => togglePick(item, option.label)}>{option.label}</button>
        })}
      </div>}
      {!item.options?.length && <input
        className="dsho-askCustom"
        placeholder="输入回答（可选）"
        value={customs[item.id] ?? ''}
        onChange={event => setCustoms(prev => ({ ...prev, [item.id]: event.target.value }))}
      />}
      {item.options?.length > 0 && <input
        className="dsho-askCustom"
        placeholder="补充说明（可选）"
        value={customs[item.id] ?? ''}
        onChange={event => setCustoms(prev => ({ ...prev, [item.id]: event.target.value }))}
      />}
    </div>)}
    {error && <div className="dsho-askError">{error}</div>}
    <button type="button" className="dsho-askSubmit" disabled={submitting} onClick={() => void submit()}>
      {submitting ? '提交中…' : '提交回答'}
    </button>
  </div>
}

/** 任务行头：状态 badge + 静默/定时标识 + 主题；interrupted 的简化行与普通行共用。 */
function TaskHead({ task }: { task: TaskRecord }): React.ReactElement {
  return <div className="dsho-taskHead">
    <span className={`dsho-badge dsho-badge-${task.status}`}>{taskStatusLabels[task.status] ?? task.status}</span>
    {task.silent && <TagChip kind="silent" title="静默：终态不通知主会话" />}
    {task.scheduled && <TagChip kind="scheduled" title="定时触发：由定时任务自动执行" />}
    <span className="dsho-taskSubject" title={task.subject}>{task.subject}</span>
  </div>
}

interface TaskLineProps {
  task: TaskRecord
  conv: ConversationRecord
  nowMs: number
  onOpenArtifact: (conv: ConversationRecord, artifact: string) => void
}

function TaskLine({ task, conv, nowMs, onOpenArtifact }: TaskLineProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const running = (activeTaskStatuses as readonly string[]).includes(task.status)
  const result = task.report?.result
  const artifacts = task.report?.artifacts ?? []
  const live = task.status === 'running' && !task.endedAt
  const duration = durationText(task, nowMs)

  // 展开区内容按状态聚合：完整结果/失败原因、用户已回答、验收、制品、投递状态。
  const detailSections: React.ReactElement[] = []
  if (result) detailSections.push(<div key="res" className="dsho-detailSec"><b>结果</b>：{result}</div>)
  if (task.answers?.length) detailSections.push(<div key="ans" className="dsho-detailSec"><b>已回答</b>：{task.answers.map(answer => {
    const parts = [answer.selected.length > 0 ? answer.selected.join('、') : '', answer.custom ?? ''].filter(Boolean)
    return `[${answer.id}] ${parts.join('；') || '（未作答）'}`
  }).join('；')}</div>)
  if (task.status === 'failed' && task.fail) {
    detailSections.push(<div key="err" className="dsho-detailSec">
      <b>失败原因</b>：{task.fail.error}
      {task.fail.reasonCode && <>（<b>{blockReasonLabels[task.fail.reasonCode] ?? task.fail.reasonCode}</b> 阻碍，处理后可继续）</>}
    </div>)
  }
  if (task.acceptanceCriteria) detailSections.push(<div key="ac" className="dsho-detailSec"><b>验收标准</b>：{task.acceptanceCriteria}</div>)
  if (artifacts.length > 0) detailSections.push(<div key="arts" className="dsho-detailSec">
    <b>制品</b>（点击打开）：
    <div className="dsho-arts">{artifacts.map(artifact => <button
      key={artifact}
      type="button"
      className="dsho-art"
      title={`${conv.workspaceName ? `${conv.workspaceName}/` : ''}${artifact}`}
      onClick={() => onOpenArtifact(conv, artifact)}
    ><FileIcon />{artifact}</button>)}</div>
  </div>)
  if (task.delivery?.state === 'pending') detailSections.push(<div key="dp" className="dsho-detailSec dsho-subtle">
    {task.delivery.attempts === 0 ? '正在把结果同步回主会话…' : `同步未成功（已重试 ${task.delivery.attempts} 次，将自动继续）${task.delivery.lastError ? ` · ${task.delivery.lastError}` : ''}`}
  </div>)
  if (task.delivery?.state === 'delivered') detailSections.push(<div key="dd" className="dsho-detailSec dsho-subtle">已同步回主会话 · {shortTime(task.delivery.deliveredAt)}</div>)

  const expanderLabel = task.status === 'failed' ? '查看错误' : '查看结果'
  if (task.status === 'interrupted') {
    return <li className="dsho-task dsho-taskMuted">
      <TaskHead task={task} />
      {task.cancelledReason && <p className="dsho-subtle">{task.cancelledReason}</p>}
      <div className="dsho-taskFoot"><span>创建 {shortTime(task.createdAt)}</span>{duration && <span className="dsho-dur">{duration}</span>}</div>
    </li>
  }

  return <li className="dsho-task">
    <TaskHead task={task} />
    <StepList steps={task.progressSteps ?? []} />
    {(task.header || task.progressNote || detailSections.length > 0) && <div className={`dsho-note${live ? ' dsho-note-live' : ''}`}>
      {task.header && <><span className="dsho-noteTitle">{task.header}</span><span className="dsho-noteSep">:</span></>}
      <span className="dsho-noteText">{task.progressNote || (live ? '正在推进…' : taskHeadline(task))}</span>
      {detailSections.length > 0 && <button type="button" className="dsho-expander" onClick={() => setExpanded(v => !v)}>{expanded ? '收起' : expanderLabel}</button>}
    </div>}
    {expanded && detailSections.length > 0 && <div className={`dsho-detail${task.status === 'failed' ? ' dsho-detail-err' : ''}`}>{detailSections}</div>}
    <div className="dsho-taskFoot">
      <span>创建 {shortTime(task.createdAt)}</span>
      {duration && <span className={`dsho-dur${live ? ' dsho-dur-live' : ''}`}>{duration}</span>}
    </div>
  </li>
}

/** 任务框：圈住多轮任务，默认折叠只显示最新一轮（新→旧）。 */
function TaskBox({ conv, tasks, nowMs, onOpenArtifact }: {
  conv: ConversationRecord
  tasks: TaskRecord[]
  nowMs: number
  onOpenArtifact: (conv: ConversationRecord, artifact: string) => void
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const rounds = [...tasks].reverse()
  return <div className={`dsho-taskBox${expanded ? '' : ' dsho-taskBox-collapsed'}`}>
    <div className="dsho-taskBoxHead" onClick={() => setExpanded(v => !v)}>
      <span className="dsho-chevron" aria-hidden />
      任务
      <span className="dsho-taskBoxCnt">{rounds.length} 轮 · {expanded ? '全部展开' : '显示最新'}</span>
    </div>
    <ul className="dsho-tasks">
      {rounds.map(task => <TaskLine key={task.id} task={task} conv={conv} nowMs={nowMs} onOpenArtifact={onOpenArtifact} />)}
    </ul>
  </div>
}

export function Board({ sessionId: propSessionId, useTabInfo, orchestrator, remoteEvents, uiWorkspace }: BoardProps): React.ReactElement {
  const tabSession = tabSessionId(useTabInfo)
  const sessionId = propSessionId ?? tabSession
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>()
  const requestSeq = useRef(0)
  // 用户手动折叠/展开覆盖默认行为；默认活动子会话展开、结束的折叠。
  const [collapsedOverride, setCollapsedOverride] = useState<Record<string, boolean>>({})
  const [error, setError] = useState<string>()
  // 进行中任务的耗时每秒实时刷新。
  const [nowMs, setNowMs] = useState(() => Date.now())

  const load = useCallback(async (seq: number) => {
    if (!sessionId) return
    try {
      const result = await orchestrator.snapshot({ parentSessionId: sessionId })
      if (requestSeq.current !== seq) return
      if (result.ok === true) {
        setSnapshot(result.value)
        setError(undefined)
      } else {
        setError(result.error?.message ?? '读取任务看板失败')
      }
    } catch (err) {
      if (requestSeq.current === seq) setError(err instanceof Error ? err.message : String(err))
    }
  }, [orchestrator, sessionId])

  useEffect(() => {
    const seq = ++requestSeq.current
    setSnapshot(undefined)
    setError(undefined)
    void load(seq)
    const timer = setInterval(() => { void load(++requestSeq.current) }, 5000)
    const ticker = setInterval(() => setNowMs(Date.now()), 1000)
    let disposeEvent: (() => void) | undefined
    try {
      disposeEvent = remoteEvents.$on('commands/change', () => { void load(++requestSeq.current) })
    } catch {
      // 轮询仍是重连和事件不可用时的兜底。
    }
    return () => {
      requestSeq.current += 1
      clearInterval(timer)
      clearInterval(ticker)
      disposeEvent?.()
    }
  }, [load, remoteEvents])

  const tasksByConversation = useMemo(() => {
    const map = new Map<string, TaskRecord[]>()
    for (const task of snapshot?.tasks ?? []) {
      map.set(task.conversationId, [...(map.get(task.conversationId) ?? []), task])
    }
    return map
  }, [snapshot])

  // 制品点击反馈：成功/失败都给 toast，打开失败自动降级为在文件管理器中显示。
  const [toast, setToast] = useState<string>()
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()
  const showToast = useCallback((text: string) => {
    setToast(text)
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(undefined), 2200)
  }, [])
  useEffect(() => () => clearTimeout(toastTimer.current), [])

  const openArtifact = useCallback(async (conv: ConversationRecord, artifact: string) => {
    // 注意：remoteEvents.session 的 getter 本身就可能抛错（cordis inject 可见性），
    // 必须把整个函数体包进 try，否则点击静默无反馈。
    try {
      const opener = remoteEvents.session?.openWorkspacePath
      if (!opener) { showToast('当前环境不支持打开文件'); return }
      if (!conv.workspaceDir) { showToast('缺少工作区路径，无法打开'); return }
      const path = `${conv.workspaceDir.replace(/\/+$/, '')}/${artifact}`
      const opened = await opener({ path })
      if (opened?.ok) { showToast(`已打开：${artifact}`); return }
      const revealed = await opener({ path, action: 'reveal' })
      showToast(revealed?.ok ? `已在文件管理器中显示：${artifact}` : `打开失败：${opened?.error?.message ?? revealed?.error?.message ?? '未知错误'}`)
    } catch (err) {
      showToast(`打开失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [remoteEvents, showToast])

  // 用户画勾/取消待办：走 RPC 持久化后立刻刷新看板。
  const toggleTodo = useCallback(async (todo: UserTodo) => {
    try {
      await orchestrator.setTodoStatus({ todoId: todo.id, status: todo.status === 'done' ? 'pending' : 'done' })
      void load(++requestSeq.current)
    } catch (err) {
      showToast(`更新待办失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [orchestrator, load, showToast])

  // 问题卡作答：走 answerTaskQuestions RPC，Host 重开任务并注入 Worker。
  const submitAnswers = useCallback(async (conv: ConversationRecord, answers: Array<{ id: string; selected?: string[]; custom?: string }>) => {
    const result = await orchestrator.answerTaskQuestions({ childSessionId: conv.childSessionId, answers })
    if (result.ok) {
      showToast('已回答，任务继续中')
      void load(++requestSeq.current)
    } else {
      throw new Error(result.error ?? '提交失败')
    }
  }, [orchestrator, load, showToast])

  if (!sessionId) return <div className="dsho-board"><h2 className="dsho-title">任务看板</h2><p className="dsho-empty">无法确定主会话 ID。</p></div>
  if (error) return <div className="dsho-board"><h2 className="dsho-title">任务看板</h2><p className="dsho-empty dsho-error" role="alert">{error}</p></div>
  if (!snapshot) return <div className="dsho-board"><h2 className="dsho-title">任务看板</h2><p className="dsho-empty">正在加载任务看板…</p></div>
  if (snapshot.conversations.length === 0) {
    return <div className="dsho-board">
      <h2 className="dsho-title">任务看板</h2>
      <div className="dsho-empty">还没有子会话。向主控助理提出需要执行的任务后，这里会显示每个子会话的状态和任务进度。</div>
    </div>
  }

  const isSilentConversation = (convId: string): boolean => {
    const convTasks = tasksByConversation.get(convId) ?? []
    return convTasks[convTasks.length - 1]?.silent === true
  }

  return <div className="dsho-board">
    <h2 className="dsho-title">任务看板 · {snapshot.conversations.length} 个子会话</h2>
    {toast && <div className="dsho-toast" role="status">{toast}</div>}
    {snapshot.conversations.map(conv => {
      const tasks = tasksByConversation.get(conv.id) ?? []
      const latest = tasks[tasks.length - 1]
      const silentConv = isSilentConversation(conv.id)
      const active = conv.state === 'running' || conv.state === 'provisioning'
        || tasks.some(task => (activeTaskStatuses as readonly string[]).includes(task.status))
      // 会话头徽标跟随最新一轮任务；无任务时回退会话状态。
      const headState = latest ? latest.status : conv.state
      const collapsed = collapsedOverride[conv.id] ?? !active
      const toggle = (): void => setCollapsedOverride(prev => ({ ...prev, [conv.id]: !collapsed }))
      const awaitingInput = latest?.status === 'input_required' && (latest.questions?.length ?? 0) > 0
      return <section
        className={`dsho-conv${active ? ' dsho-conv-active' : ''}${collapsed ? ' dsho-conv-collapsed' : ''}`}
        key={conv.id}
      >
        <header
          className="dsho-convHead"
          role="button"
          tabIndex={0}
          aria-expanded={!collapsed}
          onClick={toggle}
          onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); toggle() } }}
        >
          <span className="dsho-chevron" aria-hidden />
          {silentConv && <TagChip kind="silent" title="静默工作流：终态不会通知主会话" />}
          {conv.hasActiveSchedule && <TagChip kind="scheduled" title="绑定了定时任务：到点自动触发并上报" />}
          <span className="dsho-convTitle" title={conv.title}>{conv.title}</span>
          <span className={`dsho-badge dsho-badge-${headState}`}>{taskStatusLabels[headState] ?? convStateLabels[headState] ?? headState}</span>
          <button className="dsho-open" type="button" onClick={event => {
            event.stopPropagation()
            try {
              // Worker 是一级根会话（无 subagent 血统），必须按普通会话打开；
              // 用 parent+child 的 subagent 寻址会被平台鉴权拒绝（subagent/unauthorized）。
              const opened = uiWorkspace.openSession(conv.childSessionId)
              Promise.resolve(opened).catch(err => {
                setError(err instanceof Error ? err.message : String(err))
              })
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err))
            }
          }}>打开子会话</button>
        </header>
        {/* 折叠态也恒显：问题卡 + 用户待办（会话头之下、任务区之外） */}
        {awaitingInput && latest && <AskCard task={latest} onSubmit={answers => submitAnswers(conv, answers)} />}
        {conv.todos.length > 0 && <TodoList todos={conv.todos} onToggle={toggleTodo} showToast={showToast} onOpenAttachment={path => void openArtifact(conv, path)} />}
        {collapsed && latest && <div className="dsho-collapsedTime">
          最新任务 · 创建 {shortTime(latest.createdAt)}{(() => { const d = durationText(latest, nowMs); return d ? ` · ${d}` : '' })()}
        </div>}
        <div className="dsho-body"><div>
          <div className="dsho-bodyInner">
            {conv.workspaceName && <div className="dsho-meta">工作区：{conv.workspaceName}</div>}
            <TaskBox conv={conv} tasks={tasks} nowMs={nowMs} onOpenArtifact={openArtifact} />
          </div>
        </div></div>
      </section>
    })}
  </div>
}
