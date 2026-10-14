import { z } from 'zod'

export const scenes = ['code', 'general', 'research', 'review'] as const
export const sceneSchema = z.enum(scenes)
export type Scene = z.infer<typeof sceneSchema>

export const conversationStates = ['provisioning', 'running', 'idle', 'blocked', 'failed'] as const
export const taskStatuses = ['queued', 'running', 'blocked', 'completed', 'failed', 'cancelled'] as const
export const activeTaskStatuses = ['queued', 'running'] as const
export const terminalTaskStatuses = ['blocked', 'completed', 'failed', 'cancelled'] as const

const trimmed = z.string().trim().min(1)
const trimmedList = z.array(trimmed)
const now = () => new Date().toISOString()

export const outlineSchema = z.object({
  summary: z.string().default(''),
  keyFacts: trimmedList.default([]),
  entities: trimmedList.default([]),
  tags: trimmedList.default([]),
  artifacts: trimmedList.default([]),
  openQuestions: trimmedList.default([]),
}).strict()

export const conversationSchema = z.object({
  id: trimmed,
  childSessionId: trimmed,
  parentSessionId: trimmed,
  scene: sceneSchema,
  title: trimmed,
  outline: outlineSchema,
  activeTaskId: z.string().nullable().default(null),
  lastTaskId: z.string().nullable().default(null),
  state: z.enum(conversationStates).default('provisioning'),
  revision: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
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

export const taskSchema = z.object({
  id: trimmed,
  parentSessionId: trimmed,
  conversationId: trimmed,
  predecessorTaskId: z.string().nullable().default(null),
  scene: sceneSchema,
  subject: trimmed,
  prompt: trimmed,
  acceptanceCriteria: z.string().optional(),
  responseMode: z.enum(['wait', 'background']),
  status: z.enum(taskStatuses).default('queued'),
  progressNote: z.string().optional(),
  userAnswer: z.string().optional(),
  resultSummary: z.string().optional(),
  error: z.string().optional(),
  outlinePatch: outlinePatchSchema.optional(),
  delivery: deliverySchema.optional(),
  revision: z.number().int().nonnegative().default(0),
  createdAt: z.string(),
  updatedAt: z.string(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
}).strict()

export type Outline = z.infer<typeof outlineSchema>
export type ConversationRecord = z.infer<typeof conversationSchema>
export type TaskRecord = z.infer<typeof taskSchema>
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
  scene: Scene
  title: string
}): ConversationRecord {
  const ts = timestamp()
  return { ...input, outline: emptyOutline(), activeTaskId: null, lastTaskId: null, state: 'provisioning', revision: 0, createdAt: ts, updatedAt: ts }
}

export function createTask(input: {
  id: string
  parentSessionId: string
  conversationId: string
  predecessorTaskId: string | null
  subject: string
  prompt: string
  scene: Scene
  acceptanceCriteria?: string
  responseMode: 'wait' | 'background'
}): TaskRecord {
  const ts = timestamp()
  return {
    id: input.id,
    parentSessionId: input.parentSessionId,
    conversationId: input.conversationId,
    predecessorTaskId: input.predecessorTaskId,
    scene: input.scene,
    subject: input.subject,
    prompt: input.prompt,
    ...input.acceptanceCriteria ? { acceptanceCriteria: input.acceptanceCriteria } : {},
    responseMode: input.responseMode,
    status: 'queued',
    ...input.responseMode === 'background' ? { delivery: { state: 'pending', attempts: 0 } } : {},
    revision: 0,
    createdAt: ts,
    updatedAt: ts,
  }
}

export const dispatchInputSchema = z.object({
  subject: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  scene: sceneSchema,
  conversationId: z.string().trim().min(1).optional(),
  responseMode: z.enum(['wait', 'background']),
  acceptanceCriteria: z.string().trim().min(1).optional(),
  waitTimeoutMs: z.number().int().positive().max(600_000).optional(),
}).strict()

export const taskUpdateInputSchema = z.object({
  status: z.enum(['running', 'blocked', 'completed', 'failed']),
  progressNote: trimmed.optional(),
  userAnswer: trimmed.optional(),
  resultSummary: trimmed.optional(),
  error: trimmed.optional(),
  outlinePatch: outlinePatchSchema.optional(),
}).strict().superRefine((value, ctx) => {
  if (value.status === 'completed' && !value.userAnswer) {
    ctx.addIssue({ code: 'custom', path: ['userAnswer'], message: 'completed task_update requires userAnswer' })
  }
  if (value.status === 'failed' && !value.error) {
    ctx.addIssue({ code: 'custom', path: ['error'], message: 'failed task_update requires error' })
  }
  if (value.status === 'blocked' && !value.error && !value.progressNote) {
    ctx.addIssue({ code: 'custom', path: ['progressNote'], message: 'blocked task_update requires error or progressNote' })
  }
})

export type DispatchInput = z.infer<typeof dispatchInputSchema>
export type TaskUpdateInput = z.infer<typeof taskUpdateInputSchema>
