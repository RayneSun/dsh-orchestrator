import { z } from 'zod'
import { normalizeTimePoint, resolveScheduleTimes } from './schedule-time.ts'
export { normalizeTimePoint, normalizeDateOnly, isDateOnly, resolveScheduleTimes, scheduleConsistencyError } from './schedule-time.ts'

const conversationStates = ['provisioning', 'running', 'idle', 'input_required', 'failed'] as const
const taskStatuses = ['queued', 'running', 'input_required', 'completed', 'failed', 'interrupted'] as const
export const activeTaskStatuses = ['queued', 'running'] as const
/** 真正结束 TaskRun 的状态；input_required 仍在同一轮阻塞等待。 */
export const terminalTaskStatuses = ['completed', 'failed', 'interrupted'] as const

/** 设置页的终态投递开关（volatile，即时生效）；问题卡永不投递 Lead。 */
export interface DeliveryToggles {
  completed: boolean
  failed: boolean
  interrupted: boolean
}

export const defaultDeliveryToggles: DeliveryToggles = {
  completed: true,
  failed: true,
  interrupted: true,
}
export const blockReasonCodes = ['permission_denied', 'configuration', 'dependency', 'network', 'resource', 'runtime'] as const

const trimmed = z.string().trim().min(1)

const now = () => new Date().toISOString()

/** 日程时间点：宽松输入（startAt/endAt/remindAt 共用），输出归一化 ISO 8601 带时区。 */
const scheduleReminderTimeSchema = z.string().trim().transform((value, ctx) => {
  const normalized = normalizeTimePoint(value)
  if (!normalized) {
    ctx.addIssue({ code: 'custom', message: `无效时间 "${value}"，合法格式如 "10-28 18:00" 或 "2026-10-28T18:00"` })
    return z.NEVER
  }
  return normalized
})

/** 相对路径：拒绝绝对路径、盘符与 .. 逃逸（日程附件与任务产物共用）。 */
const relativePathSchema = z.string().trim().min(1).max(500).refine(
  (value) => {
    if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) return false
    return !value.split(/[\\/]/).includes('..')
  },
  { message: '必须是工作区内的相对路径' },
)

/** 日程优先级：P0 紧急且重要 / P1 重要不紧急 / P2 紧急不重要 / P3 有空再做（默认）。 */
export const schedulePriorities = ['P0', 'P1', 'P2', 'P3'] as const
export const schedulePrioritySchema = z.enum(schedulePriorities)

/** 日程链接：http(s) 网址 + 可选显示名。 */
const scheduleLinkSchema = z.object({
  url: z.string().trim().max(2_000).regex(/^https?:\/\//, '链接必须是 http(s) 网址'),
  label: trimmed.max(50).optional(),
}).strict()

/** 日程附件：子工作区相对路径 + 可选显示名。 */
const scheduleAttachmentSchema = z.object({
  path: relativePathSchema,
  name: trimmed.max(100).optional(),
}).strict()

/** 日程联系人：弱结构信息卡（移动端可渲染 tel:/mailto: 动作）。 */
const scheduleContactSchema = z.object({
  name: trimmed.max(50),
  phone: trimmed.max(50).optional(),
  email: z.string().trim().max(200).optional(),
  note: z.string().trim().max(500).optional(),
}).strict()

/** 日程地点：名称 + 可选地址，不做坐标。 */
const scheduleLocationSchema = z.object({
  name: trimmed.max(100),
  address: z.string().trim().max(300).optional(),
}).strict()

/** 日程时间原始输入：startAt/endAt 保持 raw，按 allDay 分叉解析（resolveScheduleTimes）。 */
const scheduleTimeFields = {
  allDay: z.boolean().optional(),
  startAt: z.string().max(40).optional(),
  endAt: z.string().max(40).optional(),
  remindAt: scheduleReminderTimeSchema.optional(),
}

/** 日程结构化内容字段（create/update 共用；时间字段走 scheduleTimeFields 分叉解析）。 */
const scheduleContentFields = {
  links: z.array(scheduleLinkSchema).max(10).optional(),
  attachments: z.array(scheduleAttachmentSchema).max(10).optional(),
  contacts: z.array(scheduleContactSchema).max(5).optional(),
  location: scheduleLocationSchema.optional(),
  // 备注放最后：诱导模型优先填结构化字段，remark 只兜底纯文字说明
  remark: z.string().trim().max(2_000).optional(),
}

/** task_schedule 的 create 元素：新建日程（title 静态必填，结构上接触不到 id/status）。 */
export const scheduleCreateSchema = z.object({
  title: trimmed.max(30),
  ...scheduleTimeFields,
  ...scheduleContentFields,
  priority: schedulePrioritySchema.default('P3'),
}).strict().transform((value, ctx) => {
  const times = resolveScheduleTimes(value, ctx)
  if (!times) return z.NEVER
  return { ...value, ...times }
})

/** task_schedule 的 update 元素：更新已有日程（id 静态必填，抄自可见清单，禁止编造）。 */
export const scheduleUpdateSchema = z.object({
  id: trimmed,
  status: z.enum(['pending', 'done', 'cancelled']).optional(),
  title: trimmed.max(30).optional(),
  ...scheduleTimeFields,
  ...scheduleContentFields,
  priority: schedulePrioritySchema.optional(),
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
  priority: schedulePrioritySchema.default('P3'),
  links: z.array(scheduleLinkSchema).default([]),
  attachments: z.array(scheduleAttachmentSchema).default([]),
  contacts: z.array(scheduleContactSchema).default([]),
  location: scheduleLocationSchema.optional(),
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

/** 会话路由卡摘要：最近 dispatch 主题链（Host 维护，最多 5 个）。仅保留实际用于路由的主题链。 */
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

/** 看板与 Worker 原生卡共用的作答项。 */
export const questionAnswerSchema = z.object({
  id: trimmed,
  selected: z.array(trimmed.max(100)).max(10).default([]),
  custom: trimmed.max(2_000).optional(),
}).strict()
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>

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
}).strict()

/** card 校验：JSON object、序列化 ≤16KB、禁三反引号（防围栏嵌套）。 */
export function cardValidationError(card: unknown): string | undefined {
  if (card === null || typeof card !== 'object' || Array.isArray(card)) return `card: expected object, received ${Array.isArray(card) ? 'array' : typeof card}`
  const json = JSON.stringify(card)
  const bytes = new TextEncoder().encode(json).byteLength
  if (bytes > 16384) return `card: serialized size ${bytes} bytes exceeds 16384`
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
  /** 极简状态标题（最多 8 个字，手机端/折叠态展示），progressNote 的压缩版。长度只在 task_* 输入边界限制，存储层不加约束。 */
  header: z.string().optional(),
  progressNote: z.string().optional(),
  /** input_required 的结构化问题（id 已由 Host 补齐）。 */
  questions: z.array(questionItemObjectSchema).max(10).optional(),
  /** 看板与 Worker 原生卡的作答留痕。 */
  answers: z.array(questionAnswerSchema).max(10).optional(),
  /** completed 终态：result 是用户最终看到的权威答案；card 是 dsh-ui 展示卡片（card 放明细，result 只写结论）。 */
  result: z.string().optional(),
  artifacts: z.array(relativePathSchema).optional(),
  card: z.record(z.string(), z.unknown()).optional(),
  /** failed 终态：error 必填；reasonCode 标记系统阻碍（Lead 可修复后重派）。 */
  error: z.string().optional(),
  reasonCode: z.enum(blockReasonCodes).optional(),
  cancelledReason: z.string().optional(),
  progressSteps: z.array(progressStepSchema).default([]),
  silent: z.boolean().default(false),
  /** 定时触发产生的上报任务（宿主按入站消息来源自动判定，看板定时标识）。 */
  scheduled: z.boolean().optional(),
  delivery: deliverySchema.optional(),
  revision: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
}).strict()

