import { describe, expect, it } from 'vitest'
import { modelDisplayName, readModelAttribution, withModelAttribution } from '../src/model-info.ts'
import { createTask, taskSchema } from '../src/types.ts'

describe('Worker 模型元数据', () => {
  it('从 DSH assistant message 分别读取传入模型与返回模型', () => {
    expect(readModelAttribution({
      source: {
        kind: 'model', model: ' moma/auto ',
        replayState: { response: { responseModel: ' abc ' } },
      },
    })).toEqual({ requestedModel: 'moma/auto', responseModel: 'abc' })
  })

  it('返回模型为空或消息结构不完整时不伪造数据', () => {
    expect(readModelAttribution({ source: { kind: 'model', model: 'moma/auto' } }))
      .toEqual({ requestedModel: 'moma/auto' })
    expect(readModelAttribution({ source: { kind: 'tool', model: 'moma/auto' } })).toBeUndefined()
    expect(readModelAttribution(undefined)).toBeUndefined()
  })

  it('最后一次推理覆盖前一次，空返回模型会清除旧路由结果', () => {
    const previous = withModelAttribution({}, { requestedModel: 'moma/auto', responseModel: 'abc' })
    expect(withModelAttribution(previous, { requestedModel: 'moma/auto', responseModel: undefined }))
      .toEqual({ requestedModel: 'moma/auto', responseModel: undefined })
  })

  it.each([
    [{ requestedModel: 'moma/auto', responseModel: 'moma/auto' }, 'moma/auto'],
    [{ requestedModel: 'moma/auto', responseModel: 'abc' }, 'moma/auto-abc'],
    [{ requestedModel: 'moma/auto', responseModel: '' }, 'moma/auto'],
    [{ responseModel: 'abc' }, undefined],
  ])('展示规则 %j -> %s', (task, expected) => {
    expect(modelDisplayName(task)).toBe(expected)
  })

  it('Task schema 与 snapshot 共用模型字段，旧记录仍可读取', () => {
    const task = createTask({
      id: 'task', parentSessionId: 'lead', conversationId: 'conv', predecessorTaskId: null,
      subject: '测试', prompt: '测试',
    })
    expect(taskSchema.parse(task).requestedModel).toBeUndefined()
    expect(taskSchema.parse({ ...task, requestedModel: 'moma/auto', responseModel: 'abc' }))
      .toMatchObject({ requestedModel: 'moma/auto', responseModel: 'abc' })
  })
})
