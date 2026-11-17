import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as persona } from '@deepseek-ai/dsh-persona'
import { renderPrompt, renderContextSnapshot } from '@deepseek-ai/dsh-system-prompt'
import { OrchestratorService } from '../src/service.ts'
import { installLeadToolPolicy, leadToolAllowList } from '../src/lead-policy.ts'
import { buildPresetDefinitions, LEAD_PRESET } from '../src/presets.ts'
import { LEAD_PROMPT } from '../src/messages.ts'
import { agentSurface } from './helpers/agent-surface.ts'
import * as fsTools from '@deepseek-ai/dsh-tool-fs'
import * as searchTools from '@deepseek-ai/dsh-tool-fs-search'
import * as webTools from '@deepseek-ai/dsh-tool-web'
import * as presentTools from '@deepseek-ai/dsh-tool-present'
import { leadCapabilities } from '../src/capabilities.ts'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolCallId } from '@deepseek-ai/dsh-llm'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { vi.unstubAllGlobals(); for (const dispose of cleanup.splice(0).reverse()) await dispose() })

async function fixture(memory = true) {
  const surface = await agentSurface()
  cleanup.push(surface.dispose)
  for (const name of leadToolAllowList(memory)) surface.register(name, surface.presetScope.ctx)
  for (const name of ['bash', 'write', 'edit', 'skill', 'todo_write', 'memory_remember', 'render_ui']) surface.register(name)
  vi.stubGlobal('fetch', vi.fn(async () => memory ? new Response('{"ok":true}') : new Response(null, { status: 404 })))
  const service = Object.create(OrchestratorService.prototype)
  Object.assign(service, {
    installed: new Map(), todoTimers: new Map(), pendingTodoSteps: new Map(),
    workerCapabilities: { tools: [], skills: [] },
    snapshotFor: () => ({ conversations: [] }),
    hostCtx: {
      get: (name: string) => name === 'webServer' ? { getOrigin: () => 'http://localhost' } : surface.ctx.get(name),
      sessions: { flush: async () => {} },
      on: surface.ctx.on.bind(surface.ctx), logger: { warn: vi.fn() },
    },
  })
  const config = buildPresetDefinitions().find(item => item.id === LEAD_PRESET)!.plugins.find(row => row.id === 'persona')!.config
  persona(surface.presetScope.ctx, config as any)
  return { ...surface, service }
}

