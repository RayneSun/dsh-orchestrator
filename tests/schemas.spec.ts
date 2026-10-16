import { describe, expect, it } from 'vitest'
import {
  conversationSchema,
  createConversation,
  createTask,
  conversationIdInputSchema,
  dispatchInputSchema,
  taskSchema,
  taskUpdateInputSchema,
} from '../src/types.ts'

describe('工具输入 Zod 校验', () => {
  it('接受完整 dispatch 参数并规范化空白', () => {
    const parsed = dispatchInputSchema.parse({
      subject: '  查询天气  ',
      prompt: '请查询上海天气',
      acceptanceCriteria: ' 给出温度 ',
    })
    expect(parsed.subject).toBe('查询天气')
    expect(parsed.acceptanceCriteria).toBe('给出温度')
  })

  it.each(['subject', 'prompt'] as const)('dispatch 拒绝空的 %s', (field) => {
    const input = { subject: '主题', prompt: '内容' }
    expect(dispatchInputSchema.safeParse({ ...input, [field]: ' ' }).success).toBe(false)
  })

  it('dispatch 拒绝已移除的 wait 参数和多余字段', () => {
    expect(dispatchInputSchema.safeParse({
      subject: '主题', prompt: '内容', responseMode: 'wait',
    }).success).toBe(false)
    expect(dispatchInputSchema.safeParse({
      subject: '主题', prompt: '内容', waitTimeoutMs: 30_000,
    }).success).toBe(false)
    expect(dispatchInputSchema.safeParse({
      subject: '主题', prompt: '内容', scene: 'code',
    }).success).toBe(false)
  })

  it('completed/failed/blocked/input_required 的必填字段符合各自语义', () => {
    expect(taskUpdateInputSchema.safeParse({ status: 'completed' }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ status: 'failed' }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ status: 'blocked' }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ status: 'input_required' }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({
      status: 'input_required', progressNote: '等待用户选择城市',
    }).success).toBe(false)
    expect(taskUpdateInputSchema.parse({
      status: 'input_required', question: '要蓝色还是红色？',
    }).question).toBe('要蓝色还是红色？')
    const blocked = taskUpdateInputSchema.parse({
      status: 'blocked',
      reasonCode: 'permission_denied',
      error: '没有浏览器控制权限',
      remediation: '请在系统设置中授权后回复继续',
    })
    expect(blocked.reasonCode).toBe('permission_denied')
    expect(taskUpdateInputSchema.safeParse({ status: 'blocked', reasonCode: 'unknown' }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({
      status: 'input_required', question: '请授权浏览器？', error: '权限不足',
    }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({
      status: 'blocked', error: '权限不足', question: '怎么办？',
    }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ status: 'running', error: '意外错误' }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ status: 'running', question: '需要选择吗？' }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ status: 'completed', userAnswer: '完成', error: '旧错误' }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ status: 'failed', error: '失败', remediation: '请安装依赖' }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ status: 'blocked', error: '缺少依赖', userAnswer: '完成' }).success).toBe(false)
    expect(taskUpdateInputSchema.parse({ status: 'blocked', error: '缺少依赖', progressNote: '已定位到 bsk 缺失' }).status).toBe('blocked')
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

  it('持久化工厂初始化 provisioning；新建任务不预挂投递（终态时才挂起）', () => {
    const conv = createConversation({
      id: 'conv_1', childSessionId: 'child', parentSessionId: 'parent', title: '天气',
    })
    const task = createTask({
      id: 'task_1', parentSessionId: 'parent', conversationId: 'conv_1',
      predecessorTaskId: null, subject: '天气', prompt: '查询',
    })
    expect(conv.state).toBe('provisioning')
    expect(conv.activeTaskId).toBeNull()
    expect(task.status).toBe('queued')
    expect(task.progressSteps).toEqual([])
    expect(task.delivery).toBeUndefined()
  })



  it('dispatch 接受可选子工作区名称，并限制长度', () => {
    expect(dispatchInputSchema.parse({ subject: 's', prompt: 'p', workspaceName: 'plane-war' }).workspaceName).toBe('plane-war')
    expect(dispatchInputSchema.safeParse({ subject: 's', prompt: 'p', workspaceName: 'a'.repeat(81) }).success).toBe(false)
  })

  it('dispatch 接受 silent 标记，任务记录默认非静默', () => {
    expect(dispatchInputSchema.parse({ subject: 's', prompt: 'p', silent: true }).silent).toBe(true)
    expect(dispatchInputSchema.parse({ subject: 's', prompt: 'p' }).silent).toBeUndefined()
    const task = createTask({
      id: 't', parentSessionId: 'p', conversationId: 'c', predecessorTaskId: null,
      subject: 's', prompt: 'p', silent: true,
    })
    expect(task.silent).toBe(true)
    expect(createTask({
      id: 't', parentSessionId: 'p', conversationId: 'c', predecessorTaskId: null,
      subject: 's', prompt: 'p',
    }).silent).toBe(false)
  })


  it('conversationId 查询拒绝空值和多余字段', () => {
    expect(conversationIdInputSchema.safeParse({ conversationId: ' ' }).success).toBe(false)
    expect(conversationIdInputSchema.safeParse({ conversationId: 'conv_1', extra: 1 }).success).toBe(false)
    expect(conversationIdInputSchema.safeParse({ conversationId: 'conv_1' }).success).toBe(true)
  })

  it('dispatch 限制主题、需求和验收标准长度，outline 列表最多 50 项', () => {
    expect(dispatchInputSchema.safeParse({ subject: 'a'.repeat(201), prompt: 'p' }).success).toBe(false)
    expect(dispatchInputSchema.safeParse({ subject: 's', prompt: 'a'.repeat(100_001) }).success).toBe(false)
    expect(dispatchInputSchema.safeParse({
      subject: 's', prompt: 'p', acceptanceCriteria: 'a'.repeat(10_001),
    }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({
      status: 'running', outlinePatch: { tags: Array.from({ length: 51 }, (_, i) => `t${i}`) },
    }).success).toBe(false)
  })

})

