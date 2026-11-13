# v0.3.24 接口差异

基线：**v0.3.23**。本文只列本版变化；完整字段以 [board-api.md](board-api.md) 为准。

## 结论

本版升级看板日程视图，统一 Worker 待办工具命名，并允许手动禁用个人记忆插件。存储继续使用 domain v3，看板 snapshot 与三个 RPC 的方法、请求和响应结构不变；**Worker 模型工具协议有更名，不保留旧工具别名**。

## Worker 待办工具协议

- `task_schedule` 更名为 `task_todo`，输入仍为 `{ create?: ScheduleNew[], update?: ScheduleUpdate[] }`，日程字段、时间解析和校验规则不变。
- `task_todo` 与四个状态上报工具的返回清单字段由 `schedules` 更名为 `todos`，每项仍只包含 `id / title / status / priority`。
- Lead 的 `orchestrator_get` 返回的工作流摘要中，待办清单字段同步由 `schedules` 更名为 `todos`。
- Worker 提示词与投递附言统一使用 `task_todo` 和 `todos`，避免模型继续引用旧工具或旧字段。
- Host 内部 schema / DSL 同步更名为 `taskTodoInputSchema` / `TASK_TODO_TOOL_PARAMETERS`；这些实现符号不是下游 RPC。

## 看板 snapshot 与存储保持不变

- `Snapshot.schedules`、`ScheduleRecord`、`TaskRecord` 和 `ConversationRecord` 的结构不变。
- `snapshot`、`setScheduleStatus`、`answerTaskQuestions` 三个 RPC 的 typert 路径、请求和响应不变。
- 存储目录仍为 `~/.dsh/storages/orchestrator/`，domain 仍为 v3，无需迁移或清理日程数据。
- 看板 RPC 中的 `schedules` 不要随 Worker 工具返回值机械改名；只有模型可见的工具返回清单使用 `todos`。

## 日程看板

- 月历迁移到 FullCalendar 7.1.5 的 Breezy / Indigo 主题，保留周一起始、上月 / 今天 / 下月导航和选中日列表。
- P0–P3 日程以色条展示；跨天事项连续显示，跨周自动续接，全天 `endAt` 继续按协议中的包含式尾日转换为 FullCalendar 的排他尾日。
- 无 `startAt` 且未作废的待办进入底部“未安排”分组，按优先级及创建时间排序；选中日列表继续置顶已过期未完成事项。
- 停留在日程页时，任务更新仍在会话页签显示未读点；再次点击主会话“任务看板”按钮会切回会话页。
- 月历、会话页和日程页继续共用同一个 snapshot，不改变数据刷新与勾选 RPC。

## 个人记忆插件禁用降级

- 手动禁用 `@cmjt/dsh-personal-memory` 后，宿主对门控路由返回 404 / 405 空响应时，Lead 跳过门控并正常推理，不再把空响应解析为 JSON 错误。
- Lead 的长期记忆提示只在插件可用且只读门控建立后注入；禁用时不宣称拥有 `memory_search / memory_read` 或记忆维护能力。
- 插件存在但返回错误、无效 JSON 或门控持续失败时仍 fail-closed，在推理前重试并阻止未建立只读策略的请求。
- 重新启用插件并重启 Web 后恢复只读策略与记忆提示；运行中的已禁用 Lead 会话不动态探测插件重新启用。

## 依赖与升级边界

- 新增普通依赖 `@fullcalendar/react@7.1.5`、`temporal-polyfill@1.0.7`；日历代码、样式和对应 MIT 许可证随发布包分发。
- 客户端继续由宿主注入 React / React DOM，DSH 要求保持 `0.2.1-rc.2` 或更高版本及 Web profile。
- 升级前让旧 Worker 的活动任务完成或停止；升级后新建 Lead / Worker 会话，避免旧上下文继续调用已删除的 `task_schedule`。
- v0.3.19 之前的旧域升级边界不变，仍须按 [v0.3.19 升级说明](board-api-v0.3.19-changes.md) 备份并新建会话。

## 安装

```bash
dsh plugin --profile web add @cmjt/dsh-orchestrator@0.3.24 --registry http://36.138.53.195:4873/
```

也可下载 GitHub Release 中已编译的 `cmjt-dsh-orchestrator-0.3.24.tgz` 安装。GitHub 自动源码归档不含 `lib/`，不能作为插件构建产物使用。
