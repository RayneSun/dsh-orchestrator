import { stat } from 'node:fs/promises'
import { resolve, sep, basename } from 'node:path'

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

type AgentCreate = (options: Record<string, unknown>) => Promise<unknown>

/**
 * 包装 agents.create：仅对预分配 childSessionId 的那次创建注入 meta.cwd（覆盖
 * childSessionMeta 从父会话继承的 cwd），其余调用原样透传。注入的 cwd 会持久化
 * 进子会话 session header，后续恢复与文件/命令工具都以它为工作目录。
 */
export function wrapAgentCreateWithCwd(create: AgentCreate, childSessionId: string, cwd: string): AgentCreate {
  return options => {
    if (String(options.sessionId) !== childSessionId) return create(options)
    const meta = (options.meta && typeof options.meta === 'object' ? options.meta : {}) as Record<string, unknown>
    return create({ ...options, meta: { ...meta, cwd } })
  }
}
