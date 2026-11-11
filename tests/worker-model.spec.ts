import { describe, expect, it, vi } from 'vitest'
import { OrchestratorService } from '../src/service.ts'

const catalog = {
  groups: [{
    id: 'ark',
    models: [
      { id: 'worker-default', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'medium' } },
      { id: 'lead-current' },
    ],
  }],
  failures: [],
}

function harness(options: {
  configured?: { provider?: string, model?: string, reasoningEffort?: string }
  current?: { provider: string, model: string }
  availableCatalog?: typeof catalog
} = {}) {
  const service = Object.create(OrchestratorService.prototype)
  const agent = { session: { id: 'worker' } }
  const selectForNextRequest = vi.fn()
  const parent = {
    options: { provider: 'snapshot', model: 'snapshot-model' },
    session: {
      id: 'lead',
      requestHeader: () => undefined,
    },
  }
  Object.assign(service, {
    configRefs: {
      workerProvider: { get: () => options.configured?.provider ?? '' },
      workerModel: { get: () => options.configured?.model ?? '' },
      workerReasoningEffort: { get: () => options.configured?.reasoningEffort ?? '' },
    },
    hostCtx: {
      sessionController: { modelCatalog: vi.fn(async () => options.availableCatalog ?? catalog) },
      sessionProjections: { stateOf: () => ({ pending: { provider: 'ark', model: 'lead-current' } }) },
      agentDefaultModel: { currentSelection: () => ({ provider: 'global', model: 'global-model' }) },
      agents: {
        selectionFor: () => ({ current: options.current ?? { provider: 'ark', model: 'lead-current' } }),
        selectForNextRequest,
      },
      logger: { warn: vi.fn(), info: vi.fn() },
    },
    withAgent: async (_id: string, operation: (value: unknown) => Promise<unknown>) => operation(agent),
  })
  return { service, parent, agent, selectForNextRequest }
}

describe('Worker 默认模型', () => {
  it('新 Worker 优先使用设置中的模型与推理强度', async () => {
    const { service, parent } = harness({ configured: { provider: 'ark', model: 'worker-default', reasoningEffort: 'high' } })
    await expect(service.workerModelOptions(parent)).resolves.toMatchObject({
      provider: 'ark', model: 'worker-default', reasoningEffort: 'high',
    })
  })

  it('默认模型失效时回退 Lead 的 pending 选择', async () => {
    const { service, parent } = harness({ configured: { provider: 'ark', model: 'removed-model' } })
    await expect(service.workerModelOptions(parent)).resolves.toMatchObject({
      provider: 'ark', model: 'lead-current',
    })
  })

  it('未设置默认模型时保持 Lead 继承逻辑', async () => {
    const { service, parent } = harness()
    await expect(service.workerModelOptions(parent)).resolves.toMatchObject({
      provider: 'ark', model: 'lead-current',
    })
  })
})

describe('旧 Worker 模型维护', () => {
  it('原模型仍可用时不覆盖旧会话选择', async () => {
    const fixture = harness({
      configured: { provider: 'ark', model: 'worker-default' },
      current: { provider: 'ark', model: 'lead-current' },
    })
    await fixture.service.refreshWorkerModelIfUnavailable('worker', fixture.parent)
    expect(fixture.selectForNextRequest).not.toHaveBeenCalled()
  })

  it('原模型失效时保留会话并仅重选模型', async () => {
    const fixture = harness({
      configured: { provider: 'ark', model: 'worker-default', reasoningEffort: 'high' },
      current: { provider: 'ark', model: 'removed-model' },
    })
    await fixture.service.refreshWorkerModelIfUnavailable('worker', fixture.parent)
    expect(fixture.selectForNextRequest).toHaveBeenCalledWith(fixture.agent, {
      provider: 'ark', model: 'worker-default', reasoningEffort: 'high',
    })
  })

  it('目录查询失败时保持旧模型，避免误切换', async () => {
    const fixture = harness({ current: { provider: 'ark', model: 'lead-current' } })
    fixture.service.hostCtx.sessionController.modelCatalog.mockRejectedValue(new Error('offline'))
    await fixture.service.refreshWorkerModelIfUnavailable('worker', fixture.parent)
    expect(fixture.selectForNextRequest).not.toHaveBeenCalled()
  })
})
