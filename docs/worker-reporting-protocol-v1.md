# interaction-core 开发者接入协议 v1

这是外部 DSH 插件维护者的交接稿。SDK 方法名和数据契约是实施目标，尚未发布。接入方声明对兼容版 `interaction-core` 的依赖，确保目标 DSH profile 启用其 Host 与 Client；只需要开发业务工具。Core 提供会话内嵌 UI、等待、预览、作答、跨入口同步和只读结果卡。不依赖 Orchestrator，也不需要自身的交互 UI、传输协议或等待服务。

## 1. 入口与身份

```ts
// 示意接口；exec 为 DSH 工具 execute(args, exec) 的真实第二参。
const run = interactionCore.bind(exec)
await run.report({ type: 'running', payload: { header: '写大纲' } })
const answer = await run.ask(card)
```

- 包公开 `protocolVersion: 1` 与 SDK；Host+Client 以 DSH 插件身份激活，每个宿主只使用一个服务。实际 npm scope、导入路径、启用配置由交付包明确。独立运行只要求 Core；如 Core 缺失或版本不兼容，返回可诊断依赖错误，不能显示假待答。
- 宿主从 `exec` 绑定来源会话、工具调用、取消信号，并解析可选的受管执行代次；调用者不传 `sessionId`、`taskId`、`requestId`、用户身份或通知目的地。
- 如果宿主视图按工具名键控，开发者用 SDK 的声明入口标出工具名（例如 `write_plan`、`review_preview`），由 Core 绑定默认视图，不写 JSX、RPC 或消息围栏。迁移一个工具时，移除它原有的 UI 注册与自有等待路径，避免一个请求出现两个后端。

## 2. 问题、正文和媒体

```ts
type AssetInput =
  | { source: 'workspace'; path: string }  // 所属工具工作区内的相对路径
  | { source: 'attachment'; id: string }    // 当前会话中宿主可授权的素材引用

type Image = { asset: AssetInput; alt: string; caption?: string }
type BlockV1 =
  | { type: 'markdown'; text: string }
  | ({ type: 'image' } & Image)
  | { type: 'gallery'; images: Image[]; caption?: string }
  | { type: 'html'; asset: AssetInput; caption?: string }

type Option = { id: string; label: string; detail?: string; preview?: BlockV1[] }
type QuestionBase = { id: string; prompt: string; body?: BlockV1[]; required?: boolean }
type QuestionV1 = QuestionBase & (
  | { type: 'single'; options: Option[]; allowCustom?: boolean }
  | { type: 'multiple'; options: Option[]; min?: number; max?: number }
  | { type: 'text'; placeholder?: string }
  | { type: 'confirm'; acceptLabel?: string; rejectLabel?: string; allowNote?: boolean }
)

type QuestionCardV1 = {
  title: string
  body?: BlockV1[]
  questions: QuestionV1[]
  timeoutMs?: number
}
```

- `body` 可以放全卡共用说明，也可以只放在一题下；`preview` 只描述其候选方案。一个单选题可以混用图、套图和 HTML；图组选择返回方案 ID。只展示 GenUI 内容时使用 §5 的 `create_ui`。
- 同卡题号唯一、同题选项号唯一。SDK 直调由调用方传稳定 ID；内置工具的适配层可以为模型补齐。`required` 默认 `true`，选填题可略过。最多 10 题、每题 10 个选项、每图组 12 张图；ID 至多 40 字符。登记前在 Host 校验数量、类型与素材权限；超限和无法授权的引用报具体字段。`min/max` 只用于多选，必答多选默认至少选择一项。
- 首版 HTML 为宿主授权的静态 `.html` 预览（自包含文件），与卡片表单隔离。远程网页、执行 HTML 脚本和 PHP 不属于契约；不要为得到结构化答案在 HTML 内自行加按钮。支持的后续内容块（如 `video`、`audio`）可在同一位置扩展。新的题型须连同答案 schema、Host 校验和两路卡片实现一起扩展；任意插件不能注入第三方 JSX 或用未知类型隐式降级。
- Core Host 归一化素材并向客户端发有作用域的引用，答案不带文件路径。未知字段或题型不能被悄悄改成其他意思；消费者依 SDK 能力选择实际已实现的类型。若有历史快照含当前客户端未知的类型，显示只读提示，不允许跳过该题提交答案。

