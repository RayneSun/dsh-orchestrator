/**
 * 主控（Lead）工具黑名单与提示段抑制策略。
 *
 * 主控保留 DSH 自带的全局工具（自带工具升级新增对 Lead 自动可见），只屏蔽
 * 第三方执行类工具：meow 记忆写/管理（只读 search/read 保留）、qqmail 全家桶、
 * 桌面/浏览器操控。执行能力全部在 Worker 侧。deny 按精确名运行时匹配
 * （未注册的自动跳过），另按前缀兜底浏览器操控类（bsk_* / ego_*）。
 */

export const LEAD_TOOL_DENY = [
  // meow-memory：只保留 search / read，写与管理全部 Worker 侧
  'memory_remember',
  'memory_update',
  'memory_home',
  'memory_project',
  'memory_dream',
  'memory_find_similar',
  // qqmail：收发管理都在 Worker
  'qqmail_send',
  'qqmail_reply',
  'qqmail_list',
  'qqmail_read',
  'qqmail_search',
  'qqmail_folders',
  'qqmail_attachment',
  'qqmail_move',
  'qqmail_mark',
  'qqmail_delete',
  'qqmail_config',
  'qqmail_status',
  // 桌面操控（dsh-computer-use）
  'click',
  'drag',
  'get_app_state',
  'list_apps',
  'perform_secondary_action',
  'press_key',
  'scroll',
  'select_text',
  'set_value',
  'type_text',
] as const

/** 浏览器操控类前缀兜底（browser-skill / ego-browser，未激活也不怕将来出现）。 */
const LEAD_TOOL_DENY_PREFIXES = /^(bsk|ego)_/

/**
 * 计算要 deny 的工具名：精确名单 ∩ 当前注册集合，加上命中前缀的注册工具。
 * restrict 只接受已注册的全局工具名，必须先按运行时注册表过滤。
 */
export function leadToolDenyList(registeredNames: readonly string[]): string[] {
  return registeredNames.filter(name =>
    (LEAD_TOOL_DENY as readonly string[]).includes(name) || LEAD_TOOL_DENY_PREFIXES.test(name))
}

/**
 * Lead 会话要遮蔽的全局系统提示段：这些能力对 Worker 有用（手册随工具走），
 * 对只做路由的主控是纯上下文负担。
 */
export const LEAD_SUPPRESSED_SECTIONS = [
  'meow-memory:guide',
  'plugin:dsh-qqmail',
] as const
