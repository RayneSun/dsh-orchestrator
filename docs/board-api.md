# dsh-orchestrator 任务看板数据接口（v0.3.20）

> 面向下游（移动端 App）开发者。本文档描述 DSH Orchestrator 插件在 DSH Web（默认 `http://127.0.0.1:3080`）中暴露的任务看板数据结构、状态定义、同步机制与展示建议。
> 完整契约；相比 0.3.19 的无字段变化说明见[变更说明](board-api-v0.3.20-changes.md)；0.3.18 升级仍需阅读[破坏性变更与迁移步骤](board-api-v0.3.19-changes.md)。

**⚠️ v0.3.18 → v0.3.19 破坏性变化（下游必读）**：
1. **Task 字段拍平**：`task.report = { result, artifacts?, card? }` 拆为顶层 `task.result / task.artifacts / task.card`；`task.fail = { error, reasonCode? }` 拆为顶层 `task.error / task.reasonCode`。旧包裹字段不再输出。
2. **Worker 上报协议拆分**：单工具 `task_update` 拆为 5 个工具——`task_running / task_input_required / task_completed / task_failed / task_schedule`；`schedules` 不再挂在状态上报上，改为独立 `task_schedule` 工具。状态枚举与 snapshot 结构除上述拍平外不变。
3. **不兼容旧会话**：升级后domain v3 不加载旧域的 Conversation/Task/Schedule；旧 ID 不可复用，升级前备份旧域并停用旧 Worker 定时任务。三个 RPC 方法名与请求不变，snapshot 的 Task 字段结构已变化。

## 1. 接入方式

### 1.1 数据源

看板数据由插件的 Cordis/typert 远程服务提供，与 Web 前端看板同源。所有数据按主会话隔离：请求携带 `parentSessionId`，只返回该主会话下的子会话与任务。

包身份为 `@cmjt/dsh-orchestrator`，typert descriptor 前缀为 `@cmjt/dsh-orchestrator#orchestrator/`；DSH 暴露的方法路径仍为 `orchestrator/<method>`。

### 1.2 远程方法

**snapshot**（拉取全量）：

| 项 | 值 |
|---|---|
| 远程方法 | `orchestrator/snapshot` |
| 请求 | `{ "parentSessionId": "<主会话 sessionId>" }` |
| 响应 | `{ "conversations": Conversation[], "tasks": Task[], "schedules": Schedule[] }` |
| 排序 | 三个数组均按 `createdAt` 升序 |
| 说明 | Conversation 均为该主会话的子会话；Task 只包含属于这些子会话的任务；Schedule 为主会话 scope 的全部用户日程（跨子会话汇总，`conversationTitle` 投影来源会话名） |

**setScheduleStatus**（用户画勾/取消日程）：

| 项 | 值 |
|---|---|
| 远程方法 | `orchestrator/setScheduleStatus` |
| 请求 | `{ "scheduleId": "sch_<uuid>", "status": "pending" \| "done" }` |
| 响应 | `{ "ok": true }`；scheduleId 不存在时抛错 |
| 说明 | 目标状态只接受 pending / done；done 写 `completedBy: "user"`，pending 清除 completedBy。RPC 不检查原状态；Web 对 cancelled 禁用勾选，App 应遵循相同规则，不可请求设置 cancelled |

**answerTaskQuestions**（问题卡作答）：

| 项 | 值 |
|---|---|
| 远程方法 | `orchestrator/answerTaskQuestions` |
| 请求 | `{ "childSessionId": "<子会话 sessionId>", "answers": QuestionAnswer[] }` |
| 响应 | `{ "ok": true, "taskId": "task_<uuid>" }`，失败为 `{ "ok": false, "error": string }` |
| 行为 | 串行幂等：只有最新任务仍是 `input_required` 才接受；先答先赢。Host resolve 挂起的 `task_input_required` 工具调用（工具返回用户答案，Worker 同轮继续），并 abort 另一侧未答的问题卡。 |

### 1.3 变更通知

任意看板数据变化（任务上报、日程变更、状态流转）后，插件广播 `commands/change` 事件（无载荷）。推荐：进入时拉取 snapshot；订阅 `commands/change` 后重拉；5 秒轮询兜底。一致性锚点：`updatedAt`（Conversation/Schedule）、`revision`（Task）。

## 2. Conversation（子会话）

