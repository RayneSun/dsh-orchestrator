# DSH Orchestrator

DSH 主控助理编排插件。Lead 主会话只负责理解需求、维护路由卡、派发任务和转述结果；持久子会话保存完整执行上下文，每次派发对应一条 TaskRun。

## 预设

- `may-orchestrator-lead`：主控助理。工具采用**白名单**：仅保留编排工具和向用户提问工具；用户后安装的全局工具（MCP/插件）对 Lead 不可见，避免干扰路由。能直接回答的闲聊和解释类问题 Lead 直接回答，不派发。
- `may-orchestrator-worker`：统一执行 Worker。工具采用**黑名单**：文件、命令、网页、浏览器、技能、MCP 等宿主自带与用户安装的工具默认可用，仅禁止再派生子 Agent、调用编排工具和直接向用户提问。

Worker 的任务上报协议、安全红线（支付/删除等不可逆操作先确认）、文件边界与整洁约束都固化在预设 persona 中，每次派发只传递任务本身（共享工作区，不重复环境声明）。`task_update` 状态为 running、input_required、completed、failed。

## 工作方式

- Lead 先调用 `orchestrator_route`，强相关追问复用原 Conversation。
- `orchestrator_dispatch` 新建 Conversation，或向已有持久子会话排队新 TaskRun；目标会话仍在运行时，会先把旧任务原子标记为 `interrupted`（改单中断，区别于失败/取消，不向主会话投递失败通知），中断子会话当前轮次，再把新需求 steer 进**同一个**子会话继续执行。
- 用户在子会话中手动停止执行时，活动任务同样进入 `interrupted`（不投递失败通知），工作流回到 idle，可直接继续派发新需求。
- `orchestrator_route` 同时考虑运行中的工作流；纯词法 0 命中时，若只有一个工作流且查询呈现改单/追问语气（如“改成白天背景”），会兜底返回该工作流。
- Worker 不能直接向用户提问：需要用户选择或补充时调用 `task_update({status:'input_required', question})`，由 Lead 向用户提问，并把答复作为新 TaskRun 派发回同一子会话。
- Worker 多步骤任务继续使用内置 `todo_write`；Host 监听子会话的 `todo/write` 事件（约 350ms 合并）并自动同步到 TaskRun 的步骤进度，任务看板会实时显示 `✓/▶/○` 与 `已完成/总数`。Worker 不需要为每个 todo 变化调用 `task_update`，todo 全完成也不会自动结束任务，终态仍以 `task_update` 为准。
- `dispatch` 默认 `background`，不阻塞主对话；`wait` 仅用于需要同轮结果的短任务，超过 60 秒自动转后台。
- `background` 完成、待补充或失败后通过持久 outbox 唤醒 Lead；改单中断与手动停止不产生通知。
- 子会话框架自带的 settled 通知会被过滤，避免与 `task_update` 重复；Lead 只以 Worker 的 `userAnswer` 为权威结果。
- 重启后恢复看板；未完成任务标记 input_required，未投递的后台终态会重试唤醒 Lead。

## Web 看板

在主会话 header 点击“任务看板”。右侧栏按工作流展示状态、轻量路由卡摘要、TaskRun 时间线、实时步骤进度、错误、结果和同步状态；点击“打开子会话”可查看完整子会话。V1 看板只读。

## 分发安装

要求接收方已安装 DSH `0.2.1-alpha.1`，并且使用 Web profile。

把 `may-dsh-orchestrator-0.2.5.tgz` 发给对方后执行：

```sh
dsh plugin --profile web add /path/to/may-dsh-orchestrator-0.2.5.tgz
dsh web --no-open --host 127.0.0.1 --port 3080
```

新版本覆盖安装时，先移除旧版本再添加新 tarball：

```sh
dsh plugin --profile web remove @may/dsh-orchestrator
dsh plugin --profile web add /path/to/may-dsh-orchestrator-0.2.5.tgz
```

重新生成分发包：

```sh
pnpm install
pnpm pack:dist
```

tarball 只包含运行所需的 `lib/`、`cordis.patch.yml`、README、LICENSE 和 package metadata；不包含源码测试、source map、本机 `node_modules` 或开发仓库路径。

## 本地开发

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm verify:packaging
pnpm pack:dry
```

安装到本地 Web profile：

```sh
dsh plugin --profile web add /Users/may/Documents/ChatGPT/dsh-orchestrator
```

移除：

```sh
dsh plugin --profile web remove @may/dsh-orchestrator
```

启动：

```sh
dsh web --no-open --host 127.0.0.1 --port 3080
```

## 存储

插件使用 `storageDomain` 的 `orchestrator` v1 domain，包含 `conversations` 与 `tasks` 两张表。完整子会话 transcript 仍由 DSH Session 持久化保存，插件只保存路由摘要和任务状态。
