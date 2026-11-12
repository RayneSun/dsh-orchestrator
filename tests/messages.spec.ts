import { describe, expect, it } from 'vitest'
import { deliveryNotice, LEAD_PROMPT, renderWorkerCapabilityIndex, scheduleStatusSection, WORKER_PROMPT } from '../src/messages.ts'
import { createConversation, createTask, type ConversationRecord, type TaskRecord } from '../src/types.ts'

describe('deliveryNotice 用户日程段', () => {
  const baseTask = (): TaskRecord => ({
    ...createTask({ id: 't1', parentSessionId: 'p1', conversationId: 'c1', predecessorTaskId: null, subject: '查距离', prompt: 'p' }),
    status: 'completed',
    result: '安贞最近',
  })

  it('有日程时附带 pending 清单与代办指引；无日程不带该段', () => {
    const conv: ConversationRecord = {
      ...createConversation({ id: 'c1', childSessionId: 's1', parentSessionId: 'p1', title: '体检' }),
    }
    const schedules = [
      {
        id: 'todo_1', conversationId: 'c1', parentSessionId: 'p1', title: '拨打预约电话', remark: '工作日 8:00-17:00', endAt: '2026-10-27T23:59:59+08:00',
        status: 'pending' as const, priority: 'P3' as const, links: [], attachments: [], contacts: [], createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
      }, {
        id: 'todo_2', conversationId: 'c1', parentSessionId: 'p1', title: '已完成事项', status: 'done' as const, completedBy: 'user' as const, priority: 'P3' as const, links: [], attachments: [], contacts: [],
        createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
      },
    ]
    const text = deliveryNotice(baseTask(), conv, schedules)
    expect(text).toContain('用户日程')
    expect(text).toContain('[todo_1] 拨打预约电话')
    expect(text).toContain('结束 10-27')
    expect(text).toContain('task_schedule 的 update')
    expect(text).not.toContain('todo_2')
    const without = deliveryNotice(baseTask(), conv, [])
    expect(without).not.toContain('用户日程')
  })
})

describe('deliveryNotice 制品交付', () => {
  it('要求 Lead 先用 present 交付，再按输出规范精简正文并保留卡片', () => {
    const task: TaskRecord = {
      ...createTask({ id: 't1', parentSessionId: 'p1', conversationId: 'c1', predecessorTaskId: null, subject: '写诗', prompt: 'p' }),
      status: 'completed',
      result: '诗已写好',
      artifacts: ['poem.md'],
    }
    const conv = createConversation({ id: 'c1', childSessionId: 's1', parentSessionId: 'p1', title: '写诗', workspaceName: 'poem-markdown' })
    const text = deliveryNotice(task, conv)
    expect(text).toContain('poem-markdown/poem.md')
    expect(text).toContain('回复前必须调用 present 交付')
    expect(text).toContain('路径仅供 present 使用，不要写进正文')
    expect(text).toContain('紧扣用户原始需求，只说结果，不补充执行过程')
    expect(text).toContain('dsh-ui 围栏原封不动')
  })
})

describe('scheduleStatusSection 投递附言', () => {
  const base = {
    createdAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z',
  }
  it('pending 全列含 id；用户标完成的列出防重复代办；worker 标完成与 cancelled 不提', () => {
    const text = scheduleStatusSection([
      { ...base, id: 'todo_1', title: '买火车票', startAt: '2026-10-20T00:00:00+08:00', endAt: '2026-10-25T23:59:59+08:00', status: 'pending', priority: 'P3' as const, links: [], attachments: [], contacts: [] },
      { ...base, id: 'todo_2', title: '取快递', status: 'done', priority: 'P3' as const, links: [], attachments: [], contacts: [], completedBy: 'user' as const },
      { ...base, id: 'todo_3', title: '已代办的', status: 'done', priority: 'P3' as const, links: [], attachments: [], contacts: [], completedBy: 'worker' as const },
      { ...base, id: 'todo_4', title: '作废的', status: 'cancelled', priority: 'P3' as const, links: [], attachments: [], contacts: [] },
    ])
    expect(text).toContain('[todo_1] 买火车票（10-20 → 10-25） — 待处理')
    expect(text).toContain('[todo_2] 取快递 — 用户已自行标记完成，不要重复代办')
    expect(text).not.toContain('todo_3')
    expect(text).not.toContain('todo_4')
  })
  it('全天日程纯日期标签：不经 Date.parse，直接月-日展示（含跨天）', () => {
    const text = scheduleStatusSection([
      { ...base, id: 'sch_1', title: '十一假期', startAt: '2026-10-01', endAt: '2026-10-07', status: 'pending', priority: 'P3' as const, links: [], attachments: [], contacts: [] },
      { ...base, id: 'sch_2', title: '生日', startAt: '2026-11-04', status: 'pending', priority: 'P3' as const, links: [], attachments: [], contacts: [] },
    ])
    expect(text).toContain('[sch_1] 十一假期（10-1 → 10-7）')
    expect(text).toContain('[sch_2] 生日（11-4 起）')
  })

  it('空清单或全无可提项时不产生片段', () => {
    expect(scheduleStatusSection([])).toBe('')
    expect(scheduleStatusSection([{ ...base, id: 'todo_1', title: 'x', status: 'cancelled', priority: 'P3' as const, links: [], attachments: [], contacts: [] }])).toBe('')
  })
})

