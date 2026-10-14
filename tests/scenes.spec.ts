import { describe, expect, it } from 'vitest'
import { isForbidden, sceneDefinitions } from '../src/scenes.ts'

describe('Worker 场景权限', () => {
  it.each(['research', 'review'] as const)('%s 拒绝写入、命令、PTC 和派孙任务', (scene) => {
    for (const name of ['write', 'edit', 'bash', 'pwsh', 'run_code', 'subagent', 'workflow']) {
      expect(isForbidden(scene, name)).toContain(name)
    }
  })

  it('code 允许读写测试但拒绝派生 Agent', () => {
    expect(isForbidden('code', 'write')).toBeUndefined()
    expect(isForbidden('code', 'bash')).toBeUndefined()
    expect(isForbidden('code', 'subagent')).toBeDefined()
    expect(isForbidden('code', 'workflow')).toBeDefined()
  })

  it('只读场景的硬 guard 允许本地 task_update，但不把它放进全局 allow', () => {
    expect(sceneDefinitions.research.toolFilter.allow).not.toContain('task_update')
    expect(isForbidden('research', 'task_update')).toBeUndefined()
    expect(isForbidden('review', 'task_update')).toBeUndefined()
  })
})
