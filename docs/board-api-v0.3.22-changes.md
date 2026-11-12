# v0.3.22 接口变化说明

基线：已发布 v0.3.21。当前包名：`@cmjt/dsh-orchestrator@0.3.22`。完整字段定义见 [board-api.md](board-api.md)。

## 结论

本版仅修复**活动定时任务跨轮次执行时的生命周期判定**：snapshot/RPC、Worker 的 5 个 `task_*` 工具输入、存储 domain v3 和全部记录字段均不变，下游无需修改请求或字段映射。

## 定时轮次的任务结算

Worker 轮次结束但 queued/running Task 尚未提交 `completed / failed / interrupted` 时，Host 现在实时查询该 Worker 子会话的原生活动定时任务：

- 仍有活动定时任务：保留 Task 当前状态和 `Conversation.activeTaskId`，不生成失败结果、不投递终态通知，等待后续定时轮次继续上报。
- 没有活动定时任务：沿用原规则，将 Task 判为 `failed`，错误为“子会话结束前未提交终态上报”（queued 任务仍使用“子会话在任务开始前结束”）。
- 定时任务服务不可用或查询失败：沿用原失败结算规则，不让任务无限停留在 running/queued。
- `input_required`：阻塞工具调用不能转移到后续轮次；轮次结束时仍按原规则结算为 `failed`，取消等待 Promise 并清理原生问题卡，不因存在定时任务而保留。
- 用户手动停止与改单中断：优先级不变，仍分别结算为 `interrupted`，不会因存在定时任务而继续等待。
- 没有活动 Task 的定时触发轮次：行为不变，仍只允许 `task_completed`，并生成独立的 ad-hoc 已完成 Task。

该变化只影响 Host 内部结算时机，不新增 Task 状态，也不改变看板字段或终态投递协议。

## 兼容边界

- snapshot 的 Conversation/Task/Schedule 结构及三个 RPC 方法不变。
- Worker 工具名称、输入字段与日程数据契约不变，存储继续使用 domain v3，旧记录无需迁移。
- 重启恢复规则不变：重启前遗留的 queued/running/input_required 任务仍转为 `interrupted`，不会因定时任务而自动续跑。
- v0.3.19 起的不兼容旧会话与旧看板数据规则不变；从 v0.3.18 或更早版本升级时，仍须按 [v0.3.19 升级说明](board-api-v0.3.19-changes.md) 备份旧域并新建会话。

## 安装

```bash
dsh plugin --profile web add @cmjt/dsh-orchestrator@0.3.22 --registry http://36.138.53.195:4873/
```

也可下载 GitHub Release 中已编译的 `cmjt-dsh-orchestrator-0.3.22.tgz` 安装。GitHub 自动源码归档不含 `lib/`，不能作为插件构建产物使用。
