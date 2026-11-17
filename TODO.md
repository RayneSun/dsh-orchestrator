# TODO：Lead 上下文收敛与执行模式实施

更新时间：2026-11-17。当前为 **0.3.24 之后的未发布工作区改动**。本文件替换旧清单，区分代码完成、自动验证与真实 Web 验收；不将设计推导当作实测结果。

用户最终范围：先保存原提示词，改造 Lead / 通用 Worker，删除冗余机制，验证工具暴露；**PPT 暂不实施，只保留扩展点**。随后已获用户授权打包部署本地 Web；不提交或对外发布，不修改 Desktop GUI。

## 1. 已确定方案

| 对象 | 职责 | 装配策略 |
| --- | --- | --- |
| Lead | 直接回答、轻量查询、路由、派发、交付 | 完整 persona + required 动态 context；继承工具固定 allow；原生记忆查询 |
| general Worker | 通用持久根执行会话 | 保留完整执行预设、AGENTS、技能及原生记忆；现有动态 deny |
| 未来专用 Worker | 同一生命周期的能力组合 | 由 modes.ts 声明 persona / 追加插件；当前没有 PPT 模式 |

- Lead 保留 memory_search/read；记忆停止开关为 `{ inject:false, write:true, dream:true }`。
- 当前上游把注入和查询绑定在 inject：**保留查询就允许自动注入**；快照作为资料，不能覆盖当前请求与系统约束。
- 不要求第三方适配，不改第三方 bundle、不建影子工具、不直接写记忆库兜底。
- 固定 allow 只限制继承工具；自身 scope 注册是平台例外。
- complete 排除普通 section，includeRuntimeContext:false 抑制 optional context；第三方 required context 与直接消息 hook 不在全面隔离承诺中。

## 2. 提示词存档与迁移

- [x] 变更前保存实际 LEAD_PROMPT、LEAD_MEMORY_PROMPT、WORKER_PROMPT 全文及来源 commit。
- [x] 存档：`docs/prompt-snapshots/0.3.24-before-lead-refactor.md`，仅供审阅，不参与装配。
- [x] Lead 保留闲聊直接答、一事一会、后台一句确认、只交付结果、不暴露内部概念等产品约束。
- [x] Lead 保留轻量 web / 文件定位 / 分段读取；来源链接、日期核验与不可信外部文本纪律补入自包含提示。
- [x] 合并原记忆纪律：仅工具可用时查询、先查重、拟好条目后 silent 派 Worker；不重复注册独立记忆 section。
- [x] 说明 roster / 能力索引为动态事实，present 只交付通知中的关键制品。
- [x] Worker 保留原任务协议、边界、文件约束及结果输出规范；已授权的同一操作不重复确认。
- [x] 完整 persona 不含未注册模板变量，不在 service 再注册第二份 complete 提示。

## 3. 运行时与模型 API

- [x] 依据本机 Homebrew CLI 0.2.2-rc.1 对齐 DSH 开发依赖及 peer 最低要求；不修改 CLI / GUI 安装。
- [x] Cordis 4.1.0、Schemastery 3.19.0 与实际运行时对齐；保留 zod 4.4.3 单实例 override，更新 lockfile。
- [x] 使用 `agent.model.current()/select()`，删除旧 selectionFor/selectForNextRequest 与投影探测接口。
- [x] 新 Worker：可用的默认配置优先，其次 Lead 当前公开选择，最后创建选项快照。
- [x] 已有 Worker：原模型可用 / 目录查询失败 / current 未确定均不切换；明确失效且替代项验证可用才 select。
- [x] 验证失效模型、目录异常、无准确替代项、替代项也不可用，不重建会话。

## 4. Lead 装配与工具策略

### 4.1 固定提示与动态 context

