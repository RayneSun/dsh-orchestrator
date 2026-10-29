# TODO

## 自进化技能库（方案已确认方向，待实施）

参考 dsh-ciri 的 SkillProvider 模式（`/Users/lixuchuan/Documents/deepseek-harness/development/dsh-ciri`，只读参考、不改动它）。

1. **技能库位置**：主工作区 `skills/`（与 `.dsh-meow` 记忆库同层），落盘即保存，无 git。结构：`skills/<名称>/SKILL.md`（frontmatter: name/description/whenToUse + 何时用/怎么用）+ 可选 `scripts/`（复杂步骤沉淀为可执行脚本，SKILL.md 只教调用）+ 根放 `README.md` 说明格式。
2. **发现机制**（新模块 `src/skills.ts`）：服务激活时 `ctx.inject(['skills'])` 注册 SkillProvider（rank 300 与 CUSTOM_RANK 一致），扫描 `skills/*/SKILL.md` 解析 frontmatter；`fs.watch` 防抖 500ms invalidate，新技能落盘即生效；skills 服务缺失时降级无操作；启动幂等建目录 + 放 README.md（只补缺不覆盖）。
3. **Worker 访问**：Worker 文件作用域在子工作区，复用 `ensureSharedMemoryLink()` 同款为每个 Worker 子工作区建 `skills` 符号链接（win32 用 junction）指向主工作区 `skills/`。
4. **工具面**：Worker 预设已有 `tool-skill`；Lead 预设补挂 `tool-skill`。
5. **自进化协议（prompt）**：WORKER_PROMPT 加"技能沉淀"节——流程第二次出现或一次任务多步才走通的复杂操作，收尾时沉淀为技能；代码落 `scripts/` 不抄进文档；一次性的不沉淀，结论/事实仍写 memory 不双写。LEAD_PROMPT 加一句：用户说"以后都这样处理"时派发 Worker 沉淀技能。
6. **种子技能**：不带，只放 README.md。
7. **测试**：frontmatter 解析/扫描/provider list-get/watch 降级单测；skills 链接复用 memory link 测试模式；装包实测 Worker 沉淀技能后 Lead 新会话可调用。

## v0.3.14：状态收缩 + 问题卡 + 看板重构（代码已实施，未 commit，待用户验收）

> UI 已按 `~/.codex/visualizations/2026/10/28/01a18123-5b41-7e41-b9b0-88d4cdcac2f0/board-ui-v3-mock.html` 定稿；投递机制调研见 `docs/delivery-to-lead.md`；接口文档（含收缩后协议）在 `docs/board-api-v0.3.13-full.md`（§6.1 树状图）。
> ⚠️ 实施前先处理 stash@{0}（自进化技能库，同样改 types/service/messages，直接 pop 会冲突）：先完成本批次或先落 stash，二选一，避免双线改同文件。

### 1. Status 收缩（Worker 协议 5 → 4）

- `taskUpdateStatuses` = `running / input_required / completed / failed`；`blocked` 枚举删除
- `failed` 字段改为 `fail: { error ★, reasonCode? }`（与 report 对称）；`remediation` 删除；`blockReasonCodes` 6 类保留挂 fail.reasonCode
- 存量迁移（types.ts read 迁移）：旧 blocked → failed+reasonCode；旧平铺 error/reasonCode → fail 对象；旧 remediation 拼进 error 尾部 `\n建议：…`
- superRefine：completed→report 必填；input_required→questions 必填；failed→fail 必填（无 reasonCode 不带建议类字段）；白名单外字段报错带路径
- `DeliveryToggles`：blocked 档并进 failed 档；**inputRequired 默认改 false**（三处问题卡已覆盖可见性）
- input_required 命名**保留不改**（与 ConversationState/平台同词）；UI 文案统一"待你操作"
- 公共字段（全状态可选）：`header?`（≤8 字粗体标题）、`progressNote?`（≤80 字，**保留原名不改 detail**）、`userTodos?`（全状态开放）
- `summary` 字段删除；`conv.outline.summary` 改由 Host 自动维护 = 历次 dispatch subject 拼接（保留最近 3~5 个），roster 摘要行照常

### 2. QuestionItem 问卷 + 三处同源问题卡

```
questions: QuestionItem[]   ★ input_required 必填（纯 question 字符串字段删除）
└── { id?(Host 补 q1/q2/…，返回值回显), question ★, header?, detail?,
     options?: [{label ★, description?}], multiSelect? }
```

- 数据源：TaskRecord.questions（新增字段）；存量 question → questions:[{id:'q1',question}]
- **三处渲染，一个数据源**：
  1. **看板问题卡**（位于待办框上方，warn 色框）：选项 chip（单选切换/多选叠加）+ 自定义输入 + 提交 → 新 RPC `answerTaskQuestions({taskId, answers})`
  2. **Worker 子会话工具行卡**：client 注册 `tool.call.toolview` keyed `task_update`（机制已验证：dsh-client-ui-tool 同款 ask-question-row），从调用参数渲染，作答走同一 RPC；非 activeTask 的历史行禁用交互
  3. **主会话原生卡**（投递开时）：Host 调 `ctx.userQuestions.ask({questions, agent: leadAgent})`——平台原生 ask_user_question 卡渲染在 Lead 聊天、零模型推理，答案 resolve 回 Host
- 作答路由：`answerTaskQuestions` 与原生卡 resolve 汇入同一路径——串行幂等（状态检查，先答先赢）→ task 转 running 新 TaskRun（followup Worker 带结构化答复）→ 给 Lead 日志 `session.append` 不唤醒备忘（防重复转派）
- 已知限制（接受）：程序化 ask 不进 userQuestions 投影，主聊天卡刷新/重启后不可恢复（看板/子会话卡不受影响）
- 主会话打字回答链路保持：Lead 被唤醒（prefix 带通知+答复）→ 派发答复（转述格式 `[q1] 选了 xxx`）

