# AGENTS.md — dsh-orchestrator 开发指引

面向接管本仓库的 AI 编码助手。读完本文件再动手。

## 项目是什么

`@may/dsh-orchestrator`：DSH（DeepSeek Harness，基线 `0.2.1-rc.2`）的编排插件。

- **Lead**（主会话，预设 `may-orchestrator-lead`）：理解需求、路由、派发任务、向用户转述结果。工具**不做裁剪**：宿主与用户安装的全部全局工具可见（后装工具自动生效）；编排纪律由 persona 约束——一步查询直接做，执行类工作全部派发，不给主会话自建 schedule。
- **Worker**（持久**根会话**，预设 `may-orchestrator-worker`）：执行任务。不是 subagent——通过 `agents.create` 创建（无 origin/delegationDepth），与主会话同为一等会话，schedule 等仅 depth-0 可用的宿主能力对 Worker 开放。工具**黑名单**制（只禁派生/编排/直接提问），其余宿主与用户安装的工具默认可用。
- 两层领域模型：**Conversation**（持久子会话/工作流）1—N **TaskRun**（一次派发）。
- 技术栈：pnpm + TypeScript + Cordis + Zod + tsdown + vitest。4 个入口：主插件、client（看板 React）、typert host/remote（snapshot / setTodoStatus RPC）。

## 本机环境与硬性约束

- DSH CLI 全局包：`@deepseek-ai/dsh@0.2.1-rc.2`（`/opt/homebrew/lib/node_modules`，读 API 定义从这里查）。**CLI 是 web 的运行时**，升级 CLI 用全局 npm；**GUI（`/Applications/DeepSeek Harness.app`）绝不能动**。
- 真实 web profile：`~/.dsh/profiles/web`。
- **重启 web 必须用脚本**：`/Users/lixuchuan/work/harness/start-dsh-web.sh`（设置 NODE_EXTRA_CA_CERTS、清代理，内部 `exec dsh web --host 127.0.0.1 --port 3080`）。不要直接 `dsh web`。脚本需用 `start_new_session` 方式彻底脱离当前会话启动，否则进程会被回收。
- 访问/写入 `~/.dsh`、`dsh plugin`、kill 3080 端口、启动 dsh 都需要沙箱提权。GitHub 访问不稳定，push/release 失败时按用户约定请求开代理。
- pnpm 供应链校验在沙箱无网时会挂起：typecheck/test/build 直接用 `./node_modules/.bin/tsc|vitest|tsdown`；`pnpm install` 需提权 + `CI=true npm_config_cache=/private/tmp/dsh-orchestrator-npm-cache`，改 manifest 后加 `--no-frozen-lockfile`。
- `npm pack`/缓存写 `~/.npm` 会 EPERM，必须：`export npm_config_cache=/private/tmp/dsh-orchestrator-npm-cache`。
- 插件安装到 profile 必须用 **tgz 绝对路径**（相对路径会被 pnpm 误判为 GitHub 简写）；先 remove 再 add，仅重启不会更新 bundle。

## 标准发布流程

```bash
./node_modules/.bin/tsc -p tsconfig.json --noEmit
./node_modules/.bin/tsc -p tsconfig.client.json --noEmit
./node_modules/.bin/vitest run        # 当前 86 个用例
./node_modules/.bin/tsdown            # 应无弃用警告
export npm_config_cache=/private/tmp/dsh-orchestrator-npm-cache
node scripts/verify-packaging.mjs     # 校验 tgz 只含运行所需 lib/、vendor/、cordis.patch.yml 等
npm pack --pack-destination dist      # 产物 dist/may-dsh-orchestrator-<version>.tgz
# 改 package.json 版本号与 README.md 中的安装文件名，保持一致
```

安装到 web profile 并重启（需提权）：

```bash
lsof -ti tcp:3080 | xargs kill
dsh plugin --profile web remove @may/dsh-orchestrator
dsh plugin --profile web add <tgz 绝对路径>
/Users/lixuchuan/work/harness/start-dsh-web.sh --no-open
```

验证要在**新会话**里做；旧会话可能有历史脏数据。

## rc.2 平台要点（与 alpha.1 的差异）

