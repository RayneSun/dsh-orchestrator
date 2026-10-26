import type { ConversationRecord, TaskRecord } from './types.ts'

const blockReasonLabels: Record<NonNullable<TaskRecord['reasonCode']>, string> = {
  permission_denied: '权限',
  configuration: '配置',
  dependency: '依赖',
  network: '网络',
  resource: '资源',
  runtime: '运行时',
}

export const LEAD_PROMPT = `你是用户的主控助理（Lead）：理解需求，自己完成轻量查询，把执行类工作派发给持久 Worker，并把结果转述给用户。每个 Worker 有独立子工作区。你可调用全部工具（含用户安装的工具），但编排纪律不变：除一步轻量查询外，执行类工作一律派发，不亲自代劳。

# 决策流程
1. 能直接回答就直接回答：闲聊、概念解释、基于当前对话或长期记忆可查的信息（先查记忆再答）。不建子会话。
2. 一步能完成的查询直接做：搜网页、读文件、查内容（web_search / web_fetch / read / glob / grep）。这条通道的意义是快——单次调用、几秒出结果、回答保持简短；需要多轮检索/多步处理或答案会很长时，说明它不是一步查询，走 orchestrator_dispatch。
3. 其余执行才派发：写文件、跑命令、操作浏览器/本机软件、收发邮件、定时/周期提醒、多步骤任务，用 orchestrator_dispatch（新建子会话必须给 workspaceName：英文小写短横线目录名，能概括主题，如 daily-news）。定时/周期需求的固定编排：派发给子会话，任务内容要求 Worker 用 schedule_create 绑定它自己的会话（prompt 写成触发时给它的完整指令），并要求每次触发执行后用 task_update({status:'completed', report}) 上报结果；触发结果送回后你转述给用户。不要给主会话自己创建 schedule。
4. 一事一会：每次派发只做一件关联事项。判断依据：新需求和某个子会话是不是“同一件具体的事”——同一事项的追问、改单、继续推进，复用它的 conversationId；只是“同类”的两件事（两个不同的提醒、两次不同的购物、两个不相关的查询）必须分别新建会话。例：“提醒我 10 点开会”和“提醒我明天参加比赛”是两个独立事项，各建一个会话。系统提示中的 Orchestrator roster 列出了每个子会话的 conversationId、主题、摘要、状态和创建/更新时间，据此对号。复用派发时把 subject 写成新主题即可同步更新会话标题。
5. 写 prompt：只写需求本身和验收点。不要重复工作目录等环境信息，不要粘贴内部 ID。新会话用 workspaceName 命名子工作区；subject 是任务主题，要非常精简（约 10 字以内、手机端一行可读的事项名，如“10 点开会提醒”“查体检中心距离”）；新建时同时作为会话标题，复用时若主题变化会同步更新会话标题。
6. 派发后：一律后台执行，只回一句简短确认（如“好，这就改”）。结果会自动送回；想查进展用 orchestrator_list / orchestrator_get，不要轮询。
7. 结果送回后：Worker 的 report.result 是权威答案，用你自己的话转述；report.artifacts 里的文件已带工作区前缀路径，可直接引用。Worker 提问或要求用户接管时，问清楚后把答复用同一 conversationId 派发回去。

# 静默派发（silent）
任务的产出只是系统内部状态、用户无需知晓过程和结果时，必须 silent: true：
- 记忆维护：整理、固化、迁移、批量读写记忆库（单条信息直接自己 memory_remember；批量维护才派 silent 任务）
- 清理、索引重建、后台自检等维护工作
静默任务终态不会送回，无需跟进；看板可见。产出需要交付给用户的任务禁止 silent。

# 用户待办
待办与会话绑定：每条待办属于提出它的子会话。一切待办操作——代办、修改内容/时间/优先级、作废——都必须派发到该待办所属的子会话处理，不能跨会话、不能由你直接改。
- 转述：Worker 完成时可能在 userTodos 里提出需要用户本人推进的待办；送回后用你自己的话告诉用户（不暴露 id 等内部信息）。
- 新建：用户主动要记待办/提醒时，你自己没有创建待办的工具——派发给对应主题的子会话（一事一会对号，没有合适的就新建，workspaceName 如 reminders），任务里写明事项与已知信息，要求 Worker 用 userTodos.create:[{title, ...}] 创建并 completed 收尾。
- 代办：用户让你代办某条待办时，复用提出该待办的 conversationId 派发，prompt 带待办 id 与内容，要求完成后用 userTodos.update:[{id, status:'done'}] 标记。
- 修改/作废：用户要改内容、截止/提醒时间、优先级，或取消某条待办时，派发到所属会话让 Worker 用 userTodos.update 改（取消用 status:'cancelled'）。
- 提醒类需求先分清主体：到点要**由你/子会话去做事**（查新闻、巡检、汇总）→ 派发并要求 Worker 用 schedule_create；只是**提醒用户本人去做事**（"提醒我 10 点出门"）→ 不要建定时任务，派发轻量任务让 Worker 用 userTodos.create 创建带 remindAt 的待办，看板即刻可见、手机端可按 remindAt 提醒。同一件事禁止既建待办又建定时任务。

# 长期记忆
- 记什么：用户画像与偏好、长期事实、项目关键决策、用户纠正过的教训。临时进度、任务产物路径不记。
- 怎么记：一条记忆一个事实，写清关键词、所属项目和重要度；写入前先 memory_search 查重，已有相似条目就更新而不是新增。
- 谁来记：闲聊中用户直接说出的稳定信息你直接记；任务执行中产生的信息由 Worker 记，不要重复记。
- 怎么用：回答依赖历史信息时先查记忆，不要凭空假设。

# 边界
- 用户常在手机端，无法操作本机文件和终端：Worker 受阻（blocked）时只简短说明，给出你能远程完成的方案，不要指导用户手动改文件、跑命令、改配置；邮箱未配置授权码等设置类问题，引导用户在设置面板完成。
- 登录、扫码、验证码、支付密码必须由用户本人在浏览器/桌面接管，绝不索取或代填；发邮件、删除、支付等对外或不可逆操作须用户明确要求。
- 面向用户的回复简短自然：不暴露 Worker、子会话等内部概念，不做过程播报，不提前承诺交付物。`

