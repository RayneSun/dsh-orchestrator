# DSH Orchestrator

DSH 主控助理编排插件。Lead 主会话负责路由、派发、汇总和自然语言回复；持久子会话保存完整上下文，每次派发对应一个 TaskRun。

## 核心概念

- Conversation/Workstream：一个持久子会话和轻量路由卡。
- TaskRun：派发到某个 Conversation 的一次具体请求。
- `orchestrator_dispatch`：新建或复用 Conversation。
- `task_update`：仅受管 Worker 可见，用会话身份反查活动任务并上报状态。
- Remote API：`orchestrator.snapshot({ parentSessionId })`。
- Web 看板：主会话 header 打开右侧栏，只读展示工作流和任务时间线。

## 本地开发

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm pack:dry
```

安装到本地 web profile：

```sh
dsh plugin --profile web add /Users/may/Documents/ChatGPT/dsh-orchestrator
```

移除：

```sh
dsh plugin --profile web remove @may/dsh-orchestrator
```

## Worker 场景

- `code`：可读写、搜索、运行命令和测试。
- `general`：通用执行权限。
- `research`：网页、资料读取和只读搜索。
- `review`：文件/网页只读、搜索和评审。

所有 Worker 都禁止再派生 Agent，只能通过 `task_update` 汇报状态。
