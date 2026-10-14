import type { Scene } from './types.ts'

export interface SceneDefinition {
  id: Scene
  label: string
  persona: string
  /** 只包含确定存在的全局工具；本地 task_update 不进入 allow，注册后仍会在子 Agent 作用域可见。 */
  toolFilter: { allow?: string[]; deny?: string[] }
  /** guard 的最终白名单；undefined 表示除 forbidden 外都允许。 */
  allowed?: ReadonlySet<string>
  forbidden: readonly string[]
}

// 稳定存在于 Worker preset 的派生工具名。未知名称不能进入 toolFilter，否则会在启动时 loud fail。
const readTools = ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch']
const knownDelegationTools = ['subagent', 'workflow', 'ralph']

const delegationPatterns = [
  'subagent', 'workflow', 'ralph', 'job_kill', 'job_output', 'job_list',
  'interrupt_agent', 'send_message', 'list_subagent_models',
]
const writePatterns = ['write', 'edit', 'str_replace_editor', 'bash', 'pwsh', 'run_code']
const leadTools = ['orchestrator_route', 'orchestrator_dispatch', 'orchestrator_list', 'orchestrator_get']

const codeForbidden = [...delegationPatterns, ...leadTools]
const readOnlyForbidden = [...writePatterns, ...delegationPatterns, ...leadTools]

export const sceneDefinitions: Record<Scene, SceneDefinition> = {
  code: {
    id: 'code',
    label: '代码执行 Worker',
    persona: '你是代码执行 Worker。只处理 Lead 分配的任务，主动汇报状态，禁止再创建或编排子 Agent。',
    toolFilter: { deny: knownDelegationTools },
    forbidden: codeForbidden,
  },
  general: {
    id: 'general',
    label: '通用执行 Worker',
    persona: '你是通用执行 Worker。只处理 Lead 分配的任务，完成后给出可转述答案，禁止再创建或编排子 Agent。',
    toolFilter: { deny: knownDelegationTools },
    forbidden: codeForbidden,
  },
  research: {
    id: 'research',
    label: '资料调研 Worker',
    persona: '你是资料调研 Worker。只允许网页访问、资料读取和只读搜索；不得写文件、运行命令或创建子 Agent。',
    toolFilter: { allow: readTools },
    allowed: new Set([...readTools, 'task_update']),
    forbidden: readOnlyForbidden,
  },
  review: {
    id: 'review',
    label: '只读审查 Worker',
    persona: '你是只读审查 Worker。只做检查、分析和评审；不得写文件、运行修改命令或创建子 Agent。',
    toolFilter: { allow: readTools },
    allowed: new Set([...readTools, 'task_update']),
    forbidden: readOnlyForbidden,
  },
}

/** 同时识别模型看到的 write 和内部的 tool:write 名称。 */
export function canonicalToolName(name: string): string {
  return name.replace(/^tool:/, '')
}

function matchesAny(name: string, patterns: readonly string[]): boolean {
  const canonical = canonicalToolName(name)
  return patterns.some(pattern => canonical === pattern || canonical.startsWith(`${pattern}_`))
}

export function isForbidden(scene: Scene, toolName: string): string | undefined {
  const definition = sceneDefinitions[scene]
  const canonical = canonicalToolName(toolName)
  if (definition.allowed && !definition.allowed.has(canonical)) {
    return `${definition.label} 禁止使用 ${toolName}`
  }
  if (matchesAny(toolName, definition.forbidden)) {
    return `${definition.label} 禁止使用 ${toolName}`
  }
  return undefined
}
