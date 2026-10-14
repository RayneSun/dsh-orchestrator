import { describe, expect, it } from 'vitest'
import { isForbidden, sceneDefinitions } from '../src/scenes.ts'

describe('Worker 场景权限', () => {
  it.each(['research', 'review'] as const)('%s 拒绝写入、命令、PTC 和派孙任务', (scene) => {
    for (const name of ['write', 'edit', 'tool:write', 'bash', 'pwsh', 'run_code', 'subagent', 'subagent_spawn', 'workflow', 'job_create', 'send_message']) {
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


describe('Worker 场景白名单边界', () => {
  it.each(['research', 'review'] as const)('%s 只放行只读全局工具和本地 task_update', (scene) => {
    for (const name of ['read', 'read_image', 'glob', 'grep', 'web_search', 'web_fetch', 'task_update']) {
      expect(isForbidden(scene, name)).toBeUndefined()
    }
    for (const name of ['ask_user', 'mcp__writer__update', 'str_replace_editor']) {
      expect(isForbidden(scene, name)).toBeDefined()
    }
  })

  it('code 可使用文件和命令工具，但不能派孙任务或调用 Lead 工具', () => {
    expect(isForbidden('code', 'str_replace_editor')).toBeUndefined()
    expect(isForbidden('code', 'job_create')).toBeDefined()
    expect(isForbidden('code', 'orchestrator_dispatch')).toBeDefined()
    expect(isForbidden('general', 'send_message')).toBeDefined()
  })
})
