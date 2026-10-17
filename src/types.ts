import { z } from 'zod'

const conversationStates = ['provisioning', 'running', 'idle', 'input_required', 'failed'] as const
const taskStatuses = ['queued', 'running', 'input_required', 'blocked', 'completed', 'failed', 'cancelled', 'interrupted'] as const
export const activeTaskStatuses = ['queued', 'running'] as const
/** 单条 TaskRun 的终态；input_required/blocked 结束本次执行，等待 Lead 后续派发新的 TaskRun。 */
export const terminalTaskStatuses = ['input_required', 'blocked', 'completed', 'failed', 'cancelled', 'interrupted'] as const
/** 需要向主会话投递通知的终态。 */
// interrupted 是否投递取决于产生路径：改单/重启不投递，手动停止才投递通知。
// 因此该表只表示"允许带 delivery"，pending 由具体路径挂起。
export const deliverableTaskStatuses = ['input_required', 'blocked', 'completed', 'failed', 'interrupted'] as const
export const blockReasonCodes = ['permission_denied', 'configuration', 'dependency', 'network', 'resource', 'runtime'] as const

const trimmed = z.string().trim().min(1)

export const taskUpdateStatuses = ['running', 'input_required', 'blocked', 'completed', 'failed'] as const

export const taskUpdateFieldAllowList: Record<(typeof taskUpdateStatuses)[number], readonly string[]> = {
  running: ['progressNote', 'outlinePatch'],
  input_required: ['progressNote', 'question', 'outlinePatch'],
  blocked: ['progressNote', 'error', 'reasonCode', 'remediation', 'outlinePatch'],
  completed: ['progressNote', 'userAnswer', 'resultSummary', 'outlinePatch'],
  failed: ['progressNote', 'error', 'outlinePatch'],
}

const trimmedList = z.array(trimmed).max(50)
const now = () => new Date().toISOString()

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

export const outlinePatchSchema = z.object({
  title: trimmed.max(200).optional(),
  summary: trimmed.max(2_000).optional(),
  keyFacts: trimmedList.optional(),
  entities: trimmedList.optional(),
  tags: trimmedList.optional(),
  artifacts: trimmedList.optional(),
  openQuestions: trimmedList.optional(),
}).strict()

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

const baseTaskSchema = z.object({
  id: trimmed,
  parentSessionId: trimmed,
  conversationId: trimmed,
  predecessorTaskId: z.string().nullable().default(null),
  subject: trimmed,
  prompt: trimmed,
  acceptanceCriteria: z.string().optional(),
  status: z.enum(taskStatuses).default('queued'),
  progressNote: z.string().optional(),
  userAnswer: z.string().optional(),
  resultSummary: z.string().optional(),
  error: z.string().optional(),
  question: z.string().optional(),
  reasonCode: z.enum(blockReasonCodes).optional(),
  remediation: z.string().optional(),
  cancelledReason: z.string().optional(),
  outlinePatch: outlinePatchSchema.optional(),
  progressSteps: z.array(progressStepSchema).default([]),
  silent: z.boolean().default(false),
  delivery: deliverySchema.optional(),
  revision: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
}).strict()

/** 兼容 0.2.x 存储记录：旧 blocked(+scene/blockedQuestion)→input_required，并丢弃废弃 scene。0.3.1 的 blocked 无 scene，必须保留。 */
function migrateRecord<T>(raw: unknown): unknown {
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
  return record
}

export const conversationSchema = z.preprocess(migrateRecord, baseConversationSchema)
export const taskSchema = z.preprocess(migrateRecord, baseTaskSchema)

export type Outline = z.infer<typeof outlineSchema>
export type ConversationRecord = z.infer<typeof baseConversationSchema>
export type TaskRecord = z.infer<typeof baseTaskSchema>
export type TaskStatus = TaskRecord['status']
export type BlockReasonCode = NonNullable<TaskRecord['reasonCode']>
export type ConversationState = ConversationRecord['state']
export type Delivery = z.infer<typeof deliverySchema>
export type OutlinePatch = z.infer<typeof outlinePatchSchema>

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


export const dispatchInputSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  workspaceName: z.string().trim().min(1).max(80).optional(),
  prompt: z.string().trim().min(1).max(100_000),
  conversationId: z.string().trim().min(1).optional(),
  acceptanceCriteria: z.string().trim().min(1).max(10_000).optional(),
  silent: z.boolean().optional(),
}).strict()

export const taskUpdateInputSchema = z.object({
  status: z.enum(taskUpdateStatuses),
  progressNote: trimmed.max(5_000).optional(),
  userAnswer: trimmed.max(50_000).optional(),
  resultSummary: trimmed.max(1_000).optional(),
  error: trimmed.max(10_000).optional(),
  question: trimmed.max(5_000).optional(),
  reasonCode: z.enum(blockReasonCodes).optional(),
  remediation: trimmed.max(5_000).optional(),
  outlinePatch: outlinePatchSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'completed' && !value.userAnswer) {
    ctx.addIssue({ code: 'custom', path: ['userAnswer'], message: 'completed task_update requires userAnswer' })
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
