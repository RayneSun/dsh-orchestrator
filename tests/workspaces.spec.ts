import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildChildWorkspace, ensureVaultPathEnv, resolveVaultRoot, sanitizeWorkspaceName } from '../src/workspaces.ts'
import { MEMORY_VAULT_DIRNAME } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('子会话工作区路径', () => {
  it('保留中文并清理路径分隔符和危险字符', () => {
    expect(sanitizeWorkspaceName('../飞机/大战:v2?')).toBe('飞机-大战-v2')
    expect(sanitizeWorkspaceName(' plane   war ')).toBe('plane-war')
    expect(sanitizeWorkspaceName('///')).toBe('task')
  })

  it('直接建在主工作区下：无中间目录、无 ID 后缀', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-orchestrator-'))
    roots.push(root)
    const workspace = await buildChildWorkspace(root, '飞机大战')
    expect(workspace.name).toBe('飞机大战')
    expect(workspace.dir).toBe(join(root, '飞机大战'))
  })

  it('同名目录已存在时递增 -2、-3 后缀，避免不同子会话混用', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-orchestrator-'))
    roots.push(root)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, '飞机大战'))
    await mkdir(join(root, '飞机大战-2'))
    const workspace = await buildChildWorkspace(root, '飞机大战')
    expect(workspace.name).toBe('飞机大战-3')
    expect(workspace.dir).toBe(join(root, '飞机大战-3'))
  })

  it('不会逃逸主工作区', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-orchestrator-'))
    roots.push(root)
    const workspace = await buildChildWorkspace(root, '../../etc/passwd')
    expect(workspace.dir).toBe(join(root, 'etc-passwd'))
    const { mkdir } = await import('node:fs/promises')
    await mkdir(workspace.dir, { recursive: true })
    await expect(readdir(root)).resolves.toEqual(['etc-passwd'])
  })
})

describe('记忆库常量', () => {
  it('记忆与知识库统一由 dsh-obsidian 管理（kb_vault）', () => {
    expect(MEMORY_VAULT_DIRNAME).toBe('kb_vault')
  })
})

describe('DSH_VAULT_PATH 代码内兜底', () => {
  const original = process.env.DSH_VAULT_PATH
  afterEach(() => {
    if (original === undefined) delete process.env.DSH_VAULT_PATH
    else process.env.DSH_VAULT_PATH = original
  })

  it('未配置时填充与 patch.yml 推导一致的默认值；显式配置优先不覆盖', () => {
    delete process.env.DSH_VAULT_PATH
    ensureVaultPathEnv()
    expect(process.env.DSH_VAULT_PATH).toBe(resolve(homedir(), 'Documents', 'deepseek-harness', 'default-workspace', 'kb_vault'))
    process.env.DSH_VAULT_PATH = 'D:/custom/vault'
    ensureVaultPathEnv()
    expect(process.env.DSH_VAULT_PATH).toBe('D:/custom/vault')
  })

  it('resolveVaultRoot 优先读代码填充的环境变量，无值时才落主工作区根', () => {
    delete process.env.DSH_VAULT_PATH
    ensureVaultPathEnv()
    expect(resolveVaultRoot('C:/any/workspace')).toBe(resolve(process.env.DSH_VAULT_PATH!))
    delete process.env.DSH_VAULT_PATH
    expect(resolveVaultRoot('C:/any/workspace')).toBe(resolve('C:/any/workspace', 'kb_vault'))
  })
})
