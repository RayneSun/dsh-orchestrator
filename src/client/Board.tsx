import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import type { AnswerQuestionsRequest, OrchestratorClient, SnapshotRequest } from '../remote.ts'
import { ScheduleList } from './schedule-list.tsx'
import { AskCard } from './question-card.tsx'
import { TaskBox, TagChip, ModelCredit, taskStatusLabels, shortTime, durationText } from './task-box.tsx'
import { SchedulePane } from './schedule-pane.tsx'
import { sortSchedules } from './schedule-ordering.ts'
import { activeTaskStatuses } from '../types.ts'
import { BOARD_REVEAL_EVENT } from './task-attention.ts'

import type { ConversationRecord, ScheduleSnapshot, Snapshot, TaskSnapshot } from '../types.ts'

interface BoardProps {
  sessionId?: string
  useTabInfo?: () => { tab: { navigation?: { params?: unknown } } }
  orchestrator: Omit<OrchestratorClient, 'snapshot'> & {
    snapshot(request: SnapshotRequest): Promise<{ ok: true; value: Snapshot } | { ok: false; error?: { message?: string } }>
  }
  remoteEvents: {
    $on(event: string, listener: () => void): () => void
    session?: {
      openWorkspacePath?(request: { path: string; action?: 'reveal' }): Promise<{ ok: boolean; error?: { message?: string } }>
    }
  }
  uiWorkspace: any
}

function tabSessionId(useTabInfo?: BoardProps['useTabInfo']): string | undefined {
  try {
    const params = useTabInfo?.().tab.navigation?.params as { sessionId?: string } | undefined
    return typeof params?.sessionId === 'string' ? params.sessionId : undefined
  } catch {
    return undefined
  }
}

