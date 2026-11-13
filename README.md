# DSH Orchestrator

DSH 主控助理编排插件，也是一个开箱即用的个人助理能力包。Lead 主会话只负责理解需求、维护路由卡、派发任务和转述结果；持久子会话保存完整执行上下文，每次派发对应一条 TaskRun。

当前版本 **0.3.23**，包名为 **`@cmjt/dsh-orchestrator`**。任务状态上报拆为四个工具，用户待办/日程独立为 `task_todo`；snapshot 的任务结果字段拍平，记忆迁移至 dsh-personal-memory。**不兼容旧会话与旧看板存储**：升级前备份旧域并停用旧 Worker 的定时任务，升级后新建会话。见[完整接口](docs/board-api.md)、[0.3.23 接口变化说明](docs/board-api-v0.3.23-changes.md)和[发布记录](docs/milestones/0.3.23.md)。

## 预设

- `may-orchestrator-lead`：主控助理。DSH 自带工具全部可用（一步轻量查询、记忆查阅直接做）；个人记忆写/管理与 GenUI 直接渲染工具对 Lead 隐藏，需要实际执行时按提示词派发 Worker。长期记忆使用 dsh-personal-memory 的原生 `memory_search` / `memory_read`，不再复刻查询工具；Lead 停止自动反思、写入和空闲整理，保留原生记忆读入，写入手册只向 Worker 提供。
- `may-orchestrator-worker`：统一执行 Worker，是与主会话同级的**一等根会话**（非子代理），因此定时任务（schedule）等平台能力对其开放。工具采用**黑名单**：文件、命令、网页、浏览器、技能、MCP、定时任务等宿主自带与用户安装的工具默认可用，可使用子智能体（subagent/fork）与后台任务（job）做并行、隔离或长耗时处理；仅禁止编排循环（workflow/ralph）、调用 orchestrator 编排工具和直接向用户提问。

Worker 的任务上报协议、安全红线（支付/删除等不可逆操作先确认）、文件边界与整洁约束都固化在预设 persona 中，每次派发只传递细化后的用户需求与验收点（独立工作区由运行时自动绑定，不重复环境声明或指定执行方法）。Lead 额外获得按实际可见范围生成的 Worker 工具与 Skill 能力索引，用于判断能否派发，不暴露为新的模型工具。上报拆为 5 个独立工具，每个工具的 schema 只含该状态合法字段（v0.3.19 起，不兼容旧会话）：

- `task_running`：进行中上报，可带 `header`（最多 8 个字的状态标题）与 `progressNote`（一句话进展）
- `task_input_required`：必带结构化 `questions`，在看板和子会话渲染同源问题卡；阻塞工具调用，任一入口作答后工具直接返回用户答案，Worker 同轮继续
- `task_completed`：终态，必带 `result`（只阐述用户需求的最终结果，不写怎么做，不含过程性内容或文件路径）；结构化明细可传 `card`（dsh-ui 展示卡片 JSON），关键文件可传 `artifacts`；三者分工且不重复，提交后本轮立即结束
- `task_failed`：终态，必带 `error`，系统阻碍另加 `reasonCode`；提交后本轮立即结束
- `task_todo`：**用户待办/日程**维护（需要用户本人推进的事），与任务状态无关、随时可调用——新的放 `create`（title 必填，可加 startAt/endAt / remindAt / priority / links / attachments / contacts / location / remark），改的放 `update`（抄 id 标 done 或 cancelled 作废）；日程主会话 scope 独立成表，`conversationId` 归属回链，代办/修改都派回所属子会话处理。看板会话卡片上以日程框展示、用户可画勾。

- `input_required` 只表示需要用户回复/选择，或需要用户接管浏览器、系统安全界面。
- `failed` 既表示普通失败，也表示权限、配置、依赖、网络、资源、运行时等系统阻碍；系统阻碍用 `reasonCode` 标记，便于重派。
- Worker 主动上报 `failed` 时只结束本次任务，持久子会话仍可复用；只有子会话启动/崩溃等 Host 级致命错误才会让 Conversation 进入 failed。
- 安装 bundle 后，新会话自动使用 `may-orchestrator-lead` 预设，不需要手动修改模型或 DSH 配置文件；用户仍可在 DSH 界面主动切换其他预设。

## 个人助理能力包

安装本 bundle 会自动安装并启用以下能力：

