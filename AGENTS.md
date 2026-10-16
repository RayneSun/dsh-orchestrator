# AGENTS.md — dsh-orchestrator 开发指引

面向接管本仓库的 AI 编码助手。读完本文件再动手。

## 项目是什么

`@may/dsh-orchestrator`：DSH（DeepSeek Harness，基线 `0.2.1-alpha.1`）的编排插件。

- **Lead**（主会话，预设 `may-orchestrator-lead`）：理解需求、路由、派发任务、向用户转述结果。工具**白名单**制：编排 + 提问 + 记忆 + 只读查询（web_search/web_fetch/read/glob/grep），一步查询直接做，有副作用的执行全部派发。
- **Worker**（持久子会话，预设 `may-orchestrator-worker`）：执行任务。工具**黑名单**制（只禁派生/编排/直接提问），其余宿主与用户安装的工具默认可用。
- 两层领域模型：**Conversation**（持久子会话/工作流）1—N **TaskRun**（一次派发）。
- 技术栈：pnpm + TypeScript + Cordis + Zod + tsdown + vitest。4 个入口：主插件、client（看板 React）、typert host/remote（snapshot RPC）。

## 本机环境与硬性约束

- DSH CLI 全局包：`@deepseek-ai/dsh@0.2.1-alpha.1`（`/opt/homebrew/lib/node_modules`，读 API 定义从这里查）。
- 真实 web profile：`~/.dsh/profiles/web`；**GUI（`/Applications/DeepSeek Harness.app`）绝不能动**，不要用全局 npm 安装/覆盖 dsh。
- **重启 web 必须用脚本**：`/Users/lixuchuan/work/harness/start-dsh-web.sh`（设置 NODE_EXTRA_CA_CERTS、清代理，内部 `exec dsh web --host 127.0.0.1 --port 3080`）。不要直接 `dsh web`。
- 访问/写入 `~/.dsh`、`dsh plugin`、kill 3080 端口、启动 dsh 都需要沙箱提权。
- `npm pack` 有 `~/.npm` root 属主 EPERM 问题，必须：`export npm_config_cache=/private/tmp/dsh-npm-cache`。

## 标准发布流程

```bash
pnpm typecheck          # tsc（主）+ tsc（client）两个 project 都要过
pnpm test               # vitest，当前 59 个用例
pnpm build
export npm_config_cache=/private/tmp/dsh-npm-cache
pnpm verify:packaging   # 校验 tgz 只含运行所需 lib/、vendor/、cordis.patch.yml 等文件
npm pack --pack-destination dist   # 产物 dist/may-dsh-orchestrator-<version>.tgz
# 改 package.json 版本号与 README.md 中的安装文件名，保持一致
```

安装到 web profile 并重启（需提权）：

```bash
lsof -ti tcp:3080 | xargs kill
dsh plugin --profile web remove @may/dsh-orchestrator
dsh plugin --profile web add <tgz 绝对路径>
/Users/lixuchuan/work/harness/start-dsh-web.sh
```

验证要在**新会话**里做；旧会话可能有历史脏数据。改插件代码后必须 remove+add 重装，仅重启不会更新 bundle。

## 架构要点（改代码前必读）

### 状态机（src/types.ts + src/state-machine.ts）

- 新建 Conversation 必须在主会话 cwd 下创建唯一子目录（同名冲突递增 `-N` 后缀），并在创建持久子会话时通过 `withChildWorkspaceCwd` 注入 `meta.cwd`；复用 Conversation 不换目录。目录名由 `dispatch.subject` 或 `workspaceName` 经 `src/workspaces.ts` 清洗。
- Task 状态：`queued / running / input_required / blocked / completed / failed / cancelled / interrupted`。
  - `input_required`：只表示 Worker 需要用户补充信息/选择，或需要用户接管浏览器、系统安全界面；必须有 question。
  - `blocked`（0.3.2 重新引入，语义不同于 0.2.x）：权限、配置、依赖、网络、资源、运行时等系统阻碍；带 error、可选 reasonCode/remediation。
  - `interrupted`：被改单接管或用户手动停止。改单接管不投递；用户手动停止需要投递一条非失败通知，工作流回 `idle` 可继续派发。
  - `input_required / blocked / completed / failed / interrupted` 都允许带 delivery；interrupted 是否挂起由具体路径决定（`deliverableTaskStatuses`）。Worker 主动 failed/blocked 后 Conversation 回 idle；只有 Host 级致命错误（如子会话启动失败/持久化记录缺失）才额外 failConversation。
