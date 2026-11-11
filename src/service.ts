import { randomUUID } from 'node:crypto'
import { mkdir, rmdir } from 'node:fs/promises'
import { Context, Service } from '@deepseek-ai/cordis'
import sz from '@deepseek-ai/schemastery'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { deliveryNotice, revisionPrompt, scheduleProjection, scheduleStatusSection, workerPrompt } from './messages.ts'
import { type ScheduleServiceLike, type SessionActivityGroup } from './host-contracts.ts'
import { DISPATCH_TOOL_PARAMETERS, TASK_COMPLETED_TOOL_PARAMETERS, TASK_FAILED_TOOL_PARAMETERS, TASK_INPUT_REQUIRED_TOOL_PARAMETERS, TASK_RUNNING_TOOL_PARAMETERS, TASK_SCHEDULE_TOOL_PARAMETERS } from './tool-parameters.ts'
import type { AnswerQuestionsRequest, AnswerQuestionsResult, SetScheduleStatusRequest, SnapshotRequest } from './remote.ts'
import { toJson } from './json.ts'
import { isUnfinishedTask } from './task-lifecycle.ts'
import { PendingAnswers } from './pending-answers.ts'
import { planScheduleChanges } from './schedule-changes.ts'
import { isWorkerToolForbidden } from './worker-policy.ts'
import { GENUI_CARD_SKILL_CONTENT, GENUI_CARD_SKILL_DESCRIPTION } from './genui-card-skill.ts'
import { LEAD_SUPPRESSED_SECTIONS, leadToolDenyList, unrecognizedGlobalTools } from './lead-policy.ts'
import { configureLeadMemory } from './memory-policy.ts'
import { normalizeProgressSteps } from './progress.ts'
import { buildChildWorkspace } from './workspaces.ts'
import { orchestratorDomain } from './storage.ts'
import { buildPresetDefinitions, LEAD_PRESET, WORKER_PRESET } from './presets.ts'
import {
  activateConversation,
  appendOutlineSubject,
  interruptTaskForRevision,
  reviseConversation,
  failConversation,
  failTask,
  interruptTaskAfterRestart,
  resumeTaskWithAnswers,
  awaitingConversation,
  settleConversation,
  startConversation,
  deliveryEnabledFor,
  gateTaskDelivery,
  classifyWorkerTurnEnd,
  statusConcludesTurn,
  transitionTask,
  type WorkerTurnEndCause,
  type TaskTransitionInput,
} from './state-machine.ts'
import {
  createConversation,
  createId,
  createTask,
  timestamp,
  type ConversationRecord,
  type ProgressStep,
  type QuestionAnswer,
  type Snapshot,
  type ScheduleRecord,
  type TaskRecord,
  activeTaskStatuses,
  terminalTaskStatuses,
  type DeliveryToggles,
  dispatchInputSchema,
  conversationIdInputSchema,
  cardValidationError,
  type DispatchInput,
  taskReportInputSchemas,
  taskScheduleInputSchema,
  type TaskReportStatus,
} from './types.ts'

export { DISPATCH_TOOL_PARAMETERS, TASK_COMPLETED_TOOL_PARAMETERS, TASK_FAILED_TOOL_PARAMETERS, TASK_INPUT_REQUIRED_TOOL_PARAMETERS, TASK_RUNNING_TOOL_PARAMETERS, TASK_SCHEDULE_TOOL_PARAMETERS } from './tool-parameters.ts'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    orchestrator: { kind: 'orchestrator' } & ContextFormed
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context { orchestrator: OrchestratorService }
  interface Events {
    /** V1 外部插件复用已允许转发的通用变更载波；客户端收到后只刷新看板。 */
    'commands/change'(): void
  }
}

type DomainType = Domain<typeof orchestratorDomain>
type DispatchProvision =
  | { ok: true; conv: ConversationRecord; task: TaskRecord }
  | { ok: false; result: unknown }

/** schedule/changed 在任务创建/更新、删除、投递时都会触发，合并后再核对，避免每轮触发都全量 list。 */
const SCHEDULE_SYNC_DEBOUNCE_MS = 500

/** 平台 modelSelection 投影与默认模型服务的本地结构化类型（不新增包导入）。 */
type ReasoningEffort = NonNullable<Agent['options']>['reasoningEffort']
interface ModelSelectionLike {
  provider?: string
  model?: string
  reasoningEffort?: ReasoningEffort
}
interface SessionProjectionsLike {
  stateOf(session: unknown, key: string): { pending?: ModelSelectionLike | null } | undefined
}
interface AgentDefaultModelLike {
  currentSelection(): ModelSelectionLike
}
/** Worker 子会话用空 section 遮蔽的全局系统提示段（同名 scoped section shadow 全局）。 */
const WORKER_SUPPRESSED_SECTIONS = ['harness:source', 'app:web-surface', 'ui:deliverable-file-references', 'genui:fence'] as const
const RECOVERY_INTERVAL_MS = 15_000
const REVISION_GUARD_MS = 120_000
const TODO_FLUSH_DELAY_MS = 350
const LAUNCH_ACCEPT_TIMEOUT_MS = 120_000
const PERSISTENCE_STAT_TIMEOUT_MS = 5_000

function isSessionNotFoundError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const candidate = error as { name?: unknown; message?: unknown }
  return candidate.name === 'SessionPersistenceNotFoundError'
    || typeof candidate.message === 'string' && candidate.message.includes('not found')
}

/** 无状态 JSON 输出描述，所有编排工具共用一个实例。 */
const sharedJsonOutput = {
  schema: { type: 'json' as const },
  render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
}

/** dispatch 入参 -> TaskRecord：新建与复用分支共用，避免验收/静默样板双写。 */
function buildTask(args: DispatchInput, ids: { id: string; parentSessionId: string; conversationId: string; predecessorTaskId: string | null }): TaskRecord {
  return createTask({
    ...ids,
    subject: args.subject,
    prompt: args.prompt,
    ...args.acceptanceCriteria ? { acceptanceCriteria: args.acceptanceCriteria } : {},
    ...args.silent ? { silent: true } : {},
  })
}

function formatRosterTime(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  const now = new Date()
  const sameYear = date.getFullYear() === now.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  const hour = String(date.getHours()).padStart(2, '0')
  const minute = String(date.getMinutes()).padStart(2, '0')
  return `${sameYear ? '' : `${date.getFullYear()}/`}${month}/${day} ${hour}:${minute}`
}

