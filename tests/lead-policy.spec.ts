import { describe, expect, it } from 'vitest'
import { LEAD_SUPPRESSED_SECTIONS, LEAD_TOOL_ALLOW } from '../src/lead-policy.ts'

describe('Lead 工具白名单与提示段抑制', () => {
  it('只保留提问、一步查询与记忆只读', () => {
    expect([...LEAD_TOOL_ALLOW].sort()).toEqual([
      'ask_user', 'ask_user_question',
      'glob', 'grep', 'memory_read', 'memory_search', 'read', 'web_fetch', 'web_search',
    ])
  })

  it('白名单不含任何写入与执行类工具', () => {
    for (const name of LEAD_TOOL_ALLOW) {
      expect(name).not.toMatch(/memory_remember|memory_update|memory_dream|memory_home|memory_project/)
      expect(name).not.toMatch(/browser|qqmail|computer|bash|write|edit/)
    }
  })

  it('遮蔽 meow 记忆手册与 qqmail 公告段', () => {
    expect(LEAD_SUPPRESSED_SECTIONS).toContain('meow-memory:guide')
    expect(LEAD_SUPPRESSED_SECTIONS).toContain('plugin:dsh-qqmail')
  })
})
