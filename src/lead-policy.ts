import type { Agent } from '@deepseek-ai/dsh-agent'
import { setTimeout } from 'node:timers/promises'
import { leadCapabilities } from './capabilities.ts'

/** 固定继承工具 allow；自身 scope 的编排和增强提问不属于限制对象。 */
export function leadToolAllowList(memoryAvailable: boolean): string[] {
  return leadCapabilities.flatMap(capability => capability.optional && !memoryAvailable ? [] : [...capability.tools])
}

/** 首方能力必须完整；异常退化为仅保留自身工具的路由会话。 */
export async function installLeadToolPolicy(agent: Agent, memoryAvailable: boolean, warn: (message: string) => void): Promise<() => unknown> {
  const allow = leadToolAllowList(memoryAvailable)
  for (let attempt = 0; ; attempt++) {
    try {
      // restrict 用过滤前的继承名校验，旧掩码无需先释放，也不枚举第三方工具。
      return agent.ctx.tools.restrict({ allow })
    } catch (error) {
      if (attempt < 2) { await setTimeout(50); continue }
      warn(`orchestrator: Lead tool policy degraded to routing only: ${String(error)}`)
      // 空 allow 也失败则向上传播；不能用 guard 充当隐藏。
      return agent.ctx.tools.restrict({ allow: [] })
    }
  }
}
