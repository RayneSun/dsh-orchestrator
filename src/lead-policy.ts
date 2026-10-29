/**
 * 主控（Lead）工具白名单与提示段抑制策略。
 *
 * 主控只做路由、转述和一步轻量查询；浏览器、邮件、桌面操控、记忆写入等
 * 执行能力全部在 Worker 侧。白名单按精确工具名运行时匹配（工具不存在自动跳过），
 * 用户后装的非白名单工具对 Lead 不可见，无需维护黑名单。
 */

export const LEAD_TOOL_ALLOW = [
  'ask_user_question',
  'ask_user',
  // 一步轻量查询
  'web_search',
  'web_fetch',
  'read',
  'glob',
  'grep',
  // 记忆只读（写入全部派发 Worker）
  'memory_search',
  'memory_read',
] as const

/**
 * Lead 会话要遮蔽的全局系统提示段：这些能力对 Worker 有用（手册随工具走），
 * 对只做路由的主控是纯上下文负担。
 */
export const LEAD_SUPPRESSED_SECTIONS = [
  'meow-memory:guide',
  'plugin:dsh-qqmail',
] as const
