import { z } from 'zod'

export const conversationStates = ['provisioning', 'running', 'idle', 'input_required', 'failed'] as const
export const taskStatuses = ['queued', 'running', 'input_required', 'completed', 'failed', 'cancelled', 'interrupted'] as const
export const activeTaskStatuses = ['queued', 'running'] as const
/** 终态：任务不再推进（input_required 等待 Lead 带着答复派发新 TaskRun）。 */
export const terminalTaskStatuses = ['input_required', 'completed', 'failed', 'cancelled', 'interrupted'] as const
/** 需要向主会话投递通知的终态。 */
export const deliverableTaskStatuses = ['input_required', 'completed', 'failed'] as const

const trimmed = z.string().trim().min(1)
const trimmedList = z.array(trimmed)
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
  title: trimmed.optional(),
  summary: trimmed.optional(),
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
  responseMode: z.enum(['wait', 'background']),
  status: z.enum(taskStatuses).default('queued'),
  progressNote: z.string().optional(),
  userAnswer: z.string().optional(),
  resultSummary: z.string().optional(),
  error: z.string().optional(),
  question: z.string().optional(),
  cancelledReason: z.string().optional(),
  outlinePatch: outlinePatchSchema.optional(),
  progressSteps: z.array(progressStepSchema).default([]),
  delivery: deliverySchema.optional(),
  revision: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
}).strict()

/** 兼容 0.2.x 存储记录：blocked→input_required、blockedQuestion→question、丢弃已废弃的 scene。 */
function migrateRecord<T>(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw
  const record = { ...(raw as Record<string, unknown>) }
  delete record.scene
  if (record.status === 'blocked') record.status = 'input_required'
  if (record.state === 'blocked') record.state = 'input_required'
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

export function emptyOutline(): Outline {
  return { summary: '', keyFacts: [], entities: [], tags: [], artifacts: [], openQuestions: [] }
}

export function createConversation(input: {
  id: string
  childSessionId: string
  parentSessionId: string
  title: string
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
  responseMode: 'wait' | 'background'
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
    responseMode: input.responseMode,
    status: 'queued',
    progressSteps: [],
    revision: 0,
    createdAt: ts,
    updatedAt: ts,
  }
}

export const dispatchInputSchema = z.object({
  subject: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  conversationId: z.string().trim().min(1).optional(),
  // 默认后台执行，不阻塞主对话；wait 仅用于需要同轮拿结果的短任务。
  responseMode: z.enum(['wait', 'background']).default('background'),
  acceptanceCriteria: z.string().trim().min(1).optional(),
  waitTimeoutMs: z.number().int().positive().max(600_000).optional(),
}).strict()

export const taskUpdateInputSchema = z.object({
  status: z.enum(['running', 'input_required', 'completed', 'failed']),
  progressNote: trimmed.optional(),
  userAnswer: trimmed.optional(),
  resultSummary: trimmed.optional(),
  error: trimmed.optional(),
  question: trimmed.optional(),
  outlinePatch: outlinePatchSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'completed' && !value.userAnswer) {
    ctx.addIssue({ code: 'custom', path: ['userAnswer'], message: 'completed task_update requires userAnswer' })
  }
  if (value.status === 'failed' && !value.error) {
    ctx.addIssue({ code: 'custom', path: ['error'], message: 'failed task_update requires error' })
  }
  if (value.status === 'input_required' && !value.error && !value.progressNote && !value.question) {
    ctx.addIssue({ code: 'custom', path: ['question'], message: 'input_required task_update requires question, error or progressNote' })
  }
})

export type DispatchInput = z.infer<typeof dispatchInputSchema>
export type TaskUpdateInput = z.infer<typeof taskUpdateInputSchema>