- [x] preset persona 设置 complete:true / includeRuntimeContext:false，挂载期生效。
- [x] Lead 移除 AGENTS、todo、模型技能工具及无消费入口的 GenUI skill 覆盖。
- [x] Lead 保留 time-context 与 compaction；文件插件显式仅 read/read_image，关闭 write/edit/applyPatch。
- [x] roster 与 Worker 能力索引改 required context，interpolate:false；roster 每次装配实时读取记录。
- [x] 普通第三方 section 不进入最终系统提示；optional 宿主 context 被抑制，required cwd / 第三方 context 保留。

### 4.2 单一能力表与失败路径

- [x] capabilities.ts 同时生成 preset 插件配置与继承 allow；记忆只引用全局插件，不重复挂载。
- [x] 正常继承名单：read/read_image、glob/grep、web_search/web_fetch、present、memory_search/read（后两项记忆禁用时移除）。
- [x] 自身工具仅注册 orchestrator_dispatch/get 与增强 ask_user_question，不把它们放进继承 allow。
- [x] 直接使用 restrict 的过滤前继承名校验，不拿 schemas 的过滤后视图静默求交。
- [x] 首方能力短暂缺失有界重试；仍缺失记录错误并退化 allow:[]，自身路由/提问保留。
- [x] 空 allow 也失败则拒绝该请求；不使用 guard 冒充隐藏。
- [x] 替换顺序：先新闸门与临时空掩码，再释放旧注册；安装新 allow 后释放临时掩码。
- [x] configure 按 Lead 会话串行；重装无重复工具、context 或遗留空掩码。
- [x] 稳定路径不监听 tools/change；晚注册的未知继承工具自动隐藏。
- [x] 会话退出与插件卸载清理注册、限制、监听及步骤计时器。

### 4.3 原生记忆

- [x] 依赖固定 @cmjt/dsh-personal-memory@0.4.6；复用原生门控实现，不修改上游产物。
- [x] 会话先 flush，再调用宿主 origin 下 skip-dreams；整组幂等设置、有界重试及超时保留。
- [x] 初始化门控失败时，在推理前重试；持续失败不调用下游模型。
- [x] 仅 404/405 空响应为插件禁用；JSON 错误、异常内容及网络失败仍报错。
- [x] 原生 HTTP + SQLite 覆盖默认 / 自定义 projectDir，不依赖 orchestrator 定位数据库。
- [x] 实际调用原生 memory_search/read 查询 Worker 写入的条目；Lead memory_remember 被门控拒绝，Worker 可写。
- [x] 原生 agent/pre-step 实测向 Lead 插入记忆内容，证明没有误关自动注入。
- [x] 持久 scope 中 write/dream=true；未将后台反思关闭误写成“全部上下文隔离”。

## 5. Worker 与模式链（PPT 不实施）

- [x] modes.ts 集中 ID、名称、能力说明、preset；提供可选专用 prompt 与追加插件，不新增调度器。
- [x] 当前只注册 general；模型 DSL、Zod 与能力索引不宣传 ppt，ppt 输入明确拒绝。
- [x] Conversation.mode 缺字段读作 general；保留未知非空存储值供恢复诊断，不切换 domain v3。
- [x] dispatch.mode 可选且无 default；新建省略→general，复用省略→沿用，相同允许，不同报错。
- [x] 模式冲突检查先于换模型、中断、改目录或写入；复用不覆盖原模式与工作区。
- [x] provisionDispatch 写 mode；创建 meta.agentPreset 与 setup.mount 从同一模式定义取值。
- [x] configureWorker 取消硬编码；冷恢复使用记录模式。
- [x] 已移除模式：会话 failed、未完成任务 failed(configuration)，保留历史终态 outbox；装配拒绝推理。
- [x] 通用 Worker 保留根会话、danger-full-access、AGENTS、技能、命令、定时、todo、present/goal 与 GenUI card 通道。
- [x] Worker 仍用动态 deny + guard 失败回退；后装普通工具默认开放，不改为白名单。
- [x] 验证 configureWorker 后五个 task_* 上报工具齐全；编排、直接提问及直接渲染工具隐藏。
- [x] 提问、改单、定时轮次、终态交付、手动停止、重启与 outbox 通过既有全量回归。
- [ ] **延期**：PPT persona、技能目录、专用 preset、真实制品制作与渲染验收，后续另行实施。

