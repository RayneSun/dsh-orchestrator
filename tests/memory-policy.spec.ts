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
    systemPrompt: { section: () => () => {} },
    commands: { register: () => () => {} },
    sessionPersistence: { list: async () => [
      { id: 'lead', cwd: home }, { id: 'worker', cwd: home },
    ] },
  }
  const ctx = {
    logger: { info: vi.fn(), warn: vi.fn() },
    tools: { register: () => () => {} },
    get: (name: keyof typeof services) => services[name],
    on: (name: string, handler: () => void) => {
      if (name === 'dispose') onDispose.push(handler)
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
  return { home, origin, db: getDb('', projectDir) }
}

describe('Lead 原生记忆只读策略', () => {
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
    const agent = { session: { id: 'lead' }, ctx: { systemPrompt: { section: () => () => {} }, on: () => () => {} } }
    const flush = vi.fn(async (session) => {
      expect(session).toBe(agent.session)
      expect(fetch).not.toHaveBeenCalled()
    })
    Object.assign(service, {
      installed: new Map(), resetInstalled: async () => {},
      applyLeadToolDenylist: () => {}, registerGenuiCardSkill: () => {}, leadTools: () => [],
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
      systemPrompt: { section: () => () => {} },
      on: (_name: string, hook: typeof beforeStream) => { beforeStream = hook; return () => {} },
    } }
    Object.assign(service, {
      installed: new Map(), resetInstalled: async () => {},
      applyLeadToolDenylist: () => {}, registerGenuiCardSkill: () => {}, leadTools: () => [],
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
})
