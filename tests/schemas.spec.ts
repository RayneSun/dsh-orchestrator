import { describe, expect, it } from 'vitest'
import {
  conversationSchema,
  normalizeTimePoint,
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

  it('completed/failed/input_required 的必填字段符合各自语义', () => {
    expect(taskUpdateInputSchema.safeParse({ status: 'completed' }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ status: 'failed' }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ status: 'input_required' }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({
      status: 'input_required', progressNote: '等待用户选择城市',
    }).success).toBe(false)
    const parsed = taskUpdateInputSchema.parse({
      status: 'input_required',
      questions: [{ question: '要蓝色还是红色？' }],
    })
    expect(parsed.questions?.[0]?.question).toBe('要蓝色还是红色？')
    const failed = taskUpdateInputSchema.parse({
      status: 'failed',
      fail: { error: '没有浏览器控制权限', reasonCode: 'permission_denied' },
    })
    expect(failed.fail?.reasonCode).toBe('permission_denied')
    expect(taskUpdateInputSchema.safeParse({ status: 'failed', fail: { error: 'x', reasonCode: 'unknown' } }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({
      status: 'input_required',
      questions: [{ question: '请授权浏览器？' }],
      fail: { error: '权限不足' },
    }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ status: 'running', fail: { error: '意外错误' } }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({
      status: 'running',
      questions: [{ question: '需要选择吗？' }],
    }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({
      status: 'completed', report: { result: '完成' }, fail: { error: '旧错误' },
    }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ status: 'failed', fail: { error: '失败' }, report: { result: 'r' } }).success).toBe(false)
    expect(taskUpdateInputSchema.parse({
      status: 'failed', fail: { error: '缺少依赖' }, progressNote: '已定位到 bsk 缺失',
    }).status).toBe('failed')
  })

  it('completed 要求 report.result；artifacts 只允许相对路径', () => {
    expect(taskUpdateInputSchema.safeParse({ status: 'completed' }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({
      status: 'completed', report: { result: '  ' },
    }).success).toBe(false)
    const parsed = taskUpdateInputSchema.parse({
      status: 'completed',
      report: { result: '完成', artifacts: ['out/index.html', 'docs/summary.md'] },
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
    expect(taskUpdateInputSchema.safeParse({ status: 'running', summary: '旧版本 summary 字段' }).success).toBe(false)
  })

})

describe('task_update 日程与标题协议', () => {
  it('header 全状态可选，最多 8 个字；超长拒绝', () => {
    for (const status of ['running', 'input_required', 'completed', 'failed'] as const) {
      const base: Record<string, unknown> = { status, header: '已查到 3 家' }
      if (status === 'completed') base.report = { result: '答案' }
      if (status === 'failed') base.fail = { error: '原因' }
      if (status === 'input_required') base.questions = [{ question: '问题' }]
      const ok = taskUpdateInputSchema.safeParse(base)
      expect(ok.success).toBe(true)
      const tooLong = taskUpdateInputSchema.safeParse({ ...base, header: 'x'.repeat(9) })
      expect(tooLong.success).toBe(false)
    }
  })

  it('schedules.create 新建：title 静态必填、priority 默认 P3、结构上无 id/status', () => {
    const parsed = taskUpdateInputSchema.parse({
      status: 'completed',
      report: { result: '答案' },
      schedules: {
        create: [
          { title: '默认' },
          { title: '加急', priority: 'P0', startAt: '2026-10-28T09:00:00+08:00', endAt: '2026-10-30T18:00:00+08:00', remindAt: '2026-10-29T09:00:00+08:00',
            links: [{ url: 'https://example.com', label: '订票页' }],
            attachments: [{ path: 'shots/a.png' }],
            contacts: [{ name: '前台', phone: '010-12345678' }],
            location: { name: '安贞医院', address: '朝阳区安贞路2号' } },
        ],
      },
    })
    expect(parsed.schedules?.create?.[0]).toMatchObject({ title: '默认', priority: 'P3' })
    expect(parsed.schedules?.create?.[1]).toMatchObject({ title: '加急', priority: 'P0', startAt: '2026-10-28T09:00:00+08:00', endAt: '2026-10-30T18:00:00+08:00' })
    // create 条目结构上接触不到 id/status（strict 拒绝）
    expect(taskUpdateInputSchema.safeParse({ status: 'running', schedules: { create: [{ title: 'x', id: 'todo_1' }] } }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ status: 'running', schedules: { create: [{ title: 'x', status: 'done' }] } }).success).toBe(false)
    // create 缺 title
    expect(taskUpdateInputSchema.safeParse({ status: 'running', schedules: { create: [{}] } }).success).toBe(false)
  })

  it('schedules.update 更新：id 静态必填，可改 status/title/priority 等', () => {
    const parsed = taskUpdateInputSchema.parse({
      status: 'completed',
      report: { result: 'r' },
      schedules: { update: [{ id: 'todo_1', status: 'done' }, { id: 'todo_2', status: 'cancelled' }, { id: 'todo_3', title: '改标题', priority: 'P1' }] },
    })
    expect(parsed.schedules?.update?.[0]).toMatchObject({ id: 'todo_1', status: 'done' })
    expect(taskUpdateInputSchema.safeParse({ status: 'running', schedules: { update: [{ status: 'done' }] } }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ status: 'running', schedules: { update: [{ id: 'todo_1', priority: 'P9' }] } }).success).toBe(false)
  })

  it('schedules 输入边界：时间简写合法、自然语言与不存在日期拒绝、链接必须 http(s)、附件禁绝对路径与 ..', () => {
    const base = { status: 'running' as const }
    for (const bad of ['明天', '下周三', '2026/10/25', '2026-13-01', '2026-02-30', '18:00', '']) {
      expect(taskUpdateInputSchema.safeParse({ ...base, schedules: { create: [{ title: 'x', endAt: bad }] } }).success).toBe(false)
    }
    for (const good of ['10-25', '10-25 18:00', '2026-10-25', '2026-10-25T09:00', '2026-10-25T09:00:00+08:00']) {
      expect(taskUpdateInputSchema.safeParse({ ...base, schedules: { create: [{ title: 'x', endAt: good }] } }).success).toBe(true)
    }
    expect(taskUpdateInputSchema.safeParse({ ...base, schedules: { create: [{ title: 'x', links: [{ url: 'ftp://a' }] }] } }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ ...base, schedules: { create: [{ title: 'x', attachments: [{ path: '/etc/passwd' }] }] } }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ ...base, schedules: { create: [{ title: 'x', attachments: [{ path: '../a' }] }] } }).success).toBe(false)
  })

  it('schedules 所有 task_update 状态都允许更新日程', () => {
    const payload = { update: [{ id: 'todo_1', status: 'done' }] }
    expect(taskUpdateInputSchema.safeParse({ status: 'running', schedules: payload }).success).toBe(true)
    expect(taskUpdateInputSchema.safeParse({ status: 'input_required', questions: [{ question: 'q' }], schedules: payload }).success).toBe(true)
    expect(taskUpdateInputSchema.safeParse({ status: 'completed', report: { result: 'r' }, schedules: payload }).success).toBe(true)
    expect(taskUpdateInputSchema.safeParse({ status: 'failed', fail: { error: 'e' }, schedules: payload }).success).toBe(true)
  })

  it('日程状态支持 cancelled（Worker 作废旧日程）', () => {
    const parsed = taskUpdateInputSchema.safeParse({
      status: 'completed',
      report: { result: 'r' },
      schedules: { update: [{ id: 'todo_1', status: 'cancelled' }] },
    })
    expect(parsed.success).toBe(true)
    const todo = userTodoSchema.parse({
      id: 'todo_1', title: 'x', status: 'cancelled', completedBy: 'worker',
      createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
    })
    expect(todo.status).toBe('cancelled')
    expect(todo.links).toEqual([])
  })

  it('时间归一化：简写补本地时区、省略年份取最近未来、完整 ISO 原样保留', () => {
    const localIso = (d: Date) => {
      const pad = (n: number) => String(n).padStart(2, '0')
      const offset = -d.getTimezoneOffset()
      const sign = offset >= 0 ? '+' : '-'
      const abs = Math.abs(offset)
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
    }
    expect(normalizeTimePoint('2026-10-28 18:00')).toBe(localIso(new Date(2026, 9, 28, 18, 0, 0)))
    expect(normalizeTimePoint('2026-10-28T18:00')).toBe(localIso(new Date(2026, 9, 28, 18, 0, 0)))
    expect(normalizeTimePoint('2026-10-28')).toBe(localIso(new Date(2026, 9, 28, 0, 0, 0)))
    // 完整 ISO（带偏移）→ 转本地表示
    expect(normalizeTimePoint('2026-10-28T18:00:00+08:00')).toBe(localIso(new Date('2026-10-28T18:00:00+08:00')))
    // 省略年份：未来日期补今年，已过去的补明年
    const now = new Date()
    const future = new Date(now.getTime() + 30 * 24 * 3600 * 1000)
    const past = new Date(now.getTime() - 30 * 24 * 3600 * 1000)
    const pad = (n: number) => String(n).padStart(2, '0')
    const futureShort = `${pad(future.getMonth() + 1)}-${pad(future.getDate())} 18:00`
    const pastShort = `${pad(past.getMonth() + 1)}-${pad(past.getDate())} 18:00`
    expect(normalizeTimePoint(futureShort)).toBe(localIso(new Date(future.getFullYear(), future.getMonth(), future.getDate(), 18, 0, 0)))
    expect(normalizeTimePoint(pastShort)).toBe(localIso(new Date(past.getFullYear() + 1, past.getMonth(), past.getDate(), 18, 0, 0)))
    // 非法
    for (const bad of ['明天', '2026-13-01', '2026-02-30', 'abc']) {
      expect(normalizeTimePoint(bad)).toBeUndefined()
    }
  })

  it('时间窗顺序：startAt 晚于 endAt 拒绝（create 与 update 同规则）', () => {
    const base = { status: 'running' as const }
    expect(taskUpdateInputSchema.safeParse({ ...base, schedules: { create: [{ title: 'x', startAt: '2026-10-30T00:00:00+08:00', endAt: '2026-10-28T00:00:00+08:00' }] } }).success).toBe(false)
    expect(taskUpdateInputSchema.safeParse({ ...base, schedules: { update: [{ id: 'todo_1', startAt: '2026-10-30T00:00:00+08:00', endAt: '2026-10-28T00:00:00+08:00' }] } }).success).toBe(false)
    // 单边更新不在输入层校验（与存量合并后由 Host 兜底）
    expect(taskUpdateInputSchema.safeParse({ ...base, schedules: { update: [{ id: 'todo_1', endAt: '2026-10-28T00:00:00+08:00' }] } }).success).toBe(true)
    // 相等合法（单时间点事项）
    expect(taskUpdateInputSchema.safeParse({ ...base, schedules: { create: [{ title: 'x', startAt: '2026-10-28T09:00:00+08:00', endAt: '2026-10-28T09:00:00+08:00' }] } }).success).toBe(true)
  })

  it('旧日程迁移：dueDate(YYYY-MM-DD) → endAt（当日 23:59 本地转 ISO）', () => {
    const todo = userTodoSchema.parse({
      id: 'todo_1', title: 'x', status: 'pending', dueDate: '2026-10-30',
      createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
    })
    expect(todo.endAt).toBe(new Date('2026-10-30T23:59:59').toISOString())
    expect((todo as Record<string, unknown>).dueDate).toBeUndefined()
    // 新数据不带 dueDate 时不受影响
    const fresh = userTodoSchema.parse({
      id: 'todo_2', title: 'y', status: 'pending', endAt: '2026-11-01T18:00:00+08:00',
      createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
    })
    expect(fresh.endAt).toBe('2026-11-01T18:00:00+08:00')
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

  it('blocked 提问迁移为 input_required，blockedQuestion 迁移为 questions', () => {
    const task = taskSchema.parse({ ...baseTask, status: 'blocked', blockedQuestion: '选哪个？', scene: 'code' })
    expect(task.status).toBe('input_required')
    expect(task.questions).toEqual([{ id: 'q1', question: '选哪个？' }])
    expect('blockedQuestion' in task).toBe(false)
    expect('scene' in task).toBe(false)
    expect('responseMode' in task).toBe(false)
  })

  it('0.3.12 任务 report.todos 冗余回显剥离（数据已在 conv.todos）', () => {
    const task = taskSchema.parse({
      ...baseTask, status: 'completed',
      report: { result: 'r', todos: [{ title: 'x' }] },
    })
    expect(task.report?.result).toBe('r')
    expect(task.report && 'todos' in task.report).toBe(false)
  })

  it('0.3.12 日程的 completedAt 死字段剥离', () => {
    const conv = conversationSchema.parse({
      ...baseConv,
      todos: [{
        id: 'todo_1', title: 'x', status: 'done', priority: 'P3',
        createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
        completedAt: '2026-10-23T01:00:00Z',
      }],
    })
    expect(conv.todos[0]?.status).toBe('done')
    expect(conv.todos[0] && 'completedAt' in conv.todos[0]).toBe(false)
  })

  it('0.3.12 日程 detail 迁移为 remark', () => {
    const conv = conversationSchema.parse({
      ...baseConv,
      todos: [{
        id: 'todo_1', title: 'x', detail: '旧备注', status: 'pending', priority: 'P3',
        createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
      }],
    })
    expect(conv.todos[0]?.remark).toBe('旧备注')
    expect(conv.todos[0] && 'detail' in conv.todos[0]).toBe(false)
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

  it('0.3.13 的系统阻碍 blocked 记录迁移为 failed + fail.reasonCode', () => {
    const task = taskSchema.parse({
      ...baseTask,
      status: 'blocked',
      error: '缺少 bsk CLI',
      reasonCode: 'dependency',
      remediation: '请安装 bsk 后继续',
    })
    expect(task.status).toBe('failed')
    expect(task.fail?.error).toContain('缺少 bsk CLI')
    expect(task.fail?.error).toContain('建议：请安装 bsk 后继续')
    expect(task.fail?.reasonCode).toBe('dependency')
  })
})
