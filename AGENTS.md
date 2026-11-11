# AGENTS.md — dsh-orchestrator 开发指引

面向接管本仓库的 AI 编码助手。读完本文件再动手。当前仓库版本 0.3.21；文档入口见 [docs/README.md](docs/README.md)。

## 项目是什么

`@cmjt/dsh-orchestrator`：DSH（DeepSeek Harness，基线 `0.2.1-rc.2`）的编排插件。

- **Lead**（主会话，预设 `may-orchestrator-lead`）：理解需求、路由、派发、转发结果。保留 DSH 自带工具；`LEAD_TOOL_DENY` 只隐藏个人记忆写/管理与 GenUI 直接渲染工具。记忆来自 `@cmjt/dsh-personal-memory@0.4.6`，原生 `memory_search/read` 保留，其余记忆工具隐藏。写入手册对 Lead 遮蔽；`memory-policy.ts` 通过记忆插件原生 HTTP 接口设置会话门控：inject=false（允许读入与查询）、write=true/dream=true（停止写入、反思与自动整理）。不导入数据库 API，不解析记忆存储配置，不重建影子工具或工作区记忆链接。
- **Worker**（持久**根会话**，预设 `may-orchestrator-worker`）：执行任务。不是 subagent——通过 `agents.create` 创建（无 origin/delegationDepth），与主会话同为一等会话，schedule 等仅 depth-0 可用的宿主能力对 Worker 开放。工具**黑名单**制（只禁编排循环/直接提问/直接 GenUI 渲染及验证），其余宿主与用户安装的工具默认可用。
- 两层领域模型：**Conversation**（持久子会话/工作流）1—N **TaskRun**（一次派发）。
- 技术栈：pnpm + TypeScript + Cordis + Zod + tsdown + vitest。4 个入口：主插件、client（看板 React）、typert host/remote（snapshot / setScheduleStatus / answerTaskQuestions RPC）。

## 本机环境与硬性约束

- DSH CLI 全局包：`@deepseek-ai/dsh@0.2.1-rc.2`（`/opt/homebrew/lib/node_modules`，读 API 定义从这里查）。**CLI 是 web 的运行时**，升级 CLI 用全局 npm；**GUI（`/Applications/DeepSeek Harness.app`）绝不能动**。
- 真实 web profile：`~/.dsh/profiles/web`。
- **重启 web 必须用脚本**：`/Users/lixuchuan/work/harness/start-dsh-web.sh`（设置 NODE_EXTRA_CA_CERTS、清代理，内部 `exec dsh web --host 127.0.0.1 --port 3080`）。不要直接 `dsh web`。脚本需用 `start_new_session` 方式彻底脱离当前会话启动，否则进程会被回收。
- 执行权限遵循当前环境；无需额外审批时直接操作。GitHub 访问不稳定，push/release 失败时按用户约定请求开代理。
- pnpm 供应链校验在沙箱无网时会挂起：typecheck/test/build 直接用 `./node_modules/.bin/tsc|vitest|tsdown`；`pnpm install` 使用 `CI=true npm_config_cache=/private/tmp/dsh-orchestrator-npm-cache`，改 manifest 后加 `--no-frozen-lockfile`。
- `npm pack`/缓存写 `~/.npm` 会 EPERM，必须：`export npm_config_cache=/private/tmp/dsh-orchestrator-npm-cache`。
- 插件安装到 profile 必须用 **tgz 绝对路径**（相对路径会被 pnpm 误判为 GitHub 简写）；先 remove 再 add，仅重启不会更新 bundle。

## 标准发布流程

先更新 package.json 版本、README 安装文件名和接口文档版本，再执行以下门禁。仅保存本地里程碑时，完成门禁、中文 commit 与 annotated tag 即停止；不执行实际 npm pack、安装、推送或发布。真正发布须另有用户授权。

