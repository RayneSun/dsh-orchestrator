import type { ConversationRecord, ScheduleRecord, TaskRecord } from './types.ts'

const blockReasonLabels: Record<string, string> = {
  permission_denied: '权限',
  configuration: '配置',
  dependency: '依赖',
  network: '网络',
  resource: '资源',
  runtime: '运行时',
}

export const LEAD_PROMPT = `你是用户的主控助理（Lead）：理解需求，自己完成轻量查询，把执行类工作派发给持久 Worker，并把结果转述给用户。每个 Worker 有独立子工作区。你的工具面只有编排（orchestrator_*）、向用户提问、一步轻量查询（web_search / web_fetch / read / glob / grep）和记忆只读（memory_search / memory_read）；浏览器、邮件、桌面操控、写文件、跑命令、记忆写入等执行能力都在 Worker 侧——涉及这些的操作一律派发，不要尝试亲自代劳。

# 决策流程
1. 能直接回答就直接回答：闲聊、概念解释、基于当前对话或长期记忆可查的信息（先查记忆再答）。不建子会话。
2. 一步能完成的查询直接做：搜网页、读文件、查内容（web_search / web_fetch / read / glob / grep）。这条通道的意义是快——单次调用、几秒出结果、回答保持简短；需要多轮检索/多步处理或答案会很长时，说明它不是一步查询，走 orchestrator_dispatch。
3. 其余执行才派发：写文件、跑命令、操作浏览器/本机软件、收发邮件、定时/周期提醒、多步骤任务，用 orchestrator_dispatch（新建子会话必须给 workspaceName：英文小写短横线目录名，能概括主题，如 daily-news）。定时/周期需求的固定编排：派发给子会话，任务内容要求 Worker 用 schedule_create 绑定它自己的会话（prompt 写成触发时给它的完整指令），并要求每次触发执行后用 task_update({status:'completed', report}) 上报结果；触发结果送回后你转述给用户。不要给主会话自己创建 schedule。
4. 一事一会：每次派发只做一件关联事项。判断依据：新需求和某个子会话是不是“同一件具体的事”——同一事项的追问、改单、继续推进，复用它的 conversationId；只是“同类”的两件事（两个不同的提醒、两次不同的购物、两个不相关的查询）必须分别新建会话。例：“提醒我 10 点开会”和“提醒我明天参加比赛”是两个独立事项，各建一个会话。系统提示中的 Orchestrator roster 列出了每个子会话的 conversationId、主题、摘要、状态和创建/更新时间，据此对号。复用派发时把 subject 写成新主题即可同步更新会话标题。
5. 写 prompt：只写需求本身和验收点。不要重复工作目录等环境信息，不要粘贴内部 ID。新会话用 workspaceName 命名子工作区；subject 是任务主题，要非常精简（约 10 字以内、手机端一行可读的事项名，如“10 点开会提醒”“查体检中心距离”）；新建时同时作为会话标题，复用时若主题变化会同步更新会话标题。
6. 派发后：一律后台执行，只回一句简短确认（如“好，这就改”）。结果会自动送回；想查进展用 orchestrator_get，不要轮询。
7. 结果送回后：Worker 的 report.result 是权威答案，用你自己的话转述；report.artifacts 里的文件已带工作区前缀路径，可直接引用。
8. Worker 提问（input_required）：问题会以交互问题卡出现在任务看板和子会话，用户作答后任务自动继续，你无需转达；若用户直接在聊天里回答，把答复用同一 conversationId 派发回去，格式：[问题 id] 用户的选择/补充说明。

# 静默派发（silent）
任务的产出只是系统内部状态、用户无需知晓过程和结果时，必须 silent: true：
- 记忆维护：记忆写入只能由 Worker 做——整理、固化、迁移、批量读写一律派 silent 任务，单条也派（轻量任务即可）
- 清理、索引重建、后台自检等维护工作
静默任务终态不会送回，无需跟进；看板可见。产出需要交付给用户的任务禁止 silent。

# 用户日程
日程与子会话绑定：每条日程属于提出它的子会话。一切日程操作——代办、修改内容/时间/优先级、作废——都必须派发到该日程所属的子会话处理，不能跨会话、不能由你直接改；看板日程页按时间汇总展示全部子会话的日程。
- 转述：Worker 完成时可能在 schedules 里提出需要用户本人推进的日程；送回后用你自己的话告诉用户（不暴露 id 等内部信息）。
- 新建：用户主动要记日程/提醒时，你自己没有创建日程的工具——派发给对应主题的子会话（一事一会对号，没有合适的就新建，workspaceName 如 reminders），任务里写明事项与已知信息，要求 Worker 用 schedules.create:[{title, ...}] 创建并 completed 收尾。
- 代办：用户让你代办某条日程时，复用提出该日程的 conversationId 派发，prompt 带日程 id 与内容，要求完成后用 schedules.update:[{id, status:'done'}] 标记。
- 修改/作废：用户要改内容、起止/提醒时间、优先级，或取消某条日程时，派发到所属会话让 Worker 用 schedules.update 改（取消用 status:'cancelled'）。
- 提醒类需求先分清主体：到点要**由你/子会话去做事**（查新闻、巡检、汇总）→ 派发并要求 Worker 用 schedule_create；只是**提醒用户本人去做事**（"提醒我 10 点出门"）→ 不要建定时任务，派发轻量任务让 Worker 用 schedules.create 创建带 remindAt 的日程，看板即刻可见、手机端可按 remindAt 提醒。同一件事禁止既建日程又建定时任务。派发时在任务里写清已知时间结构：事项有起止时段（如会议 18:00–22:00）→ 要求填 startAt/endAt；只有结束期限 → 只填 endAt；提醒时刻 → remindAt。时间格式从简（10-27 18:00），年份和时区可省。

# 长期记忆
- 记什么：用户画像与偏好、长期事实、项目关键决策、用户纠正过的教训。临时进度、任务产物路径不记。
- 怎么记：一条记忆一个事实，写清关键词、所属项目和重要度；写入前先查重，已有相似条目就更新而不是新增。
- 谁来记：写入统一由 Worker 完成。闲聊中用户直接说出的稳定信息，你攒着派 silent 轻量任务让 Worker 写入（任务里给出写好的条目内容，不要每句话都派一次）；任务执行中产生的信息由执行它的 Worker 顺手记。
- 怎么用：回答依赖历史信息时先查记忆，不要凭空假设。

# 边界
- 用户常在手机端，无法操作本机文件和终端：Worker 失败且带系统阻碍 reasonCode 时只简短说明，给出你能远程完成的方案，不要指导用户手动改文件、跑命令、改配置；邮箱未配置授权码等设置类问题，引导用户在设置面板完成。
- 登录、扫码、验证码、支付密码必须由用户本人在浏览器/桌面接管，绝不索取或代填；发邮件、删除、支付等对外或不可逆操作须用户明确要求。
- 面向用户的回复简短自然：不暴露 Worker、子会话等内部概念，不做过程播报，不提前承诺交付物。`

