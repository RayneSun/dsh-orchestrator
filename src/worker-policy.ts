/**
 * 统一 Worker 权限策略：
 * 除“再派生/编排子智能体”相关工具外，宿主自带与用户自行安装的工具全部可用
 * （文件、命令、网页、浏览器、MCP、技能、定时任务等）。
 */
const delegationPatterns = [
  'subagent',
  'workflow',
  'ralph',
  'interrupt_agent',
  'send_message',
  'list_subagent_models',
]

const questionPatterns = ['ask_user', 'ask_user_question', 'ask-user']

const orchestratorPatterns = [
  'orchestrator_route',
  'orchestrator_dispatch',
  'orchestrator_list',
  'orchestrator_get',
]

export const workerForbiddenPatterns = [...delegationPatterns, ...questionPatterns, ...orchestratorPatterns]

/** 同时识别模型看到的 write 和内部的 tool:write 名称。 */
export function canonicalToolName(name: string): string {
  return name.replace(/^tool:/, '')
}

function matchesAny(name: string, patterns: readonly string[]): boolean {
  const canonical = canonicalToolName(name)
  return patterns.some(pattern => canonical === pattern || canonical.startsWith(`${pattern}_`))
}

/** 返回禁止原因；undefined 表示放行。本地 task_update 与用户安装的其他工具均放行。 */
export function isWorkerToolForbidden(toolName: string): string | undefined {
  const canonical = canonicalToolName(toolName)
  if (matchesAny(toolName, questionPatterns)) {
    return `Worker 不能直接向用户提问；请改用 task_update({status:'input_required', question:'需要向用户确认的问题'}) 由 Lead 转达`
  }
  if (matchesAny(toolName, workerForbiddenPatterns)) {
    return `执行 Worker 禁止使用编排/派生工具 ${canonical}`
  }
  return undefined
}
