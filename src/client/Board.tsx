import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ConversationRecord, ProgressStep, Snapshot, TaskRecord } from '../types.ts'

interface BoardProps {
  sessionId?: string
  useTabInfo?: () => { tab: { navigation?: { params?: unknown } } }
  orchestrator: { snapshot(request: { parentSessionId: string }): Promise<{ ok: true; value: Snapshot } | { ok: false; error?: { message?: string } }> }
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

const ACTIVE_TASK_STATUSES = ['queued', 'running']

const taskStatusLabels: Record<string, string> = {
  queued: '排队中', running: '进行中', input_required: '待操作', blocked: '已受阻', completed: '已完成',
  failed: '失败', cancelled: '已取消', interrupted: '已中断',
}
const blockReasonLabels: Record<string, string> = {
  permission_denied: '权限', configuration: '配置', dependency: '依赖',
  network: '网络', resource: '资源', runtime: '运行时',
}
const convStateLabels: Record<string, string> = {
  provisioning: '启动中', running: '进行中', idle: '空闲', input_required: '待操作', blocked: '已受阻', failed: '失败',
}

/** 折叠态展示的一行最新状态摘要。 */
function firstLine(text: string | undefined): string {
  return (text ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? ''
}

function taskHeadline(task: TaskRecord): string {
  switch (task.status) {
    case 'running':
      return task.progressNote ?? ''
    case 'input_required':
      return task.question || '等待用户操作或补充信息'
    case 'blocked':
      return task.remediation || task.error || '任务被系统环境阻碍'
    case 'completed':
      // 折叠条/兜底标题只取首行，避免整条 report 灌进一行摘要
      return firstLine(task.report?.result) || firstLine(task.userAnswer) || '已完成'
    case 'failed':
      return task.error || '执行失败'
    case 'interrupted':
    case 'cancelled':
      return task.cancelledReason || '已中断'
    case 'queued':
      return '排队等待执行'
    default:
      return ''
  }
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

interface TaskLineProps {
  task: TaskRecord
  conv: ConversationRecord
  nowMs: number
  onOpenArtifact: (conv: ConversationRecord, artifact: string) => void
}

function TaskLine({ task, conv, nowMs, onOpenArtifact }: TaskLineProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const running = (ACTIVE_TASK_STATUSES as string[]).includes(task.status)
  const result = task.report?.result ?? task.userAnswer
  const artifacts = task.report?.artifacts ?? []
  const live = running && !task.endedAt
  const duration = durationText(task, nowMs)

  // 展开区内容按状态聚合：摘要、完整结果/问题/失败原因、验收、制品、投递状态。
  const detailSections: React.ReactElement[] = []
  if (conv.outline.summary) detailSections.push(<div key="sum" className="dsho-detailSec"><b>摘要</b>：{conv.outline.summary}</div>)
  if (result) detailSections.push(<div key="res" className="dsho-detailSec"><b>结果</b>：{result}</div>)
  if (task.question) detailSections.push(<div key="q" className="dsho-detailSec"><b>待用户操作</b>：{task.question}</div>)
  if (task.status === 'blocked' && task.reasonCode) detailSections.push(<div key="rc" className="dsho-detailSec"><b>阻碍类型</b>：{blockReasonLabels[task.reasonCode] ?? task.reasonCode}</div>)
  if (task.error) detailSections.push(<div key="err" className="dsho-detailSec"><b>{task.status === 'blocked' ? '系统阻碍' : '失败原因'}</b>：{task.error}</div>)
  if (task.remediation) detailSections.push(<div key="rem" className="dsho-detailSec"><b>建议操作</b>：{task.remediation}</div>)
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
  if (task.delivery?.state === 'delivered') detailSections.push(<div key="dd" className="dsho-detailSec dsho-subtle">已同步回主会话 · {time(task.delivery.deliveredAt)}</div>)

  if (task.status === 'interrupted' || task.status === 'cancelled') {
    return <li className="dsho-task dsho-taskMuted">
      <div className="dsho-taskHead">
        <span className={`dsho-badge dsho-badge-${task.status}`}>{taskStatusLabels[task.status] ?? task.status}</span>
        {task.silent && <TagChip kind="silent" title="静默：终态不通知主会话" />}
        {task.scheduled && <TagChip kind="scheduled" title="定时触发：由定时任务自动执行" />}
        <span className="dsho-taskSubject" title={task.subject}>{task.subject}</span>
      </div>
      {task.cancelledReason && <p className="dsho-subtle">{task.cancelledReason}</p>}
      <div className="dsho-taskFoot"><span>创建 {time(task.createdAt)}</span>{duration && <span className="dsho-dur">{duration}</span>}</div>
    </li>
  }

  return <li className="dsho-task">
    <div className="dsho-taskHead">
      <span className={`dsho-badge dsho-badge-${task.status}`}>{taskStatusLabels[task.status] ?? task.status}</span>
      {task.silent && <TagChip kind="silent" title="静默：终态不通知主会话" />}
      {task.scheduled && <TagChip kind="scheduled" title="定时触发：由定时任务自动执行" />}
      <span className="dsho-taskSubject" title={task.subject}>{task.subject}</span>
    </div>
    <StepList steps={task.progressSteps ?? []} />
    {(task.progressNote || detailSections.length > 0) && <div className={`dsho-note${live ? ' dsho-note-live' : ''}`}>
      <span className="dsho-noteText">{task.progressNote || (live ? '正在推进…' : taskHeadline(task))}</span>
      {detailSections.length > 0 && <button type="button" className="dsho-expander" onClick={() => setExpanded(v => !v)}>{expanded ? '收起' : '展开详情'}</button>}
    </div>}
    {expanded && detailSections.length > 0 && <div className="dsho-detail">{detailSections}</div>}
    <div className="dsho-taskFoot">
      <span>创建 {time(task.createdAt)}</span>
      {duration && <span className={`dsho-dur${live ? ' dsho-dur-live' : ''}`}>{duration}</span>}
    </div>
  </li>
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

  if (!sessionId) return <div className="dsho-board"><p className="dsho-empty dsho-error">无法确定主会话 ID。</p></div>
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
        || tasks.some(task => (ACTIVE_TASK_STATUSES as string[]).includes(task.status))
      const displayState = conv.state === 'idle' && latest?.status === 'blocked' ? 'blocked' : conv.state
      const collapsed = collapsedOverride[conv.id] ?? !active
      const rawHeadline = latest ? taskHeadline(latest) : ''
      const headline = rawHeadline.length > 80 ? `${rawHeadline.slice(0, 80)}…` : rawHeadline
      const toggle = (): void => setCollapsedOverride(prev => ({ ...prev, [conv.id]: !collapsed }))
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
          <span className={`dsho-badge dsho-badge-${displayState}`}>{convStateLabels[displayState] ?? displayState}</span>
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
        {collapsed && headline && <div className="dsho-strip" title={headline}>
          {latest && <span className={`dsho-badge dsho-badge-${latest.status}`}>{taskStatusLabels[latest.status] ?? latest.status}</span>}
          <span className="dsho-stripText">{headline}</span>
          <span className="dsho-stripTime">{time(latest?.updatedAt ?? conv.updatedAt)}</span>
        </div>}
        <div className="dsho-body"><div>
          {conv.workspaceName && <div className="dsho-meta">工作区：{conv.workspaceName}</div>}
          <ul className="dsho-tasks">
            {tasks.length === 0 && <li className="dsho-task"><p className="dsho-note">暂无任务</p></li>}
            {tasks.map(task => <TaskLine key={task.id} task={task} conv={conv} nowMs={nowMs} onOpenArtifact={openArtifact} />)}
          </ul>
        </div></div>
      </section>
    })}
  </div>
}
