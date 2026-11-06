import { activeTaskStatuses, type TaskStatus } from './types.ts'

export function isUnfinishedTask(status: TaskStatus): boolean {
  return status === 'input_required' || (activeTaskStatuses as readonly TaskStatus[]).includes(status)
}