```bash
./node_modules/.bin/tsc -p tsconfig.json --noEmit
./node_modules/.bin/tsc -p tsconfig.client.json --noEmit
./node_modules/.bin/vitest run        # 以当前全量用例为准
./node_modules/.bin/tsdown            # 应无弃用警告
export npm_config_cache=/private/tmp/dsh-orchestrator-npm-cache
node scripts/verify-packaging.mjs     # 校验 tgz 只含运行所需 lib/、cordis.patch.yml 等
npm pack --pack-destination dist      # 产物 dist/cmjt-dsh-orchestrator-<version>.tgz
```

- **Release 文档与通知门禁**：
  1. 每次 push/release 前，用 `git status`、工作区 diff 及上一 release/tag 以来的提交清单核对全部未同步改动，逐项确认 README、AGENTS、接口/差异文档和里程碑已同步；缺失时先补文档，不得带着文档缺口发布。
  2. GitHub Release 正文必须逐一列出本次重要改动，尤其是用户可见功能、行为变化、协议/字段、兼容性、配置与依赖变化；每项一句话，写清影响，不只贴 commit 标题。
  3. 两处发布与验证全部完成后，另给一条可直接发群的简短通知：只面向用户/下游，每个重要改动点用一句话概括；纯内部重构、测试、格式整理、构建细节和无外部影响的杂项不写入群通知。

安装到 web profile 并重启：

