import React, { useCallback, useEffect, useMemo, useState } from 'react'
import type { ProgressStep, Snapshot, TaskRecord } from '../types.ts'

interface BoardProps {
  sessionId?: string
  useTabInfo?: () => { tab: { navigation?: { params?: unknown } } }
  orchestrator: { snapshot(request: { parentSessionId: string }): Promise<{ ok: true; value: Snapshot } | { ok: false; error?: { message?: string } }> }
  remoteEvents: { $on(event: string, listener: () => void): () => void }
  uiWorkspace: any
}

function short(id: string): string {
  return id.length > 18 ? `${id.slice(0, 8)}…${id.slice(-6)}` : id
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
  queued: '排队中', running: '进行中', blocked: '待用户', completed: '已完成',
  failed: '失败', cancelled: '已取消', interrupted: '已中断',
}
const convStateLabels: Record<string, string> = {
  provisioning: '启动中', running: '进行中', idle: '空闲', blocked: '待用户', failed: '失败',
}

function TaskLine({ task }: { task: TaskRecord }): React.ReactElement {
  return <li className="dsho-task">
    <div className="dsho-taskHead">
      <span className={`dsho-badge dsho-badge-${task.status}`}>{taskStatusLabels[task.status] ?? task.status}</span>
      <span className="dsho-taskSubject" title={task.subject}>{task.subject}</span>
      <span className="dsho-mode">{task.responseMode}</span>
    </div>
    {task.acceptanceCriteria && <p className="dsho-subtle">验收：{task.acceptanceCriteria}</p>}
    <ProgressSteps steps={task.progressSteps ?? []} />
    {task.progressNote && <p className="dsho-note">{task.progressNote}</p>}
    {task.resultSummary && <p className="dsho-subtle">摘要：{task.resultSummary}</p>}
    {task.userAnswer && <p className="dsho-answer" title={task.userAnswer}>{task.userAnswer}</p>}
    {task.blockedQuestion && <p className="dsho-note">❓ 向用户提问：{task.blockedQuestion}</p>}
    {task.status === 'interrupted'
      ? <p className="dsho-subtle dsho-interrupted">已中断（改单中）：{task.cancelledReason}</p>
      : task.cancelledReason && <p className="dsho-subtle">已取消：{task.cancelledReason}</p>}
    {task.error && <p className="dsho-note dsho-error">{task.error}</p>}
    {task.delivery?.state === 'pending' && <p className="dsho-subtle">
      后台投递待重试 · 第 {task.delivery.attempts} 次{task.delivery.lastError ? ` · ${task.delivery.lastError}` : ''}
    </p>}
    {task.delivery?.state === 'delivered' && <p className="dsho-subtle">已投递回主会话 · {time(task.delivery.deliveredAt)}</p>}
    <div className="dsho-times">{short(task.id)} · 更新 {time(task.updatedAt)}</div>
  </li>
}

export function Board({ sessionId: propSessionId, useTabInfo, orchestrator, remoteEvents, uiWorkspace }: BoardProps): React.ReactElement {
  const tabSession = tabSessionId(useTabInfo)
  const sessionId = propSessionId ?? tabSession
  const [snapshot, setSnapshot] = useState<Snapshot | undefined>()
  const [error, setError] = useState<string>()

  const load = useCallback(async () => {
    if (!sessionId) return
    try {
      const result = await orchestrator.snapshot({ parentSessionId: sessionId })
      if (result.ok === true) setSnapshot(result.value)
      else setError(result.error?.message ?? '读取任务看板失败')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [orchestrator, sessionId])

  useEffect(() => {
    setSnapshot(undefined)
    setError(undefined)
    void load()
    const timer = setInterval(() => { void load() }, 5000)
    let disposeEvent: (() => void) | undefined
    try {
      disposeEvent = remoteEvents.$on('commands/change', () => { void load() })
    } catch {
      // 轮询仍是重连和事件不可用时的兜底。
    }
    return () => {
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
      <div className="dsho-empty">还没有子会话。向主控助理提出需要执行的任务后，这里会显示 Conversation 与 TaskRun。</div>
    </div>
  }

  return <div className="dsho-board">
    <h2 className="dsho-title">任务看板 · {snapshot.conversations.length} 个工作流</h2>
    {snapshot.conversations.map(conv => {
      const tasks = tasksByConversation.get(conv.id) ?? []
      return <section className="dsho-conv" key={conv.id}>
        <header className="dsho-convHead">
          <span className="dsho-convTitle" title={conv.title}>{conv.title}</span>
          <span className={`dsho-badge dsho-badge-${conv.state}`}>{convStateLabels[conv.state] ?? conv.state}</span>
          <button className="dsho-open" type="button" onClick={() => uiWorkspace.openSession({
            parentSessionId: sessionId,
            childSessionId: conv.childSessionId,
            mode: 'continuable',
          })}>打开子会话</button>
        </header>
        <div className="dsho-meta">
          <div>{short(conv.id)} · 更新 {time(conv.updatedAt)}</div>
          <div>标签：{conv.outline.tags.join(' / ') || '—'}</div>
          <div>实体：{conv.outline.entities.join(' / ') || '—'}</div>
          {conv.outline.summary && <div>摘要：{conv.outline.summary}</div>}
          {conv.outline.openQuestions.length > 0 && <div>未决：{conv.outline.openQuestions.join('；')}</div>}
        </div>
        <ul className="dsho-tasks">
          {tasks.length === 0 && <li className="dsho-task"><p className="dsho-note">暂无 TaskRun</p></li>}
          {tasks.map(task => <TaskLine key={task.id} task={task} />)}
        </ul>
      </section>
    })}
  </div>
}
