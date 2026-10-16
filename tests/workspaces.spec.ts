import { mkdtemp, rm, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildChildWorkspace, sanitizeWorkspaceName, wrapAgentCreateWithCwd } from '../src/workspaces.ts'

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

describe('agents.create 工作区注入', () => {
  const childId = 'child-session-1'

  function recorder() {
    const calls: Array<Record<string, unknown>> = []
    const create = async (options: Record<string, unknown>) => {
      calls.push(options)
      return options
    }
    return { calls, create }
  }

  it('只给目标子会话注入 meta.cwd，并保留已有 meta 字段', async () => {
    const { calls, create } = recorder()
    const wrapped = wrapAgentCreateWithCwd(create, childId, '/ws/x')
    await wrapped({ sessionId: childId, meta: { cwd: '/ws', parentSession: 'p', origin: 'subagent' } })
    expect(calls[0].meta).toEqual({
      cwd: '/ws/x',
      parentSession: 'p',
      origin: 'subagent',
    })
    // 原始 options 不被改写
  })

  it('其他会话的创建调用原样透传（同一引用）', async () => {
    const { calls, create } = recorder()
    const wrapped = wrapAgentCreateWithCwd(create, childId, '/ws/child')
    const options = { sessionId: 'another-session', meta: { cwd: '/ws' } }
    await wrapped(options)
    expect(calls[0]).toBe(options)
  })

  it('sessionId 类型不一致时按字符串比较，缺失 meta 时自动补上', async () => {
    const { calls, create } = recorder()
    const wrapped = wrapAgentCreateWithCwd(create, '123', '/ws/child')
    await wrapped({ sessionId: 123 })
    expect(calls[0].meta).toEqual({ cwd: '/ws/child' })
  })
})