子会话 = 主会话派发的一个持久工作流（一个工作区、一条独立会话、多轮任务）。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | `conv_<uuid>` |
| childSessionId | string | 子会话 DSH 会话 ID；跳转子会话、问题卡作答都用它 |
| parentSessionId | string | 所属主会话 ID（与请求参数一致） |
| title | string | 子会话标题（默认=首个任务主题，复用派发可同步更新） |
| workspaceName | string? | 子工作区目录名（英文 slug，位于主工作区内） |
| workspaceDir | string? | 子工作区绝对路径（移动端一般不展示） |
| outline.summary | string | 最近 dispatch 主题链，Host 用 `'｜'` 拼接，最多保留 5 个；仅用于路由/摘要，不再由 Worker 上报。outline 仅剩此一个字段（v0.3.17 起大纲死字段 keyFacts/entities/tags/artifacts/openQuestions 删除） |
| activeTaskId | string \| null | 当前进行中的任务 ID |
| lastTaskId | string \| null | 最近一次任务 ID |
| state | ConversationState | 会话聚合状态：`provisioning / running / idle / input_required / failed`。生命周期：活动任务上报 `input_required` 时同步为该值（`activeTaskId` 保留，轮次未结束）；作答后回 `running`；`completed / failed / interrupted` settle 回 `idle` |
| revision | number | 乐观锁版本号，任意字段变化时 +1 |
| hasActiveSchedule | boolean? | 仅 snapshot 投影字段（不落库）：子会话绑定了活动定时任务；App 可渲染 ⏰ 标记 |
| createdAt / updatedAt | string(ISO 8601) | 创建/更新时间 |

## 3. Task（子任务 / TaskRun）

Task 是子会话内的一次任务执行记录（一次 dispatch / 一次定时触发 / 一次改单）。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | `task_<uuid>` |
| conversationId | string | 所属子会话 |
| parentSessionId | string | 所属主会话 |
| predecessorTaskId | string \| null | 前驱任务（改单/续派时指向被停止的旧任务，否则 null） |
| subject | string | 任务主题（极简，约 10 字，移动端主展示文案） |
| prompt | string | 派发指令原文（内部信息，App 一般不展示） |
| acceptanceCriteria | string? | 验收标准 |
| status | TaskStatus | 任务状态，见 §6 |
| header | string? | 极简状态标题（新上报输入限制 ≤8 字；存储读取不限制旧值长度；折叠态/手机端主展示） |
| progressNote | string? | 一句话进展汇报（拟人风格，实时刷新） |
| questions | QuestionItem[]? | `input_required` 时必填，结构化问题，见 §4 |
| answers | QuestionAnswer[]? | 问题卡作答留痕；Host 恢复 running 前写入，同轮继续 |
| result | string? | `completed` 时必填：面向用户的简短结论，不含文件路径或实现细节，不重复 card/制品内容 |
| artifacts | string[]? | completed 关键制品文件（子工作区相对路径），由 Lead 通过 present 交付 |
| card | Record<string, unknown>? | completed 的 dsh-ui 展示卡片 JSON（≤16KB，禁围栏嵌套） |
| error | string? | `failed` 时必填：失败原因 |
| reasonCode | BlockReasonCode? | failed 的系统阻碍类别；普通失败不填 |
| cancelledReason | string? | interrupted 时的中断归类（如 parent、手动停止） |
| progressSteps | ProgressStep[] | 多步骤进度清单（来自 Worker 的 todo_write），见 §8 |
| silent | boolean | 会话/任务是否静默；true 时终态不向主会话投递 |
| scheduled | boolean? | 定时触发产生的上报任务标记 |
| delivery | Delivery? | 终态投递回执，见 §9；silent 不产生 |
| revision | number | 任务版本号，每次更新 +1 |
| createdAt / updatedAt | string(ISO 8601) | 创建/更新时间 |
| startedAt | string(ISO 8601)? | 第一次进入 running 的时间 |
| endedAt | string(ISO 8601)? | completed/failed/interrupted 的结束时间；input_required 等待期间不设置 |

## 4. QuestionItem 与 QuestionAnswer

```ts
QuestionItem = {
  id: string           // Worker 输入可省略；Host 补 q1/q2/…，snapshot 与作答后的 answers 使用该 id
  question: string     // 问题正文
  header?: string      // 短标题/分组
  detail?: string      // 补充说明
  options?: { label: string, description?: string }[]
  multi_select?: boolean
}
QuestionAnswer = {
  id: string
  selected: string[]   // 选中 option.label；单选最多 1 个
  custom?: string      // 自定义输入
}
```