- **prompt 严格插值**：persona suffix 只注册 `provider`/`model` 变量，`{{cwd}}` 等未注册变量直接抛 `unknown prompt variable`（曾导致 Worker 启动即崩）。不要在 persona/suffix 里手写模板变量。
- **cwd 自动注入**：平台 `dsh-working-directory` 给每个会话注入 `Current working directory: <path>` 上下文（dsh-base 默认加载），无需也不许在提示词里重复声明工作目录。
- **zod 钉 4.4.3**：rc.2 把 zod 从 4.6.7 回钉 4.4.3；`pnpm-workspace.yaml` 的 `overrides.zod=4.4.3` 防止与 `dsh-storage-domain.defineDomain` 形成双实例类型冲突（pnpm v11 不读 package.json 的 pnpm 字段，必须放 pnpm-workspace.yaml；同文件还有 rc 新包的 `minimumReleaseAgeExclude`）。
- **根会话能力**：schedule（dsh-tool-schedule）、session-query 等只对 depth-0 会话开放；Worker 根会话化后可用。ralph/workflow 等新编排工具已被 Worker 黑名单覆盖。
- **systemPrompt section/variable API**：`scoped.systemPrompt.section({name, order, text, interpolate:false})` 用于注入 roster 与遮蔽无关段落；`ctx.systemPrompt.variable()` 仅 agent scope 可用。
- **权限预设**：`ctx.permissionPresets.set(session, 'danger-full-access')` 按会话同时切换沙箱模式与审批策略（durable，log-only 事件，重复调用 no-op）；预设表在 dsh-base cordis.patch.yml（read-only / workspace-write / danger-full-access）。
- **concludeTurn**：工具 execute 第二参 `ToolRunContext.concludeTurn()` 给成功结果打 `concludesTurn` 标记，dsh-agent-loop 提交该结果批次后直接结束本轮，不再发起下一次推理；失败结果永远不带标记（模型可重试）。
- `.npmrc` 的 `verify-deps-before-run=false`：防止 pnpm 在 CI 环境下误判依赖过期而清空 node_modules。

## 架构要点（改代码前必读）

### 状态机（src/types.ts + src/state-machine.ts）

- 新建 Conversation 必须在主会话 cwd 下创建唯一子目录（同名冲突递增 `-N` 后缀），`meta.cwd` 写入 session header，冷恢复后不变；复用 Conversation 不换目录。新建派发必须提供 `workspaceName`（`workspaceNameSchema` 强制英文小写 slug），经 `src/workspaces.ts` 清洗后落盘。
- Task 状态：`queued / running / input_required / blocked / completed / failed / interrupted`（`cancelled` 从未产生过，0.3.11 起移除，旧记录加载时迁移为 interrupted）。
  - `input_required`：只表示 Worker 需要用户补充信息/选择，或需要用户接管浏览器、系统安全界面；必须有 question。
  - `blocked`（0.3.2 重新引入，语义不同于 0.2.x）：权限、配置、依赖、网络、资源、运行时等系统阻碍；带 error、可选 reasonCode/remediation。
  - `interrupted`：被改单接管或用户手动停止。改单接管不投递；用户手动停止需要投递一条非失败通知，工作流回 `idle` 可继续派发。
  - `input_required / blocked / completed / failed / interrupted` 都允许带 delivery；interrupted 是否挂起由具体路径决定（`deliverableTaskStatuses`）。Worker 主动 failed/blocked 后 Conversation 回 idle；只有 Host 级致命错误（如子会话启动失败/持久化记录缺失）才额外 failConversation。
