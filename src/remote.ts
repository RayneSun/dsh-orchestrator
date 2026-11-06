import { z } from 'zod'
import type { Snapshot } from './types.ts'
import { snapshotResultSchema } from './types.ts'
export { snapshotResultSchema } from './types.ts'

export const snapshotRequestSchema = z.object({
  parentSessionId: z.string().min(1),
}).strict()

export const setScheduleStatusRequestSchema = z.object({
  scheduleId: z.string().min(1),
  status: z.enum(['pending', 'done']),
}).strict()

export const setScheduleStatusResultSchema = z.object({
  ok: z.literal(true),
}).strict()

export const answerQuestionsRequestSchema = z.object({
  childSessionId: z.string().min(1),
  answers: z.array(z.object({
    id: z.string().min(1),
    selected: z.array(z.string()).default([]),
    custom: z.string().optional(),
  }).strict()).min(1),
}).strict()

export const answerQuestionsResultSchema = z.object({
  ok: z.boolean(),
  taskId: z.string().optional(),
  error: z.string().optional(),
}).strict()

export type SnapshotRequest = z.input<typeof snapshotRequestSchema>
export type SetScheduleStatusRequest = z.input<typeof setScheduleStatusRequestSchema>
export type AnswerQuestionsRequest = z.input<typeof answerQuestionsRequestSchema>
export type AnswerQuestionsResult = z.infer<typeof answerQuestionsResultSchema>

export interface OrchestratorClient {
  snapshot(request: SnapshotRequest): Promise<Snapshot>
  setScheduleStatus(request: SetScheduleStatusRequest): Promise<z.infer<typeof setScheduleStatusResultSchema>>
  answerTaskQuestions(request: AnswerQuestionsRequest): Promise<AnswerQuestionsResult>
}

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
    buildDescriptor('@may/dsh-orchestrator#orchestrator/setScheduleStatus', 'setScheduleStatus', 'SetScheduleStatusRequest', setScheduleStatusRequestSchema, setScheduleStatusResultSchema),
    buildDescriptor('@may/dsh-orchestrator#orchestrator/answerTaskQuestions', 'answerTaskQuestions', 'AnswerQuestionsRequest', answerQuestionsRequestSchema, answerQuestionsResultSchema),
  ],
}

export default TYPERT_REMOTE