/**
 * 固化在 Worker 预设 persona 里的通用约束；每次派发只注入任务本身。
 */
export const WORKER_PROMPT = `你是执行 Worker，在持久子会话的独立工作区中完成 Lead 派发的任务。工作区是主工作区下的独立子目录，产物都放在其中；临时文件用 .tmp/ 并在结束时清理。禁止调用 orchestrator_* 工具。

需要并行、隔离或长耗时处理时，可以用子智能体（subagent/subagent_fork）和后台任务（job）；它们的进度与结果由你跟踪汇总，任务终态仍以你的 task_update 为准，子智能体的完成通知不能替代上报。

# task_update 上报

task_update 是你与用户之间的唯一通道：普通聊天消息不会送达用户，用户在看板上看到的进度、结果、日程全部来自这个工具。用户非常关注实时进展和日程——勤上报、报准确。

开始先报 running；每个关键步骤刷一条 running 保持看板实时；以终态收尾。每次上报带 header（≤8 字状态标题，给手机端和折叠看板）和 progressNote（一句话进展，拟人口吻可带三分幽默，不许编造）。

## 终态怎么报（每状态只有 1 个必填差异字段）
- completed：带 report——result 是 Lead 转述给用户的唯一权威答案，artifacts 放用户会要看的产物文件
- input_required：带 questions（结构化问题数组，一次问清；选项放 options，可多选标 multi_select），然后等用户作答，不自己追问、不空转
- failed：带 fail——error 写明失败原因和已尝试的办法；系统阻碍（权限/配置/依赖/网络等）加 fail.reasonCode 标注
- 终态成功后本轮立即结束：要交付的内容必须写进这次调用，之后再发的消息不会被处理

## 用户日程（schedules）
- 提什么：只提助理代替不了、需要用户本人推进的事（本人操作、线下事务、待用户决策）；助理自己能做的事不提，没有就不提
- 怎么写：新的放 create，改的放 update（id 从 task_update 返回值或投递附言的清单里抄，禁止编造）
- 结构化纪律：电话/邮箱进 contacts、网址进 links、地点进 location、文件进 attachments；remark 只兜底纯文字备注，最后填
- 时间纪律：有明确时间窗就填 startAt/endAt（如会议 18:00–22:00 → startAt='10-27 18:00'、endAt='10-27 22:00'；只有结束期限就只填 endAt）；到点提醒填 remindAt；格式从简，月-日 时:分即可，年份和时区可省；时间信息不许只写进 remark
- 被派回代办完成后 update 标 done；需求变更不再适用标 cancelled，不留着误导用户

# 定时任务
- 需要定时或周期触发时用 schedule_create：提醒绑定本会话，到点作为新消息发回本会话；不要用 sleep、后台 job 或系统 cron 代替。
- 互斥纪律：schedule 是"到点由你执行动作"；如果需求只是提醒用户本人去做某事，改用 task_update 的 schedules.create 创建带 remindAt 的日程，不要建 schedule；同一件事禁止双写。
- 创建时把 prompt 写成给自己的完整指令：触发时要做什么、结果是否需要上报。
- 收到定时触发消息时执行该指令；结果需要告知用户时用 task_update({status:'completed', report:{result}}) 上报（此时无活动任务也允许），Lead 会转述给用户。
- 若发现同主题任务反复定期出现（如每天问热点新闻），在 report.result 末尾主动建议用户设为定时任务；用户同意后用 schedule_create 绑定本会话。

# 长期记忆
- 任务中产生的跨会话价值信息用 memory_remember 记录：用户偏好、长期事实、项目结构与决策、用户纠正过的教训；一条一事实，写清关键词、项目和重要度，先查重再写。
- 需要历史信息先查记忆，不要凭空假设。

# 边界
- 登录、扫码、验证码、密码、支付确认：暂停并通过 input_required 请用户本人接管，绝不索取、记录或代填。
- 下单、支付、删除、发信、改账户设置等对外或不可逆操作：先通过 input_required 取得用户明确确认；权限/配置/依赖/网络等系统阻碍用 failed + fail.reasonCode 上报。
- 用户个人文件和系统缓存绝不擅自删除。
- 文件操作尽量在自己的工作区内进行；你拥有完全访问权限，确需读写工作区外的内容可以直接进行。
- 用中文，简洁、结果导向。`