问题卡只出现在两处：任务看板、Worker 子会话内由 `userQuestions.ask` 创建的原生问题卡（主会话不参与投递，`answerTaskQuestions` 同源路由，任一处作答另一处自动消失）。停止、改单、工具取消或服务卸载会清理等待，已取消原生卡晚到的答案不会进入后续提问；Host 重启后遗留 `input_required` 转为已有 `interrupted`，Conversation 回 `idle`，不投递 Lead。

## 5. Schedule（用户日程）

主会话 scope 的独立表（domain v3 存储）。一次任务可创建多条；App 可按会话（归属回链）或按时间（日程页）两个维度展示。没有 startAt 的日程只在会话页出现，即使有 endAt，日程页也跳过。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | `sch_<uuid>`；旧 `todo_` id 已废弃，Worker 引用会报不存在 |
| parentSessionId | string | 主会话 ID（scope 归属） |
| conversationId | string | 提出该日程的子会话 ID（归属回链；代办/修改派回此会话） |
| conversationTitle | string | 仅 snapshot 投影，必有字段：来源子会话标题，未找到时为 `''`；日程页渲染「来自 xx」 |
| title | string | 极简标题，≤30 字 |
| allDay | boolean | 全天日程标记；缺省 false（旧记录免迁移） |
| startAt | string? | allDay=true 时为完整纯日期 `YYYY-MM-DD`（必填，不落时区）；否则为 ISO 8601 带时区时间戳（可缺省） |
| endAt | string? | allDay=true 时为完整纯日期，**尾日包含**（11-04 到 11-06 存 `2026-11-06`，单日可省略）；否则为 ISO 8601 时间戳/死线 |
| remindAt | string(ISO 8601)? | 用户提醒时间；不受 allDay 影响，恒为绝对时刻（全天日程也可设提醒） |
| priority | `'P0' \| 'P1' \| 'P2' \| 'P3'` | 四象限；默认 P3 |
| links | `{ url, label? }[]` | http(s) 链接，≤10 |
| attachments | `{ path, name? }[]` | 子工作区相对路径，≤10；展示/打开时拼 `<workspaceName>/<path>` |
| contacts | `{ name, phone?, email?, note? }[]` | ≤5；移动端可渲染 tel:/mailto: |
| location | `{ name, address? }?` | 地点名称与地址 |
| remark | string? | 纯文字备注；联系方式/链接/地点/文件应放结构化字段 |
| status | `'pending' \| 'done' \| 'cancelled'` | done/cancelled 非待处理 |
| completedBy | `'user' \| 'worker'`? | 用户标 done 为 user；Worker 标 done / cancelled 为 worker；恢复 pending 清除 |
| createdAt / updatedAt | string(ISO 8601) | 创建/更新时间 |

时间输入在 Worker 上报时按 allDay 分叉解析，存储后格式互斥：

- **普通日程（allDay=false/缺省）**：startAt/endAt 必须带时刻（`10-29 09:30`、`2026-10-29T09:00`、完整 ISO 8601 均可），归一化为带本地时区的 ISO 8601。**纯日期输入一律拒绝**（含 `10-25` 月-日简写），不再猜测午夜——`2026-11-04` 与 `2026-11-04 00:00` 从此语义可分。
- **全天日程（allDay=true）**：startAt 必填完整纯日期 `YYYY-MM-DD`（不省略年、不带时刻）；endAt 可选、尾日包含、≥ startAt。纯日期不落时区，任何设备时区读取均为同一日历日。
- **模式与时间一起提交**：task_schedule 的 `update` 显式提供 allDay 时必须同时携带对应格式的 startAt（全天带纯日期、普通带时刻），只给 allDay 会被 schema 拒绝。省略 allDay 的时间 patch 按普通带时刻语义解析；更新全天纯日期时必须显式带 `allDay: true` 与 startAt。patch 与存量记录合并后，Host 再校验整条记录的时间一致性。
- **先校验再写入**：整批 create / update 校验完成后才开始写入；同一 id 的多个 patch 按顺序合并，归属或时间校验失败时零写入。存储没有跨记录 I/O 事务，磁盘失败或进程崩溃仍可能部分落盘。
- **互斥**：allDay 与 startAt/endAt 格式一一绑定，不存在"全天 + 时刻"混合记录；remindAt 恒为绝对时刻。

> 与 RFC 5545 / MS Graph 的差异：本契约 endAt 为**包含端**（尾日当天有效），迁移自他方日历数据时注意换算（iCal/Graph 的排除端需减一天）。

## 6. TaskStatus 与 Worker 上报协议

**TaskStatus（存储/看板）**：`queued / running / input_required / completed / failed / interrupted`

