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
  // dsh-genui：卡片走 task_update 的 report.card，Lead/Worker 不直接渲染或验证围栏
  'render_ui',
  'validate_dsh_ui',
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
  'screen_observe',
  'screen_zoom',
  'computer_click',
  'computer_double_click',
  'computer_right_click',
  'computer_type',
  'computer_key',
  'computer_scroll',
  'computer_drag',
  'computer_wait',
  'app_list',
  'app_launch',
  'browser_session',
  'browser_page',
  'browser_inspect',
  'browser_interact',
  'browser_tabs',
  'browser_assist',
] as const

/**
 * DSH 自带全局工具基线快照（2026-11-06 源码枚举，57 个）。
 * 用途：Lead 挂载时对比当前注册表——出现在注册表但既不在基线、也未命中 deny
 * 的名字 = 新装第三方插件（或 DSH 新增自带工具），打 warn 提醒复查
 * LEAD_TOOL_DENY。本清单只在"发现变化 → 确认归属"时更新，不参与过滤。
 */
export const DSH_CORE_TOOL_BASELINE: readonly string[] = [
  'ask_user_question', 'bash', 'cordis_inspect_list', 'cordis_inspect_query', 'create_goal',
  'create_worktree', 'edit', 'get_goal', 'glob', 'grep', 'interrupt_agent', 'job_kill',
  'job_list', 'job_output', 'list_agents', 'list_mcp_resource_templates', 'list_mcp_resources',
  'list_subagent_models', 'load_workspace_dependencies', 'plugin_manager', 'plugin_market', 'present', 'pwsh', 'ralph', 'read',
  'read_image', 'read_mcp_resource', 'schedule_create', 'schedule_delete', 'schedule_list',
  'schedule_update', 'send_message', 'session_event_read', 'session_event_search',
  'session_event_trace', 'session_search', 'session_trace', 'skill', 'spawn_teammate',
  'str_replace_editor', 'team_task_create', 'team_task_get', 'team_task_list',
  'team_task_update', 'terminal_close', 'terminal_list', 'terminal_open', 'terminal_read',
  'terminal_send', 'terminal_signal', 'todo_write', 'update_goal', 'wait_agent', 'web_fetch',
  'web_search', 'working_directory', 'write',
]

/** 基线外的有意保留项：meow 影子只读（Lead 侧复刻实现，不依赖全局注册）。 */
export const LEAD_TOOL_KEEP: readonly string[] = ['memory_search', 'memory_read']

/** 浏览器操控类前缀兜底（browser-skill / ego-browser，未激活也不怕将来出现）。 */
const LEAD_TOOL_DENY_PREFIXES = /^(bsk|ego)_/

/** 工具名是否命中 deny：精确名单或浏览器操控类前缀。 */
function isDeniedTool(name: string): boolean {
  return (LEAD_TOOL_DENY as readonly string[]).includes(name) || LEAD_TOOL_DENY_PREFIXES.test(name)
}

/**
 * 计算要 deny 的工具名：精确名单 ∩ 当前注册集合，加上命中前缀的注册工具。
 * restrict 只接受已注册的全局工具名，必须先按运行时注册表过滤。
 */
export function leadToolDenyList(registeredNames: readonly string[]): string[] {
  return registeredNames.filter(isDeniedTool)
}

/**
 * 陌生工具检测：注册表中不在自带基线/keep、也不命中 deny 名单/前缀的名字。
 * 这些工具当前对 Lead 可见——新装第三方插件会走到这里，触发 warn 提醒。
 */
export function unrecognizedGlobalTools(registeredNames: readonly string[]): string[] {
  const known = new Set([...DSH_CORE_TOOL_BASELINE, ...LEAD_TOOL_KEEP])
  return registeredNames.filter(name => !known.has(name) && !isDeniedTool(name))
}

/**
 * Lead 会话要遮蔽的全局系统提示段：这些能力对 Worker 有用（手册随工具走），
 * 对只做路由的主控是纯上下文负担。
 */
export const LEAD_SUPPRESSED_SECTIONS = [
  'meow-memory:guide',
  'plugin:dsh-qqmail',
  'genui:fence',
  'harness:source',
  'app:web-surface',
  'ui:deliverable-file-references',
] as const
