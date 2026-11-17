import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activeHomeDir, apply, closeAllDbs, getDb, setActiveHomeDir } from '@cmjt/dsh-personal-memory'
import { configureLeadMemory } from '../src/memory-policy.ts'
import { OrchestratorService } from '../src/service.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  vi.unstubAllGlobals()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  vi.unstubAllEnvs()
})

/** 使用上游原生路由和真实 SQLite；测试宿主只提供注册、配置与会话查询。 */
async function nativeMemory(projectDir?: string) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-memory-policy-'))
  vi.stubEnv('DSH_HOME', join(home, 'dsh'))
  vi.stubEnv('DSH_PERSONAL_MEMORY_HOME', home)
  vi.stubEnv('DSH_PERSONAL_MEMORY_LEGACY_HOME', join(home, 'legacy'))
  const previousHome = activeHomeDir()
  setActiveHomeDir(home)
  const routes = new Map<string, Handler>()
  const tools = new Map<string, any>()
  const hooks = new Map<string, (...args: any[]) => any>()
  const onDispose: Array<() => void> = []
  const server = createServer((req, res) => {
    const handler = routes.get(req.url!)
    if (handler) void handler(req, res)
    else { res.writeHead(404); res.end('{"ok":false,"error":"route not found"}') }
  })
  cleanups.push(async () => {
    for (const dispose of onDispose.reverse()) dispose()
    closeAllDbs()
    await new Promise<void>(resolve => server.close(() => resolve()))
    setActiveHomeDir(previousHome)
    await rm(home, { recursive: true, force: true })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const services = {
    webServer: { register: ({ path, handler }: { path: string; handler: Handler }) => {
      routes.set(path, handler)
      return () => { routes.delete(path) }
    } },
    systemPrompt: { context: () => () => {} },
    commands: { register: () => () => {} },
    sessionPersistence: { list: async () => [
      { id: 'lead', cwd: home }, { id: 'worker', cwd: home },
    ] },
  }
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn() },
    tools: { register: (tool: any) => { tools.set(tool.name, tool); return () => tools.delete(tool.name) }, restrict: () => () => {} },
    get: (name: keyof typeof services) => services[name],
    on: (name: string, handler: (...args: any[]) => any) => {
      if (name === 'dispose') onDispose.push(handler)
      hooks.set(name, handler)
      return () => {}
    },
    effect: (start: () => () => void) => start(),
    inject: (names: string[], callback: (ctx: unknown) => void) => {
      if (names.includes('settings')) callback({ settings: {
        installSection: (_owner: unknown, _ns: string, _schema: unknown, base: unknown, hooks: { setSource(get: () => unknown): void }) => hooks.setSource(() => base),
      } })
    },
  }
  await apply(ctx, {
    homeDir: home, ...projectDir ? { projectDir } : {},
    reflect: false, dream: { enabled: false }, semantic: { enabled: false },
  })
  expect(routes.has('/dsh-personal-memory/skip-dreams')).toBe(true)
  return { home, origin, db: getDb('', projectDir), tools, hooks }
}

