import { z } from 'zod'
import { conversationSchema, taskSchema } from './types.ts'

export const snapshotRequestSchema = z.object({
  parentSessionId: z.string().min(1),
}).strict()

export const snapshotResultSchema = z.object({
  conversations: z.array(conversationSchema),
  tasks: z.array(taskSchema),
}).strict()

export const setTodoStatusRequestSchema = z.object({
  todoId: z.string().min(1),
  status: z.enum(['pending', 'done']),
}).strict()

export const setTodoStatusResultSchema = z.object({
  ok: z.literal(true),
}).strict()

const descriptor = {
  id: '@may/dsh-orchestrator#orchestrator/snapshot',
  service: 'orchestrator',
  namespace: 'orchestrator',
  method: 'snapshot',
  invocation: { kind: 'direct' as const },
  parameters: [{
    name: 'request',
    wire: 'request',
    source: 'json' as const,
    codec: {
      mode: 'strict' as const,
      typeSymbol: '@may/dsh-orchestrator/client#SnapshotRequest',
      create: () => snapshotRequestSchema,
    },
  }],
  result: {
    mode: 'strict' as const,
    typeSymbol: '@may/dsh-orchestrator#orchestrator/snapshot:result',
    create: () => snapshotResultSchema,
  },
  sourceLocation: { file: 'src/service.ts', line: 277, column: 3 },
}

const setTodoStatusDescriptor = {
  id: '@may/dsh-orchestrator#orchestrator/setTodoStatus',
  service: 'orchestrator',
  namespace: 'orchestrator',
  method: 'setTodoStatus',
  invocation: { kind: 'direct' as const },
  parameters: [{
    name: 'request',
    wire: 'request',
    source: 'json' as const,
    codec: {
      mode: 'strict' as const,
      typeSymbol: '@may/dsh-orchestrator/client#SetTodoStatusRequest',
      create: () => setTodoStatusRequestSchema,
    },
  }],
  result: {
    mode: 'strict' as const,
    typeSymbol: '@may/dsh-orchestrator#orchestrator/setTodoStatus:result',
    create: () => setTodoStatusResultSchema,
  },
  sourceLocation: { file: 'src/service.ts', line: 282, column: 3 },
}

export const TYPERT_REMOTE = {
  package: '@may/dsh-orchestrator',
  descriptors: [descriptor, setTodoStatusDescriptor],
}

export default TYPERT_REMOTE