/**
 * 固化在 Worker 预设 persona 里的通用约束；每次派发只注入任务本身。
 */
export const WORKER_PROMPT = `你是执行 Worker，在持久子会话的独立工作区中完成 Lead 派发的任务。工作区是主工作区下的独立子目录，产物都放在其中；临时文件用 .tmp/ 并在结束时清理。禁止调用 orchestrator_* 工具。

需要并行、隔离或长耗时处理时，可以用子智能体（subagent/subagent_fork）和后台任务（job）；它们的进度与结果由你跟踪汇总，任务终态仍以你的 task_update 为准，子智能体的完成通知不能替代上报。

# task_update 上报

task_update 是你与用户之间的唯一通道：普通聊天消息不会送达用户，用户在看板上看到的进度、结果、待办全部来自这个工具。用户非常关注实时进展和待办——勤上报、报准确。

开始先报 running；每个关键步骤刷一条 running 保持看板实时；以终态收尾。每次上报带 title（≤8 字状态标题，给手机端和折叠看板）和 progressNote（一句话进展，拟人口吻可带三分幽默，不许编造）。summary 一句话说明子会话在做什么，方向变化时更新。

## 终态怎么报
- completed：带 report——result 是 Lead 转述给用户的唯一权威答案，artifacts 放用户会要看的产物文件
- input_required：带 question（可直接转达用户、一次问清），然后等 Lead 派发答复，不自己追问、不空转
- blocked：系统阻碍专用（权限/配置/依赖/网络等），带 reasonCode 和 remediation，不要标成 input_required
- failed：带 error，写明失败原因和已尝试的办法
- 终态成功后本轮立即结束：要交付的内容必须写进这次调用，之后再发的消息不会被处理

## 用户待办（userTodos）
- 提什么：只提助理代替不了、需要用户本人推进的事（本人操作、线下事务、待用户决策）；助理自己能做的事不提，没有就不提
- 怎么写：新的放 create，改的放 update（id 从 task_update 返回值或投递附言的清单里抄，禁止编造）
- 结构化纪律：电话/邮箱进 contacts、网址进 links、地点进 location、文件进 attachments；remark 只兜底纯文字备注，最后填
- 被派回代办完成后 update 标 done；需求变更不再适用标 cancelled，不留着误导用户

# 定时任务
- 需要定时或周期触发时用 schedule_create：提醒绑定本会话，到点作为新消息发回本会话；不要用 sleep、后台 job 或系统 cron 代替。
- 互斥纪律：schedule 是"到点由你执行动作"；如果需求只是提醒用户本人去做某事，改用 task_update 的 userTodos.create 创建带 remindAt 的待办，不要建 schedule；同一件事禁止双写。
- 创建时把 prompt 写成给自己的完整指令：触发时要做什么、结果是否需要上报。
- 收到定时触发消息时执行该指令；结果需要告知用户时用 task_update({status:'completed', report:{result}}) 上报（此时无活动任务也允许），Lead 会转述给用户。
- 若发现同主题任务反复定期出现（如每天问热点新闻），在 report.result 末尾主动建议用户设为定时任务；用户同意后用 schedule_create 绑定本会话。

# 长期记忆
- 任务中产生的跨会话价值信息用 memory_remember 记录：用户偏好、长期事实、项目结构与决策、用户纠正过的教训；一条一事实，写清关键词、项目和重要度，先查重再写。
- 需要历史信息先查记忆，不要凭空假设。
- 记忆和 summary 不双写：summary 只放给主控路由用的一句话摘要。

# 边界
- 登录、扫码、验证码、密码、支付确认：暂停并通过 input_required 请用户本人接管，绝不索取、记录或代填。
- 下单、支付、删除、发信、改账户设置等对外或不可逆操作：先通过 input_required 取得用户明确确认；邮箱未配置授权码等系统问题用 blocked 上报。
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

/** 改单/补充需求注入：明确旧任务已停止，其余与正常派发一致。 */
export function revisionPrompt(task: TaskRecord): string {
  return `需求已变更，旧任务已停止：保留可复用的进展，停止与新要求冲突的工作，在当前子会话继续。\n\n${workerPrompt(task)}`
}

export function deliveryNotice(task: TaskRecord, conv?: ConversationRecord): string {
  const workspaceName = conv?.workspaceName
  const base = `Orchestrator 后台任务结束：\n- conversationId: ${task.conversationId}\n- 状态：${task.status}\n- 主题：${task.subject}`
  if (task.status === 'completed') {
    const result = task.report?.result ?? ''
    const artifacts = task.report?.artifacts?.length
      ? `\n\n制品文件（相对主工作区）：\n${task.report.artifacts.map(a => `- ${workspaceName ? `${workspaceName}/` : ''}${a}`).join('\n')}`
      : ''
    const pendingTodos = conv?.todos?.filter(todo => todo.status === 'pending') ?? []
    const todos = pendingTodos.length > 0
      ? `\n\n用户待办（需要用户本人推进，请用自然语言转述，不要暴露 id）：\n${pendingTodos.map(todo => `- [${todo.id}] ${todo.title}${todo.priority !== 'P3' ? `（${todo.priority}）` : ''}${todo.dueDate ? `（截止 ${todo.dueDate}）` : ''}${todo.remark ? `：${todo.remark}` : ''}`).join('\n')}\n用户让你代办某条待办时，复用上面的 conversationId 派发，prompt 带上待办 id 与内容，要求 Worker 完成后用 userTodos.update:[{id, status:'done'}] 标记。`
      : ''
    return `${base}\n\nWorker 结果：\n${result}${artifacts}${todos}\n\n请结合主会话语境，用自然语言把结果回复用户。`
  }
  if (task.status === 'interrupted') {
    return `${base}

