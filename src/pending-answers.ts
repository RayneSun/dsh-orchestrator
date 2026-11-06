import type { QuestionAnswer } from './types.ts'

interface PendingAnswer {
  promise: Promise<QuestionAnswer[]>
  resolve(answers: QuestionAnswer[]): void
  reject(error: Error): void
  abort: AbortController
  cleanup(): void
}

export class PendingAnswers {
  private readonly entries = new Map<string, PendingAnswer>()
  private closed = false

  wait(taskId: string, signal?: AbortSignal): Promise<QuestionAnswer[]> {
    if (this.closed) return Promise.reject(new Error('编排服务已停止，等待作答已中断'))
    if (signal?.aborted) return Promise.reject(new Error('任务已中断，停止等待用户作答'))
    const existing = this.entries.get(taskId)
    if (existing) return existing.promise
    let resolve: PendingAnswer['resolve']
    let reject: PendingAnswer['reject']
    const promise = new Promise<QuestionAnswer[]>((accept, decline) => {
      resolve = accept
      reject = decline
    })
    const onAbort = () => this.cancel(taskId, new Error('任务已中断，停止等待用户作答'))
    this.entries.set(taskId, {
      promise, resolve, reject, abort: new AbortController(),
      cleanup: () => signal?.removeEventListener('abort', onAbort),
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    return promise
  }

  signal(taskId: string): AbortSignal | undefined {
    return this.entries.get(taskId)?.abort.signal
  }

  private take(taskId: string): PendingAnswer | undefined {
    const pending = this.entries.get(taskId)
    if (pending) {
      this.entries.delete(taskId)
      pending.cleanup()
      pending.abort.abort()
    }
    return pending
  }

  resolve(taskId: string, answers: QuestionAnswer[]): void {
    this.take(taskId)?.resolve(answers)
  }

  cancel(taskId: string, error: Error): void {
    this.take(taskId)?.reject(error)
  }

  close(): void {
    this.closed = true
    for (const taskId of this.entries.keys()) {
      this.cancel(taskId, new Error('编排服务已停止，等待作答已中断'))
    }
  }
}
