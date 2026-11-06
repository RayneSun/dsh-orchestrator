import { z } from 'zod'
import { normalizeTimePoint, resolveScheduleTimes } from './schedule-time.ts'
export { normalizeTimePoint, normalizeDateOnly, isDateOnly, resolveScheduleTimes, scheduleConsistencyError } from './schedule-time.ts'

const conversationStates = ['provisioning', 'running', 'idle', 'input_required', 'failed'] as const
const taskStatuses = ['queued', 'running', 'input_required', 'completed', 'failed', 'interrupted'] as const
export const activeTaskStatuses = ['queued', 'running'] as const
/** 单条 TaskRun 的历史终态集合；input_required 的工具调用仍阻塞，作答后继续同一 TaskRun。 */
export const terminalTaskStatuses = ['input_required', 'completed', 'failed', 'interrupted'] as const
/** 允许向主会话投递通知的终态。 */
// interrupted 是否投递取决于产生路径：改单/重启不投递，手动停止才投递通知。
// 因此该表只表示"允许带 delivery"，pending 由具体路径挂起；
// 最终是否真正投递还受设置页投递开关（DeliveryToggles）与 silent 约束。
export const deliverableTaskStatuses = ['input_required', 'completed', 'failed', 'interrupted'] as const

/** 设置页的终态投递开关（volatile，即时生效）：关闭的状态只更新状态，不向主会话投递消息。 */
export interface DeliveryToggles {
  inputRequired: boolean
  completed: boolean
  failed: boolean
  interrupted: boolean
}

/** Host 固定 inputRequired=false：问题卡由看板与 Worker 原生问题卡承载。 */
export const defaultDeliveryToggles: DeliveryToggles = {
  inputRequired: false,
  completed: true,
  failed: true,
  interrupted: true,
}
export const blockReasonCodes = ['permission_denied', 'configuration', 'dependency', 'network', 'resource', 'runtime'] as const

const trimmed = z.string().trim().min(1)

export const taskUpdateStatuses = ['running', 'input_required', 'completed', 'failed'] as const

export const taskUpdateFieldAllowList: Record<(typeof taskUpdateStatuses)[number], readonly string[]> = {
  running: ['header', 'progressNote', 'schedules'],
  input_required: ['header', 'progressNote', 'questions', 'schedules'],
  completed: ['header', 'progressNote', 'report', 'schedules'],
  failed: ['header', 'progressNote', 'fail', 'schedules'],
}

const now = () => new Date().toISOString()

/** 待办时间点：宽松输入（startAt/endAt/remindAt 共用），输出归一化 ISO 8601 带时区。 */
const todoTimeSchema = z.string().trim().transform((value, ctx) => {
  const normalized = normalizeTimePoint(value)
  if (!normalized) {
    ctx.addIssue({ code: 'custom', message: `无效时间 "${value}"，合法格式如 "10-28 18:00" 或 "2026-10-28T18:00"` })
    return z.NEVER
  }
  return normalized
})

/** 相对路径：拒绝绝对路径、盘符与 .. 逃逸（待办附件与 report.artifacts 共用）。 */
const relativePathSchema = z.string().trim().min(1).max(500).refine(
  (value) => {
    if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) return false
    return !value.split(/[\\/]/).includes('..')
  },
  { message: '必须是工作区内的相对路径' },
)

/** 待办优先级：P0 紧急且重要 / P1 重要不紧急 / P2 紧急不重要 / P3 有空再做（默认）。 */
export const todoPriorities = ['P0', 'P1', 'P2', 'P3'] as const
export const todoPrioritySchema = z.enum(todoPriorities)

