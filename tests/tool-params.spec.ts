import { describe, expect, it } from 'vitest'
import { parameterSchemaSpecToJsonSchema } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import {
  DISPATCH_TOOL_PARAMETERS,
  TASK_COMPLETED_TOOL_PARAMETERS,
  TASK_FAILED_TOOL_PARAMETERS,
  TASK_INPUT_REQUIRED_TOOL_PARAMETERS,
  TASK_RUNNING_TOOL_PARAMETERS,
  TASK_SCHEDULE_TOOL_PARAMETERS,
} from '../src/service.ts'
import {
  dispatchInputSchema,
  taskCompletedInputSchema,
  taskFailedInputSchema,
  taskInputRequiredInputSchema,
  taskRunningInputSchema,
  taskScheduleInputSchema,
} from '../src/types.ts'

interface ContractSchema {
  type?: unknown
  enum?: unknown[]
  required?: string[]
  properties?: Record<string, ContractSchema>
  items?: ContractSchema
}

function fieldContracts(schema: ContractSchema, prefix = ''): unknown[] {
  return Object.entries(schema.properties ?? {}).sort(([first], [second]) => first.localeCompare(second)).flatMap(([name, field]) => [
    { path: `${prefix}${name}`, type: field.type, enum: field.enum, required: schema.required?.includes(name) ?? false },
    ...fieldContracts(field, `${prefix}${name}.`),
    ...fieldContracts(field.items ?? {}, `${prefix}${name}[].`),
  ])
}

// 回归：v0.3.9 曾因参数描述里带 DSL 不支持的关键字（pattern），
// defineTool 编译期抛错导致 orchestrator_dispatch 注册失败、从工具列表消失。
describe('工具参数描述可被 dsh-tools DSL 编译', () => {
  it.each([
    ['dispatch', dispatchInputSchema, DISPATCH_TOOL_PARAMETERS],
    ['task_running', taskRunningInputSchema, TASK_RUNNING_TOOL_PARAMETERS],
    ['task_completed', taskCompletedInputSchema, TASK_COMPLETED_TOOL_PARAMETERS],
    ['task_failed', taskFailedInputSchema, TASK_FAILED_TOOL_PARAMETERS],
    ['task_input_required', taskInputRequiredInputSchema, TASK_INPUT_REQUIRED_TOOL_PARAMETERS],
    ['task_schedule', taskScheduleInputSchema, TASK_SCHEDULE_TOOL_PARAMETERS],
  ] as const)('%s 的全部嵌套字段、类型、枚举和静态必填约束与 Host 一致', (_name, input, parameters) => {
    const host = z.toJSONSchema(input, { io: 'input', unrepresentable: 'any' })
    const visible = parameterSchemaSpecToJsonSchema(parameters)
    expect(fieldContracts(visible as ContractSchema)).toEqual(fieldContracts(host as ContractSchema))
  })

  it('orchestrator_dispatch 参数能通过 DSL 编译', () => {
    expect(() => parameterSchemaSpecToJsonSchema(DISPATCH_TOOL_PARAMETERS)).not.toThrow()
  })

  it('task_* 参数能通过 DSL 编译，模型可见字段与协议一致（防 zod/DSL 双写漂移）', () => {
    for (const parameters of [TASK_RUNNING_TOOL_PARAMETERS, TASK_COMPLETED_TOOL_PARAMETERS, TASK_FAILED_TOOL_PARAMETERS, TASK_INPUT_REQUIRED_TOOL_PARAMETERS, TASK_SCHEDULE_TOOL_PARAMETERS]) {
      expect(() => parameterSchemaSpecToJsonSchema(parameters)).not.toThrow()
    }
    expect(Object.keys(TASK_COMPLETED_TOOL_PARAMETERS)).toEqual(expect.arrayContaining(['header', 'progressNote', 'result', 'artifacts', 'card', 'scheduleId']))
    expect(Object.keys(TASK_RUNNING_TOOL_PARAMETERS)).toContain('scheduleId')
    expect(TASK_COMPLETED_TOOL_PARAMETERS.result.description).toContain('只阐述用户需求的最终结果')
    expect(TASK_COMPLETED_TOOL_PARAMETERS.result.description).toContain('不写怎么做或过程性内容')
    expect(TASK_COMPLETED_TOOL_PARAMETERS.result.description).toContain('不含文件路径')
    expect(TASK_COMPLETED_TOOL_PARAMETERS.card.description).toContain('不复制 result 或制品正文')
    expect(TASK_COMPLETED_TOOL_PARAMETERS.artifacts.description).toContain('仅限用户需要打开的关键制品')
    expect(Object.keys(TASK_FAILED_TOOL_PARAMETERS)).toEqual(expect.arrayContaining(['header', 'progressNote', 'error', 'reasonCode']))
    expect(Object.keys(TASK_FAILED_TOOL_PARAMETERS)).toContain('scheduleId')
    expect(Object.keys(TASK_INPUT_REQUIRED_TOOL_PARAMETERS)).toEqual(expect.arrayContaining(['header', 'progressNote', 'questions']))
    expect(Object.keys(TASK_INPUT_REQUIRED_TOOL_PARAMETERS)).toContain('scheduleId')
    // task_schedule：create.title / update.id 在 JSON Schema 层静态必填（模型漏填在平台侧就被拦）
    const schema = parameterSchemaSpecToJsonSchema(TASK_SCHEDULE_TOOL_PARAMETERS as never) as any
    expect(schema.properties.create.items.required).toContain('title')
    expect(schema.properties.update.items.required).toContain('id')
    expect(schema.properties.create.items.properties).not.toHaveProperty('id')
    expect(schema.properties.create.items.properties).not.toHaveProperty('status')
  })

  it('平台 DSL 对未知关键字依旧抛错（锁定平台行为）', () => {
    expect(() => parameterSchemaSpecToJsonSchema({ x: { type: 'string', pattern: '^a$' } as never })).toThrow()
  })
})