describe('真实 rc.1 Lead 装配', () => {
  it('真实首方插件按能力配置挂载，原生执行器允许读取并拒绝隐藏的修改工具', async () => {
    const mutation = vi.fn(async () => 'should never execute')
    let webReady = true
    const f = await agentSurface({
      fs: {
        resolve: async (path: string) => path,
        stat: async () => ({ type: 'file', size: 12 }),
        readText: async () => 'hello world\n', processPath: (path: string) => path,
      },
      workingDirectory: { ensure: async () => '/tmp' },
      attachments: {}, subprocess: {}, agents: {},
      web: { searchReady: () => webReady, fetchReady: () => webReady },
    })
    cleanup.push(f.dispose)
    const plugins = [fsTools, searchTools, webTools, presentTools]
    for (const capability of leadCapabilities) {
      if (!capability.plugin) continue
      const plugin = plugins.find(plugin => capability.plugin!.name.endsWith('/dsh-' + plugin.name))!
      await plugin.apply(f.presetScope.ctx, plugin.Config(capability.plugin.config ?? {}) as any)
    }
    await vi.waitFor(() => expect(f.names()).toContain('read_image'))
    expect(f.names()).toEqual(leadToolAllowList(false).sort())
    f.ctx.tools.register({ ...f.ctx.tools.get('read', f.agent)!, name: 'write', execute: mutation })
    await installLeadToolPolicy(f.agent as Agent, false, vi.fn())
    const admitted = async () => {
      const tools = await f.ctx.tools.resolve({ agent: f.agent as Agent, modelSelection: { provider: 'test', model: 'test' }, signal: AbortSignal.timeout(5000) })
      try { return f.ctx.tools.schemas(f.agent, tools).map(tool => tool.name).sort() }
      finally { tools.dispose() }
    }
    expect(await admitted()).toEqual(leadToolAllowList(false).sort())
    webReady = false
    expect(await admitted()).toEqual(leadToolAllowList(false).filter(name => !name.startsWith('web_')).sort())
    const result = await f.ctx.tools.execute({
      agent: f.agent as Agent, signal: AbortSignal.timeout(5000),
      calls: [
        { type: 'tool-call', id: 'read' as ToolCallId, name: 'read', arguments: '{"file_path":"/tmp/test.txt"}' },
        { type: 'tool-call', id: 'write' as ToolCallId, name: 'write', arguments: '{"file_path":"/tmp/test.txt"}' },
      ],
    })
    expect(result.results[0].result, JSON.stringify(result.results[0].result)).not.toMatchObject({ isError: true })
    expect(JSON.stringify(result.results[0].result)).toContain('hello world')
    expect(result.results[1].result.isError).toBe(true)
    expect(mutation).not.toHaveBeenCalled()
  })

  it('只暴露固定继承工具与自身编排/提问，晚注册普通工具仍默认隐藏', async () => {
    const f = await fixture()
    await f.service.configureLead(f.agent)
    const expected = [...leadToolAllowList(true), 'orchestrator_dispatch', 'orchestrator_get', 'ask_user_question'].sort()
    expect(f.names()).toEqual(expected)
    f.register('third_party_future_tool')
    expect(f.names()).toEqual(expected)
    // own scope 是平台明确的例外，不能将继承掩码宣传为任意插件隔离。
    f.register('third_party_own_tool', f.agent.ctx)
    expect(f.names()).toContain('third_party_own_tool')
    expect(f.ctx.tools.get('bash', f.agent)).toBeUndefined()
    const assembly = await f.ctx.systemPrompt.assemble({ scope: f.agent })
    expect(assembly.tools.map(tool => tool.name).sort()).toEqual(f.names())
  })

  it('complete 排除普通 section，关闭 optional context 并保留 required 来源及动态 roster', async () => {
    const f = await fixture()
    f.ctx.systemPrompt.section({ name: 'third-party-guide', order: 99, text: '普通插件说明' })
    f.ctx.systemPrompt.context({ name: 'harness:source', order: 100, text: '可选宿主源码' })
    f.ctx.systemPrompt.context({ name: 'cwd', order: 1, text: '/workspace', required: true })
    f.ctx.systemPrompt.context({ name: 'third-party-required', order: 2, text: '第三方必需事实', required: true })
    await f.service.configureLead(f.agent)
    const assembly = await f.ctx.systemPrompt.assemble({ scope: f.agent })
    expect(assembly.sections).toHaveLength(1)
    expect(renderPrompt(assembly)).toBe(LEAD_PROMPT)
    expect(assembly.contexts.map(item => item.name)).toEqual(['cwd', 'third-party-required', 'orchestrator:worker-capabilities', 'orchestrator:roster'])
    expect(renderContextSnapshot(assembly)).toContain('可派发模式：general')
    expect(renderContextSnapshot(assembly)).not.toContain('ppt（')
  })

  it('重装只保留一组注册，空掩码覆盖 teardown 窗口，卸载释放所有策略', async () => {
    const f = await fixture()
    await f.service.configureLead(f.agent)
    const before = f.names()
    const reset = f.service.resetInstalled.bind(f.service)
    f.service.resetInstalled = async (id: string) => {
      await reset(id)
      expect(f.names()).toEqual([])
    }
    await f.service.configureLead(f.agent)
    expect(f.names()).toEqual(before)
    f.service.resetInstalled = reset
    await reset('lead')
    expect(f.names()).toContain('bash')
    expect(f.names()).not.toContain('orchestrator_dispatch')
  })

  it('并发 configure 串行重装，不重复注册或遗留空掩码', async () => {
    const f = await fixture()
    await Promise.all([f.service.configureLead(f.agent), f.service.configureLead(f.agent)])
    expect(f.names()).toEqual([...leadToolAllowList(true), 'orchestrator_dispatch', 'orchestrator_get', 'ask_user_question'].sort())
    expect(f.service.leadConfigurations.size).toBe(0)
  })

  it('未启用记忆插件时正常装配且不暴露查询', async () => {
    const f = await fixture(false)
    await f.service.configureLead(f.agent)
    expect(f.names()).not.toContain('memory_search')
    expect(f.names()).toContain('read')
    expect(f.service.hostCtx.logger.warn).not.toHaveBeenCalled()
  })

  it('必需工具缺失不能静默求交，退化后自身路由工具仍保留', async () => {
    const f = await agentSurface(); cleanup.push(f.dispose)
    f.register('orchestrator_dispatch', f.agent.ctx)
    const warn = vi.fn()
    const release = await installLeadToolPolicy(f.agent as any, false, warn)
    expect(f.names()).toEqual(['orchestrator_dispatch'])
    f.register('new_tool')
    expect(f.names()).toEqual(['orchestrator_dispatch'])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('read'))
    release()
    expect(f.names()).toContain('new_tool')
  })

  it('加载时序短暂缺失有界重试，不建立常驻监听', async () => {
    const f = await agentSurface(); cleanup.push(f.dispose)
    const policy = installLeadToolPolicy(f.agent as any, false, vi.fn())
    for (const name of leadToolAllowList(false)) f.register(name)
    await policy
    expect(f.names()).toEqual(leadToolAllowList(false).sort())
  })

  it('空 allow 也失败时向上传播，不能用 guard 冒充隐藏', async () => {
    const agent = { ctx: { tools: { restrict: () => { throw new Error('registry unavailable') } } } }
    await expect(installLeadToolPolicy(agent as any, false, vi.fn())).rejects.toThrow('registry unavailable')
  })
})

