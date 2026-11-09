import { setTimeout } from 'node:timers/promises'

/** 使用原生接口，目录与配置解析全部由记忆插件负责；启动竞态时重试整组幂等设置。 */
export async function configureLeadMemory(sessionId: string, origin: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    const results = await Promise.allSettled(Object.entries({ write: true, dream: true, inject: false }).map(async ([field, value]) => {
      const response = await fetch(new URL('/dsh-personal-memory/skip-dreams', origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, field, value }),
        signal: AbortSignal.timeout(5_000),
      })
      const result = await response.json()
      if (!response.ok || result.ok !== true) {
        throw new Error(`记忆会话门控 ${field} 设置失败（HTTP ${response.status}）：${result.error ?? '未知错误'}`)
      }
    }))
    const failure = results.find(result => result.status === 'rejected')
    if (!failure) return
    if (attempt === 2) throw failure.reason
    await setTimeout(100 * (attempt + 1))
  }
}
