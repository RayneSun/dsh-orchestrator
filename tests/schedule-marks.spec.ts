import { describe, expect, it } from 'vitest'
import { applyScheduleMark, SCHEDULE_MARK_PREFIX } from '../src/schedule-marks.ts'

describe('定时任务标题标记', () => {
  it('marked 时加 ⏰ 前缀，幂等不重复', () => {
    expect(applyScheduleMark('每日热点', true)).toBe(`${SCHEDULE_MARK_PREFIX}每日热点`)
    expect(applyScheduleMark(`${SCHEDULE_MARK_PREFIX}每日热点`, true)).toBe(`${SCHEDULE_MARK_PREFIX}每日热点`)
  })

  it('unmarked 时去除前缀，无前缀时原样返回', () => {
    expect(applyScheduleMark(`${SCHEDULE_MARK_PREFIX}每日热点`, false)).toBe('每日热点')
    expect(applyScheduleMark('每日热点', false)).toBe('每日热点')
  })

  it('标题中间出现的 ⏰ 图案不受影响，只处理前缀', () => {
    expect(applyScheduleMark('监控⏰报警', false)).toBe('监控⏰报警')
    expect(applyScheduleMark('监控⏰报警', true)).toBe(`${SCHEDULE_MARK_PREFIX}监控⏰报警`)
  })
})
