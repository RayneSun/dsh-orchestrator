import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ProgressStep, Snapshot, TaskRecord } from '../types.ts'

interface BoardProps {
  sessionId?: string
  useTabInfo?: () => { tab: { navigation?: { params?: unknown } } }
  orchestrator: { snapshot(request: { parentSessionId: string }): Promise<{ ok: true; value: Snapshot } | { ok: false; error?: { message?: string } }> }
  remoteEvents: { $on(event: string, listener: () => void): () => void }
  uiWorkspace: any
}

function time(value?: string): string {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

function tabSessionId(useTabInfo?: BoardProps['useTabInfo']): string | undefined {
  try {
    const params = useTabInfo?.().tab.navigation?.params as { sessionId?: string } | undefined
    return typeof params?.sessionId === 'string' ? params.sessionId : undefined
  } catch {
    return undefined
  }
}


function ProgressSteps({ steps }: { steps: ProgressStep[] }): React.ReactElement | null {
  if (steps.length === 0) return null
  const completed = steps.filter(step => step.status === 'completed').length
  const active = steps.some(step => step.status === 'in_progress')
  return <div className="dsho-steps">
    <div className="dsho-stepsHead">
      <span>执行步骤</span>
      <span className={active ? 'dsho-stepsActive' : ''}>{completed}/{steps.length}</span>
    </div>
    <ul>
      {steps.map((step, index) => <li key={`${index}-${step.content}`} className={`dsho-step dsho-step-${step.status}`}>
        <span className="dsho-stepIcon">
          {step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '▶' : '○'}
        </span>
        <span>{step.content}</span>
      </li>)}
    </ul>
  </div>
}

const taskStatusLabels: Record<string, string> = {
  queued: '排队中', running: '进行中', input_required: '待补充', completed: '已完成',
  failed: '失败', cancelled: '已取消', interrupted: '已中断',
}
const modeLabels: Record<string, string> = { background: '后台', wait: '等待' }
const convStateLabels: Record<string, string> = {
  provisioning: '启动中', running: '进行中', idle: '空闲', input_required: '待补充', failed: '失败',
}


const ACTIVE_TASK_STATUSES = ['queued', 'running']

function stepProgress(steps: ProgressStep[] | undefined): string {
  if (!steps || steps.length === 0) return ''
  const done = steps.filter(step => step.status === 'completed').length
  return `步骤 ${done}/${steps.length}`
}

/** 折叠态展示的一行最新状态摘要。 */
function taskHeadline(task: TaskRecord): string {
  switch (task.status) {
    case 'running':
      return task.progressNote || stepProgress(task.progressSteps)
    case 'input_required':
      return task.question || task.progressNote || '等待用户补充信息'
    case 'completed':
      return task.userAnswer || task.resultSummary || '已完成'
    case 'failed':
      return task.error || '执行失败'
    case 'interrupted':
      return task.cancelledReason || '已中断'
    case 'cancelled':
      return task.cancelledReason || '已取消'
    case 'queued':
      return '排队等待执行'
    default:
      return ''
  }
}

function TaskLine({ task }: { task: TaskRecord }): React.ReactElement {
  // 被改单/手动停止的任务只保留一行历史，不展示旧的步骤清单和过程信息，避免看板杂乱。
  if (task.status === 'interrupted') {
    return <li className="dsho-task dsho-taskMuted">
      <div className="dsho-taskHead">
        <span className="dsho-badge dsho-badge-interrupted">已中断</span>
        <span className="dsho-taskSubject" title={task.subject}>{task.subject}</span>
      </div>
      {task.cancelledReason && <p className="dsho-subtle">{task.cancelledReason}</p>}
      {task.delivery?.state === 'pending' && <p className="dsho-subtle">
        {task.delivery.attempts === 0
          ? '正在把中断消息同步回主会话…'
          : <>同步未成功（已重试 {task.delivery.attempts} 次，将自动继续）{task.delivery.lastError ? ` · ${task.delivery.lastError}` : ''}</>}
      </p>}
      {task.delivery?.state === 'delivered' && <p className="dsho-subtle">已同步回主会话 · {time(task.delivery.deliveredAt)}</p>}
      <div className="dsho-times">更新 {time(task.updatedAt)}</div>
    </li>
  }
  return <li className="dsho-task">
    <div className="dsho-taskHead">
      <span className={`dsho-badge dsho-badge-${task.status}`}>{taskStatusLabels[task.status] ?? task.status}</span>
      <span className="dsho-taskSubject" title={task.subject}>{task.subject}</span>
      <span className="dsho-mode">{modeLabels[task.responseMode] ?? task.responseMode}</span>
    </div>
    {task.acceptanceCriteria && <p className="dsho-subtle">验收：{task.acceptanceCriteria}</p>}
    <ProgressSteps steps={task.progressSteps ?? []} />
    {task.progressNote && <p className="dsho-note">{task.progressNote}</p>}
    {task.resultSummary && <p className="dsho-subtle">摘要：{task.resultSummary}</p>}
    {task.userAnswer && <p className="dsho-answer" title={task.userAnswer}>{task.userAnswer}</p>}
    {task.question && <p className="dsho-note">❓ 待用户回复：{task.question}</p>}
    {task.status === 'cancelled' && task.cancelledReason && <p className="dsho-subtle">已取消：{task.cancelledReason}</p>}
    {task.error && <p className="dsho-note dsho-error">{task.error}</p>}
    {task.delivery?.state === 'pending' && <p className="dsho-subtle">
      {task.delivery.attempts === 0
        ? '正在把结果同步回主会话…'
        : <>同步回主会话未成功（已重试 {task.delivery.attempts} 次，将自动继续）{task.delivery.lastError ? ` · ${task.delivery.lastError}` : ''}</>}
    </p>}
    {task.delivery?.state === 'delivered' && <p className="dsho-subtle">已同步回主会话 · {time(task.delivery.deliveredAt)}</p>}
    <div className="dsho-times">更新 {time(task.updatedAt)}</div>
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
    let disposeEvent: (() => void) | undefined
    try {
      disposeEvent = remoteEvents.$on('commands/change', () => { void load(++requestSeq.current) })
    } catch {
      // 轮询仍是重连和事件不可用时的兜底。
    }
    return () => {
      requestSeq.current += 1
      clearInterval(timer)
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

  if (!sessionId) return <div className="dsho-board"><p className="dsho-empty dsho-error">无法确定主会话 ID。</p></div>
  if (error) return <div className="dsho-board"><h2 className="dsho-title">任务看板</h2><p className="dsho-empty dsho-error" role="alert">{error}</p></div>
  if (!snapshot) return <div className="dsho-board"><h2 className="dsho-title">任务看板</h2><p className="dsho-empty">正在加载任务看板…</p></div>

  if (snapshot.conversations.length === 0) {
    return <div className="dsho-board">
      <h2 className="dsho-title">任务看板</h2>
      <div className="dsho-empty">还没有子会话。向主控助理提出需要执行的任务后，这里会显示每个子会话的状态和任务进度。</div>
    </div>
  }

  return <div className="dsho-board">
    <h2 className="dsho-title">任务看板 · {snapshot.conversations.length} 个子会话</h2>
    {snapshot.conversations.map(conv => {
      const tasks = tasksByConversation.get(conv.id) ?? []
      const latest = tasks[tasks.length - 1]
      const active = conv.state === 'running' || conv.state === 'provisioning'
        || tasks.some(task => (ACTIVE_TASK_STATUSES as string[]).includes(task.status))
      const collapsed = collapsedOverride[conv.id] ?? !active
      const headline = latest ? taskHeadline(latest) : ''
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
          <span className="dsho-convTitle" title={conv.title}>{conv.title}</span>
          <span className={`dsho-badge dsho-badge-${conv.state}`}>{convStateLabels[conv.state] ?? conv.state}</span>
          <button className="dsho-open" type="button" onClick={event => {
            event.stopPropagation()
            try {
              const opened = uiWorkspace.openSession({
                parentSessionId: sessionId,
                childSessionId: conv.childSessionId,
                mode: 'continuable',
              })
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
          <div className="dsho-meta">
            <div>更新 {time(conv.updatedAt)}</div>
            {conv.outline.summary && <div>摘要：{conv.outline.summary}</div>}
            {conv.outline.openQuestions.length > 0 && <div>未决：{conv.outline.openQuestions.join('；')}</div>}
          </div>
          <ul className="dsho-tasks">
            {tasks.length === 0 && <li className="dsho-task"><p className="dsho-note">暂无任务</p></li>}
            {tasks.map(task => <TaskLine key={task.id} task={task} />)}
          </ul>
        </div></div>
      </section>
    })}
  </div>
}
