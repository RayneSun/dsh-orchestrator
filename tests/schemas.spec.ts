import { describe, expect, it } from 'vitest'
import {
  conversationSchema,
  normalizeTimePoint,
  createConversation,
  createTask,
  conversationIdInputSchema,
  dispatchInputSchema,
  taskSchema,
  snapshotResultSchema,
  taskCompletedInputSchema,
  taskFailedInputSchema,
  taskInputRequiredInputSchema,
  taskRunningInputSchema,
  taskScheduleInputSchema,
  scheduleConsistencyError,
  scheduleObjectSchema,
} from '../src/types.ts'

describe('工具输入 Zod 校验', () => {
  it('旧 Task 缺少 scheduleIds 时按空关联读取，snapshot 接受 Task 活动时钟投影', () => {
    const task = createTask({
      id: 'task', parentSessionId: 'parent', conversationId: 'conv', predecessorTaskId: null,
      subject: '旧任务', prompt: '执行',
    })
    const { scheduleIds: _scheduleIds, ...legacy } = task
    expect(taskSchema.parse(legacy).scheduleIds).toEqual([])
    const snapshot = snapshotResultSchema.parse({
      conversations: [], schedules: [], tasks: [{ ...task, hasActiveSchedule: true }],
    })
    expect(snapshot.tasks[0].hasActiveSchedule).toBe(true)
  })

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

  it('task_completed 必填 result，artifacts 只允许相对路径', () => {
    expect(taskCompletedInputSchema.safeParse({}).success).toBe(false)
    expect(taskCompletedInputSchema.safeParse({ result: '  ' }).success).toBe(false)
    const parsed = taskCompletedInputSchema.parse({
      result: '完成', artifacts: ['out/index.html', 'docs/summary.md'],
    })
    expect(parsed.artifacts).toEqual(['out/index.html', 'docs/summary.md'])
    for (const bad of ['/abs/path.html', '../escape.html', 'a/../../b', '']) {
      expect(taskCompletedInputSchema.safeParse({ result: 'r', artifacts: [bad] }).success).toBe(false)
    }
  })

  it('task_failed 必填 error，reasonCode 只接受枚举值', () => {
    expect(taskFailedInputSchema.safeParse({}).success).toBe(false)
    const parsed = taskFailedInputSchema.parse({
      error: '没有浏览器控制权限', reasonCode: 'permission_denied',
    })
    expect(parsed.reasonCode).toBe('permission_denied')
    expect(taskFailedInputSchema.safeParse({ error: 'x', reasonCode: 'unknown' }).success).toBe(false)
  })

  it('task_input_required 必填 questions', () => {
    expect(taskInputRequiredInputSchema.safeParse({}).success).toBe(false)
    expect(taskInputRequiredInputSchema.safeParse({ progressNote: '等待用户选择城市' }).success).toBe(false)
    const parsed = taskInputRequiredInputSchema.parse({ questions: [{ question: '要蓝色还是红色？' }] })
    expect(parsed.questions[0]?.question).toBe('要蓝色还是红色？')
  })

  it('task_running 只接受 header/progressNote；各状态工具互不收对方字段', () => {
    expect(taskRunningInputSchema.safeParse({ header: '推进中', progressNote: '抓取到一半' }).success).toBe(true)
    expect(taskRunningInputSchema.safeParse({ result: 'x' }).success).toBe(false)
    expect(taskRunningInputSchema.safeParse({ fail: { error: 'x' } }).success).toBe(false)
    expect(taskRunningInputSchema.safeParse({ schedules: { create: [{ title: 'x' }] } }).success).toBe(false)
    expect(taskCompletedInputSchema.safeParse({ result: 'r', questions: [{ question: 'q' }] }).success).toBe(false)
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
    expect(conversationSchema.safeParse({ ...conv, hasActiveSchedule: true }).success).toBe(false)
    const snapshot = snapshotResultSchema.parse({ conversations: [{ ...conv, hasActiveSchedule: true }], tasks: [], schedules: [] })
    expect(snapshot.conversations[0].hasActiveSchedule).toBe(true)
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
    expect(taskRunningInputSchema.safeParse({ outlinePatch: { tags: ['t'] } }).success).toBe(false)
    expect(taskRunningInputSchema.safeParse({ summary: '旧版本 summary 字段' }).success).toBe(false)
  })

})

