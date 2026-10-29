import { describe, expect, it, vi } from 'vitest'
import { apply } from '../src/client/index.tsx'

function createHarness() {
  const snapshot = vi.fn(async () => ({ ok: true as const, value: { conversations: [], tasks: [] } }))
  const rootRemote = {
    $mount: vi.fn(async () => vi.fn(async () => undefined)),
    $on: vi.fn(() => vi.fn()),
  }
  Object.defineProperty(rootRemote, 'orchestrator', {
    get() { throw new Error('cannot get property "orchestrator" without inject') },
  })

  const entries: Array<{ name: string; options: any; component: unknown }> = []
  const tabDispose = vi.fn()
  const slotDisposes = [vi.fn(), vi.fn(), vi.fn()]
  const scopedRemote = { ...rootRemote, orchestrator: { snapshot } }
  const uiWorkspace = { openSession: vi.fn() }
  const sidebarRight = { openTab: vi.fn() }

  const scoped: any = {
    remote: scopedRemote,
    uiWorkspace,
    sidebarRight,
    sidebarRightTabs: { register: vi.fn(() => tabDispose) },
    effect: vi.fn((dispose: () => unknown) => { void dispose() }),
    slots: {
      inject: vi.fn((name: string, factory: () => unknown) => {
        factory()
        const index = entries.findIndex(entry => entry.name === name)
        return slotDisposes[index]
      }),
      register: vi.fn((options: any, component: unknown) => {
        entries.push({ name: options.name, options, component })
        return slotDisposes[entries.length - 1]
      }),
    },
  }

  const root: any = {
    remote: rootRemote,
    inject: vi.fn((_deps: string[], callback: (ctx: any) => void) => {
      callback(scoped)
      return Object.assign(Promise.resolve(), { dispose: vi.fn(async () => undefined) })
    }),
  }
  return { root, entries, snapshot, sidebarRight, scoped }
}

describe('client orchestrator mount', () => {
  it('在 remote.orchestrator inject 子作用域注册看板，并把命名空间显式传入组件', async () => {
    const harness = createHarness()
    await apply(harness.root as any)

    expect(harness.root.remote.$mount).toHaveBeenCalledOnce()
    expect(harness.root.inject).toHaveBeenCalledOnce()
    expect(harness.root.inject.mock.calls[0]![0]).toContain('remote.orchestrator')
    expect(() => harness.root.remote.orchestrator).toThrow('without inject')

    const body = harness.entries.find(
      entry => entry.name === 'sidebar.right.pane.tab' && entry.options.key === '@may/dsh-orchestrator/board',
    )
    expect(body).toBeDefined()
    const props = body!.options.inject('parent-session')
    expect(props.orchestrator.snapshot).toBe(harness.snapshot)
    expect(await props.orchestrator.snapshot({ parentSessionId: 'parent-session' })).toMatchObject({ ok: true })
    expect(props.remoteEvents.$on).toBe(harness.scoped.remote.$on)
    expect(props.uiWorkspace.openSession).toBe(harness.scoped.uiWorkspace.openSession)

    const header = harness.entries.find(entry => entry.options.id === '@may/dsh-orchestrator/header')
    header!.options.inject('parent-session').sidebarRight.openTab('orchestratorBoard', {
      params: { sessionId: 'parent-session' },
    })
    expect(harness.sidebarRight.openTab).toHaveBeenCalledWith('orchestratorBoard', {
      params: { sessionId: 'parent-session' },
    })
  })
})