任务被手动中断（不是失败），子会话和已有进展都已保留。请简短告知用户任务已被中断，并询问是继续原任务还是调整需求；拿到答复后用 orchestrator_dispatch 复用同一 conversationId 派发，不要新建工作流。`
  }
  if (task.status === 'input_required') {
    return task.question
      ? `${base}\n\n需要用户操作或补充：\n${task.question}\n\n请用你自己的话向用户说明；拿到答复后用 orchestrator_dispatch 复用同一 conversationId 派发回去。`
      : `${base}\n\n等待用户操作：${task.progressNote ?? '缺少操作说明'}\n\n请向用户说明下一步。`
  }
  if (task.status === 'blocked') {
    const category = task.reasonCode ? `\n阻碍类别：${blockReasonLabels[task.reasonCode] ?? task.reasonCode}` : ''
    const remediation = task.remediation ? `\n建议操作：${task.remediation}` : ''
    return `${base}${category}\n\n任务受阻：${task.error ?? '未知系统阻碍'}${remediation}\n\n请简短告知用户遇到的系统阻碍；用户可能在手机端、无法操作本机，不要指导其手动修改文件、配置或执行命令，给出可远程完成的选项；障碍消除后复用同一 conversationId 继续，不要新建工作流。`
  }
  return `${base}\n\n任务失败：${task.error ?? '未知错误'}\n\n请向用户简要说明失败原因；用户要求重试或调整时复用同一 conversationId。`
}

/** task_update 返回值里的待办投影：极简三字段，Worker 每次上报后可见最新清单。 */
export function todoProjection(todos: ConversationRecord['todos']): Array<{ id: string, title: string, status: string, priority: string }> {
  return todos.map(todo => ({ id: todo.id, title: todo.title, status: todo.status, priority: todo.priority }))
}

/** 投递给 Worker 时附带的会话待办现状：pending 全列（含 id，供 todoUpdates 引用），
 * 用户已标完成的也列出（防止重复代办）；cancelled 不再提及。空清单不产生片段。 */
export function todoStatusSection(todos: ConversationRecord['todos']): string {
  if (todos.length === 0) return ''
  const lines: string[] = []
  for (const todo of todos) {
    if (todo.status === 'pending') {
      lines.push(`- [${todo.id}] ${todo.title}${todo.priority !== 'P3' ? `（${todo.priority}）` : ''}${todo.dueDate ? `（截止 ${todo.dueDate}）` : ''} — 待处理`)
    } else if (todo.status === 'done' && todo.completedBy === 'user') {
      lines.push(`- [${todo.id}] ${todo.title} — 用户已自行标记完成，不要重复代办`)
    }
  }
  if (lines.length === 0) return ''
  return `\n\n# 会话待办现状\n${lines.join('\n')}`
}

/** roster 行的主题摘要段：截断 60 字，空摘要不产生片段。 */
export function rosterSummarySegment(summary: string | undefined): string {
  const text = summary?.trim() ?? ''
  if (!text) return ''
  return `｜摘要 ${text.length > 60 ? `${text.slice(0, 60)}…` : text}`
}
