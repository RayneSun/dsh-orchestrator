import { z } from 'zod'

export const scenes = ['code', 'general', 'research', 'review'] as const
export const sceneSchema = z.enum(scenes)
export type Scene = z.infer<typeof sceneSchema>

export const conversationStates = ['provisioning', 'running', 'idle', 'blocked', 'failed'] as const
export const taskStatuses = ['queued', 'running', 'blocked', 'completed', 'failed', 'cancelled'] as const
export const activeTaskStatuses = ['queued', 'running'] as const
export const terminalTaskStatuses = ['blocked', 'completed', 'failed', 'cancelled'] as const

const trimmed = z.string().trim().min(1)
const now = () => new Date().toISOString()

export const outlineSchema = z.object({
  summary: z.string().default(''),
  keyFacts: z.array(z.string()).default([]),
  entities: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
  artifacts: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
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
  title: z.string().optional(),
  summary: z.string().optional(),
  keyFacts: z.array(z.string()).optional(),
  entities: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
  artifacts: z.array(z.string()).optional(),
  openQuestions: z.array(z.string()).optional(),
}).partial().strict()

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