| 状态 | 含义 | 关键字段 |
|---|---|---|
| queued | 已入队，Worker 轮次未开始 | — |
| running | 执行中 | header / progressNote / progressSteps |
| input_required | 待用户操作（阻塞工具，看板 + 子会话原生卡双入口作答） | questions 必填 |
| completed | 完成 | result 必填 |
| failed | 失败（含系统阻碍） | error 必填；系统阻碍加 reasonCode |
| interrupted | 改单接管、用户手动停止或重启恢复 | cancelledReason |

**Worker 上报协议（v0.3.19 起 5 个独立工具，单工具 `task_update` 已删除）**：

```txt
task_running        { header?, progressNote? }
task_input_required { header?, progressNote?, questions: QuestionItem[] ★ }   阻塞调用，返回用户答案
task_completed      { header?, progressNote?, result: string ★, artifacts?, card? }   终态，本轮立即结束
task_failed         { header?, progressNote?, error: string ★, reasonCode? }          终态，本轮立即结束
task_schedule       { create?: ScheduleNew[], update?: ScheduleUpdate[] }   日程 CRUD，与任务状态无关
```

- `task_input_required` 为阻塞调用，返回值即用户答案 `{ answers: [{id, selected, custom?}] }`，Worker 同轮继续。
- `task_completed / task_failed` 为终态：提交成功后 Worker 本轮不再推理；无活动任务的定时触发轮次只允许 `task_completed`。
- `task_schedule` 返回最新日程清单（含 id），随时可调用，不产生状态迁移。
- `reasonCode`：`permission_denied / configuration / dependency / network / resource / runtime`。

## 7. 状态映射与展示

| TaskStatus | 建议文案 | 颜色 |
|---|---|---|
| queued / running | 进行中 | 蓝 |
| input_required | 待你操作 | 橙/警告 |
| completed | 已完成 | 绿 |
| failed | 失败 | 红 |
| interrupted | 已停止 | 灰 |

会话头徽标跟随最新任务；静默显示 🚫；`hasActiveSchedule` 显示 ⏰。

**消费方聚合规则**：非 idle 会话（`provisioning / running / input_required / failed`）以 `Conversation.state` 为准，只有 `idle` 才回查 `lastTaskId.status`。待决策事项（`input_required`）因此必须同时体现在 `Conversation.state` 上。

## 8. ProgressStep（多步骤进度）

| 字段 | 类型 | 说明 |
|---|---|---|
| content | string | 步骤描述（≤300 字） |
| status | enum | `pending / in_progress / completed` |

App 渲染建议：列表 + 勾（completed）/ 转（in_progress）/ 空（pending），按数组顺序。

## 9. Delivery（终态投递回执）

任务终态结果通过 outbox 异步送达主会话（Lead），`delivery` 记录投递状态（silent 任务不产生 delivery）：

| state | 字段 | 说明 |
|---|---|---|
| pending | `attempts`, `lastError?` | 待投递 |
| delivered | `deliveredAt`, `messageId` | 已送达 |

投递开关：completed / failed / interrupted 默认开；input_required 恒为关（问题卡只在看板 + 子会话渲染，主会话不参与）。

## 10. 看板层级与展示建议

标题行下方有独立的维度页签：**会话**（会话页）与 **日程**（日历页）。停留在日程页时若有任务更新，会话页签显示未读提醒点（颜色跟最新任务状态：运行/完成绿、失败红、待操作橙），点击看板页签即清除。

**看板页（会话页）**：

1. **会话卡片**：chevron + 属性图标（🚫/⏰）+ title + 最新任务状态徽标 + 打开子会话按钮。
2. **折叠态**：保留问题卡与日程框；可保留“最新任务 · 创建时间 · 耗时”一行。任务体/工作区收起。
3. **问题卡**：位于日程框上方，warn 色框；单选切换、多选叠加、custom 输入、提交后卡片消失。
4. **日程框**：位于工作区行上方；折叠/展开恒显；框头 `日程 · N 项待处理`（0 项为“全部完成”）；done/cancelled 灰显划线；优先级胶囊 P0/P1/P2/P3，颜色红/橙/黄/绿；时间窗/提醒渲染为胶囊。
5. **任务框**：圈住多轮；默认折叠只显示最新一轮，框头 `N 轮 · 显示最新`，可展开全部。
6. **任务行**：状态徽标 + subject（有卡片时附卡片徽标）；下一行 `header: progressNote`（running 带 shimmer）；失败可展开错误；completed/input_required 可展开结果/作答；completed 的卡片可展开原始 JSON 预览；脚注创建时间与实时耗时。

