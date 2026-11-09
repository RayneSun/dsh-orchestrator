import { describe, expect, it } from 'vitest'
import { orchestratorDomain } from '../src/storage.ts'

describe('orchestrator 存储域', () => {
  it('v3 拍平存储不接纳旧版本，三张独立表保持 per-record 布局', () => {
    expect(orchestratorDomain.version).toBe(3)
    expect(orchestratorDomain.layout).toBe('per-record')
    expect(orchestratorDomain).not.toHaveProperty('compatibleVersions')
    expect(Object.keys(orchestratorDomain.tables)).toEqual(['conversations', 'tasks', 'schedules'])
  })
})
