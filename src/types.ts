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
  running: ['title', 'progressNote', 'summary', 'todoUpdates'],
  input_required: ['title', 'progressNote', 'question', 'summary', 'todoUpdates'],
  blocked: ['title', 'progressNote', 'error', 'reasonCode', 'remediation', 'summary'],
  completed: ['title', 'progressNote', 'report', 'summary', 'todoUpdates'],
  failed: ['title', 'progressNote', 'error', 'summary'],
}

const trimmedList = z.array(trimmed).max(50)
const now = () => new Date().toISOString()

/** 严格日期：YYYY-MM-DD。 */
const dueDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'dueDate 必须是 YYYY-MM-DD 格式')

/** 待办优先级：P0 紧急且重要 / P1 重要不紧急 / P2 紧急不重要 / P3 有空再做（默认）。 */
export const todoPriorities = ['P0', 'P1', 'P2', 'P3'] as const
export const todoPrioritySchema = z.enum(todoPriorities)

/** 子会话提出的用户待办（report.todos 元素）：需要用户本人推进的事。 */
export const newTodoSchema = z.object({
  title: trimmed.max(30),
  detail: z.string().trim().max(2_000).optional(),
  dueDate: dueDateSchema.optional(),
  priority: todoPrioritySchema.default('P3'),
}).strict()

/** 持久化的用户待办：属于会话级清单，用户与子会话双向画勾。 */
export const userTodoSchema = z.object({
  id: trimmed,
  title: trimmed.max(30),
  detail: z.string().trim().max(2_000).optional(),
  dueDate: dueDateSchema.optional(),
  priority: todoPrioritySchema.default('P3'),
  status: z.enum(['pending', 'done', 'cancelled']).default('pending'),
  completedBy: z.enum(['user', 'worker']).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  completedAt: z.string().optional(),
}).strict()
export type UserTodo = z.infer<typeof userTodoSchema>

/** task_update 最外层的待办更新：按 id 标 done 或改内容。 */
export const todoUpdateSchema = z.object({
  id: trimmed,
  status: z.enum(['pending', 'done', 'cancelled']).optional(),
  title: trimmed.max(30).optional(),
  detail: z.string().trim().max(2_000).optional(),
  dueDate: dueDateSchema.optional(),
  priority: todoPrioritySchema.optional(),
}).strict()

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

/** 制品路径：子工作区内相对路径，拒绝绝对路径、盘符与 .. 逃逸。 */
const artifactPath = z.string().trim().min(1).max(500).refine(
  (value) => {
    if (value.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(value)) return false
    return !value.split(/[\\/]/).includes('..')
  },
  { message: 'artifacts 必须是子工作区内的相对路径' },
)

/** completed 上报：result 给主会话转述；artifacts 是用户会要看的产物文件（相对路径）。 */
export const reportSchema = z.object({
  result: trimmed.max(50_000),
  artifacts: z.array(artifactPath).max(20).optional(),
  todos: z.array(newTodoSchema).max(20).optional(),
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
  if (record.status === 'cancelled') record.status = 'interrupted'
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
  todoUpdates: z.array(todoUpdateSchema).max(50).optional(),
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