- Conversation 状态：`provisioning / running / idle / input_required / failed`。
- 终态投递（delivery outbox）由状态机在迁移时统一挂起，**不要**在创建任务或别处预挂 `delivery: pending`（否则看板对运行中任务误报"同步中"）。
- **终态投递开关**：`OrchestratorService.static Config`（schemastery）声明 5 个 volatile 布尔（deliverOnCompleted/Failed/InputRequired/Blocked/Interrupted，默认 true）。volatile 改动经 loader `_commitVolatile` 即时生效、不重启 fiber；服务构造器第二参数接收 volatile 引用（`.get()` 实时读）。判定收敛在纯函数 `deliveryEnabledFor(toggles, status)` 与 `gateTaskDelivery(task, toggles)`（state-machine.ts），挂接点：updateFromWorker 两处 transitionTask 后、onWorkerTurnEnd（manual_stop/failed）、failLaunch、deliverPendingTask 兜底（关闭时清掉存量 pending，不补投）。语义分界：开关只影响"消息是否回投主会话"，task_update 的状态/摘要/待办总是持久化并更新 roster/看板——silent 是整会话不投，开关是按状态不投。
- **设置页（客户端）**：`src/client/settings-card.tsx` 注册 `plugins.row.config` 槽（key `<包名>#<行id>` = `@may/dsh-orchestrator#may-dsh-orchestrator`），入口：插件管理 → 已安装 → 本包 → 行"配置"。SettingsFormModel+Switch 模式仿 dsh-ciri；`@deepseek-ai/dsh-client-ui-primitives`/`dsh-client-store` 是前端 ModuleLoader 运行时 external（package.json `dsh.client.external` + tsdown neverBundle + vitest alias 桩）；`dsh.client.immediately: true` 保证插件管理页打开时槽位已注册。
- 所有状态修改走 `service.serialize()` 串行链；涉及改单必须"旧任务 interrupted + reviseConversation 原子切 activeTaskId"先落盘，再做外部调用。

### Worker 会话生命周期（根会话，0.3.2 起）

- 创建：`agents.withoutInitiator` + `agents.create({sessionId, meta:{cwd, agentPreset: WORKER_PRESET}, agentOptions: {...parent.options}})`；随后 `sessionTitle.rename` 显式命名为任务主题（自动标题只响应真人消息）。
- 投递：`sessionController.resolveAgent` 恢复冷会话 → `agent.followup(message)`（source.kind='orchestrator'）→ `sessions.flush` 确认落盘后才算投递成功（与 dsh-schedule 的提醒投递同一机制）。
- 中断：`agent.cancel({kind:'parent'})`（fire-and-return，单独 try/catch，失败不拖垮新任务）。
- 完成驱动：监听子会话 `turn/end`。`classifyWorkerTurnEnd`：`aborted.reason.kind=user` → 用户手动停止（interrupted + 投递非失败通知）；`kind=parent` → 改单中断。无 task_update 终态就结束的轮次按失败处理。

### 改单（同一工作流补充/修改需求）时序

`provisionDispatch` 复用分支（src/service.ts）：

1. 存储原子切换：旧任务 `interruptTaskForRevision`（delivery=undefined）+ `reviseConversation`（绕过 busy 校验）+ 新任务落盘。
2. arm 改单守卫（`revisionTurnEnds`，120s 窗口）。
3. `cancel({kind:'parent'})` 取消当前轮次（单独 try/catch）。
4. `deliverToWorker` 注入 `revisionPrompt(task)`；followup 排队，在被中止轮次收敛为 idle 后开新一轮。
5. cancel 异步带来的旧轮次 `turn/end aborted(kind=parent)` 由守卫吞掉，防止误判为手动停止或 failed。

### 工具权限

- Lead：**不裁剪**（0.3.13 移除 restrict 白名单）。宿主与用户安装的全部全局工具可见，后装工具自动生效；白名单时代曾导致 meow-memory 新版工具（memory_read/update/home）对 Lead 静默缺失，不再走回头路。编排纪律（轻查询直接做、执行一律派发、不自建 schedule）由 persona 约束。
- Worker：`scoped.tools.guard(isWorkerToolForbidden)`（worker-policy.ts）。编排/派生类禁止项见 `workerForbiddenPatterns`（workflow/ralph/orchestrator），直接向用户提问类见 `workerQuestionPatterns`（ask_user 系，命中时引导改走 task_update input_required）；新增"禁止类"工具只改这两张表。子智能体工具由 Worker 预设的 delegation 组显式组合（与平台 standard 预设同款，spawn/fork 后端驻留宿主平面）。
- 不要用白名单裁剪 Worker——用户后装工具（MCP/浏览器/技能）必须默认可用。
- 会话权限：Worker 在 configureWorker 时切 `danger-full-access`（沙箱全开放+审批 never）：后台无人值守，默认 workspace-write+ask 会把敏感操作永远卡在审批上；Lead 保持默认。**注意**：cordis 4 的 context proxy 对未 inject 的服务属性访问直接抛错（cannot get property without inject），permissionPresets/schedule 这类不在 static inject 里的可选服务必须用 `ctx.get(name)` 访问，否则 silently 失效（权限切换曾因此从未生效，定时标记同步同因）。

### 定时任务

