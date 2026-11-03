import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, sep, basename, join } from 'node:path'
import { MEMORY_VAULT_DIRNAME } from './types.ts'

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

/**
 * DSH 默认共享 vault 的代码内定位：锚定 dsh 默认工作空间下的
 * default-workspace/kb_vault（<用户目录>/Documents/deepseek-harness/default-workspace/kb_vault），
 * 与 cordis.patch.yml 中 dsh-obsidian vaultPath 的默认推导完全一致，双源读写同一 vault，
 * 不随进程 cwd 漂移（多实例部署时各自 cwd 不同，cwd 推导会分叉到不同目录）。
 */
export function defaultVaultPath(): string {
  return resolve(homedir(), 'Documents', 'deepseek-harness', 'default-workspace', MEMORY_VAULT_DIRNAME)
}

/**
 * 进程内兜底设置 DSH_VAULT_PATH：未显式配置时填充 defaultVaultPath()，
 * 使 Lead/Worker/Host 各处 resolveVaultRoot 与 dsh-obsidian 的 vaultPath
 * 无需人工 setx 即指向同一 vault 根。只在当前进程生效、不持久化；显式
 * 环境变量（setx / 启动脚本）始终优先，不会被覆盖。
 */
export function ensureVaultPathEnv(): void {
  if (!process.env.DSH_VAULT_PATH) process.env.DSH_VAULT_PATH = defaultVaultPath()
}

/**
 * 解析共享 vault 根路径：环境变量 DSH_VAULT_PATH 优先，否则落在主工作区根下。
 * 与 cordis.patch.yml 中 dsh-obsidian 的 vaultPath 推导保持一致。
 */
export function resolveVaultRoot(workspaceRoot: string): string {
  return process.env.DSH_VAULT_PATH
    ? resolve(process.env.DSH_VAULT_PATH)
    : resolve(workspaceRoot, MEMORY_VAULT_DIRNAME)
}