```bash
lsof -ti tcp:3080 | xargs kill
dsh plugin --profile web remove @cmjt/dsh-orchestrator
dsh plugin --profile web add <tgz 绝对路径>
uv run --no-project --python /usr/bin/python3 python -c 'import subprocess; subprocess.Popen(["/Users/lixuchuan/work/harness/start-dsh-web.sh", "--no-open"], start_new_session=True, stdin=subprocess.DEVNULL, stdout=open("/private/tmp/dsh-web.log", "ab"), stderr=subprocess.STDOUT)'
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

### 模块职责（0.3.19）

| 模块 | 职责 |
|---|---|
| `types.ts` / `schedule-time.ts` | Zod 数据契约 / 日程时间解析及一致性；types 保留时间函数重导出 |
| `model-info.ts` | DSH assistant message 模型元数据提取、Task 合并与看板展示名计算 |
| `state-machine.ts` / `task-lifecycle.ts` | 纯状态迁移与投递开关 / 未完成任务判定（含 input_required） |
| `service.ts` / `pending-answers.ts` | 宿主协调、串行写入、投递恢复 / 作答等待与取消清理 |
| `schedule-changes.ts` | 日程整批规划、归属及合并校验，不执行持久化 |
| `tool-parameters.ts` / `remote.ts` / `host-contracts.ts` | 模型参数 DSL / 三个 RPC 契约 / 宿主结构接口；service 保留 DSL 重导出 |
| `messages.ts` / `presets.ts` / `lead-policy.ts` / `worker-policy.ts` | 提示词、预设与工具策略 |
| `storage.ts` / `workspaces.ts` / `memory-policy.ts` | 存储域、子工作区路径、Lead 原生记忆只读策略 |
| `client/Board.tsx` | 会话与日程页签、数据刷新和回调协调 |
| `client/question-card.tsx` / `task-box.tsx` | 问题作答 / 任务时间线及详情 |
| `client/schedule-list.tsx` / `schedule-pane.tsx` / `schedule-ordering.ts` | 两页共用日程行 / 月历 / 日程排序与日期辅助 |

### 状态机（src/types.ts + src/state-machine.ts）

- 新建 Conversation 必须在主会话 cwd 下创建唯一子目录（同名冲突递增 `-N` 后缀），`meta.cwd` 写入 session header，冷恢复后不变；复用 Conversation 不换目录。新建派发必须提供 `workspaceName`（`workspaceNameSchema` 强制英文小写 slug），经 `src/workspaces.ts` 清洗后落盘。
- Task 状态：`queued / running / input_required / completed / failed / interrupted`（Worker 只主动上报 running/input_required/completed/failed）。
  - `input_required`：只表示 Worker 需要用户补充信息/选择，或需要用户接管浏览器、系统安全界面；必须有 `questions`。
  - `failed`：普通失败与系统阻碍统一；系统阻碍用顶层 `reasonCode`（permission_denied/configuration/dependency/network/resource/runtime）标记。
  - `interrupted`：被改单接管或用户手动停止。改单接管不投递；用户手动停止需要投递一条非失败通知，工作流回 `idle` 可继续派发。
  - 只有 `completed / failed / interrupted` 允许带 delivery；interrupted 是否挂起由具体路径决定（`terminalTaskStatuses`）。Worker 主动 failed 后 Conversation 回 idle；只有 Host 级致命错误（如子会话启动失败/持久化记录缺失）才额外 failConversation。
- Conversation 状态：`provisioning / running / idle / input_required / failed`。
- 终态投递（delivery outbox）由状态机在迁移时统一挂起，**不要**在创建任务或别处预挂 `delivery: pending`（否则看板对运行中任务误报"同步中"）。
- **终态投递开关**：`OrchestratorService.static Config`（schemastery）声明 3 个 volatile 布尔（deliverOnCompleted/Failed/Interrupted，默认全部 true；input_required 恒不投递，无对应开关或死字段）。volatile 改动经 loader `_commitVolatile` 即时生效、不重启 fiber；服务构造器第二参数接收 volatile 引用（`.get()` 实时读）。判定收敛在纯函数 `deliveryEnabledFor(toggles, status)` 与 `gateTaskDelivery(task, toggles)`（state-machine.ts），挂接点：reportFromWorker 两处 transitionTask 后、onWorkerTurnEnd（manual_stop/failed）、failLaunch、deliverPendingTask 兜底（关闭时清掉存量 pending，不补投）。语义分界：开关只影响"消息是否回投主会话"，上报的状态与进展总是持久化并更新 roster/看板——silent 是整会话不投，开关是按状态不投。
- **Worker 默认模型**：Config 另有 volatile `workerProvider/workerModel/workerReasoningEffort`（空串=未设置）；设置卡片从 `remote.session.modelCatalog()` 渲染模型与推理强度下拉框。新 Worker 优先使用目录中可用的默认设置，否则沿用 Lead pending → 最近请求头 → 全局默认；旧 Worker 仅在原模型明确不在目录时通过 `agents.selectForNextRequest` 重选，目录查询失败不乱切换，也不重建会话。
- **设置页（客户端）**：`src/client/settings-card.tsx` 注册 `plugins.row.config` 槽（key `<包名>#<行id>` = `@cmjt/dsh-orchestrator#may-dsh-orchestrator`），入口：插件管理 → 已安装 → 本包 → 行"配置"。SettingsFormModel+Switch 模式仿 dsh-ciri；`@deepseek-ai/dsh-client-ui-primitives`/`dsh-client-store` 是前端 ModuleLoader 运行时 external（package.json `dsh.client.external` + tsdown neverBundle + vitest alias 桩）；`dsh.client.immediately: true` 保证插件管理页打开时槽位已注册。
- 所有状态修改走 `service.serialize()` 串行链；涉及改单必须"旧任务 interrupted + reviseConversation 原子切 activeTaskId"先落盘，再做外部调用。

### Worker 会话生命周期（根会话，0.3.2 起）

- 创建：`agents.withoutInitiator` + `agents.create({sessionId, meta:{cwd, agentPreset: WORKER_PRESET}, agentOptions: {...parent.options}})`；随后 `sessionTitle.rename` 显式命名为任务主题（自动标题只响应真人消息）。
- 投递：`sessionController.resolveAgent` 恢复冷会话 → `agent.followup(message)`（source.kind='orchestrator'）→ `sessions.flush` 确认落盘后才算投递成功（与 dsh-schedule 的提醒投递同一机制）。
- 中断：`agent.cancel({kind:'parent'})`（fire-and-return，单独 try/catch，失败不拖垮新任务）。
- 完成驱动：监听子会话 `turn/end`。`classifyWorkerTurnEnd`：`aborted.reason.kind=user` → 用户手动停止（interrupted + 投递非失败通知）；`kind=parent` → 改单中断。无终态上报就结束的轮次按失败处理。
- 等待管理：`PendingAnswers` 按 taskId 保存 Promise 与原生卡取消信号，作答、工具取消、手动停止、改单与服务卸载均清理监听和原生卡；已取消卡片晚到的答案不得答入后续提问。重启时 queued/running/input_required 均按未完成任务恢复为已有 interrupted，Conversation 回 idle，不新增状态或投递。

