import { describe, expect, it, vi } from 'vitest'
import { executionMode, executionModes, resolveExecutionMode } from '../src/modes.ts'
import { conversationSchema, createConversation, dispatchInputSchema } from '../src/types.ts'
import { buildPresetDefinitions } from '../src/presets.ts'
import { renderWorkerCapabilityIndex } from '../src/messages.ts'
import { OrchestratorService } from '../src/service.ts'

const conversation = () => createConversation({ id: 'conv', parentSessionId: 'lead', childSessionId: 'worker', title: '测试' })

describe('最小执行模式契约', () => {
  it('只启用 general，旧记录缺字段默认读取为 general，未知记录不被解析丢弃', () => {
    expect(executionModes.map(mode => mode.id)).toEqual(['general'])
    expect(buildPresetDefinitions().some(preset => preset.id === executionMode('general').preset)).toBe(true)
    const { mode: _, ...legacy } = conversation()
    expect(conversationSchema.parse(legacy).mode).toBe('general')
    expect(conversationSchema.parse({ ...legacy, mode: 'removed' }).mode).toBe('removed')
    expect(renderWorkerCapabilityIndex({ tools: [], skills: [] })).not.toContain('ppt（')
  })

  it('dispatch 不为省略的 mode 默认填值，PPT 与未知输入当前被拒绝', () => {
    const args = { subject: '测试', prompt: '测试', conversationId: 'conv' }
    expect(dispatchInputSchema.parse(args).mode).toBeUndefined()
    expect(dispatchInputSchema.parse({ ...args, mode: 'general' }).mode).toBe('general')
    for (const mode of ['ppt', 'unknown', '']) expect(dispatchInputSchema.safeParse({ ...args, mode }).success).toBe(false)
  })

  it('新建缺省、复用缺省与显式相同可用，显式切换和移除模式明确报错', () => {
    expect(resolveExecutionMode()).toBe('general')
    expect(resolveExecutionMode(undefined, 'general')).toBe('general')
    expect(resolveExecutionMode('general', 'general')).toBe('general')
    expect(() => resolveExecutionMode('ppt', 'general')).toThrow('不能变更')
    expect(() => resolveExecutionMode(undefined, 'removed')).toThrow('不可用')
  })

  it('复用模式校验先于换模型、中断、落库与投递，不破坏旧任务', async () => {
    const service = Object.create(OrchestratorService.prototype)
    const refresh = vi.fn(), write = vi.fn()
    Object.assign(service, { conversationById: conversation, refreshWorkerModelIfUnavailable: refresh, putPair: write })
    await expect(service.provisionDispatch({ conversationId: 'conv', mode: 'ppt' }, {}, 'lead')).rejects.toThrow('不能变更')
    expect(refresh).not.toHaveBeenCalled()
    expect(write).not.toHaveBeenCalled()
  })
})
