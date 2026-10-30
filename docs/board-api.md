# dsh-orchestrator 任务看板数据接口（v0.3.15 日程升级版）

> 面向下游（移动端 App）开发者。本文档完整描述 DSH Orchestrator 插件在 DSH Web（默认 `http://127.0.0.1:3080`）中暴露的任务看板数据结构：全部字段、全部状态定义、同步机制与展示建议。基于 v0.3.15：用户待办升级为用户日程（独立表 + 双页签看板）。
> 内部资料，请勿公开分发。

## 1. 接入方式

### 1.1 数据源

看板数据由插件的 Cordis/typert 远程服务提供，与 Web 前端看板同源。所有数据按主会话隔离：请求携带 `parentSessionId`，只返回该主会话下的子会话与任务。

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
| 说明 | 只允许 pending ↔ done 互转；落库 `completedBy: "user"`。`cancelled` 只能由子会话标记，App 不可设置 |

**answerTaskQuestions**（问题卡作答）：

| 项 | 值 |
|---|---|
| 远程方法 | `orchestrator/answerTaskQuestions` |
| 请求 | `{ "childSessionId": "<子会话 sessionId>", "answers": QuestionAnswer[] }` |
| 响应 | `{ "ok": true, "taskId": "task_<uuid>" }`，失败为 `{ "ok": false, "error": string }` |
| 行为 | 串行幂等：只有最新任务仍是 `input_required` 才接受；先答先赢。Host resolve 挂起的 `task_update(input_required)` 工具调用（工具返回用户答案，Worker 同轮继续），并 abort 另一侧未答的问题卡。 |

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
| outline.summary | string | 最近 dispatch 主题链，Host 用 `'｜'` 拼接，最多保留 5 个；仅用于路由/摘要，不再由 Worker 上报 |
| outline.keyFacts / entities / tags / artifacts / openQuestions | string[] | 结构兼容保留，恒为空数组，可忽略 |
| activeTaskId | string \| null | 当前进行中的任务 ID |
| lastTaskId | string \| null | 最近一次任务 ID |
| state | ConversationState | 会话聚合状态：`provisioning / running / idle / input_required / failed` |
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
| header | string? | 极简状态标题（≤8 字，progressNote 压缩版；折叠态/手机端主展示） |
| progressNote | string? | 一句话进展汇报（拟人风格，实时刷新） |
| questions | QuestionItem[]? | `input_required` 时必填，结构化问题，见 §4 |
| answers | QuestionAnswer[]? | 问题卡作答留痕；Host 重开任务前写入 |
| fail | TaskFail? | `failed` 时必填：`{ error, reasonCode? }`，不再有顶层 error/reasonCode/remediation |
| cancelledReason | string? | interrupted 时的中断归类（如 parent、手动停止） |
| report | TaskReport? | completed 时必填：`{ result, artifacts? }` |
| progressSteps | ProgressStep[] | 多步骤进度清单（来自 Worker 的 todo_write），见 §8 |
| silent | boolean | 会话/任务是否静默；true 时终态不向主会话投递 |
| scheduled | boolean? | 定时触发产生的上报任务标记 |
| delivery | Delivery? | 终态投递回执，见 §9；silent 不产生 |
| revision | number | 任务版本号，每次更新 +1 |
| createdAt / updatedAt | string(ISO 8601) | 创建/更新时间 |
| startedAt | string(ISO 8601)? | 第一次进入 running 的时间 |
| endedAt | string(ISO 8601)? | 终态结束时间；input_required 被回答恢复 running 后清除，最终终态再写入 |

## 4. QuestionItem 与 QuestionAnswer