- [dsh-personal-memory v0.4.6](https://github.com/friendllcc/dsh-personal-memory/releases/tag/v0.4.6)：通过私有 npm 源的 `@cmjt/dsh-personal-memory@0.4.6` 普通依赖自动安装。Lead 与 Worker 原生共享用户全局记忆库，默认数据家在 `~/.dsh/storages/dsh-personal-memory`（设置了 `DSH_HOME` 时跟随该目录），SQLite 位于其中的 `.dsh-personal-memory/memory.db`。Worker 保留完整记忆能力；Lead 只查询。旧工作区库的发现与合并交由插件原生迁移，不再创建共享链接，也不删除旧记忆。
- `@changfenhuang/dsh-genui@0.15.0`：普通依赖随包安装并在 bundle 中默认启用，负责渲染 Worker 提交的 `dsh-ui` 卡片。orchestrator 继续用定制 skill 约束 Worker 只通过 `task_completed.card` 提交卡片，不开放直接渲染与验证工具。
- `@fullcalendar/react@7.1.5`：日程页的 Breezy / Indigo 月历与跨天色条布局；React 运行时使用宿主，日历与样式内联进 client bundle。

权限分两层：记忆等可信插件在宿主进程内通过 Node 文件 API 读写 `~/.dsh`，不受模型文件工具的工作区沙箱限制；Worker 使用 `danger-full-access`（审批策略为 never），可按需读写该目录。Lead 的文件工具仍遵守自己的沙箱，记忆工具的查询不受此限制。无需放宽目录的系统权限。

记忆插件的“停止读入”同时会停用查询，因此 Lead 保留原生记忆快照。快照中的项目导引可能提及 `memory_project`，该工具仍对 Lead 隐藏，项目全景与记忆维护交给 Worker；不为此重建查询工具或改写插件消息。

Lead 的只读策略通过记忆插件已有的会话门控接口设置，短暂失败时幂等重试，仍失败则在推理前再次确认，避免未建立策略就运行；记忆目录由该插件自行定位，支持其自定义 `projectDir` / `homeDir`。orchestrator 不直接打开记忆数据库，也不创建工作区记忆链接。

这些能力插件的普通依赖不会把旧版 DSH runtime 提升到 profile 依赖树；macOS 驱动只通过宿主的 peer runtime 加载，避免覆盖 `@deepseek-ai/dsh-tools`。

## 工作方式

- Lead 的系统提示中注入实时 roster（conversationId、状态、创建/更新时间），按“一事一会”拆分与对号：同一事项的追问、改单、继续推进复用原 Conversation；只是“同类”的两件事（两个不同提醒、两次不同购物、两个不相关查询）分别新建子会话。用户指代的历史任务（如“上周那个”）按主题与时间对号。
- `orchestrator_dispatch` 新建 Conversation，或向已有持久子会话排队新 TaskRun；目标会话仍在运行时，会先把旧任务原子标记为 `interrupted`（改单中断，区别于失败/取消，不向主会话投递失败通知），中断子会话当前轮次，再把新需求 steer 进**同一个**子会话继续执行。
- 用户在子会话中手动停止执行时，活动任务进入 `interrupted`（非失败），工作流回到 idle，并向主会话投递中断通知：Lead 据此简短告知用户并询问继续、改需求还是放弃，答复仍复用同一工作流。
- Worker 系统提示自动遮蔽 DSH 自举开发说明（checkout/Web GUI/HMR）等与执行任务无关的全局段落，且不组合 present/goal 等面向终端用户的插件，降低每轮上下文体积。
- Worker 不能直接向用户提问：需要用户选择、补充或接管浏览器/系统确认时调用 `task_input_required({questions})`，问题卡在看板和子会话同步展示；任一入口作答后阻塞的工具调用立即返回用户答案，Worker 同轮继续执行。权限/配置/依赖/网络等系统阻碍使用 `task_failed + reasonCode`。
- Worker 多步骤任务继续使用内置 `todo_write`；Host 监听子会话的 `todo/write` 事件（约 350ms 合并）并自动同步到 TaskRun 的步骤进度，任务看板会实时显示 `✓/▶/○` 与 `已完成/总数`。Worker 不需要为每个 todo 变化调用状态上报，todo 全完成也不会自动结束任务，终态仍以 `task_completed`/`task_failed` 为准。
- 新建 Worker 会在当前主工作区下获得独立工作目录：派发时必须提供 `workspaceName`（英文小写短横线 slug，如 `daily-news`，正则 `^[a-z0-9][a-z0-9-]{0,79}$`；同名冲突自动递增 `-2`、`-3`）。复用已有子会话时继续使用原目录，无需再传。
- `dispatch` 一律后台派发，不阻塞主对话；需要了解进展时由 Lead 主动调用 `orchestrator_get` 查询。记忆整理等后台维护任务可设 `silent: true`：终态（含失败）完全不向主会话投递，Lead 不跟进，看板仍显示状态并带“静默”徽标。
- 完成、失败或被用户手动停止后通过持久 outbox 唤醒 Lead；`input_required` 由看板 + 子会话双入口问题卡承载，不唤醒主会话；改单接管和普通重启中断的旧任务不产生通知。
- **Worker 默认模型（设置页）**：在上述行“配置”中可从 DSH 实时模型目录选择 provider/model ID 与推理强度；默认留空并继承主会话。只影响新建 Worker；已有 Worker 保持原模型，目录明确标记原模型失效时才按“默认设置 → Lead 当前选择 → 全局默认”重选，不重建会话。
- **终态投递开关（设置页）**：插件管理 → 已安装 → `@cmjt/dsh-orchestrator` → 行“配置”，可按状态（completed / failed / interrupted）勾选是否向主会话投递终态消息；默认全部开启。input_required 不参与投递（问题卡只在看板 + 子会话渲染）。改动即时生效。投递只决定“消息是否唤醒主会话回应”：上报的状态与进展总是持久化，roster 与看板照常实时更新——这与 `silent` 的分界一致（silent 是整个会话不投，开关是按状态不投）。关闭期间产生的终态不补投。
- Lead 紧扣用户原始需求，以 Worker 的 `task.result` 为事实依据只输出结果，不补充子会话执行过程；`task.card` 围栏原封不动；`task.artifacts` 路径自动带工作区前缀并只用于 `present`，三者不重复输出。
- 定时/周期任务由 Worker 的 schedule 工具创建并绑定其自身子会话；Host 自动把 `schedule_create` 返回的 ID 关联到当前 Task（一个 Task 可关联多个）。到点后按消息中的 scheduleId 更新对应 Task，支持 running / input_required / completed / failed 全生命周期，不重复新增任务；批量定时消息的每次上报都必须传 scheduleId，未关联的来源才创建 ad-hoc Task。只有当前 Task 自己仍有活动 schedule 时，本轮未提交终态才保留 queued/running；其他 Task 的 schedule 不再阻止失败结算。Task 与会话时钟徽标都由原生活动 schedule 实时推导，删除后消失；DSH 侧栏标题不加图标前缀。
- 等待用户作答期间，手动停止、改单、工具取消和服务卸载会清理等待与原生问题卡；已取消卡片晚到的答案不会答入后续提问。
- 重启后恢复看板；普通未完成任务（queued / running / input_required）标记 interrupted，工作流回 idle；无法确认持久化状态时标记 failed 并带 runtime 原因；未投递的后台终态会重试唤醒 Lead。
- 日程变更整批完成归属和时间一致性校验后才开始写入，校验失败不写入任何日程；存储没有跨记录事务，I/O 失败仍可能部分落盘。

## Web 看板

在主会话 header 点击“任务看板”。右侧栏按子会话展示：

- **会话卡片**：状态徽标、静默 / 定时 / dsh-ui 卡片徽标、独立工作区名、任务时间线；支持折叠；折叠态保留问题卡与日程，运行中的会话高亮并带柔光扫过动效。任务新进入待操作时，看板未展开会自动打开并高亮目标会话与任务；已经查看看板时只高亮，不重复聚焦。completed 任务可展开查看卡片 JSON 预览。每轮任务脚注自动展示实际传入模型与上游返回模型（路由不一致时合并显示），不增加 Worker 上报负担。看板提供**会话 / 日程**双页签：日程页使用 FullCalendar Breezy 月历（周一起始、P0–P3 优先级色条、跨天连续展示与跨周续接、过期未完成置顶）；无 startAt 的待办集中在底部“未安排”分组，按优先级与创建时间排序，停留在日程页时任务更新会在会话页签亮起未读点，切回即清除。
- **用户日程框**：位于工作区行上方、折叠也显示；用户可画勾/取消（经 `setScheduleStatus` 持久化并让子会话在后续派发/工具结果中知情），已完成灰显划线保留，Worker 作废的日程带"已作废"胶囊不可勾；每条日程带优先级胶囊（P0 红 / P1 橙 / P2 黄 / P3 绿，默认 P3），时间窗/提醒时间渲染为胶囊（`remindAt` 是供 App 使用的元数据，本插件不据此发到点通知），点击日程行展开详情（备注/链接/附件/联系人/地点）。
- **任务框**：把多轮任务圈起来，默认只显示最新一轮，可展开全部。任务行含状态徽标、精简主题、实时步骤进度（✓/● 框选清单）、加粗 `header` + 一句话进展（运行中带扫光动效）、创建时间与实时耗时；“展开详情”含完整结果/错误、作答留痕、可点击打开的制品文件与同步状态。
- 点击“打开子会话”可查看完整子会话（Worker 是与主会话同级的一等会话）。除日程画勾和问题卡作答外看板只读。

会话页与日程页共用日程行，两页都显示 P0–P3 优先级胶囊。

## 分发安装

要求接收方已安装 DSH `0.2.1-rc.2` 或更高版本，并且使用 Web profile。

从私有源安装，记忆与 GenUI 插件随依赖自动安装并启用，无需单独添加：

```sh
dsh plugin --profile web add @cmjt/dsh-orchestrator --registry http://36.138.53.195:4873/
```

使用 GitHub Release tgz 安装时同样指定私有源，以便解析 `@cmjt` 依赖；若已有 `@cmjt:registry` 映射则可省略 `--registry`。普通 registry 依赖无需关闭 pnpm 安全校验。

记忆依赖固定为 `0.4.6`，GenUI 依赖固定为 `0.15.0`。orchestrator 不再捆绑 BrowserSkill、Computer Use 或 QQ 邮箱；需要这些能力时可另行安装对应插件，Worker 仍可使用后装工具。Lead 不再保留这些插件的工具名/前缀专门遮蔽，也不遮蔽 QQ 邮箱公告段。

如果旧版本曾单独执行 `dsh plugin --profile web add @changfenhuang/dsh-genui`，升级前先执行 `dsh plugin --profile web remove @changfenhuang/dsh-genui`，移除独立的 bundle 条目；orchestrator 会保留依赖并自行启用 GenUI，避免重复注册。

从旧 scope 升级，先备份并清理旧域（详见升级文档），再移除旧包、安装新包；不要同时启用两个 scope：

```sh
dsh plugin --profile web remove @may/dsh-orchestrator
dsh plugin --profile web add /absolute/path/to/cmjt-dsh-orchestrator-0.3.23.tgz --registry http://36.138.53.195:4873/
```

重新生成分发包：

```sh
pnpm install
pnpm pack:dist
```

tarball 只包含运行所需的 `lib/`、`cordis.patch.yml`、`genui-card-skill.md`、README、LICENSE 和 package metadata；不包含源码测试、source map、本机 `node_modules` 或开发仓库路径。

## 本地开发

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm verify:packaging
pnpm pack:dry
```

正式构建分发包后安装到本地 Web profile（必须使用 tgz 绝对路径，覆盖安装先 remove）：

```sh
dsh plugin --profile web remove @cmjt/dsh-orchestrator
dsh plugin --profile web add /absolute/path/to/cmjt-dsh-orchestrator-0.3.23.tgz
```

移除：

```sh
dsh plugin --profile web remove @cmjt/dsh-orchestrator
```

本机启动使用指定脚本，并通过 `start_new_session` 脱离命令会话；普通前台调用或 `nohup` 可能被回收：

```sh
uv run --no-project --python /usr/bin/python3 python -c 'import subprocess; subprocess.Popen(["/Users/lixuchuan/work/harness/start-dsh-web.sh", "--no-open"], start_new_session=True, stdin=subprocess.DEVNULL, stdout=open("/private/tmp/dsh-web.log", "ab"), stderr=subprocess.STDOUT)'
```

## 存储

插件使用 `storageDomain` 的 `orchestrator` v3 domain，采用 per-record 布局，位于 `~/.dsh/storages/orchestrator/`，包含 `conversations`、`tasks`、`schedules` 三张表。完整子会话 transcript 仍由 DSH Session 持久化保存，插件保存路由摘要、任务状态和日程。