// v0.3.19 起使用全新的拍平协议，不兼容旧记录，也不静默丢弃历史字段。
export const conversationSchema = baseConversationSchema
export const taskSchema = baseTaskSchema

export type Outline = z.infer<typeof outlineSchema>
export type ConversationRecord = z.infer<typeof baseConversationSchema>
export type TaskRecord = z.infer<typeof baseTaskSchema>
export type TaskStatus = TaskRecord['status']
export type BlockReasonCode = (typeof blockReasonCodes)[number]

export const snapshotResultSchema = z.object({
  conversations: z.array(conversationSchema.extend({
    /** 由宿主定时任务推导，不落库。 */
    hasActiveSchedule: z.boolean().optional(),
  })),
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

/** task_* 工具的公共字段：header 与 progressNote（长度只在输入边界限制，存储层不加约束）。 */
const taskCommonFields = {
  header: trimmed.max(8).optional(),
  progressNote: trimmed.max(500).optional(),
}

export const taskRunningInputSchema = z.object({
  ...taskCommonFields,
}).strict()
export type TaskRunningInput = z.infer<typeof taskRunningInputSchema>

export const taskCompletedInputSchema = z.object({
  ...taskCommonFields,
  result: trimmed.max(50_000),
  artifacts: z.array(relativePathSchema).max(20).optional(),
  card: z.record(z.string(), z.unknown()).optional(),
}).strict()
export type TaskCompletedInput = z.infer<typeof taskCompletedInputSchema>

export const taskFailedInputSchema = z.object({
  ...taskCommonFields,
  error: trimmed.max(10_000),
  reasonCode: z.enum(blockReasonCodes).optional(),
}).strict()
export type TaskFailedInput = z.infer<typeof taskFailedInputSchema>

export const taskInputRequiredInputSchema = z.object({
  ...taskCommonFields,
  questions: z.array(questionItemInputSchema).min(1).max(10),
}).strict()
export type TaskInputRequiredInput = z.infer<typeof taskInputRequiredInputSchema>

export const taskScheduleInputSchema = z.object({
  create: z.array(scheduleCreateSchema).max(50).optional(),
  update: z.array(scheduleUpdateSchema).max(50).optional(),
}).strict().refine(
  value => (value.create?.length ?? 0) + (value.update?.length ?? 0) > 0,
  { message: 'task_schedule requires create or update' },
)
export type TaskScheduleInput = z.infer<typeof taskScheduleInputSchema>

/** 四个状态上报工具的 schema 查找表（service 按工具名取用）。 */
export const taskReportInputSchemas = {
  running: taskRunningInputSchema,
  input_required: taskInputRequiredInputSchema,
  completed: taskCompletedInputSchema,
  failed: taskFailedInputSchema,
} as const
export type TaskReportStatus = keyof typeof taskReportInputSchemas

export type DispatchInput = z.infer<typeof dispatchInputSchema>