```ts
QuestionItem = {
  id: string           // Worker 可省略；Host 自动补 q1/q2/… 并在 task_update 返回值回显
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

问题卡只出现在两处：任务看板、子会话对话内 task_update 工具行（主会话不参与投递，`answerTaskQuestions` 同源路由，任一处作答另一处自动消失）。

## 5. Schedule（用户日程）

主会话 scope 的独立表（v2 存储，旧 `Conversation.todos` 启动时幂等迁移）。一次任务可创建多条；App 可按会话（归属回链）或按时间（日程页）两个维度展示。没有 startAt/endAt 的日程只在会话页出现，日程页跳过。

| 字段 | 类型 | 说明 |
|---|---|---|
| id | string | `sch_<uuid>`；v1 存量迁移时分配全新 id（旧 `todo_` id 不保留，Worker 引用旧 id 会报不存在） |
| parentSessionId | string | 主会话 ID（scope 归属） |
| conversationId | string | 提出该日程的子会话 ID（归属回链；代办/修改派回此会话） |
| conversationTitle | string? | 仅 snapshot 投影：来源子会话标题，日程页渲染「来自 xx」 |
| title | string | 极简标题，≤30 字 |
| startAt | string(ISO 8601)? | 时间窗开始；与 endAt 同时存在时不得晚于 endAt |
| endAt | string(ISO 8601)? | 时间窗结束/死线 |
| remindAt | string(ISO 8601)? | 用户提醒时间 |
| priority | `'P0' \| 'P1' \| 'P2' \| 'P3'` | 四象限；默认 P3 |
| links | `{ url, label? }[]` | http(s) 链接，≤10 |
| attachments | `{ path, name? }[]` | 子工作区相对路径，≤10；展示/打开时拼 `<workspaceName>/<path>` |
| contacts | `{ name, phone?, email?, note? }[]` | ≤5；移动端可渲染 tel:/mailto: |
| location | `{ name, address? }?` | 地点名称与地址 |
| remark | string? | 纯文字备注；联系方式/链接/地点/文件应放结构化字段 |
| status | `'pending' \| 'done' \| 'cancelled'` | done/cancelled 非待处理 |
| completedBy | `'user' \| 'worker'`? | done 的完成方；pending 无 |
| createdAt / updatedAt | string(ISO 8601) | 创建/更新时间 |

时间输入在 Worker 上报时走宽松解析（`10-29 09:30`、`2026-10-29`、完整 ISO 8601 均可），存储归一化为带本地时区的 ISO 8601。

## 6. TaskStatus 与 Worker 上报协议

**TaskStatus（存储/看板）**：`queued / running / input_required / completed / failed / interrupted`

| 状态 | 含义 | 关键字段 |
|---|---|---|
| queued | 已入队，Worker 轮次未开始 | — |
| running | 执行中 | header / progressNote / progressSteps / schedules 可更新 |
| input_required | 待用户操作（阻塞工具，看板 + 子会话原生卡双入口作答） | questions 必填 |
| completed | 完成 | report 必填 |
| failed | 失败（含系统阻碍） | fail.error 必填；系统阻碍加 fail.reasonCode |
| interrupted | 改单接管、用户手动停止或重启恢复 | cancelledReason |

**Worker task_update 状态（协议）**：`running / input_required / completed / failed`（`blocked` 已删除；`interrupted` 只由 Host 写入）。

```txt
task_update（input_required 为阻塞调用，返回值即用户答案 { answers: [{id, selected, custom?}] }）
├── status: 'running'|'input_required'|'completed'|'failed'  ★
├── header?: string                    全状态可选，≤8 字
├── progressNote?: string              全状态可选，一句话进展
├── schedules?: { create?: ScheduleNew[], update?: ScheduleUpdate[] }   全状态可选，顶层字段
├── questions?: QuestionItem[]         input_required ★ 必填
├── report?: { result ★, artifacts? }  completed ★ 必填
└── fail?: { error ★, reasonCode? }    failed ★ 必填
```

`reasonCode`：`permission_denied / configuration / dependency / network / resource / runtime`。

## 7. 状态映射与展示

| TaskStatus | 建议文案 | 颜色 |
|---|---|---|
| queued / running | 进行中 | 蓝 |
| input_required | 待你操作 | 橙/警告 |
| completed | 已完成 | 绿 |
| failed | 失败 | 红 |
| interrupted | 已停止 | 灰 |

会话头徽标跟随最新任务；静默显示 🚫；`hasActiveSchedule` 显示 ⏰。

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
6. **任务行**：状态徽标 + subject；下一行 `header: progressNote`（running 带 shimmer）；失败可展开错误；completed/input_required 可展开结果/作答；脚注创建时间与实时耗时。

**日程页（日历页）**：

- 月历：周一起始，‹ / 今天 / › 导航；今天描边、选中日高亮；每天下方显示活动日程的优先级色点（最多 3 个 +「+N」），跨天事项每天出现。
- 选中日列表：默认今天；标题「M 月 D 日 周X · N 条」；已过期未完成的日程置顶「已过期」分组（红字）；每行下方「来自 {conversationTitle}」来源回链。
- 无 startAt/endAt 的日程不进日程页；同一行组件与看板页共用，点行展开详情（备注/链接/附件/联系人/地点胶囊）。

## 11. 同步与兼容性注意

- snapshot 读取时经 schema 迁移，输出永远是最新结构。
- **v0.3.13 → v0.3.14 破坏性变化**：
  - `TaskStatus` 删除 `blocked`；系统阻碍并入 `failed.fail.reasonCode`。
  - `task.error / task.reasonCode / task.remediation` 删除；改为 `task.fail = { error, reasonCode? }`。
  - `task.title` 改名 `task.header`。
  - `task.question` 字符串删除；改为 `task.questions: QuestionItem[]`。
  - `task.summary` 删除；`Conversation.outline.summary` 由 Host 自动维护。
  - `task_update` Worker 状态删除 `blocked`；`fail` 对象必填；`userTodos` 全状态开放。
  - 新增 `answerTaskQuestions` RPC；问题卡可三处作答。
- **v0.3.14 → v0.3.15 破坏性变化**：
  - `userTodos` 协议改名 `schedules`（无别名）；id 前缀统一 `sch_`（存量迁移分配全新 id，旧 `todo_` id 失效）。
  - `Conversation.todos` 删除；改为顶层 `snapshot.schedules: Schedule[]`（主会话 scope，含 `conversationId`/`conversationTitle`）。
  - RPC `setTodoStatus` → `setScheduleStatus`（请求字段 `todoId` → `scheduleId`）。
  - 新增看板「日程」页签（月历）；日程无时间字段时不进日程页。
- 下游不应持久化 snapshot 作为长期数据；以 `revision`/`updatedAt` 做增量判断，重拉即可。
- App 按当前主会话取数，切换主会话必须重新拉取。
