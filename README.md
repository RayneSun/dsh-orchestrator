# DSH Orchestrator

DSH 主控助理编排插件，也是一个开箱即用的个人助理能力包。Lead 主会话只负责理解需求、维护路由卡、派发任务和转述结果；持久子会话保存完整执行上下文，每次派发对应一条 TaskRun。

## 预设

- `may-orchestrator-lead`：主控助理。工具采用**白名单**：编排工具、向用户提问、长期记忆，以及只读轻量查询（web_search / web_fetch / read / glob / grep）——一步能完成的查询 Lead 直接做；写文件、跑命令等执行类全局工具（含用户后装的 MCP/插件）对 Lead 不可见，避免干扰路由。能直接回答的闲聊和解释类问题 Lead 直接回答，不派发。
- `may-orchestrator-worker`：统一执行 Worker，是与主会话同级的**一等根会话**（非子代理），因此定时任务（schedule）等平台能力对其开放。工具采用**黑名单**：文件、命令、网页、浏览器、技能、MCP、定时任务等宿主自带与用户安装的工具默认可用，可使用子智能体（subagent/fork）与后台任务（job）做并行、隔离或长耗时处理；仅禁止编排循环（workflow/ralph）、调用 orchestrator 编排工具和直接向用户提问。

Worker 的任务上报协议、安全红线（支付/删除等不可逆操作先确认）、文件边界与整洁约束都固化在预设 persona 中，每次派发只传递任务本身（独立工作区由运行时自动绑定，不重复环境声明）。`task_update` 状态为 running、input_required、blocked、completed、failed。

- `input_required` 只表示需要用户回复/选择，或需要用户接管浏览器、系统安全界面。
- `blocked` 表示权限、配置、依赖、网络、资源、运行时等系统阻碍；Worker 可提供原因分类和补救建议。
- Worker 主动上报 `failed` 时只结束本次任务，持久子会话仍可复用；只有子会话启动/崩溃等 Host 级致命错误才会让 Conversation 进入 failed。
- 安装 bundle 后，新会话自动使用 `may-orchestrator-lead` 预设，不需要手动修改模型或 DSH 配置文件；用户仍可在 DSH 界面主动切换其他预设。

## 个人助理能力包

安装本 bundle 会同时启用：

- `meow-memory`：跨会话长期记忆，是唯一长期记忆库。Lead 与所有 Worker 子会话通过共享链接（macOS/Linux 符号链接、Windows junction）指向主工作区下的同一份记忆库，任何一端写入、全端可查。
- `@wxg-prc-cpg/browser-skill-dsh-plugin`：浏览器自动化；需自行安装 `bsk` CLI 和浏览器扩展。
- `@zhengjunyao/dsh-qqmail`：QQ 邮箱/IMAP/SMTP，默认只读，外发或删除需用户确认与配置授权码。
- 桌面操控：macOS 使用本包内 vendored 的 `dsh-computer-use` 驱动；Windows 安装 `@milkuovo/dsh-computer-use`。两者通过平台 gate 二选一启用。vendored 驱动的 MIT 许可证见 `lib/vendor/dsh-computer-use-darwin/LICENSE`，仍需系统提供可执行的 `cua-driver`。

这些能力插件的普通依赖不会把旧版 DSH runtime 提升到 profile 依赖树；macOS 驱动只通过宿主的 peer runtime 加载，避免覆盖 `@deepseek-ai/dsh-tools`。

## 工作方式

