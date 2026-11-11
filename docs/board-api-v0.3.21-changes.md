# v0.3.21 接口变化说明

基线：已发布 v0.3.20。当前包名：`@cmjt/dsh-orchestrator@0.3.21`。完整字段定义见 [board-api.md](board-api.md)。

## 结论

本版为 **Task 可选字段新增 + 配置与依赖调整**：snapshot/RPC 方法不变，存储继续使用 domain v3，Worker 的 5 个 `task_*` 工具名称及输入字段不变。下游可忽略新增模型元数据，无需修改既有请求。

## Snapshot / Task

Task 新增两个 Host 生成的只读可选字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| requestedModel | string? | 本轮最后一次推理实际传入的模型 ID |
| responseModel | string? | 本轮最后一次推理的上游返回模型 ID，用于识别网关路由 |

- 数据来自 DSH `assistant/message`，不属于任何 `task_*` 工具输入，Worker 无需上报。
- 看板在 `responseModel` 非空且不同于 `requestedModel` 时显示 `requestedModel-responseModel`；否则只显示 `requestedModel`；旧任务或尚无模型响应时不展示。
- Conversation、Schedule、QuestionItem 等其他结构不变；`orchestrator/snapshot`、`setScheduleStatus`、`answerTaskQuestions` 的方法名、请求和响应不变。

## 配置变化

插件行“配置”新增 Worker 默认模型设置：

| 配置 | 类型 / 默认值 | 行为 |
|---|---|---|
| workerProvider | string / `''` | 默认 provider；与 workerModel 同时非空才生效 |
| workerModel | string / `''` | 默认 model ID；留空继承 Lead 当前选择 |
| workerReasoningEffort | string / `''` | 推理强度；留空使用模型默认值 |

三个配置均为 volatile，保存后即时生效。新 Worker 优先使用目录中可用的默认设置，否则沿用 Lead pending 选择 → 最近请求头 → 全局默认；已有 Worker 保持原模型，仅在目录明确标记原模型失效时重选，目录查询失败不切换，也不重建会话。

原 `deliverOnCompleted / deliverOnFailed / deliverOnInterrupted` 开关语义不变。

## Worker 工具与输出行为

- `task_running / task_input_required / task_completed / task_failed / task_schedule` 的输入字段均未增删。
- `task_schedule` 强化事件时间引导：按事件尽量填全 `startAt / endAt / remindAt`；结束时间未明确时可按事件类型估计，提醒提前量按准备成本和重要程度选择。`remindAt` 仍只是 App 元数据，本插件不据此自动提醒。
- Lead roster 改为实时展示当前/最近需求、任务状态、进展/结果、更新时间与日程摘要，不再读取 `outline.summary` 主题链；动态内容关闭 prompt 插值，`{{...}}` 按原文显示。
- Lead 派发指南进一步明确同事项复用、不同事项新建、静默维护和卡片围栏输出规则；这些变化不修改 RPC 或存储契约。

## 依赖与 bundle 变化

- 新增普通依赖 `@changfenhuang/dsh-genui@0.15.0`，随包安装并由 orchestrator bundle 默认启用。
- 移除 `@wxg-prc-cpg/browser-skill-dsh-plugin`、`@zhengjunyao/dsh-qqmail`、`@milkuovo/dsh-computer-use` 及 vendored macOS Computer Use 驱动；需要这些能力时改为自行安装对应插件。
- Lead 不再保留上述已解绑插件的工具名/前缀专门遮蔽及 QQ 邮箱公告段遮蔽；个人记忆写/管理与 GenUI 直接渲染工具仍隐藏。Worker 的工具黑名单和任务协议不变。
- `@cmjt/dsh-personal-memory` 仍固定为 `0.4.6`。

若旧 profile 曾独立安装 `@changfenhuang/dsh-genui`，升级前先移除该独立 bundle 条目，再由 orchestrator 依赖启用，避免重复注册。

## 兼容边界

- 存储仍为 domain v3；v0.3.19 起的不兼容旧会话与旧看板数据规则不变。由 v0.3.18 或更早版本升级时，仍须按 [v0.3.19 升级说明](board-api-v0.3.19-changes.md) 备份旧域并新建会话。
- Task 新字段均为可选，旧记录无需迁移；模型元数据只描述本轮最后一次推理，不回填历史任务。

## 安装

```bash
dsh plugin --profile web add @cmjt/dsh-orchestrator@0.3.21 --registry http://36.138.53.195:4873/
```

也可下载 GitHub Release 中已编译的 `cmjt-dsh-orchestrator-0.3.21.tgz` 安装。GitHub 自动源码归档不含 `lib/`，不能作为插件构建产物使用。