### 改单（同一工作流补充/修改需求）时序

`provisionDispatch` 复用分支（src/service.ts）：

1. 存储原子切换：旧任务 `interruptTaskForRevision`（delivery=undefined）+ `reviseConversation`（绕过 busy 校验）+ 新任务落盘。
2. arm 改单守卫（`revisionTurnEnds`，120s 窗口）。
3. `cancel({kind:'parent'})` 取消当前轮次（单独 try/catch）。
4. `deliverToWorker` 注入 `revisionPrompt(task)`；followup 排队，在被中止轮次收敛为 idle 后开新一轮。
5. cancel 异步带来的旧轮次 `turn/end aborted(kind=parent)` 由守卫吞掉，防止误判为手动停止或 failed。

### 工具权限

- Lead **预设挂载面**（presets.ts）：显式挂载自带插件 tool-web（web_search/web_fetch）、tool-fs-search（glob/grep，必配 `sampleOverCapGlobResults`）、tool-fs（read/write/edit/read_image）、tool-present（Worker artifacts 的主会话制品卡交付）、tool-todo（必配 `allowParallelInProgress`）、tool-goal、tool-ask-user。0.2.7 起 tool-web 曾被误删，"一步查询"长期是空头承诺，0.3.16 补回。不挂 bash/terminal/jobs/schedule/session-query/skill/mcp-resources/subagent/teams/worktree——执行与编排都在 Worker 侧；缺必配 config 会新建会话即报 agent-preset/invalid。
- Lead：**黑名单裁剪**，按注册表过滤记忆写/管理与 GenUI 直接渲染工具，自带工具升级新增不被误藏。记忆工具全部由 dsh-personal-memory 原生注册；仅保留 search/read，其余交给 Worker。orchestrator 不导入记忆插件实现，只通过原生会话门控接口设置策略。
- Worker：按 `isWorkerToolForbidden`（worker-policy.ts）枚举工具并 `scoped.tools.restrict({ deny })`，失败时回退 `guard`。编排/派生类禁止项见 `workerForbiddenPatterns`（workflow/ralph/orchestrator），直接向用户提问类见 `workerQuestionPatterns`（ask_user 系，命中时引导改走 task_input_required）；新增"禁止类"工具只改这两张表。子智能体工具由 Worker 预设的 delegation 组显式组合（与平台 standard 预设同款，spawn/fork 后端驻留宿主平面）。
- **工具清单巡检（每次相关改动必做）**：改 lead-policy/service 工具面相关代码、或 DSH/插件升级后，重新枚举全局工具（扫 DSH core + profile 插件的 defineTool 名字）与 `DSH_CORE_TOOL_BASELINE` 快照对比。运行时也有兜底：Lead 挂载时 `unrecognizedGlobalTools` 发现基线外且未命中 deny 的名字会打 warn。发现新工具 → 确认归属 → 自带的更新基线、第三方的评估加入 LEAD_TOOL_DENY（或确认放行）。用户主动装新插件同样适用。
- 不要用白名单限制 Worker；仅禁止上述类别，用户后装工具（MCP/浏览器/技能）默认可用。
- orchestrator 不再捆绑 BrowserSkill、Computer Use 或 QQ 邮箱，Lead 也不保留对应的工具名/前缀遮蔽与 QQ 邮箱提示段抑制。核心工具基线 57 项，含 plugin_manager / plugin_market。
- 会话权限：Worker 在 configureWorker 时切 `danger-full-access`（沙箱全开放+审批 never）：后台无人值守，默认 workspace-write+ask 会把敏感操作永远卡在审批上；Lead 保持默认。**注意**：cordis 4 的 context proxy 对未 inject 的服务属性访问直接抛错（cannot get property without inject），permissionPresets/schedule 这类不在 static inject 里的可选服务必须用 `ctx.get(name)` 访问，否则 silently 失效（权限切换曾因此从未生效，定时标记同步同因）。

