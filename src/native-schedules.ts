/** DSH 原生 schedule 工具与定时消息的最小解析边界。 */

export interface ScheduledTurnContext {
  scheduleIds: string[]
  /** 本轮消息实际进入 Worker 的时间，用于计算单次定时执行耗时。 */
  receivedAt: string
}

function textContent(value: unknown): string {
  const content = (value as { content?: unknown } | null | undefined)?.content
  if (!Array.isArray(content)) return ''
  return content.map(block => {
    const type = (block as { type?: unknown } | null | undefined)?.type
    const text = (block as { text?: unknown } | null | undefined)?.text
    return type === 'text' && typeof text === 'string' ? text : ''
  }).filter(Boolean).join('\n')
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function uniqueIds(values: unknown[]): string[] {
  return [...new Set(values.map(nonEmpty).filter((value): value is string => Boolean(value)))]
}

/** 解析原生 schedule_create 调用，返回用于配对未来 tool/result 的 callId。 */
export function scheduleCreateCallId(data: unknown): string | undefined {
  const value = data as { name?: unknown, callId?: unknown } | null | undefined
  return value?.name === 'schedule_create' ? nonEmpty(value.callId) : undefined
}

/**
 * 解析 schedule_create 结果。即使失败或结果畸形也返回 callId，让调用方清理等待映射；
 * 只有成功且包含合法 id 时才返回 scheduleId。
 */
export function scheduleCreateResult(data: unknown): { callId: string, scheduleId?: string } | undefined {
  const message = (data as { message?: unknown } | null | undefined)?.message as {
    toolCallId?: unknown
    isError?: unknown
  } | undefined
  const callId = nonEmpty(message?.toolCallId)
  if (!callId) return undefined
  if (message?.isError) return { callId }
  const text = textContent(message)
  try {
    const value = JSON.parse(text) as { id?: unknown }
    const scheduleId = nonEmpty(value.id)
    return { callId, ...scheduleId ? { scheduleId } : {} }
  } catch {
    return { callId }
  }
}

/** 解析 DSH 单次/批量定时消息；source.kind=schedule 但结构不合法时返回 undefined。 */
export function parseScheduledTurn(message: unknown, receivedAt: string): ScheduledTurnContext | undefined {
  const source = (message as { source?: { kind?: unknown } } | null | undefined)?.source
  if (source?.kind !== 'schedule') return undefined
  const text = textContent(message)
  if (text.startsWith('[SCHEDULE REMINDER BATCH]')) {
    const match = text.match(/^reminders_json:\s*(.+)$/m)
    if (!match) return undefined
    try {
      const reminders = JSON.parse(match[1]) as Array<{ schedule_id?: unknown }>
      if (!Array.isArray(reminders)) return undefined
      const scheduleIds = uniqueIds(reminders.map(item => item?.schedule_id))
      return scheduleIds.length > 0 ? { scheduleIds, receivedAt } : undefined
    } catch {
      return undefined
    }
  }
  if (!text.startsWith('[SCHEDULE REMINDER]')) return undefined
  const match = text.match(/^schedule_id_json:\s*(.+)$/m)
  if (!match) return undefined
  try {
    const scheduleIds = uniqueIds([JSON.parse(match[1])])
    return scheduleIds.length > 0 ? { scheduleIds, receivedAt } : undefined
  } catch {
    return undefined
  }
}
