import { describe, expect, it } from 'vitest'
import {
  createConversation,
  createTask,
  dispatchInputSchema,
  taskUpdateInputSchema,
} from '../src/types.ts'

describe('工具输入 Zod 校验', () => {
  it('接受完整 dispatch 参数并规范化空白，responseMode 默认 background', () => {
    const parsed = dispatchInputSchema.parse({
      subject: '  查询天气  ',
      prompt: '请查询上海天气',
      acceptanceCriteria: ' 给出温度 ',
      waitTimeoutMs: 30_000,
    })
    expect(parsed.subject).toBe('查询天气')
    expect(parsed.acceptanceCriteria).toBe('给出温度')
    expect(parsed.responseMode).toBe('background')
  })

  it('仍允许显式选择 wait', () => {
    const parsed = dispatchInputSchema.parse({ subject: '主题', prompt: '内容', responseMode: 'wait' })
    expect(parsed.responseMode).toBe('wait')
  })

  it.each(['subject', 'prompt'] as const)('dispatch 拒绝空的 %s', (field) => {
    const input = { subject: '主题', prompt: '内容' }
    expect(dispatchInputSchema.safeParse({ ...input, [field]: ' ' }).success).toBe(false)
  })

  it('dispatch 拒绝非法 responseMode、非法等待时间和多余字段', () => {
    expect(dispatchInputSchema.safeParse({
      subject: '主题', prompt: '内容', responseMode: 'nope',
    }).success).toBe(false)
    expect(dispatchInputSchema.safeParse({
      subject: '主题', prompt: '内容', responseMode: 'wait', waitTimeoutMs: 0,
    }).success).toBe(false)
    expect(dispatchInputSchema.safeParse({
      subject: '主题', prompt: '内容', scene: 'code',
    }).success).toBe(false)
  })

  it('completed 必须带 userAnswer，failed 必须带 error', () => {
    expect(taskUpdateInputSchema.safeParse({ status: 'completed' }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ status: 'failed' }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ status: 'blocked' }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({
      status: 'blocked', progressNote: '等待用户选择城市',
    }).success).toBe(true)
    expect(taskUpdateInputSchema.safeParse({
      status: 'blocked', question: '要蓝色还是红色？',
    }).success).toBe(true)
  })

  it('outlinePatch 拒绝空字符串但允许空数组清空未决问题', () => {
    expect(taskUpdateInputSchema.safeParse({
      status: 'running',
      outlinePatch: { tags: [' '] },
    }).success).toBe(false)
    const parsed = taskUpdateInputSchema.parse({
      status: 'running',
      outlinePatch: { tags: ['天气', '天气'], openQuestions: [] },
    })
    expect(parsed.outlinePatch?.tags).toEqual(['天气', '天气'])
    expect(parsed.outlinePatch?.openQuestions).toEqual([])
  })

  it('持久化工厂会初始化 provisioning、worker scene 和后台投递 outbox', () => {
    const conv = createConversation({
      id: 'conv_1', childSessionId: 'child', parentSessionId: 'parent', title: '天气',
    })
    const task = createTask({
      id: 'task_1', parentSessionId: 'parent', conversationId: 'conv_1',
      predecessorTaskId: null, subject: '天气', prompt: '查询',
      responseMode: 'background',
    })
    expect(conv.state).toBe('provisioning')
    expect(conv.scene).toBe('worker')
    expect(task.scene).toBe('worker')
    expect(task.progressSteps).toEqual([])
    expect(task.delivery).toEqual({ state: 'pending', attempts: 0 })
  })
})