## 3. 答案与生命周期

```ts
type AnswerV1 = { questionId: string } & (
  | { type: 'single'; optionId: string }
  | { type: 'single'; custom: string }
  | { type: 'multiple'; optionIds: string[] }
  | { type: 'text'; text: string }
  | { type: 'confirm'; decision: 'accept' | 'reject'; note?: string }
)

type AskOutcomeV1 =
  | { status: 'answered'; requestId: string; answers: AnswerV1[] }
  | { status: 'cancelled' | 'expired'; requestId: string }
```

Core 验证必答题完整、题型对应、ID 存在且无重复、文本不为空、选项数合规。选填题不回答时省略该条；`single` 的 `optionId` 和 `custom` 必须二选一，且只有 `allowCustom: true` 才允许 `custom`；`note` 仅在 `allowNote: true` 时接受。确认/退回均是合法答案；取消与过期不是同意，业务应明确处理。无效卡片在登记前抛带字段路径的错误。默认等待上限 30 分钟，部署可通过 Core 配置设定最大等待时间；`timeoutMs` 为正整数，不能超过该上限。阻塞当前工具，不阻塞宿主其他工具或会话。

```text
Worker ask → Core pending → worker 会话卡 + 可选的 Orchestrator 弹框卡
                            两处提交同一 requestId
            Core 原子接受第一份合法答案 → answered → 返回到同一个 ask
            停止 / 改单 / 到期            → cancelled / expired
```

- 两处卡片按同一个 Host 快照提交。客户端只需要这些操作：`get(requestId)`、`subscribe(requestId, onChange)`、`submit(requestId, { revision, answers })`、按授权载入媒体。业务调用方不实现或直接使用这套客户端接口。
- 快照含 `requestId`、`revision`、`status` 和渲染数据。重连先读当前快照，再跟随更新；旧 revision 不覆盖新状态。无效提交返回字段错误，其他入口已答返回最新快照，全卡退出待答。关闭弹框不取消；取消/改派后拒绝迟到提交。进程重启关闭未完成请求并回收等待，首版不跨进程恢复阻塞工具。
- Orchestrator 只获得当前执行的请求 ID、状态、摘要及事件顺序，足够更新任务数据和打开共享卡身；打开后 Core 按同一授权读完整数据。独立工具的问答不会出现在不相关的任务中。

## 4. 非阻塞任务报告

`run.report({ type: 'running', payload })` 无需等待任何用户动作。命令可以等待接收回执，其中 `unmanaged` 表示没有绑定编排任务，独立工具继续正常运行。进展失败不应拖垮 PPT 业务。`await run.ask` 和 `await run.report` 的等待对象不同：前者等用户回答，后者只等宿主接收。

| `type` | `payload` | 来源及语义 |
|---|---|---|
| `running` | `header?`（≤8 字）、`progressNote?`（≤500 字） | 任意已绑定的业务工具/通用 Worker；例如 `write_plan` 开始时汇报「写大纲 / 正在整理《季度经营复盘》的大纲」。仍有待答时更新进展，不关闭问题。 |
| `completed` | 同上公共字段 + `result`（必填）、`artifacts?`、`uiRef?` | 由受管派发注入的 `task_completed` 提交。`result` 为结论；`artifacts` 为关键制品的工作区相对路径；`uiRef` 引用同一执行中已通过 `create_ui` 创建的展示卡。 |
| `failed` | 同上公共字段 + `error`（必填）、`reasonCode?` | 受管派发注入的 `task_failed` 调用同一通道。`reasonCode` 沿用 `permission_denied / configuration / dependency / network / resource / runtime`。 |

