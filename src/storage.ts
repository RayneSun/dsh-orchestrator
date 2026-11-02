import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { conversationSchema, scheduleObjectSchema, taskSchema } from './types.ts'

export const orchestratorDomain = defineDomain({
  name: 'orchestrator',
  version: 2,
  // v1 记录（conversations/tasks，todos 还挂在 conversation 上）保持可读，启动时迁移进 schedules。
  compatibleVersions: [1],
  // per-record 布局：旧 v1 单文件（storages/orchestrator.json）经 bootstrapLegacyUnit 拷入
  // per-record 树并盖 v2 版戳；single 布局的 openUnit 只接受精确版本匹配，会直接拒开。
  layout: 'per-record',
  tables: {
    conversations: domainTable<string, ReturnType<typeof conversationSchema.parse>>(conversationSchema),
    tasks: domainTable<string, ReturnType<typeof taskSchema.parse>>(taskSchema),
    schedules: domainTable<string, ReturnType<typeof scheduleObjectSchema.parse>>(scheduleObjectSchema),
  },
})
