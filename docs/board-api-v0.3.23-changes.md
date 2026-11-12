# v0.3.23 接口变化说明

基线：已发布 v0.3.22。当前包名：`@cmjt/dsh-orchestrator@0.3.23`。完整字段定义见 [board-api.md](board-api.md)。

## 结论

本版为 **Task 定时关联字段新增、Worker 状态工具输入扩展与问题作答路由增强**。存储继续使用 domain v3；旧 Task 缺少新字段时按默认值读取，无需迁移。下游需要识别新的定时关联字段；批量定时消息的 Worker 上报必须携带 `scheduleId`。

## Snapshot / Task

Task 新增字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| scheduleIds | string[] | 当前 Task 创建或关联过的原生 schedule ID；默认 `[]`，删除 schedule 后仍保留历史关联 |
| lastScheduleId | string? | 最近一次定时上报的来源 schedule ID |
| hasActiveSchedule | boolean | snapshot 专用投影；自己的 `scheduleIds` 与原生活动 schedule 相交时为 true，否则明确为 false，不落库 |

Conversation 的 `hasActiveSchedule` 也由可选字段改为始终明确返回 boolean：任一原生活动 schedule 为 true，否则为 false。两个 snapshot schema 在输入缺省时均补 false；持久化 Conversation/Task 不接收该投影字段。

旧 `scheduled?: boolean` 仅保留历史读取兼容，不再新增写入，也不驱动看板时钟。

## 定时关联与状态上报

- Host 配对原生 `schedule_create` 的 `tool/call → tool/result`，把真实 schedule ID 关联到当前 Task；一个 Task 可关联多个 schedule。
- `task_running / task_input_required / task_completed / task_failed` 均新增可选 `scheduleId`。单条定时消息可省略，由 Host 自动补全；批量消息必须显式携带当前批次内的 ID，`task_schedule` 不变。
- 同一 schedule 再次触发时复用并重开原 Task，覆盖上一轮结果、问题、答案和步骤，不重复新增 Task；只有找不到关联来源时才创建 ad-hoc Task。
- 更新某个定时 Task 不会结算同会话另一个 activeTask；批量轮次允许逐条上报，唯一阻塞提问在轮次结束时仍会清理，其他运行任务不受影响。
- 终态 outbox 按开始投递时的 Task.revision 回写；旧投递的成功或失败结果不会覆盖更新后的 pending，最新结果会继续投递。

## answerTaskQuestions

请求新增可选 `taskId`：

```ts
{
  childSessionId: string
  taskId?: string
  answers: QuestionAnswer[]
}
```

定时 Task 与另一个 activeTask 并存时，客户端应显式传 `taskId`，确保作答路由到正确问题。旧客户端省略时仍回退 `Conversation.lastTaskId`；成功响应继续返回 `{ ok: true, taskId }`。

## Web 与提示词行为

- 任务新进入 `input_required` 时，看板未展开会自动打开并高亮目标会话和任务；看板已经可见时不重复聚焦。
- Worker 需要咨询用户时必须调用阻塞的 `task_input_required`，禁止只在正文提问后结束。
- Lead 的派发参数与提示词收敛为只传需求和验收点；新增 Worker 实际工具/Skill 能力索引用于路由判断，不新增 RPC 或模型工具。

## 兼容边界

- snapshot 与三个 RPC 的方法名不变，存储继续使用 domain v3，旧记录无需迁移。
- `scheduleIds` 缺省按 `[]` 读取；不关联旧 `scheduled` 标记，避免把历史 ad-hoc 任务误绑到原生 schedule。
- 重启恢复仍会把遗留 queued/running/input_required 任务转为 interrupted，不自动恢复执行。
- v0.3.19 起的不兼容旧会话与旧看板数据规则不变；从 v0.3.18 或更早版本升级时，仍须按 [v0.3.19 升级说明](board-api-v0.3.19-changes.md) 备份旧域并新建会话。

## 安装

```bash
dsh plugin --profile web add @cmjt/dsh-orchestrator@0.3.23 --registry http://36.138.53.195:4873/
```

也可下载 GitHub Release 中已编译的 `cmjt-dsh-orchestrator-0.3.23.tgz` 安装。GitHub 自动源码归档不含 `lib/`，不能作为插件构建产物使用。
