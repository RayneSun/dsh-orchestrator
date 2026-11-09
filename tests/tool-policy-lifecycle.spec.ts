import { expect, it } from 'vitest'
import { OrchestratorService } from '../src/service.ts'
import { leadToolDenyList } from '../src/lead-policy.ts'

// 重现记忆插件晚注册：作用域限制也广播 tools/change，不能递归或漏掉新工具。
it('全局工具晚注册后从 Lead 隐藏，查询保持可见，卸载释放限制', () => {
  const names = ['read', 'memory_search', 'memory_read']
  const listeners = new Set<() => void>()
  const filters = new Set<{ deny: string[] }>()
  const changed = () => { for (const listener of listeners) listener() }
  const service = Object.create(OrchestratorService.prototype)
  const agent = { session: { id: 'lead' }, ctx: { tools: {
    restrict: (filter: { deny: string[] }) => {
      filters.add(filter)
      changed()
      return () => { filters.delete(filter); changed() }
    },
  } } }
  Object.assign(service, {
    installed: new Map(), todoTimers: new Map(), pendingTodoSteps: new Map(),
    hostCtx: {
      get: () => ({ schemas: () => names.map(name => ({ name })) }),
      on: (_event: string, listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener) },
      logger: { warn() {} },
    },
  })
  service.watchToolPolicy(agent, leadToolDenyList)
  names.push('memory_remember')
  changed()
  expect([...filters]).toEqual([{ deny: ['memory_remember'] }])
  names.push('memory_dream')
  changed()
  expect([...filters]).toEqual([{ deny: ['memory_dream', 'memory_remember'] }])
  expect([...filters][0].deny).not.toContain('memory_search')
  return service.resetInstalled('lead').then(() => {
    expect(filters.size).toBe(0)
    expect(listeners.size).toBe(0)
  })
})
