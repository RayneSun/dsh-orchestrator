import { describe, expect, it } from 'vitest'
import { buildPresetDefinitions, LEAD_PRESET, LEAD_TOOL_ALLOW, WORKER_PRESET } from '../src/presets.ts'

describe('Orchestrator agent presets', () => {
  const presets = buildPresetDefinitions()
  const byId = new Map(presets.map(preset => [preset.id, preset]))

  it('注册 Lead 和唯一的统一 Worker 预设', () => {
    expect(presets.map(preset => preset.id)).toEqual([LEAD_PRESET, WORKER_PRESET])
  })

  it('Lead 全局工具白名单只保留向用户提问', () => {
    expect(LEAD_TOOL_ALLOW).toContain('ask_user_question')
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

  it('统一 Worker 组合完整执行工具集，且不组合任何派生/编排插件', () => {
    const names = new Set(byId.get(WORKER_PRESET)!.plugins.map(row => row.name))
    for (const name of [
      '@deepseek-ai/dsh-tool-bash',
      '@deepseek-ai/dsh-tool-fs',
      '@deepseek-ai/dsh-tool-fs-search',
      '@deepseek-ai/dsh-tool-jobs',
      '@deepseek-ai/dsh-tool-skill',
      '@deepseek-ai/dsh-skill-filesystem',
      '@deepseek-ai/dsh-tool-todo',
      '@deepseek-ai/dsh-tool-web',
      '@deepseek-ai/dsh-persona',
    ]) {
      expect(names.has(name)).toBe(true)
    }
    for (const name of [
      // 不面向终端用户：提问、文件卡片、目标管理（目标由 Orchestrator 负责）
      '@deepseek-ai/dsh-tool-ask-user',
      '@deepseek-ai/dsh-tool-present',
      '@deepseek-ai/dsh-tool-goal',
      '@deepseek-ai/dsh-command-goal',
      // 禁止再派生
      '@deepseek-ai/dsh-tool-subagent',
      '@deepseek-ai/dsh-tool-subagent-control',
      '@deepseek-ai/dsh-tool-workflow',
      '@deepseek-ai/dsh-tool-ralph',
      '@deepseek-ai/dsh-workflow-ptc',
    ]) {
      expect(names.has(name)).toBe(false)
    }
  })

  it('Worker persona 固化了 task_update 协议和通用约束', () => {
    const persona = byId.get(WORKER_PRESET)!.plugins.find(row => row.id === 'persona')
    const prefix = String((persona!.config as { prefix: string }).prefix)
    expect(prefix).toContain('task_update')
    expect(prefix).toContain('completed')
    expect(prefix).toContain('工作区')
  })
})