### 定时任务

- Worker 预设挂载 `dsh-tool-schedule`（schedule_create/list/update/delete）；提醒绑定 Worker 会话，到点作为新消息发回该会话。
- 定时触发的轮次没有活动任务：只允许 `task_completed`，Host 生成 ad-hoc 已完成任务并经 outbox 投递给 Lead（service.ts reportFromWorker 的无 activeTaskId 分支）。
- 定时标记：`schedule/changed` 事件 + Worker `turn/end` 双触发全量核对（500ms 防抖），`scheduleMarks` 内存 Map → snapshot 投影 `hasActiveSchedule`（看板 badge）。DSH 侧栏标题**不加**图标前缀（0.3.x 曾加 ⏰/🕐，已按用户要求移除，renameWorkerSession 只同步看板标题本身）。turn/end 双触发的原因：schedule/changed 的 cordis 传播链路未实测可靠，而轮次内创建的 schedule 在 turn/end 时必已提交。注意 Worker 经它自己的 subagent/job 创建的 schedule 绑定的是那个子会话，不在本机制覆盖内。

### 全局个人记忆

- 记忆使用私有 npm 源的 `@cmjt/dsh-personal-memory@0.4.6` 普通依赖，随 orchestrator 自动安装；bundle 直接引用 scoped 包名，运行时代码仅调用其原生 HTTP 门控接口。安装指定 `--registry http://36.138.53.195:4873/` 或配置 `@cmjt:registry`，不需要提前安装记忆 tgz。插件内部的 section 名、数据目录与工具名仍为原有名称，不随 npm scope 改动。
- 依赖固定为 0.4.6，禁止恢复 latest，避免旧 profile lockfile 继续复用有缺陷的 0.4.5；scoped 包的客户端注册与 bundle 引用已由上游修正，orchestrator 不包含第三方产物补丁。
- 默认数据家：`$DSH_HOME/storages/dsh-personal-memory`，未设环境变量时为 `~/.dsh/storages/dsh-personal-memory`；SQLite 位于数据家下 `.dsh-personal-memory/memory.db`。遵从插件的 homeDir 设置，不再随工作区定位。
- Lead 使用原生 search/read 与读入，禁写与自动反思/整理；Worker 使用完整原生能力和原生手册，不在 persona 重复写记忆纪律。
- 门控使用短暂失败有界重试，并在推理前确认策略；复用 `POST /dsh-personal-memory/skip-dreams`（`sessionId / field / value`），地址来自宿主 `webServer.getOrigin()`；先 flush Lead 会话，再设置 write=true、dream=true、inject=false。数据库定位与配置解析由记忆插件负责，包括自定义 projectDir/homeDir；接口失败告警，推理前重试，仍失败则阻止该请求；不回退直接写库。测试使用上游原生路由与 SQLite，覆盖默认和自定义 projectDir。
- 旧库的扫描与合并由插件原生迁移处理，保留旧文件；新建和恢复 Worker 不再创建记忆链接。
- 可信插件通过 Node 文件 API 读写 `~/.dsh`；模型文件/命令工具另受会话沙箱约束。Worker 已持久化 danger-full-access（full + never），Lead 文件沙箱保持默认；rc.2 不支持额外增加单个可写根目录，不要通过 chmod 或符号链接绕过沙箱。

### 给模型的输入输出要精简（产品要求）

- dispatch 的 `prompt` 只写需求和验收点。cwd 由平台注入，禁止重复工作目录/路径声明，禁止粘贴内部 ID。
- dispatch 返回给 Lead 的只需 `conversationId`（后续复用）；不要返回 taskId/childSessionId。
- list/get 的输出做投影（leadTools/listWorkflows），不要把整条数据库记录给模型。
- roster 系统提示词每工作流一行：会话 ID/状态/标题 + 当前或最近需求、任务状态与进展/结果 + 更新时间和日程摘要；动态文本每次渲染实时读取任务记录，不使用 outline 主题链。看板（Board.tsx）可以展示更多内部字段，但不要在主会话输出内部概念。
- Worker 注入只有两种文案：`workerPrompt`（正常）和 `revisionPrompt`（改单），都在 messages.ts。

