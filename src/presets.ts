import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { LEAD_PROMPT } from './messages.ts'
import { sceneDefinitions } from './scenes.ts'
import { scenes, type Scene } from './types.ts'

export const LEAD_PRESET = 'may-orchestrator-lead'
export const LEAD_TOOL_DENY = ['web_search', 'web_fetch'] as const

export const WORKER_PRESET: Record<Scene, string> = {
  code: 'may-orchestrator-worker-code',
  general: 'may-orchestrator-worker-general',
  research: 'may-orchestrator-worker-research',
  review: 'may-orchestrator-worker-review',
}

type PluginRow = PresetDefinition['plugins'][number]

function shell(id: string, name: string, disabled?: boolean): PluginRow {
  return disabled === undefined ? { id, name } : { id, name, disabled }
}

export function buildPresetDefinitions(): PresetDefinition[] {
  const bash = shell('tool-bash', '@deepseek-ai/dsh-tool-bash', process.platform === 'win32')
  const pwsh = shell('tool-pwsh', '@deepseek-ai/dsh-tool-pwsh', process.platform !== 'win32')
  const basics: PluginRow[] = [
    {
      id: 'agent-instructions',
      name: '@deepseek-ai/dsh-agent-instructions',
      config: { maxBytes: 65_536 },
    },
    { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
  ]
  const compaction: PluginRow = {
    id: 'compaction',
    name: 'cordis:group',
    group: true,
    isolate: { compaction: true, toolResultPruner: true },
    config: [
      { id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic' },
      { id: 'command-compact', name: '@deepseek-ai/dsh-command-compact' },
      {
        id: 'tool-result-pruner',
        name: '@deepseek-ai/dsh-compaction-tool-result-pruner',
        config: { thresholdChars: 8192, headChars: 4096, tailChars: 1024 },
      },
    ],
  }

  return [
    {
      id: LEAD_PRESET,
      name: '主控助理',
      order: 8,
      description: '只负责路由和编排，把执行工作分发给持久子会话',
      plugins: [
        {
          id: 'persona',
          name: '@deepseek-ai/dsh-persona',
          config: { prefix: LEAD_PROMPT, suffix: '你的工作目录是 {{cwd}}。' },
        },
        ...basics,
        { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60_000 } },
        { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
        compaction,
      ],
    },
    ...scenes.map((scene): PresetDefinition => {
      const definition = sceneDefinitions[scene]
      return {
        id: WORKER_PRESET[scene],
        name: definition.label,
        order: 20 + scenes.indexOf(scene),
        description: definition.description,
        plugins: [
          ...basics,
          ...(scene === 'code' || scene === 'general' ? [bash, pwsh] : []),
          { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
          {
            id: 'tool-fs-search',
            name: '@deepseek-ai/dsh-tool-fs-search',
            config: { sampleOverCapGlobResults: false },
          },
          { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60_000 } },
          compaction,
        ],
      }
    }),
  ]
}