describe('task_* header 与 task_schedule 协议', () => {
  it('header 可选，最多 8 个字；超长拒绝', () => {
    for (const schema of [taskRunningInputSchema, taskCompletedInputSchema, taskFailedInputSchema, taskInputRequiredInputSchema] as const) {
      const base = schema === taskCompletedInputSchema ? { result: '答案' }
        : schema === taskFailedInputSchema ? { error: 'e' }
        : schema === taskInputRequiredInputSchema ? { questions: [{ question: 'q' }] }
        : {}
      const ok = schema.safeParse(base)
      expect(ok.success).toBe(true)
      const tooLong = schema.safeParse({ ...base, header: 'x'.repeat(9) })
      expect(tooLong.success).toBe(false)
    }
  })

  it('schedules.create 新建：title 静态必填、priority 默认 P3、结构上无 id/status', () => {
    const parsed = taskScheduleInputSchema.parse({
      create: [
        { title: '默认' },
        { title: '加急', priority: 'P0', startAt: '2026-10-28T09:00:00+08:00', endAt: '2026-10-30T18:00:00+08:00', remindAt: '2026-10-29T09:00:00+08:00',
          links: [{ url: 'https://example.com', label: '订票页' }],
          attachments: [{ path: 'shots/a.png' }],
          contacts: [{ name: '前台', phone: '010-12345678' }],
          location: { name: '安贞医院', address: '朝阳区安贞路2号' } },
      ],
    })
    expect(parsed.create?.[0]).toMatchObject({ title: '默认', priority: 'P3' })
    expect(parsed.create?.[1]).toMatchObject({ title: '加急', priority: 'P0', startAt: '2026-10-28T09:00:00+08:00', endAt: '2026-10-30T18:00:00+08:00' })
    // create 条目结构上接触不到 id/status（strict 拒绝）
    expect(taskScheduleInputSchema.safeParse({ create: [{ title: 'x', id: 'todo_1' }] }).success).toBe(false)
    expect(taskScheduleInputSchema.safeParse({ create: [{ title: 'x', status: 'done' }] }).success).toBe(false)
    // create 缺 title
    expect(taskScheduleInputSchema.safeParse({ create: [{}] }).success).toBe(false)
  })

  it('schedules.update 更新：id 静态必填，可改 status/title/priority 等', () => {
    const parsed = taskScheduleInputSchema.parse({
      update: [{ id: 'todo_1', status: 'done' }, { id: 'todo_2', status: 'cancelled' }, { id: 'todo_3', title: '改标题', priority: 'P1' }],
    })
    expect(parsed.update?.[0]).toMatchObject({ id: 'todo_1', status: 'done' })
    expect(taskScheduleInputSchema.safeParse({ update: [{ status: 'done' }] }).success).toBe(false)
    expect(taskScheduleInputSchema.safeParse({ update: [{ id: 'todo_1', priority: 'P9' }] }).success).toBe(false)
  })

  it('schedules 输入边界：时间简写合法、自然语言与不存在日期拒绝、链接必须 http(s)、附件禁绝对路径与 ..', () => {
    for (const bad of ['明天', '下周三', '2026/10/25', '2026-13-01', '2026-02-30', '18:00', '']) {
      expect(taskScheduleInputSchema.safeParse({ create: [{ title: 'x', endAt: bad }] }).success).toBe(false)
    }
    for (const good of ['10-25 18:00', '2026-10-25T09:00', '2026-10-25T09:00:00+08:00']) {
      expect(taskScheduleInputSchema.safeParse({ create: [{ title: 'x', endAt: good }] }).success).toBe(true)
    }
    // 纯日期属于全天日程：allDay 缺省时拒绝（强制模型表态，不再猜午夜）
    for (const dateOnly of ['10-25', '2026-10-25']) {
      expect(taskScheduleInputSchema.safeParse({ create: [{ title: 'x', endAt: dateOnly }] }).success).toBe(false)
    }
    expect(taskScheduleInputSchema.safeParse({ create: [{ title: 'x', links: [{ url: 'ftp://a' }] }] }).success).toBe(false)
    expect(taskScheduleInputSchema.safeParse({ create: [{ title: 'x', attachments: [{ path: '/etc/passwd' }] }] }).success).toBe(false)
    expect(taskScheduleInputSchema.safeParse({ create: [{ title: 'x', attachments: [{ path: '../a' }] }] }).success).toBe(false)
  })

  it('task_schedule 独立承载日程：状态上报工具不再携带 schedules', () => {
    const payload = { update: [{ id: 'todo_1', status: 'done' }] }
    expect(taskScheduleInputSchema.safeParse(payload).success).toBe(true)
    expect(taskRunningInputSchema.safeParse(payload).success).toBe(false)
    expect(taskCompletedInputSchema.safeParse({ result: 'r', schedules: payload }).success).toBe(false)
    expect(taskFailedInputSchema.safeParse({ error: 'e', schedules: payload }).success).toBe(false)
  })

  it('日程状态支持 cancelled（Worker 作废旧日程）', () => {
    const parsed = taskScheduleInputSchema.safeParse({ update: [{ id: 'todo_1', status: 'cancelled' }] })
    expect(parsed.success).toBe(true)
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
    expect(taskScheduleInputSchema.safeParse({ create: [{ title: 'x', startAt: '2026-10-30T00:00:00+08:00', endAt: '2026-10-28T00:00:00+08:00' }] }).success).toBe(false)
    expect(taskScheduleInputSchema.safeParse({ update: [{ id: 'todo_1', startAt: '2026-10-30T00:00:00+08:00', endAt: '2026-10-28T00:00:00+08:00' }] }).success).toBe(false)
    // 单边更新不在输入层校验（与存量合并后由 Host 兜底）
    expect(taskScheduleInputSchema.safeParse({ update: [{ id: 'todo_1', endAt: '2026-10-28T00:00:00+08:00' }] }).success).toBe(true)
    // 相等合法（单时间点事项）
    expect(taskScheduleInputSchema.safeParse({ create: [{ title: 'x', startAt: '2026-10-28T09:00:00+08:00', endAt: '2026-10-28T09:00:00+08:00' }] }).success).toBe(true)
  })

  it('schedules 全天日程：allDay 纯日期契约（新建必填 startAt、update 原子切换）', () => {
    // 新建：allDay=true 必填完整纯日期 startAt；endAt 尾日包含、>= startAt
    const parsed = taskScheduleInputSchema.parse({ create: [{ title: '假期', allDay: true, startAt: '2026-11-04', endAt: '2026-11-06' }] })
    expect(parsed.create?.[0]).toMatchObject({ allDay: true, startAt: '2026-11-04', endAt: '2026-11-06' })
    // 单日全天可省略 endAt；缺省 allDay 落 false
    const single = taskScheduleInputSchema.parse({ create: [{ title: 'x', allDay: true, startAt: '2026-11-04' }] })
    expect(single.create?.[0]).toMatchObject({ allDay: true, startAt: '2026-11-04' })
    expect(taskScheduleInputSchema.parse({ create: [{ title: 'x' }] }).create?.[0]).toMatchObject({ allDay: false })
    // allDay=true 但缺 startAt / 带时刻 / 不完整日期 / 倒置 → 拒绝
    expect(taskScheduleInputSchema.safeParse({ create: [{ title: 'x', allDay: true }] }).success).toBe(false)
    expect(taskScheduleInputSchema.safeParse({ create: [{ title: 'x', allDay: true, startAt: '2026-11-04 09:00' }] }).success).toBe(false)
    expect(taskScheduleInputSchema.safeParse({ create: [{ title: 'x', allDay: true, startAt: '2026-11-4' }] }).success).toBe(false)
    expect(taskScheduleInputSchema.safeParse({ create: [{ title: 'x', allDay: true, startAt: '2026-11-06', endAt: '2026-11-04' }] }).success).toBe(false)
    // allDay 缺省或显式 false：纯日期拒绝
    expect(taskScheduleInputSchema.safeParse({ create: [{ title: 'x', startAt: '2026-11-04' }] }).success).toBe(false)
    expect(taskScheduleInputSchema.safeParse({ create: [{ title: 'x', allDay: false, startAt: '2026-11-04' }] }).success).toBe(false)
    // update：只改 allDay 不带 startAt → 拒绝（原子切换）
    expect(taskScheduleInputSchema.safeParse({ update: [{ id: 'a', allDay: true }] }).success).toBe(false)
    expect(taskScheduleInputSchema.safeParse({ update: [{ id: 'a', allDay: false }] }).success).toBe(false)
    // update：allDay:true + 纯日期 startAt → 通过；allDay 缺省 + 纯日期 → 拒绝
    expect(taskScheduleInputSchema.safeParse({ update: [{ id: 'a', allDay: true, startAt: '2026-11-04' }] }).success).toBe(true)
    expect(taskScheduleInputSchema.safeParse({ update: [{ id: 'a', startAt: '2026-11-04' }] }).success).toBe(false)
    // update：只改标题不碰时间 → patch 不携带 allDay/时间字段（避免合并覆盖旧值）
    const titleOnly = taskScheduleInputSchema.parse({ update: [{ id: 'a', title: '新标题' }] })
    expect(titleOnly.update?.[0]).toEqual({ id: 'a', title: '新标题' })
  })

  it('scheduleConsistencyError：allDay 与时间格式互洽（service 合并后兜底）', () => {
    expect(scheduleConsistencyError({ allDay: true, startAt: '2026-11-04', endAt: '2026-11-06' })).toBeUndefined()
    expect(scheduleConsistencyError({ allDay: false, startAt: '2026-10-28T09:00:00+08:00', endAt: '2026-10-30T18:00:00+08:00' })).toBeUndefined()
    // allDay=true 但 startAt 带时刻（update 只带时间戳、allDay 沿用 true 的残留场景）
    expect(scheduleConsistencyError({ allDay: true, startAt: '2026-11-04T09:00:00+08:00' })).toBeTruthy()
    expect(scheduleConsistencyError({ allDay: true, startAt: '2026-11-04', endAt: '2026-11-04T18:00:00+08:00' })).toBeTruthy()
    expect(scheduleConsistencyError({ allDay: true, startAt: '2026-11-06', endAt: '2026-11-04' })).toBeTruthy()
    // allDay 缺省按有时刻语义：纯日期 / 倒置拒绝
    expect(scheduleConsistencyError({ startAt: '2026-11-04' })).toBeTruthy()
    expect(scheduleConsistencyError({ startAt: '2026-10-30T00:00:00+08:00', endAt: '2026-10-28T00:00:00+08:00' })).toBeTruthy()
    expect(scheduleConsistencyError({})).toBeUndefined()
  })

  it('scheduleObjectSchema：allDay 缺省 false，旧记录免迁移', () => {
    const record = scheduleObjectSchema.parse({
      id: 'sch_1', parentSessionId: 's1', conversationId: 'c1', title: '旧日程',
      startAt: '2026-10-28T09:00:00+08:00', priority: 'P3', status: 'pending',
      links: [], attachments: [], contacts: [], createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
    })
    expect(record.allDay).toBe(false)
    const allDay = scheduleObjectSchema.parse({
      id: 'sch_2', parentSessionId: 's1', conversationId: 'c1', title: '假期', allDay: true,
      startAt: '2026-11-04', endAt: '2026-11-06', priority: 'P3', status: 'pending',
      links: [], attachments: [], contacts: [], createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
    })
    expect(allDay.allDay).toBe(true)
    expect(allDay.startAt).toBe('2026-11-04')
  })

})

