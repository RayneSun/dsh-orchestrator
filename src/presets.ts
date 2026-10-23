import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { LEAD_PROMPT, WORKER_PROMPT } from './messages.ts'

export const LEAD_PRESET = 'may-orchestrator-lead'
export const WORKER_PRESET = 'may-orchestrator-worker'
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
  // 子智能体：与平台 standard 预设同款的 delegation 组（不含 workflow-ptc，
  // 高层编排循环仍由黑名单拦截）。后端 spawn/fork 驻留宿主平面，这里只选择工具面。
  const delegation: PluginRow = {
    id: 'delegation',
    name: 'cordis:group',
    group: true,
    isolate: { workflowEngine: true },
    config: [
      { id: 'tool-subagent-control', name: '@deepseek-ai/dsh-tool-subagent-control' },
      { id: 'tool-subagent-list-agents', name: '@deepseek-ai/dsh-tool-subagent-control/list-agents' },
      {
        id: 'tool-subagent',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: { provider: 'spawn', toolName: 'subagent', modelSelectionSettings: true },
      },
      {
        id: 'tool-subagent-fork',
        name: '@deepseek-ai/dsh-tool-subagent',
        config: { provider: 'fork', toolName: 'subagent_fork' },
      },
    ],
  }
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
      description: '可使用宿主与用户安装的全部工具执行任务（含子智能体与后台任务）；禁止编排循环与 orchestrator 工具，通过 task_update 上报状态',
      plugins: [
        {
          id: 'persona',
          name: '@deepseek-ai/dsh-persona',
          // rc.2 起 persona suffix 不再支持 {{cwd}} 模板变量（严格插值，仅 provider/model）；
          // 平台 dsh-working-directory 已给每个会话注入 Current working directory，无需手写。
          config: { prefix: WORKER_PROMPT },
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
        delegation,
        // 定时/周期提醒：Worker 是根会话（delegationDepth=0），schedule 绑定并触发回本子会话。
        { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
        { id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem' },
        { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
        { id: 'tool-todo', name: '@deepseek-ai/dsh-tool-todo', config: { allowParallelInProgress: true } },
        { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60_000 } },
        compaction,
      ],
    },
  ]
}
