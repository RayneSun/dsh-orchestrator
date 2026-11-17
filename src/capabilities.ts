import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'

type PluginRow = PresetDefinition['plugins'][number]

/** Lead 挂载与继承 allow 的唯一工具定义。可选记忆由全局插件提供。 */
export const leadCapabilities: readonly { plugin?: PluginRow; tools: readonly string[]; optional?: boolean }[] = [
  { plugin: { id: 'tool-web', name: '@deepseek-ai/dsh-tool-web', config: { fetch: true, searchTimeoutMs: 60_000 } }, tools: ['web_search', 'web_fetch'] },
  { plugin: { id: 'tool-fs-search', name: '@deepseek-ai/dsh-tool-fs-search', config: { sampleOverCapGlobResults: false } }, tools: ['glob', 'grep'] },
  { plugin: { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs', config: { read: true, readImage: true, write: false, edit: false, applyPatch: false } }, tools: ['read', 'read_image'] },
  { plugin: { id: 'tool-present', name: '@deepseek-ai/dsh-tool-present' }, tools: ['present'] },
  { tools: ['memory_search', 'memory_read'], optional: true },
]
