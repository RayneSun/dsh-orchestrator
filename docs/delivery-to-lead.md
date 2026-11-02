# 向主会话（Lead）投递消息的方式调研

> 调研基线：DSH 0.2.1-rc.2（2026-10-28）。结论来自 `@deepseek-ai/dsh-agent` 与 `@deepseek-ai/dsh-session` 的类型定义与 README 实读。
> **当前版本：普通终态维持 followup；input_required 已改为优先走平台原生问题卡（`userQuestions.ask`），答案 resolve 回 Host 后直接注入 Worker。看板/子会话问题卡共用 `answerTaskQuestions`。Lead 备忘使用 `session.append` 不唤醒。**

## 背景

Worker 终态（input_required / completed / failed / interrupted）需要把结果送到 Lead 主会话。`deliverPendingTask`（src/service.ts）的默认路径是 `agent.followup(message)`：消息入 inbox 并**唤醒驱动器**，Lead 开一轮推理来转述/处理。`input_required` 如果继续 followup 会为“只需要用户看见”的通知烧一次模型调用；v0.3.14 起改为 `deliverInputRequired`。

## 三种机制

| 机制 | 落日志 | 渲染进聊天 | 唤醒模型 | 适用 |
|---|---|---|---|---|
| `agent.followup(msg)` | ✅（claim 后） | ✅ | ✅ 开新轮 | 需要 Lead 模型处理的结果转述 |
| `agent.inject(msg)` | ✅ | ❌（不可见） | ❌ 挂到下一轮 pre-step | 给 Lead 塞上下文但不打扰 |
| `agent.session.append('user/message', msg)` | ✅ | ✅ | ❌ 不唤醒 | 纯展示通知/备忘；用户之后打字时 Lead 自动带上下文 |

补充：`agent.send(msg, target, wakeup: false)` 可把消息停进 inbox 不唤醒，但要等下一次唤醒才落日志渲染，不适合“立即呈现”。

## 当前 input_required 链路

1. Worker 上报 `input_required + questions`；任务持久化为待你操作。
2. 看板与子会话工具行立即渲染问题卡；默认向主会话投递原生问题卡（设置项 `deliverOnInputRequired` 默认 true）。
3. 用户在看板/子会话作答 → `orchestrator/answerTaskQuestions`；Host 串行幂等校验 → 任务恢复 running → 结构化答案 followup 回同一 Worker。
4. 如果投递开启，Host 调 `ctx.userQuestions.ask({ questions, agent })` 在主会话渲染原生问题卡；答案 resolve 后走同一作答路由。平台服务缺失时降级为普通 followup 文本。
5. 看板作答成功后给 Lead 写 `session.append` 不唤醒备忘，避免 Lead 下一轮重复转派。

## `session.append` 细节（Lead 备忘用）

- API：`session.append('user/message', createUserMessage({...}))`，属于公开 event-sourced API。
- 当场不触发推理，但下次 Lead 因任何原因开轮时自动进入请求前缀。
- source 用 `{ kind: 'orchestrator', form: 'notice', summary }`，聊天渲染为用户气泡。
- 调用需带 surface intent 参数；append 后 `hostCtx.sessions.flush(session)` 确认持久化。

## 风险

- 程序化 `userQuestions.ask` 不进 userQuestions 投影：主聊天原生卡刷新/重启后不可恢复；看板与子会话卡不受影响。
- `session.append` 比 followup 更底层，绕过 agent inbox/turn 语义；升级 DSH 后需回归“落日志但不唤醒”。