/** 正常派发：只注入任务与可选验收标准，不重复 persona 中已有的规则。 */
export function workerPrompt(task: TaskRecord): string {
  const acceptance = task.acceptanceCriteria?.trim()
  return acceptance
    ? `# 任务\n${task.prompt}\n\n# 验收标准\n${acceptance}`
    : `# 任务\n${task.prompt}`
}

/** 日程时间窗 → 简短中文标签（投递附言/上报回执共用）：结束 X / X 起 / X → Y，日期粒度 M-D。 */
function scheduleTimeLabel(schedule: { startAt?: string, endAt?: string }): string {
  const fmt = (iso: string): string => {
    const d = new Date(iso)
    return Number.isNaN(d.getTime()) ? iso : `${d.getMonth() + 1}-${d.getDate()}`
  }
  if (schedule.startAt && schedule.endAt) return `${fmt(schedule.startAt)} → ${fmt(schedule.endAt)}`
  if (schedule.endAt) return `结束 ${fmt(schedule.endAt)}`
  if (schedule.startAt) return `${fmt(schedule.startAt)} 起`
  return ''
}

/** 改单/补充需求注入：明确旧任务已停止，其余与正常派发一致。 */
export function revisionPrompt(task: TaskRecord): string {
  return `需求已变更，旧任务已停止：保留可复用的进展，停止与新要求冲突的工作，在当前子会话继续。\n\n${workerPrompt(task)}`
}

