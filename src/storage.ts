import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { conversationSchema, scheduleObjectSchema, taskSchema } from './types.ts'

export const orchestratorDomain = defineDomain({
  name: 'orchestrator',
  // 拍平协议与旧记录不兼容：升级前备份旧域，新版本从空域开始。
  version: 3,
  layout: 'per-record',
  tables: {
    conversations: domainTable<string, ReturnType<typeof conversationSchema.parse>>(conversationSchema),
    tasks: domainTable<string, ReturnType<typeof taskSchema.parse>>(taskSchema),
    schedules: domainTable<string, ReturnType<typeof scheduleObjectSchema.parse>>(scheduleObjectSchema),
  },
})
