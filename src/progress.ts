import type { ProgressStep } from './types.ts'

export const MAX_PROGRESS_STEPS = 50

/** 将 DSH 内置 todo_write 的 todo/write 载荷收敛为 TaskRun 可持久化的步骤快照。 */
export function normalizeProgressSteps(raw: unknown): ProgressStep[] {
  if (!Array.isArray(raw)) return []
  const steps: ProgressStep[] = []
  for (const item of raw.slice(0, MAX_PROGRESS_STEPS)) {
    if (!item || typeof item !== 'object') continue
    const candidate = item as { content?: unknown; status?: unknown }
    if (typeof candidate.content !== 'string' || typeof candidate.status !== 'string') continue
    const content = candidate.content.trim().slice(0, 300)
    const status = candidate.status
    if (!content) continue
    if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') continue
    steps.push({ content, status })
  }
  return steps
}