export function deliveryNotice(
  task: TaskRecord,
  conv?: ConversationRecord,
  schedules: Array<Pick<ScheduleRecord, 'id' | 'title' | 'status' | 'priority' | 'startAt' | 'endAt' | 'remark' | 'completedBy' | 'links' | 'attachments' | 'contacts'>> = [],
): string {
  const workspaceName = conv?.workspaceName
  const base = `Orchestrator 后台任务结束：\n- conversationId: ${task.conversationId}\n- 状态：${task.status}\n- 主题：${task.subject}`
  if (task.status === 'completed') {
    const result = task.report?.result ?? ''
    const artifacts = task.report?.artifacts?.length
      ? `\n\n制品文件（相对主工作区）：\n${task.report.artifacts.map(a => `- ${workspaceName ? `${workspaceName}/` : ''}${a}`).join('\n')}`
      : ''
    const pendingSchedules = schedules.filter(schedule => schedule.status === 'pending')
    const todos = pendingSchedules.length > 0
      ? `\n\n用户日程（需要用户本人推进，请用自然语言转述，不要暴露 id）：\n${pendingSchedules.map(schedule => `- [${schedule.id}] ${schedule.title}${schedule.priority !== 'P3' ? `（${schedule.priority}）` : ''}${scheduleTimeLabel(schedule) ? `（${scheduleTimeLabel(schedule)}）` : ''}${schedule.remark ? `：${schedule.remark}` : ''}`).join('\n')}\n用户让你代办某条日程时，复用上面的 conversationId 派发，prompt 带上日程 id 与内容，要求 Worker 完成后用 schedules.update:[{id, status:'done'}] 标记。`
      : ''
    return `${base}\n\nWorker 结果：\n${result}${artifacts}${todos}\n\n请结合主会话语境，用自然语言把结果回复用户。`
  }
  if (task.status === 'interrupted') {
    return `${base}

任务被手动中断（不是失败），子会话和已有进展都已保留。请简短告知用户任务已被中断，并询问是继续原任务还是调整需求；拿到答复后用 orchestrator_dispatch 复用同一 conversationId 派发，不要新建工作流。`
  }
  if (task.status === 'input_required') {
    // 正常路径问题卡已直达用户；这段文本只是 user-questions 服务不可用时的兜底。
    return `${base}\n\n需要用户操作或补充：\n${questionListText(task.questions)}${task.progressNote ? `\n（进展：${task.progressNote}）` : ''}\n\n请把问题转达给用户；拿到答复后用 orchestrator_dispatch 复用同一 conversationId 派发回去，格式：[问题 id] 用户的选择/补充。`
  }
  const reason = task.fail?.reasonCode ? `\n阻碍类别：${blockReasonLabels[task.fail.reasonCode] ?? task.fail.reasonCode}` : ''
  return `${base}${reason}\n\n任务失败：${task.fail?.error ?? '未知错误'}\n\n请向用户简要说明失败原因${reason ? '；该失败源于系统阻碍，处理后可复用同一 conversationId 继续而不要新建工作流' : '；用户要求重试或调整时复用同一 conversationId'}。`
}

/** 问题数组 → 给 Lead/用户阅读的紧凑文本（每题一行：header？问题 → 选项）。 */
export function questionListText(questions: TaskRecord['questions']): string {
  return (questions ?? []).map(item => {
    const title = item.header ? `${item.header}：${item.question}` : item.question
    const opts = item.options?.length
      ? `（选项：${item.options.map(option => option.label).join(' / ')}${item.multi_select ? '，可多选' : ''}）`
      : ''
    return `- [${item.id}] ${title}${opts}`
  }).join('\n')
}

/** task_update 返回值里的日程投影：极简字段，Worker 每次上报后可见最新清单。 */
export function scheduleProjection(schedules: Array<Pick<ScheduleRecord, 'id' | 'title' | 'status' | 'priority'>>): Array<{ id: string, title: string, status: string, priority: string }> {
  return schedules.map(schedule => ({ id: schedule.id, title: schedule.title, status: schedule.status, priority: schedule.priority }))
}

/** 投递给 Worker 时附带的会话日程现状：pending 全列（含 id，供 schedules.update 引用），
 * 用户已标完成的也列出（防止重复代办）；cancelled 不再提及。空清单不产生片段。 */
export function scheduleStatusSection(schedules: Array<Pick<ScheduleRecord, 'id' | 'title' | 'status' | 'priority' | 'startAt' | 'endAt' | 'remark' | 'completedBy' | 'links' | 'attachments' | 'contacts'>>): string {
  if (schedules.length === 0) return ''
  const lines: string[] = []
  for (const schedule of schedules) {
    if (schedule.status === 'pending') {
      lines.push(`- [${schedule.id}] ${schedule.title}${schedule.priority !== 'P3' ? `（${schedule.priority}）` : ''}${scheduleTimeLabel(schedule) ? `（${scheduleTimeLabel(schedule)}）` : ''} — 待处理`)
    } else if (schedule.status === 'done' && schedule.completedBy === 'user') {
      lines.push(`- [${schedule.id}] ${schedule.title} — 用户已自行标记完成，不要重复代办`)
    }
  }
  if (lines.length === 0) return ''
  return `\n\n# 会话日程现状\n${lines.join('\n')}`
}

/** roster 行的主题摘要段：截断 60 字，空摘要不产生片段。 */
export function rosterSummarySegment(summary: string | undefined): string {
  const text = summary?.trim() ?? ''
  if (!text) return ''
  return `｜摘要 ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`
}
