import { describe, expect, it, vi } from 'vitest'
import { BOARD_KIND, watchInputRequired } from '../src/client/task-attention.ts'
import type { TaskSnapshot, TaskStatus } from '../src/types.ts'

function task(status: TaskStatus, id = 'task-1'): TaskSnapshot {
  return { id, status } as TaskSnapshot
}

function ok(tasks: TaskSnapshot[]) {
  return { ok: true as const, value: { tasks } }
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

function createHarness(options?: { expanded?: boolean, activeKind?: string, initial: TaskSnapshot[] }) {
  const snapshot = vi.fn().mockResolvedValueOnce(ok(options?.initial ?? []))
  let listener: (() => void) | undefined
  const disposeEvent = vi.fn()
  const sidebarRight = {
    active: vi.fn(() => ({ kind: options?.activeKind ?? BOARD_KIND })),
    isExpanded: vi.fn(() => options?.expanded ?? false),
    openTab: vi.fn(),
  }
  const stop = watchInputRequired({
    sessionId: 'session-lead',
    orchestrator: { snapshot },
    remoteEvents: {
      $on: vi.fn((_event, next) => {
        listener = next
        return disposeEvent
      }),
    },
    sidebarRight,
  })
  return {
    snapshot,
    sidebarRight,
    disposeEvent,
    stop,
    async emit() {
      listener?.()
      await flush()
    },
  }
}

describe('待操作看板提醒', () => {
  it('任务新进入待操作时自动展开，重复快照不重复打开', async () => {
    const harness = createHarness({ initial: [task('running')] })
    harness.snapshot
      .mockResolvedValueOnce(ok([task('input_required')]))
      .mockResolvedValueOnce(ok([task('input_required')]))
    await flush()
    expect(harness.sidebarRight.openTab).not.toHaveBeenCalled()

    await harness.emit()
    expect(harness.sidebarRight.openTab).toHaveBeenCalledOnce()
    expect(harness.sidebarRight.openTab).toHaveBeenCalledWith(BOARD_KIND, {
      params: { sessionId: 'session-lead' },
    })

    await harness.emit()
    expect(harness.sidebarRight.openTab).toHaveBeenCalledOnce()
    harness.stop()
    expect(harness.disposeEvent).toHaveBeenCalledOnce()
  })

  it('看板已经展开且位于当前页时只保留高亮，不重新聚焦', async () => {
    const harness = createHarness({ expanded: true, initial: [task('running')] })
    harness.snapshot
      .mockResolvedValueOnce(ok([task('input_required')]))
    await flush()
    await harness.emit()

    expect(harness.sidebarRight.openTab).not.toHaveBeenCalled()
    harness.stop()
  })

  it('首次加载已有待操作不弹出，离开后再进入可再次提醒', async () => {
    const harness = createHarness({ expanded: true, activeKind: 'files', initial: [task('input_required')] })
    harness.snapshot
      .mockResolvedValueOnce(ok([task('running')]))
      .mockResolvedValueOnce(ok([task('input_required')]))
    await flush()
    expect(harness.sidebarRight.openTab).not.toHaveBeenCalled()

    await harness.emit()
    expect(harness.sidebarRight.openTab).not.toHaveBeenCalled()
    await harness.emit()
    expect(harness.sidebarRight.openTab).toHaveBeenCalledOnce()
    harness.stop()
  })
})
