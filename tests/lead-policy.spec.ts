import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { DSH_CORE_TOOL_BASELINE, LEAD_SUPPRESSED_SECTIONS, LEAD_TOOL_DENY, LEAD_TOOL_KEEP, leadToolDenyList, unrecognizedGlobalTools } from '../src/lead-policy.ts'

describe('Lead 工具黑名单与提示段抑制', () => {
  it('当前 vendored macOS 工具全部对 Lead 隐藏', () => {
    const source = readFileSync(new URL('../vendor/dsh-computer-use-darwin/index.js', import.meta.url), 'utf8')
    const names = [...source.matchAll(/defineTool\(\{\s*name: '([^']+)'/g)].map(match => match[1])
    expect(names).toHaveLength(12)
    expect(leadToolDenyList(names)).toEqual(names)
    expect(unrecognizedGlobalTools(names)).toEqual([])
  })
  it('deny 只含第三方执行类：个人记忆写/管理、qqmail 全家桶、桌面操控', () => {
    expect([...LEAD_TOOL_DENY].sort()).toEqual([
      'click', 'drag', 'get_app_state', 'list_apps', 'memory_dream', 'memory_find_similar', 'memory_home',
      'memory_project', 'memory_remember', 'memory_update', 'perform_secondary_action', 'press_key',
      'qqmail_attachment', 'qqmail_config', 'qqmail_delete', 'qqmail_folders', 'qqmail_list', 'qqmail_mark',
      'qqmail_move', 'qqmail_read', 'qqmail_reply', 'qqmail_search', 'qqmail_send', 'qqmail_status',
      'render_ui', 'scroll', 'select_text', 'set_value', 'type_text', 'validate_dsh_ui',
      'screen_observe', 'screen_zoom', 'computer_click', 'computer_double_click', 'computer_right_click',
      'computer_type', 'computer_key', 'computer_scroll', 'computer_drag', 'computer_wait', 'app_list', 'app_launch',
      'browser_session', 'browser_page', 'browser_inspect', 'browser_interact', 'browser_tabs', 'browser_assist',
    ].sort())
  })

  it('deny 名单不含 DSH 自带基线工具与记忆只读', () => {
    for (const name of LEAD_TOOL_DENY) {
      expect(DSH_CORE_TOOL_BASELINE).not.toContain(name)
    }
    expect(LEAD_TOOL_DENY).not.toContain('memory_search')
    expect(LEAD_TOOL_DENY).not.toContain('memory_read')
    expect(LEAD_TOOL_DENY).not.toContain('ask_user_question')
  })

  it('陌生工具巡检：基线外且未命中 deny 的名字被报告', () => {
    const registered = [...DSH_CORE_TOOL_BASELINE, 'memory_search', 'memory_read', 'some_new_plugin_tool', 'bsk_x']
    expect(unrecognizedGlobalTools(registered)).toEqual(['some_new_plugin_tool'])
    expect(unrecognizedGlobalTools([...DSH_CORE_TOOL_BASELINE, 'memory_search', 'memory_read'])).toEqual([])
  })

  it('keep 集不与基线/deny 重叠', () => {
    for (const name of LEAD_TOOL_KEEP) {
      expect(DSH_CORE_TOOL_BASELINE).not.toContain(name)
      expect(LEAD_TOOL_DENY).not.toContain(name)
    }
  })

  it('leadToolDenyList 按注册表过滤并按前缀兜底浏览器操控', () => {
    const registered = [
      'bash', 'read', 'web_search', // 自带：不 deny
      'memory_search', 'memory_read', // 个人记忆只读：保留
      'memory_remember', 'qqmail_send', 'click', // 第三方精确名
      'bsk_navigate', 'ego_click', // 前缀兜底
      'some_future_plugin_tool', // 陌生第三方：不拦（prompt 引导兜底）
    ]
    expect(leadToolDenyList(registered).sort()).toEqual([
      'bsk_navigate', 'click', 'ego_click', 'memory_remember', 'qqmail_send',
    ])
  })

  it('遮蔽 个人记忆写入手册与 qqmail 公告段', () => {
    expect(LEAD_SUPPRESSED_SECTIONS).toContain('dsh-personal-memory:guide')
    expect(LEAD_SUPPRESSED_SECTIONS).toContain('plugin:dsh-qqmail')
    expect(LEAD_SUPPRESSED_SECTIONS).not.toContain('ui:deliverable-file-references')
    expect(LEAD_TOOL_DENY).not.toContain('present')
  })
})