describe('Lead 原生记忆只读策略', () => {
  it('原生工具保留 Lead 查询与自动注入，拒绝直接写入，Worker 仍可写', async () => {
    const { home, origin, tools, hooks } = await nativeMemory()
    await configureLeadMemory('lead', origin)
    const agent = (id: string) => ({ session: { id, header: { id, cwd: home }, events: [] } })
    const exec = (id: string) => ({ agent: agent(id), signal: AbortSignal.timeout(5000) })
    const entry = { content: '项目偏好使用紫色主题', project: '测试项目', keywords: ['主题', '紫色'], importance: 9 }
    await tools.get('memory_remember').execute(entry, exec('worker'))
    const messages = [{ role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: '紫色主题' }] }]
    const injected = await hooks.get('agent/pre-step')!({ agent: agent('lead'), messages, signal: AbortSignal.timeout(5000) }, async () => ({ kind: 'enter', messages }))
    expect(injected.messages.length).toBeGreaterThan(messages.length)
    const snapshots = injected.messages.filter((message: any) => message.source?.kind === 'plugin:dsh-personal-memory' && message.source.form === 'snapshot')
    expect(snapshots).toHaveLength(1)
    expect(JSON.stringify(snapshots)).toContain(entry.project)
    const search = await tools.get('memory_search').execute({ query: '紫色' }, exec('lead'))
    const serialized = JSON.stringify(search)
    expect(serialized).toContain('紫色')
    const id = search.hits[0].id
    expect(await tools.get('memory_read').execute({ id }, exec('lead'))).toMatchObject({ found: true, content: entry.content })
    await expect(tools.get('memory_remember').execute(entry, exec('lead'))).rejects.toThrow()

  })

  it.each([undefined, 'custom-memory'])('原生接口定位数据库（projectDir=%s），幂等禁写与禁整理且不影响 Worker', async (projectDir) => {
    const { home, origin, db } = await nativeMemory(projectDir)
    db.setMemoryScopeField('lead', 'inject', true)
    await configureLeadMemory('lead', origin)
    await configureLeadMemory('lead', origin)
    expect(db.getMemoryScope('lead')).toEqual({ inject: false, write: true, dream: true })
    expect(db.getMemoryScope('worker')).toEqual({ inject: false, write: false, dream: false })
    if (projectDir) expect(existsSync(join(home, '.dsh-personal-memory', 'memory.db'))).toBe(false)
  })

  it('未知会话返回原生错误，不假报配置成功', async () => {
    const { origin } = await nativeMemory()
    await expect(configureLeadMemory('unknown', origin)).rejects.toThrow('write 设置失败（HTTP 404）：unknown session')
  })

  it('HTTP 成功但插件拒绝操作时也报错', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: '拒绝操作' }))))
    await expect(configureLeadMemory('lead', 'http://localhost')).rejects.toThrow('拒绝操作')
  })

  it.each([404, 405])('插件路由未注册（HTTP %s 空响应）时按已禁用处理，不重试也不解析空 JSON', async (status) => {
    const fetch = vi.fn(async () => new Response(null, { status }))
    vi.stubGlobal('fetch', fetch)
    await expect(configureLeadMemory('lead', 'http://localhost')).resolves.toBe(false)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('插件存在但返回无效 JSON 时保留明确错误，不降级为未启用', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not-json')))
    await expect(configureLeadMemory('lead', 'http://localhost')).rejects.toThrow('返回了无效 JSON（HTTP 200）')
  })

  it('启动短暂失败后重试整组门控，不遗留部分策略', async () => {
    let calls = 0
    const fetch = vi.fn(async () => new Response(++calls === 2 ? '{"ok":false,"error":"not ready"}' : '{"ok":true}'))
    vi.stubGlobal('fetch', fetch)
    await configureLeadMemory('lead', 'http://localhost')
    expect(fetch).toHaveBeenCalledTimes(6)
  })

  it('新会话先落盘，再调用原生门控接口', async () => {
    const service = Object.create(OrchestratorService.prototype)
    const fetch = vi.fn(async () => new Response('{"ok":true}'))
    vi.stubGlobal('fetch', fetch)
    const agent = { session: { id: 'lead' }, ctx: { tools: { register: () => () => {}, restrict: () => () => {} }, systemPrompt: { context: () => () => {} }, on: () => () => {} } }
    const flush = vi.fn(async (session) => {
      expect(session).toBe(agent.session)
      expect(fetch).not.toHaveBeenCalled()
    })
    Object.assign(service, {
      installed: new Map(), resetInstalled: async () => {},
      leadTools: () => [],
      hostCtx: { sessions: { flush }, get: () => ({ getOrigin: () => 'http://localhost' }), logger: { warn: vi.fn() } },
    })
    await service.configureLead(agent)
    expect(flush).toHaveBeenCalledOnce()
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(service.hostCtx.logger.warn).not.toHaveBeenCalled()
  })

  it('门控持续失败时阻止推理，恢复后重新建立策略再放行', async () => {
    const service = Object.create(OrchestratorService.prototype)
    const fetch = vi.fn(async () => new Response('{"ok":false,"error":"not ready"}'))
    vi.stubGlobal('fetch', fetch)
    let beforeStream: (_options: unknown, next: () => AsyncGenerator<string>) => AsyncGenerator<string>
    const agent = { session: { id: 'lead' }, ctx: {
      tools: { register: () => () => {}, restrict: () => () => {} },
      systemPrompt: { context: () => () => {} },
      on: (_name: string, hook: typeof beforeStream) => { beforeStream = hook; return () => {} },
    } }
    Object.assign(service, {
      installed: new Map(), resetInstalled: async () => {},
      leadTools: () => [],
      hostCtx: { sessions: { flush: async () => {} }, get: () => ({ getOrigin: () => 'http://localhost' }), logger: { warn: vi.fn() } },
    })
    await service.configureLead(agent)
    const next = vi.fn(async function* () { yield 'ok' })
    await expect(beforeStream!({}, next).next()).rejects.toThrow('not ready')
    expect(next).not.toHaveBeenCalled()
    fetch.mockImplementation(async () => new Response('{"ok":true}'))
    expect(await beforeStream!({}, next).next()).toEqual({ value: 'ok', done: false })
    expect(next).toHaveBeenCalledOnce()
  })

  it('记忆插件已禁用时跳过门控、隐藏记忆提示并正常推理', async () => {
    const service = Object.create(OrchestratorService.prototype)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 405 })))
    let beforeStream: (_options: unknown, next: () => AsyncGenerator<string>) => AsyncGenerator<string>
    const sections = new Map<string, { text: () => string }>()
    const agent = { session: { id: 'lead' }, ctx: {
      tools: { register: () => () => {}, restrict: () => () => {} },
      systemPrompt: { context: (section: { name: string, text: () => string }) => {
        sections.set(section.name, section)
        return () => {}
      } },
      on: (_name: string, hook: typeof beforeStream) => { beforeStream = hook; return () => {} },
    } }
    Object.assign(service, {
      installed: new Map(), resetInstalled: async () => {},
      leadTools: () => [],
      hostCtx: { sessions: { flush: async () => {} }, get: () => ({ getOrigin: () => 'http://localhost' }), logger: { warn: vi.fn() } },
    })
    await service.configureLead(agent)
    expect(sections.has('orchestrator:memory')).toBe(false)
    const next = vi.fn(async function* () { yield 'ok' })
    expect(await beforeStream!({}, next).next()).toEqual({ value: 'ok', done: false })
    expect(next).toHaveBeenCalledOnce()
    expect(service.hostCtx.logger.warn).not.toHaveBeenCalled()
  })
})
