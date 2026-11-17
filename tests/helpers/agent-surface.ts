import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { defineTool, ToolsService } from '@deepseek-ai/dsh-tools'
import { apply as nativeExecutor } from '@deepseek-ai/dsh-tool-executor-native'

/** 使用真实 rc.1 注册表、scope 链与原生执行器，避免 mock 自证过滤语义。 */
export async function agentSurface(providers: Record<string, unknown> = {}) {
  const root = new Context()
  for (const [name, value] of Object.entries(providers)) root.provide(name, value)
  const fibers = [root.plugin(SystemPrompt, {}), root.plugin(ToolsService)]
  let dependencyFiber: ReturnType<Context['inject']>
  const ctx = await new Promise<Context>(resolve => {
    dependencyFiber = root.inject(['tools', 'systemPrompt', ...Object.keys(providers)], ctx => { resolve(ctx) })
  })
  nativeExecutor(ctx)
  const preset = {}
  const presetScope = createScope(ctx, preset)
  const agent = { session: { id: 'lead', header: { cwd: '/tmp' } }, ctx: undefined as Context }
  const scope = createScope(ctx, agent, { parent: preset })
  agent.ctx = scope.ctx
  const register = (name: string, target = ctx) => target.tools.register(defineTool({
    name, description: name, parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: String(value) }] }, execute: async () => name,
  }))
  return {
    ctx, agent, presetScope, register,
    names: () => ctx.tools.schemas(agent).map(tool => tool.name).sort(),
    dispose: async () => {
      await scope.dispose()
      await presetScope.dispose()
      await dependencyFiber.dispose()
      for (const fiber of fibers.reverse()) await fiber.dispose()
    },
  }
}
