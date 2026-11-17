# Lead 上下文收敛与 Worker 模式扩展（未发布）

2026-11-17，基于 0.3.24 工作区实施。生产 CLI 基线为 Homebrew DSH 0.2.2-rc.1；已按用户授权打包安装到本地 Web profile 并重启服务，未修改 CLI 或 Desktop GUI，未提交或对外发布。

## 变更结果

Lead 从维护第三方工具/提示段的 deny 名单，改为自己持有完整 persona 和少量固定继承能力。通用 Worker 保留完整执行预设与既有动态 deny；模式贯穿共享生命周期，当前仅 general，没有 PPT 专用 preset、技能目录或派发入口。

改造前先保存了 [Lead / 记忆纪律 / Worker 提示全文](prompt-snapshots/0.3.24-before-lead-refactor.md)，与来源 commit `281da28aa24c05434d67e85ea45872a498b96ddc` 的原字符串逐项核对一致。原有路由、问答、交付、定时、记忆维护等重要约束保留；Lead 合并查询和记忆纪律，Worker 对已经明确授权的同一操作不再重复请求确认。

## 工具装配

| 范围 | 正常可见能力 | 机制 |
| --- | --- | --- |
| Lead 继承 | read、read_image、glob、grep、web_search、web_fetch、present | capabilities.ts 同时生成 preset 配置和 allow；web 工具另受 provider 本步就绪条件控制 |
| Lead 可选继承 | memory_search、memory_read | 原生记忆插件启用且注册完成时保留；未启用时排除 |
| Lead 自身 | orchestrator_dispatch、orchestrator_get、ask_user_question | agent scope 注册，不属于 restrict 的继承 allow |
| general Worker | 文件、命令、网页、技能、记忆、定时、子智能体与后装普通工具；五个 task_* 上报工具 | 保留原执行预设；动态 deny 隐藏高层编排、orchestrator、直接提问及直接 GenUI 渲染/验证 |

正常 Lead 最多 12 个工具；记忆未启用时 10 个。具体模型步仍由 provider 就绪状态及祖先作用域限制决定，不能把这个数量宣传为任意环境都固定不变。

删除 Lead 的 57 项全局工具基线、deny/keep/陌生工具告警、tools/change 扫描、提示段名称名单和无消费入口的 GenUI skill 覆盖。Worker 的动态 deny、GenUI card skill 及既有必要段处理保留。

重装先建立推理闸门和临时空 allow，再释放旧注册；新 allow 安装成功后释放临时掩码。首方工具缺失有界重试，仍缺失则记录配置错误并退化 allow:[]，只保留自身路由/提问；空 allow 也失败时拒绝请求。单个 Lead 的并发装配串行处理，agent 退出与服务卸载清理注册。

## 提示与记忆边界

- Lead persona 使用 complete:true / includeRuntimeContext:false；不挂 AGENTS、todo 或模型技能加载入口。完整提示不含未注册插值变量。
- roster 与能力/模式索引使用 required context，interpolate:false；roster 回调实时读取业务记录。
- complete 排除普通 section，runtime 开关抑制 optional context；required cwd 与第三方 required context 保留。
- restrict 只覆盖继承工具；第三方直接注册在当前 agent 自身 scope 的工具仍可见，任意第三方消息 hook 也没有被隔离。
- 原生记忆门控继续为 inject=false、write=true、dream=true（这些是停止开关）。允许 Lead 查询也允许自动快照注入；原生 pre-step 实测会注入带项目导引的 snapshot。
- 门控先 flush 会话，再经原生 HTTP 设置；失败有界重试，推理前仍失败则不调用模型。仅 404/405 空响应视为插件未启用。
- orchestrator 运行时代码不导入第三方数据库、不解析其目录配置、不修改其 bundle；测试使用真实上游路由和 SQLite 验证。

## 模式与模型选择

modes.ts 集中定义 ID、名称、说明、preset，以及可选 prompt / 追加插件。新增模式继续共用派发、改单、提问、定时和 outbox，不复制 service 或状态机。未来若需要替换基础工具组合，应明确调整配置组合规则；当前只提供最小追加扩展，不宣称已实现任意插件替换框架。

