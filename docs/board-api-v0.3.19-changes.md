# v0.3.19 接口变化与升级说明

基线：已发布 v0.3.18。当前包名：`@cmjt/dsh-orchestrator@0.3.19`。完整字段定义见 [board-api.md](board-api.md)。

## 1. snapshot 字段变化（必须适配）

snapshot 顶层仍为 `{ conversations, tasks, schedules }`；三张表和状态枚举不变，Task 的结果字段拍平：

| v0.3.18 | v0.3.19 | 类型/语义 |
|---|---|---|
| `task.report.result` | `task.result` | string，可选；completed 的权威结果 |
| `task.report.artifacts` | `task.artifacts` | string[]，可选；子工作区相对路径 |
| `task.report.card` | `task.card` | JSON object，可选；dsh-ui 展示卡 |
| `task.fail.error` | `task.error` | string，可选；失败原因和尝试 |
| `task.fail.reasonCode` | `task.reasonCode` | 原枚举，可选；系统阻碍类别 |
| `task.report`、`task.fail` | 删除 | 无兼容别名，无旧字段输出 |

`header/progressNote/questions/answers/progressSteps/delivery` 及时间字段保持名称；`hasActiveSchedule` 仍仅在 Conversation 的 snapshot 投影出现，不落库。作答后后续进度/终态上报保留最近一组已答问题与答案；再次提问会清空前一组答案。

`input_required` 是同一 TaskRun 内的等待状态，保留 activeTaskId，不设置 endedAt，也不生成 delivery；用户作答后恢复 running。真正终态为 completed/failed/interrupted。

App 应改读顶层字段，更新生成的类型及校验 schema；不要只升级包而继续读取 report/fail。

## 2. Worker 工具变化

删除 `task_update`，无别名。公共 `header?`（最多 8 字）和 `progressNote?`（最多 500 字）仅属于四个任务状态工具。

```text
task_running
├─ header?: string
└─ progressNote?: string

task_input_required
├─ header?: string
├─ progressNote?: string
└─ questions: QuestionItem[]        必填，1–10；阻塞直到用户作答

task_completed
├─ header?: string
├─ progressNote?: string
├─ result: string                  必填
├─ artifacts?: string[]
└─ card?: object                   ≤16384 UTF-8 字节，禁止三反引号

task_failed
├─ header?: string
├─ progressNote?: string
├─ error: string                   必填
└─ reasonCode?: 原系统阻碍枚举

task_schedule
├─ create?: ScheduleNew[]          title 必填
└─ update?: ScheduleUpdate[]       id 必填
```

- task_completed/task_failed 提交成功后 concludeTurn，本轮不再推理。
- task_input_required 返回 `{ok:true,status:"input_required_answered",answers:[{id,selected,custom?}]}`；看板与 Worker 原生卡两处作答，先答先赢，另一处同步消失。主会话不承载问题卡。
- running/completed/failed 返回 `{ok:true,status,schedules:[{id,title,status,priority}]}`；task_schedule 返回 `{ok:true,schedules:[…]}`。日程不再嵌入任务上报，也不改变任务状态。
- card/artifacts/result 均位于 task_completed 顶层，不再放 report。

## 3. RPC 与包身份

| 项目 | 变化 |
|---|---|
| npm 包 | `@may/dsh-orchestrator` → `@cmjt/dsh-orchestrator` |
| typert 包与 descriptor 前缀 | `@cmjt/dsh-orchestrator#orchestrator/` |
| 方法路径 | 仍为 `orchestrator/snapshot`、`orchestrator/setScheduleStatus`、`orchestrator/answerTaskQuestions` |
| RPC 请求 | 均不变 |
| 日程勾选/问题作答响应 | 不变 |
| snapshot 响应 | 顶层三数组不变，Task 字段按上表适配 |
| Agent preset ID / Cordis 行 ID | 保留 `may-orchestrator-lead/worker`、`may-dsh-orchestrator`，不是旧 npm 包依赖 |

## 4. 破坏性升级

存储域升至 **v3**，删除 migrateRecord 与 compatibleVersions。v1/v2 的 Conversation/Task/Schedule 不加载、不迁移；旧会话映射与旧 ID 不能继续使用。原 DSH transcript 不由本包删除。

1. 停止派发和执行，记录旧 Worker 列表，停用其绑定的 DSH 宿主定时任务。宿主定时任务存储独立，不会随看板域自动停用；需要的任务在新会话重建。
2. 停止 Web。备份并移出当前 DSH 数据根的 `storages/orchestrator/`，以及存在时的历史 `storages/orchestrator.json`。默认数据根是 `~/.dsh`，设置 DSH_HOME 时使用实际目录。不要仅修改旧域版本戳。
3. 移除旧 `@may/dsh-orchestrator`，安装新 scope；不要同时启用两个包。
4. 重启 Web，新建 Lead/Worker 会话；按新字段更新下游 App，再验证进度、问题作答、结果、日程勾选。

```sh
dsh plugin --profile web remove @may/dsh-orchestrator
dsh plugin --profile web add @cmjt/dsh-orchestrator@0.3.19 --registry http://36.138.53.195:4873/
```

## 5. 记忆与提醒边界

记忆替换为 `@cmjt/dsh-personal-memory`，依赖声明使用 latest；发布时解析为 0.4.5。Lead 保留原生 memory_search/read，禁写、反思及自动整理；Worker 使用完整原生能力。门控由记忆插件原生接口解析其有效 projectDir/homeDir，orchestrator 不直接打开数据库，不再创建工作区记忆链接；旧记忆文件保留。

私有源 memory 0.4.5 的客户端模块 ID 与 scoped 包名不一致，可能导致记忆管理 UI 加载失败；后端 API 不受该模块注册问题影响。[上游 issue #1](https://github.com/friendllcc/dsh-personal-memory/issues/1) 已反馈。我们不改写第三方包；latest 修复后需重新安装/更新依赖，已安装的锁定依赖不会自动更新。

`remindAt` 只持久化供 App 使用的通知时间；本插件不会据此自动发送提醒。需要 Agent 到点执行并上报时使用 DSH 原生定时任务。
