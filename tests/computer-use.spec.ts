import { describe, expect, it, vi } from 'vitest'
import { createComputerSessionScope } from '../vendor/dsh-computer-use-darwin/lib/sessions.js'
import { getSnapshot, setSnapshot } from '../vendor/dsh-computer-use-darwin/lib/snapshot.js'
import { resolveClickTarget } from '../vendor/dsh-computer-use-darwin/lib/human.js'
import { cuaCall, withSession } from '../vendor/dsh-computer-use-darwin/lib/cua.js'
import { apply } from '../vendor/dsh-computer-use-darwin/index.js'

vi.mock('../vendor/dsh-computer-use-darwin/lib/cua.js', async (original) => ({
  ...await original<object>(),
  cuaCall: vi.fn(async (tool: string, args: Record<string, unknown>) => {
    if (tool === 'list_windows') return { windows: [
      { pid: 1, window_id: 11, app_name: 'A', title: 'A' },
      { pid: 2, window_id: 22, app_name: 'B', title: 'B' },
    ] }
    if (tool === 'get_window_state') return {
      snapshot_id: `snapshot-${args.pid}`, element_count: 1, total_element_count: 1,
      elements: [{ element_index: 1, element_token: `token-${args.pid}`, role: 'AXButton', label: '继续' }],
    }
    return { ok: true }
  }),
}))

function execution(id: string) {
  return { agent: { session: { id } }, signal: new AbortController().signal }
}

describe('桌面会话隔离与快照时效', () => {
  it('不同 Worker 的异步调用各自保留快照和驱动会话', async () => {
    const run = createComputerSessionScope('test')
    const first = execution('first')
    const second = execution('second')
    await Promise.all([first, second].map(exec => run(exec, async () => {
      setSnapshot({ pid: exec.agent.session.id })
      await Promise.resolve()
      expect(getSnapshot().pid).toBe(exec.agent.session.id)
      expect(withSession().session).toBe(`test-${exec.agent.session.id}`)
    })))
    await run(first, () => expect(getSnapshot().pid).toBe('first'))
  })

  it('同一 Worker 串行执行，失败不会阻断后续调用', async () => {
    const run = createComputerSessionScope('test')
    const exec = execution('worker')
    let release: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const order: string[] = []
    const first = run(exec, async () => { order.push('first'); await gate; throw new Error('failed') })
    const rejected = expect(first).rejects.toThrow('failed')
    const second = run(exec, () => order.push('second'))
    await Promise.resolve()
    expect(order).toEqual(['first'])
    release()
    await rejected
    await second
    expect(order).toEqual(['first', 'second'])
  })

  it('编号点击拒绝过期快照并仅清除当前 Worker 快照', async () => {
    const run = createComputerSessionScope('test')
    const first = execution('first')
    const second = execution('second')
    await run(second, () => setSnapshot({ pid: 2, at: Date.now() }))
    await run(first, () => {
      setSnapshot({ pid: 1, windowId: 11, at: Date.now() - 60_000, entries: new Map([[1, { token: 'old', x: 10, y: 20 }]]) })
      expect(() => resolveClickTarget(1, 30_000)).toThrow('快照已过期')
      expect(getSnapshot()).toBeNull()
    })
    await run(second, () => expect(getSnapshot().pid).toBe(2))
  })

  it('缺少当前会话时拒绝读取其他 Worker 的快照', () => {
    expect(() => getSnapshot()).toThrow('缺少会话上下文')
  })

  it('实际注册工具在两个 Worker 交替观察后使用各自编号与引擎会话', async () => {
    const tools = new Map<string, { execute(args: unknown, exec: unknown): Promise<unknown> }>()
    apply({ tools: { register: (tool: any) => tools.set(tool.name, tool) }, logger: { info() {} } }, { ttlMs: 30_000 })
    const first = execution('first')
    const second = execution('second')
    await tools.get('screen_observe')!.execute({ window: '1' }, first)
    await tools.get('screen_observe')!.execute({ window: '2' }, second)
    await tools.get('computer_type')!.execute({ element: 1, text: 'A' }, first)
    await tools.get('computer_type')!.execute({ element: 1, text: 'B' }, second)
    const payloads = vi.mocked(cuaCall).mock.calls.filter(([tool]) => tool === 'type_text').map(([, args]) => args)
    expect(payloads).toEqual([
      expect.objectContaining({ pid: 1, element_token: 'token-1', text: 'A', session: expect.stringContaining('-first') }),
      expect.objectContaining({ pid: 2, element_token: 'token-2', text: 'B', session: expect.stringContaining('-second') }),
    ])
  })
})
