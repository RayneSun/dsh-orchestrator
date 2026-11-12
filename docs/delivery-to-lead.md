# 向主会话（Lead）投递消息的方式调研

> 调研基线：DSH 0.2.1-rc.2（2026-10-28）。结论来自 `@deepseek-ai/dsh-agent` 与 `@deepseek-ai/dsh-session` 的类型定义与 README 实读。
> **当前实现（v0.3.23）：completed / failed / interrupted 经 followup 投递；completed 文本由 `task.result`、制品清单、用户日程附言和可选 `task.card` 的 dsh-ui 围栏组成。Lead 按输出规范精简 result 正文，card 围栏原封不动，制品路径只用于 present，三者不重复。`input_required` 由看板和 Worker 原生问题卡承载，不投递 Lead；任一入口通过 `answerTaskQuestions` 作答后，阻塞的 task_input_required 在同轮返回用户答案。**

## 背景

Worker 的 completed / failed / interrupted 通过持久 outbox 投递到 Lead 主会话，受 silent 和状态投递开关约束。`deliverPendingTask`（src/service.ts）调用 `agent.followup(message)`：消息入 inbox 并**唤醒驱动器**，Lead 开一轮推理来转述/处理。input_required 直接等待用户作答，不经过 Lead。

同一 Task 可被定时触发多次并覆盖 completed 结果。每次投递开始捕获 Task.revision，成功或失败回写只处理该 revision；若投递期间产生了新结果，旧回写失效并继续投递最新 pending，避免旧 delivered/attempts 吞掉新结果。无变化的 delivery 回写不增加 revision。

## 三种机制

| 机制 | 落日志 | 渲染进聊天 | 唤醒模型 | 适用 |
|---|---|---|---|---|
| `agent.followup(msg)` | ✅（claim 后） | ✅ | ✅ 开新轮 | 需要 Lead 模型处理的结果转述 |
| `agent.inject(msg)` | ✅ | ❌（不可见） | ❌ 挂到下一轮 pre-step | 给 Lead 塞上下文但不打扰 |
| `agent.session.append('user/message', msg)` | ✅ | ✅ | ❌ 不唤醒 | 纯展示通知/备忘；用户之后打字时 Lead 自动带上下文 |

补充：`agent.send(msg, target, wakeup: false)` 可把消息停进 inbox 不唤醒，但要等下一次唤醒才落日志渲染，不适合“立即呈现”。

## 当前 input_required 链路

1. Worker 上报 `input_required + questions`；任务持久化为待你操作。
2. 看板渲染问题卡；Host 在 Worker Agent 上调用 `userQuestions.ask` 渲染原生问题卡。inputRequired 固定为 false，无 `deliverOnInputRequired` 配置。
3. 用户在任一入口作答 → `orchestrator/answerTaskQuestions`；Host 串行幂等校验 → 任务恢复 running → resolve 等待中的 task_input_required；Worker 在同轮直接收到结构化答案。
4. 任一入口成功作答后清理另一侧原生卡及取消监听。工具取消、手动停止、改单、服务卸载均清理等待；已取消原生卡晚到的答案被丢弃，不会进入后续提问。重启时遗留 input_required 转为现有 interrupted 状态，工作流回 idle，不投递 Lead。
5. 原生问题服务不可用时仍可从看板作答；原生卡异常记录告警。作答不追加 Lead 备忘，不派发新的 Worker 轮次。

## `session.append` API 对比

- API：`session.append('user/message', createUserMessage({...}))`，属于公开 event-sourced API。
- 当场不触发推理，但下次 Lead 因任何原因开轮时自动进入请求前缀。
- source 用 `{ kind: 'orchestrator', form: 'notice', summary }`，聊天渲染为用户气泡。
- 调用需带 surface intent 参数；append 后 `hostCtx.sessions.flush(session)` 确认持久化。当前编排插件未使用该投递方式。

## 风险

- 程序化 `userQuestions.ask` 不进 userQuestions 投影：Worker 原生卡刷新后不可恢复，看板仍可作答；Host 重启会将遗留等待任务中断。
- 若未来采用 `session.append`，需单独回归“落日志但不唤醒”；当前插件使用 followup，升级 DSH 时应回归实际投递与同轮作答链路。