const convStateLabels: Record<string, string> = {
  provisioning: '启动中', running: '进行中', idle: '空闲', input_required: '待你操作', failed: '失败',
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
  // 看板/日程双页签：切回看板即清除未读提醒点（lastSeen 记录最近查看时间）。
  const [tab, setTab] = useState<'board' | 'sched'>('board')
  const lastSeenAt = useRef(Date.now())

  useEffect(() => {
    const reveal = (event: Event) => {
      if ((event as CustomEvent<string>).detail === sessionId) setTab('board')
    }
    window.addEventListener(BOARD_REVEAL_EVENT, reveal)
    return () => window.removeEventListener(BOARD_REVEAL_EVENT, reveal)
  }, [sessionId])

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
    const map = new Map<string, TaskSnapshot[]>()
    for (const task of snapshot?.tasks ?? []) {
      map.set(task.conversationId, [...(map.get(task.conversationId) ?? []), task])
    }
    return map
  }, [snapshot])

  const schedulesByConversation = useMemo(() => {
    const map = new Map<string, ScheduleSnapshot[]>()
    for (const schedule of snapshot?.schedules ?? []) {
      map.set(schedule.conversationId, [...(map.get(schedule.conversationId) ?? []), schedule])
    }
    // 由近及远：会话内日程按 startAt 升序，无时间沉底
    for (const [key, list] of map) map.set(key, sortSchedules(list))
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

  // 用户画勾/取消日程：走 RPC 持久化后立刻刷新看板（用户/Worker 双向同步同一张表）。
  const toggleSchedule = useCallback(async (schedule: ScheduleSnapshot) => {
    try {
      await orchestrator.setScheduleStatus({ scheduleId: schedule.id, status: schedule.status === 'done' ? 'pending' : 'done' })
      void load(++requestSeq.current)
    } catch (err) {
      showToast(`更新日程失败：${err instanceof Error ? err.message : String(err)}`)
    }
  }, [orchestrator, load, showToast])

  // 问题卡作答：走 answerTaskQuestions RPC，Host 恢复任务并返回同轮等待的答案。
  const submitAnswers = useCallback(async (conv: ConversationRecord, taskId: string, answers: AnswerQuestionsRequest['answers']) => {
    const result = await orchestrator.answerTaskQuestions({ childSessionId: conv.childSessionId, taskId, answers })
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

  // 未读提醒点：停留在日程页时，若有任务晚于最近一次看板查看时间更新则亮起（颜色跟最新任务状态）。
  const latestTask = [...snapshot.tasks].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
  const hasUnseen = tab === 'sched' && Boolean(latestTask && Date.parse(latestTask.updatedAt) > lastSeenAt.current)
  const notifKind = latestTask?.status === 'failed' ? 'failed' : latestTask?.status === 'input_required' ? 'input_required' : 'running'
  const switchTab = (next: 'board' | 'sched'): void => {
    setTab(next)
    if (next === 'board') lastSeenAt.current = Date.now()
  }

  return <div className="dsho-board">
    <h2 className="dsho-title">任务看板 · {snapshot.conversations.length} 个子会话</h2>
    <div className="dsho-tabs" role="tablist">
      <button type="button" role="tab" aria-selected={tab === 'board'} className={`dsho-tab${tab === 'board' ? ' on' : ''}`} onClick={() => switchTab('board')}>
        {hasUnseen && <span className={`dsho-notif dsho-notif-${notifKind}`} />}
        会话
      </button>
      <button type="button" role="tab" aria-selected={tab === 'sched'} className={`dsho-tab${tab === 'sched' ? ' on' : ''}`} onClick={() => switchTab('sched')}>日程</button>
    </div>
    {toast && <div className="dsho-toast" role="status">{toast}</div>}
    {tab === 'sched' && <SchedulePane
      schedules={snapshot.schedules}
      onToggle={toggleSchedule}
      onOpenAttachment={(schedule, path) => {
        const conv = snapshot.conversations.find(item => item.id === schedule.conversationId)
        if (conv) void openArtifact(conv, path)
        else showToast('找不到来源子会话，无法打开附件')
      }}
      showToast={showToast}
    />}
    {tab === 'board' && snapshot.conversations.map(conv => {
      const tasks = tasksByConversation.get(conv.id) ?? []
      const latest = tasks[tasks.length - 1]
      const silentConv = isSilentConversation(conv.id)
      const active = conv.state === 'running' || conv.state === 'provisioning' || conv.state === 'input_required'
        || tasks.some(task => (activeTaskStatuses as readonly string[]).includes(task.status))
      // 会话头徽标跟随最新一轮任务；无任务时回退会话状态。
      const headState = latest ? latest.status : conv.state
      const collapsed = collapsedOverride[conv.id] ?? !active
      const toggle = (): void => setCollapsedOverride(prev => ({ ...prev, [conv.id]: !collapsed }))
      const awaitingInput = tasks.find(task => task.status === 'input_required' && (task.questions?.length ?? 0) > 0)
      const convSchedules = schedulesByConversation.get(conv.id) ?? []
      return <section
        className={`dsho-conv${active ? ' dsho-conv-active' : ''}${collapsed ? ' dsho-conv-collapsed' : ''}${awaitingInput ? ' dsho-conv-attention' : ''}`}
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
        {awaitingInput && <AskCard task={awaitingInput} onSubmit={answers => submitAnswers(conv, awaitingInput.id, answers)} />}
        {convSchedules.length > 0 && <ScheduleList schedules={convSchedules} onToggle={toggleSchedule} showToast={showToast} onOpenAttachment={(_schedule, path) => void openArtifact(conv, path)} />}
        {collapsed && latest && <div className="dsho-collapsedTime">
          <span>最新任务 · 创建 {shortTime(latest.createdAt)}{(() => { const d = durationText(latest, nowMs); return d ? ` · ${d}` : '' })()}</span>
          <ModelCredit task={latest} />
        </div>}
        <div className="dsho-body"><div>
          <div className="dsho-bodyInner">
            {conv.workspaceName && <div className="dsho-meta">工作区：{conv.workspaceName}</div>}
            <TaskBox conv={conv} tasks={tasks} nowMs={nowMs} onOpenArtifact={openArtifact} attentionTaskId={awaitingInput?.id} />
          </div>
        </div></div>
      </section>
    })}
  </div>
}
