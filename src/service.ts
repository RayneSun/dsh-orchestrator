import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { mkdir, readdir, readFile, rename, rmdir, writeFile, appendFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import sz from '@deepseek-ai/schemastery'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { deliveryNotice, questionListText, revisionPrompt, rosterSummarySegment, scheduleProjection, scheduleStatusSection, workerPrompt } from './messages.ts'
import { type ScheduleServiceLike, type SessionActivityGroup } from './schedule-marks.ts'
import { toJson } from './json.ts'
import { isWorkerToolForbidden } from './worker-policy.ts'
import { LEAD_SUPPRESSED_SECTIONS, leadToolDenyList, unrecognizedGlobalTools } from './lead-policy.ts'
import { normalizeProgressSteps } from './progress.ts'
import { buildChildWorkspace, ensureVaultPathEnv, resolveVaultRoot } from './workspaces.ts'
import {
  MEMORY_DREAM_WORKSPACE,
  MEMORY_REFLECT_WORKSPACE,
  DREAM_IDLE_MS,
  claimDreamLease,
  finishDreamLease,
  buildDreamPrompt,
  buildReflectPrompt,
  recallMemoryEntries,
} from './memory-dream.ts'
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
  blockReasonCodes,
  deliverableTaskStatuses,
  type DeliveryToggles,
  taskUpdateStatuses,
  todoPriorities,
  dispatchInputSchema,
  conversationIdInputSchema,
  taskUpdateInputSchema,
  memoryRememberInputSchema,
  type DispatchInput,
  type TaskUpdateInput,
} from './types.ts'

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

/** ad-hoc 上报任务（定时提醒/Worker 自发上报）的 prompt 标记：创建与反思过滤共用。 */
const AD_HOC_TASK_PROMPT = '（定时触发或 Worker 自发上报）'

/** 反思工作量门槛（对齐喵记忆 reflectTurns）：任务内放行的工具步数达到该值才算"干过活"。 */
const REFLECT_MIN_TOOL_STEPS = 5

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
const WORKER_SUPPRESSED_SECTIONS = ['harness:source', 'app:web-surface', 'ui:deliverable-file-references'] as const
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

/**
 * orchestrator_dispatch 的参数描述。注意：dsh-tools 的参数 DSL 只支持
 * type/required/enum/const/items/properties/oneOf/description/title/default/examples，
 * 任何其他关键字（如 pattern）会在 defineTool 编译期直接抛错、导致工具注册失败消失。
 * 约束只能写进 description，运行时校验由 dispatchInputSchema 负责。
 */
