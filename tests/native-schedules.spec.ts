import { describe, expect, it } from 'vitest'
import { parseScheduledTurn, scheduleCreateCallId, scheduleCreateResult } from '../src/native-schedules.ts'

function message(text: string, kind = 'schedule') {
  return { source: { kind }, content: [{ type: 'text', text }] }
}

function result(text: string, isError = false) {
  return { message: { toolCallId: 'call-1', isError, content: [{ type: 'text', text }] } }
}

describe('原生 schedule 消息解析', () => {
  it('解析单条定时消息', () => {
    expect(parseScheduledTurn(message('[SCHEDULE REMINDER]\nschedule_id_json: "schedule-a"\nprompt: 执行'), '2026-11-12T08:00:00.000Z'))
      .toEqual({ scheduleIds: ['schedule-a'], receivedAt: '2026-11-12T08:00:00.000Z' })
  })

  it('解析批量定时消息并去重来源', () => {
    const text = '[SCHEDULE REMINDER BATCH]\nreminders_json: [{"schedule_id":"a"},{"schedule_id":"b"},{"schedule_id":"a"}]'
    expect(parseScheduledTurn(message(text), 'now')).toEqual({ scheduleIds: ['a', 'b'], receivedAt: 'now' })
  })

  it.each([
    '[SCHEDULE REMINDER]\nschedule_id_json: 不是 JSON',
    '[SCHEDULE REMINDER BATCH]\nreminders_json: {}',
    '[SCHEDULE REMINDER BATCH]\nreminders_json: [{"id":"missing"}]',
    '普通消息',
  ])('拒绝畸形定时消息：%s', text => {
    expect(parseScheduledTurn(message(text), 'now')).toBeUndefined()
  })

  it('普通用户消息不生成定时上下文', () => {
    expect(parseScheduledTurn(message('[SCHEDULE REMINDER]\nschedule_id_json: "a"', 'orchestrator'), 'now')).toBeUndefined()
  })
})

describe('原生 schedule_create 调用配对', () => {
  it('只捕获 schedule_create 的 callId', () => {
    expect(scheduleCreateCallId({ name: 'schedule_create', callId: 'call-1' })).toBe('call-1')
    expect(scheduleCreateCallId({ name: 'schedule_delete', callId: 'call-1' })).toBeUndefined()
    expect(scheduleCreateCallId({ name: 'schedule_create' })).toBeUndefined()
  })

  it('从成功结果提取真实 scheduleId', () => {
    expect(scheduleCreateResult(result('{"id":"schedule-a","enabled":true}')))
      .toEqual({ callId: 'call-1', scheduleId: 'schedule-a' })
  })

  it('失败或畸形结果仍返回 callId 供清理', () => {
    expect(scheduleCreateResult(result('{"id":"schedule-a"}', true))).toEqual({ callId: 'call-1' })
    expect(scheduleCreateResult(result('not json'))).toEqual({ callId: 'call-1' })
    expect(scheduleCreateResult({ message: { content: [] } })).toBeUndefined()
  })
})