- Worker 预设挂载 `dsh-tool-schedule`（schedule_create/list/update/delete）；提醒绑定 Worker 会话，到点作为新消息发回该会话。
- 定时触发的轮次没有活动任务：只允许 `task_update({status:'completed'})`，Host 生成 ad-hoc 已完成任务并经 outbox 投递给 Lead（service.ts updateFromWorker 的无 activeTaskId 分支）。
- 定时标记：`schedule/changed` 事件 + Worker `turn/end` 双触发全量核对（500ms 防抖），`scheduleMarks` 内存 Map → snapshot 投影 `hasActiveSchedule`（看板 badge）。DSH 侧栏标题**不加**图标前缀（0.3.x 曾加 ⏰/🕐，已按用户要求移除，renameWorkerSession 只同步看板标题本身）。turn/end 双触发的原因：schedule/changed 的 cordis 传播链路未实测可靠，而轮次内创建的 schedule 在 turn/end 时必已提交。注意 Worker 经它自己的 subagent/job 创建的 schedule 绑定的是那个子会话，不在本机制覆盖内。

### 记忆共享（0.3.4 起）

- meow-memory 的记忆库是 `<会话cwd>/.dsh-meow/memory.db`（per-workspace SQLite，WAL + busy_timeout=5000）。
- 为让 Lead 与全部 Worker 共用一份记忆：`ensureSharedMemoryLink()`（workspaces.ts）把每个 Worker 工作区的 `.dsh-meow` **符号链接**到主工作区的 `.dsh-meow`（win32 用 junction，普通用户免管理员；目标必须绝对路径）。
- 接入点：新建派发（mkdir 后）与 `recoverRuntimeState`（存量会话补建，dirname(workspaceDir) 即主工作区）。幂等；已存在真实目录（历史孤立记忆）时保留现状；失败仅 warn 降级为独立记忆。

### 给模型的输入输出要精简（产品要求）

- dispatch 的 `prompt` 只写需求和验收点。cwd 由平台注入，禁止重复工作目录/路径声明，禁止粘贴内部 ID。
- dispatch 返回给 Lead 的只需 `conversationId`（后续复用）；不要返回 taskId/childSessionId。
- list/get 的输出做投影（leadTools/listWorkflows），不要把整条数据库记录给模型。
- roster 系统提示词每工作流一行（含创建/更新时间，供"上周那个"类指代对号）；看板（Board.tsx）可以展示更多内部字段，但不要在主会话输出内部概念。
- Worker 注入只有两种文案：`workerPrompt`（正常）和 `revisionPrompt`（改单），都在 messages.ts。

### Lead 行为约束（messages.ts LEAD_PROMPT）

- 闲聊、概念解释、当前对话内可答的问题**直接回答，不调任何工具**；需要实际执行（联网/文件/命令/浏览器）才派发。
- background 派发后只回一句简短自然确认（"好，这就改"）；禁止"任务正在后台进行/Worker 完成后我会发给你"等系统腔；不暴露 Worker/Conversation/TaskRun 等词；不提前承诺交付物。
- 一事一会：同一事项的追问、改单、继续推进必须由 Lead 按 roster 复用原 conversationId；只是"同类"的两件事（两个不同提醒、两次不同购物）必须分别新建会话。subject 要非常精简（约 10 字以内、手机端一行可读）。
- 记忆维护类任务必须 `silent: true` 派发（终态不投递）；用户常在手机端，blocked 时不得指导用户手改文件/命令/配置。
- 单条记忆 Lead 自己 `memory_remember`；任务中产生的记忆由 Worker 记；写入前先查重。

### Worker 上报协议

