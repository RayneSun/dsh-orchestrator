# 文档索引

当前版本 **0.3.24**，包名 `@cmjt/dsh-orchestrator`。本版升级 FullCalendar 日程视图、统一 `task_todo` 工具协议，并兼容个人记忆插件禁用状态。

工作区另有尚未发布的 Lead 上下文与通用 Worker 模式改造，实施范围与验证边界见下表中的改造记录。

## 当前文档

| 文档 | 用途 |
|---|---|
| [README](../README.md) | 产品能力、预设、安装与开发入口 |
| [AGENTS](../AGENTS.md) | 环境约束、模块职责、状态机、工具策略与开发门禁 |
| [看板数据接口](board-api.md) | snapshot、日程勾选、问题作答 RPC 及字段契约；含全部字段与状态定义 |
| [GenUI 卡片规范](../genui-card-skill.md) | 随包加载的 Worker 运行时文档，规定 task_completed 的 card 展示通道与组件 |
| [看板交互设计稿](board-schedule-mock.html) | 会话 / 日程双页、待操作入口、两图直选与三图整体评价弹窗；静态数据，不接后端 |
| [看板全字段展示](board-showcase.html) | 各任务/日程状态、Snapshot 字段示例、五个远程方法与字段映射；静态数据，不接后端 |
| [0.3.24 发布记录](milestones/0.3.24.md) | 日历交互升级、待办工具更名与记忆能力按可用性注入 |
| [0.3.23 发布记录](milestones/0.3.23.md) | 定时多轮上报、待操作提醒与 Lead/Worker 提示优化 |
| [0.3.22 发布记录](milestones/0.3.22.md) | 活动定时任务跨轮次继续与误判失败修复 |
| [0.3.21 发布记录](milestones/0.3.21.md) | 路由提示、模型配置、日程引导与看板模型来源 |
| [0.3.20 发布记录](milestones/0.3.20.md) | 制品交付、输出规范与真实任务验收 |
| [0.3.19 发布记录](milestones/0.3.19.md) | 重构、回归与已知依赖问题 |
| [0.3.18 里程碑](milestones/0.3.18.md) | A–D、B1–B5 的最终变更、清理统计、门禁和验证边界 |
| [Lead 上下文改造记录](lead-context-refactor.md) | 当前未发布实现、真实工具面测试与隔离边界 |
| [改造前提示词快照](prompt-snapshots/0.3.24-before-lead-refactor.md) | Lead / 记忆纪律 / Worker 原始提示全文，不参与运行时 |
| [TODO](../TODO.md) | 本次实施状态、验收证据与延期项（PPT 暂不实施） |

两份 HTML 展示当前方案的交互与字段，但均为**静态示例**，不代表实时任务数据。下游接口以 [board-api.md](board-api.md) 和源码 schema 为准；历史版本记录保留原文。