export const DISPATCH_TOOL_PARAMETERS = {
  subject: { type: 'string', required: true, description: '短主题' },
  workspaceName: { type: 'string', description: '新建子会话必填：子工作区目录名，必须匹配 ^[a-z0-9][a-z0-9-]{0,79}$（英文小写短横线 slug，如 daily-news、plane-war）；复用已有子会话时忽略' },
  prompt: { type: 'string', required: true, description: '需求本身和验收点。Worker 与你共享同一工作区，不要重复工作目录、路径等环境声明，不要粘贴内部 ID' },
  conversationId: { type: 'string', description: '复用已有工作流时提供' },
  acceptanceCriteria: { type: 'string', description: '可选验收标准' },
  silent: { type: 'boolean', description: '静默模式：记忆整理等后台维护任务使用；终态不会向主会话投递任何消息，看板仍可见状态' },
} as const

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
   * 只决定"终态消息是否回投主会话"：task_update 的状态/摘要/待办总是持久化，
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
  /** taskId -> resolver，task_update(input_required) 阻塞等待用户作答。 */
  private readonly pendingAnswerResolvers = new Map<string, { resolve: (answers: QuestionAnswer[]) => void; reject: (error: Error) => void; abort?: AbortController }>()
  private readonly pendingTodoSteps = new Map<string, { taskId: string; steps: ProgressStep[] }>()
  private readonly todoTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // 改单 cancel 自身会产生一次 aborted turn/end，需要忽略，不能当成手动停止或任务失败。
  private readonly revisionTurnEnds = new Map<string, number>()
  /** childSessionId -> 是否绑定了活动定时任务（看板 badge 数据源，内存推导不落库）。 */
  private readonly scheduleMarks = new Map<string, boolean>()
  /** 记忆文件写入锁：按文件路径串行化 append/write，降低多 Worker 并发写同一 md 的冲突。 */
  private readonly memoryWriteLocks = new Map<string, Promise<unknown>>()
  /** childSessionId -> 最近一条入站消息的 source.kind（判定定时触发上报用）。 */
  private readonly lastInboundSource = new Map<string, string>()
  /** childSessionId -> 已同步到 DSH 侧栏的标题（含定时标记前缀），用于跳过无谓 rename。 */
  private readonly syncedTitles = new Map<string, string>()
  private scheduleSyncTimer: ReturnType<typeof setTimeout> | undefined
  private recoveryTimer: ReturnType<typeof setInterval> | undefined
  /** 记忆 Dream 空闲触发定时器。 */
  private dreamTimer: ReturnType<typeof setTimeout> | undefined
  /** 最近用户/Lead 活动时间戳，用于判定空闲。 */
  private lastActivityAt = Date.now()
  /** sessionId -> 最近一条用户问题/任务文本（记忆 BM25 召回的 query）。 */
  private readonly lastUserQuery = new Map<string, string>()
  /** taskId -> 任务期间放行的工具步数（Worker tools.guard 计数），反思工作量门槛的数据源。 */
  private readonly taskToolSteps = new Map<string, number>()

  constructor(private readonly hostCtx: Context, private readonly configRefs?: OrchestratorConfigRefs) {
    super(hostCtx, 'orchestrator', { namespace: 'orchestrator' })
    // 代码内兜底设置 DSH_VAULT_PATH（显式环境变量优先，不覆盖）：Lead/Worker/Host
    // 各处 resolveVaultRoot 与 cordis.patch.yml 的 dsh-obsidian vaultPath 无需人工
    // setx 即共享同一 vault 根。
    ensureVaultPathEnv()
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
      // inputRequired 恒为 false：问题卡只在子会话 + 看板渲染，主会话不参与投递。
      inputRequired: false,
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
            if (!conv || !active || !(activeTaskStatuses as readonly string[]).includes(active.status)) return rest
            return [{ kind: 'orchestrator', items: [{ id: conv.id, label: `任务进行中：${active.subject}` }] }, ...rest]
          })
        this.recoveryTimer = setInterval(() => { void this.recoverDeliveries() }, RECOVERY_INTERVAL_MS)
        this.recoveryTimer.unref()
        // 记忆 Dream：用户空闲 3h 后触发，优先派发 LLM 整理任务，带 lease 锁避免重复/崩溃残留。
        this.armDreamTimer()
        return async () => {
          offPreset()
          offCreated()
          offScheduleChanged()
          offActivity()
          if (this.scheduleSyncTimer) clearTimeout(this.scheduleSyncTimer)
          if (this.recoveryTimer) clearInterval(this.recoveryTimer)
          if (this.dreamTimer) clearTimeout(this.dreamTimer)
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
    const parent = this.hostCtx.agents.get(parentSessionId as SessionId)
    const vaultRoot = parent ? resolveVaultRoot(parent.session.header.cwd ?? process.cwd()) : undefined
    const conversations = [...this.conversations().entries()]
      .map(([, conv]) => conv)
      .filter(conv => conv.parentSessionId === parentSessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(conv => {
        const stripped: ConversationRecord = { ...conv, todos: [] }
        return this.scheduleMarks.get(conv.childSessionId) ? { ...stripped, hasActiveSchedule: true } : stripped
      })
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
    return { conversations, tasks, schedules, ...(vaultRoot ? { vaultRoot } : {}) }
  }

  async snapshot(request: { parentSessionId: string }): Promise<Snapshot> {
    await this.ready
    return this.snapshotFor(request.parentSessionId)
  }

  /** 看板用户画勾/取消画勾日程（会话页与日程页同一入口）；持久化并驱动看板刷新。 */
  async setScheduleStatus(request: { scheduleId: string, status: 'pending' | 'done' }): Promise<{ ok: true }> {
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
    // v2：todos 已迁移进 schedules 表，conversation 记录统一剥离该字段落盘。
    await this.conversations().put(conv.id, { ...conv, todos: [] })
    this.emitChanged()
  }

  /** v1 → v2 迁移：conv.todos 搬进 schedules 表后清空（幂等；todos 已空则跳过）。 */
  private async migrateTodosToSchedules(): Promise<void> {
    for (const [, conv] of this.conversations().entries()) {
      if (!conv.todos.length) continue
      const now = timestamp()
      for (const todo of conv.todos) {
        const item: ScheduleRecord = {
          id: createId('sch'),
          parentSessionId: conv.parentSessionId,
          conversationId: conv.id,
          title: todo.title,
          ...todo.startAt ? { startAt: todo.startAt } : {},
          ...todo.endAt ? { endAt: todo.endAt } : {},
          ...todo.remindAt ? { remindAt: todo.remindAt } : {},
          priority: todo.priority,
          links: todo.links,
          attachments: todo.attachments,
          contacts: todo.contacts,
          ...todo.location ? { location: todo.location } : {},
          ...todo.remark ? { remark: todo.remark } : {},
          status: todo.status,
          ...todo.completedBy ? { completedBy: todo.completedBy } : {},
          createdAt: todo.createdAt || now,
          updatedAt: todo.updatedAt || now,
        }
        await this.schedules().put(item.id, item)
      }
      await this.conversations().put(conv.id, { ...conv, todos: [] })
      this.hostCtx.logger.info(`orchestrator: migrated ${conv.todos.length} todos of ${conv.id} into schedules`)
    }
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
    // 自动初始化共享 vault（工作区根下仅建 kb_vault 根；session/assets 由归档任务按会话创建）
    try {
      const workspaceRoot = agent.session.header.cwd ?? process.cwd()
      const vaultRoot = resolveVaultRoot(workspaceRoot)
      await mkdir(vaultRoot, { recursive: true })
      this.hostCtx.logger.info(`orchestrator: kb_vault ready at ${vaultRoot}`)
    } catch (error) {
      this.hostCtx.logger.warn(`orchestrator: kb_vault init failed: ${String(error)}`)
    }
    const scoped = agent.ctx
    this.keep(agent, scoped.systemPrompt.section({
      name: 'orchestrator:roster',
      order: 610,
      text: () => this.renderRoster(String(agent.session.id)),
    }))
    // 遮蔽与主控无关的全局提示段（meow 记忆手册、qqmail 公告）：这些能力的使用方是 Worker。
    for (const sectionName of LEAD_SUPPRESSED_SECTIONS) {
      this.keep(agent, scoped.systemPrompt.section({ name: sectionName, order: 0, text: '', interpolate: false }))
    }
    this.applyLeadToolDenylist(agent, scoped)
    // Lead 会话收到用户消息时：记录活动推迟 Dream，并把问题文本作为记忆召回 query。
    this.keep(agent, scoped.on('session/event', (session, event) => {
      if (String(session.id) !== String(agent.session.id)) return
      const ev = event as unknown as { type?: unknown; data?: { source?: { kind?: unknown } } }
      if (ev.type === 'user/message' && ev.data?.source?.kind === 'user') {
        this.noteActivity()
        this.setLastUserQuery(String(agent.session.id), this.messageQueryOf(ev.data))
      }
    }))
    // Obsidian 记忆上下文注入：主控只读，写入统一由 Worker 完成。
    this.keep(agent, scoped.systemPrompt.section({
      name: 'orchestrator:memory-context',
      order: 620,
      text: () => this.renderMemoryContext(String(agent.session.id), agent.session.header.cwd),
    }))
    for (const tool of this.leadTools(agent)) this.keep(agent, scoped.tools.register(tool as any))
  }

  /** Lead 工具黑名单：DSH 自带工具全保留，只屏蔽第三方执行类工具（未注册的自动跳过）。 */
  private applyLeadToolDenylist(agent: Agent, scoped: Agent['ctx']): void {
    try {
      // deny 只作用于全局层：scope 内注册的 orchestrator_* 与影子记忆工具不受影响。
      const globalNames = [...new Set(scoped.tools.schemas().map(schema => schema.name))]
      const deny = leadToolDenyList(globalNames)
      if (deny.length > 0) this.keep(agent, scoped.tools.restrict({ deny }))
      // 工具清单巡检：陌生名字（非自带基线、未命中 deny）主动提醒复查名单。
      const unrecognized = unrecognizedGlobalTools(globalNames)
      if (unrecognized.length > 0) {
        this.hostCtx.logger.warn(`orchestrator: unrecognized global tools visible to Lead: ${unrecognized.join(', ')} — review LEAD_TOOL_DENY in lead-policy.ts`)
      }
    } catch (error) {
      // 枚举失败时退回无限制，避免主控完全失去工具。
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
    // 通用行为约束和 task_update 协议已固化在 WORKER_PRESET 的 persona 中。
    this.keep(agent, scoped.tools.guard(exec => {
      const forbidden = isWorkerToolForbidden(exec.name)
      // 工作量计数：Worker 每次放行的工具调用都记到当前活动任务名下，
      // 终态后供反思工作量门槛判断（建提醒日程这类事务性轮次只有两三次工具调用）。
      if (!forbidden) this.noteTaskToolStep(String(agent.session.id))
      return forbidden
    }))
    // 遮蔽与 Worker 任务无关的全局系统提示段（DSH 自举开发说明、Web GUI/HMR 说明、
    // 面向终端用户的文件卡片/Markdown 链接指引），每个子会话可省约 2.2k 字符；
    // scoped 同名 section 只影响本子会话，主会话仍保留。
    for (const sectionName of WORKER_SUPPRESSED_SECTIONS) {
      this.keep(agent, scoped.systemPrompt.section({ name: sectionName, order: 0, text: '', interpolate: false }))
    }
    // 记忆注入钩子：Worker 子工作区在共享 vault 之下，记忆文件在主工作区根的 kb_vault，
    // 故取 cwd 的父目录作为主工作区根。文件缺失时 renderMemoryContext 静默返回空段。
    this.keep(agent, scoped.systemPrompt.section({
      name: 'orchestrator:memory-context',
      order: 620,
      text: () => this.renderMemoryContext(String(agent.session.id), agent.session.header.cwd ? dirname(agent.session.header.cwd) : undefined),
    }))
    this.keep(agent, scoped.on('session/event', (session, event) => {
      if (String(session.id) !== String(agent.session.id)) return
      const ev = event as unknown as { type?: unknown; data?: { todos?: unknown; reason?: unknown; source?: { kind?: unknown } } }
      if (ev.type === 'user/message') {
        const kind = ev.data?.source?.kind
        if (typeof kind === 'string') this.lastInboundSource.set(String(agent.session.id), kind)
        const conv = this.conversationByChild(String(agent.session.id))
        if (kind === 'user' && conv?.workspaceName !== MEMORY_DREAM_WORKSPACE && conv?.workspaceName !== MEMORY_REFLECT_WORKSPACE) {
          this.noteActivity()
          this.setLastUserQuery(String(agent.session.id), this.messageQueryOf(ev.data))
        }
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
    this.keep(agent, scoped.tools.register(defineTool({
      name: 'task_update',
      description: '任务进度上报与用户日程维护：实时汇报进展、提交终态结果，并创建/更新需要用户本人推进的日程（schedules）。定时触发轮次无活动任务，仅允许 completed 上报结果。',
      parameters: TASK_UPDATE_TOOL_PARAMETERS,
      output: sharedJsonOutput,
      execute: async (args: any, exec: { concludeTurn?: () => void }) => {
        const result = await this.updateFromWorker(args, String(agent.session.id))
        // 终态（completed/failed/blocked）后无需再做一次全上下文推理：标记 concludesTurn 结束本轮。
        // input_required 阻塞工具拿到用户答案后 status 为 input_required_answered：不结束轮次，Worker 同轮继续。
        const resultStatus = (result as { status?: string }).status
        if (resultStatus !== 'input_required_answered' && statusConcludesTurn(resultStatus)) exec.concludeTurn?.()
        return toJson(result)
      },
    })))
    // Worker 产生跨会话价值记忆时走带锁的 memory_remember，避免多个 Worker 并发写同一文件。
    this.keep(agent, scoped.tools.register(this.memoryRememberTool(agent) as any))
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
      const tail = active
        ? `｜进行中：${active.subject}`
        : last?.report?.result
          ? `｜最近结果：${last.report.result.slice(0, 80)}`
          : ''
      const schedules = this.schedulesOf(conv.id)
      const pending = schedules.filter(schedule => schedule.status === 'pending')
      const todoSegment = schedules.length === 0
        ? ''
        : pending.length > 0
          ? `｜日程 ${pending.length} 项待处理：${pending.slice(0, 3).map(schedule => schedule.title).join('、')}${pending.length > 3 ? '…' : ''}`
          : `｜日程 ${schedules.length} 项全部完成`
      return `- ${conv.id} [${conv.state}] ${conv.title}${rosterSummarySegment(conv.outline.summary)}｜创建 ${formatRosterTime(conv.createdAt)}｜更新 ${formatRosterTime(conv.updatedAt)}${tail}${todoSegment}`
    })
    return `Orchestrator roster（dispatch 用 conversationId 复用子会话；get 看详情）：\n${lines.join('\n')}`
  }

  /**
   * 记忆注入钩子：USER.md（用户画像）静态全文注入；MEMORY.md 按当前问题做关键词召回
   * （query 取该会话最近一条用户问题/任务文本，进程内分词计分，无外部依赖）。
   * 无查询或没有命中时退回静态头部截断。缺失文件静默跳过；读取失败降级为空段。
   *
   * 注意：dsh runtime 的 system-prompt 服务目前只支持同步 text 函数，因此召回保持同步，
   * 不能用 obsidian_search 工具（那是模型侧的异步工具）。
   */
  private renderMemoryContext(sessionId: string, rootCwd: string | undefined): string {
    const vaultRoot = resolveVaultRoot(rootCwd ?? process.cwd())
    const parts: string[] = []
    const userText = this.readVaultText(vaultRoot, 'USER.md')
    if (userText) parts.push(`USER.md：${userText}`)
    const memoryLines = this.readVaultLines(vaultRoot, 'MEMORY.md')
    if (memoryLines.length > 0) {
      const recalled = recallMemoryEntries(memoryLines, this.lastUserQuery.get(sessionId))
        .map(line => line.slice(0, 200))
      parts.push(`MEMORY.md：${(recalled.length > 0 ? recalled : memoryLines).join('\n').slice(0, 1200)}`)
    }
    if (parts.length === 0) return ''
    return `# 记忆上下文\n${parts.join('\n')}`
  }

  /** 读 vault 根下文件并压成单行文本（静态注入用），缺失/为空返回空串。 */
  private readVaultText(vaultRoot: string, rel: string, max = 1200): string {
    try {
      const text = readFileSync(join(vaultRoot, rel), 'utf8').trim()
      if (!text) return ''
      const collapsed = text.replace(/\s+/g, ' ')
      return collapsed.slice(0, max) + (collapsed.length > max ? '…' : '')
    } catch {
      return ''
    }
  }

  /** 读 vault 根下文件并按行拆成记忆条目（一行一条事实，去掉列表符与标题）。 */
  private readVaultLines(vaultRoot: string, rel: string): string[] {
    try {
      return readFileSync(join(vaultRoot, rel), 'utf8')
        .split('\n')
        .map(line => line.trim().replace(/^[-*]\s*/, '').replace(/\s+/g, ' '))
        .filter(line => line.length > 0 && !line.startsWith('#'))
    } catch {
      return []
    }
  }

  /** 记录会话最近一条用户问题/任务文本（记忆召回 query），超容量时淘汰最早条目。 */
  private setLastUserQuery(sessionId: string, query: string): void {
    const trimmed = query.trim().slice(0, 400)
    if (!trimmed) return
    if (this.lastUserQuery.size >= 100) {
      const oldest = this.lastUserQuery.keys().next().value
      if (oldest !== undefined) this.lastUserQuery.delete(oldest)
    }
    this.lastUserQuery.set(sessionId, trimmed)
  }

  /** user/message 事件的 data 即消息本体：抽取 text 内容片段。 */
  private messageQueryOf(data: unknown): string {
    const rec = data as { content?: Array<{ type?: unknown; text?: unknown }> } | undefined
    if (!rec || !Array.isArray(rec.content)) return ''
    return rec.content
      .filter(item => item && item.type === 'text' && typeof item.text === 'string')
      .map(item => item.text as string)
      .join(' ')
  }

  /**
   * Host 级机械蒸馏（纯 Node.js，不经 LLM），补齐图片要求的 6 项操作：
   * 1) 收集近 7 日 memory/*.md 未标注 [distilled] 的行，汇总到 memory/pending.md，源行标注 [distilled]；
   * 2) MEMORY.md 行级精确去重（归一化后相同的合并，语义合并留给语义提炼步）；
   * 3) memory/ 超过 14 天且已整文件蒸馏的移入 memory/archive/，归档文件头部标 [distilled]；
   * 4) DREAMS.md 只保留最近 50 条审计，旧的移入 DREAMS.archive.md；
   * 5) 检查 kb_vault/<session_id>/00-会话归档总览索引.md 完整性，缺失记 warn；
   * 6) 返回 pending 条目数（idle Dream 据此决定是否派发语义提炼）。
   * 语义提炼（pending.md → 长期记忆）由 idle Dream 派发 silent Worker 完成；无 Lead 时调用方机械兜底。
   */
  private async runMemoryDistillation(): Promise<number> {
    const vaultRoot = resolveVaultRoot(process.cwd())
    const memoryDir = join(vaultRoot, 'memory')
    const today = new Date()
    const dates: string[] = []
    for (let i = 0; i < 7; i++) {
      const d = new Date(today.getTime() - i * 86_400_000)
      dates.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`)
    }
    // 1) 收集待蒸馏条目 → pending.md，源行标注 [distilled]
    let collected = 0
    const sources: string[] = []
    for (const date of dates) {
      const filePath = join(memoryDir, `${date}.md`)
      let text = ''
      try { text = await readFile(filePath, 'utf8') } catch { continue }
      const lines = text.split('\n')
      const pending: string[] = []
      const rewritten: string[] = []
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#') || trimmed.includes('[distilled]') || trimmed === '[distilled]') {
          rewritten.push(line)
          continue
        }
        pending.push(trimmed.replace(/^[-*]\s*/, ''))
        rewritten.push(`${line} [distilled]`)
      }
      if (pending.length === 0) continue
      await this.withMemoryWriteLock(filePath, async () => {
        await writeFile(filePath, rewritten.join('\n'))
      })
      await this.withMemoryWriteLock(join(memoryDir, 'pending.md'), async () => {
        await mkdir(memoryDir, { recursive: true })
        await appendFile(join(memoryDir, 'pending.md'), pending.map(entry => `- ${entry}`).join('\n') + '\n')
      })
      collected += pending.length
      sources.push(`${date}.md:${pending.length}`)
    }
    // 2) MEMORY.md 行级精确去重（归一化相同 → 保留最后一次出现的文本，位置取首次出现）
    await this.dedupeMemoryMd(vaultRoot)
    // 3) memory/ 旧文件归档轮转
    await this.archiveOldMemoryFiles(memoryDir, 14)
    // 4) DREAMS.md 审计轮转
    await this.rotateDreamsAudit(vaultRoot, 50)
    // 5) 索引完整性检查
    await this.checkVaultIndexes(vaultRoot)
    if (collected > 0) {
      const audit = `- ${new Date().toISOString()}: Host 机械蒸馏：收集 ${collected} 条待蒸馏（${sources.join(', ')}），待语义提炼\n`
      await this.withMemoryWriteLock(join(vaultRoot, 'DREAMS.md'), async () => {
        await appendFile(join(vaultRoot, 'DREAMS.md'), audit)
      })
      this.hostCtx.logger.info(`orchestrator: collected ${collected} memory entries into pending.md`)
    }
    return collected
  }

  /** MEMORY.md 行级去重：归一化（去列表符/空白/大小写）后相同的行只保留最后一次出现的文本。 */
  private async dedupeMemoryMd(vaultRoot: string): Promise<void> {
    const memoryPath = join(vaultRoot, 'MEMORY.md')
    let text = ''
    try { text = await readFile(memoryPath, 'utf8') } catch { return }
    const lines = text.split('\n')
    const normalize = (line: string): string => line.trim().replace(/^[-*]\s*/, '').replace(/\s+/g, '').toLowerCase()
    const lastText = new Map<string, string>()
    const order: string[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const key = normalize(line)
      if (!lastText.has(key)) order.push(key)
      lastText.set(key, trimmed.replace(/^[-*]\s*/, ''))
    }
    if (order.length === 0) return
    const deduped = order.map(key => `- ${lastText.get(key)}`).join('\n') + '\n'
    if (deduped === text) return
    await this.withMemoryWriteLock(memoryPath, async () => {
      await writeFile(memoryPath, deduped)
    })
    this.hostCtx.logger.info(`orchestrator: MEMORY.md deduped ${lines.length} -> ${order.length} entries`)
  }

  /** memory/ 归档轮转：文件名日期超过 keepDays 且整文件已蒸馏的移入 memory/archive/，头部标 [distilled]。 */
  private async archiveOldMemoryFiles(memoryDir: string, keepDays: number): Promise<void> {
    let entries: Array<{ name: string; isFile: boolean }>
    try {
      entries = (await readdir(memoryDir, { withFileTypes: true })).map(d => ({ name: d.name, isFile: d.isFile() }))
    } catch {
      return
    }
    const cutoff = Date.now() - keepDays * 86_400_000
    for (const entry of entries) {
      if (!entry.isFile || !/^\d{4}-\d{2}-\d{2}\.md$/.test(entry.name)) continue
      const dateMs = new Date(entry.name.replace('.md', '')).getTime()
      if (Number.isNaN(dateMs) || dateMs > cutoff) continue
      const filePath = join(memoryDir, entry.name)
      const text = await readFile(filePath, 'utf8').catch(() => '')
      // 只归档已整文件蒸馏的：所有实质行都带 [distilled] 标注
      const substantive = text.split('\n').filter(line => {
        const t = line.trim()
        return t && !t.startsWith('#') && t !== '[distilled]'
      })
      if (substantive.length === 0 || !substantive.every(line => line.includes('[distilled]'))) continue
      const archiveDir = join(memoryDir, 'archive')
      await mkdir(archiveDir, { recursive: true })
      await this.withMemoryWriteLock(join(archiveDir, entry.name), async () => {
        await rename(filePath, join(archiveDir, entry.name)).catch(async error => {
          // rename 失败（跨设备等）退化为复制语义：写新文件后删旧文件
          this.hostCtx.logger.warn(`orchestrator: memory archive rename failed, fallback write: ${String(error)}`)
          await writeFile(join(archiveDir, entry.name), `[distilled]\n${text}`)
        })
      })
      // 归档文件头部补 [distilled] 标注
      await this.withMemoryWriteLock(join(archiveDir, entry.name), async () => {
        const archived = await readFile(join(archiveDir, entry.name), 'utf8').catch(() => '')
        if (!archived.startsWith('[distilled]')) {
          await writeFile(join(archiveDir, entry.name), `[distilled]\n${archived}`)
        }
      })
      this.hostCtx.logger.info(`orchestrator: archived memory/${entry.name}`)
    }
  }

  /** DREAMS.md 审计轮转：只保留最近 keep 条审计行，旧的追加进 DREAMS.archive.md。 */
  private async rotateDreamsAudit(vaultRoot: string, keep: number): Promise<void> {
    const dreamsPath = join(vaultRoot, 'DREAMS.md')
    let text = ''
    try { text = await readFile(dreamsPath, 'utf8') } catch { return }
    const lines = text.split('\n')
    const auditLines = lines.filter(line => line.trim().startsWith('- '))
    if (auditLines.length <= keep) return
    const overflow = auditLines.slice(0, auditLines.length - keep)
    await this.withMemoryWriteLock(join(vaultRoot, 'DREAMS.archive.md'), async () => {
      await appendFile(join(vaultRoot, 'DREAMS.archive.md'), overflow.join('\n') + '\n')
    })
    // 按出现顺序逐个移除 overflow 行（避免内容相同的审计行被误全删）
    let removeIndex = 0
    const kept = lines.filter(line => removeIndex < overflow.length && line === overflow[removeIndex] ? (removeIndex++, false) : true)
    await this.withMemoryWriteLock(dreamsPath, async () => {
      await writeFile(dreamsPath, kept.join('\n'))
    })
    this.hostCtx.logger.info(`orchestrator: rotated ${overflow.length} DREAMS.md audit lines to DREAMS.archive.md`)
  }

  /** 索引完整性检查：kb_vault/<session_id>/ 缺 00-会话归档总览索引.md 时记 warn。 */
  private async checkVaultIndexes(vaultRoot: string): Promise<void> {
    let entries: Array<{ name: string; isDirectory: boolean }>
    try {
      entries = (await readdir(vaultRoot, { withFileTypes: true })).map(d => ({ name: d.name, isDirectory: d.isDirectory() }))
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory) continue
      if (['memory', 'assets'].includes(entry.name)) continue
      const indexPath = join(vaultRoot, entry.name, '00-会话归档总览索引.md')
      try {
        await readFile(indexPath, 'utf8')
      } catch {
        this.hostCtx.logger.warn(`orchestrator: kb_vault/${entry.name}/ 缺少 00-会话归档总览索引.md`)
      }
    }
  }

  /** 读取 memory/pending.md 的待语义提炼条目（空文件或缺失返回空数组）。 */
  private async readPendingEntries(vaultRoot: string): Promise<string[]> {
    let text = ''
    try { text = await readFile(join(vaultRoot, 'memory', 'pending.md'), 'utf8') } catch { return [] }
    return text.split('\n')
      .map(line => line.trim().replace(/^[-*]\s*/, ''))
      .filter(line => line.length > 0)
  }

  /** 清空 memory/pending.md（语义提炼任务结算后调用；无 Lead 机械兜底后也调用）。 */
  private async clearPendingEntries(vaultRoot: string): Promise<void> {
    await this.withMemoryWriteLock(join(vaultRoot, 'memory', 'pending.md'), async () => {
      await mkdir(join(vaultRoot, 'memory'), { recursive: true })
      await writeFile(join(vaultRoot, 'memory', 'pending.md'), '')
    }).catch(() => undefined)
  }

  /**
   * 串行化记忆文件写入：按文件路径排队，避免多 Worker 并发 append/write 同一 md 导致冲突。
   * 注意：此锁只在调用方使用 Host 提供的写入路径时生效；模型直接调用 obsidian_write 仍可能冲突。
   */
  private async withMemoryWriteLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
    const previous = this.memoryWriteLocks.get(filePath) ?? Promise.resolve()
    const next = previous.then(task, task)
    this.memoryWriteLocks.set(filePath, next)
    try {
      return await next
    } finally {
      if (this.memoryWriteLocks.get(filePath) === next) {
        this.memoryWriteLocks.delete(filePath)
      }
    }
  }

  /** 用户/Lead 活动发生时调用，推迟 Dream 到下一次 3h 空闲。 */
  private noteActivity(): void {
    this.lastActivityAt = Date.now()
    this.armDreamTimer()
  }

  private armDreamTimer(): void {
    if (this.dreamTimer) clearTimeout(this.dreamTimer)
    const elapsed = Date.now() - this.lastActivityAt
    const delay = Math.max(0, DREAM_IDLE_MS - elapsed)
    this.dreamTimer = setTimeout(() => { void this.runDream() }, delay)
    this.dreamTimer.unref?.()
  }

  /**
   * Idle Dream（图片要求的分工）：空闲 3h 后抢占 lease →
   * Host 机械蒸馏（收集→pending.md、去重、归档、轮转、索引检查）→
   * pending 非空且有 Lead 在线时派 silent Worker 只做最后一步语义提炼 →
   * 无 Lead 或派发失败时机械兜底（条目直接进 MEMORY.md，保证不丢）。
   * LLM 路径的 lease 与 pending.md 清理由 memory-dream 任务终态结算完成。
   * 每次触发后以当下时间重置活动基线，避免空闲期反复触发。
   */
  private async runDream(): Promise<void> {
    const idle = Date.now() - this.lastActivityAt
    if (idle < DREAM_IDLE_MS) {
      this.armDreamTimer()
      return
    }
    const vaultRoot = resolveVaultRoot(process.cwd())
    await mkdir(vaultRoot, { recursive: true })
    const owner = `orchestrator:${process.pid}:${randomUUID()}`
    const claimed = await claimDreamLease(vaultRoot, owner)
    if (!claimed) {
      this.hostCtx.logger.info('orchestrator: dream skipped, lease held')
      this.settleDreamRound()
      return
    }
    this.hostCtx.logger.info('orchestrator: idle dream started')
    try {
      await this.runMemoryDistillation()
    } catch (error) {
      this.hostCtx.logger.warn(`orchestrator: mechanical distillation failed: ${String(error)}`)
    }
    const pending = await this.readPendingEntries(vaultRoot)
    let dispatched = false
    if (pending.length > 0) {
      const target = this.dreamDispatchTarget()
      if (target) {
        try {
          const result = await this.dispatch({
            subject: '记忆语义提炼 Dream',
            workspaceName: MEMORY_DREAM_WORKSPACE,
            prompt: buildDreamPrompt(vaultRoot),
            ...target.conversationId ? { conversationId: target.conversationId } : {},
            silent: true,
          }, target.agent)
          dispatched = (result as { kind?: unknown }).kind !== 'error'
          if (!dispatched) this.hostCtx.logger.warn(`orchestrator: dream dispatch rejected: ${toJson(result)}`)
        } catch (error) {
          this.hostCtx.logger.warn(`orchestrator: dream dispatch failed: ${String(error)}`)
        }
      } else {
        this.hostCtx.logger.info('orchestrator: no lead agent online, dream falls back to mechanical append')
      }
      if (!dispatched) {
        // 机械兜底：pending 条目直接进 MEMORY.md，保证信息不丢；完成后清空 pending 并释放 lease。
        try {
          await this.withMemoryWriteLock(join(vaultRoot, 'MEMORY.md'), async () => {
            await appendFile(join(vaultRoot, 'MEMORY.md'), pending.map(entry => `- ${entry}`).join('\n') + '\n')
          })
          const audit = `- ${new Date().toISOString()}: 无 Lead 在线，${pending.length} 条 pending 机械追加进 MEMORY.md\n`
          await this.withMemoryWriteLock(join(vaultRoot, 'DREAMS.md'), async () => {
            await appendFile(join(vaultRoot, 'DREAMS.md'), audit)
          })
        } catch (error) {
          this.hostCtx.logger.warn(`orchestrator: mechanical fallback append failed: ${String(error)}`)
        }
        await this.clearPendingEntries(vaultRoot)
        await finishDreamLease(vaultRoot)
      }
    } else {
      // 无待提炼条目：直接释放 lease。
      await finishDreamLease(vaultRoot)
    }
    if (dispatched) {
      // LLM 语义提炼异步进行，lease 与 pending.md 清理留给 memory-dream 任务终态结算。
      this.settleDreamRound()
      return
    }
    this.settleDreamRound()
  }

  /** 一轮 Dream 收尾：重置活动基线（整理本身算维护活动），重挂 3h 计时器。 */
  private settleDreamRound(): void {
    this.lastActivityAt = Date.now()
    this.armDreamTimer()
  }

  /** Dream 派发目标：最近更新的受管会话所属的 Lead agent，并尽量复用该父会话下最近的 memory-dream 子会话。 */
  private dreamDispatchTarget(): { agent: Agent; conversationId?: string } | undefined {
    let latest: ConversationRecord | undefined
    for (const [, conv] of this.conversations().entries()) {
      if (!latest || conv.updatedAt > latest.updatedAt) latest = conv
    }
    if (!latest) return undefined
    const agent = this.hostCtx.agents.get(latest.parentSessionId as SessionId)
    if (!agent) return undefined
    let dreamConv: ConversationRecord | undefined
    for (const [, conv] of this.conversations().entries()) {
      if (conv.parentSessionId !== latest.parentSessionId || conv.workspaceName !== MEMORY_DREAM_WORKSPACE) continue
      if (!dreamConv || conv.updatedAt > dreamConv.updatedAt) dreamConv = conv
    }
    return { agent, conversationId: dreamConv?.id }
  }

  /** Worker 工具守卫计数：把本次放行的工具调用记到该子会话当前活动任务名下。 */
  private noteTaskToolStep(childSessionId: string): void {
    const taskId = this.conversationByChild(childSessionId)?.activeTaskId
    if (!taskId) return
    this.taskToolSteps.set(taskId, (this.taskToolSteps.get(taskId) ?? 0) + 1)
  }

  /**
   * 非记忆维护任务终态后，静默派发 memory-reflect 让 Worker 写当日运行记录。
   * 约束：1) 记忆维护任务自身不触发；2) 任务必须有实质产出（闲聊/空跑跳过）；
   * 3) ad-hoc 提醒/自发上报任务不触发；4) 工作量门槛：任务内放行的工具步数达到
   * REFLECT_MIN_TOOL_STEPS 才算干过活（对齐喵记忆 reflectTurns 的工作量驱动）——
   * 创建提醒日程等事务性任务只有两三次工具调用，产出不含新知识，不派发反思；
   * 有制品的任务不受此限（产出即证据）。
   */
  private queueMemoryReflection(task: TaskRecord, conv: ConversationRecord, toolSteps: number): void {
    if (task.silent) return
    if (task.prompt === AD_HOC_TASK_PROMPT) return
    // 过滤无实质产出的任务：闲聊/空跑不需要 reflect
    const hasResult = !!(task.report?.result?.trim() || task.report?.artifacts?.length)
    if (!hasResult) return
    if (toolSteps < REFLECT_MIN_TOOL_STEPS && !task.report?.artifacts?.length) return
    const agent = this.hostCtx.agents.get(conv.parentSessionId as SessionId)
    if (!agent) return
    const subject = `记忆反思：${task.subject}`
    this.dispatch({
      subject: subject.slice(0, 200),
      workspaceName: MEMORY_REFLECT_WORKSPACE,
      prompt: buildReflectPrompt(task),
      silent: true,
    }, agent).catch(error => {
      this.hostCtx.logger.warn(`orchestrator: queue memory reflect failed: ${String(error)}`)
    })
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
              ...task.report?.result ? { answer: task.report.result } : {},
              ...task.report?.artifacts?.length ? { artifacts: task.report.artifacts } : {},
              ...task.fail ? { fail: task.fail } : {},
              updatedAt: task.updatedAt,
            }))
          const schedules = this.schedulesOf(conv.id).map(schedule => ({
            id: schedule.id,
            title: schedule.title,
            status: schedule.status,
            priority: schedule.priority,
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

  /**
   * Worker 记忆写入工具：把单条事实追加到共享 vault 根下的记忆文件。
   * 带路径安全检查与文件级写入锁，避免多会话并发写同一文件冲突。
   */
  private memoryRememberTool(agent: Agent) {
    return defineTool({
      name: 'memory_remember',
      description: '把一条跨会话价值信息追加到共享 vault 根下的记忆文件（USER.md / MEMORY.md / memory/YYYY-MM-DD.md）。单条一事实，写入前应先 obsidian_search 查重；Host 会自动串行化同一文件的并发写入。',
      parameters: {
        relPath: { type: 'string', required: true, description: '相对 kb_vault 根的路径，如 USER.md、MEMORY.md、memory/2026-11-02.md' },
        content: { type: 'string', required: true, description: '一条记忆事实，建议带关键词、所属项目和重要度' },
      },
      output: sharedJsonOutput,
      execute: async (args: unknown) => {
        const parsed = memoryRememberInputSchema.safeParse(args)
        if (!parsed.success) return toJson({ error: parsed.error.issues[0]?.message ?? 'invalid arguments' })
        const { relPath, content } = parsed.data
        const cwd = agent.session.header.cwd
        const workspaceRoot = this.composedPreset(agent) === WORKER_PRESET && cwd ? dirname(cwd) : cwd
        const vaultRoot = resolveVaultRoot(workspaceRoot ?? process.cwd())
        const filePath = resolve(vaultRoot, relPath)
        if (!filePath.startsWith(vaultRoot + sep)) {
          return toJson({ error: `invalid memory path: ${relPath}` })
        }
        const line = content.trim()
        if (!line) return toJson({ error: 'content is empty' })
        try {
          await this.withMemoryWriteLock(filePath, async () => {
            await mkdir(dirname(filePath), { recursive: true })
            await appendFile(filePath, `${line}\n\n`)
          })
          return toJson({ ok: true, file: relPath })
        } catch (error) {
          return toJson({ error: String(error instanceof Error ? error.message : error) })
        }
      },
    })
  }

  private async dispatch(rawArgs: unknown, parent: Agent): Promise<any> {
    const parsed = dispatchInputSchema.safeParse(rawArgs)
    if (!parsed.success) return { kind: 'error', error: parsed.error.issues[0]?.message ?? 'invalid orchestrator_dispatch arguments' }
    const args: DispatchInput = parsed.data
    const parentSessionId = String(parent.session.id)
    if (!args.silent) this.noteActivity()

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
        if (active && (activeTaskStatuses as readonly string[]).includes(active.status)) {
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
      // 路由卡摘要（roster"摘要"行）由 Host 维护：最近主题链，替代旧 task_update.summary。
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
   * 创建根级别的 Worker 会话：与主会话同为一等会话（不带 origin/delegationDepth 的
   * subagent 血统），因此 schedule 等只对 depth-0 会话开放的宿主能力对 Worker 可用。
   * cwd 与 agentPreset 直接写入 session header，冷恢复后保持不变；模型继承主会话当前生效的选择。
   */
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
    // 派发文本即该 Worker 会话当前的"问题"，用于记忆 BM25 召回；记忆维护会话排除在外。
    const conv = this.conversationByChild(childSessionId)
    if (conv?.workspaceName !== MEMORY_DREAM_WORKSPACE && conv?.workspaceName !== MEMORY_REFLECT_WORKSPACE) {
      this.setLastUserQuery(childSessionId, text)
    }
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
   * task_update 的会话级副作用：schedules.create/update 写入独立日程表
   * （Host 分配 id；update 的 id 必须属于当前会话，未知 id 抛错，不产生部分写入）。
   * 必须在 serialize 串行块内调用；路由卡摘要已改由 dispatch 侧维护。
   */
  private async applyUpdateSideEffects(conv: ConversationRecord, args: TaskUpdateInput): Promise<void> {
    const now = timestamp()
    const existing = this.schedulesOf(conv.id)
    for (const entry of args.schedules?.create ?? []) {
      const { priority, ...content } = entry
      const item: ScheduleRecord = {
        id: createId('sch'),
        parentSessionId: conv.parentSessionId,
        conversationId: conv.id,
        priority,
        links: [], attachments: [], contacts: [],
        ...content,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      }
      await this.schedules().put(item.id, item)
    }
    for (const entry of args.schedules?.update ?? []) {
      const item = existing.find(schedule => schedule.id === entry.id)
      if (!item) throw new Error(`schedule not found in this conversation: ${entry.id}`)
      const { id, status, ...patch } = entry
      const merged = { ...item, ...patch }
      if (merged.startAt && merged.endAt && Date.parse(merged.startAt) > Date.parse(merged.endAt)) {
        throw new Error(`schedule ${id}: startAt 不能晚于 endAt`)
      }
      await this.schedules().put(id, {
        ...merged,
        ...status !== undefined
          ? {
              status,
              // done/cancelled 都是 Worker 侧的终结标记；回到 pending 则清除
              completedBy: status !== 'pending' ? 'worker' as const : undefined,
            }
          : {},
        updatedAt: now,
      })
    }
  }

  private async updateFromWorker(rawArgs: unknown, childSessionId: string): Promise<any> {
    const parsed = taskUpdateInputSchema.safeParse(rawArgs)
    if (!parsed.success) {
      // 全量 issues 带路径返回：模型下一轮能精准补字段，而不是猜"哪里少了字符串"。
      const detail = parsed.error.issues
        .map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ')
      throw new Error(`invalid task_update arguments: ${detail}`)
    }
    let args: TaskUpdateInput = parsed.data
    // input_required：Host 补齐问题 id（q1..qn，缺省才补），返回值回显给 Worker 备用。
    let questionEcho: Array<{ id: string, question: string }> | undefined
    if (args.status === 'input_required' && args.questions) {
      args = {
        ...args,
        questions: args.questions.map((item, index) => ({ id: item.id ?? `q${index + 1}`, ...item })),
      }
      questionEcho = args.questions.map(item => ({ id: item.id!, question: item.question }))
    }
    let shouldDeliver = false
    let terminalTaskId: string | undefined
    const result = await this.serialize(async () => {
      const conv = this.conversationByChild(childSessionId)
      if (!conv) throw new Error('task_update is only available in a managed worker')
      if (!conv.activeTaskId) {
        // 定时提醒触发等无活动任务的轮次：只允许 completed 上报，
        // 生成一条 ad-hoc 已完成任务并照常经 outbox 投递给主会话。
        if (args.status !== 'completed') {
          throw new Error('no active task: only completed task_update is allowed (e.g. schedule-fired reporting)')
        }
        const subject = (args.report?.result?.trim().split('\n')[0] || '定时触发上报').slice(0, 60)
        const seeded = createTask({
          id: createId('task'),
          parentSessionId: conv.parentSessionId,
          conversationId: conv.id,
          predecessorTaskId: conv.lastTaskId,
          subject,
          prompt: AD_HOC_TASK_PROMPT,
        })
        // 定时触发的入站消息带 source.kind='schedule'，据此给上报任务打定时标记（仅显示用）。
        const marked = this.lastInboundSource.get(childSessionId) === 'schedule'
        const task = gateTaskDelivery(
          transitionTask({ ...seeded, status: 'running', startedAt: seeded.createdAt, ...marked ? { scheduled: true } : {} }, args),
          this.deliveryToggles(),
        )
        await this.applyUpdateSideEffects(conv, args)
        await this.putPair(settleConversation(conv, task), task)
        terminalTaskId = task.id
        shouldDeliver = task.delivery?.state === 'pending'
        return { ok: true as const, status: task.status, schedules: scheduleProjection(this.schedulesOf(conv.id)) }
      }
      const previous = this.taskById(conv.activeTaskId)
      if (!previous) throw new Error('active task record is missing')

      const task = gateTaskDelivery(transitionTask(previous, args), this.deliveryToggles())
      const terminal = (deliverableTaskStatuses as readonly string[]).includes(task.status)
      const isInputRequired = task.status === 'input_required'
      await this.applyUpdateSideEffects(conv, args)
      // input_required 不 settle（activeTaskId 保留、轮次未结束），但聚合状态要同步为待决策；
      // 其余终态照常 settle 回 idle。
      const nextConv = terminal && !isInputRequired
        ? settleConversation(conv, task)
        : isInputRequired ? awaitingConversation(conv) : conv
      await this.putPair(nextConv, task)
      if (terminal && !isInputRequired) {
        terminalTaskId = task.id
        shouldDeliver = task.delivery?.state === 'pending'
      }
      return { ok: true as const, status: task.status, schedules: scheduleProjection(this.schedulesOf(conv.id)), __inputRequired__: isInputRequired ? task : undefined }
    })
    if (shouldDeliver && terminalTaskId) void this.deliverPendingTask(terminalTaskId)
    if (terminalTaskId) {
      const task = this.taskById(terminalTaskId)
      const conv = task ? this.conversationById(task.conversationId) : undefined
      // 工具步数随任务终态消费，成功/失败/中断都清理，不留脏数据。
      const toolSteps = this.taskToolSteps.get(terminalTaskId) ?? 0
      this.taskToolSteps.delete(terminalTaskId)
      if (task && conv) {
        if (conv.workspaceName === MEMORY_DREAM_WORKSPACE) {
          const vaultRoot = resolveVaultRoot(process.cwd())
          if (task.status === 'completed') {
            // 语义提炼成功结算：清空 pending.md（结果已进长期记忆），释放 lease。
            this.hostCtx.logger.info('orchestrator: dream task completed, clearing lease and pending.md')
            await this.clearPendingEntries(vaultRoot)
          } else {
            // 提炼失败：保留 pending.md 供下一轮 Dream 重试，仅释放 lease。
            this.hostCtx.logger.warn(`orchestrator: dream task ended with ${task.status}, keeping pending.md`)
          }
          await finishDreamLease(vaultRoot).catch(() => {})
        } else if (conv.workspaceName !== MEMORY_REFLECT_WORKSPACE && task.status === 'completed' && !task.silent) {
          this.queueMemoryReflection(task, conv, toolSteps)
        }
      }
    }
    // input_required：工具调用阻塞直到用户从任一入口作答，返回值即用户答案。
    if (result.__inputRequired__) {
      const answers = await this.blockAndWaitForAnswers(result.__inputRequired__, childSessionId)
      return {
        ok: true as const,
        status: 'input_required_answered' as const,
        answers: answers.map(a => ({ id: a.id, selected: a.selected, ...a.custom !== undefined ? { custom: a.custom } : {} })),
      }
    }
    return questionEcho ? { ...result, questions: questionEcho } : result
  }

  /**
   * Worker 轮次结束的结算：task_update 已提交终态的任务在 settle 后 activeTaskId 为空，
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
      if (!previous || !(activeTaskStatuses as readonly string[]).includes(previous.status)) return
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
          failTask(previous, previous.status === 'queued' ? '子会话在任务开始前结束' : '子会话结束前未提交终态 task_update', now),
          this.deliveryToggles(),
        )
        nextConv = failConversation(settleConversation(conv, task, now), now)
        shouldDeliver = task.delivery?.state === 'pending'
        outcome = 'failed'
      }
      await this.putPair(nextConv, task)
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
    if (!(deliverableTaskStatuses as readonly string[]).includes(task.status)) return
    if (!deliveryEnabledFor(this.deliveryToggles(), task.status)) {
      // 设置页已关闭该状态的投递：清掉存量 pending（不补投），状态本身已持久化、roster/看板照常可见。
      await this.patchDelivery(taskId, () => undefined)
      return
    }
    this.delivering.add(taskId)
    try {
      // input_required 由 task_update 工具阻塞处理，不走 deliverPendingTask。
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
   * input_required 的阻塞作答：task_update(input_required) 的工具调用本身挂起不返回。
   * 问题卡只在两个地方渲染：
   * - 子会话：平台原生 ask_user_question（Worker 是 live root，直接对 Worker 挂 ask）
   * - 任务看板：自定义 AskCard
   * 主会话完全不参与（不投递、不弹卡）。任一来源作答后 resolve，工具直接返回用户答案。
   */
  private blockAndWaitForAnswers(task: TaskRecord, childSessionId: string): Promise<QuestionAnswer[]> {
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

    return new Promise<QuestionAnswer[]>((resolve, reject) => {
      const workerAbort = new AbortController()
      this.pendingAnswerResolvers.set(task.id, { resolve, reject, abort: workerAbort })

      // 在 Worker 会话挂原生 ask_user_question 卡（Worker 是 live root）。
      if (userQuestions?.ask) {
        void this.withAgent(childSessionId, async (agent) => {
          try {
            const result = await userQuestions.ask({ questions, agent, signal: workerAbort.signal })
            // Worker 原生卡作答：走统一入口（answerTaskQuestions 会 resolve 挂起的 Promise）。
            await this.answerTaskQuestions({ childSessionId, answers: result.answers })
          } catch {
            // ask 被取消/abort（看板先答了），不是业务失败。
          }
        }).catch(() => undefined)
      }
    })
  }

  /** 看板/子会话原生卡作答后统一 resolve 挂起的 task_update(input_required) 工具调用并清理另一侧卡片。 */
  private resolvePendingAnswers(taskId: string, answers: QuestionAnswer[]): void {
    const pending = this.pendingAnswerResolvers.get(taskId)
    if (pending) {
      this.pendingAnswerResolvers.delete(taskId)
      // abort Worker 的 userQuestions.ask()，平台会清理子会话原生问题卡。
      pending.abort?.abort()
      pending.resolve(answers)
    }
  }

  /**
   * 三处问题卡（看板 / 子会话工具行 / 主会话原生卡）共用的作答路由：
   * 幂等——只有 input_required 的最新任务可答，先答先赢；重开同一 TaskRun 继续执行，
   * 答案注入 Worker，并给 Lead 日志追加不唤醒的备忘（防 Lead 下一轮重复转派）。
   */
  async answerTaskQuestions(request: {
    childSessionId: string
    answers: Array<{ id: string; selected?: string[]; custom?: string }>
  }): Promise<{ ok: boolean; taskId?: string; error?: string }> {
    await this.ready
    this.noteActivity()
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
      return { ok: true as const, taskId: resumed.id, childSessionId: conv.childSessionId, parentSessionId: conv.parentSessionId, subject: resumed.subject, questions: resumed.questions }
    })
    if (!outcome.ok) return outcome
    // 阻塞模型：resolve 挂起的 task_update(input_required) 工具调用，Worker 同轮拿到答案。
    this.resolvePendingAnswers(outcome.taskId!, answers)
    return { ok: true, taskId: outcome.taskId }
  }

  private async recoverDeliveries(): Promise<void> {
    try {
      await this.ready
      const pending = [...this.tasks().entries()]
        .map(([, task]) => task)
        .filter(task => !task.silent
          && task.delivery?.state === 'pending'
          && (deliverableTaskStatuses as readonly string[]).includes(task.status))
      for (const task of pending) await this.deliverPendingTask(task.id)
    } catch (error) {
      this.hostCtx.logger.warn(`orchestrator: recover deliveries failed: ${String(error)}`)
    }
  }

  /** Recover provisioning records and tasks left live by a process restart. */
  private async recoverRuntimeState(): Promise<void> {
    await this.serialize(async () => {
      await this.migrateTodosToSchedules()
      const now = timestamp()
      for (const [, conv] of this.conversations().entries()) {
        const active = conv.activeTaskId ? this.taskById(conv.activeTaskId) : undefined
        if (!active) {
          if (conv.activeTaskId) {
            // Repair a dangling reference left by a crash between cross-table writes.
            const failedConv = { ...failConversation(conv, now), activeTaskId: null }
            await this.conversations().put(failedConv.id, failedConv)
          }
          continue
        }
        if (!(activeTaskStatuses as readonly string[]).includes(active.status)) {
          // The task row can reach a terminal state before the conversation row is updated.
          await this.putPair(settleConversation(conv, active, now), active)
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

/** task_update 的模型可见参数 DSL（defineTool parameters）。与 taskUpdateInputSchema 双写：
 * 模型只能看到这里的字段——zod 加了字段而这里没加，模型就永远不知道（v0.3.13 前踩过）。 */
export const TASK_UPDATE_TOOL_PARAMETERS = {
  status: { type: 'string', required: true, enum: [...taskUpdateStatuses] },
  header: { type: 'string', description: '极度精简的状态标题（最多 8 个字，看板加粗展示），如"抓取新闻源""已查到 3 家"' },
  progressNote: { type: 'string', description: '一行精简进展（看板直接显示；信息优先，可带三分幽默）' },
  report: {
    type: 'object',
    additionalProperties: false,
    properties: {
      result: { type: 'string', required: true, description: '完整结果，Lead 转述给用户的权威答案' },
      artifacts: { type: 'array', items: { type: 'string' }, description: '用户会要看的产物文件：子工作区产物用相对路径（如 report.md）；共享知识库产物用 kb_vault/ 开头的主工作区相对路径（如 kb_vault/<session_id>/assets/原件.pdf）；禁止绝对路径和 ..' },
    },
    description: 'completed 时必填：最终结果与产物',
  },
  questions: {
    type: 'array',
    description: 'input_required 时必填：结构化问题（一次问清，id 可省略会自动分配并在返回值回显）',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: '问题 id，省略则自动分配 q1/q2/…' },
        question: { type: 'string', required: true, description: '问题正文（可直接展示给用户）' },
        header: { type: 'string', description: '短标题/分组（如"确认"）' },
        detail: { type: 'string', description: '补充说明（不出现在选项里）' },
        options: {
          type: 'array',
          description: '可选项；推荐项放首位并在 label 末尾加 (Recommended)',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string', required: true, description: '短选项文案' },
              description: { type: 'string', description: '一句话说明该选项的影响' },
            },
          },
        },
        multi_select: { type: 'boolean', description: '是否可多选，默认单选' },
      },
    },
  },
  fail: {
    type: 'object',
    additionalProperties: false,
    properties: {
      error: { type: 'string', required: true, description: '失败原因和已尝试的办法' },
      reasonCode: { type: 'string', enum: [...blockReasonCodes], description: '系统阻碍类别（权限/配置/依赖/网络/资源/运行时）；普通失败不填' },
    },
    description: 'failed 时必填：失败原因；带 reasonCode 表示系统阻碍（可修复后重试）',
  },
  schedules: {
    type: 'object',
    additionalProperties: false,
    properties: {
      create: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string', required: true, description: '日程标题（极简，≤30 字）' },
            startAt: { type: 'string', description: '开始时间，如 10-28 09:00（可带年份 2026-10-28 09:00；事项可开始办理的时间窗起点，无明确起点不填）' },
            endAt: { type: 'string', description: '结束时间，如 10-28 22:00（事项应完成的时刻）' },
            remindAt: { type: 'string', description: '提醒时间，如 10-28 17:30（到点提醒用户，与时间窗分开）' },
            priority: { type: 'string', enum: [...todoPriorities], description: 'P0 紧急且重要 / P1 重要不紧急 / P2 紧急不重要 / P3 有空再做（默认 P3）' },
            links: {
              type: 'array',
              items: { type: 'object', additionalProperties: false, properties: {
                url: { type: 'string', required: true, description: 'http(s) 网址' },
                label: { type: 'string', description: '显示名（缺省显示域名）' },
              } },
              description: '相关链接（≤10）',
            },
            attachments: {
              type: 'array',
              items: { type: 'object', additionalProperties: false, properties: {
                path: { type: 'string', required: true, description: '子工作区相对路径（禁止绝对路径和 ..）' },
                name: { type: 'string', description: '显示名（缺省显示文件名）' },
              } },
              description: '附件文件（≤10，须已在工作区内生成）',
            },
            contacts: {
              type: 'array',
              items: { type: 'object', additionalProperties: false, properties: {
                name: { type: 'string', required: true },
                phone: { type: 'string' },
                email: { type: 'string' },
                note: { type: 'string', description: '如可用时段' },
              } },
              description: '联系人信息卡（≤5，电话/邮箱供用户点按联系）',
            },
            location: {
              type: 'object', additionalProperties: false, properties: {
                name: { type: 'string', required: true },
                address: { type: 'string' },
              },
              description: '地点（名称+可选地址）',
            },
            remark: { type: 'string', description: '备注：纯文字说明。联系方式/网址/地点/文件用 contacts/links/location/attachments 字段，不要堆在这里' },
          },
        },
        description: '新建用户日程：只有助理代替不了、需要用户本人推进的事才建；必须挂在 task_update 顶层，不要放进 report；电话/网址/地点/附件写进 contacts/links/location/attachments 字段',
      },
      update: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: '日程 id（从投递附言/本工具返回值的清单里抄，禁止编造）' },
            status: { type: 'string', enum: ['pending', 'done', 'cancelled'], description: '代办完成标 done；不再适用标 cancelled' },
            title: { type: 'string', description: '改标题（≤30 字）' },
            startAt: { type: 'string', description: '开始时间，如 10-28 09:00（可带年份）' },
            endAt: { type: 'string', description: '结束时间，如 10-28 22:00' },
            remindAt: { type: 'string', description: '提醒时间，如 10-28 17:30' },
            priority: { type: 'string', enum: [...todoPriorities], description: 'P0~P3' },
            links: {
              type: 'array',
              items: { type: 'object', additionalProperties: false, properties: {
                url: { type: 'string', required: true }, label: { type: 'string' },
              } },
            },
            attachments: {
              type: 'array',
              items: { type: 'object', additionalProperties: false, properties: {
                path: { type: 'string', required: true }, name: { type: 'string' },
              } },
            },
            contacts: {
              type: 'array',
              items: { type: 'object', additionalProperties: false, properties: {
                name: { type: 'string', required: true }, phone: { type: 'string' }, email: { type: 'string' }, note: { type: 'string' },
              } },
            },
            location: {
              type: 'object', additionalProperties: false, properties: {
                name: { type: 'string', required: true }, address: { type: 'string' },
              },
            },
            remark: { type: 'string', description: '备注：纯文字说明' },
          },
        },
        description: '更新已有日程：按 id 改状态或内容（改谁带谁）',
      },
    },
    description: '用户日程：新的放 create，改的放 update（抄 id）',
  },
} as const

export default OrchestratorService
