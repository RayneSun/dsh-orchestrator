# DSH Orchestrator

DSH 主控助理编排插件。Lead 主会话只负责理解需求、维护路由卡、派发任务和转述结果；持久子会话保存完整执行上下文，每次派发对应一条 TaskRun。

## 预设

- `may-orchestrator-lead`：主控助理，只暴露编排和追问工具。
- `may-orchestrator-worker-code`：代码执行 Worker，可读写、搜索、运行命令和测试。
- `may-orchestrator-worker-general`：通用执行 Worker。
- `may-orchestrator-worker-research`：资料调研 Worker，仅网页、资料读取和只读搜索。
- `may-orchestrator-worker-review`：只读审查 Worker。

所有 Worker 都禁止再派生 Agent，并通过 `task_update` 上报 running、blocked、completed、failed。

## 工作方式

- Lead 先调用 `orchestrator_route`，强相关追问复用原 Conversation。
- `orchestrator_dispatch` 新建 Conversation，或向已有持久子会话排队新 TaskRun。
- `wait` 同轮等待短任务；超过 60 秒自动转后台。
- `background` 完成、阻塞或失败后通过持久 outbox 唤醒 Lead。
- 子会话框架自带的 settled 通知会被过滤，避免与 `task_update` 重复；Lead 只以 Worker 的 `userAnswer` 为权威结果。
- 重启后恢复看板；未完成任务标记 blocked，未投递的后台终态会重试唤醒 Lead。

## Web 看板

在主会话 header 点击“任务看板”。右侧栏按 Conversation 展示场景、状态、轻量路由卡、TaskRun 时间线、进度、错误、结果摘要和后台投递状态；点击“打开子会话”可查看完整子会话。V1 看板只读。

## 分发安装

要求接收方已安装 DSH `0.2.1-alpha.1`，并且使用 Web profile。

把 `may-dsh-orchestrator-0.1.0.tgz` 发给对方后执行：

```sh
dsh plugin --profile web add /path/to/may-dsh-orchestrator-0.1.0.tgz
dsh web --no-open --host 127.0.0.1 --port 3080
```

新版本覆盖安装时，先移除旧版本再添加新 tarball：

```sh
dsh plugin --profile web remove @may/dsh-orchestrator
dsh plugin --profile web add /path/to/may-dsh-orchestrator-0.1.0.tgz
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