- Conversation 状态：`provisioning / running / idle / input_required / failed`。
- 终态投递（delivery outbox）由状态机在迁移时统一挂起，**不要**在创建任务或别处预挂 `delivery: pending`（否则看板对运行中任务误报"同步中"）。
- 所有状态修改走 `service.serialize()` 串行链；涉及改单必须"旧任务 interrupted + reviseConversation 原子切 activeTaskId"先落盘，再做外部调用。

### 改单（同一工作流补充/修改需求）时序

`provisionDispatch` 复用分支（src/service.ts）：

1. 存储原子切换：旧任务 `interruptTaskForRevision`（delivery=undefined）+ `reviseConversation`（绕过 busy 校验）+ 新任务落盘。
2. arm 两个守卫（`revisionEndGuards` + `revisionTurnEnds`，120s 窗口）。
3. `subagents.interrupt()`（fire-and-return，单独 try/catch，失败不拖垮新任务）。
4. `steerHostSubagentPrompt` 注入 `revisionPrompt(task)`（一句短通知 + 任务正文）；steer 不接受则 fallback `queueHostSubagentPrompt`。
5. interrupt 必然异步带来一次 `turn/end aborted` 和 `subagent/end`：前者由 revisionTurnEnds 吞掉（防止误判为手动停止），后者由 revisionEndGuards 按 oldTaskId 核对吞掉（防止误判 failed）。
6. 子会话 `turn/end` 的 `aborted.reason.kind=user` 是**用户手动停止**：任务标 interrupted、工作流回 idle、投递非失败通知；`aborted.reason.kind=parent` 且改单守卫缺失时按改单中断幂等处理，不投递。

### 工具权限

- Lead：`scoped.tools.restrict({ allow })`，allow 名单见 `LEAD_TOOL_ALLOW`（presets.ts）。
  - restrict 只过滤**全局**工具；scope 内注册的 orchestrator_* 始终可见。
  - 必须先枚举实际注册的全局工具取交集再 restrict（传未知名会 throw）；枚举失败退回无限制并 warn，fail-open 比让主控失能安全。
- Worker：`scoped.tools.guard(isWorkerToolForbidden)`（worker-policy.ts）。模式匹配见 `workerForbiddenPatterns`；新增"禁止类"工具只改这里。
- 不要用白名单裁剪 Worker——用户后装工具（MCP/浏览器/技能）必须默认可用。

### 给模型的输入输出要精简（产品要求）

- dispatch 的 `prompt` 只写需求和验收点。Lead/Worker 共享同一工作区（`{{cwd}}` 由 persona suffix 注入），禁止重复工作目录/路径声明，禁止粘贴内部 ID。
- dispatch 返回给 Lead 的只需 `conversationId`（后续复用）；不要返回 taskId/childSessionId。
- list/get 的输出做投影（leadTools/listWorkflows），不要把整条数据库记录给模型。
- roster 系统提示词每工作流一行；看板（Board.tsx）可以展示更多内部字段，但不要在主会话输出内部概念。
- Worker 注入只有两种文案：`workerPrompt`（正常）和 `revisionPrompt`（改单），都在 messages.ts。

### Lead 行为约束（messages.ts LEAD_PROMPT）

- 闲聊、概念解释、当前对话内可答的问题**直接回答，不调任何工具**；需要实际执行（联网/文件/命令/浏览器）才派发。
- background 派发后只回一句简短自然确认（"好，这就改"）；禁止"任务正在后台进行/Worker 完成后我会发给你"等系统腔；不暴露 Worker/Conversation/TaskRun 等词；不提前承诺交付物。
- 追问、改单必须由 Lead 按 roster 复用原 conversationId；roster/list 必须给 Lead 暴露创建和更新时间。

