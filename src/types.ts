import { z } from 'zod'

const conversationStates = ['provisioning', 'running', 'idle', 'input_required', 'failed'] as const
const taskStatuses = ['queued', 'running', 'input_required', 'blocked', 'completed', 'failed', 'interrupted'] as const
export const activeTaskStatuses = ['queued', 'running'] as const
/** 单条 TaskRun 的终态；input_required/blocked 结束本次执行，等待 Lead 后续派发新的 TaskRun。 */
export const terminalTaskStatuses = ['input_required', 'blocked', 'completed', 'failed', 'interrupted'] as const
/** 允许向主会话投递通知的终态。 */
// interrupted 是否投递取决于产生路径：改单/重启不投递，手动停止才投递通知。
// 因此该表只表示"允许带 delivery"，pending 由具体路径挂起；
// 最终是否真正投递还受设置页投递开关（DeliveryToggles）与 silent 约束。
export const deliverableTaskStatuses = ['input_required', 'blocked', 'completed', 'failed', 'interrupted'] as const

/** 设置页的终态投递开关（volatile，即时生效）：关闭的状态只更新状态，不向主会话投递消息。 */
export interface DeliveryToggles {
  inputRequired: boolean
  blocked: boolean
  completed: boolean
  failed: boolean
  interrupted: boolean
}

/** 默认全部投递（未注入配置时的行为，与历史版本一致）。 */
export const defaultDeliveryToggles: DeliveryToggles = {
  inputRequired: true,
  blocked: true,
  completed: true,
  failed: true,
  interrupted: true,
}
export const blockReasonCodes = ['permission_denied', 'configuration', 'dependency', 'network', 'resource', 'runtime'] as const

const trimmed = z.string().trim().min(1)

export const taskUpdateStatuses = ['running', 'input_required', 'blocked', 'completed', 'failed'] as const

export const taskUpdateFieldAllowList: Record<(typeof taskUpdateStatuses)[number], readonly string[]> = {
  running: ['title', 'progressNote', 'summary', 'userTodos'],
  input_required: ['title', 'progressNote', 'question', 'summary', 'userTodos'],
  blocked: ['title', 'progressNote', 'error', 'reasonCode', 'remediation', 'summary'],
  completed: ['title', 'progressNote', 'report', 'summary', 'userTodos'],
  failed: ['title', 'progressNote', 'error', 'summary'],
}

const trimmedList = z.array(trimmed).max(50)
const now = () => new Date().toISOString()

const pad2 = (n: number) => String(n).padStart(2, '0')

