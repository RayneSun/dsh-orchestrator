import { blockReasonCodes, schedulePriorities } from './types.ts'

/**
 * orchestrator_dispatch 的参数描述。注意：dsh-tools 的参数 DSL 只支持
 * type/required/enum/const/items/properties/oneOf/description/title/default/examples，
 * 任何其他关键字（如 pattern）会在 defineTool 编译期直接抛错、导致工具注册失败消失。
 * 约束只能写进 description，运行时校验由 dispatchInputSchema 负责。
 */
export const DISPATCH_TOOL_PARAMETERS = {
  subject: { type: 'string', required: true, description: '短主题' },
  workspaceName: { type: 'string', description: '新建子会话必填：子工作区目录名，必须匹配 ^[a-z0-9][a-z0-9-]{0,79}$（英文小写短横线 slug，如 daily-news、plane-war）；复用已有子会话时忽略' },
  prompt: { type: 'string', required: true, description: '只写细化后的用户需求；不要拆分步骤、指导执行方法或指定工具/Skill/技术方案/上报字段/展示组件，不要重复环境信息或粘贴无关内部 ID' },
  conversationId: { type: 'string', description: '复用已有工作流时提供' },
  acceptanceCriteria: { type: 'string', description: '可选验收结果：写清怎样算满足用户需求，不写执行步骤或方法' },
  silent: { type: 'boolean', description: '静默模式：记忆整理等后台维护任务使用；终态不会向主会话投递任何消息，看板仍可见状态' },
} as const
/** task_* 工具公共字段（与各 input schema 双写：zod 加了字段而这里没加，模型就永远不知道）。 */
const HEADER_PARAM = { type: 'string', description: '极度精简的状态标题（最多 8 个字，看板加粗展示），如"抓取新闻源""已查到 3 家"' } as const
const PROGRESS_NOTE_PARAM = { type: 'string', description: '一行精简进展（看板直接显示；信息优先，可带三分幽默）' } as const
const SCHEDULE_ID_PARAM = { type: 'string', description: '批量定时消息中必填：本次上报对应消息里的 schedule_id；单条定时消息和普通任务省略' } as const

/** 日程条目（create/update 共用结构，分别导出常量避免双写漂移）。 */
const SCHEDULE_ITEM_PROPERTIES = {
  title: { type: 'string', required: true, description: '日程标题（极简，≤30 字）' },
  allDay: { type: 'boolean', description: '全天日程：true 时 startAt 必填完整纯日期（如 2026-11-04），endAt 可选且尾日包含（11-04 到 11-06 填 2026-11-06），均不带时刻' },
  startAt: { type: 'string', description: '事件开始时间；普通日程如 10-28 09:00（可带年份，无年份按未来就近解析）；全天日程用完整纯日期' },
  endAt: { type: 'string', description: '事件结束时间；未明确时按事件类型合理估计，无法估计才省略。普通日程如 10-28 22:00；全天日程用完整纯日期，尾日包含当天' },
  remindAt: { type: 'string', description: '提醒时间元数据；未指定但需要提醒时，根据事项类型、准备成本和重要程度自行选择合理的 startAt 提前量，如 10-28 07:40（供 App 通知使用；本插件不会据此自动触发提醒）' },
  priority: { type: 'string', enum: [...schedulePriorities], description: 'P0 紧急且重要 / P1 重要不紧急 / P2 紧急不重要 / P3 有空再做（默认 P3）' },
  links: {
    type: 'array',
    items: { type: 'object', additionalProperties: false, properties: {
      url: { type: 'string', required: true, description: 'http(s) 网址' },
      label: { type: 'string', description: '显示名（缺省显示域名）' },
    } },
    description: '相关链接（≤10）',
  },
  attachments: {
    type: 'array',
    items: { type: 'object', additionalProperties: false, properties: {
      path: { type: 'string', required: true, description: '子工作区相对路径（禁止绝对路径和 ..）' },
      name: { type: 'string', description: '显示名（缺省显示文件名）' },
    } },
    description: '附件文件（≤10，须已在工作区内生成）',
  },
  contacts: {
    type: 'array',
    items: { type: 'object', additionalProperties: false, properties: {
      name: { type: 'string', required: true },
      phone: { type: 'string' },
      email: { type: 'string' },
      note: { type: 'string', description: '如可用时段' },
    } },
    description: '联系人信息卡（≤5，电话/邮箱供用户点按联系）',
  },
  location: {
    type: 'object', additionalProperties: false, properties: {
      name: { type: 'string', required: true },
      address: { type: 'string' },
    },
    description: '地点（名称+可选地址）',
  },
  remark: { type: 'string', description: '备注：纯文字说明。联系方式/网址/地点/文件用 contacts/links/location/attachments 字段，不要堆在这里' },
} as const
export const TASK_SCHEDULE_TOOL_PARAMETERS = {
  create: {
    type: 'array',
    items: { type: 'object', additionalProperties: false, properties: SCHEDULE_ITEM_PROPERTIES },
    description: '新建用户待办/日程：只有助理代替不了、需要用户本人推进的事才建；按事件尽量填全 startAt/endAt/remindAt，电话/网址/地点/附件写进 contacts/links/location/attachments 字段',
  },
  update: {
    type: 'array',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', required: true, description: '日程 id（从投递附言/本工具返回值的清单里抄，禁止编造）' },
        status: { type: 'string', enum: ['pending', 'done', 'cancelled'], description: '代办完成标 done；不再适用标 cancelled' },
        ...SCHEDULE_ITEM_PROPERTIES,
        title: { type: 'string', description: '改标题（≤30 字）' },
        allDay: { type: 'boolean', description: '修改全天状态时必须同时提供新格式的 startAt；普通日程带时刻，全天日程用完整纯日期' },
      },
    },
    description: '更新已有日程：按 id 改状态或内容（改谁带谁）',
  },
} as const

