# DSH 主控助理编排插件开发计划

## 概要

- 在官方 DSH 源码之外新建独立插件仓库：`/Users/may/Documents/ChatGPT/dsh-orchestrator`。
- 交付一个可安装 bundle：`dsh-orchestrator`；内部包含 Lead 编排、Worker 场景、状态上报、Remote API 和 Web 看板。
- 不修改官方 DSH 源码，不发布 npm，本地通过绝对路径安装到 `web` profile。
- 技术栈使用 DSH 生态要求的 `pnpm + TypeScript + Cordis + Zod + tsdown + vitest`；不使用 uv/Typer/Pydantic。
- 当前基线已确认：DSH `0.2.1-alpha.1`、官方仓库构建通过、`dsh web` 运行在 `http://127.0.0.1:3080`。

核心语义拆成两层：

- **Conversation/Workstream**：持久子会话，保存完整上下文。
- **TaskRun**：派发到某个子会话的一次具体请求。

天气示例中，子任务通过 `task_update` 返回结构化结果；Lead 收到后在主会话生成最终自然语言回答。UI 看板只展示任务状态和结果摘要，不把子会话原文伪装成用户直接答案。

“适合穿什么”的追问通过 Lead 的轻量路由卡和 `orchestrator_route` 复用天气子会话；主会话只保存摘要、实体、标签和结果，不加载所有子会话全文。

## 产品与接口设计

### Agent Preset

bundle 注册以下 preset：

- `may-orchestrator-lead`：主控助理。
- `may-orchestrator-worker-code`：代码执行 Worker。
- `may-orchestrator-worker-research`：资料调研 Worker。
- `may-orchestrator-worker-review`：只读审查 Worker。
- `may-orchestrator-worker-general`：通用执行 Worker。

用户新建主会话时选择“主控助理”。Lead preset 只保留对话、网页、追问、展示和压缩所需工具；具体写文件、跑命令等工作交给 Worker。

子会话创建时先继承 Lead preset，插件在 `agent/created` 的串行阶段根据存储中的 scene 调用 `agentPresets.recompose()` 切换到对应 Worker preset，然后安装 worker 工具和 guard。冷恢复时也执行同样逻辑。

### Lead 工具

仅在 Lead agent scope 注册：

- `orchestrator_route`：根据用户新请求匹配可复用 Conversation，返回候选、匹配理由和摘要。
- `orchestrator_dispatch`：新建 Conversation 或向已有 Conversation 队列新 TaskRun。
- `orchestrator_list`：列出工作流和任务状态。
- `orchestrator_get`：读取某个 Conversation 的完整路由卡。

`orchestrator_dispatch` 参数：

- `subject`
- `prompt`
- `scene`
- `conversationId?`
- `responseMode: 'wait' | 'background'`
- `acceptanceCriteria?`
- `waitTimeoutMs?`，默认 60 秒。

`wait` 在同轮等待短任务结果；超时自动转后台。后台任务完成、阻塞或失败后，Host 通过 `sessionController.resolveAgent()` 和 `agent.followup()` 唤醒 Lead，由 Lead 再回复用户。

Lead 的动态 system prompt 中始终注入紧凑 Workstream roster：ID、标题、scene、状态、当前任务、关键实体、标签和最近结果；完整大纲按需通过工具读取。

### Worker 工具与场景

仅在受管子会话中注册 `task_update`，不接受 task id；Host 根据 `exec.agent.session.id` 反查 active task，防止串改。

`task_update` 支持：

- `status: 'running' | 'blocked' | 'completed' | 'failed'`
- `progressNote?`
- `userAnswer?`：completed 时必填，给 Lead 转述给用户的权威答案。
- `resultSummary?`
- `error?`
- `outlinePatch?`：更新标题、关键事实、实体、标签、产物、未决问题。

场景权限：

- `code`：允许读写、搜索、命令和测试；禁止再派生 Agent。
- `general`：通用执行权限；禁止再派生 Agent。
- `research`：允许网页、资料读取、文件只读；禁止写入和命令。
- `review`：允许文件/网页只读和搜索；禁止写入和命令。

权限双层实现：

1. `startContinuable()` 设置 scene persona、`toolFilter` 和 `maxDepth: 1`。
2. 在子 agent scope 注册 `tools/pre-execute` guard，作为硬安全边界。

`subagent/end` 不代表任务完成。若子会话结束时没有提交终态 `task_update`，当前 TaskRun 标记为 `failed` 或 `blocked`，原因记录为缺少终态上报。

### 持久化模型

使用 `ctx.storageDomain`，domain 名称为 `orchestrator`，版本 1，包含两张表：

- `conversations`
- `tasks`

Conversation 记录：

- `id` / `childSessionId`
- `parentSessionId`
- `scene`
- `title`
- `outline`：summary、keyFacts、entities、tags、artifacts、openQuestions
- `activeTaskId`
- `lastTaskId`
- `state: 'provisioning' | 'running' | 'idle' | 'blocked' | 'failed'`
- revision 和时间戳。

TaskRun 记录：