## 6. 已删除的维护机制

- [x] Lead deny/keep 名单、57 项宿主基线、陌生全局工具告警及对应测试。
- [x] Lead 提示段名单与逐名空覆盖；保留 Worker 自己的既有段处理。
- [x] Lead tools/change 扫描刷新、无技能入口的 GenUI override。
- [x] 独立 LEAD_MEMORY_PROMPT 的运行时装配与旧模型接口/无效探测。
- [x] README、AGENTS、board-api、文档索引同步固定 allow、context 边界、模式与运行时要求。
- [x] 原始历史发布记录保持可追溯；当前实现说明另存 docs/lead-context-refactor.md。

## 7. 验证分层与证据

### 7.1 自动化（真实 rc.1 核心组件参与）

- [x] 使用真实 Cordis、scope 链、ToolsService、persona、SystemPrompt 与 Native executor，而非仅比较 mock 名单。
- [x] 真实 fs/fs-search/web/present 插件按能力表配置注册，实际工具名与声明一致。
- [x] 验证最终系统提示及 schema；web provider 未就绪时按平台条件从本步工具清单移除。
- [x] 原生执行器成功调用 read；隐藏 write 调用报错且修改函数不执行。
- [x] 新继承工具默认隐藏、自身 scope 第三方例外保留；测试同时写清限制边界。
- [x] 必需能力缺失、时序恢复、空 allow 失败、重新装配、并发 configure 与清理。
- [x] memory 原生路由/数据库/工具/消息 hook，门控失败拒绝推理及恢复后放行。
- [x] 模式默认 / 冲突 / 未知恢复、DSL-Zod 契约及 Worker 模型边界。
- [x] host/client TypeScript、全量 Vitest（27 文件 / 235 用例）、tsdown、packaging（12 文件 dry-run）、diff 检查通过；证据与限制见改造记录。

### 7.2 真实 Web 与成本（未执行，不冒充完成）

- [ ] 在新 Web 会话验证闲聊、联网、文件读取、记忆查询、general 派发及 present 交付。
- [ ] 验证同会话改单、阻塞提问作答、终态交付与进程重启后的恢复。
- [ ] 核对真实 provider、文件沙箱、权限配置、全局第三方插件与 schedule 唤醒行为。
- [ ] 用同一真实多步任务对比 roster section / context：输入 token、缓存命中、system/message 追加数、user/message context 快照数；不可观测的指标如实标注。

当前保留唯一 required context 实现；尚未获得真实 token/cache 数据，不承诺节省比例，也不把快照数当状态变化数。

### 7.3 本地打包部署（2026-11-17 已完成）

- [x] 重新构建与打包校验，生成 12 文件的本地 0.3.24 tgz；不覆盖原 dist 发行包。
- [x] 备份部署前 profile 配置、lockfile 与原已安装插件，保存到本次独立部署目录。
- [x] 停止旧 Web，先 remove 再通过 tgz 绝对路径 add 到真实 web profile。
- [x] 使用指定启动脚本及 start_new_session 重启，确认新进程监听 127.0.0.1:3080，启动日志无错误。
- [x] 核对 profile 启用插件、依赖指向新包；四个入口 bundle 与 cordis.patch.yml 的安装文件 SHA-256 与构建一致。
- [x] 启动 token 换取认证 cookie 返回 303，携 cookie 获取 Web 前端返回 200。

包与备份目录：`dist/local-2026-11-17T09-44-43-916Z/`。详细证据见 `docs/lead-context-refactor.md`；真实模型与 UI 验收仍按 7.2 保持未完成。

## 8. 当前完成边界

代码、自动化验证及本地 Web 打包安装、重启、认证 HTTP 验证已完成；外部模型 E2E、提交/tag/push/release 均未执行。PPT 明确延期。真实 Web 联调应使用新 Lead 会话，Desktop GUI 保持不动。
