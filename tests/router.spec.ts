import { describe, expect, it } from 'vitest'
import { createConversation } from '../src/types.ts'
import { routeQuery } from '../src/router.ts'

function weatherConv() {
  const conv = createConversation({
    id: 'conv_weather', childSessionId: 'child-weather', parentSessionId: 'parent',
    scene: 'research', title: '查询今天天气',
  })
  return {
    ...conv,
    outline: {
      ...conv.outline,
      summary: '查询本地天气、温度和降雨概率',
      entities: ['天气'], tags: ['天气', 'weather'], keyFacts: ['今天有小雨'],
    },
  }
}

describe('词法路由', () => {
  it('天气后的穿衣追问命中同一工作流', () => {
    const candidates = routeQuery('适合穿什么衣服呢', [weatherConv()])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.conversation.id).toBe('conv_weather')
  })

  it('无关代码问题不命中天气工作流', () => {
    const candidates = routeQuery('请修复这个 TypeScript 编译错误', [weatherConv()])
    expect(candidates).toHaveLength(0)
  })
})
