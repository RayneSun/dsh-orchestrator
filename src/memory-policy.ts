import { setTimeout } from 'node:timers/promises'

/**
 * 使用原生接口，目录与配置解析全部由记忆插件负责；启动竞态时重试整组幂等设置。
 * 返回 false 仅表示插件未启用；插件已启用但门控失败时仍抛错，不能默默放开写入。
 */
export async function configureLeadMemory(sessionId: string, origin: string): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    const results = await Promise.allSettled(Object.entries({ write: true, dream: true, inject: false }).map(async ([field, value]) => {
      const response = await fetch(new URL('/dsh-personal-memory/skip-dreams', origin), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId, field, value }),
        signal: AbortSignal.timeout(5_000),
      })
      const body = await response.text()
      // 插件禁用后宿主对未知路由返回 404/405 空响应；原生插件的错误始终为 JSON。
      if (!body && (response.status === 404 || response.status === 405)) return false
      let result: { ok?: boolean, error?: string }
      try { result = JSON.parse(body) }
      catch { throw new Error(`记忆会话门控 ${field} 返回了无效 JSON（HTTP ${response.status}）`) }
      if (!response.ok || result.ok !== true) {
        throw new Error(`记忆会话门控 ${field} 设置失败（HTTP ${response.status}）：${result.error ?? '未知错误'}`)
      }
      return true
    }))
    const failure = results.find(result => result.status === 'rejected')
    if (!failure) return results.every(result => result.status === 'fulfilled' && result.value)
    if (attempt === 2) throw failure.reason
    await setTimeout(100 * (attempt + 1))
  }
}
