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

const PACKAGE = '@may/dsh-orchestrator'

/** 手写 typert descriptor 的公共骨架：方法之间只有 id/method 名与请求/结果 schema 不同。
 * id 必须保持完整字符串字面量（verify-packaging 在产物里检索它做 strict descriptor 校验）。 */
function buildDescriptor(id: string, method: string, requestType: string, requestSchema: z.ZodType, resultSchema: z.ZodType) {
  return {
    id,
    service: 'orchestrator',
    namespace: 'orchestrator',
    method,
    invocation: { kind: 'direct' as const },
    parameters: [{
      name: 'request',
      wire: 'request',
      source: 'json' as const,
      codec: {
        mode: 'strict' as const,
        typeSymbol: `${PACKAGE}/client#${requestType}`,
        create: () => requestSchema,
      },
    }],
    result: {
      mode: 'strict' as const,
      typeSymbol: `${PACKAGE}#orchestrator/${method}:result`,
      create: () => resultSchema,
    },
    sourceLocation: { file: 'src/service.ts', line: 0, column: 0 },
  }
}

export const TYPERT_REMOTE = {
  package: PACKAGE,
  descriptors: [
    buildDescriptor('@may/dsh-orchestrator#orchestrator/snapshot', 'snapshot', 'SnapshotRequest', snapshotRequestSchema, snapshotResultSchema),
    buildDescriptor('@may/dsh-orchestrator#orchestrator/setTodoStatus', 'setTodoStatus', 'SetTodoStatusRequest', setTodoStatusRequestSchema, setTodoStatusResultSchema),
  ],
}

export default TYPERT_REMOTE