/** 待办链接：http(s) 网址 + 可选显示名。 */
const todoLinkSchema = z.object({
  url: z.string().trim().max(2_000).regex(/^https?:\/\//, '链接必须是 http(s) 网址'),
  label: trimmed.max(50).optional(),
}).strict()

/** 待办附件：子工作区相对路径 + 可选显示名。 */
const todoAttachmentSchema = z.object({
  path: relativePathSchema,
  name: trimmed.max(100).optional(),
}).strict()

/** 待办联系人：弱结构信息卡（移动端可渲染 tel:/mailto: 动作）。 */
const todoContactSchema = z.object({
  name: trimmed.max(50),
  phone: trimmed.max(50).optional(),
  email: z.string().trim().max(200).optional(),
  note: z.string().trim().max(500).optional(),
}).strict()

/** 待办地点：名称 + 可选地址，不做坐标。 */
const todoLocationSchema = z.object({
  name: trimmed.max(100),
  address: z.string().trim().max(300).optional(),
}).strict()

/** 日程时间原始输入：startAt/endAt 保持 raw，按 allDay 分叉解析（resolveScheduleTimes）。 */
const scheduleTimeFields = {
  allDay: z.boolean().optional(),
  startAt: z.string().max(40).optional(),
  endAt: z.string().max(40).optional(),
  remindAt: todoTimeSchema.optional(),
}

/** 日程结构化内容字段（create/update 共用；时间字段走 scheduleTimeFields 分叉解析）。 */
const todoContentFields = {
  links: z.array(todoLinkSchema).max(10).optional(),
  attachments: z.array(todoAttachmentSchema).max(10).optional(),
  contacts: z.array(todoContactSchema).max(5).optional(),
  location: todoLocationSchema.optional(),
  // 备注放最后：诱导模型优先填结构化字段，remark 只兜底纯文字说明
  remark: z.string().trim().max(2_000).optional(),
}

/** task_update 的 schedules.create 元素：新建日程（title 静态必填，结构上接触不到 id/status）。 */
export const todoCreateSchema = z.object({
  title: trimmed.max(30),
  ...scheduleTimeFields,
  ...todoContentFields,
  priority: todoPrioritySchema.default('P3'),
}).strict().transform((value, ctx) => {
  const times = resolveScheduleTimes(value, ctx)
  if (!times) return z.NEVER
  return { ...value, ...times }
})

/** task_update 的 schedules.update 元素：更新已有日程（id 静态必填，抄自可见清单，禁止编造）。 */
export const todoUpdateEntrySchema = z.object({
  id: trimmed,
  status: z.enum(['pending', 'done', 'cancelled']).optional(),
  title: trimmed.max(30).optional(),
  ...scheduleTimeFields,
  ...todoContentFields,
  priority: todoPrioritySchema.optional(),
}).strict().transform((value, ctx) => {
  const times = resolveScheduleTimes(value, ctx, true)
  if (!times) return z.NEVER
  const { allDay: _allDay, startAt: _startAt, endAt: _endAt, ...rest } = value
  return { ...rest, ...times }
})

/** 持久化的用户日程（v2 独立表）：时间强关联，看板"日程"页按日组织；归属子会话仅作回链。 */
export const scheduleObjectSchema = z.object({
  id: trimmed,
  parentSessionId: trimmed,
  conversationId: trimmed,
  title: trimmed.max(30),
  /** 全天日程：true 时 startAt/endAt 为 YYYY-MM-DD 纯日期（endAt 尾日包含）；缺省按有时刻语义。 */
  allDay: z.boolean().default(false),
  startAt: z.string().optional(),
  endAt: z.string().optional(),
  remindAt: z.string().optional(),
  priority: todoPrioritySchema.default('P3'),
  links: z.array(todoLinkSchema).default([]),
  attachments: z.array(todoAttachmentSchema).default([]),
  contacts: z.array(todoContactSchema).default([]),
  location: todoLocationSchema.optional(),
  remark: z.string().trim().max(2_000).optional(),
  status: z.enum(['pending', 'done', 'cancelled']).default('pending'),
  completedBy: z.enum(['user', 'worker']).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
}).strict()
export type ScheduleRecord = z.infer<typeof scheduleObjectSchema>

export const progressStepSchema = z.object({
  content: z.string().trim().min(1).max(300),
  status: z.enum(['pending', 'in_progress', 'completed']),
}).strict()
export type ProgressStep = z.infer<typeof progressStepSchema>

/** 会话路由卡摘要：最近 dispatch 主题链（Host 维护，最多 5 个）。旧大纲死字段由 migrateRecord 剥离。 */
export const outlineSchema = z.object({
  summary: z.string().default(''),
}).strict()

export const deliverySchema = z.discriminatedUnion('state', [
  z.object({
    state: z.literal('pending'),
    attempts: z.number().int().nonnegative().default(0),
    lastError: z.string().optional(),
  }).strict(),
  z.object({
    state: z.literal('delivered'),
    deliveredAt: z.string(),
    messageId: z.string().min(1),
  }).strict(),
])

/** completed 上报：result 给主会话转述；artifacts 是产物文件；card 是 dsh-ui 展示卡片（仅 completed）。 */
export const reportSchema = z.object({
  result: trimmed.max(50_000),
  artifacts: z.array(relativePathSchema).max(20).optional(),
  card: z.record(z.string(), z.unknown()).optional(),
}).strict()
export type TaskReport = z.infer<typeof reportSchema>

/** 问题选项：与平台 ask_user_question 同构（推荐项放首位，label 后缀 "(Recommended)"）。 */
const questionOptionSchema = z.object({
  label: trimmed.max(100),
  description: trimmed.max(300).optional(),
}).strict()

/** input_required 的结构化问题（Worker 上报输入）：id 可省略，Host 自动补 q1/q2/… 并在返回值回显。 */
export const questionItemInputSchema = z.object({
  id: trimmed.max(40).optional(),
  question: trimmed.max(2_000),
  header: trimmed.max(60).optional(),
  detail: trimmed.max(1_000).optional(),
  options: z.array(questionOptionSchema).max(10).optional(),
  multi_select: z.boolean().optional(),
}).strict()

/** 持久化的问题（id 已由 Host 补齐）。 */
const questionItemObjectSchema = questionItemInputSchema.required({ id: true })
export type QuestionItem = z.infer<typeof questionItemObjectSchema>

/** 看板/主会话原生卡的作答项。 */
export const questionAnswerSchema = z.object({
  id: trimmed,
  selected: z.array(trimmed.max(100)).max(10).default([]),
  custom: trimmed.max(2_000).optional(),
}).strict()
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>

/** failed 上报：error 必填；reasonCode 标记系统阻碍（Lead 可修复后重派），remediation 已废除。 */
export const taskFailSchema = z.object({
  error: trimmed.max(10_000),
  reasonCode: z.enum(blockReasonCodes).optional(),
}).strict()
export type TaskFail = z.infer<typeof taskFailSchema>

const baseConversationSchema = z.object({
  id: trimmed,
  childSessionId: trimmed,
  parentSessionId: trimmed,
  title: trimmed,
  workspaceName: z.string().trim().min(1).max(100).optional(),
  workspaceDir: z.string().trim().min(1).optional(),
  outline: outlineSchema,
  activeTaskId: z.string().nullable().default(null),
  lastTaskId: z.string().nullable().default(null),
  state: z.enum(conversationStates).default('provisioning'),
  revision: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** 仅快照投影使用：子会话绑定了活动定时任务（不落库，由宿主核对 schedule 后填入）。 */
  hasActiveSchedule: z.boolean().optional(),
}).strict()

/** report.card 校验：JSON object、序列化 ≤16KB、禁三反引号（防围栏嵌套）。 */
export function cardValidationError(card: unknown): string | undefined {
  if (card === null || typeof card !== 'object' || Array.isArray(card)) return `card: expected object, received ${Array.isArray(card) ? 'array' : typeof card}`
  const json = JSON.stringify(card)
  if (json.length > 16384) return `card: serialized length ${json.length} exceeds 16384`
  if (json.includes('\`\`\`')) return 'card: content contains fence marker (\`\`\`)'
  return undefined
}

const baseTaskSchema = z.object({
  id: trimmed,
  parentSessionId: trimmed,
  conversationId: trimmed,
  predecessorTaskId: z.string().nullable().default(null),
  subject: trimmed,
  prompt: trimmed,
  acceptanceCriteria: z.string().optional(),
  status: z.enum(taskStatuses).default('queued'),
  /** 极简状态标题（最多 8 个字，手机端/折叠态展示），progressNote 的压缩版。长度只在 task_update 输入边界限制，存储层不加约束（旧记录兼容）。 */
  header: z.string().optional(),
  progressNote: z.string().optional(),
  /** input_required 的结构化问题（id 已由 Host 补齐）。 */
  questions: z.array(questionItemObjectSchema).max(10).optional(),
  /** 看板/主会话卡的作答留痕（Host 路由时写入）。 */
  answers: z.array(questionAnswerSchema).max(10).optional(),
  /** failed 时的失败原因；reasonCode 标记系统阻碍（可修复重派）。 */
  fail: taskFailSchema.optional(),
  cancelledReason: z.string().optional(),
  progressSteps: z.array(progressStepSchema).default([]),
  silent: z.boolean().default(false),
  report: reportSchema.optional(),
  /** 定时触发产生的上报任务（宿主按入站消息来源自动判定，看板定时标识）。 */
  scheduled: z.boolean().optional(),
  delivery: deliverySchema.optional(),
  revision: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
}).strict()

/**
 * 旧存储记录迁移：
 * - 0.2.x：blocked(+scene/blockedQuestion)→input_required，丢弃废弃 scene；0.3.1 的 blocked 无 scene，必须保留。
 * - ≤0.3.10：userAnswer/resultSummary → report.result（内容保留，旧任务的结果在看板和 roster 仍可读）；
 *   outlinePatch 从未写入过，直接剥离；cancelled 状态从未产生过，防御性并入 interrupted。
 * - v2 起 conv.todos 与大纲死字段（keyFacts/entities/tags/artifacts/openQuestions）直接删除，不做数据搬迁。
 */
function migrateRecord(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const record = { ...(raw as Record<string, unknown>) }
  const isTask = typeof record.prompt === 'string'
  const legacyTaskBlocked = record.status === 'blocked'
    && (record.scene !== undefined || record.blockedQuestion !== undefined)
  if (legacyTaskBlocked) record.status = 'input_required'
  if (record.state === 'blocked') record.state = 'input_required'
  delete record.scene
  delete record.responseMode
  if (record.blockedQuestion !== undefined) {
    if (record.question === undefined) record.question = record.blockedQuestion
    delete record.blockedQuestion
  }
  if (record.report === undefined) {
    const legacyResult = record.userAnswer ?? record.resultSummary
    if (typeof legacyResult === 'string' && legacyResult.trim()) record.report = { result: legacyResult }
  }
  // 0.3.17 开发期顶层 card → report.card；当前 report 已存在时原样搬迁。
  if (isTask && record.card !== undefined) {
    const report = record.report
    if (report && typeof report === 'object' && !Array.isArray(report) && 'card' in report === false) {
      record.report = { ...report, card: record.card }
    }
    delete record.card
  }
  delete record.userAnswer
  delete record.resultSummary
  delete record.outlinePatch
  // 0.3.12 的 report.todos 是待办创建请求的冗余回显（数据已落 conv.todos），0.3.13 协议移出 report，剥离。
  if (record.report && typeof record.report === 'object' && 'todos' in record.report) {
    const { todos, ...rest } = record.report as Record<string, unknown>
    record.report = rest
  }
  if (record.status === 'cancelled') record.status = 'interrupted'
  if (isTask) {
    // 0.3.14 协议收缩：blocked 并入 failed（reasonCode 表达系统阻碍）；remediation 并入 error 文本。
    if (record.status === 'blocked') record.status = 'failed'
    if (record.fail === undefined
      && (record.error !== undefined || record.reasonCode !== undefined || record.remediation !== undefined)) {
      const parts = [
        typeof record.error === 'string' && record.error.trim() ? record.error.trim() : undefined,
        typeof record.remediation === 'string' && record.remediation.trim() ? `建议：${record.remediation.trim()}` : undefined,
      ].filter(Boolean)
      const fail: Record<string, unknown> = { error: parts.length > 0 ? parts.join('\n') : '任务失败' }
      if (typeof record.reasonCode === 'string') fail.reasonCode = record.reasonCode
      record.fail = fail
    }
    delete record.error
    delete record.reasonCode
    delete record.remediation
    // title → header；question(字符串) → questions[{id:'q1', question}]
    if (record.header === undefined && typeof record.title === 'string') record.header = record.title
    delete record.title
    if (record.questions === undefined && typeof record.question === 'string') {
      record.questions = [{ id: 'q1', question: record.question }]
    }
    delete record.question
  }
  // v2 起待办/日程独立成表，conv.todos 老字段连同数据一并废弃（用户拍板：旧数据直接删）。
  delete record.todos
  // 大纲只剩 summary（路由卡主题链）；keyFacts/entities/tags/artifacts/openQuestions 从未写入，剥离。
  if (record.outline && typeof record.outline === 'object' && !Array.isArray(record.outline)) {
    const outline = { ...(record.outline as Record<string, unknown>) }
    for (const key of ['keyFacts', 'entities', 'tags', 'artifacts', 'openQuestions']) delete outline[key]
    record.outline = outline
  }
  return record
}

export const conversationSchema = z.preprocess(migrateRecord, baseConversationSchema)
export const taskSchema = z.preprocess(migrateRecord, baseTaskSchema)

export type Outline = z.infer<typeof outlineSchema>
export type ConversationRecord = z.infer<typeof baseConversationSchema>
export type TaskRecord = z.infer<typeof baseTaskSchema>
export type TaskStatus = TaskRecord['status']
export type BlockReasonCode = (typeof blockReasonCodes)[number]

export const snapshotResultSchema = z.object({
  conversations: z.array(conversationSchema),
  tasks: z.array(taskSchema),
  schedules: z.array(scheduleObjectSchema.extend({ conversationTitle: z.string() })),
}).strict()

export type Snapshot = z.infer<typeof snapshotResultSchema>
export type ScheduleSnapshot = Snapshot['schedules'][number]

export function createId(prefix: string): string {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
}

export function timestamp(): string {
  return now()
}

function emptyOutline(): Outline {
  return { summary: '' }
}

export function createConversation(input: {
  id: string
  childSessionId: string
  parentSessionId: string
  title: string
  workspaceName?: string
  workspaceDir?: string
}): ConversationRecord {
  const ts = timestamp()
  return {
    ...input,
    outline: emptyOutline(),
    activeTaskId: null,
    lastTaskId: null,
    state: 'provisioning',
    revision: 0,
    createdAt: ts,
    updatedAt: ts,
  }
}

export function createTask(input: {
  id: string
  parentSessionId: string
  conversationId: string
  predecessorTaskId: string | null
  subject: string
  prompt: string
  acceptanceCriteria?: string
  silent?: boolean
}): TaskRecord {
  const ts = timestamp()
  return {
    id: input.id,
    parentSessionId: input.parentSessionId,
    conversationId: input.conversationId,
    predecessorTaskId: input.predecessorTaskId,
    subject: input.subject,
    prompt: input.prompt,
    ...input.acceptanceCriteria ? { acceptanceCriteria: input.acceptanceCriteria } : {},
    status: 'queued',
    silent: input.silent ?? false,
    progressSteps: [],
    revision: 0,
    createdAt: ts,
    updatedAt: ts,
  }
}

export const conversationIdInputSchema = z.object({
  conversationId: trimmed,
}).strict()


// 子工作区目录名强制英文 slug：中文目录名在 shell/路径拼接场景容易出问题，且跨平台可读性差。
export const workspaceNameSchema = z.string().trim()
  .regex(/^[a-z0-9][a-z0-9-]{0,79}$/, 'workspaceName must be a lowercase slug like daily-news')

export const dispatchInputSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  workspaceName: workspaceNameSchema.optional(),
  prompt: z.string().trim().min(1).max(100_000),
  conversationId: z.string().trim().min(1).optional(),
  acceptanceCriteria: z.string().trim().min(1).max(10_000).optional(),
  silent: z.boolean().optional(),
}).strict().superRefine((value, ctx) => {
  // 新建子会话必须显式给英文目录名；复用已有子会话时沿用原目录，无需传。
  if (!value.conversationId && !value.workspaceName) {
    ctx.addIssue({ code: 'custom', path: ['workspaceName'], message: 'new conversation requires workspaceName (lowercase slug)' })
  }
})

