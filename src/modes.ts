import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'

interface ExecutionModeDefinition {
  id: string
  name: string
  preset: string
  description: string
  /** 省略时使用通用 Worker 提示；专用模式可替换 persona 并追加能力。 */
  prompt?: string
  plugins?: PresetDefinition['plugins']
}

/** 执行模式仅描述能力组合；调度、提问、定时和交付共用 Worker 生命周期。 */
export const executionModes: readonly ExecutionModeDefinition[] = [
  { id: 'general', name: '通用执行', preset: 'may-orchestrator-worker', description: '文件、开发、联网、文档、可视化与定时任务' },
]

export const executionModeIds = executionModes.map(mode => mode.id)
export type ExecutionMode = typeof executionModes[number]['id']

export function executionMode(id: string) {
  const mode = executionModes.find(mode => mode.id === id)
  if (!mode) throw new Error(`执行模式不可用：${id}`)
  return mode
}

export function resolveExecutionMode(requested?: string, saved?: string): ExecutionMode {
  const mode = executionMode(saved ?? requested ?? 'general')
  if (requested !== undefined && requested !== mode.id) throw new Error(`不能变更已有会话的执行模式：${mode.id} → ${requested}`)
  return mode.id
}
