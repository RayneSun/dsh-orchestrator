import { describe, expect, it } from 'vitest'
import { createTask, defaultDeliveryToggles, type DeliveryToggles } from '../src/types.ts'
import { deliveryEnabledFor, gateTaskDelivery, transitionTask } from '../src/state-machine.ts'

function bgTask() {
  return createTask({
    id: 't1',
    parentSessionId: 'p',
    conversationId: 'c',
    predecessorTaskId: null,
    subject: '测试任务',
    prompt: '做点什么',
  })
}

const allOff: DeliveryToggles = {
  inputRequired: false,
  blocked: false,
  completed: false,
  failed: false,
  interrupted: false,
}

describe('终态投递开关', () => {
  it('toggles 缺失（未注入配置）时按默认全开，与历史行为一致', () => {
    for (const status of ['input_required', 'blocked', 'completed', 'failed', 'interrupted'] as const) {
      expect(deliveryEnabledFor(undefined, status)).toBe(true)
    }
  })

  it('按状态独立判定；非终态状态不受开关影响', () => {
    expect(deliveryEnabledFor({ ...defaultDeliveryToggles, inputRequired: false }, 'input_required')).toBe(false)
    expect(deliveryEnabledFor({ ...defaultDeliveryToggles, inputRequired: false }, 'completed')).toBe(true)
    expect(deliveryEnabledFor({ ...defaultDeliveryToggles, failed: false }, 'failed')).toBe(false)
    expect(deliveryEnabledFor({ ...defaultDeliveryToggles, interrupted: false }, 'interrupted')).toBe(false)
    expect(deliveryEnabledFor(allOff, 'running')).toBe(true)
    expect(deliveryEnabledFor(allOff, 'queued')).toBe(true)
  })

  it('gateTaskDelivery 剥掉被关闭状态的 pending，其他字段不变', () => {
    const done = transitionTask(bgTask(), { status: 'completed', report: { result: '搞定' } })
    expect(done.delivery).toEqual({ state: 'pending', attempts: 0 })
    const gated = gateTaskDelivery(done, { ...defaultDeliveryToggles, completed: false })
    expect(gated.delivery).toBeUndefined()
    expect(gated.status).toBe('completed')
    expect(gated.report?.result).toBe('搞定')
  })

  it('gateTaskDelivery 对开启状态与非 pending 记录是恒等操作', () => {
    const done = transitionTask(bgTask(), { status: 'completed', report: { result: 'x' } })
    expect(gateTaskDelivery(done, defaultDeliveryToggles)).toBe(done)
    expect(gateTaskDelivery(done, undefined)).toBe(done)
    const running = transitionTask(bgTask(), { status: 'running', progressNote: '进行中' })
    expect(gateTaskDelivery(running, allOff)).toBe(running)
  })

  it('silent 任务本就不挂起 pending，开关不再产生任何影响', () => {
    const silentDone = transitionTask({ ...bgTask(), silent: true }, { status: 'completed', report: { result: 'x' } })
    expect(silentDone.delivery).toBeUndefined()
    expect(gateTaskDelivery(silentDone, allOff)).toBe(silentDone)
  })
})
