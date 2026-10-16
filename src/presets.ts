import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { LEAD_PROMPT, WORKER_PROMPT } from './messages.ts'

export const LEAD_PRESET = 'may-orchestrator-lead'
export const WORKER_PRESET = 'may-orchestrator-worker'
/**
 * Lead 只保留"向用户提问"这一个全局执行工具；其余全局工具（含用户后安装的
 * MCP/插件工具）对白名单不可见，避免无关工具干扰主控的路由决策。
 * orchestrator_* 在 scope 内注册，restrict 的 allow 不影响它们。
 */
/**
 * Lead 的全局工具白名单：向用户提问 + 长期记忆的检索/记录（meow-memory 全局注册）。
 * 浏览器/桌面/邮件等执行工具不在此列：由 Worker 子会话持有，避免主控绕过编排直接执行。
 */
export const LEAD_TOOL_ALLOW = [
  'ask_user_question',
  'ask_user',
  'memory_search',
  'memory_project',
  'memory_remember',
] as const

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
      description: '只负责路由和编排，把执行工作分发给持久执行 Worker',
      plugins: [
        {
          id: 'persona',
          name: '@deepseek-ai/dsh-persona',
          config: { prefix: LEAD_PROMPT },
        },
        ...basics,
        { id: 'tool-ask-user', name: '@deepseek-ai/dsh-tool-ask-user' },
        compaction,
      ],
    },
    {
      id: WORKER_PRESET,
      name: '执行 Worker',
      order: 20,
      description: '可使用宿主与用户安装的全部工具执行任务；禁止再派生子 Agent，通过 task_update 上报状态',
      plugins: [
        {
          id: 'persona',
          name: '@deepseek-ai/dsh-persona',
          config: {
            prefix: WORKER_PROMPT,
            suffix: '你的工作目录是 {{cwd}}。',
          },
        },
        ...basics,
        bash,
        pwsh,
        { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
        {
          id: 'tool-fs-search',
          name: '@deepseek-ai/dsh-tool-fs-search',
          config: { sampleOverCapGlobResults: false },
        },
        { id: 'tool-jobs', name: '@deepseek-ai/dsh-tool-jobs' },
        { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
        { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
        { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
        { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60_000 } },
        compaction,
      ],
    },
  ]
}