### Worker 上报协议

- `task_update`：running(+progressNote?) / input_required(+question) / blocked(+error, reasonCode?, remediation?) / completed(+userAnswer) / failed(+error)。completed 的 userAnswer 是 Lead 转述的唯一权威答案。
- Worker 不能直接向用户提问（ask-user 工具被 guard 拦且不进预设）。
- todo_write 是内部步骤清单：Host 监听 `todo/write` 事件，350ms 防抖写入 `task.progressSteps` 驱动看板；Worker 无需为 todo 调 task_update，todo 全完成不等于任务完成。
- 子代理框架自带的 settled 唤醒（source.kind = 'subagent-settled'）必须被 pre-step 过滤 + followup/steer/inject monkey-patch 双重拦截，否则会产生空回合和重复答案。

### 存储与兼容性

- 存储：`~/.dsh/storages/orchestrator.json`（domain v1，tables: conversations/tasks）。
- 持久化 schema 用 zod；**改字段必须在 types.ts 的 `migrateRecord` 里做旧记录迁移**（先例：scene 剥离、仅旧版带 scene/blockedQuestion 的 blocked→input_required、blockedQuestion→question；0.3.2 新 blocked 无 scene，不能误迁移）。client snapshot 走 z.preprocess，旧数据不能让看板炸掉。
- 子会话 transcript：`~/.dsh/sessions/<workspace-encoded>/<childSessionId>/session.v4.jsonl.zstd`，用 `zstd -dc` 解压排查真实轮次；`turn/end` 的 reason 是判断手动停止/改单的依据。

## 代码约定

- `pnpm typecheck` 必须干净；提交前跑全量 vitest。
- 新语义先在 state-machine/types 层落纯函数 + 单测，再接 service。
- 状态字面量列表用 types.ts 的常量（activeTaskStatuses / deliverableTaskStatuses / terminalTaskStatuses / taskUpdateStatuses / blockReasonCodes），不要再散落状态数组。
- 日志用 `hostCtx.logger.info/warn`，英文即可；面向用户的文案一律中文。
- 看板文案与状态标签中文；新增 TaskStatus/ConversationState 时同步 Board.tsx 的 labels 与 styles.ts 的 badge 颜色。
- 死代码及时删（前几轮已清理 scene 四模式、PLAN.md、未用导入等），不要留兼容分支以外的旧代码。

## 常见坑

- 先 interrupt 再对持旧 activeTaskId 的 conv 做普通 activate：必撞 `conversation_busy`。改单走 `reviseConversation`。
- interrupt 是 fire-and-return，end 事件晚到；没有守卫就会把新任务/旧任务误判 failed 并向主会话吐失败通知。
- 向 failed 工作流派发会 throw，dispatch 已包 try/catch 返回结构化 error，新增的外部调用路径同样要兜住。
- 重启恢复：普通活动任务统一转 interrupted（`interruptTaskAfterRestart`，不主动投递）；persistence stat 不确定时用 blockTask 标 blocked；并恢复未投递 outbox。

## 背景材料

- README.md：用户面说明，发版时随版本号更新。
- git log：0.2.0（background/单 Worker 预设）→ 0.2.1（路由追问兜底/改单 steer/blocked 提问）→ 0.2.2（todo 进度桥接看板）→ 0.2.3（interrupted 改单语义）→ 0.2.4（手动停止捕获、看板与话术精简）→ 0.2.5（白名单、input_required、上下文瘦身、鲁棒性）→ 0.2.6（手动中断通知、状态配色、Worker 提示词瘦身）→ 0.2.7（子会话折叠、柔光动效、按钮突出、提示词/恢复加固）→ 0.3.0（个人助理能力 bundle）→ 0.3.2（blocked 系统受阻语义、Worker failed 可复用、默认 Lead 预设免手改）。