export const taskUpdateInputSchema = z.object({
  status: z.enum(taskUpdateStatuses),
  header: trimmed.max(8).optional(),
  progressNote: trimmed.max(500).optional(),
  report: reportSchema.optional(),
  questions: z.array(questionItemInputSchema).min(1).max(10).optional(),
  fail: taskFailSchema.optional(),
  schedules: z.object({
    create: z.array(todoCreateSchema).max(50).optional(),
    update: z.array(todoUpdateEntrySchema).max(50).optional(),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'completed' && !value.report) {
    ctx.addIssue({ code: 'custom', path: ['report'], message: 'completed task_update requires report' })
  }
  if (value.status === 'failed' && !value.fail?.error?.trim()) {
    ctx.addIssue({ code: 'custom', path: ['fail'], message: 'failed task_update requires fail.error（系统阻碍加 fail.reasonCode）' })
  }
  if (value.status === 'input_required' && !(value.questions?.length)) {
    ctx.addIssue({ code: 'custom', path: ['questions'], message: 'input_required task_update requires questions' })
  }

  const allowed = new Set(taskUpdateFieldAllowList[value.status])
  for (const [field, fieldValue] of Object.entries(value)) {
    if (field !== 'status' && fieldValue !== undefined && !allowed.has(field)) {
      ctx.addIssue({
        code: 'custom',
        path: [field],
        message: `${field} is not allowed on a ${value.status} task_update`,
      })
    }
  }
})

export type DispatchInput = z.infer<typeof dispatchInputSchema>
export type TaskUpdateInput = z.infer<typeof taskUpdateInputSchema>
