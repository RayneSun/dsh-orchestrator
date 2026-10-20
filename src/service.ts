import { randomUUID } from 'node:crypto'
import { mkdir, rmdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
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
import { deliveryNotice, revisionPrompt, rosterSummarySegment, workerPrompt } from './messages.ts'
import { applyScheduleMark, type ScheduleServiceLike, type SessionActivityGroup } from './schedule-marks.ts'
import { toJson } from './json.ts'
import { isWorkerToolForbidden } from './worker-policy.ts'
import { normalizeProgressSteps } from './progress.ts'
import { buildChildWorkspace, ensureSharedMemoryLink } from './workspaces.ts'
import { orchestratorDomain } from './storage.ts'
import { buildPresetDefinitions, LEAD_PRESET, LEAD_TOOL_ALLOW, WORKER_PRESET } from './presets.ts'
import {
  activateConversation,
  applyOutlinePatch,
  interruptTaskForRevision,
  reviseConversation,
  failConversation,
  blockTask,
  failTask,
  interruptTaskAfterRestart,
  settleConversation,
  startConversation,
  classifyWorkerTurnEnd,
  transitionTask,
  type WorkerTurnEndCause,
} from './state-machine.ts'
import {
  createConversation,
  createId,
  createTask,
  timestamp,
  type ConversationRecord,
  type OutlinePatch,
  type ProgressStep,
  type Snapshot,
  type TaskRecord,
  activeTaskStatuses,
  blockReasonCodes,
  deliverableTaskStatuses,
  taskUpdateStatuses,
  dispatchInputSchema,
  conversationIdInputSchema,
  taskUpdateInputSchema,
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

/** Worker 子会话用空 section 遮蔽的全局系统提示段（同名 scoped section shadow 全局）。 */
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
const WORKER_SUPPRESSED_SECTIONS = ['harness:source', 'app:web-surface', 'ui:deliverable-file-references'] as const
/** Lead 白名单不含邮件工具，但 qqmail 会全局公告工具能力；遮蔽避免主控看到却调不到而产生幻觉。 */
const LEAD_SUPPRESSED_SECTIONS = ['plugin:dsh-qqmail'] as const
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

export class OrchestratorService extends TypertRemoteService {
  static inject = [
    'agents', 'sessions', 'storageDomain',
    'sessionController', 'sessionPersistence', 'agentPresets', 'sessionTitle',
    'sessionProjections', 'agentDefaultModel',
  ]

  private ready: Promise<void>
  private domain: DomainType | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private readonly installed = new Map<string, Array<() => unknown>>()
  private readonly delivering = new Set<string>()
  private readonly pendingTodoSteps = new Map<string, { taskId: string; steps: ProgressStep[] }>()
  private readonly todoTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // 改单 cancel 自身会产生一次 aborted turn/end，需要忽略，不能当成手动停止或任务失败。
  private readonly revisionTurnEnds = new Map<string, number>()
  /** childSessionId -> 是否绑定了活动定时任务（看板 badge 数据源，内存推导不落库）。 */
  private readonly scheduleMarks = new Map<string, boolean>()
  /** childSessionId -> 已同步到 DSH 侧栏的标题（含 ⏰ 前缀），用于跳过无谓 rename。 */
  private readonly syncedTitles = new Map<string, string>()
  private scheduleSyncTimer: ReturnType<typeof setTimeout> | undefined
  private recoveryTimer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly hostCtx: Context) {
    super(hostCtx, 'orchestrator', { namespace: 'orchestrator' })
    this.markRemote('snapshot')
    this.ready = this.start()
  }

  async [Service.init](): Promise<void> {
    await this.ready
  }

  /** Standalone tsdown does not run Typert's decorator lowering; use its public decorator API once per instance. */
  private markRemote(method: 'snapshot'): void {
    const prototype = Object.getPrototypeOf(this) as Record<'snapshot', unknown>
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
        return async () => {
          offPreset()
          offCreated()
          offScheduleChanged()
          offActivity()
          if (this.scheduleSyncTimer) clearTimeout(this.scheduleSyncTimer)
          if (this.recoveryTimer) clearInterval(this.recoveryTimer)
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

  private snapshotFor(parentSessionId: string): Snapshot {
    const conversations = [...this.conversations().entries()]
      .map(([, conv]) => conv)
      .filter(conv => conv.parentSessionId === parentSessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map(conv => this.scheduleMarks.get(conv.childSessionId) ? { ...conv, hasActiveSchedule: true } : conv)
    const ids = new Set(conversations.map(conv => conv.id))
    const tasks = [...this.tasks().entries()]
      .map(([, task]) => task)
      .filter(task => ids.has(task.conversationId))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return { conversations, tasks }
  }

  async snapshot(request: { parentSessionId: string }): Promise<Snapshot> {
    await this.ready
    return this.snapshotFor(request.parentSessionId)
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
      await this.configureWorker(agent, conv)
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
    }))
    this.applyLeadToolWhitelist(agent, scoped)
    for (const sectionName of LEAD_SUPPRESSED_SECTIONS) {
      this.keep(agent, scoped.systemPrompt.section({ name: sectionName, order: 0, text: '', interpolate: false }))
    }
    for (const tool of this.leadTools(agent)) this.keep(agent, scoped.tools.register(tool as any))
  }

  /** Lead 白名单：只保留显式允许且当前确实注册的全局工具；用户后装的工具不会打扰主控。 */
  private applyLeadToolWhitelist(agent: Agent, scoped: Agent['ctx']): void {
    try {
      // 必须在注册 orchestrator_* 之前枚举：此时作用域内只有继承自全局层的工具；
      // restrict 只过滤全局层，scope 内的 orchestrator_* 始终可见。
      const globalNames = new Set(scoped.tools.schemas().map(schema => schema.name))
      const allow = LEAD_TOOL_ALLOW.filter(name => globalNames.has(name))
      if (allow.length > 0) this.keep(agent, scoped.tools.restrict({ allow: [...allow] }))
      else this.hostCtx.logger.warn('orchestrator: lead tool whitelist matched no global tools; skipping restriction')
    } catch (error) {
      // 枚举失败时退回无限制，避免主控完全失去工具。
      this.hostCtx.logger.warn(`orchestrator: lead tool whitelist failed: ${String(error)}`)
    }
  }

  private async configureWorker(agent: Agent, conv: ConversationRecord): Promise<void> {
    await this.resetInstalled(String(agent.session.id))
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
    this.keep(agent, scoped.tools.guard(exec => isWorkerToolForbidden(exec.name)))
    // 遮蔽与 Worker 任务无关的全局系统提示段（DSH 自举开发说明、Web GUI/HMR 说明、
    // 面向终端用户的文件卡片/Markdown 链接指引），每个子会话可省约 2.2k 字符；
    // scoped 同名 section 只影响本子会话，主会话仍保留。
    for (const sectionName of WORKER_SUPPRESSED_SECTIONS) {
      this.keep(agent, scoped.systemPrompt.section({ name: sectionName, order: 0, text: '', interpolate: false }))
    }
    this.keep(agent, scoped.on('session/event', (session, event) => {
      if (String(session.id) !== String(agent.session.id)) return
      const ev = event as unknown as { type?: unknown; data?: { todos?: unknown; reason?: unknown } }
      if (ev.type === 'todo/write') {
        this.queueTodoProgress(String(agent.session.id), ev.data?.todos)
        return
      }
      if (ev.type === 'turn/end') {
        const childId = String(agent.session.id)
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
      description: '向 Orchestrator Host 上报当前子会话活动 TaskRun 的状态。不接受 task id，Host 根据会话身份反查。无活动任务时仅允许 completed（定时触发后的结果上报）。',
      parameters: {
        status: { type: 'string', required: true, enum: [...taskUpdateStatuses] },
        progressNote: { type: 'string', description: '进展说明' },
        userAnswer: { type: 'string', description: 'completed 时必填：给 Lead 转述给用户的权威最终答案' },
        resultSummary: { type: 'string', description: '一句话结果摘要' },
        error: { type: 'string', description: 'failed/blocked 时必填：失败原因或系统阻碍' },
        question: { type: 'string', description: 'input_required 时必填：可直接转达给用户的问题/接管提示，需自包含、一次问清' },
        reasonCode: { type: 'string', enum: [...blockReasonCodes], description: 'blocked 的阻碍类别' },
        remediation: { type: 'string', description: 'blocked 时建议用户执行的补救动作' },
        outlinePatch: {
          type: 'object',
          additionalProperties: false,
          properties: {
            title: { type: 'string' },
            summary: { type: 'string' },
            keyFacts: { type: 'array', items: { type: 'string' } },
            entities: { type: 'array', items: { type: 'string' } },
            tags: { type: 'array', items: { type: 'string' } },
            artifacts: { type: 'array', items: { type: 'string' } },
            openQuestions: { type: 'array', items: { type: 'string' } },
          },
          description: '更新轻量路由卡；不要提交子会话全文',
        },
      },
      output: sharedJsonOutput,
      execute: async (args: any) => toJson(await this.updateFromWorker(args, String(agent.session.id))),
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
      const tail = active
        ? `｜进行中：${active.subject}`
        : last?.resultSummary || last?.userAnswer
          ? `｜最近结果：${(last.resultSummary || last.userAnswer)!.slice(0, 80)}`
          : ''
      return `- ${conv.id} [${conv.state}] ${conv.title}${rosterSummarySegment(conv.outline.summary)}｜创建 ${formatRosterTime(conv.createdAt)}｜更新 ${formatRosterTime(conv.updatedAt)}${tail}`
    })
    return `Orchestrator roster（dispatch 用 conversationId 复用子会话；get 看详情）：\n${lines.join('\n')}`
  }
  /** list 工具的精简投影：只给模型决策所需字段，避免内部 ID 和大段文本污染上下文。 */
  private listWorkflows(parentSessionId: string) {
    const { conversations, tasks } = this.snapshotFor(parentSessionId)
    const byConv = new Map<string, TaskRecord[]>()
    for (const task of tasks) byConv.set(task.conversationId, [...(byConv.get(task.conversationId) ?? []), task])
    return conversations.map(conv => {
      const active = conv.activeTaskId ? this.taskById(conv.activeTaskId) : undefined
      const convTasks = byConv.get(conv.id) ?? []
      const last = convTasks[convTasks.length - 1]
      return {
        conversationId: conv.id,
        title: conv.title,
        state: conv.state,
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt,
        ...active ? { active: active.subject } : {},
        ...last && !active ? { lastStatus: last.status, lastResult: last.resultSummary ?? last.userAnswer } : {},
      }
    })
  }

  private leadTools(agent: Agent) {
    const parentId = () => String(agent.session.id)
    return [
      defineTool({
        name: 'orchestrator_dispatch',
        description: '新建工作流，或把新需求派发给已有持久子会话；目标会话正忙时会自动中断旧任务并把新需求注入同一子会话。',
        parameters: {
          subject: { type: 'string', required: true, description: '短主题' },
          workspaceName: { type: 'string', description: '新建子会话时的工作区目录名，简短可文件系统使用；复用已有子会话时忽略；缺省由 subject 生成' },
          prompt: { type: 'string', required: true, description: '需求本身和验收点。Worker 与你共享同一工作区，不要重复工作目录、路径等环境声明，不要粘贴内部 ID' },
          conversationId: { type: 'string', description: '复用已有工作流时提供' },
          conversationTitle: { type: 'string', description: '可选：重命名子会话标题（侧栏/看板同步），仅当会话主题漂移时使用' },
          acceptanceCriteria: { type: 'string', description: '可选验收标准' },
          silent: { type: 'boolean', description: '静默模式：记忆整理等后台维护任务使用；终态不会向主会话投递任何消息，看板仍可见状态' },
        },
        output: sharedJsonOutput,
        execute: async (args: any) => toJson(await this.dispatch(args, agent)),
      }),
      defineTool({
        name: 'orchestrator_list',
        description: '列出当前主会话下全部工作流的精简状态。',
        parameters: {},
        output: sharedJsonOutput,
        execute: async () => toJson({ workflows: this.listWorkflows(parentId()) }),
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
              ...task.question ? { question: task.question } : {},
              ...task.userAnswer ? { answer: task.userAnswer } : {},
              ...task.reasonCode ? { reasonCode: task.reasonCode } : {},
              ...task.remediation ? { remediation: task.remediation } : {},
              ...task.error ? { error: task.error } : {},
              updatedAt: task.updatedAt,
            }))
          return toJson({
            title: conv.title,
            state: conv.state,
            createdAt: conv.createdAt,
            updatedAt: conv.updatedAt,
            outline: {
              summary: conv.outline.summary,
              keyFacts: conv.outline.keyFacts.slice(-5),
              artifacts: conv.outline.artifacts.slice(-5),
              openQuestions: conv.outline.openQuestions,
            },
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
        if (active && (activeTaskStatuses as readonly string[]).includes(active.status)) {
          interruptedTaskId = active.id
        }
      }

      task = createTask({
        id: createId('task'),
        parentSessionId,
        conversationId: existing.id,
        predecessorTaskId: existing.lastTaskId,
        subject: args.subject,
        prompt: args.prompt,
        ...args.acceptanceCriteria ? { acceptanceCriteria: args.acceptanceCriteria } : {},
        ...args.silent ? { silent: true } : {},
      })
      conv = interruptedTaskId
        ? reviseConversation(existing, task.id, at)
        : activateConversation(existing, task.id, at)
      // 会话主题漂移：Lead 显式传 conversationTitle 才改名，标题保持克制不随每条任务措辞抖动。
      const titleChanged = args.conversationTitle !== undefined && args.conversationTitle !== existing.title
      if (titleChanged) conv = { ...conv, title: args.conversationTitle! }
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
        const text = interruptedTaskId ? revisionPrompt(task) : workerPrompt(task)
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
      const workspace = await buildChildWorkspace(parentCwd, args.workspaceName ?? args.subject)
      await mkdir(workspace.dir, { recursive: true })
      await this.shareMemoryWithRoot(workspace.dir, parentCwd)
      const provisional = createConversation({
        id: conversationId,
        childSessionId,
        parentSessionId,
        title: args.conversationTitle ?? args.subject,
        workspaceName: workspace.name,
        workspaceDir: workspace.dir,
      })
      conv = { ...provisional, activeTaskId: taskId, lastTaskId: taskId }
      task = createTask({
        id: taskId,
        parentSessionId,
        conversationId,
        predecessorTaskId: null,
        subject: args.subject,
        prompt: args.prompt,
        ...args.acceptanceCriteria ? { acceptanceCriteria: args.acceptanceCriteria } : {},
        ...args.silent ? { silent: true } : {},
      })
      await this.putPair(conv, task)
      try {
        await this.createWorkerAgent(childSessionId, workspace.dir, parent, conv.title)
        await this.deliverToWorker(childSessionId, workerPrompt(task), `orchestrator task ${task.subject}`)
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

  /**
   * 记忆库共享：把 Worker 工作区的 .dsh-meow 链接到主工作区，Lead 与全部 Worker 共用
   * 同一份 meow-memory 长期记忆。失败（如 Windows 无 symlink 权限）降级为独立记忆，仅告警。
   */
  private async shareMemoryWithRoot(workspaceDir: string, rootCwd: string): Promise<void> {
    try {
      await ensureSharedMemoryLink(workspaceDir, rootCwd)
    } catch (error) {
      this.hostCtx.logger.warn(`orchestrator: shared memory link failed for ${workspaceDir}: ${String(error)}`)
    }
  }

  /** 宿主 schedule 服务（本地结构化类型，组合未挂载时整体降级为无标记）。 */
  private scheduleService(): ScheduleServiceLike | undefined {
    return (this.hostCtx as unknown as { schedule?: ScheduleServiceLike }).schedule
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
   * 核对全部受管子会话的活动定时任务：更新看板标记（hasActiveSchedule）并把
   * DSH 侧栏标题同步为「看板标题 + ⏰ 前缀」。单会话 list 失败跳过该会话，不影响其余。
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
      await this.renameWorkerSession(conv.childSessionId)
      if (previous !== marked) this.emitChanged()
    }
  }

  /**
   * 子会话标题同步：DSH 侧栏标题 = 看板标题 + 定时标记 ⏰ 前缀；与上次同步值一致则跳过，
   * rename 失败仅告警（下次 schedule/changed 核对时按 diff 重试）。
   */
  private async renameWorkerSession(childSessionId: string): Promise<void> {
    const conv = this.conversationByChild(childSessionId)
    if (!conv) return
    const desired = applyScheduleMark(conv.title, this.scheduleMarks.get(childSessionId) ?? false)
    if (this.syncedTitles.get(childSessionId) === desired) return
    try {
      await this.hostCtx.agents.withoutInitiator(async () => {
        const resolved = await this.hostCtx.sessionController.resolveAgent(childSessionId as SessionId)
        if ('error' in resolved) throw resolved.error
        this.hostCtx.sessionTitle.rename(resolved.agent.session, desired)
      })
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
    await this.hostCtx.agents.withoutInitiator(async () => {
      const resolved = await this.hostCtx.sessionController.resolveAgent(childSessionId as SessionId)
      if ('error' in resolved) throw resolved.error
      const message = createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'orchestrator', form: 'notice', summary: summary.slice(0, 120) },
      })
      resolved.agent.followup(message)
      const flushed = await this.hostCtx.sessions.flush(resolved.agent.session)
      if (!flushed) throw new Error('Session persistence did not acknowledge orchestrator worker prompt')
    })
  }

  /** 取消 Worker 当前轮次（改单前置）：原因记为 parent，turn/end 据此归类为 revision。 */
  private async interruptWorker(childSessionId: string): Promise<void> {
    await this.hostCtx.agents.withoutInitiator(async () => {
      const resolved = await this.hostCtx.sessionController.resolveAgent(childSessionId as SessionId)
      if ('error' in resolved) throw resolved.error
      resolved.agent.cancel({ kind: 'parent' })
    })
  }

  private async failLaunch(conv: ConversationRecord, task: TaskRecord, error: unknown): Promise<unknown> {
    const now = timestamp()
    if (conv.workspaceDir) await rmdir(conv.workspaceDir).catch(() => undefined)
    const failedTask = failTask(task, String(error), now)
    const failedConv = failConversation(settleConversation(conv, failedTask, now), now)
    await this.putPair(failedConv, failedTask)
    if (!failedTask.silent) void this.deliverPendingTask(failedTask.id)
    return { kind: 'error', error: String(error) }
  }


  private async updateFromWorker(rawArgs: unknown, childSessionId: string): Promise<any> {
    const parsed = taskUpdateInputSchema.safeParse(rawArgs)
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'invalid task_update arguments')
    const args: TaskUpdateInput = parsed.data
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
        const subject = (args.outlinePatch?.title?.trim() || args.userAnswer?.trim().split('\n')[0] || '定时触发上报').slice(0, 60)
        const seeded = createTask({
          id: createId('task'),
          parentSessionId: conv.parentSessionId,
          conversationId: conv.id,
          predecessorTaskId: conv.lastTaskId,
          subject,
          prompt: '（定时触发或 Worker 自发上报）',
        })
        const task = transitionTask({ ...seeded, status: 'running', startedAt: seeded.createdAt }, args)
        const patched = args.outlinePatch ? applyOutlinePatch(conv, args.outlinePatch as OutlinePatch) : conv
        await this.putPair(settleConversation(patched, task), task)
        terminalTaskId = task.id
        shouldDeliver = task.delivery?.state === 'pending'
        return { ok: true as const, status: task.status }
      }
      const previous = this.taskById(conv.activeTaskId)
      if (!previous) throw new Error('active task record is missing')

      const task = transitionTask(previous, args)
      const terminal = (deliverableTaskStatuses as readonly string[]).includes(task.status)
      const patched = args.outlinePatch ? applyOutlinePatch(conv, args.outlinePatch as OutlinePatch) : conv
      // running 只更新路由卡，不能释放 activeTaskId；终态才 settle。
      const nextConv = terminal ? settleConversation(patched, task) : patched
      await this.putPair(nextConv, task)
      if (terminal) {
        terminalTaskId = task.id
        shouldDeliver = task.delivery?.state === 'pending'
      }
      return { ok: true as const, status: task.status }
    })
    if (shouldDeliver && terminalTaskId) void this.deliverPendingTask(terminalTaskId)
    return result
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
        // 手动停止需要通知主会话：挂起投递，由 deliverPendingTask 发通知；静默任务除外。
        if (!task.silent) {
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
        task = failTask(previous, previous.status === 'queued' ? '子会话在任务开始前结束' : '子会话结束前未提交终态 task_update', now)
        nextConv = failConversation(settleConversation(conv, task, now), now)
        shouldDeliver = true
        outcome = 'failed'
      }
      await this.putPair(nextConv, task)
      taskId = task.id
    })
    if (outcome === 'manual_stop') {
      this.hostCtx.logger.info?.(`orchestrator: task ${taskId} interrupted by manual stop: ${childSessionId}`)
    }
    if (outcome === 'revision') {
      this.hostCtx.logger.info?.(`orchestrator: task ${taskId} interrupted by revision: ${childSessionId}`)
    }
    if (shouldDeliver && taskId) await this.deliverPendingTask(taskId)
  }

  private async deliverPendingTask(taskId: string): Promise<void> {
    if (this.delivering.has(taskId)) return
    const task = this.taskById(taskId)
    if (!task || task.silent || task.delivery?.state !== 'pending') return
    if (!(deliverableTaskStatuses as readonly string[]).includes(task.status)) return
    this.delivering.add(taskId)
    try {
      await this.hostCtx.agents.withoutInitiator(async () => {
        const resolved = await this.hostCtx.sessionController.resolveAgent(task.parentSessionId as SessionId)
        if ('error' in resolved) throw resolved.error
        const message = createUserMessage({
          content: [{ type: 'text', text: deliveryNotice(task) }],
          source: { kind: 'orchestrator', form: 'notice', summary: `orchestrator ${task.status}: ${task.subject}`.slice(0, 120) },
        })
        resolved.agent.followup(message)
        const flushed = await this.hostCtx.sessions.flush(resolved.agent.session)
        if (!flushed) throw new Error('Session persistence did not acknowledge orchestrator delivery')
        await this.serialize(async () => {
          const current = this.taskById(taskId)
          if (!current) return
          const now = timestamp()
          await this.tasks().put(taskId, {
            ...current,
            revision: current.revision + 1,
            updatedAt: now,
            delivery: { state: 'delivered', deliveredAt: now, messageId: String(message.id) },
          })
          this.emitChanged()
        })
      })
    } catch (error) {
      try {
        await this.serialize(async () => {
          const current = this.taskById(taskId)
          if (!current || current.delivery?.state !== 'pending') return
          const attempts = current.delivery.attempts + 1
          await this.tasks().put(taskId, {
            ...current,
            revision: current.revision + 1,
            updatedAt: timestamp(),
            delivery: { state: 'pending', attempts, lastError: String(error) },
          })
          this.emitChanged()
        })
      } catch (markError) {
        this.hostCtx.logger.warn(`orchestrator: mark delivery failure ${taskId} failed: ${String(markError)}`)
      }
      this.hostCtx.logger.warn(`orchestrator: deliver ${taskId} failed: ${String(error)}`)
    } finally {
      this.delivering.delete(taskId)
    }
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
      const now = timestamp()
      for (const [, conv] of this.conversations().entries()) {
        // 存量会话补建共享记忆链接（workspaceDir 是主工作区的直接子目录，dirname 即主工作区）。
        if (conv.workspaceDir) await this.shareMemoryWithRoot(conv.workspaceDir, dirname(conv.workspaceDir))
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
            const nextTask = blockTask(
              active,
              '重启后无法确认子会话持久化状态，可能是存储权限或运行时 I/O 暂时不可用',
              { reasonCode: 'runtime', remediation: '请稍后让我继续重试；若反复出现，请重启 Web 后再恢复任务' },
              now,
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