- `task_update`：running / input_required(+question) / blocked(+error, reasonCode?, remediation?) / completed(+report) / failed(+error)；全状态可带 title（最多 8 个字的极简状态标题，折叠态/手机端展示）、progressNote（一句话进展，允许三分幽默）、summary；userTodos 仅 running/input_required/completed 允许（failed/blocked 禁止——终态失败/受阻不应再改待办）：分桶结构 {create:[], update:[]}，create.title / update.id 在 DSL 层静态必填（type 判别已废弃——分支规则必须由结构而非文案表达，模型多次踩过文案条件必填的坑）；completed 的 report{result, artifacts?}：result 是 Lead 转述给用户的唯一权威答案；artifacts 为子工作区相对路径，投递时自动加工作区前缀。待办内容字段：dueDate(YYYY-MM-DD)/remindAt(ISO)/priority(P0~P3 默认 P3)/links/attachments(相对路径)/contacts/location/remark（备注，排字段表末位诱导先填结构化字段；旧字段 detail 已迁移为 remark）。双向知情通道：新任务投递附"会话待办现状"（todoStatusSection，pending 全列+用户已勾的防重复代办），task_update 返回值带 `todos` 投影（id/title/status/priority，todoProjection）。用户在看板画勾走 setTodoStatus RPC（Host 持久化+看板刷新，Worker 不实时通知，靠上述两个通道知情）。
- 终态（completed/failed/input_required/blocked）task_update 成功后调 `exec.concludeTurn()` 直接结束本轮（statusConcludesTurn），省掉末次全上下文推理；running 不结束。
- **zod/DSL 双写**：模型可见的只有 defineTool 的 parameters DSL（`TASK_UPDATE_TOOL_PARAMETERS` 导出常量），zod（taskUpdateInputSchema）是 Host 侧校验；两处必须同步——zod 加了字段而 DSL 没加，模型永远不知道（0.3.13 踩过）。tool-params.spec 锁定 DSL 可编译且关键字段齐全。
- title 的 8 字上限只在输入边界（taskUpdateInputSchema）限制；baseTaskSchema 用 z.string() 不加 max，防止存储层解析拒绝旧记录。
- 用户待办清单：会话级 `conv.todos`（UserTodo：id/title/dueDate/remindAt/priority/links/attachments/contacts/location/remark/status: pending|done|cancelled/completedBy: user|worker；completedAt 死字段已删），Worker 用 userTodos.create 提出、userTodos.update 标 done 或 cancelled；用户在任务看板画勾/取消走 `setTodoStatus` RPC（仅 pending/done）；待办框在"工作区"行上方，折叠也显示，cancelled 灰显划线带"已作废"胶囊且不可勾。派发与改单注入末尾附 `todoStatusSection`（会话待办现状：pending 全列含 id，用户自己勾掉的标注"不要重复代办"，cancelled 不提）。Lead 把待办转述给用户；用户让代办/修改时复用原 conversationId 派发并要求 Worker userTodos.update。校验失败报错带全量路径（如 userTodos.create[0].title: …），模型可一轮自愈。
- Worker 会话在 configureWorker 时切到 `danger-full-access` 权限预设（permissionPresets.set，沙箱全开放+审批 never）：后台无人值守，默认 workspace-write+ask 会把敏感操作卡在审批上。Lead 保持默认。
- Worker 不能直接向用户提问（ask-user 工具被 guard 拦且不进预设）。
- todo_write 是内部步骤清单：Host 监听 `todo/write` 事件，350ms 防抖写入 `task.progressSteps` 驱动看板；Worker 无需为 todo 调 task_update，todo 全完成不等于任务完成。

### 存储与兼容性

- 存储：`~/.dsh/storages/orchestrator.json`（domain v1，tables: conversations/tasks）。
- 持久化 schema 用 zod；**改字段必须在 types.ts 的 `migrateRecord` 里做旧记录迁移**（先例：scene 剥离、仅旧版带 scene/blockedQuestion 的 blocked→input_required、blockedQuestion→question；0.3.2 新 blocked 无 scene，不能误迁移）。client snapshot 走 z.preprocess，旧数据不能让看板炸掉。
- 子会话 transcript：`~/.dsh/sessions/<workspace-encoded>/<childSessionId>/session.v4.jsonl.zstd`，用 `zstd -dc` 解压排查真实轮次；`turn/end` 的 reason 是判断手动停止/改单的依据。

## 代码约定

- typecheck（host + client 两个 project）必须干净；提交前跑全量 vitest。
- 新语义先在 state-machine/types 层落纯函数 + 单测，再接 service。
- 状态字面量列表用 types.ts 的常量（activeTaskStatuses / deliverableTaskStatuses / terminalTaskStatuses / taskUpdateStatuses / blockReasonCodes），不要再散落状态数组；仅内部使用的常量不要 export。
- 日志用 `hostCtx.logger.info/warn`，英文即可；面向用户的文案一律中文。
- 看板文案与状态标签中文；新增 TaskStatus/ConversationState 时同步 Board.tsx 的 labels 与 styles.ts 的 badge 颜色。
- 死代码及时删（已清理：scene 四模式、PLAN.md、subagent 时代 settled 双重拦截、{{cwd}} suffix 等），不要留兼容分支以外的旧代码。