- Lead 的系统提示中注入实时 roster（conversationId、状态、创建/更新时间），直接据此复用 Conversation；追问、改单和用户指代的历史任务（如“上周那个”）按主题与时间对号。
- `orchestrator_dispatch` 新建 Conversation，或向已有持久子会话排队新 TaskRun；目标会话仍在运行时，会先把旧任务原子标记为 `interrupted`（改单中断，区别于失败/取消，不向主会话投递失败通知），中断子会话当前轮次，再把新需求 steer 进**同一个**子会话继续执行。
- 用户在子会话中手动停止执行时，活动任务进入 `interrupted`（非失败），工作流回到 idle，并向主会话投递中断通知：Lead 据此简短告知用户并询问继续、改需求还是放弃，答复仍复用同一工作流。
- Worker 系统提示自动遮蔽 DSH 自举开发说明（checkout/Web GUI/HMR）等与执行任务无关的全局段落，且不组合 present/goal 等面向终端用户的插件，降低每轮上下文体积。
- Worker 不能直接向用户提问：需要用户选择、补充或接管浏览器/系统确认时调用 `task_update({status:'input_required', question})`，由 Lead 向用户提问，并把答复作为新 TaskRun 派发回同一子会话；权限/配置/依赖/网络等系统阻碍使用 `blocked`。
- Worker 多步骤任务继续使用内置 `todo_write`；Host 监听子会话的 `todo/write` 事件（约 350ms 合并）并自动同步到 TaskRun 的步骤进度，任务看板会实时显示 `✓/▶/○` 与 `已完成/总数`。Worker 不需要为每个 todo 变化调用 `task_update`，todo 全完成也不会自动结束任务，终态仍以 `task_update` 为准。
- 新建 Worker 会在当前主工作区下获得独立工作目录 `<主题>/`（同名冲突自动递增 `-2`、`-3`）；`dispatch.subject` 自动用于目录命名，也可传 `workspaceName` 覆盖。复用已有子会话时继续使用原目录。
- `dispatch` 一律后台派发，不阻塞主对话；需要了解进展时由 Lead 主动调用 `orchestrator_list` / `orchestrator_get` 查询。记忆整理等后台维护任务可设 `silent: true`：终态（含失败）完全不向主会话投递，Lead 不跟进，看板仍显示状态并带“静默”徽标。
- 完成、待操作、受阻、失败或被用户手动停止后通过持久 outbox 唤醒 Lead；改单接管和普通重启中断的旧任务不产生通知。
- Lead 只以 Worker 的 `report.result` 为权威结果；`report.artifacts` 制品路径自动带工作区前缀。
- 定时/周期任务由 Worker 的 schedule 工具创建并绑定其自身子会话；到点触发后 Worker 执行并上报，Lead 转述给用户。
- 重启后恢复看板；普通未完成任务标记 interrupted，无法确认持久化状态时标记 blocked；未投递的后台终态会重试唤醒 Lead。

## Web 看板

在主会话 header 点击“任务看板”。右侧栏按子会话展示状态、独立工作区名、轻量路由卡摘要、任务时间线（支持折叠，运行中的子会话高亮）、实时步骤进度、错误、结果和同步状态；点击“打开子会话”可查看完整子会话。静默工作流带 🔇 图标、整卡降透明度，标题计数拆分“N 个子会话 · M 个静默”。V1 看板只读。

## 分发安装

要求接收方已安装 DSH `0.2.1-rc.2` 或更高版本，并且使用 Web profile。

把 `may-dsh-orchestrator-0.3.6.tgz` 发给对方后执行（安装后新会话自动进入主控助理预设，无需手改配置）：

```sh
dsh plugin --profile web add /path/to/may-dsh-orchestrator-0.3.6.tgz
dsh web --no-open --host 127.0.0.1 --port 3080
```

新版本覆盖安装时，先移除旧版本再添加新 tarball：

```sh
dsh plugin --profile web remove @may/dsh-orchestrator
dsh plugin --profile web add /path/to/may-dsh-orchestrator-0.3.6.tgz
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
dsh plugin --profile web add /path/to/dsh-orchestrator
```

移除：

```sh
dsh plugin --profile web remove @may/dsh-orchestrator
```

启动：

```sh
/Users/lixuchuan/work/harness/start-dsh-web.sh
```

## 存储

插件使用 `storageDomain` 的 `orchestrator` v1 domain，包含 `conversations` 与 `tasks` 两张表。完整子会话 transcript 仍由 DSH Session 持久化保存，插件只保存路由摘要和任务状态。