describe('prompt 编排约定', () => {
  it('Lead prompt 只描述 Worker 业务能力，不暴露 Worker 工具与上报协议', () => {
    expect(LEAD_PROMPT).toContain('用户待办/日程管理')
    expect(LEAD_PROMPT).toContain('记忆管理')
    expect(LEAD_PROMPT).toContain('制作 PPT')
    expect(LEAD_PROMPT).toContain('联网检索与信息整理')
    expect(LEAD_PROMPT).toContain('DSH-UI 可视化')
    expect(LEAD_PROMPT).toContain('统计图表与 ECharts')
    expect(LEAD_PROMPT).toContain('流程图/架构图/Mermaid')
    expect(LEAD_PROMPT).toContain('数学函数图像、图片及 3D 场景')
    expect(LEAD_PROMPT).toContain('不要改成 Python/matplotlib 绘图或静态图片制作任务')
    expect(LEAD_PROMPT).toContain('自己做不了的需求也一律派发 Worker')
    expect(LEAD_PROMPT).toContain('Worker 环境能力索引')
    expect(LEAD_PROMPT).toContain('不要在派发需求、执行方法或用户回复中引用这些名称')
    expect(LEAD_PROMPT).not.toContain('task_completed')
    expect(LEAD_PROMPT).not.toContain('task_schedule')
    expect(LEAD_PROMPT).not.toContain('schedule_create')
    expect(LEAD_PROMPT).not.toContain('list/keyvalue')
    expect(LEAD_PROMPT).not.toContain('startAt/endAt/remindAt')
  })

  it('Dispatch 只细化用户需求与验收结果，不指导 Worker 执行', () => {
    expect(LEAD_PROMPT).toContain('prompt 只写细化后的用户需求')
    expect(LEAD_PROMPT).toContain('acceptanceCriteria 写可检查的验收结果')
    expect(LEAD_PROMPT).toContain('不要教 Worker 怎么做')
    expect(LEAD_PROMPT).toContain('不要替它拆分步骤')
    expect(LEAD_PROMPT).toContain('不要指定工具、Skill、技术方案、执行路径、上报字段或展示组件')
    expect(LEAD_PROMPT).toContain('按照下方的输出规范回复用户')
    expect(LEAD_PROMPT).toContain('以 ```dsh-ui 开头、以单独的 ``` 结尾')
    expect(LEAD_PROMPT).toContain('同一信息只在一个载体出现')
  })

  it('环境能力索引只列名称并禁止在派发文案中引用', () => {
    const text = renderWorkerCapabilityIndex({ tools: ['bash', 'web_search'], skills: ['genui'] })
    expect(text).toContain('工具：bash、web_search')
    expect(text).toContain('Skills：genui')
    expect(text).toContain('不是使用说明')
    expect(text).toContain('禁止在 dispatch 的 prompt/acceptanceCriteria')
  })

  it('Worker prompt 约定 result/card/artifacts 分工、去重且 result 不含路径', () => {
    expect(WORKER_PROMPT).toContain('禁止出现任何文件路径')
    expect(WORKER_PROMPT).toContain('忽略具体实现细节')
    expect(WORKER_PROMPT).toContain('只阐述用户原始需求对应的结果')
    expect(WORKER_PROMPT).toContain('不写怎么做')
    expect(WORKER_PROMPT).toContain('只放用户需要打开的关键产物文件')
    expect(WORKER_PROMPT).toContain('制品正文内容不要复制进 result 或 card')
  })

  it('Worker prompt 约定 progressNote 拟人化幽默风格', () => {
    expect(WORKER_PROMPT).toContain('拟人口吻')
    expect(WORKER_PROMPT).toContain('不许编造')
  })

  it('Worker prompt 约定重复模式主动建议定时任务', () => {
    expect(WORKER_PROMPT).toContain('反复定期出现')
    expect(WORKER_PROMPT).toContain('schedule_create 绑定本会话')
  })

  it('Worker prompt 引导按事件填全起止与提醒时间', () => {
    expect(WORKER_PROMPT).toContain('# 用户待办/日程（task_schedule）')
    expect(WORKER_PROMPT).toContain('尽量填全 startAt/endAt/remindAt')
    expect(WORKER_PROMPT).toContain('根据事件类型合理估计')
    expect(WORKER_PROMPT).toContain('自行选择合理的提前量')
    expect(WORKER_PROMPT).toContain('不要对所有事项套用固定提前时间')
    expect(WORKER_PROMPT).toContain('若判断提前 20 分钟合适')
  })
})
