import { defineTool } from '@deepseek-ai/dsh-tools'
import { SHARED_MEMORY_DIRNAME } from './workspaces.ts'

/**
 * Lead 记忆只读层。
 *
 * Lead 会话在 meow-memory 的 per-session 开关里关闭 inject/write/dream
 * （自动注入、自动写回、空闲整理全停），再用 scope 内同名影子工具
 * memory_search / memory_read 绕过 meow 的读闸门（skip_inject 会同时
 * 拒绝原生工具读）——主控保留查记忆能力，但不再被记忆系统注入上下文。
 *
 * meow-memory 是可选依赖：包被剔除或导出面变更时整体降级（不置开关、
 * 不注册影子工具），不影响 Lead 其余功能。
 */

type MeowRow = {
  id: string
  level: string
  title?: string
  content: string
  keywords?: string[]
  project?: string
  status?: string
  importance?: number
  created_at: number
  updated_at: number
}

type MeowDoc = {
  id: string
  level: string
  title?: string
  content: string
  keywords?: string[]
  importance?: number
  created_at: number
  updated_at: number
}

type MeowDb = {
  list(level: string, opts?: { status?: string }): MeowRow[]
  listSearchable?(level: string): MeowRow[]
  findById(id: string): { row: MeowRow } | undefined
  bumpHit?(level: string, id: string): void
  setMemoryScopeField(sessionId: string, field: 'inject' | 'write' | 'dream', value: boolean): void
}

type MeowSearchHit = {
  id: string
  level: string
  score: number
  content: string
  updated_at?: number
}

type MeowModule = {
  getDb(workspace: string, dir?: string): MeowDb
  search(query: string, docs: MeowDoc[], opts?: { k?: number }): MeowSearchHit[]
  readSeen(workspace: string, sessionId: string, dir?: string): Set<string>
  markSearched(workspace: string, sessionId: string, ids: string[], dir?: string): void
  markAccessed(workspace: string, sessionId: string, ids: string[], dir?: string): void
  LEVELS: readonly string[]
  projectCovers(rowProject: unknown, project: string): boolean
  isGlobalProject(project: string): boolean
  setCurrentProject(workspace: string, sessionId: string, project: string, dir?: string): void
}

let cached: MeowModule | null | undefined

/** 加载 meow-memory；包缺失或导出面变更时返回 null 并缓存，后续调用不再重试。 */
async function loadMeow(logger: { info?(message: string): void; warn?(message: string): void }): Promise<MeowModule | null> {
  if (cached !== undefined) return cached
  try {
    const mod = await import('meow-memory') as Partial<MeowModule>
    const required: Array<keyof MeowModule> = ['getDb', 'search', 'readSeen', 'markSearched', 'markAccessed', 'LEVELS', 'projectCovers', 'isGlobalProject', 'setCurrentProject']
    const missing = required.filter(key => mod[key] === undefined)
    if (missing.length > 0) throw new Error(`missing exports: ${missing.join(', ')}`)
    cached = mod as MeowModule
  } catch (error) {
    cached = null
    logger.warn?.(`orchestrator: meow-memory unavailable, lead memory tools skipped: ${String(error)}`)
  }
  return cached
}

export function leadMemoryState(): 'loaded' | 'unavailable' | 'pending' {
  return cached === undefined ? 'pending' : cached === null ? 'unavailable' : 'loaded'
}

export interface LeadMemoryTarget {
  workspace: string
  sessionId: string
}

/** 关闭 Lead 会话的记忆自动注入/写回/整理（幂等，失败只告警）。 */
export async function disableLeadMemoryInjection(
  target: LeadMemoryTarget,
  logger: { info?(message: string): void; warn?(message: string): void },
): Promise<void> {
  const meow = await loadMeow(logger)
  if (!meow) return
  try {
    const db = meow.getDb(target.workspace, SHARED_MEMORY_DIRNAME)
    for (const field of ['inject', 'write', 'dream'] as const) {
      db.setMemoryScopeField(target.sessionId, field, true)
    }
    logger.info?.(`orchestrator: lead memory injection/write/dream disabled for ${target.sessionId}`)
  } catch (error) {
    logger.warn?.(`orchestrator: disable lead memory scope failed: ${String(error)}`)
  }
}

const searchNote = '如果冲突，以最新的为准。时间戳较旧的条目可作为事情发展过程的参考。如果你确实需要更多细节，可以直接去聊天记录里搜索相关关键词。'