describe('拍平存储契约', () => {
  const task = {
    id: 't', parentSessionId: 'p', conversationId: 'c', subject: 's', prompt: 'p',
    status: 'completed', result: '新结果', createdAt: '2026-11-09T00:00:00Z', updatedAt: '2026-11-09T00:00:00Z',
  }

  it('snapshot 保留顶层结果与 card，拒绝旧包裹而不是静默丢弃内容', () => {
    const card = { type: 'stat', value: 1 }
    expect(taskSchema.parse({ ...task, card })).toMatchObject({ result: '新结果', card })
    expect(taskSchema.safeParse({ ...task, report: { result: '旧结果' } }).success).toBe(false)
    expect(taskSchema.safeParse({ ...task, fail: { error: '旧错误' } }).success).toBe(false)
  })

  it('会话仅接受当前字段，不再迁移历史 todos 与大纲死字段', () => {
    const conv = {
      id: 'c', childSessionId: 's', parentSessionId: 'p', title: 't', outline: { summary: '' },
      createdAt: task.createdAt, updatedAt: task.updatedAt,
    }
    expect(conversationSchema.safeParse(conv).success).toBe(true)
    expect(conversationSchema.safeParse({ ...conv, todos: [] }).success).toBe(false)
    expect(conversationSchema.safeParse({ ...conv, outline: { summary: '', tags: [] } }).success).toBe(false)
  })
})
