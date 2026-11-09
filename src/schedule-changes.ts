import { createId, scheduleConsistencyError, timestamp, type ConversationRecord, type ScheduleRecord, type TaskScheduleInput } from './types.ts'

export function planScheduleChanges(
  conversation: ConversationRecord,
  input: TaskScheduleInput,
  existing: readonly ScheduleRecord[],
  at = timestamp(),
): ScheduleRecord[] {
  const current = new Map(existing.map(schedule => [schedule.id, schedule]))
  const changes = new Map<string, ScheduleRecord>()
  for (const entry of input.create ?? []) {
    const { priority, allDay, ...content } = entry
    const schedule: ScheduleRecord = {
      id: createId('sch'),
      parentSessionId: conversation.parentSessionId,
      conversationId: conversation.id,
      priority,
      allDay: allDay ?? false,
      links: [], attachments: [], contacts: [],
      ...content,
      status: 'pending',
      createdAt: at,
      updatedAt: at,
    }
    changes.set(schedule.id, schedule)
  }
  for (const entry of input.update ?? []) {
    const schedule = current.get(entry.id)
    if (!schedule || schedule.conversationId !== conversation.id) {
      throw new Error(`schedule not found in this conversation: ${entry.id}`)
    }
    const { id, status, ...patch } = entry
    const merged = { ...schedule, ...patch }
    const inconsistency = scheduleConsistencyError(merged)
    if (inconsistency) throw new Error(`schedule ${id}: ${inconsistency}`)
    const updated: ScheduleRecord = {
      ...merged,
      ...status !== undefined
        ? { status, completedBy: status !== 'pending' ? 'worker' as const : undefined }
        : {},
      updatedAt: at,
    }
    current.set(id, updated)
    changes.set(id, updated)
  }
  return [...changes.values()]
}
