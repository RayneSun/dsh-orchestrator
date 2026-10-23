import { describe, expect, it } from 'vitest'
import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import { DISPATCH_TOOL_PARAMETERS, TASK_UPDATE_TOOL_PARAMETERS } from '../src/service.ts'

// 回归：v0.3.9 曾因参数描述里带 DSL 不支持的关键字（pattern），
// defineTool 编译期抛错导致 orchestrator_dispatch 注册失败、从工具列表消失。
describe('工具参数描述可被 dsh-tools DSL 编译', () => {
  it('orchestrator_dispatch 参数能通过 DSL 编译', () => {
    expect(() => parameterSchemaSpecToJsonSchema(DISPATCH_TOOL_PARAMETERS)).not.toThrow()
  })

  it('task_update 参数能通过 DSL 编译，且模型可见字段与协议一致（防 zod/DSL 双写漂移）', () => {
    expect(() => parameterSchemaSpecToJsonSchema(TASK_UPDATE_TOOL_PARAMETERS)).not.toThrow()
    // 模型只能看到 DSL 里的字段：title / report.todos / todoUpdates 必须在其中
    expect(Object.keys(TASK_UPDATE_TOOL_PARAMETERS)).toEqual(expect.arrayContaining(['status', 'title', 'progressNote', 'summary', 'report', 'todoUpdates', 'error', 'question']))
    const report = TASK_UPDATE_TOOL_PARAMETERS.report as { properties: Record<string, unknown> }
    expect(Object.keys(report.properties)).toEqual(expect.arrayContaining(['result', 'artifacts', 'todos']))
  })

  it('平台 DSL 对未知关键字依旧抛错（锁定平台行为）', () => {
    expect(() => parameterSchemaSpecToJsonSchema({ x: { type: 'string', pattern: '^a$' } as never })).toThrow()
  })
})