describe('0.2.x 存储记录迁移', () => {
  const baseTask = {
    id: 'task_1', parentSessionId: 'p', conversationId: 'c', predecessorTaskId: null,
    subject: 's', prompt: 'p', responseMode: 'background',
    revision: 0, createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z',
    progressSteps: [],
  }
  const baseConv = {
    id: 'c', childSessionId: 'child', parentSessionId: 'p', title: 't',
    outline: { summary: '', keyFacts: [], entities: [], tags: [], artifacts: [], openQuestions: [] },
    activeTaskId: null, lastTaskId: null,
    revision: 0, createdAt: '2026-10-14T00:00:00.000Z', updatedAt: '2026-10-14T00:00:00.000Z',
  }

  it('blocked 迁移为 input_required，blockedQuestion 迁移为 question', () => {
    const task = taskSchema.parse({ ...baseTask, status: 'blocked', blockedQuestion: '选哪个？', scene: 'code' })
    expect(task.status).toBe('input_required')
    expect(task.question).toBe('选哪个？')
    expect('blockedQuestion' in task).toBe(false)
    expect('scene' in task).toBe(false)
    expect('responseMode' in task).toBe(false)
  })

  it('会话 blocked 状态迁移为 input_required', () => {
    const conv = conversationSchema.parse({ ...baseConv, state: 'blocked', scene: 'worker' })
    expect(conv.state).toBe('input_required')
    expect('scene' in conv).toBe(false)
  })

  it('0.3.1 的 blocked 记录不会被旧迁移规则误转为 input_required', () => {
    const task = taskSchema.parse({
      ...baseTask,
      status: 'blocked',
      error: '缺少 bsk CLI',
      reasonCode: 'dependency',
      remediation: '请安装 bsk 后继续',
    })
    expect(task.status).toBe('blocked')
    expect(task.reasonCode).toBe('dependency')
    expect(task.remediation).toContain('bsk')
  })
})
