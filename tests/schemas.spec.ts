import { describe, expect, it } from 'vitest'
import {
  conversationSchema,
  createConversation,
  createTask,
  userTodoSchema,
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
      workspaceName: 'weather-query',
      acceptanceCriteria: ' 给出温度 ',
    })
    expect(parsed.subject).toBe('查询天气')
    expect(parsed.acceptanceCriteria).toBe('给出温度')
  })

  it.each(['subject', 'prompt'] as const)('dispatch 拒绝空的 %s', (field) => {
    const input = { subject: '主题', prompt: '内容', workspaceName: 'demo-task' }
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
    expect(taskUpdateInputSchema.safeParse({ status: 'completed', report: { result: '完成' }, error: '旧错误' }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ status: 'failed', error: '失败', remediation: '请安装依赖' }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ status: 'blocked', error: '缺少依赖', report: { result: '完成' } }).success).toBe(false)
    expect(taskUpdateInputSchema.parse({ status: 'blocked', error: '缺少依赖', progressNote: '已定位到 bsk 缺失' }).status).toBe('blocked')
  })

  it('completed 要求 report.result；artifacts 只允许相对路径', () => {
    expect(taskUpdateInputSchema.safeParse({ status: 'completed' }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({
      status: 'completed', report: { result: '  ' },
    }).success).toBe(false)
    const parsed = taskUpdateInputSchema.parse({
      status: 'completed',
      report: { result: '完成', artifacts: ['out/index.html', 'docs/summary.md'] },
      summary: '产物已就绪',
    })
    expect(parsed.report?.artifacts).toEqual(['out/index.html', 'docs/summary.md'])
    for (const bad of ['/abs/path.html', '../escape.html', 'a/../../b', '']) {
      expect(taskUpdateInputSchema.safeParse({
        status: 'completed', report: { result: 'r', artifacts: [bad] },
      }).success).toBe(false)
    }
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



  it('workspaceName 新建必填且必须是英文 slug；复用子会话时可省略', () => {
    expect(dispatchInputSchema.parse({ subject: 's', prompt: 'p', workspaceName: 'plane-war' }).workspaceName).toBe('plane-war')
    // 新建（无 conversationId）缺 workspaceName 拒绝
    expect(dispatchInputSchema.safeParse({ subject: 's', prompt: 'p' }).success).toBe(false)
    // 复用时不需要
    expect(dispatchInputSchema.safeParse({ subject: 's', prompt: 'p', conversationId: 'conv_1' }).success).toBe(true)
    // slug 规则：中文、大写、空格、下划线、前导中划线、超长都拒绝
    for (const bad of ['制作页面', 'Daily-News', 'daily news', 'daily_news', '-daily', 'a'.repeat(81), '']) {
      expect(dispatchInputSchema.safeParse({ subject: 's', prompt: 'p', workspaceName: bad }).success).toBe(false)
    }
  })

  it('dispatch 接受 silent 标记，任务记录默认非静默', () => {
    expect(dispatchInputSchema.parse({ subject: 's', prompt: 'p', workspaceName: 'demo-task', silent: true }).silent).toBe(true)
    expect(dispatchInputSchema.parse({ subject: 's', prompt: 'p', workspaceName: 'demo-task' }).silent).toBeUndefined()
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


  it('dispatch 已移除 conversationTitle（subject 即会话标题）', () => {
    expect(dispatchInputSchema.parse({ subject: '每日热点新闻', prompt: 'p', workspaceName: 'daily-news' }).subject).toBe('每日热点新闻')
    expect(dispatchInputSchema.safeParse({ subject: 's', prompt: 'p', workspaceName: 'demo-task', conversationTitle: 'x' }).success).toBe(false)
  })

  it('conversation 记录允许可选 hasActiveSchedule 快照标记', () => {
    const conv = createConversation({ id: 'c1', childSessionId: 's1', parentSessionId: 'p1', title: 't' })
    expect(conversationSchema.parse(conv).hasActiveSchedule).toBeUndefined()
    expect(conversationSchema.parse({ ...conv, hasActiveSchedule: true }).hasActiveSchedule).toBe(true)
  })

  it('conversationId 查询拒绝空值和多余字段', () => {
    expect(conversationIdInputSchema.safeParse({ conversationId: ' ' }).success).toBe(false)
    expect(conversationIdInputSchema.safeParse({ conversationId: 'conv_1', extra: 1 }).success).toBe(false)
    expect(conversationIdInputSchema.safeParse({ conversationId: 'conv_1' }).success).toBe(true)
  })

  it('dispatch 限制主题、需求和验收标准长度，outline 列表最多 50 项', () => {
    expect(dispatchInputSchema.safeParse({ subject: 'a'.repeat(201), prompt: 'p', workspaceName: 'demo-task' }).success).toBe(false)
    expect(dispatchInputSchema.safeParse({ subject: 's', prompt: 'a'.repeat(100_001), workspaceName: 'demo-task' }).success).toBe(false)
    expect(dispatchInputSchema.safeParse({
      subject: 's', prompt: 'p', acceptanceCriteria: 'a'.repeat(10_001),
    }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({
      status: 'running', outlinePatch: { tags: ['t'] },
    }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ status: 'running', summary: 'a'.repeat(301) }).success).toBe(false)
  })

})

describe('task_update 待办与标题协议', () => {
  it('title 全状态可选，最多 8 个字；超长拒绝', () => {
    for (const status of ['running', 'input_required', 'blocked', 'completed', 'failed'] as const) {
      const base: Record<string, unknown> = { status, title: '已查到 3 家' }
      if (status === 'completed') base.report = { result: '答案' }
      if (status === 'failed' || status === 'blocked') base.error = '原因'
      if (status === 'input_required') base.question = '问题'
      const ok = taskUpdateInputSchema.safeParse(base)
      expect(ok.success).toBe(true)
      const tooLong = taskUpdateInputSchema.safeParse({ ...base, title: 'x'.repeat(9) })
      expect(tooLong.success).toBe(false)
    }
  })

  it('report.todos 接受 title/detail/dueDate；dueDate 必须 YYYY-MM-DD', () => {
    const ok = taskUpdateInputSchema.safeParse({
      status: 'completed',
      report: { result: '答案', todos: [{ title: '去购买火车票', detail: 'G123 二等座', dueDate: '2026-10-25' }] },
    })
    expect(ok.success).toBe(true)
    for (const bad of ['明天', '2026/10/25', '10-25']) {
      const parsed = taskUpdateInputSchema.safeParse({
        status: 'completed',
        report: { result: '答案', todos: [{ title: 'x', dueDate: bad }] },
      })
      expect(parsed.success).toBe(false)
    }
  })

  it('priority 默认 P3；可指定 P0~P3；todoUpdates 可调整 priority', () => {
    const parsed = taskUpdateInputSchema.parse({
      status: 'completed',
      report: { result: '答案', todos: [{ title: '默认' }, { title: '加急', priority: 'P0' }] },
      todoUpdates: [{ id: 'todo_1', priority: 'P1' }],
    })
    expect(parsed.report?.todos?.[0]?.priority).toBe('P3')
    expect(parsed.report?.todos?.[1]?.priority).toBe('P0')
    expect(parsed.todoUpdates?.[0]?.priority).toBe('P1')
    expect(taskUpdateInputSchema.safeParse({
      status: 'completed',
      report: { result: '答案', todos: [{ title: 'x', priority: 'P9' }] },
    }).success).toBe(false)
  })

  it('todoUpdates 允许 running/input_required/completed，禁止 failed/blocked', () => {
    const updates = [{ id: 'todo_1', status: 'done' }, { id: 'todo_2', title: '改标题', detail: 'd', dueDate: '2026-11-01' }]
    expect(taskUpdateInputSchema.safeParse({ status: 'running', todoUpdates: updates }).success).toBe(true)
    expect(taskUpdateInputSchema.safeParse({ status: 'input_required', question: 'q', todoUpdates: updates }).success).toBe(true)
    expect(taskUpdateInputSchema.safeParse({ status: 'completed', report: { result: 'r' }, todoUpdates: updates }).success).toBe(true)
    expect(taskUpdateInputSchema.safeParse({ status: 'failed', error: 'e', todoUpdates: updates }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ status: 'blocked', error: 'e', todoUpdates: updates }).success).toBe(false)
  })

  it('待办状态支持 cancelled（Worker 作废旧待办）', () => {
    const parsed = taskUpdateInputSchema.safeParse({
      status: 'completed',
      report: { result: 'r' },
      todoUpdates: [{ id: 'todo_1', status: 'cancelled' }],
    })
    expect(parsed.success).toBe(true)
    const todo = userTodoSchema.parse({
      id: 'todo_1', title: 'x', status: 'cancelled', completedBy: 'worker',
      createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
    })
    expect(todo.status).toBe('cancelled')
  })

  it('旧会话记录无 todos 字段时默认空清单', () => {
    const conv = createConversation({ id: 'c1', childSessionId: 's1', parentSessionId: 'p1', title: 't' })
    const { todos, ...legacy } = conv
    const parsed = conversationSchema.parse(legacy)
    expect(parsed.todos).toEqual([])
  })
})

describe('旧版本存储记录迁移', () => {
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

  it('≤0.3.10 的 userAnswer/resultSummary 迁移为 report.result', () => {
    const task = taskSchema.parse({ ...baseTask, status: 'completed', userAnswer: '旧答案', resultSummary: '旧摘要' })
    expect(task.report?.result).toBe('旧答案')
    expect('userAnswer' in task).toBe(false)
    expect('resultSummary' in task).toBe(false)
    const onlySummary = taskSchema.parse({ ...baseTask, status: 'completed', resultSummary: '旧摘要' })
    expect(onlySummary.report?.result).toBe('旧摘要')
  })

  it('≤0.3.10 的 outlinePatch 剥离、cancelled 并入 interrupted', () => {
    const task = taskSchema.parse({ ...baseTask, status: 'cancelled', outlinePatch: { tags: ['t'] } })
    expect(task.status).toBe('interrupted')
    expect('outlinePatch' in task).toBe(false)
  })

  it('已有 report 的记录不被 userAnswer 覆盖', () => {
    const task = taskSchema.parse({
      ...baseTask, status: 'completed',
      report: { result: '新结果' }, userAnswer: '旧答案',
    })
    expect(task.report?.result).toBe('新结果')
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
