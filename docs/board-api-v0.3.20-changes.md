# v0.3.20 接口变化说明

基线：已发布 v0.3.19。当前包名：`@cmjt/dsh-orchestrator@0.3.20`。完整字段定义见 [board-api.md](board-api.md)。

## 结论

**snapshot、RPC、Worker 工具 schema 与存储结构均无变化，下游无需修改字段映射或请求代码。**

- `Snapshot`、Conversation、Task、Schedule、QuestionItem 等结构保持 v0.3.19 定义。
- `orchestrator/snapshot`、`orchestrator/setScheduleStatus`、`orchestrator/answerTaskQuestions` 的方法名、请求和响应不变。
- 存储继续使用 domain v3；v0.3.19 的不兼容旧会话规则不变。由 v0.3.18 或更早版本升级时，仍须按 [v0.3.19 升级说明](board-api-v0.3.19-changes.md) 备份旧域并新建会话。

## 输出行为变化

以下变化只影响 Worker 上报内容约定和 Lead 的最终回复，不改变看板数据契约：

- Lead 恢复 `present` 制品交付能力及制品文件引用提示。`task.artifacts` 中的关键文件会在主会话生成可点击、可预览的制品卡，不再只显示路径文本。
- `task.result` 只写简短结论，不写文件路径或实现细节；`task.card` 承载结构化明细；`task.artifacts` 只列用户需要打开的关键制品。
- Lead 对 `result` 按输出规范精简表达；`task.card` 序列化后的 `dsh-ui` 围栏仍须原封不动输出；制品通过 `present` 交付，正文不列路径。
- 正文、卡片和制品三者不得重复承载同一信息。

## 安装

```bash
dsh plugin --profile web add @cmjt/dsh-orchestrator@0.3.20 --registry http://36.138.53.195:4873/
```

也可下载 GitHub Release 中已编译的 `cmjt-dsh-orchestrator-0.3.20.tgz` 安装。GitHub 自动源码归档不含 `lib/`，不能作为插件构建产物使用。
