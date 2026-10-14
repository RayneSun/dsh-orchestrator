import { describe, expect, it } from 'vitest'
import TYPERT from '../src/typert-host.ts'
import TYPERT_REMOTE from '../src/remote.ts'
import {
  snapshotRequestSchema,
  snapshotResultSchema,
} from '../src/remote.ts'
import { createConversation, createTask } from '../src/types.ts'

const descriptor = TYPERT_REMOTE.descriptors[0]!

describe('Orchestrator strict Remote descriptor', () => {
  it('声明唯一的 orchestrator/snapshot direct 方法', () => {
    expect(TYPERT.face).toBe('host')
    expect(TYPERT.package).toBe('@may/dsh-orchestrator')
    expect(descriptor).toMatchObject({
      id: '@may/dsh-orchestrator#orchestrator/snapshot',
      service: 'orchestrator',
      namespace: 'orchestrator',
      method: 'snapshot',
      invocation: { kind: 'direct' },
    })
    expect(descriptor.parameters).toHaveLength(1)
    expect(descriptor.parameters[0]!.codec.mode).toBe('strict')
    expect(descriptor.result.mode).toBe('strict')
    expect(descriptor.sourceLocation?.line).toBeGreaterThan(0)
    expect(descriptor.sourceLocation?.column).toBeGreaterThan(0)
  })

  it('request 和 result codec 使用可执行 Zod strict schema', () => {
    const request = descriptor.parameters[0]!.codec.create().parse({ parentSessionId: 'parent' })
    expect(request).toEqual({ parentSessionId: 'parent' })
    expect(descriptor.parameters[0]!.codec.create().safeParse({ parentSessionId: '' }).success).toBe(false)

    const conv = createConversation({
      id: 'conv_1', childSessionId: 'child', parentSessionId: 'parent',
      scene: 'general', title: '任务',
    })
    const task = createTask({
      id: 'task_1', parentSessionId: 'parent', conversationId: 'conv_1',
      predecessorTaskId: null, subject: '任务', prompt: '执行', scene: 'general',
      responseMode: 'wait',
    })
    expect(snapshotRequestSchema.safeParse({ parentSessionId: 'parent', extra: 1 }).success).toBe(false)
    expect(snapshotResultSchema.parse({ conversations: [conv], tasks: [task] }).tasks).toHaveLength(1)
    expect(snapshotResultSchema.safeParse({ conversations: [], tasks: [], extra: 1 }).success).toBe(false)
  })
})
