/**
 * 统一 Worker 权限策略：
 * 宿主自带与用户自行安装的工具全部可用（文件、命令、网页、浏览器、MCP、技能、
 * 定时任务、子智能体、后台任务等）；只禁高层编排循环（workflow/ralph）、
 * orchestrator 工具和直接向用户提问。
 */

/** 高层编排循环：Worker 内再跑编排会产生失控的嵌套派发。 */
const delegationPatterns = ['workflow', 'ralph']

/** 前缀匹配：Lead 现在和将来新增的全部 orchestrator_* 工具都对 Worker 禁用。 */
const orchestratorPatterns = ['orchestrator']

/** 直接向用户提问的工具：Worker 只能经 task_update(input_required, questions) 由问题卡转达。 */
const questionPatterns = ['ask_user', 'ask_user_question', 'ask-user']

export const workerForbiddenPatterns = [...delegationPatterns, ...orchestratorPatterns]
export const workerQuestionPatterns = questionPatterns

/** 同时识别模型看到的 write 和内部的 tool:write 名称。 */
function canonicalToolName(name: string): string {
  return name.replace(/^tool:/, '')
}

function matchesAny(name: string, patterns: readonly string[]): boolean {
  const canonical = canonicalToolName(name)
  return patterns.some(pattern => canonical === pattern || canonical.startsWith(`${pattern}_`))
}

/** 返回禁止原因；undefined 表示放行。本地 task_update 与用户安装的其他工具均放行。 */
export function isWorkerToolForbidden(toolName: string): string | undefined {
  if (matchesAny(toolName, workerQuestionPatterns)) {
    return `Worker 不能直接向用户提问；请改用 task_update({status:'input_required', questions:[{question:'…', options:[…]}]}) 由问题卡转达`
  }
  if (matchesAny(toolName, workerForbiddenPatterns)) {
    return `执行 Worker 禁止使用编排/派生工具 ${canonicalToolName(toolName)}`
  }
  return undefined
}