Conversation.mode 缺字段默认 general，未知值保留供诊断；dispatch.mode 可选且无 default。新建省略使用 general；复用省略沿用，相同允许，不同在写入/中断前报错。创建 header 与 mount 从同一模式解析 preset，恢复未知模式将会话和未完成任务标失败（configuration），保留历史终态投递，并阻止该 Worker 推理。

DSH 开发依赖及 peer 最低要求对齐 0.2.2-rc.1。模型选择改为公开 agent.model.current()/select()；原模型仍可用、选择未确定或目录异常时不乱切换，明确失效且替代项验证可用才重选。

PPT 专用模式延期；不影响通用 Worker 已有文档制作能力。

## 验证结果

2026-11-17 自动化结果：**27 个测试文件、235 个用例全部通过**。

| 检查 | 结果与证据范围 |
| --- | --- |
| host TypeScript | tsc -p tsconfig.json --noEmit，通过 |
| client TypeScript | tsc -p tsconfig.client.json --noEmit，通过 |
| 全量 Vitest | vitest run，27 / 235 全部通过 |
| 构建 | tsdown，4 入口通过，无弃用警告 |
| 打包校验 | verify-packaging.mjs，通过，12 个文件；随后生成本地 tgz 并安装到 Web profile |
| 差异格式 | git diff --check，通过 |
| 原提示词 | 与来源 commit 三段实际字符串核对，全文保留 |

工具面验证使用真实 rc.1 Cordis、scope 链、ToolsService、SystemPrompt、persona 和 Native executor；真实 fs/fs-search/web/present 插件按能力表配置注册。测试的文件/网页等宿主后端为受控适配器，不等同于真实操作系统沙箱或联网 E2E。

覆盖最终 schema、首方配置实际提供的工具名、provider 条件、晚注册继承工具默认隐藏、自身 scope 例外、完整提示/required context、空掩码降级、时序恢复、并发重装和清理。原生执行器成功执行 read，隐藏 write 返回错误且不调用修改函数；Worker 完整 configure 后五个上报工具齐全、权限预设设置正确，未知模式推理被阻止。

记忆验证实际启动本地原生 HTTP 路由并使用临时 SQLite：默认/自定义 projectDir、禁用/异常/恢复、Worker 原生写入、Lead search/read 查询、Lead 写入拒绝，以及原生 pre-step 自动 snapshot 注入。write/dream 停止标志已验证持久化；没有运行长期后台 dream 调度来估算资源开销。

既有任务状态、改单、问答、日程、定时轮次、模型元数据、交付与重启恢复测试同时回归。

## 本地部署

2026-11-17 使用本地版本号 0.3.24 替换安装，未发布到 npm、Verdaccio 或 GitHub。安装包为 `dist/local-2026-11-17T09-44-43-916Z/cmjt-dsh-orchestrator-0.3.24.tgz`，SHA-1 为 `dfd3b125b92aed1726ae02b647151877ba582771`；同目录 backup 保存部署前 profile 配置、lockfile 和已安装插件。

先 remove 再以 tgz 绝对路径 add 到 `~/.dsh/profiles/web`，通过指定 `start-dsh-web.sh --no-open` 脱离启动。新进程 PID 75056 监听 `127.0.0.1:3080`；启动已完成并打印入口，日志无启动错误。profile 启用本插件，安装的四个入口 bundle 和 cordis.patch.yml 与此次构建的 SHA-256 一致。认证验证完成启动 token 换取 cookie（303），携 cookie 获取前端 HTML 返回 200；未认证返回 401 是正常行为。

## 尚未实测

尚未调用真实模型完成端到端交互，也没有实际 provider / 文件沙箱 / UI 联调证据。已安装并重启 Web，下一步应在新 Lead 会话验证轻量查询、general 派发、改单、提问与制品交付，再验证带任务的进程重启恢复。

roster 采用唯一 required context 实现；尚未做同任务 A/B，输入 token、缓存命中、system/message 追加数和 user/message context 快照数未形成实测数据，因此不承诺 token 或缓存收益比例。后续若观测不到缓存指标，应如实标记。

PPT 技能来源、专用组合与真实制品渲染均未实施。若将来需要按会话真正隔离第三方插件贡献，应由 DSH 核心提供贡献来源与消息闸门；不通过继续扩充插件名称黑名单解决。