- `id`
- `parentSessionId`
- `conversationId`
- `predecessorTaskId?`
- `subject`、`prompt`、`acceptanceCriteria?`
- `responseMode`
- `status: 'queued' | 'running' | 'blocked' | 'completed' | 'failed' | 'cancelled'`
- `progressNote?`、`userAnswer?`、`resultSummary?`、`error?`
- `delivery`：后台任务投递状态，用作持久 outbox
- revision 和时间戳。

V1 不写自定义 Session Event，避免会话事件重放兼容问题；子会话完整 transcript 仍由 DSH 自身保存。

新建任务时预分配 `childSessionId` 并写入 `provisioning/queued`，再调用：

- 新子会话：`ctx.subagents.startContinuable()`
- 复用子会话：`ctx.subagents.queuePrompt()`

启动失败会把任务标记为失败；重启时发现残留 provisioning 记录，会检查子会话是否存在，存在则采纳为 running，否则标记 failed。

## 实现步骤

1. **打包 Spike**
   - 初始化单包插件、tsdown host 构建和 browser closure 构建。
   - 验证 `lib/client.js` 是 `window.__ModuleLoader__.load(...)` closure。
   - 本地安装到 `web` profile，确认 host/client 都能加载。

2. **场景 Spike**
   - 注册 Lead 和 Worker preset。
   - 验证受管子会话创建后能从 Lead preset 重绑定到 scene preset。
   - 验证 Lead 看不到 `task_update`，Worker 看得到；Worker 的写入、命令和派孙任务 guard 生效。

3. **核心状态机**
   - 实现 Zod schema、revision CAS、状态迁移、词法路由评分、outline 合并。
   - 所有路由只基于摘要和元数据，不读取子会话全文。

4. **Host 生命周期**
   - 管理 start/queue、active task、`subagent/end`、异常回收和冷恢复。
   - 后台终态通过持久 delivery 记录重试投递，重启后未投递结果仍会唤醒 Lead。

5. **Lead/Worker 工具**
   - 动态安装 Lead 工具、Worker 工具、prompt section 和 scene guard。
   - Worker 初始 prompt 明确要求开始、进展、阻塞、完成时调用 `task_update`。

6. **Remote API**
   - 注册 Typert namespace：`orchestrator`。
   - 提供 `snapshot({ parentSessionId })`。
   - 每次持久状态变化后 emit `orchestrator/changed`。

7. **Web 看板**
   - 在主会话 header 增加“任务看板”入口。
   - 右侧栏按 Conversation 分组展示 TaskRun 时间线、状态、进展、错误和结果摘要。
   - 点击子会话卡片调用 `uiWorkspace.openSession({ parentSessionId, childSessionId, mode: 'continuable' })`。
   - V1 只读；取消、重试、直接追问放到 V2。

8. **安装与验收**
   - `pnpm build && pnpm test && pnpm typecheck`
   - `dsh plugin --profile web add /Users/may/Documents/ChatGPT/dsh-orchestrator`
   - 重启当前 3080 端口的 `dsh web`。
   - 若插件导致 Web 启动失败，立即从 `web` profile 移除插件并重启，保证官方 Web 可恢复。

## 测试计划

### 自动化测试

- 路由：天气后追问衣服能命中同一 Conversation；不同主题不会错误复用。
- 状态机：非法迁移、revision 冲突、缺少终态上报、失败和阻塞。
- 派发：新建 child、复用 child、`T2.predecessorTaskId = T1`、同一 child 同时只能有一个 active task。
- Worker：`task_update` 只能更新自己的 active task；Lead 和其他 child 不能修改。
- 场景：research/review 拒绝写入和 bash；所有 Worker 拒绝 subagent/workflow；code 允许正常读写和测试。
- 恢复：重启后 Conversation、Task、看板恢复；后台终态未投递时重新唤醒 Lead。
- Remote：snapshot、changed 事件、重连刷新。
- Client：空态、运行、阻塞、失败、完成、打开子会话。
- 打包：client closure 结构、peer dependency、`npm pack` 内容和插件安装兼容性。

### 真实模型手动验收

1. 在新的“主控助理”会话问“今天天气如何”：
   - Lead 创建 research 子会话。
   - 子会话通过 `task_update` 返回天气结果。
   - Lead 在主会话自然语言回答。
2. 继续问“适合穿什么衣服呢”：
   - Lead 复用天气子会话。
   - 同一 child 产生第二个 TaskRun，并能利用自身完整上下文。
3. 派发一个较长代码任务：
   - Lead 立即告知后台运行。
   - UI 展示进展。
   - 完成后 Lead 被唤醒并汇报。
4. 重启 `dsh web`：
   - 看板记录仍在。
   - 可打开原子会话。
   - 未投递的后台结果不丢失。

## 默认假设

- 只安装和验证 Web profile，不处理 Electron desktop 发布。
- V1 使用词法路由和摘要索引，不引入 embedding/vector database。
- V1 UI 只读，不做取消、重试和人工改派。
- 默认等待 60 秒，超时自动转后台。
- 一个 Conversation 同时只运行一个 TaskRun；不同 Conversation 可并行。
- 新仓库会初始化 Git，并按阶段使用中文 commit；不配置远程、不主动 push。
