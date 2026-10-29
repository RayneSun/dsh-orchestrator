import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildChildWorkspace, ensureSharedMemoryLink, sanitizeWorkspaceName, SHARED_MEMORY_DIRNAME } from '../src/workspaces.ts'

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

describe('共享记忆库链接', () => {
  it('Worker 工作区的 .dsh-meow 链接到主工作区，且幂等', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-orchestrator-'))
    roots.push(root)
    const { mkdir, lstat, readlink } = await import('node:fs/promises')
    const worker = join(root, 'worker-a')
    await mkdir(worker)
    await expect(ensureSharedMemoryLink(worker, root)).resolves.toBe(true)
    const link = join(worker, SHARED_MEMORY_DIRNAME)
    expect((await lstat(link)).isSymbolicLink()).toBe(true)
    expect(await readlink(link)).toBe(join(root, SHARED_MEMORY_DIRNAME))
    // 目标目录被真实创建，幂等重入不报错
    await expect(ensureSharedMemoryLink(worker, root)).resolves.toBe(true)
  })

  it('已存在真实目录（历史孤立记忆）时保留现状', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-orchestrator-'))
    roots.push(root)
    const { mkdir } = await import('node:fs/promises')
    const worker = join(root, 'worker-b')
    await mkdir(join(worker, SHARED_MEMORY_DIRNAME), { recursive: true })
    await expect(ensureSharedMemoryLink(worker, root)).resolves.toBe(false)
  })

  it('主工作区自身或非子目录不建链接', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-orchestrator-'))
    roots.push(root)
    await expect(ensureSharedMemoryLink(root, root)).resolves.toBe(false)
    await expect(ensureSharedMemoryLink(join(root, '..'), root)).resolves.toBe(false)
  })
})