- 第三方业务工具只需提交 `running`。`completed`/`failed` 由派发方持有能力并注入；仅某步返回成功不会结算整单。独立轮次没有这些终态工具，也不需要检测 Orchestrator 的存在。编排器对终态持久接受后才回执成功；已被改单替换的来源不能结算新执行。
- 公共协议按带版本的事件类型扩展，每种报告校验自己的 payload；未知报告返回不支持，不当作 `running` 或 `completed`。消费方按受管执行绑定、事件 ID/顺序去重并拒绝旧代次，终态不可被迟到的进度或问题重开。报告不创建可作答卡。要问用户时调用 `ask`；展示卡可以在完成报告中引用。

```ts
type ReportFieldsV1 = { header?: string; progressNote?: string }
type TaskReportV1 =
  | { type: 'running'; payload: ReportFieldsV1 }
  | { type: 'completed'; payload: ReportFieldsV1 & {
      result: string; artifacts?: string[]; uiRef?: UiRefV1
    } }
  | { type: 'failed'; payload: ReportFieldsV1 & {
      error: string; reasonCode?: 'permission_denied' | 'configuration' | 'dependency'
        | 'network' | 'resource' | 'runtime'
    } }

type ReportReceiptV1 =
  | { status: 'accepted' | 'duplicate'; eventId: string }
  | { status: 'unmanaged' }
  | { status: 'rejected'; code: 'invalid' | 'unsupported' | 'stale' | 'forbidden' | 'unavailable'; message: string }

interface BoundInteractionV1 {
  ask(card: QuestionCardV1): Promise<AskOutcomeV1>
  createUi(input: CreateUiInputV1): Promise<CreateUiResultV1>
  report(event: TaskReportV1): Promise<ReportReceiptV1>
}
```

## 5. 只读卡：`create_ui` 与引用

Core 提供模型工具 `create_ui`，SDK 的 `run.createUi` 与它走同一个 Host 实现。这个入口不等待用户，也不报告任务完成。它返回内部引用 ID，正文和任务报告使用相同的 ID；调用后不会自动往会话插入卡片。

```ts
type UiRefV1 = `ui_${string}` // Host 校验完整格式；调用方使用原样返回的值
interface CreateUiInputV1 { spec: unknown }
interface CreateUiResultV1 { uiRef: UiRefV1 }
```

- `spec` 使用 Core Skill 公布的 GenUI 展示子集。支持表格、统计、时间线、图表等展示组件。允许局部展开、缩放等纯展示操作；不接受会话 action、按钮回传、表单提交或 Panel。Host 校验嵌套组件、字段、大小和资源访问，成功持久化后才返回 ID；校验失败附带字段路径。需要用户输入或需要工具等待时，用 `ask`。
- **正文内嵌**：模型在普通正文中单独输出下面的围栏。围栏只放一个 `uiRef`，不带 JSON、链接语法、说明或额外字段。Core 在围栏闭合后按消息所属会话解析引用并渲染。引用无法解析或没有读取权限时显示错误提示。

````markdown
```dsh-ui
ui_01ARZ3NDEKTSV4RRFFQ69G5FAV
```
````

- **作为任务交付**：在当前受管执行中创建后，模型可调用 `task_completed({ result: '复盘已完成', uiRef })`，同时可附 `artifacts`。不再传 `card` JSON。Orchestrator 校验归属后关联任务，为实际接收投递的 Lead 会话授予读取权限，Lead 原样输出同一个引用围栏。外部业务工具无需自行注入或调用终态工具。
- 引用不是访问凭证。通过创建者会话或 Host 授权的目标会话读取；仅有 ID 不授予访问，其他会话或旧执行的引用不能用来结算当前任务。卡片创建后不可原地改写并可跨重启回看；更新内容需要创建新引用。切换前已存在的 JSON 围栏只读兼容，不作为新输出格式，不执行旧交互动作。

## 6. 编排宿主的接入面