/** Roster 保持单会话一行：压缩动态文本中的换行，并限制模型上下文占用。 */
function rosterExcerpt(value: string | undefined, limit = 80): string {
  const text = value?.trim().replace(/\s+/g, ' ') ?? ''
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function rosterTaskSegment(active: TaskRecord | undefined, last: TaskRecord | undefined): string {
  const task = active ?? last
  if (!task) return ''
  if (task.status === 'input_required') {
    const questions = task.questions ?? []
    const text = rosterExcerpt(questions.slice(0, 2).map(item => item.question).join('；'), 100)
    return `｜待操作：${text || '等待用户作答'}${questions.length > 2 ? '…' : ''}`
  }
  const segment = `｜${active ? '当前' : '最近'}需求：${rosterExcerpt(task.prompt)} [${task.status}]`
  if (active) {
    const progress = [rosterExcerpt(task.header, 8), rosterExcerpt(task.progressNote, 120)].filter(Boolean).join(' — ')
    return `${segment}${progress ? `｜进展：${progress}` : ''}`
  }
  if (task.status === 'completed' && task.result) return `${segment}｜结果：${rosterExcerpt(task.result)}`
  if (task.status === 'failed' && task.error) return `${segment}｜错误：${rosterExcerpt(task.error)}`
  return segment
}

/** 设置页（插件管理 → 本包行配置）的 volatile 配置引用：.get() 读实时值，改动即时生效不重启。 */
interface OrchestratorConfigRefs {
  deliverOnCompleted?: { get(): boolean }
  deliverOnFailed?: { get(): boolean }
  deliverOnInterrupted?: { get(): boolean }
}

export class OrchestratorService extends TypertRemoteService {
  static inject = [
    'agents', 'sessions', 'storageDomain',
    'sessionController', 'sessionPersistence', 'agentPresets', 'sessionTitle',
    'sessionProjections', 'agentDefaultModel',
  ]

  /**
   * 终态投递开关（设置页可配，全部默认开）。
   * 只决定"终态消息是否回投主会话"：上报的状态与进展总是持久化，
   * roster 与看板照常更新——与 silent 的语义分界一致（silent 是整会话不投，开关是按状态不投）。
   */
  static Config = sz.object({
    deliverOnCompleted: sz.boolean().default(true).volatile(),
    deliverOnFailed: sz.boolean().default(true).volatile(),
    deliverOnInterrupted: sz.boolean().default(true).volatile(),
  })

  private ready: Promise<void>
  private domain: DomainType | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private readonly installed = new Map<string, Array<() => unknown>>()
  private readonly delivering = new Set<string>()
  /** taskId -> resolver，task_input_required 阻塞等待用户作答。 */
  private readonly pendingAnswers = new PendingAnswers()
  private readonly pendingTodoSteps = new Map<string, { taskId: string; steps: ProgressStep[] }>()
  private readonly todoTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // 改单 cancel 自身会产生一次 aborted turn/end，需要忽略，不能当成手动停止或任务失败。
  private readonly revisionTurnEnds = new Map<string, number>()
  /** childSessionId -> 是否绑定了活动定时任务（看板 badge 数据源，内存推导不落库）。 */
  private readonly scheduleMarks = new Map<string, boolean>()
  /** childSessionId -> 最近一条入站消息的 source.kind（判定定时触发上报用）。 */
  private readonly lastInboundSource = new Map<string, string>()
  /** childSessionId -> 已同步到 DSH 侧栏的标题（不含定时标记前缀），用于跳过无谓 rename。 */
  private readonly syncedTitles = new Map<string, string>()
  private scheduleSyncTimer: ReturnType<typeof setTimeout> | undefined
  private recoveryTimer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly hostCtx: Context, private readonly configRefs?: OrchestratorConfigRefs) {
    super(hostCtx, 'orchestrator', { namespace: 'orchestrator' })
    this.markRemote('snapshot')
    this.markRemote('setScheduleStatus')
    this.markRemote('answerTaskQuestions')
    this.ready = this.start()
  }

  /** 从 volatile 引用实时解析投递开关（设置页改动立即反映到下一次判定）。 */
  private deliveryToggles(): DeliveryToggles {
    const refs = this.configRefs
    const read = (ref?: { get(): boolean }) => ref?.get() !== false
    return {
      completed: read(refs?.deliverOnCompleted),
      failed: read(refs?.deliverOnFailed),
      interrupted: read(refs?.deliverOnInterrupted),
    }
  }

  async [Service.init](): Promise<void> {
    await this.ready
  }

  /** Standalone tsdown does not run Typert's decorator lowering; use its public decorator API once per instance. */
  private markRemote(method: 'snapshot' | 'setScheduleStatus' | 'answerTaskQuestions'): void {
    const prototype = Object.getPrototypeOf(this) as Record<'snapshot' | 'setScheduleStatus', unknown>
    let initializer: (() => void) | undefined
    Remote(method)(prototype.snapshot as never, {
      kind: 'method',
      name: method,
      static: false,
      private: false,
      addInitializer: (fn: () => void) => { initializer = fn },
    } as never)
    initializer?.call(this)
  }

  private async start(): Promise<void> {
    const domain = await this.hostCtx.storageDomain.open(orchestratorDomain)
    this.domain = domain
    try {
      await this.registerPresets()
      this.hostCtx.effect(() => {
        const offPreset = this.hostCtx.on('agent-preset/selected', (sessionId, preset) => {
          if (preset !== LEAD_PRESET) return
          const agent = this.hostCtx.agents.get(sessionId as SessionId)
          if (agent) void this.configureLead(agent).catch(error => {
            this.hostCtx.logger.warn(`orchestrator: configure lead failed: ${String(error)}`)
          })
        })
        const offCreated = this.hostCtx.on('agent/created', async ({ agent }) => {
          await this.configureAgent(agent).catch(error => {
            this.hostCtx.logger.warn(`orchestrator: configure agent failed: ${String(error)}`)
          })
        })
        // 定时任务标记：schedule 服务每次提交变更（创建/更新/删除/投递）后广播，防抖后全量核对。
        const offScheduleChanged = (this.hostCtx.on as (name: string, listener: () => void) => () => void)
          .call(this.hostCtx, 'schedule/changed', () => this.queueScheduleMarkSync())
        // 归档准入：有进行中任务的受管子会话向平台瀑布上报活动，归档被拦截报错（与 dsh-schedule 同机制）。
        const offActivity = (this.hostCtx.on as (name: string, listener: (payload: { sessionId: string }, next: () => Promise<SessionActivityGroup[]>) => Promise<SessionActivityGroup[]>) => () => void)
          .call(this.hostCtx, 'workspace/session-activity', async ({ sessionId }, next) => {
            const rest = await next()
            const conv = this.conversationByChild(String(sessionId))
            const active = conv?.activeTaskId ? this.taskById(conv.activeTaskId) : undefined
            if (!conv || !active || !isUnfinishedTask(active.status)) return rest
            return [{ kind: 'orchestrator', items: [{ id: conv.id, label: `任务进行中：${active.subject}` }] }, ...rest]
          })
        this.recoveryTimer = setInterval(() => { void this.recoverDeliveries() }, RECOVERY_INTERVAL_MS)
        this.recoveryTimer.unref()
        return async () => {
          offPreset()
          offCreated()
          offScheduleChanged()
          offActivity()
          if (this.scheduleSyncTimer) clearTimeout(this.scheduleSyncTimer)
          if (this.recoveryTimer) clearInterval(this.recoveryTimer)
          this.pendingAnswers.close()
          await this.chain.catch(() => undefined)
          await domain.close()
        }
      }, 'may-orchestrator:lifecycle')

      await this.recoverRuntimeState()
      void this.recoverDeliveries()
      void this.syncScheduleMarks().catch(error => {
        this.hostCtx.logger.warn(`orchestrator: initial schedule mark sync failed: ${String(error)}`)
      })
    } catch (error) {
      await domain.close().catch(closeError => {
        this.hostCtx.logger.warn(`orchestrator: close storage after failed startup: ${String(closeError)}`)
      })
      throw error
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.chain.then(work, work)
    this.chain = run.then(() => undefined, () => undefined)
    return run
  }

  private requireDomain(): DomainType {
    if (!this.domain) throw new Error('orchestrator storage is not ready')
    return this.domain
  }

  private conversations() { return this.requireDomain().table('conversations') }
  private tasks() { return this.requireDomain().table('tasks') }
  private schedules() { return this.requireDomain().table('schedules') }

  /** 某会话的日程（创建时间序）。 */
  private schedulesOf(conversationId: string): ScheduleRecord[] {
    return [...this.schedules().entries()]
      .map(([, item]) => item)
      .filter(item => item.conversationId === conversationId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  }

  private snapshotFor(parentSessionId: string): Snapshot {
    const conversations = [...this.conversations().entries()]
      .map(([, conv]) => conv)
      .filter(conv => conv.parentSessionId === parentSessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(conv => this.scheduleMarks.get(conv.childSessionId) ? { ...conv, hasActiveSchedule: true } : conv)
    const ids = new Set(conversations.map(conv => conv.id))
    const titles = new Map(conversations.map(conv => [conv.id, conv.title]))
    const tasks = [...this.tasks().entries()]
      .map(([, task]) => task)
      .filter(task => ids.has(task.conversationId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const schedules = [...this.schedules().entries()]
      .map(([, item]) => item)
      .filter(item => item.parentSessionId === parentSessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(item => ({ ...item, conversationTitle: titles.get(item.conversationId) ?? '' }))
    return { conversations, tasks, schedules }
  }

  async snapshot(request: SnapshotRequest): Promise<Snapshot> {
    await this.ready
    return this.snapshotFor(request.parentSessionId)
  }

  /** 看板用户画勾/取消画勾日程（会话页与日程页同一入口）；持久化并驱动看板刷新。 */
  async setScheduleStatus(request: SetScheduleStatusRequest): Promise<{ ok: true }> {
    await this.ready
    await this.serialize(async () => {
      const item = this.schedules().get(request.scheduleId)
      if (!item) throw new Error(`schedule not found: ${request.scheduleId}`)
      const now = timestamp()
      await this.schedules().put(item.id, {
        ...item,
        status: request.status,
        completedBy: request.status === 'done' ? 'user' as const : undefined,
        updatedAt: now,
      })
      this.emitChanged()
      return
    })
    return { ok: true as const }
  }

  private conversationById(id: string): ConversationRecord | undefined {
    return this.conversations().get(id)
  }

  private conversationByChild(childSessionId: string): ConversationRecord | undefined {
    for (const [, conv] of this.conversations().entries()) {
      if (conv.childSessionId === childSessionId) return conv
    }
    return undefined
  }

  private taskById(id: string): TaskRecord | undefined {
    return this.tasks().get(id)
  }

  private emitChanged(): void {
    try {
      ;(this.hostCtx as any).emit('commands/change')
    } catch (error) {
      this.hostCtx.logger.warn(`orchestrator: changed event failed: ${String(error)}`)
    }
  }

  private async putPair(conv: ConversationRecord, task?: TaskRecord): Promise<void> {
    // Write the task before the conversation that references it so a crash cannot leave activeTaskId dangling.
    if (task) await this.tasks().put(task.id, task)
    await this.conversations().put(conv.id, conv)
    this.emitChanged()
  }

  private async registerPresets(): Promise<void> {
    const disposers: Array<() => Promise<void>> = []
    this.hostCtx.effect(() => () => Promise.allSettled(disposers.map(dispose => dispose())))
    for (const definition of buildPresetDefinitions()) {
      disposers.push(await this.hostCtx.agentPresets.register(definition))
    }
  }

  private composedPreset(agent: Agent): string | undefined {
    try { return this.hostCtx.agentPresets.composedPreset(agent.ctx) }
    catch { return agent.session.header.agentPreset }
  }

  private async configureAgent(agent: Agent): Promise<void> {
    await this.ready
    const conv = this.conversationByChild(String(agent.session.id))
    if (conv) {
      await this.configureWorker(agent)
      return
    }
    if (delegationDepthOf(agent) === 0 && this.composedPreset(agent) === LEAD_PRESET) {
      await this.configureLead(agent)
    }
  }

  private async resetInstalled(key: string): Promise<void> {
    const timer = this.todoTimers.get(key)
    if (timer) {
      clearTimeout(timer)
      this.todoTimers.delete(key)
    }
    this.pendingTodoSteps.delete(key)
    const disposers = this.installed.get(key) ?? []
    this.installed.delete(key)
    const results = await Promise.allSettled(disposers.map(dispose => Promise.resolve().then(dispose)))
    for (const result of results) {
      if (result.status === 'rejected') {
        this.hostCtx.logger.warn(`orchestrator: agent scope teardown failed: ${String(result.reason)}`)
      }
    }
  }

  private keep(agent: Agent, disposer: () => unknown): void {
    const key = String(agent.session.id)
    const list = this.installed.get(key) ?? []
    list.push(disposer)
    this.installed.set(key, list)
  }

  private async configureLead(agent: Agent): Promise<void> {
    await this.resetInstalled(String(agent.session.id))
    const scoped = agent.ctx
    this.keep(agent, scoped.systemPrompt.section({
      name: 'orchestrator:roster',
      order: 610,
      text: () => this.renderRoster(String(agent.session.id)),
      interpolate: false,
    }))
    // 遮蔽与主控无关的全局提示段（记忆写入手册、qqmail 公告）：这些能力的使用方是 Worker。
    for (const sectionName of LEAD_SUPPRESSED_SECTIONS) {
      this.keep(agent, scoped.systemPrompt.section({ name: sectionName, order: 0, text: '', interpolate: false }))
    }
    this.applyLeadToolDenylist(agent)
    // Lead 侧覆盖 genui skill：Lead 不生成卡片，即使 invoke 也读到 card 通道而非围栏教学。
    this.registerGenuiCardSkill(agent, scoped)
    let memoryReady = false
    const ensureMemory = async () => {
      if (memoryReady) return
      const webServer = this.hostCtx.get('webServer') as { getOrigin(): string } | undefined
      if (!webServer) throw new Error('记忆会话门控需要 webServer 服务')
      // 原生接口通过持久化会话定位配置，新建会话先落盘。
      await this.hostCtx.sessions.flush(agent.session)
      await configureLeadMemory(String(agent.session.id), webServer.getOrigin())
      memoryReady = true
    }
    this.keep(agent, scoped.on('llm/stream', async function* (_options, next) {
      // 初始化失败时在真正推理前重试；策略未建立则拒绝请求，不能默默开放记忆写入。
      await ensureMemory()
      yield* next()
    }))
    try { await ensureMemory() }
    catch (error) {
      this.hostCtx.logger.warn(`orchestrator: Lead 只读记忆策略未建立，推理前将重试：${String(error)}`)
    }
    for (const tool of this.leadTools(agent)) this.keep(agent, scoped.tools.register(tool as any))
  }

  /** 注册 runtime 版 genui skill，覆盖 dsh-genui 原版的正文围栏教学。 */
  private registerGenuiCardSkill(agent: Agent, scoped: Agent['ctx']): void {
    try {
      const skills = scoped.get?.('skills') as {
        register(skill: { name: string, description: string, invocation: { modelInvocable: boolean, userInvocable: boolean }, source: string, provider: string, content: string }): () => void
      } | undefined
      if (!skills) return
      // runtime skill 的内置 rank 低于 provider skill（250 < 600），同名时稳定胜出。
      const skill = {
        name: 'genui',
        description: GENUI_CARD_SKILL_DESCRIPTION,
        invocation: { modelInvocable: true, userInvocable: true } as const,
        source: 'runtime' as const,
        provider: 'dsh-orchestrator',
        content: GENUI_CARD_SKILL_CONTENT,
      }
      this.keep(agent, skills.register(skill))
    } catch (error) {
      this.hostCtx.logger.warn(`orchestrator: genui card skill registration failed: ${String(error)}`)
    }
  }

  /** 全局工具可能晚注册；按变化刷新 agent 限制，作用域自身变动不重复挂载。 */
  private watchToolPolicy(agent: Agent, select: (names: string[]) => string[]): void {
    let signature = ''
    let updating = false
    let release: (() => unknown) | undefined
    const refresh = () => {
      if (updating) return
      const names = [...new Set(this.hostCtx.get('tools')!.schemas().map(schema => schema.name))]
      const deny = select(names)
      const next = JSON.stringify(deny.sort())
      if (next === signature) return
      updating = true
      try {
        const replacement = deny.length > 0 ? agent.ctx.tools.restrict({ deny }) : undefined
        release?.()
        release = replacement
        signature = next
      } finally { updating = false }
    }
    refresh()
    this.keep(agent, this.hostCtx.on('tools/change', refresh))
    this.keep(agent, () => { updating = true; return release?.() })
  }

  private applyLeadToolDenylist(agent: Agent): void {
    try {
      this.watchToolPolicy(agent, names => {
        const unrecognized = unrecognizedGlobalTools(names)
        if (unrecognized.length > 0) {
          this.hostCtx.logger.warn(`orchestrator: unrecognized global tools visible to Lead: ${unrecognized.join(', ')} — review LEAD_TOOL_DENY in lead-policy.ts`)
        }
        return leadToolDenyList(names)
      })
    } catch (error) {
      this.hostCtx.logger.warn(`orchestrator: lead tool denylist failed: ${String(error)}`)
    }
  }

  private async configureWorker(agent: Agent): Promise<void> {
    await this.resetInstalled(String(agent.session.id))
    // Worker 切换为完全访问权限（沙箱全开放 + 审批 never）：后台执行无人值守，
    // 默认 workspace-write+ask 会让敏感操作停在审批上永远等不到人。
    // 该选择按会话持久化（sandbox/mode 与 approval/policy 事件），重复调用为 no-op；Lead 不受影响。
    // 注意：cordis 4 的 context proxy 对未 inject 的服务属性访问直接抛错
    // （cannot get property "permissionPresets" without inject），可选服务必须用 ctx.get。
    try {
      const presets = this.hostCtx.get?.('permissionPresets') as { set(session: unknown, name: string): void } | undefined
      if (!presets) this.hostCtx.logger.warn('orchestrator: permissionPresets service unavailable; worker stays on default preset')
      else presets.set(agent.session, 'danger-full-access')
    } catch (error) {
      this.hostCtx.logger.warn(`orchestrator: worker permission preset unavailable: ${String(error)}`)
    }
    const wanted = WORKER_PRESET
    try {
      if (this.composedPreset(agent) !== wanted) await this.hostCtx.agentPresets.select(agent, wanted)
    } catch (error) {
      // 冷恢复或已有首个 turn 时，select 会锁定；仍需重绑 live scope，保证本次打开使用 Worker 能力。
      this.hostCtx.logger.warn(`orchestrator: worker preset select ${wanted} unavailable: ${String(error)}`)
      try {
        if (this.composedPreset(agent) !== wanted) await this.hostCtx.agentPresets.recompose(agent.ctx, wanted)
      } catch (recomposeError) {
        this.hostCtx.logger.warn(`orchestrator: worker preset ${wanted} unavailable: ${String(recomposeError)}`)
      }
    }

    const scoped = agent.ctx
    // 不做工具白名单裁剪：宿主与用户安装的其他工具（浏览器、MCP、技能等）对 Worker 全部可见；
    // 通用行为约束和 task_* 上报协议已固化在 WORKER_PRESET 的 persona 中。
    // restrict 从工具清单里直接移除（模型看不到），比 guard（可见但调用报错）更干净。
    try {
      this.watchToolPolicy(agent, names => names.filter(name => isWorkerToolForbidden(name) !== undefined))
    } catch (error) {
      this.hostCtx.logger.warn(`orchestrator: worker tool restrict failed, fallback to guard: ${String(error)}`)
      this.keep(agent, scoped.tools.guard(exec => isWorkerToolForbidden(exec.name)))
    }
    // 遮蔽与 Worker 任务无关的全局系统提示段（DSH 自举开发说明、Web GUI/HMR 说明、
    // 面向终端用户的文件卡片/Markdown 链接指引），每个子会话可省约 2.2k 字符；
    // scoped 同名 section 只影响本子会话，主会话仍保留。
    for (const sectionName of WORKER_SUPPRESSED_SECTIONS) {
      this.keep(agent, scoped.systemPrompt.section({ name: sectionName, order: 0, text: '', interpolate: false }))
    }
    // Runtime skill 覆盖 dsh-genui 原版 skill（runtime rank 250 < provider rank 600）；通道改为 task_completed 的 card。
    this.registerGenuiCardSkill(agent, scoped)
    this.keep(agent, scoped.on('session/event', (session, event) => {
      if (String(session.id) !== String(agent.session.id)) return
      const ev = event as unknown as { type?: unknown; data?: { todos?: unknown; reason?: unknown; source?: { kind?: unknown } } }
      if (ev.type === 'user/message') {
        const kind = ev.data?.source?.kind
        if (typeof kind === 'string') this.lastInboundSource.set(String(agent.session.id), kind)
        return
      }
      if (ev.type === 'todo/write') {
        this.queueTodoProgress(String(agent.session.id), ev.data?.todos)
        return
      }
      if (ev.type === 'turn/end') {
        const childId = String(agent.session.id)
        // 定时标记双触发：轮次内可能创建/修改/删除了 schedule，turn/end 后必已提交，
        // 不依赖 schedule/changed 的传播即可让定时标记及时刷新。
        this.queueScheduleMarkSync()
        const until = this.revisionTurnEnds.get(childId)
        if (until) {
          this.revisionTurnEnds.delete(childId)
          if (Date.now() <= until) return // 改单 cancel 的预期内轮次结束，不是手动停止。
        }
        const cause = classifyWorkerTurnEnd(ev.data?.reason)
        void this.onWorkerTurnEnd(childId, cause).catch(error => {
          this.hostCtx.logger.warn(`orchestrator: worker turn/end handler failed: ${String(error)}`)
        })
      }
    }))
    const reportToolExecute = async (status: TaskReportStatus, args: unknown, exec: ToolRunContext) => {
      const result = await this.reportFromWorker(status, args, String(agent.session.id), exec.signal)
      // 终态（completed/failed）后无需再做一次全上下文推理：标记 concludeTurn 结束本轮。
      const resultStatus = (result as { status?: string }).status
      if (statusConcludesTurn(resultStatus)) exec.concludeTurn?.()
      return toJson(result)
    }
    const statusReportTools = [
      {
        name: 'task_running',
        status: 'running',
        parameters: TASK_RUNNING_TOOL_PARAMETERS,
        description: '任务进行中上报：开始任务和每个关键步骤后各刷一条，保持看板实时。',
      },
      {
        name: 'task_input_required',
        status: 'input_required',
        parameters: TASK_INPUT_REQUIRED_TOOL_PARAMETERS,
        description: '需要用户补充信息、做选择或接管浏览器/系统确认时上报：工具调用阻塞，返回值即用户在问题卡的作答，拿到答案同轮继续。',
      },
      {
        name: 'task_completed',
        status: 'completed',
        parameters: TASK_COMPLETED_TOOL_PARAMETERS,
        description: '任务成功收尾：result 只写无路径的简短结论，card 承载结构化明细，artifacts 只交付关键文件，三者不重复。提交后本轮立即结束。定时触发轮次无活动任务时也只允许本工具上报结果。',
      },
      {
        name: 'task_failed',
        status: 'failed',
        parameters: TASK_FAILED_TOOL_PARAMETERS,
        description: '任务本身没做成（要拿的内容没拿到、要执行的操作没成功）时上报；调查有结论（如目标不可达）用 task_completed。提交后本轮立即结束。',
      },
    ] as const
    for (const tool of statusReportTools) {
      this.keep(agent, scoped.tools.register(defineTool({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        output: sharedJsonOutput,
        execute: (args: any, exec: ToolRunContext) => reportToolExecute(tool.status, args, exec),
      })))
    }
    this.keep(agent, scoped.tools.register(defineTool({
      name: 'task_schedule',
      description: '用户日程维护（与任务状态无关，随时可调用）：创建/更新需要用户本人推进的日程，返回最新日程清单（含 id）。',
      parameters: TASK_SCHEDULE_TOOL_PARAMETERS,
      output: sharedJsonOutput,
      execute: async (args: unknown) => toJson(await this.scheduleFromWorker(args, String(agent.session.id))),
    })))
  }

  private armRevisionTurnGuard(childSessionId: string): void {
    // cancel 的取消效果异步到达：下一次 turn/end 属于旧轮次，必须忽略。
    // 守卫过期后不再吞掉新任务真正的结束信号。
    this.revisionTurnEnds.set(childSessionId, Date.now() + REVISION_GUARD_MS)
  }

  private queueTodoProgress(childSessionId: string, rawTodos: unknown): void {
    const conv = this.conversationByChild(childSessionId)
    if (!conv?.activeTaskId) return
    const steps = normalizeProgressSteps(rawTodos)
    this.pendingTodoSteps.set(childSessionId, { taskId: conv.activeTaskId, steps })
    const existing = this.todoTimers.get(childSessionId)
    if (existing) clearTimeout(existing)
    // todo_write 是整表覆盖，短时间内可能连续触发；合并后写入并立刻通知看板刷新。
    const timer = setTimeout(() => { void this.flushTodoProgress(childSessionId) }, TODO_FLUSH_DELAY_MS)
    timer.unref()
    this.todoTimers.set(childSessionId, timer)
  }

  private async flushTodoProgress(childSessionId: string): Promise<void> {
    this.todoTimers.delete(childSessionId)
    const pending = this.pendingTodoSteps.get(childSessionId)
    this.pendingTodoSteps.delete(childSessionId)
    if (!pending) return
    await this.serialize(async () => {
      const conv = this.conversationByChild(childSessionId)
      if (!conv?.activeTaskId || conv.activeTaskId !== pending.taskId) return
      const task = this.taskById(conv.activeTaskId)
      if (!task || !(activeTaskStatuses as readonly string[]).includes(task.status)) return
      const unchanged = JSON.stringify(task.progressSteps ?? []) === JSON.stringify(pending.steps)
      if (unchanged) return
      const now = timestamp()
      const nextTask: TaskRecord = {
        ...task,
        revision: task.revision + 1,
        updatedAt: now,
        status: 'running',
        startedAt: task.startedAt ?? now,
        progressSteps: pending.steps,
      }
      await this.tasks().put(task.id, nextTask)
      this.emitChanged()
    }).catch(error => {
      this.hostCtx.logger.warn(`orchestrator: sync todo/write failed: ${String(error)}`)
    })
  }

  private renderRoster(parentSessionId: string): string {
    const { conversations } = this.snapshotFor(parentSessionId)
    if (conversations.length === 0) return 'Orchestrator roster: empty.'
    const lines = conversations.map((conv) => {
      const active = conv.activeTaskId ? this.taskById(conv.activeTaskId) : undefined
      const last = conv.lastTaskId ? this.taskById(conv.lastTaskId) : undefined
      const taskSegment = rosterTaskSegment(active, last)
      const schedules = this.schedulesOf(conv.id)
      const pending = schedules.filter(schedule => schedule.status === 'pending')
      const todoSegment = schedules.length === 0
        ? ''
        : pending.length > 0
          ? `｜日程 ${pending.length} 项待处理：${pending.slice(0, 3).map(schedule => schedule.title).join('、')}${pending.length > 3 ? '…' : ''}`
          : `｜日程 ${schedules.length} 项全部完成`
      return `- ${conv.id} [${conv.state}] ${conv.title}${taskSegment}｜更新 ${formatRosterTime(conv.updatedAt)}${todoSegment}`
    })
    return `Orchestrator roster（dispatch 用 conversationId 复用子会话；get 看详情）：\n${lines.join('\n')}`
  }

  private leadTools(agent: Agent) {
    const parentId = () => String(agent.session.id)
    return [
      defineTool({
        name: 'orchestrator_dispatch',
        description: '新建工作流，或把新需求派发给已有持久子会话；目标会话正忙时会自动中断旧任务并把新需求注入同一子会话。',
        parameters: DISPATCH_TOOL_PARAMETERS,
        output: sharedJsonOutput,
        execute: async (args: any) => toJson(await this.dispatch(args, agent)),
      }),
      defineTool({
        name: 'orchestrator_get',
        description: '读取一个工作流的路由卡摘要和任务列表，不读取子会话全文。',
        parameters: { conversationId: { type: 'string', required: true } },
        output: sharedJsonOutput,
        execute: async (args: unknown) => {
          const parsed = conversationIdInputSchema.safeParse(args)
          if (!parsed.success) return toJson({ error: 'conversation not found' })
          const { conversationId } = parsed.data
          const conv = this.conversationById(conversationId)
          if (!conv || conv.parentSessionId !== parentId()) return toJson({ error: 'conversation not found' })
          const tasks = [...this.tasks().entries()]
            .map(([, task]) => task)
            .filter(task => task.conversationId === conv.id)
            .map(task => ({
              subject: task.subject,
              status: task.status,
              ...task.progressNote ? { progressNote: task.progressNote } : {},
              ...task.questions?.length ? { questions: task.questions } : {},
              ...task.result ? { answer: task.result } : {},
              ...task.artifacts?.length ? { artifacts: task.artifacts } : {},
              ...task.error ? { error: task.error, ...task.reasonCode ? { reasonCode: task.reasonCode } : {} } : {},
              updatedAt: task.updatedAt,
            }))
          const schedules = this.schedulesOf(conv.id).map(schedule => ({
            id: schedule.id,
            title: schedule.title,
            status: schedule.status,
            priority: schedule.priority,
            ...schedule.allDay ? { allDay: true } : {},
            ...schedule.startAt ? { startAt: schedule.startAt } : {},
            ...schedule.endAt ? { endAt: schedule.endAt } : {},
            ...schedule.remindAt ? { remindAt: schedule.remindAt } : {},
            ...schedule.location ? { location: schedule.location } : {},
            ...schedule.links.length ? { links: schedule.links } : {},
            ...schedule.contacts.length ? { contacts: schedule.contacts } : {},
            ...schedule.attachments.length ? { attachments: schedule.attachments } : {},
            ...schedule.remark ? { remark: schedule.remark } : {},
          }))
          return toJson({
            title: conv.title,
            state: conv.state,
            ...conv.workspaceName ? { workspaceName: conv.workspaceName } : {},
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            outline: { summary: conv.outline.summary },
            schedules,
            tasks,
          })
        },
      }),
    ]
  }

  private async dispatch(rawArgs: unknown, parent: Agent): Promise<any> {
    const parsed = dispatchInputSchema.safeParse(rawArgs)
    if (!parsed.success) return { kind: 'error', error: parsed.error.issues[0]?.message ?? 'invalid orchestrator_dispatch arguments' }
    const args: DispatchInput = parsed.data
    const parentSessionId = String(parent.session.id)

    let provisioned: DispatchProvision
    try {
      provisioned = await this.serialize(() => this.provisionDispatch(args, parent, parentSessionId))
    } catch (error) {
      return { kind: 'error', error: String(error instanceof Error ? error.message : error) }
    }
    if (provisioned.ok === false) return provisioned.result
    return { ok: true, status: 'background', conversationId: provisioned.conv.id }
  }

  private async provisionDispatch(
    args: DispatchInput,
    parent: Agent,
    parentSessionId: string,
  ): Promise<DispatchProvision> {
    let conv: ConversationRecord
    let task: TaskRecord
    const at = timestamp()

    if (args.conversationId) {
      const existing = this.conversationById(args.conversationId)
      if (!existing || existing.parentSessionId !== parentSessionId) return { ok: false, result: { kind: 'error', error: 'conversation not found' } }

      // 改需求：先在存储里原子完成“旧任务 interrupted + 新任务 active”，再取消子会话当前轮次，
      // 最后用 followup 把新需求注入同一个持久子会话。这样旧轮次的 turn/end 到达时不会把旧任务误判为 failed。
      let interruptedTaskId: string | undefined
      if (existing.activeTaskId) {
        const active = this.taskById(existing.activeTaskId)
        if (active && isUnfinishedTask(active.status)) {
          interruptedTaskId = active.id
        }
      }

      task = buildTask(args, {
        id: createId('task'),
        parentSessionId,
        conversationId: existing.id,
        predecessorTaskId: existing.lastTaskId,
      })
      conv = interruptedTaskId
        ? reviseConversation(existing, task.id, at)
        : activateConversation(existing, task.id, at)
      // subject 与会话标题同源：复用时主题有变化则同步更新会话标题（看板/roster/侧栏一致）。
      const titleChanged = args.subject !== existing.title
      if (titleChanged) conv = { ...conv, title: args.subject }
      conv = appendOutlineSubject(conv, args.subject)
      if (interruptedTaskId) {
        const active = this.taskById(interruptedTaskId)
        if (active) {
          const interruptedTask = interruptTaskForRevision(active, `被新需求「${args.subject}」接管`, at)
          await this.tasks().put(interruptedTaskId, interruptedTask)
          // cancel 会异步带来一次旧轮次的 turn/end；那是改单的预期结果，不是任务失败。
          this.armRevisionTurnGuard(existing.childSessionId)
        }
      }
      await this.putPair(conv, task)

      if (interruptedTaskId) {
        this.pendingAnswers.cancel(interruptedTaskId, new Error('任务已被新需求接管，停止等待用户作答'))
        // cancel 本身失败不应拖垮新任务：取消当前轮次后照常注入，新需求在旧轮次收敛后运行。
        try {
          await this.interruptWorker(existing.childSessionId)
        } catch (interruptError) {
          this.hostCtx.logger.warn(`orchestrator: cancel before revise failed, continue with inject: ${String(interruptError)}`)
        }
      }
      try {
        const text = (interruptedTaskId ? revisionPrompt(task) : workerPrompt(task)) + scheduleStatusSection(this.schedulesOf(conv.id))
        // 取消后的 followup 会排队并在被中止轮次收敛为 idle 后开启新一轮（agent-loop 的 wake 收敛语义）。
        await this.deliverToWorker(
          conv.childSessionId, text,
          `orchestrator ${interruptedTaskId ? 'revise' : 'task'} ${task.subject}`,
        )
        if (titleChanged) await this.renameWorkerSession(conv.childSessionId)
      } catch (error) {
        return { ok: false, result: await this.failLaunch(conv, task, error) }
      }
    } else {
      const conversationId = createId('conv')
      const taskId = createId('task')
      const childSessionId = randomUUID()
      const parentCwd = parent.session.header.cwd
      if (!parentCwd) throw new Error('当前主会话缺少工作区，无法创建子会话工作区')
      if (!args.workspaceName) throw new Error('新建子会话缺少 workspaceName（英文小写 slug）')
      const workspace = await buildChildWorkspace(parentCwd, args.workspaceName)
      await mkdir(workspace.dir, { recursive: true })
      const provisional = createConversation({
        id: conversationId,
        childSessionId,
        parentSessionId,
        title: args.subject,
        workspaceName: workspace.name,
        workspaceDir: workspace.dir,
      })
      conv = appendOutlineSubject({ ...provisional, activeTaskId: taskId, lastTaskId: taskId }, args.subject)
      task = buildTask(args, { id: taskId, parentSessionId, conversationId, predecessorTaskId: null })
      await this.putPair(conv, task)
      try {
        await this.createWorkerAgent(childSessionId, workspace.dir, parent, conv.title)
        await this.deliverToWorker(childSessionId, workerPrompt(task) + scheduleStatusSection(this.schedulesOf(conv.id)), `orchestrator task ${task.subject}`)
      } catch (error) {
        return { ok: false, result: await this.failLaunch(conv, task, error) }
      }
    }

    // 快速 Worker 可能在 inbox 接受与此处收尾之间已提交终态；只补 queued -> running，不回滚终态。
    const acceptedTask = this.taskById(task.id)
    const acceptedConv = this.conversationById(conv.id)
    if (acceptedTask && acceptedConv) {
      const now = timestamp()
      const nextTask = acceptedTask.status === 'queued'
        ? { ...acceptedTask, revision: acceptedTask.revision + 1, updatedAt: now, status: 'running' as const, startedAt: acceptedTask.startedAt ?? now }
        : acceptedTask
      const nextConv = acceptedConv.state === 'provisioning' ? startConversation(acceptedConv, now) : acceptedConv
      if (nextTask !== acceptedTask || nextConv !== acceptedConv) await this.putPair(nextConv, nextTask)
      conv = nextConv
      task = nextTask
    }
    return { ok: true, conv, task }
  }

  /** 在 withoutInitiator 上下文里解析并操作一个会话 Agent；解析失败直接抛出。 */
  private async withAgent<T>(sessionId: string, work: (agent: Agent) => T | Promise<T>): Promise<T> {
    return this.hostCtx.agents.withoutInitiator(async () => {
      const resolved = await this.hostCtx.sessionController.resolveAgent(sessionId as SessionId)
      if ('error' in resolved) throw resolved.error
      return work(resolved.agent)
    })
  }

  /** 宿主 schedule 服务（本地结构化类型，组合未挂载时整体降级为无标记）。 */
  private scheduleService(): ScheduleServiceLike | undefined {
    return this.hostCtx.get?.('schedule') as ScheduleServiceLike | undefined
  }

  private queueScheduleMarkSync(): void {
    if (this.scheduleSyncTimer) clearTimeout(this.scheduleSyncTimer)
    this.scheduleSyncTimer = setTimeout(() => {
      this.scheduleSyncTimer = undefined
      void this.syncScheduleMarks().catch(error => {
        this.hostCtx.logger.warn(`orchestrator: schedule mark sync failed: ${String(error)}`)
      })
    }, SCHEDULE_SYNC_DEBOUNCE_MS)
    this.scheduleSyncTimer.unref()
  }

  /**
   * 核对全部受管子会话的活动定时任务：更新看板标记（hasActiveSchedule）。
   * 单会话 list 失败跳过该会话，不影响其余；DSH 侧栏标题不加图标前缀。
   */
  private async syncScheduleMarks(): Promise<void> {
    const schedule = this.scheduleService()
    if (!schedule) return
    for (const [, conv] of this.conversations().entries()) {
      let marked: boolean
      try {
        marked = (await schedule.list({ sessionId: conv.childSessionId })).length > 0
      } catch (error) {
        this.hostCtx.logger.warn(`orchestrator: schedule list failed for ${conv.childSessionId}: ${String(error)}`)
        continue
      }
      const previous = this.scheduleMarks.get(conv.childSessionId) ?? false
      this.scheduleMarks.set(conv.childSessionId, marked)
      if (previous !== marked) this.emitChanged()
    }
  }

  /**
   * 子会话标题同步：DSH 侧栏标题 = 看板标题（dispatch 改主题时调用）；与上次同步值一致则跳过，
   * rename 失败仅告警。
   */
  private async renameWorkerSession(childSessionId: string): Promise<void> {
    const conv = this.conversationByChild(childSessionId)
    if (!conv) return
    const desired = conv.title
    if (this.syncedTitles.get(childSessionId) === desired) return
    try {
      await this.withAgent(childSessionId, agent => this.hostCtx.sessionTitle.rename(agent.session, desired))
      this.syncedTitles.set(childSessionId, desired)
    } catch (error) {
      this.hostCtx.logger.warn(`orchestrator: rename worker session failed: ${String(error)}`)
    }
  }

  /**
   * Worker 的模型选项。Agent.options 只是会话创建时的快照：用户在主会话里切换模型走
   * 会话级选择（model/selection 事件 + requestHeader），不回写 options。这里按
   * session-controller 内部 selectionFor 的同一顺序解析主会话当前生效模型——
   * 会话级 pending 选择 → 最近请求头 → 全局默认——覆盖 provider/model/reasoningEffort；
   * 任一步读取失败回退到创建快照。Worker 首个请求头落盘后，后续轮次沿用它。
   */
  private workerModelOptions(parent: Agent): Agent['options'] {
    try {
      const projections = (this.hostCtx as unknown as { sessionProjections?: SessionProjectionsLike }).sessionProjections
      const pending = projections?.stateOf(parent.session, 'modelSelection')?.pending
      if (pending?.provider && pending.model) {
        return {
          ...parent.options,
          provider: pending.provider,
          model: pending.model,
          ...pending.reasoningEffort ? { reasoningEffort: pending.reasoningEffort } : {},
        }
      }
      const header = parent.session.requestHeader()
      if (header?.config.provider && header.config.model) {
        const keepEffort = header.config.reasoningEffort !== undefined && header.adapterDefaults?.reasoningEffort !== true
        return {
          ...parent.options,
          provider: header.config.provider,
          model: header.config.model,
          ...keepEffort ? { reasoningEffort: header.config.reasoningEffort } : {},
        }
      }
      const defaults = (this.hostCtx as unknown as { agentDefaultModel?: AgentDefaultModelLike }).agentDefaultModel
      const fallback = defaults?.currentSelection()
      if (fallback?.provider && fallback.model) {
        return {
          ...parent.options,
          provider: fallback.provider,
          model: fallback.model,
          ...fallback.reasoningEffort ? { reasoningEffort: fallback.reasoningEffort } : {},
        }
      }
    } catch (error) {
      this.hostCtx.logger.warn(`orchestrator: read lead model selection failed: ${String(error)}`)
    }
    return { ...parent.options }
  }

  /**
   * 创建根级别的 Worker 会话：与主会话同为一等会话（不带 origin/delegationDepth 的
   * subagent 血统），因此 schedule 等只对 depth-0 会话开放的宿主能力对 Worker 可用。
   * cwd 与 agentPreset 直接写入 session header，冷恢复后保持不变；模型继承主会话当前生效的选择。
   */
  private async createWorkerAgent(childSessionId: string, cwd: string, parent: Agent, title: string): Promise<void> {
    await this.hostCtx.agents.withoutInitiator(async () => {
      const handle = await this.hostCtx.agents.create({
        sessionId: childSessionId as SessionId,
        meta: { cwd, agentPreset: WORKER_PRESET },
        agentOptions: this.workerModelOptions(parent),
        signal: AbortSignal.timeout(LAUNCH_ACCEPT_TIMEOUT_MS),
      })
      try {
        // 自动标题只响应真人消息（source=orchestrator 的任务注入不触发），显式命名为任务主题。
        this.hostCtx.sessionTitle.rename(handle.agent.session, title)
        this.syncedTitles.set(childSessionId, title)
      } catch (titleError) {
        this.hostCtx.logger.warn(`orchestrator: rename worker session failed: ${String(titleError)}`)
      }
    })
  }

  /**
   * 向 Worker 会话投递任务消息：resolveAgent 恢复冷会话后 followup 排队（空闲即开轮；
   * 改单时排在被中止轮次之后运行）。消息经 flush 落盘后才算投递成功，
   * 与 dsh-schedule 的提醒投递是同一机制。
   */
  private async deliverToWorker(childSessionId: string, text: string, summary: string): Promise<void> {
    await this.withAgent(childSessionId, async (agent) => {
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'orchestrator', form: 'notice', summary: summary.slice(0, 120) },
      })
      agent.followup(message)
      const flushed = await this.hostCtx.sessions.flush(agent.session)
      if (!flushed) throw new Error('Session persistence did not acknowledge orchestrator worker prompt')
    })
  }

  /** 取消 Worker 当前轮次（改单前置）：原因记为 parent，turn/end 据此归类为 revision。 */
  private async interruptWorker(childSessionId: string): Promise<void> {
    await this.withAgent(childSessionId, agent => agent.cancel({ kind: 'parent' }))
  }

  private async failLaunch(conv: ConversationRecord, task: TaskRecord, error: unknown): Promise<unknown> {
    const now = timestamp()
    if (conv.workspaceDir) await rmdir(conv.workspaceDir).catch(() => undefined)
    const failedTask = gateTaskDelivery(failTask(task, String(error), now), this.deliveryToggles())
    const failedConv = failConversation(settleConversation(conv, failedTask, now), now)
    await this.putPair(failedConv, failedTask)
    if (failedTask.delivery?.state === 'pending') void this.deliverPendingTask(failedTask.id)
    return { kind: 'error', error: String(error) }
  }


  /**
   * task_schedule 的会话级副作用：create/update 写入独立日程表
   * （Host 分配 id；update 的 id 必须属于当前会话，未知 id 抛错，不产生部分写入）。
   * 必须在 serialize 串行块内调用；路由卡摘要已改由 dispatch 侧维护。
   */
  private async scheduleFromWorker(rawArgs: unknown, childSessionId: string): Promise<unknown> {
    const parsed = taskScheduleInputSchema.safeParse(rawArgs)
    if (!parsed.success) {
      const detail = parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`).join('; ')
      throw new Error(`invalid task_schedule arguments: ${detail}`)
    }
    return this.serialize(async () => {
      const conv = this.conversationByChild(childSessionId)
      if (!conv) throw new Error('task_schedule is only available in a managed worker')
      const changes = planScheduleChanges(conv, parsed.data, this.schedulesOf(conv.id))
      for (const item of changes) {
        await this.schedules().put(item.id, item)
      }
      if (changes.length > 0) this.emitChanged()
      return { ok: true as const, schedules: scheduleProjection(this.schedulesOf(conv.id)) }
    })
  }

  private async reportFromWorker(
    status: TaskReportStatus,
    rawArgs: unknown,
    childSessionId: string,
    signal?: AbortSignal,
  ): Promise<any> {
    const parsed = taskReportInputSchemas[status].safeParse(rawArgs)
    if (!parsed.success) {
      // 全量 issues 带路径返回：模型下一轮能精准补字段，而不是猜"哪里少了字符串"。
      const detail = parsed.error.issues
        .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      throw new Error(`invalid task_${status} arguments: ${detail}`)
    }
    let input = { ...parsed.data, status } as TaskTransitionInput
    if (input.status === 'completed' && input.card !== undefined) {
      const cardError = cardValidationError(input.card)
      if (cardError) throw new Error(`invalid task_completed arguments: ${cardError}`)
    }
    if (input.status === 'input_required') {
      input = { ...input, questions: input.questions.map((item, index) => ({ ...item, id: item.id ?? `q${index + 1}` })) }
    }
    let shouldDeliver = false
    let terminalTaskId: string | undefined
    const result = await this.serialize(async () => {
      const conv = this.conversationByChild(childSessionId)
      if (!conv) throw new Error(`task_${status} is only available in a managed worker`)
      if (!conv.activeTaskId) {
        // 定时提醒触发等无活动任务的轮次：只允许 task_completed 上报，
        // 生成一条 ad-hoc 已完成任务并照常经 outbox 投递给主会话。
        if (input.status !== 'completed') {
          throw new Error(`no active task: only task_completed is allowed (e.g. schedule-fired reporting)`)
        }
        const subject = (input.result.trim().split('\n')[0] || '定时触发上报').slice(0, 60)
        const seeded = createTask({
          id: createId('task'),
          parentSessionId: conv.parentSessionId,
          conversationId: conv.id,
          predecessorTaskId: conv.lastTaskId,
          subject,
          prompt: '（定时触发或 Worker 自发上报）',
        })
        // 定时触发的入站消息带 source.kind='schedule'，据此给上报任务打定时标记（仅显示用）。
        const marked = this.lastInboundSource.get(childSessionId) === 'schedule'
        const task = gateTaskDelivery(
          transitionTask({ ...seeded, status: 'running', startedAt: seeded.createdAt, ...marked ? { scheduled: true } : {} }, input),
          this.deliveryToggles(),
        )
        await this.putPair(settleConversation(conv, task), task)
        terminalTaskId = task.id
        shouldDeliver = task.delivery?.state === 'pending'
        return { ok: true as const, status: task.status, schedules: scheduleProjection(this.schedulesOf(conv.id)) }
      }
      const previous = this.taskById(conv.activeTaskId)
      if (!previous) throw new Error('active task record is missing')

      const task = gateTaskDelivery(transitionTask(previous, input), this.deliveryToggles())
      const terminal = (terminalTaskStatuses as readonly string[]).includes(task.status)
      const isInputRequired = task.status === 'input_required'
      // input_required 不 settle（activeTaskId 保留、轮次未结束），但聚合状态要同步为待决策；
      // 其余终态照常 settle 回 idle。
      const nextConv = terminal
        ? settleConversation(conv, task)
        : isInputRequired ? awaitingConversation(conv) : conv
      await this.putPair(nextConv, task)
      if (terminal) {
        terminalTaskId = task.id
        shouldDeliver = task.delivery?.state === 'pending'
      }
      return { ok: true as const, status: task.status, schedules: scheduleProjection(this.schedulesOf(conv.id)), __inputRequired__: isInputRequired ? task : undefined }
    })
    if (shouldDeliver && terminalTaskId) void this.deliverPendingTask(terminalTaskId)
    // input_required：工具调用阻塞直到用户从任一入口作答，返回值即用户答案。
    if (result.__inputRequired__) {
      const answers = await this.blockAndWaitForAnswers(result.__inputRequired__, childSessionId, signal)
      return {
        ok: true as const,
        status: 'input_required_answered' as const,
        answers: answers.map(a => ({ id: a.id, selected: a.selected, ...a.custom !== undefined ? { custom: a.custom } : {} })),
      }
    }
    return result
  }

  /**
   * Worker 轮次结束的结算：已提交终态的任务在 settle 后 activeTaskId 为空，
   * 走到这里的都是“轮次结束了但任务没有终态”——按结束原因分为手动停止、改单中断或失败。
   */
  private async onWorkerTurnEnd(childSessionId: string, endCause: WorkerTurnEndCause | undefined): Promise<void> {
    let shouldDeliver = false
    let taskId: string | undefined
    let outcome: 'manual_stop' | 'revision' | 'failed' | undefined
    await this.serialize(async () => {
      const conv = this.conversationByChild(childSessionId)
      if (!conv?.activeTaskId) return
      const previous = this.taskById(conv.activeTaskId)
      if (!previous || !isUnfinishedTask(previous.status)) return
      const now = timestamp()
      let task: TaskRecord
      let nextConv: ConversationRecord
      if (endCause === 'manual_stop') {
        task = interruptTaskForRevision(previous, '子会话执行被手动停止；工作流已保留，可继续派发新需求', now)
        // 手动停止需要通知主会话：挂起投递，由 deliverPendingTask 发通知；静默任务与设置页关闭 interrupted 投递时除外。
        if (!task.silent && deliveryEnabledFor(this.deliveryToggles(), 'interrupted')) {
          task = { ...task, delivery: { state: 'pending', attempts: 0 } }
          shouldDeliver = true
        }
        nextConv = settleConversation(conv, task, now)
        outcome = 'manual_stop'
      } else if (endCause === 'revision') {
        task = interruptTaskForRevision(previous, '旧轮次被新需求中断', now)
        nextConv = settleConversation(conv, task, now)
        outcome = 'revision'
      } else {
        task = gateTaskDelivery(
          failTask(previous, previous.status === 'queued' ? '子会话在任务开始前结束' : '子会话结束前未提交终态上报', now),
          this.deliveryToggles(),
        )
        nextConv = failConversation(settleConversation(conv, task, now), now)
        shouldDeliver = task.delivery?.state === 'pending'
        outcome = 'failed'
      }
      await this.putPair(nextConv, task)
      this.pendingAnswers.cancel(task.id, new Error('子会话轮次已结束，停止等待用户作答'))
      taskId = task.id
    })
    if (outcome === 'manual_stop' || outcome === 'revision') {
      this.hostCtx.logger.info?.(`orchestrator: task ${taskId} interrupted by ${outcome}: ${childSessionId}`)
    }
    if (shouldDeliver && taskId) await this.deliverPendingTask(taskId)
  }

  /** 串行回写任务的投递状态（成功 delivered / 失败 attempts+1），看板经 changed 事件刷新。 */
  private async patchDelivery(taskId: string, delivery: (current: TaskRecord) => TaskRecord['delivery']): Promise<void> {
    await this.serialize(async () => {
      const current = this.taskById(taskId)
      if (!current) return
      await this.tasks().put(taskId, {
        ...current,
        revision: current.revision + 1,
        updatedAt: timestamp(),
        delivery: delivery(current),
      })
      this.emitChanged()
    })
  }

  private async deliverPendingTask(taskId: string): Promise<void> {
    if (this.delivering.has(taskId)) return
    const task = this.taskById(taskId)
    if (!task || task.silent || task.delivery?.state !== 'pending') return
    if (!(terminalTaskStatuses as readonly string[]).includes(task.status)) return
    if (!deliveryEnabledFor(this.deliveryToggles(), task.status)) {
      // 设置页已关闭该状态的投递：清掉存量 pending（不补投），状态本身已持久化、roster/看板照常可见。
      await this.patchDelivery(taskId, () => undefined)
      return
    }
    this.delivering.add(taskId)
    try {
      // input_required 由 task_input_required 阻塞处理，不走 deliverPendingTask。
      if (task.status === 'input_required') return
      await this.withAgent(task.parentSessionId, async (agent) => {
        const message = createUserMessage({
          content: [{ type: 'text', text: deliveryNotice(task, this.conversationById(task.conversationId), this.schedulesOf(task.conversationId)) }],
          source: { kind: 'orchestrator', form: 'notice', summary: `orchestrator ${task.status}: ${task.subject}`.slice(0, 120) },
        })
        agent.followup(message)
        const flushed = await this.hostCtx.sessions.flush(agent.session)
        if (!flushed) throw new Error('Session persistence did not acknowledge orchestrator delivery')
        await this.patchDelivery(taskId, () => ({ state: 'delivered', deliveredAt: timestamp(), messageId: String(message.id) }))
      })
    } catch (error) {
      try {
        await this.patchDelivery(taskId, current => current.delivery?.state === 'pending'
          ? { state: 'pending', attempts: current.delivery.attempts + 1, lastError: String(error) }
          : current.delivery)
      } catch (markError) {
        this.hostCtx.logger.warn(`orchestrator: mark delivery failure ${taskId} failed: ${String(markError)}`)
      }
      this.hostCtx.logger.warn(`orchestrator: deliver ${taskId} failed: ${String(error)}`)
    } finally {
      this.delivering.delete(taskId)
    }
  }

  /**
   * input_required 的阻塞作答：task_input_required 的工具调用本身挂起不返回。
   * 问题卡只在两个地方渲染：
   * - 子会话：平台原生 ask_user_question（Worker 是 live root，直接对 Worker 挂 ask）
   * - 任务看板：自定义 AskCard
   * 主会话完全不参与（不投递、不弹卡）。任一来源作答后 resolve，工具直接返回用户答案。
   */
  private blockAndWaitForAnswers(task: TaskRecord, childSessionId: string, signal?: AbortSignal): Promise<QuestionAnswer[]> {
    const current = this.taskById(task.id)
    if (current?.status === 'running' && current.answers) return Promise.resolve(current.answers)
    if (current?.status !== 'input_required') return Promise.reject(new Error('任务已结束，停止等待用户作答'))
    const userQuestions = (this.hostCtx as unknown as { get?(key: string): unknown }).get?.('userQuestions') as
      | { ask(request: { questions: unknown; agent: unknown; signal?: AbortSignal }): Promise<{ answers: Array<{ id: string; selected: string[]; custom?: string }> }> }
      | undefined
    const questions = (task.questions ?? []).map(item => ({
      id: item.id,
      question: item.question,
      ...item.header !== undefined ? { header: item.header } : {},
      ...item.detail !== undefined ? { detail: item.detail } : {},
      ...item.options !== undefined ? { options: item.options } : {},
      ...item.multi_select !== undefined ? { multi_select: item.multi_select } : {},
    }))

    const promise = this.pendingAnswers.wait(task.id, signal)
    const questionSignal = this.pendingAnswers.signal(task.id)
    if (userQuestions?.ask && questionSignal) {
      void this.withAgent(childSessionId, async (agent) => {
        if (questionSignal.aborted) return
        const result = await userQuestions.ask({ questions, agent, signal: questionSignal })
        if (questionSignal.aborted) return
        await this.answerTaskQuestions({ childSessionId, answers: result.answers })
      }).catch(error => {
        if (!questionSignal.aborted) this.hostCtx.logger.warn(`orchestrator: worker question card failed: ${String(error)}`)
      })
    }
    return promise
  }

  /**
   * 看板与 Worker 原生问题卡共用的作答路由：
   * 幂等——只有 input_required 的最新任务可答，先答先赢；重开同一 TaskRun 继续执行，
   * 答案直接返回同轮阻塞的 task_input_required，另一入口的问题卡同时清理。
   */
  async answerTaskQuestions(request: AnswerQuestionsRequest): Promise<AnswerQuestionsResult> {
    await this.ready
    const answers: QuestionAnswer[] = (request.answers ?? []).map(answer => ({
      id: answer.id,
      selected: answer.selected ?? [],
      ...answer.custom !== undefined ? { custom: answer.custom } : {},
    }))
    if (answers.length === 0) return { ok: false, error: 'answers is empty' }
    const outcome = await this.serialize(async () => {
      const conv = this.conversationByChild(request.childSessionId)
      if (!conv) return { ok: false as const, error: 'conversation not found' }
      const task = conv.lastTaskId ? this.taskById(conv.lastTaskId) : undefined
      if (!task || task.status !== 'input_required') return { ok: false as const, error: 'task is not awaiting input' }
      const known = new Set((task.questions ?? []).map(item => item.id))
      for (const answer of answers) {
        if (!known.has(answer.id)) return { ok: false as const, error: `unknown question id: ${answer.id}` }
      }
      const now = timestamp()
      const resumed = resumeTaskWithAnswers(task, answers, now)
      const nextConv: ConversationRecord = {
        ...conv,
        state: 'running',
        activeTaskId: resumed.id,
        revision: conv.revision + 1,
        updatedAt: now,
      }
      await this.putPair(nextConv, resumed)
      return { ok: true as const, taskId: resumed.id }
    })
    if (!outcome.ok) return outcome
    // 阻塞模型：resolve 挂起的 task_input_required 工具调用，Worker 同轮拿到答案。
    this.pendingAnswers.resolve(outcome.taskId, answers)
    return { ok: true, taskId: outcome.taskId }
  }

  private async recoverDeliveries(): Promise<void> {
    try {
      await this.ready
      const pending = [...this.tasks().entries()]
        .map(([, task]) => task)
        .filter(task => !task.silent
          && task.delivery?.state === 'pending'
          && (terminalTaskStatuses as readonly string[]).includes(task.status))
      for (const task of pending) await this.deliverPendingTask(task.id)
    } catch (error) {
      this.hostCtx.logger.warn(`orchestrator: recover deliveries failed: ${String(error)}`)
    }
  }

  /** Recover provisioning records and tasks left live by a process restart. */
  private async recoverRuntimeState(): Promise<void> {
    await this.serialize(async () => {
      const now = timestamp()
      for (const [, conv] of this.conversations().entries()) {
        const active = conv.activeTaskId ? this.taskById(conv.activeTaskId) : conv.lastTaskId ? this.taskById(conv.lastTaskId) : undefined
        if (!conv.activeTaskId && active?.status !== 'input_required') continue
        if (!active) {
          if (conv.activeTaskId) {
            // Repair a dangling reference left by a crash between cross-table writes.
            const failedConv = { ...failConversation(conv, now), activeTaskId: null }
            await this.conversations().put(failedConv.id, failedConv)
          }
          continue
        }
        if (!isUnfinishedTask(active.status)) {
          // The task row can reach a terminal state before the conversation row is updated.
          await this.putPair(settleConversation(conv, active, now), active)
          continue
        }

        if (active.status === 'input_required') {
          const interrupted = interruptTaskAfterRestart(active, now)
          await this.putPair(settleConversation(conv, interrupted, now), interrupted)
          continue
        }

        if (conv.state === 'provisioning') {
          let persistenceState: 'exists' | 'missing' | 'uncertain' = 'uncertain'
          // Control-flow analysis does not track assignment from the Promise catch callback.
          const stat = await this.hostCtx.sessionPersistence
            .stat(conv.childSessionId as SessionId, { signal: AbortSignal.timeout(PERSISTENCE_STAT_TIMEOUT_MS) })
            .catch(error => {
              persistenceState = isSessionNotFoundError(error) ? 'missing' : 'uncertain'
              return undefined
            })
          if (stat) persistenceState = 'exists'
          if ((persistenceState as string) === 'exists') {
            const nextConv = startConversation(conv, now)
            const nextTask = {
              ...active,
              revision: active.revision + 1,
              updatedAt: now,
              status: 'running' as const,
              startedAt: active.startedAt ?? now,
            }
            await this.putPair(nextConv, nextTask)
          } else if ((persistenceState as string) === 'missing') {
            const reason = 'child session was not materialized before restart'
            const nextTask = failTask(active, reason, now)
            const nextConv = failConversation(settleConversation(conv, nextTask, now), now)
            await this.putPair(nextConv, nextTask)
          } else {
            // I/O timeout/permission errors are system obstacles: do not ask a model question, and do not mark a possibly live session failed.
            const nextTask = failTask(
              active,
              '重启后无法确认子会话持久化状态，可能是存储权限或运行时 I/O 暂时不可用。已保留进展；请稍后让我继续重试，若反复出现请重启 Web 后恢复任务',
              now,
              { reasonCode: 'runtime' },
            )
            const nextConv = settleConversation(conv, nextTask, now)
            await this.putPair(nextConv, nextTask)
          }
          continue
        }

        if ((activeTaskStatuses as readonly string[]).includes(active.status)) {
          const nextTask = interruptTaskAfterRestart(active, now)
          const nextConv = settleConversation(conv, nextTask, now)
          await this.putPair(nextConv, nextTask)
        }
      }
      this.emitChanged()
    })
  }
}

export default OrchestratorService