/** Date → 本地 ISO 8601（带 ±HH:mm 偏移，比 UTC Z 形式更可读）。 */
function toLocalIso(d: Date): string {
  const offset = -d.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const abs = Math.abs(offset)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`
}

/** 宽松时间点解析：模型友好简写 → 归一化为带时区的完整 ISO 8601。
 * 合法输入："10-28 18:00"（省略年份=最近未来）、"2026-10-28 18:00"、"2026-10-28T18:00"、
 * "2026-10-28"（当日 00:00）、完整 ISO 8601（Z 或 ±HH:mm）。自然语言（"明天下午"）拒绝。 */
export function normalizeTimePoint(raw: string): string | undefined {
  const match = raw.trim().match(/^(?:(\d{4})-)?(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?\s*(Z|[+-]\d{2}:\d{2})?$/)
  if (!match) return undefined
  const [, yearStr, monthStr, dayStr, hourStr, minuteStr, secondStr, zone] = match
  const month = Number(monthStr), day = Number(dayStr)
  const hour = hourStr === undefined ? 0 : Number(hourStr)
  const minute = minuteStr === undefined ? 0 : Number(minuteStr)
  const second = secondStr === undefined ? 0 : Number(secondStr)
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return undefined
  if (zone) {
    const full = `${yearStr ?? String(new Date().getFullYear())}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:${pad2(minute)}:${pad2(second)}${zone}`
    const parsed = new Date(full)
    return Number.isNaN(parsed.getTime()) ? undefined : toLocalIso(parsed)
  }
  const now = new Date()
  let year = yearStr ? Number(yearStr) : now.getFullYear()
  let local = new Date(year, month - 1, day, hour, minute, second)
  // 校验日期真实存在（2-30 会被 Date 滑到 3 月，回读比对拒绝）
  if (local.getMonth() !== month - 1 || local.getDate() !== day) return undefined
  if (!yearStr && local.getTime() < now.getTime()) {
    year += 1
    local = new Date(year, month - 1, day, hour, minute, second)
  }
  return toLocalIso(local)
}

/** 待办时间点：宽松输入（startAt/endAt/remindAt 共用），输出归一化 ISO 8601 带时区。 */
const todoTimeSchema = z.string().trim().transform((value, ctx) => {
  const normalized = normalizeTimePoint(value)
  if (!normalized) {
    ctx.addIssue({ code: 'custom', message: `无效时间 "${value}"，合法格式如 "10-28 18:00" 或 "2026-10-28T18:00"` })
    return z.NEVER
  }
  return normalized
})

/** 时间窗顺序校验：startAt 不得晚于 endAt（两点都存在时）。 */
const timeWindowRefinement = (value: { startAt?: string, endAt?: string }, ctx: z.RefinementCtx) => {
  if (value.startAt && value.endAt && Date.parse(value.startAt) > Date.parse(value.endAt)) {
    ctx.addIssue({ code: 'custom', path: ['startAt'], message: 'startAt 不能晚于 endAt' })
  }
}

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

/** 待办内容字段（new 与 update 共用；update 全可选）。 */
const todoContentFields = {
  startAt: todoTimeSchema.optional(),
  endAt: todoTimeSchema.optional(),
  remindAt: todoTimeSchema.optional(),
  links: z.array(todoLinkSchema).max(10).optional(),
  attachments: z.array(todoAttachmentSchema).max(10).optional(),
  contacts: z.array(todoContactSchema).max(5).optional(),
  location: todoLocationSchema.optional(),
  // 备注放最后：诱导模型优先填结构化字段，remark 只兜底纯文字说明
  remark: z.string().trim().max(2_000).optional(),
}

/** task_update 的 userTodos.create 元素：新建待办（title 静态必填，结构上接触不到 id/status）。 */
export const todoCreateSchema = z.object({
  title: trimmed.max(30),
  ...todoContentFields,
  priority: todoPrioritySchema.default('P3'),
}).strict().superRefine(timeWindowRefinement)

/** task_update 的 userTodos.update 元素：更新已有待办（id 静态必填，抄自可见清单，禁止编造）。 */
export const todoUpdateEntrySchema = z.object({
  id: trimmed,
  status: z.enum(['pending', 'done', 'cancelled']).optional(),
  title: trimmed.max(30).optional(),
  ...todoContentFields,
  priority: todoPrioritySchema.optional(),
}).strict().superRefine(timeWindowRefinement)

/** 持久化的用户待办：属于会话级清单，用户与子会话双向画勾。 */
const userTodoObjectSchema = z.object({
  id: trimmed,
  title: trimmed.max(30),
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

/** 旧字段迁移：dueDate（YYYY-MM-DD）→ endAt（当日 23:59 本地，转 ISO 8601）。 */
export const userTodoSchema = z.preprocess((value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const record = value as Record<string, unknown>
  if (typeof record.dueDate !== 'string') return value
  const { dueDate, ...rest } = record
  if (rest.endAt !== undefined) return rest
  const endOfDay = new Date(`${dueDate}T23:59:59`)
  return { ...rest, endAt: Number.isNaN(endOfDay.getTime()) ? dueDate : endOfDay.toISOString() }
}, userTodoObjectSchema)
export type UserTodo = z.infer<typeof userTodoSchema>

export const progressStepSchema = z.object({
  content: z.string().trim().min(1).max(300),
  status: z.enum(['pending', 'in_progress', 'completed']),
}).strict()
export type ProgressStep = z.infer<typeof progressStepSchema>

export const outlineSchema = z.object({
  summary: z.string().default(''),
  keyFacts: trimmedList.default([]),
  entities: trimmedList.default([]),
  tags: trimmedList.default([]),
  artifacts: trimmedList.default([]),
  openQuestions: trimmedList.default([]),
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

/** completed 上报：result 给主会话转述；artifacts 是用户会要看的产物文件（相对路径）。 */
export const reportSchema = z.object({
  result: trimmed.max(50_000),
  artifacts: z.array(relativePathSchema).max(20).optional(),
}).strict()
export type TaskReport = z.infer<typeof reportSchema>

const baseConversationSchema = z.object({
  id: trimmed,
  childSessionId: trimmed,
  parentSessionId: trimmed,
  title: trimmed,
  workspaceName: z.string().trim().min(1).max(100).optional(),
  workspaceDir: z.string().trim().min(1).optional(),
  outline: outlineSchema,
  todos: z.array(userTodoSchema).default([]),
  activeTaskId: z.string().nullable().default(null),
  lastTaskId: z.string().nullable().default(null),
  state: z.enum(conversationStates).default('provisioning'),
  revision: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** 仅快照投影使用：子会话绑定了活动定时任务（不落库，由宿主核对 schedule 后填入）。 */
  hasActiveSchedule: z.boolean().optional(),
}).strict()

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
  title: z.string().optional(),
  progressNote: z.string().optional(),
  error: z.string().optional(),
  question: z.string().optional(),
  reasonCode: z.enum(blockReasonCodes).optional(),
  remediation: z.string().optional(),
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
 */
function migrateRecord(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const record = { ...(raw as Record<string, unknown>) }
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
  delete record.userAnswer
  delete record.resultSummary
  delete record.outlinePatch
  // 0.3.12 的 report.todos 是待办创建请求的冗余回显（数据已落 conv.todos），0.3.13 协议移出 report，剥离。
  if (record.report && typeof record.report === 'object' && 'todos' in record.report) {
    const { todos, ...rest } = record.report as Record<string, unknown>
    record.report = rest
  }
  if (record.status === 'cancelled') record.status = 'interrupted'
  // 0.3.12 的待办带 completedAt（只写不读的死字段），0.3.13 起剥离。
  if (Array.isArray(record.todos)) {
    record.todos = record.todos.map(todo => {
      if (!todo || typeof todo !== 'object') return todo
      const { completedAt, ...rest } = todo as Record<string, unknown>
      // 0.3.12 的 detail → 0.3.13 的 remark
      if (rest.remark === undefined && typeof rest.detail === 'string') {
        rest.remark = rest.detail
      }
      delete rest.detail
      return rest
    })
  }
  return record
}

export const conversationSchema = z.preprocess(migrateRecord, baseConversationSchema)
export const taskSchema = z.preprocess(migrateRecord, baseTaskSchema)

export type Outline = z.infer<typeof outlineSchema>
export type ConversationRecord = z.infer<typeof baseConversationSchema>
export type TaskRecord = z.infer<typeof baseTaskSchema>
export type TaskStatus = TaskRecord['status']
export type BlockReasonCode = NonNullable<TaskRecord['reasonCode']>

export interface Snapshot {
  conversations: ConversationRecord[]
  tasks: TaskRecord[]
}

export function createId(prefix: string): string {
  return `${prefix}_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
}

export function timestamp(): string {
  return now()
}

function emptyOutline(): Outline {
  return { summary: '', keyFacts: [], entities: [], tags: [], artifacts: [], openQuestions: [] }
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
    todos: [],
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
  title: trimmed.max(8).optional(),
  progressNote: trimmed.max(500).optional(),
  summary: trimmed.max(300).optional(),
  report: reportSchema.optional(),
  error: trimmed.max(10_000).optional(),
  question: trimmed.max(5_000).optional(),
  reasonCode: z.enum(blockReasonCodes).optional(),
  remediation: trimmed.max(5_000).optional(),
  userTodos: z.object({
    create: z.array(todoCreateSchema).max(50).optional(),
    update: z.array(todoUpdateEntrySchema).max(50).optional(),
  }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'completed' && !value.report) {
    ctx.addIssue({ code: 'custom', path: ['report'], message: 'completed task_update requires report' })
  }
  if ((value.status === 'failed' || value.status === 'blocked') && !value.error) {
    ctx.addIssue({ code: 'custom', path: ['error'], message: `${value.status} task_update requires error` })
  }
  if (value.status === 'input_required' && !value.question) {
    ctx.addIssue({ code: 'custom', path: ['question'], message: 'input_required task_update requires question' })
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
