import { describe, expect, it } from 'vitest'
import { buildPresetDefinitions, LEAD_PRESET, LEAD_TOOL_DENY, WORKER_PRESET } from '../src/presets.ts'

describe('Orchestrator agent presets', () => {
  const presets = buildPresetDefinitions()
  const byId = new Map(presets.map(preset => [preset.id, preset]))

  it('注册 Lead 和四个 Worker 预设', () => {
    expect(presets.map(preset => preset.id)).toEqual([
      LEAD_PRESET,
      WORKER_PRESET.code,
      WORKER_PRESET.general,
      WORKER_PRESET.research,
      WORKER_PRESET.review,
    ])
  })

  it('Lead 隐藏直接网页工具，强制通过 research Worker 联网', () => {
    expect([...LEAD_TOOL_DENY]).toEqual(['web_search', 'web_fetch'])
  })

  it('每个 agent-instructions 行都提供必需的 maxBytes', () => {
    for (const preset of presets) {
      const rows = preset.plugins.filter(row => row.name === '@deepseek-ai/dsh-agent-instructions')
      expect(rows).toHaveLength(1)
      expect(rows[0]!.config).toMatchObject({ maxBytes: 65536 })
    }
  })

  it('压缩插件放在独立 isolate group 中', () => {
    for (const preset of presets) {
      const group = preset.plugins.find(row => row.id === 'compaction')
      expect(group).toMatchObject({
        name: 'cordis:group',
        group: true,
        isolate: { compaction: true, toolResultPruner: true },
      })
      expect(Array.isArray(group!.config)).toBe(true)
    }
  })

  it('只读 Worker 不组合 shell，执行 Worker 才组合 bash/pwsh', () => {
    const names = (id: string) => new Set(byId.get(id)!.plugins.map(row => row.name))
    expect(names(WORKER_PRESET.research)).not.toContain('@deepseek-ai/dsh-tool-bash')
    expect(names(WORKER_PRESET.review)).not.toContain('@deepseek-ai/dsh-tool-pwsh')
    expect(names(WORKER_PRESET.code)).toContain('@deepseek-ai/dsh-tool-fs')
    expect(names(WORKER_PRESET.general)).toContain('@deepseek-ai/dsh-tool-web')
  })
})