### 3. 看板 UI 重构（按定稿 mock）

会话卡片自上而下：会话头（chevron+属性图标🚫/⏰+subject+状态徽标+打开按钮）→ ask 卡 → 待办框（可独立折叠，**会话折叠也恒显**）→ 工作区行 → **任务框**（圈住多轮，框头"N 轮·显示最新"，默认折叠只显示最新一轮，可展开全部）
- 多轮：新→旧；轮内 = 状态徽标+subject+expander → `header: progressNote` 行（running shimmer；input_required 无动画）→ 步骤框（todo_write）→ 展开区（结果/错误+制品+同步时间）→ 脚注（创建时间+耗时，running 实时）
- 状态展示映射（App 同款 4 态）：进行中=queued+running；待你操作=input_required；已完成=completed；失败/停止=failed+interrupted
- 会话头徽标跟随最新一轮

### 4. 连带改动

- **提示词**：Lead——4 态、fail 对象、看板/原生卡已答复场景、转述格式、无 summary；Worker——questions 示例、fail 示例、header/progressNote、删 summary/task 教程类表述；task_update 描述只写能力
- **文档**：README/AGENTS.md 协议同步；`docs/board-api-v0.3.13-full.md` 更新为新协议后随 release 出 `dsh-orchestrator-board-api-v0.3.14-changes.md`（破坏性变更清单：blocked→fail、question→questions、title→header、summary 删、inputRequired 默认反转、新 RPC）
- **`docs/delivery-to-lead.md`** 补一段"已实施"结论（input_required 走原生卡，不再用 append 文本通知——按最终实施为准修订）

### 5. 测试与验收

- 单测：迁移三件套（blocked→fail、字段改名、question→questions）；fail superRefine；questions 校验+id 回显；answerTaskQuestions 幂等路由（先答先赢/后答拒绝/Lead 备忘）；outline 自动拼接；现有用例回归
- 门禁：tsc×2、vitest、tsdown、verify:packaging
- E2E（装 web profile 重启，重点实测）：主聊天原生卡真实渲染与结算；三处作答互斥；看板新层级（任务框折叠/会话折叠/待办恒显）；静默任务的看板+子会话双卡；重启恢复
- 发版：commit → tag v0.3.14 → release（tgz + 变更 md），需网络时代理 127.0.0.1:7892

### 决策记录

- input_required 不改名（平台一致性）；progressNote 不改名 detail（用户裁定，避免与 QuestionItem.detail 歧义）
- Worker 会话问题卡若 toolview 注册实测失败：降级为非交互提示行，交互收敛看板（不阻塞本批次）
- 用户Todos 全状态开放的场景兜底：failed 时也可留"需用户本人确认"的待办


## v0.3.14 实施验收记录（2026-10-28）

- 已过门禁：tsc(host/client)、vitest 94/94、tsdown、verify:packaging。
- 已装 web profile 重启实测：普通后台任务 running→completed；问题卡从 input_required 到看板作答后恢复 running，答案注入 Worker；userTodos.create 创建成功；用户画勾走 setTodoStatus 并显示完成。
- 实测发现并修复：`answerTaskQuestions` 未手动 markRemote 导致 RPC 404；task_update 工具描述补充 userTodos 必须顶层。
- Worker 上下文确认：子会话 cwd 正确指向 `/Users/lixuchuan/Documents/deepseek-harness/assistant/<workspaceName>`，sandbox/approval 为 danger-full-access/never，投递与作答注入文本均落 transcript。
- 文档已同步：README/AGENTS 协议；docs/board-api-v0.3.13-full.md 改为 v0.3.14 收缩协议；docs/delivery-to-lead.md 记录当前 input_required 链路。

## v0.3.14 最终实施（2026-10-29）

### input_required 阻塞工具调用（本轮核心改动）

- `task_update(input_required)` 改为阻塞工具调用：Worker 调用后 Promise 挂起不返回，用户作答后工具直接返回 `{ answers: [{ id, selected, custom? }] }`，Worker 同轮继续执行（不开新轮、不注入消息）。
- 问题卡只在两处渲染：
  1. **子会话**：对 Worker 会话（live root）挂 `ctx.userQuestions.ask()`，平台原生 ask_user_question 卡。
  2. **任务看板**：自定义 AskCard（已有）。
- **主会话完全不参与**：`deliveryToggles.inputRequired` 硬编码 `false`；`deliverOnInputRequired` 配置项和设置页开关均已删除；无 Lead 侧 ask、无 text notice。
- 一处作答、另一处自动消失：看板作答 → `resolvePendingAnswers` → abort Worker 的 ask（原生卡清理）→ Promise resolve；Worker 原生卡作答 → `ask()` resolve → `answerTaskQuestions` → `resolvePendingAnswers` → 看板卡消失（下次渲染无 input_required 任务）。
- 已删除冗余代码：`deliverInputRequired`、`answerInjectPrompt`、`appendLeadMemo`、`deliverToWorker` 注入路径、`deliverOnInputRequired`/`deliverOnBlocked` 配置项。

### 门禁与验证

- tsc host/client：通过
- vitest：94/94 通过
- tsdown + verify:packaging：通过
- E2E（web profile 实测）：看板卡显示 → 作答 → 卡消失；Worker 原生卡显示 → 作答 → 卡消失 + 看板卡消失；Worker 1 轮内完成（无第二次执行请求）；工具返回值含用户答案

### 版本

- 0.3.14-beta.3（未 commit，待用户验收后 commit + tag + release）
