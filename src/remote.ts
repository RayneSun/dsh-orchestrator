import { z } from 'zod'
import { conversationSchema, taskSchema } from './types.ts'

export const snapshotRequestSchema = z.object({
  parentSessionId: z.string().min(1),
}).strict()

export const snapshotResultSchema = z.object({
  conversations: z.array(conversationSchema),
  tasks: z.array(taskSchema),
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
  sourceLocation: { file: 'src/service.ts', line: 172, column: 3 },
}

export const TYPERT_REMOTE = {
  package: '@may/dsh-orchestrator',
  descriptors: [descriptor],
}

export default TYPERT_REMOTE