这一节由 Orchestrator 等管理方实现；业务 Worker 不依赖它。以 Core 发出的执行流为编排侧唯一的交互数据来源，受管执行绑定由编排宿主创建和撤销，会话与调用归属始终从 DSH 运行时读取。

```ts
type RequestRefV1 = {
  requestId: string
  revision: number
  status: 'pending' | 'answered' | 'cancelled' | 'expired'
  title: string
  questionCount: number
}

type ManagedEventV1 = {
  protocolVersion: 1
  executionId: string  // 宿主签发的执行代次标识，仅在宿主间传递
  sequence: number    // 同一执行单调递增
  eventId: string
} & (
  | { type: 'request.changed'; request: RequestRefV1 }
  | { type: 'report.received'; report: TaskReportV1 }
)
```

- `TaskReportV1` 定义见 §4；定时任务的 `scheduleId` 仍由 Orchestrator 注入工具与执行绑定处理，不作为通用事件字段。Core 提供按执行订阅的快照加后续事件，快照含待答集合及对应游标。订阅建立时补齐快照到实时流的间隙；重连或游标不连续时重读快照，不能把已关闭的请求重新投影为待答。报告处理有接收回执，终态必须持久化后才能返回成功。报告响应至少区分 `accepted`、`duplicate`、`unmanaged` 和拒绝类结果；验证错误应带原因。
- 任务数据只保存待答关联和必需的摘要。Core 客户端提供可嵌入的卡身，使用形状如 `<QuestionCard requestId={id} onSettled={close} />`。其中 `onSettled` 只协调容器关闭；作答、媒体鉴权、状态订阅及重连均由组件和 Core 负责。会话的内嵌位置、会话内展开弹框、看板的点击弹框都能挂同一卡身。终态报告中的 `uiRef` 只用于展示，不能传给 `QuestionCard`。
- `requestId` 不是访问凭证。先用绑定的会话或编排任务归属校验当前用户，再取快照、订阅、获取资源或提交。关闭任一容器只卸载该视图，其他视图和工具等待不受影响。

## 7. PPT 接入示例：选一套封面

```ts
const run = interactionCore.bind(exec)
await run.report({ type: 'running', payload: { header: '比较封面', progressNote: '正在准备两套季度复盘封面' } })
const outcome = await run.ask({
  title: '选一套季度复盘封面',
  body: [{ type: 'markdown', text: '每套有两张图，点击图片可以放大。' }],
  questions: [{
    id: 'cover', type: 'single', prompt: '你更喜欢哪一套？',
    options: ['a', 'b'].map(id => ({
      id, label: `方案 ${id.toUpperCase()}`,
      preview: [{ type: 'gallery', images: [1, 2].map(n => ({
        asset: { source: 'workspace', path: `covers/${id}-${n}.png` },
        alt: `方案 ${id.toUpperCase()} 第 ${n} 张`,
      })) }],
    })),
  }],
})
if (outcome.status !== 'answered') return handleStopped(outcome.status)
const answer = outcome.answers.find(a => a.questionId === 'cover')
if (answer?.type !== 'single' || !('optionId' in answer)) return handleUnexpectedAnswer()
return useCover(answer.optionId)
```

`write_plan` 接入点同理：先生成大纲，在 `body` 给 Markdown，大纲问题用 `confirm`，允许退回时附修改意见，SDK 归还选择后 PPT 自行确认存盘或继续修改。没有专用编辑题型的版本，逐页编辑仍由 PPT 的业务流程决定何时迁移；不要把业务阶段的轻量视觉改造与旧专用编辑行为的退役混为一轮。

独立验收：只启用 Core 和示例 Worker，在该 Worker 会话内看到卡片，分别提交确认、退回与媒体题。联动验收：由用户在 Orchestrator 设置登记 Worker 的预设、名称和介绍，再由 Lead 通过 `orchestrator_dispatch.type` 派发，分别从会话与看板弹框作答，并行作答只恢复一次；验证 `running`、完成结果、`uiRef` 和制品能到达，撤回或改单后旧请求无法提交。开发者不需要调用注册 Worker 的 API。
