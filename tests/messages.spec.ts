import { describe, expect, it } from 'vitest'
import { LEAD_PROMPT, rosterSummarySegment, WORKER_PROMPT } from '../src/messages.ts'

describe('roster 摘要段', () => {
  it('空摘要/纯空白不产生片段', () => {
    expect(rosterSummarySegment(undefined)).toBe('')
    expect(rosterSummarySegment('   ')).toBe('')
  })

  it('60 字以内原样输出，超长截断并加省略号', () => {
    expect(rosterSummarySegment('做一个飞机大战游戏')).toBe('｜摘要 做一个飞机大战游戏')
    const long = '长'.repeat(80)
    expect(rosterSummarySegment(long)).toBe(`｜摘要 ${'长'.repeat(60)}…`)
  })
})

describe('prompt 编排约定', () => {
  it('Lead prompt 约定定时任务编排与 subject 改名', () => {
    expect(LEAD_PROMPT).toContain('schedule_create 绑定它自己的会话')
    expect(LEAD_PROMPT).toContain('subject 写成新主题')
    expect(LEAD_PROMPT).toContain('优先复用其 conversationId')
  })

  it('Worker prompt 约定重复模式主动建议定时任务', () => {
    expect(WORKER_PROMPT).toContain('反复定期出现')
    expect(WORKER_PROMPT).toContain('schedule_create 绑定本会话')
  })
})
