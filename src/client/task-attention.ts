import type { Snapshot, TaskSnapshot } from '../types.ts'

export const BOARD_KIND = 'orchestratorBoard'
export const BOARD_REVEAL_EVENT = 'orchestrator:board-reveal'

interface AttentionSnapshotClient {
  snapshot(request: { parentSessionId: string }): Promise<
    { ok: true; value: Pick<Snapshot, 'tasks'> } | { ok: false; error?: { message?: string } }
  >
}

interface AttentionSidebar {
  active(): { kind?: string } | undefined
  isExpanded(): boolean
  openTab(kind: string, options: { params: { sessionId: string } }): void
}

/** 只在任务新进入待操作时唤醒看板；已经看着看板时不重复聚焦或改变布局。 */
export function watchInputRequired(options: {
  sessionId: string
  orchestrator: AttentionSnapshotClient
  remoteEvents: { $on(event: string, listener: () => void): () => void }
  sidebarRight: AttentionSidebar
}): () => void {
  const { sessionId, orchestrator, remoteEvents, sidebarRight } = options
  let previous: Map<string, TaskSnapshot['status']> | undefined
  let requestSeq = 0
  let disposed = false

  const load = async (): Promise<void> => {
    const seq = ++requestSeq
    try {
      const result = await orchestrator.snapshot({ parentSessionId: sessionId })
      if (disposed || seq !== requestSeq || result.ok !== true) return
      const next = new Map(result.value.tasks.map(task => [task.id, task.status]))
      const hasNewInput = previous !== undefined && result.value.tasks.some(task =>
        task.status === 'input_required' && previous?.get(task.id) !== 'input_required'
      )
      previous = next
      if (!hasNewInput) return

      let boardVisible = false
      try {
        boardVisible = sidebarRight.isExpanded() && sidebarRight.active()?.kind === BOARD_KIND
      } catch {
        // 状态不可读时仍尝试打开，打开失败由下面的边界兜底。
      }
      if (!boardVisible) sidebarRight.openTab(BOARD_KIND, { params: { sessionId } })
    } catch {
      // 看板正文负责展示读取错误；后台监听不重复弹错。
    }
  }

  void load()
  const timer = setInterval(() => { void load() }, 5000)
  let disposeEvent: (() => void) | undefined
  try {
    disposeEvent = remoteEvents.$on('commands/change', () => { void load() })
  } catch {
    // 轮询作为事件不可用时的兜底。
  }
  return () => {
    disposed = true
    requestSeq += 1
    clearInterval(timer)
    disposeEvent?.()
  }
}
