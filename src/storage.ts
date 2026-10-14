import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { conversationSchema, taskSchema } from './types.ts'

export const orchestratorDomain = defineDomain({
  name: 'orchestrator',
  version: 1,
  tables: {
    conversations: domainTable<string, ReturnType<typeof conversationSchema.parse>>(conversationSchema),
    tasks: domainTable<string, ReturnType<typeof taskSchema.parse>>(taskSchema),
  },
})
