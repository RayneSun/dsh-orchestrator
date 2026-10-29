import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => {
  const scopeCalls: Array<{ sessionId: string; field: string; value: boolean }> = []
  const searched: string[][] = []
  const accessed: string[][] = []
  const db = {
    list: (level: string) => level === 'fact' ? [
      { id: 'f1', level, title: '喜欢 vue', content: '用户喜欢 vue 页面', keywords: ['vue'], project: 'prefs', status: 'active', importance: 3, created_at: 1, updated_at: 2 },
      { id: 'f2', level, title: '旧事实', content: '已经过期的内容', keywords: [], project: '', status: 'archived', importance: 1, created_at: 1, updated_at: 3 },
    ] : [],
    listSearchable: (level: string) => db.list(level).filter(r => r.status === 'active'),
    findById: (id: string) => (id === 'f1' ? { row: db.list('fact')[0]! } : undefined),
    bumpHit: () => {},
    setMemoryScopeField: (sessionId: string, field: string, value: boolean) => scopeCalls.push({ sessionId, field, value }),
  }
  return {
    scopeCalls, searched, accessed,
    meow: {
      getDb: () => db,
      search: (query: string, docs: Array<{ id: string; content: string }>) =>
        docs.filter(d => d.content.includes(query)).map((d, i) => ({ id: d.id, level: 'fact', score: 1 - i * 0.1, content: d.content, updated_at: 2 })),
      readSeen: () => new Set<string>(),
      markSearched: (_ws: string, _sid: string, ids: string[]) => { searched.push(ids) },
      markAccessed: (_ws: string, _sid: string, ids: string[]) => { accessed.push(ids) },
      LEVELS: ['project', 'topic', 'fact', 'lesson', 'rules', 'soul', 'user'],
      projectCovers: (rowProject: unknown, project: string) => rowProject === project,
      isGlobalProject: () => false,
      setCurrentProject: () => {},
    },
  }
})

vi.mock('meow-memory', () => state.meow)

async function freshModule() {
  vi.resetModules()
  return await import('../src/lead-memory.ts')
}

describe('Lead 记忆只读层', () => {
  const target = { workspace: '/ws', sessionId: 'session-lead' }
  const logger = { info: () => {}, warn: (m: string) => { throw new Error(m) } }

  beforeEach(() => {
    state.scopeCalls.length = 0
    state.searched.length = 0
    state.accessed.length = 0
  })

  it('关闭 inject/write/dream 三个 per-session 开关', async () => {
    const mod = await freshModule()
    await mod.disableLeadMemoryInjection(target, logger)
    expect(state.scopeCalls.map(c => c.field).sort()).toEqual(['dream', 'inject', 'write'])
    expect(state.scopeCalls.every(c => c.value && c.sessionId === 'session-lead')).toBe(true)
  })

  it('影子工具恰好是 search/read，search 走库内检索并记录', async () => {
    const mod = await freshModule()
    const tools = await mod.buildLeadMemoryTools(target, logger)
    expect(tools.map(t => t.name)).toEqual(['memory_search', 'memory_read'])
    const search = tools[0]! as unknown as { execute(args: unknown): Promise<{ hits: Array<{ id: string }> }> }
    const result = await search.execute({ query: 'vue' })
    expect(result.hits.map(h => h.id)).toEqual(['f1'])
    expect(state.searched).toEqual([['f1']])
  })

  it('read 按 id 返回完整条目并记录 accessed', async () => {
    const mod = await freshModule()
    const tools = await mod.buildLeadMemoryTools(target, logger)
    const read = tools[1]! as unknown as { execute(args: unknown): Promise<Record<string, unknown>> }
    const found = await read.execute({ id: 'f1' })
    expect(found).toMatchObject({ found: true, id: 'f1', content: '用户喜欢 vue 页面' })
    expect(state.accessed).toEqual([['f1']])
    expect(await read.execute({ id: 'nope' })).toEqual({ found: false })
  })

  it('query 缺失直接抛错', async () => {
    const mod = await freshModule()
    const tools = await mod.buildLeadMemoryTools(target, logger)
    const search = tools[0]! as unknown as { execute(args: unknown): Promise<unknown> }
    await expect(search.execute({})).rejects.toThrow('query')
  })
})