### Lead 行为约束（messages.ts LEAD_PROMPT）

- 闲聊、概念解释、当前对话内可答的问题**直接回答，不调任何工具**；需要实际执行（联网/文件/命令/浏览器）才派发。
- background 派发后只回一句简短自然确认（"好，这就改"）；禁止"任务正在后台进行/Worker 完成后我会发给你"等系统腔；不暴露 Worker/Conversation/TaskRun 等词；不提前承诺交付物。
- 输出正文必须紧扣用户原始需求，只说结果，不补充 Worker 的执行过程、方法、步骤或工具调用等过程性内容。
- 一事一会：同一事项的追问、改单、继续推进必须由 Lead 按 roster 复用原 conversationId；只是"同类"的两件事（两个不同提醒、两次不同购物）必须分别新建会话。subject 要非常精简（约 10 字以内、手机端一行可读）。
- 记忆维护类任务必须 `silent: true` 派发（终态不投递）；用户常在手机端，failed + reasonCode 时也不得指导用户手改文件/命令/配置。
- 记忆写入全部由 Worker 完成：Lead 发现值得记的信息派 silent 轻量任务让 Worker 写入（任务里给出写好的条目内容），任务中产生的记忆由执行它的 Worker 顺手记；写入前先查重。

### Worker 上报协议

- **5 个独立工具（v0.3.19 起，单工具 `task_update` 已删除）**：`task_running` / `task_input_required` / `task_completed` / `task_failed` / `task_schedule`。每个工具的 zod input schema（`taskReportInputSchemas` / `taskScheduleInputSchema`）只含该工具合法字段，schema 结构即校验——不再有 allowlist / superRefine 交叉校验（单工具 + 条件必填被模型多次踩坑，拆分是根治）。四个状态工具可带 header（≤8 字极简状态标题）和 progressNote（一句话进展）；task_schedule 不带进度字段。
  - `task_input_required`：必填 `questions[]`，结构化问卷 `{id?, question, header?, detail?, options?, multi_select?}`，Worker 的 id 可省略，Host 补 q1/q2/…，snapshot 与作答后的 answers 使用该 id。阻塞工具调用，返回值即用户答案。
  - `task_completed`：必填 `result`（只阐述用户需求的最终结果，不写怎么做，不含过程性内容或文件路径）；可选 `artifacts`（关键制品的子工作区相对路径，投递时自动加工作区前缀，仅供 Lead 调用 present）与 `card`（dsh-ui 结构化明细 JSON，Host 序列化围栏后由 Lead 原封不动输出）；正文、卡片和制品不重复。
  - `task_failed`：必填 `error`，系统阻碍加 `reasonCode`。
  - `task_schedule`：日程 CRUD（`create`/`update` 分桶，create.title / update.id 在 DSL 层静态必填——分支规则必须由结构而非文案表达）；返回最新日程清单投影，与任务状态无关、不产生状态迁移。
  - **存储拍平**：TaskRecord 顶层 `result/artifacts/card/error/reasonCode`，`report/fail` 包裹层删除；domain v3 隔离旧存储，不加载、不迁移旧记录。transitionTask 输入是判别联合 `TaskTransitionInput`，按 status 收敛字段并清空非对应终态字段；保留已回答的问题及答案。
