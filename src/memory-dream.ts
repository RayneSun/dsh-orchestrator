import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { TaskRecord } from './types.ts'

/** 记忆维护子工作区名，用于识别并跳过递归触发。 */
export const MEMORY_DREAM_WORKSPACE = 'memory-dream'
export const MEMORY_REFLECT_WORKSPACE = 'memory-reflect'

/** Dream 触发条件：用户/Lead 空闲 3 小时以上。 */
export const DREAM_IDLE_MS = 3 * 60 * 60 * 1000

/** Dream lease 有效期：超过此时间未更新则认为上次 Dream 已失效，可回收。 */
export const DREAM_LEASE_MS = 30 * 60 * 1000

/** Dream lease 心跳间隔（如未来改为 LLM 长任务时使用）。 */
export const DREAM_HEARTBEAT_MS = 60 * 1000

interface DreamLease {
  owner: string
  startedAt: number
  progressAt: number
}

function leasePath(vaultRoot: string): string {
  return join(vaultRoot, '.dream-lease.json')
}

export async function readDreamLease(vaultRoot: string): Promise<DreamLease | null> {
  try {
    const text = await readFile(leasePath(vaultRoot), 'utf8')
    const parsed = JSON.parse(text) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    const l = parsed as Partial<DreamLease>
    if (typeof l.owner !== 'string' || typeof l.startedAt !== 'number' || typeof l.progressAt !== 'number') return null
    return { owner: l.owner, startedAt: l.startedAt, progressAt: l.progressAt }
  } catch {
    return null
  }
}

/** 抢占 lease：当前无 lease 或 lease 已过期时返回 true。 */
export async function claimDreamLease(vaultRoot: string, owner: string): Promise<boolean> {
  const now = Date.now()
  const existing = await readDreamLease(vaultRoot)
  if (existing && now - existing.progressAt < DREAM_LEASE_MS) return false
  const lease: DreamLease = { owner, startedAt: now, progressAt: now }
  await writeFile(leasePath(vaultRoot), JSON.stringify(lease, null, 2), 'utf8')
  return true
}

export async function touchDreamLease(vaultRoot: string): Promise<void> {
  const lease = await readDreamLease(vaultRoot)
  if (!lease) return
  lease.progressAt = Date.now()
  await writeFile(leasePath(vaultRoot), JSON.stringify(lease, null, 2), 'utf8')
}

export async function finishDreamLease(vaultRoot: string): Promise<void> {
  await writeFile(leasePath(vaultRoot), '{}', 'utf8').catch(() => {})
}

export async function releaseDreamLease(vaultRoot: string): Promise<void> {
  await finishDreamLease(vaultRoot)
}

/** 近 7 日日期列表，用于 Dream 扫描 memory/ 目录。 */
export function recentMemoryDates(days = 7): string[] {
  const today = new Date()
  const dates: string[] = []
  for (let i = 0; i < days; i++) {
    const d = new Date(today.getTime() - i * 86_400_000)
    dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
  }
  return dates
}

/**
 * 语义提炼 prompt（idle Dream 用）：Host 已完成收集/去重/归档等机械操作，
 * 把待蒸馏条目汇总在 memory/pending.md；Worker 只负责最后一步语义提炼。
 */
export function buildDreamPrompt(vaultRoot: string): string {
  return `你是记忆语义提炼 Worker。Host 已把近 7 日待蒸馏的原始条目机械收集到 memory/pending.md（vault 根：${vaultRoot}），归档与轮转也已完成。你的唯一职责是从 pending.md 提炼长期记忆，不要做文件归档、移动、轮转等机械操作。

1. 用 obsidian_read 读 memory/pending.md，逐条判断是否值得进长期记忆
2. 值得的改写为规范条目（一条一事实、带关键词、所属项目、重要度 1-3），用 memory_remember 写入：用户画像/偏好 → USER.md，长期事实/决策/教训 → MEMORY.md；不值得的丢弃
3. 写入前先 obsidian_search 查重：已有相似条目用 obsidian_read → 修改 → obsidian_write 更新，不要新增重复
4. 在 DREAMS.md 追加一行审计：- <时间>：语义提炼 N 条进长期记忆，丢弃 M 条
5. 不要修改 memory/pending.md（Host 会在任务结算时清空它）
6. 完成后 task_update({status:'completed', report:{result:'提炼 N 条，丢弃 M 条'}})`
}

/** 刚结束的任务 → 记忆反思 prompt。
 * 反思只写当日原始记录（memory/YYYY-MM-DD.md）和非常稳定的用户画像；
 * 长期事实/决策/教训的提炼由 idle Dream 负责，避免任务刚结束就把临时信息当长期记忆。
 */
export function buildReflectPrompt(task: TaskRecord): string {
  const outcome = task.status === 'completed'
    ? `任务结果：\n${task.report?.result ?? ''}\n产物：${task.report?.artifacts?.join(', ') ?? '无'}`
    : `任务失败：${task.fail?.error ?? ''}`
  return `请回顾刚刚结束的任务，把有价值的信息先写入当日运行记录，不要急于写进长期记忆。

任务主题：${task.subject}
任务需求：${task.prompt}
${outcome}

写入规则：
- 用户画像/偏好（称呼、职业、居住地、生活习惯、兴趣等稳定信息）→ USER.md
- 其他所有信息 → 只进 memory/YYYY-MM-DD.md（当日运行记录）
- 禁止直接写入 MEMORY.md；MEMORY.md 只放经 Dream 提炼后的长期事实/决策/教训

当日记录写法：一条一事实，写清关键词、所属项目、重要度；临时进展、任务交付要点、当天决策都可以记。写入前用 memory_search 查重，当日记录里有相似条目就更新而非新增。
如果没有值得记录的信息，直接 task_update({status:'completed', report:{result:'无需记忆'}})。`
}

/** 分词：英文/数字整词 + 中文单字与相邻二字组（召回用，无外部依赖）。 */
function tokenize(text: string): string[] {
  const lower = text.toLowerCase()
  const tokens = [...lower.matchAll(/[a-z0-9]+/g)].map(m => m[0])
  for (const run of lower.match(/[\u4e00-\u9fff]+/g) ?? []) {
    const chars = [...run]
    for (let i = 0; i < chars.length; i++) {
      tokens.push(chars[i]!)
      if (i + 1 < chars.length) tokens.push(chars[i]! + chars[i + 1]!)
    }
  }
  return tokens
}

/**
 * 按问题对记忆条目做关键词重叠召回（进程内同步，供 system-prompt section 使用）：
 * query 与条目分词后按词频交集计分，返回得分最高的 k 条原文。
 * 无 query 或没有命中时返回空数组，调用方退回静态注入。
 */
export function recallMemoryEntries(entries: string[], query: string | undefined, k = 8): string[] {
  if (!query?.trim() || entries.length === 0) return []
  const queryTokens = new Set(tokenize(query))
  if (queryTokens.size === 0) return []
  const scored: Array<{ index: number; score: number }> = []
  for (let index = 0; index < entries.length; index++) {
    const counts = new Map<string, number>()
    for (const token of tokenize(entries[index]!)) counts.set(token, (counts.get(token) ?? 0) + 1)
    let score = 0
    for (const token of queryTokens) score += counts.get(token) ?? 0
    if (score > 0) scored.push({ index, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k).map(s => entries[s.index]!)
}
