import { lstat, mkdir, readlink, stat, symlink } from 'node:fs/promises'
import { resolve, sep, basename, join } from 'node:path'

const MAX_NAME_LENGTH = 64

/**
 * 把 Lead 提供的名称转成跨平台安全的单层目录名。保留中文和常见字母数字，
 * 拒绝路径分隔符、上级目录、控制字符，避免子工作区逃逸当前工作区。
 */
export function sanitizeWorkspaceName(input: string, fallback = 'task'): string {
  const normalized = input
    .normalize('NFKC')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '-')
    .replace(/\.\.+/g, '.')
    .replace(/[\s\-_]+/g, '-')
    .replace(/^[-.\s]+|[-.\s]+$/g, '')
    .slice(0, MAX_NAME_LENGTH)
    .replace(/[-.\s]+$/g, '')
  return /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u.test(normalized) ? normalized : fallback
}

export interface ChildWorkspace {
  name: string
  dir: string
}

async function pathExists(dir: string): Promise<boolean> {
  try {
    await stat(dir)
    return true
  } catch {
    return false
  }
}

/**
 * 在主会话工作区下解析唯一的子会话工作区路径：<主工作区>/<名称>/。
 * 名称已被占用（同名旧会话目录或其他文件）时递增 -2、-3 后缀，避免不同子会话混用目录。
 * 调用方负责 mkdir；dispatch 全程串行，检查与创建之间无竞态。
 */
export async function buildChildWorkspace(rootCwd: string, requestedName: string | undefined): Promise<ChildWorkspace> {
  const root = resolve(rootCwd)
  const slug = sanitizeWorkspaceName(requestedName?.trim() || 'task')
  for (let index = 0; index < 100; index++) {
    const name = index === 0 ? slug : `${slug}-${index + 1}`
    const dir = resolve(root, name)
    if (!dir.startsWith(root + sep) || basename(dir) !== name) {
      throw new Error(`invalid child workspace path: ${dir}`)
    }
    if (!await pathExists(dir)) return { name, dir }
  }
  throw new Error(`无法为子会话分配工作区目录：${slug} 的可用名称已耗尽`)
}

/** meow-memory 记忆库目录名（其库文件为 <会话cwd>/.dsh-meow/memory.db，per-workspace）。 */
export const SHARED_MEMORY_DIRNAME = '.dsh-meow'

/**
 * 把 Worker 工作区下的记忆库目录链接到主工作区的共享库，让 Lead 与全部 Worker
 * 共用同一份长期记忆（meow-memory 开 WAL + busy_timeout，多连接并发安全）。
 * 已存在真实目录（历史孤立记忆）时保留现状返回 false，由调用方决定告警；
 * 链接已正确指向目标时幂等返回 true。
 */
export async function ensureSharedMemoryLink(workerDir: string, rootCwd: string): Promise<boolean> {
  const root = resolve(rootCwd)
  const worker = resolve(workerDir)
  if (worker === root || !worker.startsWith(root + sep)) return false
  const target = join(root, SHARED_MEMORY_DIRNAME)
  const link = join(worker, SHARED_MEMORY_DIRNAME)
  const existing = await lstat(link).catch(() => undefined)
  if (existing) {
    if (!existing.isSymbolicLink()) return false
    const points = await readlink(link).catch(() => undefined)
    return points === target
  }
  await mkdir(target, { recursive: true })
  await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  return true
}