- 终态（completed/failed）提交成功后调 `exec.concludeTurn()` 直接结束本轮（statusConcludesTurn），省掉末次全上下文推理；running 不结束；input_required 为阻塞工具调用（不 concludeTurn，用户作答后同轮返回答案继续）。
- **zod/DSL 双写**：模型可见的只有 defineTool 的 parameters DSL（`tool-parameters.ts` 的 `TASK_*_TOOL_PARAMETERS` 五个常量，service.ts 保留重导出），zod 是 Host 侧校验；两处必须同步——zod 加了字段而 DSL 没加，模型永远不知道（0.3.13 踩过）。tool-params.spec 锁定 5 个工具的 DSL 可编译且字段与 zod 契约一致。
- header 的 8 字上限只在输入边界限制；baseTaskSchema 用 z.string() 不加 max，避免持久化层重复输入边界约束。
- 日程时间逻辑位于 `schedule-time.ts`，types.ts 保留重导出：allDay=true 的 startAt/endAt 使用完整纯日期；普通日程必须带时刻，remindAt 使用 `normalizeTimePoint` 宽松解析，省略年份取最近未来、缺时区补本地；自然语言（"明天下午"）拒绝；priority(P0~P3 默认 P3)/links/attachments(相对路径)/contacts/location/remark（备注，排字段表末位诱导先填结构化字段）。
- 双向知情通道：新任务投递附"会话日程现状"（scheduleStatusSection，pending 全列+用户已勾的防重复代办），task_schedule 与状态上报的返回值都带 `schedules` 投影（id/title/status/priority，scheduleProjection）。用户在看板画勾走 setScheduleStatus RPC（Host 持久化+看板刷新，Worker 不实时通知，靠上述两个通道知情）。
- 用户日程（v2 独立表 schedules，主会话 scope；v0.3.17 起 conv.todos 字段删除、旧残留数据直接丢弃）：ScheduleRecord{id/title/startAt/endAt/remindAt/priority/links/attachments/contacts/location/remark/status: pending|done|cancelled/completedBy: user|worker + parentSessionId/conversationId 归属回链}，Worker 用 task_schedule 的 create 提出、update 标 done 或 cancelled 作废；用户在任务看板画勾/取消走 `setScheduleStatus` RPC（仅 pending/done）；日程框在"工作区"行上方，折叠也显示，cancelled 灰显划线带"已作废"胶囊且不可勾。派发与改单注入末尾附 `scheduleStatusSection`（会话日程现状：pending 全列含 id，用户自己勾掉的标注"不要重复代办"，cancelled 不提）。看板双页签：会话（会话页）+ 日程（月历页：周一起始、优先级色点、跨天逐日出现、过期未完成置顶、无时间字段只在会话页）；停留在日程页时任务更新会在会话页签显示未读点（颜色跟最新任务状态），切回即清除。Lead 把日程转述给用户；用户让代办/修改时复用原 conversationId 派发并要求 Worker task_schedule update。校验失败报错带全量路径（如 create[0].title: …），模型可一轮自愈。
- ScheduleRecord 还包含 allDay（默认 false）。缺少 startAt 的日程只在会话页显示；两页共用 ScheduleList，均展示 P0–P3 胶囊。更新全天纯日期时显式提供 allDay=true 与 startAt，未提供 allDay 的时间输入按普通带时刻语义解析。
- Worker 会话在 configureWorker 时切到 `danger-full-access` 权限预设（permissionPresets.set，沙箱全开放+审批 never）：后台无人值守，默认 workspace-write+ask 会把敏感操作卡在审批上。Lead 保持默认。
- Worker 不能直接向用户提问（ask-user 工具由 restrict 隐藏，失败时由 guard 拦截，且不进预设）。
- todo_write 是内部步骤清单：Host 监听 `todo/write` 事件，350ms 防抖写入 `task.progressSteps` 驱动看板；Worker 无需为 todo 调状态上报，todo 全完成不等于任务完成。

### 存储与兼容性

