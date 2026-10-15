import { describe, expect, it } from 'vitest'
import { createConversation } from '../src/types.ts'
import { routeQuery } from '../src/router.ts'

function weatherConv() {
  const conv = createConversation({
    id: 'conv_weather', childSessionId: 'child-weather', parentSessionId: 'parent',
    title: '查询今天天气',
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


describe('追问和不同主题路由', () => {
  it('代码报错的后续重构请求命中同一代码工作流', () => {
    const conv = createConversation({
      id: 'conv_code', childSessionId: 'child-code', parentSessionId: 'parent',
      title: '修复 TypeScript 编译错误',
    })
    conv.outline.summary = '修复测试中的类型错误并保证 build 通过'
    conv.outline.tags = ['TypeScript', '编译', '测试']
    const candidates = routeQuery('那顺手重构一下相关测试', [conv])
    expect(candidates[0]?.conversation.id).toBe('conv_code')
  })

  it('天气工作流不会承接午餐预算问题', () => {
    expect(routeQuery('帮我规划午餐预算', [weatherConv()])).toHaveLength(0)
  })
})

describe('短追问与运行中工作流的兜底路由', () => {
  function runningConv() {
    const conv = createConversation({
      id: 'conv_only', childSessionId: 'child', parentSessionId: 'parent',
      title: '开发飞机大战游戏',
    })
    conv.outline.summary = ''
    return { ...conv, state: 'running' as const }
  }

  it('纯词法 0 命中时，唯一工作流兜底返回', () => {
    const candidates = routeQuery('不是星空背景，我要白天背景', [runningConv()])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]!.conversation.id).toBe('conv_only')
    expect(candidates[0]!.reasons[0]).toContain('兜底')
  })

  it('多个工作流且都不相关时不兜底', () => {
    const other = { ...runningConv(), id: 'conv_other' }
    const candidates = routeQuery('完全无关的事情', [runningConv(), other])
    expect(candidates).toHaveLength(0)
  })
})