/** Lead 的记忆只读影子工具；meow 不可用时返回空数组。 */
export async function buildLeadMemoryTools(
  target: LeadMemoryTarget,
  logger: { info?(message: string): void; warn?(message: string): void },
): Promise<Array<ReturnType<typeof defineTool>>> {
  const meow = await loadMeow(logger)
  if (!meow) return []
  const dir = SHARED_MEMORY_DIRNAME
  const { workspace, sessionId } = target

  const sharedOutput = {
    schema: { type: 'json' as const },
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  }

  const searchTool = defineTool({
    name: 'memory_search',
    description: '检索长期记忆（只读）。按关键词查用户画像、偏好、长期事实、项目决策与教训。',
    parameters: {
      query: { type: 'string', required: true, description: '检索关键词' },
      level: { type: 'string', description: '限定层级，逗号分隔（fact/lesson/topic/rules 等）' },
      project: { type: 'string', description: '限定项目，逗号分隔' },
      status: { type: 'string', description: '限定状态，逗号分隔' },
      days: { type: 'integer', description: '只看最近 N 天（1-3650）' },
      k: { type: 'integer', description: '返回条数（1-50），默认 10' },
      content_max: { type: 'integer', description: '单条内容截断长度（0-5000），默认 300' },
    } as const,
    output: sharedOutput,
    async execute(args: any) {
      const query = typeof args?.query === 'string' ? args.query.trim() : ''
      if (!query) throw new Error('memory_search: query 必填且不能为空')
      const db = meow.getDb(workspace, dir)
      const seen = meow.readSeen(workspace, sessionId, dir)
      const projects = typeof args.project === 'string' && args.project.trim()
        ? args.project.split(',').map((s: string) => s.trim()).filter(Boolean)
        : []
      if (projects.length === 1 && !meow.isGlobalProject(projects[0]!)) {
        try { meow.setCurrentProject(workspace, sessionId, projects[0]!, dir) } catch { }
      }
      const statuses = typeof args.status === 'string' && args.status.trim()
        ? args.status.split(',').map((s: string) => s.trim()).filter(Boolean)
        : []
      const days = typeof args.days === 'number' && args.days > 0 ? Math.floor(args.days) : null
      const k = typeof args.k === 'number' && args.k >= 1 ? Math.min(50, Math.floor(args.k)) : 10
      const contentMax = typeof args.content_max === 'number' && args.content_max >= 0 ? Math.min(5000, Math.floor(args.content_max)) : 300
      const levels = typeof args.level === 'string' && args.level.trim()
        ? args.level.split(',').map((s: string) => s.trim()).filter((lv: string) => meow.LEVELS.includes(lv))
        : ['fact', 'lesson', 'topic', 'rules']
      const rows = levels.flatMap(lv => {
        if (statuses.length === 1 && statuses[0] !== 'active' && statuses[0] !== 'all') return db.list(lv, { status: statuses[0]! })
        if (statuses.length > 1) return db.list(lv)
        return typeof db.listSearchable === 'function' ? db.listSearchable(lv) : db.list(lv)
      }).filter(r => {
        if (projects.length > 0 && !projects.some(p => meow.projectCovers(r.project, p))) return false
        if (statuses.length > 0 && !statuses.includes('all') && r.status !== undefined && !statuses.includes(r.status)) return false
        if (days !== null && Date.now() - r.created_at > days * 86_400_000) return false
        return true
      })
      const byId = new Map<string, MeowRow>(rows.map(r => [r.id, r] as const))
      const docs: MeowDoc[] = rows.map(r => ({
        id: r.id, level: r.level, title: r.title, content: r.content,
        keywords: r.keywords, importance: r.importance, created_at: r.created_at, updated_at: r.updated_at,
      }))
      const ranked = meow.search(query, docs, { k: docs.length })
      const blindCount = Math.min(5, k)
      const fresh: MeowSearchHit[] = []
      for (const hit of ranked.slice(blindCount)) {
        if (fresh.length >= k - blindCount) break
        if (seen.has(hit.id)) continue
        fresh.push(hit)
      }
      const hits = [...ranked.slice(0, blindCount), ...fresh]
      for (const hit of hits) { try { db.bumpHit?.(hit.level, hit.id) } catch { } }
      try { meow.markSearched(workspace, sessionId, hits.map(h => h.id), dir) } catch { }
      return {
        note: searchNote,
        hits: [...hits].sort((a, b) => (a.updated_at ?? 0) - (b.updated_at ?? 0)).map(h => {
          const row = byId.get(h.id)
          return {
            id: h.id,
            level: h.level,
            title: row?.title ?? '',
            content: contentMax > 0 ? h.content.slice(0, contentMax) : h.content,
            keywords: row?.keywords ?? [],
            project: row?.project ?? '',
            score: Math.round(h.score * 100) / 100,
            updated_at: h.updated_at ?? 0,
          }
        }),
      }
    },
  })

  const readTool = defineTool({
    name: 'memory_read',
    description: '按 id 读取一条长期记忆的完整内容（只读）。',
    parameters: {
      id: { type: 'string', required: true, description: '记忆条目 id（来自 memory_search）' },
    } as const,
    output: sharedOutput,
    async execute(args: any) {
      const id = typeof args?.id === 'string' ? args.id.trim() : ''
      if (!id) throw new Error('memory_read: id 不能为空')
      const db = meow.getDb(workspace, dir)
      const found = db.findById(id)
      if (!found) return { found: false }
      const { row } = found
      try { meow.markAccessed(workspace, sessionId, [row.id], dir) } catch { }
      return {
        found: true,
        id: row.id,
        level: row.level,
        title: row.title ?? '',
        content: row.content,
        importance: row.importance,
        status: row.status,
        keywords: row.keywords,
        project: row.project ?? '',
        created_at: row.created_at,
        updated_at: row.updated_at,
      }
    },
  })

  logger.info?.('orchestrator: lead memory shadow tools registered (search/read, injection disabled)')
  return [searchTool, readTool]
}