## 常见坑

- 先 interrupt 再对持旧 activeTaskId 的 conv 做普通 activate：必撞 `conversation_busy`。改单走 `reviseConversation`。
- cancel 是 fire-and-return，旧轮次 turn/end 晚到；没有 revisionTurnEnds 守卫就会把旧任务误判 failed 或把新任务误标手动停止。
- 向 failed 工作流派发会 throw，dispatch 已包 try/catch 返回结构化 error，新增的外部调用路径同样要兜住。
- 快速 Worker 可能在 followup 接受与收尾之间已提交终态：只补 queued→running，不回滚终态。
- 重启恢复：普通活动任务统一转 interrupted（`interruptTaskAfterRestart`，不主动投递）；persistence stat 不确定时用 blockTask 标 blocked；并恢复未投递 outbox 与补建记忆共享链接。
- pnpm-lock 与 peerDeps 范围改动后必须 `--no-frozen-lockfile` 重装并核对 zod 解析到 4.4.3。
- 存储 schema（baseTaskSchema/baseConversationSchema）收紧约束会让旧记录在重启后解析失败：新字段给 default、长度等限制只放输入边界 schema。

## 背景材料

- README.md：用户面说明，发版时随版本号更新。
- git log：0.2.0（background/单 Worker 预设）→ 0.2.1（路由追问兜底/改单 steer/blocked 提问）→ 0.2.2（todo 进度桥接看板）→ 0.2.3（interrupted 改单语义）→ 0.2.4（手动停止捕获、看板与话术精简）→ 0.2.5（白名单、input_required、上下文瘦身、鲁棒性）→ 0.2.6（手动中断通知、状态配色、Worker 提示词瘦身）→ 0.2.7（子会话折叠、柔光动效、按钮突出、提示词/恢复加固）→ 0.3.0（个人助理能力 bundle）→ 0.3.2（Worker 根会话化、blocked 系统受阻语义、默认 Lead 预设免手改）→ 0.3.3（DSH 0.2.1-rc.2 适配、移除 dsh-market）→ 0.3.4（记忆共享、settled 死代码清理、文档重写）→ 0.3.5（Worker 放开子智能体与后台任务）→ 0.3.6（标题更新/同主题复用/定时编排/定时标记）→ 0.3.7（模型选择透传、打开子会话寻址修复）→ 0.3.8（看板重构、task_update v2：report/progressNote/summary）→ 0.3.9（workspaceName 英文 slug 必填、mock 对齐）→ 0.3.10（dispatch 工具参数 DSL pattern 崩溃修复）→ 0.3.11（死字段 userAnswer/resultSummary/outlinePatch/cancelled 清理与数据迁移、outline 摘要写入简化、看板 API 文档）→ 0.3.12（Lead 白名单补 memory_read/update/home）→ 未发布（Lead 移除工具白名单；一事一会拆分；task_update title（≤8 字）+ report.todos/todoUpdates 用户待办清单 + setTodoStatus RPC；Worker danger-full-access；定时标记 turn/end 双触发；终态 concludeTurn；task_update 参数 DSL 漂移修复与测试锁定；cordis 4 inject 陷阱修复（ctx.get 访问 permissionPresets/schedule）；待办 cancelled 作废 + 派发注入会话待办现状 + task_update 返回 todos 投影 + todoUpdates 收紧（failed/blocked 禁止）；待办 priority 四象限（P0~P3 默认 P3，看板彩色胶囊）；setTodoStatus markRemote 漏注册修复（独立 tsdown 无装饰器降级，每个 RPC 方法都必须手动 markRemote）；未使用导出类型清理（NewTodo/TodoUpdate/TodoPriority/Delivery/ConversationState）；终态投递开关与插件设置页（plugins.row.config）；DSH 侧栏定时图标前缀移除）→ 0.3.13（userTodos 分桶 create/update 取代 type 判别、create.title/update.id DSL 静态必填、待办新字段 remindAt/links/attachments/contacts/location、detail→remark 并置末位、completedAt 死字段删除、校验报错带全量路径、LEAD 待办节按操作类型重组、WORKER task_update 节嵌套化、看板详情区一切皆胶囊）。
