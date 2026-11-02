import { describe, expect, it } from 'vitest'
import { orchestratorDomain } from '../src/storage.ts'

// v1→v2 迁移依赖平台 bootstrapLegacyUnit：它只在 per-record 布局下生效
// （single 布局的 openUnit 严格匹配版本，会把 v1 单文件直接拒开）。
describe('orchestrator 存储域', () => {
  it('per-record 布局 + 兼容 v1（防迁移路径回归）', () => {
    expect(orchestratorDomain.version).toBe(2)
    expect(orchestratorDomain.layout).toBe('per-record')
    expect(orchestratorDomain.compatibleVersions).toContain(1)
    expect(Object.keys(orchestratorDomain.tables)).toEqual(['conversations', 'tasks', 'schedules'])
  })
})
