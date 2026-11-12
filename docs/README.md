# 文档索引

当前版本 **0.3.22**，包名 `@cmjt/dsh-orchestrator`。本版 snapshot 任务字段拍平，不兼容旧会话与旧看板存储。

## 当前文档

| 文档 | 用途 |
|---|---|
| [README](../README.md) | 产品能力、预设、安装与开发入口 |
| [AGENTS](../AGENTS.md) | 环境约束、模块职责、状态机、工具策略与开发门禁 |
| [看板数据接口](board-api.md) | snapshot、日程勾选、问题作答 RPC 及字段契约；含全部字段与状态定义 |
| [投递机制](delivery-to-lead.md) | 当前 followup / outbox 与同轮作答链路，附平台 API 调研 |
| [GenUI 卡片规范](../genui-card-skill.md) | 随包加载的 Worker 运行时文档，规定 task_completed 的 card 展示通道与组件 |
| [看板展示设计稿](board-showcase-v0315.html) | 静态 UI 设计稿，含任务模型来源、路由差异与折叠态展示 |
| [0.3.22 接口差异](board-api-v0.3.22-changes.md) | 定时轮次的任务生命周期与兼容边界 |
| [0.3.22 发布记录](milestones/0.3.22.md) | 活动定时任务跨轮次继续与误判失败修复 |
| [0.3.21 接口差异](board-api-v0.3.21-changes.md) | Task 模型元数据、Worker 默认模型、配置与依赖变化 |
| [0.3.21 发布记录](milestones/0.3.21.md) | 路由提示、模型配置、日程引导与看板模型来源 |
| [0.3.20 接口差异](board-api-v0.3.20-changes.md) | 相对 0.3.19 的接口兼容确认与输出行为变化 |
| [0.3.20 发布记录](milestones/0.3.20.md) | 制品交付、输出规范与真实任务验收 |
| [0.3.19 接口差异](board-api-v0.3.19-changes.md) | 下游字段映射、scope 更名、破坏性升级步骤 |
| [0.3.19 发布记录](milestones/0.3.19.md) | 重构、回归与已知依赖问题 |
| [0.3.18 里程碑](milestones/0.3.18.md) | A–D、B1–B5 的最终变更、清理统计、门禁和验证边界 |
| [TODO](../TODO.md) | 当前未处理机会与原始历史方案、验收记录 |

## 历史设计

以下 HTML 是静态设计稿，保留当时布局与样例数据；不代表当前组件或 RPC 契约，也不接真实后端。

- [日程看板设计稿](board-schedule-mock.html)

历史版本记录保留原文；当前接口以 board-api.md 与源码 schema 为准，当前模块归属以 AGENTS.md 为准。