**日程页（日历页）**：

- 月历：周一起始，‹ / 今天 / › 导航；今天描边、选中日高亮；每天下方显示活动日程的优先级色点（最多 3 个 +「+N」），跨天事项每天出现。
- 选中日列表：默认今天；标题「M 月 D 日 周X · N 条」；已过期未完成的日程置顶「已过期」分组（红字）；每行下方「来自 {conversationTitle}」来源回链。
- 无 startAt 的日程不进日程页；两页共用日程行，均显示 P0–P3 优先级胶囊，点行展开详情（备注/链接/附件/联系人/地点胶囊）。

## 11. 同步与兼容性注意

- snapshot 使用当前严格 schema；不做旧版本记录迁移。
- **v0.3.18 → v0.3.19（破坏性）**：
  - `task.report` / `task.fail` 包裹层删除：`report.result / report.artifacts / report.card` → `task.result / task.artifacts / task.card`；`fail.error / fail.reasonCode` → `task.error / task.reasonCode`。
  - Worker 协议：单工具 `task_update` 拆为 `task_running / task_input_required / task_completed / task_failed / task_schedule`；状态上报不再携带 `schedules`。
  - domain v3 不接纳 v1/v2 数据，升级前备份并移出旧域；保留备份及原 DSH transcript，新版需新建会话。
- **v0.3.17 → v0.3.18**：snapshot / RPC 和存储格式不变，无新增 status，无 schema 迁移。`Snapshot` 与 RPC 请求类型从原有 Zod schema 推导；`snapshotResultSchema` 移至 types.ts，remote.ts 保留重导出。生命周期修复会使遗留等待任务在重启后进入已有 interrupted 状态。
- 以下为历史变更记录，包含当时的方案用语；当前问题卡只有看板与 Worker 原生卡两个入口，以 §4 为准。
- **v0.3.13 → v0.3.14 破坏性变化**：
  - `TaskStatus` 删除 `blocked`；系统阻碍并入 `failed.fail.reasonCode`。
  - `task.error / task.reasonCode / task.remediation` 删除；改为 `task.fail = { error, reasonCode? }`。
  - `task.title` 改名 `task.header`。
  - `task.question` 字符串删除；改为 `task.questions: QuestionItem[]`。
  - `task.summary` 删除；`Conversation.outline.summary` 由 Host 自动维护。
  - `task_update` Worker 状态删除 `blocked`；`fail` 对象必填；`userTodos` 全状态开放。
  - 新增 `answerTaskQuestions` RPC；问题卡可三处作答。
- **v0.3.16 → v0.3.17 破坏性变化**：
- **v0.3.16 → v0.3.17 新增字段**：
  - `TaskReport.card?: Record<string, unknown>`：dsh-ui 展示卡片 JSON；仅 `status=completed` 时存在。App 可先渲染原生控件，无法识别时降级为 JSON 预览或忽略。
  - 终态投递给 Lead 的文本会包含 Worker `result` 和序列化后的 `dsh-ui` 围栏；App 若解析主会话文本，需保留围栏原文以供 dsh-genui 客户端渲染。
  - `Conversation.outline` 仅剩 `summary`；`keyFacts / entities / tags / artifacts / openQuestions` 死字段删除（此前恒为空数组，无消费方）。
  - `Conversation.todos` 彻底删除（v0.3.15 已移入顶层 `snapshot.schedules`，本版起旧记录中的残留数据直接丢弃，不再迁移）。
- **v0.3.14 → v0.3.15 破坏性变化**：
  - `userTodos` 协议改名 `schedules`（无别名）；id 前缀统一 `sch_`（存量迁移分配全新 id，旧 `todo_` id 失效）。
  - `Conversation.todos` 删除；改为顶层 `snapshot.schedules: Schedule[]`（主会话 scope，含 `conversationId`/`conversationTitle`）。
  - RPC `setTodoStatus` → `setScheduleStatus`（请求字段 `todoId` → `scheduleId`）。
  - 新增看板「日程」页签（月历）；日程无时间字段时不进日程页。
- 下游不应持久化 snapshot 作为长期数据；以 `revision`/`updatedAt` 做增量判断，重拉即可。
- App 按当前主会话取数，切换主会话必须重新拉取。

## 12. 提醒时间的执行边界

`Schedule.remindAt` 是供 App 通知使用的提醒时间元数据；本插件仅校验、持久化与展示，不会据此启动到点消息。需要 Agent 到点执行并回报时，使用 DSH 原生定时任务；它与用户日程是不同机制。