/** 四个状态上报工具 + 日程工具的模型可见参数。 */
export const TASK_RUNNING_TOOL_PARAMETERS = {
  header: HEADER_PARAM,
  progressNote: PROGRESS_NOTE_PARAM,
  scheduleId: SCHEDULE_ID_PARAM,
} as const

export const TASK_COMPLETED_TOOL_PARAMETERS = {
  header: HEADER_PARAM,
  progressNote: PROGRESS_NOTE_PARAM,
  result: { type: 'string', required: true, description: '只阐述用户需求的最终结果，不写怎么做或过程性内容；不含文件路径，不重复 card 或制品已表达的内容' },
  card: { type: 'object', additionalProperties: true, description: 'dsh-ui 展示卡片 JSON；组件规范用 genui skill，只放结构化明细，不复制 result 或制品正文' },
  artifacts: { type: 'array', items: { type: 'string' }, description: '仅限用户需要打开的关键制品，子工作区相对路径（禁止绝对路径和 ..）；制品正文不要复制到 result/card' },
  scheduleId: SCHEDULE_ID_PARAM,
} as const

export const TASK_FAILED_TOOL_PARAMETERS = {
  header: HEADER_PARAM,
  progressNote: PROGRESS_NOTE_PARAM,
  scheduleId: SCHEDULE_ID_PARAM,
  error: { type: 'string', required: true, description: '任务本身没做成的原因和已尝试的办法' },
  reasonCode: { type: 'string', enum: [...blockReasonCodes], description: '系统阻碍类别（权限/配置/依赖/网络/资源/运行时）；普通失败不填' },
} as const

export const TASK_INPUT_REQUIRED_TOOL_PARAMETERS = {
  header: HEADER_PARAM,
  progressNote: PROGRESS_NOTE_PARAM,
  scheduleId: SCHEDULE_ID_PARAM,
  questions: {
    type: 'array',
    required: true,
    description: '结构化问题（一次问清，id 可省略会自动分配并在返回值回显）',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '问题 id，省略则自动分配 q1/q2/…' },
        question: { type: 'string', required: true, description: '问题正文（可直接展示给用户）' },
        header: { type: 'string', description: '短标题/分组（如"确认"）' },
        detail: { type: 'string', description: '补充说明（不出现在选项里）' },
        options: {
          type: 'array',
          description: '可选项；推荐项放首位并在 label 末尾加 (Recommended)',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string', required: true, description: '短选项文案' },
              description: { type: 'string', description: '一句话说明该选项的影响' },
            },
          },
        },
        multi_select: { type: 'boolean', description: '是否可多选，默认单选' },
      },
    },
  },
} as const
