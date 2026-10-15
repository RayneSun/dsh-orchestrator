import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { queueHostSubagentPrompt, steerHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { WORKER_PROMPT, deliveryNotice, revisionPrompt, workerPrompt } from './messages.ts'
import { toJson } from './json.ts'
import { routeQuery } from './router.ts'
import { isWorkerToolForbidden } from './worker-policy.ts'
import { normalizeProgressSteps } from './progress.ts'
import { orchestratorDomain } from './storage.ts'
import { buildPresetDefinitions, LEAD_PRESET, LEAD_TOOL_ALLOW, WORKER_PRESET } from './presets.ts'
import {
  activateConversation,
  applyOutlinePatch,
  interruptTaskForRevision,
  reviseConversation,
  failConversation,
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
  deliverableTaskStatuses,
  dispatchInputSchema,
  routeQueryInputSchema,
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
type Waiter = { resolve: (task: TaskRecord) => void }
type DispatchProvision =
  | { ok: true; conv: ConversationRecord; task: TaskRecord }
  | { ok: false; result: unknown }

/** Worker 子会话用空 section 遮蔽的全局系统提示段（同名 scoped section shadow 全局）。 */
const WORKER_SUPPRESSED_SECTIONS = ['harness:source', 'app:web-surface', 'ui:deliverable-file-references'] as const
const RECOVERY_INTERVAL_MS = 15_000
const REVISION_GUARD_MS = 120_000
const TODO_FLUSH_DELAY_MS = 350
const DEFAULT_WAIT_TIMEOUT_MS = 60_000
const LAUNCH_ACCEPT_TIMEOUT_MS = 120_000
const PERSISTENCE_STAT_TIMEOUT_MS = 5_000

type WorkerTurnEnd = { until: number; cause: WorkerTurnEndCause }

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

export class OrchestratorService extends TypertRemoteService {
  static inject = [
    'agents', 'sessions', 'subagents', 'storageDomain',
    'sessionController', 'sessionPersistence', 'agentPresets',
  ]

  private ready: Promise<void>
  private domain: DomainType | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private readonly waiters = new Map<string, Waiter>()
  private readonly installed = new Map<string, Array<() => unknown>>()
  private readonly delivering = new Set<string>()
  private readonly pendingTodoSteps = new Map<string, { taskId: string; steps: ProgressStep[] }>()
  private readonly todoTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private readonly revisionEndGuards = new Map<string, { until: number; oldTaskId: string }>()
  // 改单 interrupt 自身会产生一次 aborted turn/end，需要忽略，不能当成手动停止。
  private readonly revisionTurnEnds = new Map<string, number>()
  // 子会话 turn/end aborted/interrupted → 紧随其后的 subagent/end 是手动停止，不是任务失败。
  private readonly workerTurnEnds = new Map<string, WorkerTurnEnd>()
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
        const offEnd = this.hostCtx.on('subagent/end', (info) => {
          void this.onSubagentEnd(String(info.id)).catch(error => {
            this.hostCtx.logger.warn(`orchestrator: subagent/end handler failed: ${String(error)}`)
          })
        })
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
        this.recoveryTimer = setInterval(() => { void this.recoverDeliveries() }, RECOVERY_INTERVAL_MS)
        this.recoveryTimer.unref()
        return async () => {
          offEnd()
          offPreset()
          offCreated()
          if (this.recoveryTimer) clearInterval(this.recoveryTimer)
          await this.chain.catch(() => undefined)
          await domain.close()
        }
      }, 'may-orchestrator:lifecycle')

      await this.recoverRuntimeState()
      void this.recoverDeliveries()
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
    this.installSettlementFilter(agent)
    this.keep(agent, scoped.systemPrompt.section({
      name: 'orchestrator:roster',
      order: 610,
      text: () => this.renderRoster(String(agent.session.id)),
    }))
    this.applyLeadToolWhitelist(agent, scoped)
    this.keep(agent, scoped.on('agent/pre-step', async ({ messages }, next) => {
      if (!messages.some(message => this.isManagedSettlement(agent, message))) return next()
      const visible = messages.filter(message => !this.isManagedSettlement(agent, message))
      if (visible.length === 0) return { kind: 'reject' as const }
      return { kind: 'enter' as const, messages: visible }
    }))
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

  private isManagedSettlement(agent: Agent, message: { source?: unknown }): boolean {
    const source = message.source as { kind?: string; senderSessionId?: string } | undefined
    if (source?.kind !== 'subagent-settled' || typeof source.senderSessionId !== 'string') return false
    return this.conversationByChild(source.senderSessionId)?.parentSessionId === String(agent.session.id)
  }

  /** task_update 是唯一完成通道；过滤子代理框架自带的 settled 唤醒，避免空回合和重复答案。 */
  private installSettlementFilter(agent: Agent): void {
    for (const name of ['followup', 'steer', 'inject'] as const) {
      const original = agent[name].bind(agent)
      const replacement = (message: { source?: unknown }): void => {
        if (this.isManagedSettlement(agent, message)) return
        original(message as never)
      }
      ;(agent as unknown as Record<typeof name, typeof replacement>)[name] = replacement
      this.keep(agent, () => {
        ;(agent as unknown as Record<typeof name, typeof original>)[name] = original
      })
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
          if (Date.now() <= until) return // 改单 interrupt 的预期内轮次结束，不是手动停止。
        }
        const cause = classifyWorkerTurnEnd(ev.data?.reason)
        if (cause) this.workerTurnEnds.set(childId, { until: Date.now() + REVISION_GUARD_MS, cause })
      }
    }))
    this.keep(agent, scoped.tools.register(defineTool({
      name: 'task_update',
      description: '向 Orchestrator Host 上报当前子会话活动 TaskRun 的状态。不接受 task id，Host 根据会话身份反查。',
      parameters: {
        status: { type: 'string', required: true, enum: ['running', 'input_required', 'completed', 'failed'] },
        progressNote: { type: 'string', description: '进展说明' },
        userAnswer: { type: 'string', description: 'completed 时必填：给 Lead 转述给用户的权威最终答案' },
        resultSummary: { type: 'string', description: '一句话结果摘要' },
        error: { type: 'string', description: 'failed 的错误，或 input_required 的外部阻塞原因' },
        question: { type: 'string', description: 'input_required 时给用户的问题，需自包含、一次问清' },
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

  private armRevisionEndGuard(childSessionId: string, oldTaskId: string): void {
    // interrupt 的取消效果异步到达：下一次 subagent/end 属于旧轮次，必须忽略。
    // 守卫过期后不再吞掉新任务真正的失败信号。
    const until = Date.now() + REVISION_GUARD_MS
    this.revisionEndGuards.set(childSessionId, { until, oldTaskId })
    this.revisionTurnEnds.set(childSessionId, until)
  }

  /** 取子会话最近一次结束原因；时间窗口外视为过期，防止旧 turn 波及新任务。 */
  private consumeWorkerTurnEnd(childSessionId: string): WorkerTurnEndCause | undefined {
    const turn = this.workerTurnEnds.get(childSessionId)
    if (!turn) return undefined
    this.workerTurnEnds.delete(childSessionId)
    return Date.now() <= turn.until ? turn.cause : undefined
  }

  /** 改单注入中断后，旧轮次结束属于预期事件：仅当活动任务确实已切到新任务时忽略一次。 */
  private consumeRevisionEnd(childSessionId: string, activeTaskId: string | null | undefined): boolean {
    const guard = this.revisionEndGuards.get(childSessionId)
    if (!guard) return false
    this.revisionEndGuards.delete(childSessionId)
    if (Date.now() > guard.until) return false
    return activeTaskId !== guard.oldTaskId
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
      return `- ${conv.id} [${conv.state}] ${conv.title}${tail}`
    })
    return `Orchestrator roster（route 复用 id；get 看详情）：\n${lines.join('\n')}`
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
        ...active ? { active: active.subject } : {},
        ...last && !active ? { lastStatus: last.status, lastResult: last.resultSummary ?? last.userAnswer } : {},
      }
    })
  }

  private leadTools(agent: Agent) {
    const parentId = () => String(agent.session.id)
    return [
      defineTool({
        name: 'orchestrator_route',
        description: '根据新用户请求匹配可复用的工作流。强相关追问和改单应复用原会话。',
        parameters: { query: { type: 'string', required: true, description: '用户的新需求' } },
        output: sharedJsonOutput,
        execute: async (args: unknown) => {
          const parsed = routeQueryInputSchema.safeParse(args)
          if (!parsed.success) return toJson({ kind: 'error', error: parsed.error.issues[0]?.message ?? 'invalid orchestrator_route arguments' })
          // 改需求/追问可能发生在子任务仍在运行时，运行中的工作流也要作为候选。
          const conversations = this.snapshotFor(parentId()).conversations.filter(conv => conv.state !== 'failed')
          const candidates = routeQuery(parsed.data.query, conversations, 6).map(candidate => ({
            conversationId: candidate.conversation.id,
            title: candidate.conversation.title,
            state: candidate.conversation.state,
            score: candidate.score,
            reasons: candidate.reasons,
          }))
          return toJson({ candidates })
        },
      }),
      defineTool({
        name: 'orchestrator_dispatch',
        description: '新建工作流，或把新需求派发给已有持久子会话；目标会话正忙时会自动中断旧任务并把新需求注入同一子会话。',
        parameters: {
          subject: { type: 'string', required: true, description: '短主题' },
          prompt: { type: 'string', required: true, description: '需求本身和验收点。Worker 与你共享同一工作区，不要重复工作目录、路径等环境声明，不要粘贴内部 ID' },
          conversationId: { type: 'string', description: '复用已有工作流时提供' },
          responseMode: { type: 'string', enum: ['wait', 'background'], description: '默认 background，不阻塞主对话；wait 仅用于需要同轮结果的短任务' },
          acceptanceCriteria: { type: 'string', description: '可选验收标准' },
          waitTimeoutMs: { type: 'integer', description: 'wait 超时，默认 60000；超时自动转后台' },
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
              ...task.error ? { error: task.error } : {},
              updatedAt: task.updatedAt,
            }))
          return toJson({
            title: conv.title,
            state: conv.state,
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
    const responseMode = args.responseMode
    const timeout = args.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS

    // waitTask 必须在串行写锁外等待，否则 Worker 的 task_update 无法进入状态机。
    let provisioned: DispatchProvision
    try {
      provisioned = await this.serialize(() => this.provisionDispatch(args, parent, parentSessionId))
    } catch (error) {
      return { kind: 'error', error: String(error instanceof Error ? error.message : error) }
    }
    if (provisioned.ok === false) return provisioned.result
    const { conv, task } = provisioned
    if (responseMode === 'background') {
      return { ok: true, status: 'background', conversationId: conv.id }
    }
    return await this.waitTask(task.id, timeout)
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

      // 改需求：先在存储里原子完成“旧任务 interrupted + 新任务 active”，再中断子会话当前轮次，
      // 最后用 steer 把新需求注入同一个持久子会话。这样 subagent/end 到达时不会把旧任务误判为 failed。
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
        responseMode: args.responseMode,
        ...args.acceptanceCriteria ? { acceptanceCriteria: args.acceptanceCriteria } : {},
      })
      conv = interruptedTaskId
        ? reviseConversation(existing, task.id, at)
        : activateConversation(existing, task.id, at)
      if (interruptedTaskId) {
        const active = this.taskById(interruptedTaskId)
        if (active) {
          const interruptedTask = interruptTaskForRevision(active, `被新需求「${args.subject}」接管`, at)
          await this.tasks().put(interruptedTaskId, interruptedTask)
          this.waiters.get(interruptedTaskId)?.resolve(interruptedTask)
          this.waiters.delete(interruptedTaskId)
          // interrupt 会异步带来一次 subagent/end；那是改单的预期结果，不是任务失败。
          this.armRevisionEndGuard(existing.childSessionId, interruptedTaskId)
        }
      }
      await this.putPair(conv, task)

      if (interruptedTaskId) {
        // interrupt 本身失败不应拖垮新任务：steer 也会抢占当前轮次，queue 则等旧轮次自然结束后注入。
        try {
          this.hostCtx.subagents.interrupt(existing.childSessionId as SessionId, { kind: 'ancestor', agent: parent })
        } catch (interruptError) {
          this.hostCtx.logger.warn(`orchestrator: interrupt before revise failed, continue with steer/queue: ${String(interruptError)}`)
        }
      }
      try {
        const text = interruptedTaskId ? revisionPrompt(task) : workerPrompt(task)
        const blocks = [{ type: 'text' as const, text }]
        const source = {
          kind: 'orchestrator' as const,
          form: 'notice' as const,
          summary: `orchestrator ${interruptedTaskId ? 'revise' : 'task'} ${task.subject}`.slice(0, 120),
        }
        if (interruptedTaskId) {
          // 改单时 steer 抢占当前轮次；若运行时不接受则退化为排队，等旧轮次结束后注入。
          try {
            await steerHostSubagentPrompt(
              this.hostCtx.subagents, parent, conv.childSessionId as SessionId, blocks, source,
              AbortSignal.timeout(LAUNCH_ACCEPT_TIMEOUT_MS),
            )
          } catch (steerError) {
            this.hostCtx.logger.warn(`orchestrator: steer failed, fallback to queue: ${String(steerError)}`)
            await queueHostSubagentPrompt(
              this.hostCtx.subagents, parent, conv.childSessionId as SessionId, blocks, source,
              AbortSignal.timeout(LAUNCH_ACCEPT_TIMEOUT_MS),
            )
          }
        } else {
          await queueHostSubagentPrompt(
            this.hostCtx.subagents, parent, conv.childSessionId as SessionId, blocks, source,
            AbortSignal.timeout(LAUNCH_ACCEPT_TIMEOUT_MS),
          )
        }
      } catch (error) {
        return { ok: false, result: await this.failLaunch(conv, task, error) }
      }
    } else {
      const conversationId = createId('conv')
      const taskId = createId('task')
      const childSessionId = randomUUID()
      const provisional = createConversation({ id: conversationId, childSessionId, parentSessionId, title: args.subject })
      conv = { ...provisional, activeTaskId: taskId, lastTaskId: taskId }
      task = createTask({
        id: taskId,
        parentSessionId,
        conversationId,
        predecessorTaskId: null,
        subject: args.subject,
        prompt: args.prompt,
        responseMode: args.responseMode,
        ...args.acceptanceCriteria ? { acceptanceCriteria: args.acceptanceCriteria } : {},
      })
      await this.putPair(conv, task)
      try {
        await this.hostCtx.subagents.startContinuable({
          provider: 'spawn',
          label: args.subject,
          childId: childSessionId as SessionId,
          request: {
            prompt: [{ type: 'text', text: workerPrompt(task) }],
            parent,
            persona: WORKER_PROMPT,
            // 创建窗口先继承 Lead preset；文件等工具要等 Worker preset recompose 后才可枚举。
            maxDepth: 1,
          },
          signal: AbortSignal.timeout(LAUNCH_ACCEPT_TIMEOUT_MS),
        })
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

  private async failLaunch(conv: ConversationRecord, task: TaskRecord, error: unknown): Promise<unknown> {
    const now = timestamp()
    const failedTask = failTask(task, String(error), now)
    const failedConv = failConversation(settleConversation(conv, failedTask, now), now)
    await this.putPair(failedConv, failedTask)
    this.waiters.get(failedTask.id)?.resolve(failedTask)
    this.waiters.delete(failedTask.id)
    if (failedTask.responseMode === 'background') void this.deliverPendingTask(failedTask.id)
    return { kind: 'error', error: String(error) }
  }

  private waitTask(taskId: string, timeoutMs: number): Promise<unknown> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(taskId)
        void this.serialize(async () => {
          const task = this.taskById(taskId)
          if (!task || !(activeTaskStatuses as readonly string[]).includes(task.status)) return
          await this.tasks().put(taskId, {
            ...task,
            revision: task.revision + 1,
            updatedAt: timestamp(),
            responseMode: 'background',
          })
          this.emitChanged()
        }).catch(error => {
          this.hostCtx.logger.warn(`orchestrator: wait timeout fallback for ${taskId} failed: ${String(error)}`)
        })
        resolve({ ok: true, status: 'background', conversationId: this.taskById(taskId)?.conversationId, reason: 'timeout' })
      }, timeoutMs)
      timer.unref()
      this.waiters.set(taskId, {
        resolve: task => {
          clearTimeout(timer)
          resolve({
            ok: true,
            status: task.status,
            conversationId: task.conversationId,
            answer: task.userAnswer,
            question: task.question,
            error: task.error,
            progressNote: task.progressNote,
          })
        },
      })
    })
  }

  private async updateFromWorker(rawArgs: unknown, childSessionId: string): Promise<any> {
    const parsed = taskUpdateInputSchema.safeParse(rawArgs)
    if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'invalid task_update arguments')
    const args: TaskUpdateInput = parsed.data
    let shouldDeliver = false
    let terminalTaskId: string | undefined
    const result = await this.serialize(async () => {
      const conv = this.conversationByChild(childSessionId)
      if (!conv || !conv.activeTaskId) {
        throw new Error('task_update is only available in a managed worker with an active task')
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
        this.waiters.get(task.id)?.resolve(task)
        this.waiters.delete(task.id)
        terminalTaskId = task.id
        shouldDeliver = task.responseMode === 'background' && task.delivery?.state === 'pending'
      }
      return { ok: true as const, status: task.status }
    })
    if (shouldDeliver && terminalTaskId) void this.deliverPendingTask(terminalTaskId)
    return result
  }

  private async onSubagentEnd(childSessionId: string): Promise<void> {
    let shouldDeliver = false
    let taskId: string | undefined
    let outcome: 'ignored' | 'manual_stop' | 'revision' | 'failed' | undefined
    await this.serialize(async () => {
      const conv = this.conversationByChild(childSessionId)
      if (!conv?.activeTaskId) return
      if (this.consumeRevisionEnd(childSessionId, conv.activeTaskId)) {
        // 改单注入产生的预期内旧轮次结束；同一事件原因令牌也作废，避免波及新任务。
        this.workerTurnEnds.delete(childSessionId)
        this.revisionTurnEnds.delete(childSessionId)
        outcome = 'ignored'
        return
      }
      const previous = this.taskById(conv.activeTaskId)
      if (!previous || !(activeTaskStatuses as readonly string[]).includes(previous.status)) return
      const now = timestamp()
      const endCause = this.consumeWorkerTurnEnd(childSessionId)
      let task: TaskRecord
      let nextConv: ConversationRecord
      if (endCause === 'manual_stop') {
        task = interruptTaskForRevision(previous, '子会话执行被手动停止；工作流已保留，可继续派发新需求', now)
        // 手动停止需要通知主会话；background 模式挂起投递，wait 模式直接解除等待。
        if (task.responseMode === 'background') task = { ...task, delivery: { state: 'pending', attempts: 0 } }
        nextConv = settleConversation(conv, task, now)
        shouldDeliver = task.responseMode === 'background'
        outcome = 'manual_stop'
      } else if (endCause === 'revision') {
        task = interruptTaskForRevision(previous, '旧轮次被新需求中断', now)
        nextConv = settleConversation(conv, task, now)
        outcome = 'revision'
      } else {
        task = failTask(previous, previous.status === 'queued' ? '子会话在任务开始前结束' : '子会话结束前未提交终态 task_update', now)
        nextConv = failConversation(settleConversation(conv, task, now), now)
        shouldDeliver = task.responseMode === 'background'
        outcome = 'failed'
      }
      await this.putPair(nextConv, task)
      this.waiters.get(task.id)?.resolve(task)
      this.waiters.delete(task.id)
      taskId = task.id
    })
    if (outcome === 'ignored') {
      this.hostCtx.logger.info?.(`orchestrator: ignore expected subagent/end after revision: ${childSessionId}`)
      return
    }
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
    if (!task || task.responseMode !== 'background' || task.delivery?.state !== 'pending') return
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
        .filter(task => task.responseMode === 'background'
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
            const nextConv = settleConversation(conv, nextTask, now)
            await this.putPair(nextConv, nextTask)
          } else {
            // I/O timeout/permission errors are uncertain: do not mark a possibly live session failed.
            const nextTask = interruptTaskAfterRestart(active, now)
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