it('Worker 动态 deny 仍隐藏禁止类别，后装普通工具默认开放，卸载清理监听', async () => {
  const f = await agentSurface(); cleanup.push(f.dispose)
  const service = Object.create(OrchestratorService.prototype)
  Object.assign(service, {
    installed: new Map(), todoTimers: new Map(), pendingTodoSteps: new Map(),
    hostCtx: { get: f.ctx.get.bind(f.ctx), on: f.ctx.on.bind(f.ctx), logger: { warn: vi.fn() } },
  })
  const { isWorkerToolForbidden } = await import('../src/worker-policy.ts')
  service.watchToolPolicy(f.agent, (names: string[]) => names.filter(name => isWorkerToolForbidden(name) !== undefined))
  for (const name of ['bash', 'memory_remember', 'third_party_tool', 'orchestrator_dispatch', 'ask_user_question', 'ralph', 'task_completed']) f.register(name)
  expect(f.names()).toEqual(['bash', 'memory_remember', 'task_completed', 'third_party_tool'])
  await service.resetInstalled('lead')
  expect(f.names()).toContain('orchestrator_dispatch')
})

it('Worker 完整装配保留执行能力、五个上报工具和权限设置，未知模式拒绝推理', async () => {
  const f = await agentSurface(); cleanup.push(f.dispose)
  for (const name of ['bash', 'read', 'write', 'skill', 'todo_write', 'memory_search', 'memory_remember', 'schedule_create', 'subagent', 'ask_user_question', 'orchestrator_dispatch', 'render_ui']) f.register(name)
  const set = vi.fn(), select = vi.fn(), recompose = vi.fn()
  let mode = 'general'
  const service = Object.create(OrchestratorService.prototype)
  Object.assign(service, {
    installed: new Map(), todoTimers: new Map(), pendingTodoSteps: new Map(),
    conversationByChild: () => ({ mode }),
    hostCtx: {
      agentPresets: { composedPreset: () => 'may-orchestrator-worker', select, recompose },
      get: (name: string) => name === 'permissionPresets' ? { set } : f.ctx.get(name),
      on: f.ctx.on.bind(f.ctx), logger: { warn: vi.fn() },
    },
  })
  await service.configureWorker(f.agent)
  expect(f.names()).toEqual(['bash', 'memory_remember', 'memory_search', 'read', 'schedule_create', 'skill', 'subagent', 'task_completed', 'task_failed', 'task_input_required', 'task_running', 'task_todo', 'todo_write', 'write'])
  expect(set).toHaveBeenCalledWith(f.agent.session, 'danger-full-access')
  expect(select).not.toHaveBeenCalled()
  mode = 'removed'
  await expect(service.configureWorker(f.agent)).rejects.toThrow('执行模式不可用')
  const stream = f.agent.ctx.waterfall('llm/stream', {} as any, async function* () { yield 'bad' })
  await expect(stream.next()).rejects.toThrow('执行模式不可用')
  expect(recompose).not.toHaveBeenCalled()
})