- **0.3.19 破坏性变更**：Task 顶层保存 result/artifacts/card/error/reasonCode，删除 report/fail。domain v3 不接纳旧域，已删除 migrateRecord 与 compatibleVersions；不要静默丢字段、搬旧包裹数据或修改旧域版本戳。升级前备份旧域，并停用旧 Worker 绑定的宿主定时任务；新建 Lead/Worker 会话。
- `snapshotResultSchema` 与持久化 schema 同源；hasActiveSchedule 只在 snapshot 扩展，不落库。RPC 方法/请求不变，typert 包身份随 npm 包改为 @cmjt/dsh-orchestrator。
- 日程由 planScheduleChanges 整批校验后写入，成功后广播一次变更；只保证校验失败零写入，不承诺 I/O 失败的跨记录原子性。
- 存储仍位于 ~/.dsh/storages/orchestrator/（domain v3，per-record，conversations/tasks/schedules）；旧 orchestrator.json 同样需要备份移出。详见 docs/board-api-v0.3.19-changes.md。
- 子会话 transcript：`~/.dsh/sessions/<workspace-encoded>/<childSessionId>/session.v4.jsonl.zstd`，用 `zstd -dc` 解压排查真实轮次；`turn/end` 的 reason 是判断手动停止/改单的依据。

## 代码约定

- typecheck（host + client 两个 project）必须干净；提交前跑全量 vitest。
- 新语义先在 state-machine/types 层落纯函数 + 单测，再接 service。
- 状态字面量列表用 types.ts 的常量（activeTaskStatuses / terminalTaskStatuses / blockReasonCodes），不要再散落状态数组；仅内部使用的常量不要 export。
- 日志用 `hostCtx.logger.info/warn`，英文即可；面向用户的文案一律中文。
- 看板文案与状态标签中文；新增 TaskStatus/ConversationState 时同步 task-box.tsx 的标签、Board.tsx 的会话聚合与 styles.ts 的 badge 颜色。
- 死代码及时删（已清理：scene 四模式、PLAN.md、subagent 时代 settled 双重拦截、{{cwd}} suffix 等），不要留兼容分支以外的旧代码。

## 常见坑

- 先 interrupt 再对持旧 activeTaskId 的 conv 做普通 activate：必撞 `conversation_busy`。改单走 `reviseConversation`。
- cancel 是 fire-and-return，旧轮次 turn/end 晚到；没有 revisionTurnEnds 守卫就会把旧任务误判 failed 或把新任务误标手动停止。
- 向 failed 工作流派发会 throw，dispatch 已包 try/catch 返回结构化 error，新增的外部调用路径同样要兜住。
- 快速 Worker 可能在 followup 接受与收尾之间已提交终态：只补 queued→running，不回滚终态。
- 重启恢复：普通活动任务（含 input_required）统一转 interrupted（`interruptTaskAfterRestart`，不主动投递）；persistence stat 不确定时用 `failTask(..., {reasonCode:'runtime'})`；并恢复未投递 outbox。
- pnpm-lock 与 peerDeps 范围改动后必须 `--no-frozen-lockfile` 重装并核对 zod 解析到 4.4.3。
- 存储 schema（baseTaskSchema/baseConversationSchema）收紧约束会让旧记录在重启后解析失败：新字段给 default、长度等限制只放输入边界 schema。

## 背景材料

- README.md：用户面说明，发版时随版本号更新。
- docs/README.md：文档索引；docs/milestones/0.3.21.md：当前变更、验证与已知限制。
- **正式发版清单（用户授权后）**：先更新版本与文档 → host/client typecheck + 全量测试 → build + verify:packaging → `npm pack` → 中文 commit + annotated tag（若本地里程碑已存在且内容未变则复用）→ push dev 与对应 tag → `gh release create` 必须同时附三个资产：构建产物 tgz（**lib/ 已编译**，源码 tar.gz 装不了）、`board-api.md` 完整接口和 `board-api-v<版本>-changes.md` 差异说明 → 正式版 tgz 装回 web profile 并通过指定脚本以 start_new_session 重启 3080。**GitHub release 之外必须同步发布私有 npm 源**（Verdaccio `http://36.138.53.195:4873/`，scope `@cmjt` 已映射）：`npm publish --registry http://36.138.53.195:4873/` 后用 `npm view @cmjt/dsh-orchestrator --registry http://36.138.53.195:4873/` 验证；两处包内容 shasum 应一致（同一次 `npm pack` 产物）。
