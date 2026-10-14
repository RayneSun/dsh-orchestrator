import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import { createUserMessage, type ContextFormed } from '@deepseek-ai/dsh-llm'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { deliveryNotice, workerPrompt } from './messages.ts'
import { toJson } from './json.ts'
import { routeQuery } from './router.ts'
import { isForbidden, sceneDefinitions } from './scenes.ts'
import { orchestratorDomain } from './storage.ts'
import { buildPresetDefinitions, LEAD_PRESET, LEAD_TOOL_DENY, WORKER_PRESET } from './presets.ts'
import {
  activateConversation,
  applyOutlinePatch,
  failConversation,
  failTask,
  interruptTaskAfterRestart,
  settleConversation,
  startConversation,
  StateError,
  transitionTask,
} from './state-machine.ts'
import {
  createConversation,
  createId,
  createTask,
  scenes,
  timestamp,
  type ConversationRecord,
  type OutlinePatch,
  type Scene,
  type Snapshot,
  type TaskRecord,
  dispatchInputSchema,
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

function jsonOutput() {
  return {
    schema: { type: 'json' as const },
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value) }],
  }
}

export class OrchestratorService extends TypertRemoteService {
  static inject = [
    'agents', 'sessions', 'subagents', 'storageDomain',
    'sessionController', 'sessionPersistence', 'agentPresets',
  ]

  private ready: Promise<void>
  private domain: DomainType | undefined
  private chain: Promise<unknown> = Promise.resolve()
  private stopping = false
  private readonly waiters = new Map<string, Waiter>()
  private readonly installed = new Map<string, Array<() => unknown>>()
  private readonly delivering = new Set<string>()
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

    await this.registerPresets()
    this.hostCtx.effect(() => {
      const offEnd = this.hostCtx.on('subagent/end', (info) => { void this.onSubagentEnd(String(info.id)) })
      const offPreset = this.hostCtx.on('agent-preset/selected', (sessionId, preset) => {
        if (preset !== LEAD_PRESET) return
        const agent = this.hostCtx.agents.get(sessionId as SessionId)
        if (agent) this.configureLead(agent)
      })
      const offCreated = this.hostCtx.on('agent/created', async ({ agent }) => { await this.configureAgent(agent) })
      this.recoveryTimer = setInterval(() => { void this.recoverDeliveries() }, 15_000)
      this.recoveryTimer.unref()
      return async () => {
        this.stopping = true
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
    await this.conversations().put(conv.id, conv)
    if (task) await this.tasks().put(task.id, task)
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
      this.configureLead(agent)
    }
  }

  private resetInstalled(key: string): void {
    const disposers = this.installed.get(key) ?? []
    this.installed.delete(key)
    for (const dispose of disposers) {
      try { void dispose() } catch { /* agent scope owns teardown failures */ }
    }
  }

  private keep(agent: Agent, disposer: () => unknown): void {
    const key = String(agent.session.id)
    const list = this.installed.get(key) ?? []
    list.push(disposer)
    this.installed.set(key, list)
  }

  private configureLead(agent: Agent): void {
    this.resetInstalled(String(agent.session.id))
    const scoped = agent.ctx
    this.installSettlementFilter(agent)
    this.keep(agent, scoped.systemPrompt.section({
      name: 'orchestrator:roster',
      order: 610,
      text: () => this.renderRoster(String(agent.session.id)),
    }))
    this.keep(agent, scoped.tools.restrict({ deny: [...LEAD_TOOL_DENY] }))
    this.keep(agent, scoped.on('agent/pre-step', async ({ messages }, next) => {
      const managedSettled = (message: { source?: unknown }): boolean => {
        const source = message.source as { kind?: string; senderSessionId?: string } | undefined
        return source?.kind === 'subagent-settled'
          && typeof source.senderSessionId === 'string'
          && this.conversationByChild(source.senderSessionId)?.parentSessionId === String(agent.session.id)
      }
      if (!messages.some(managedSettled)) return next()
      const visible = messages.filter(message => !managedSettled(message))
      if (visible.length === 0) return { kind: 'reject' as const }
      return { kind: 'enter' as const, messages: visible }
    }))
    for (const tool of this.leadTools(agent)) this.keep(agent, scoped.tools.register(tool as any))
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
    this.resetInstalled(String(agent.session.id))
    const wanted = WORKER_PRESET[conv.scene]
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
    const toolFilter = sceneDefinitions[conv.scene].toolFilter
    if (toolFilter.allow) {
      this.keep(agent, scoped.tools.restrict({ allow: toolFilter.allow }))
    }
    this.keep(agent, scoped.systemPrompt.section({
      name: 'orchestrator:worker-policy',
      order: 610,
      text: `${sceneDefinitions[conv.scene].persona}\n必须按任务协议调用 task_update；终态 completed/failed/blocked 必须在本轮结束前提交。`,
    }))
    this.keep(agent, scoped.tools.guard(exec => isForbidden(conv.scene, exec.name)))
    this.keep(agent, scoped.tools.register(defineTool({
      name: 'task_update',
      description: '向 Orchestrator Host 上报当前子会话活动 TaskRun 的状态。不接受 task id，Host 根据会话身份反查。',
      parameters: {
        status: { type: 'string', required: true, enum: ['running', 'blocked', 'completed', 'failed'] },
        progressNote: { type: 'string', description: '进展或阻塞说明' },
        userAnswer: { type: 'string', description: 'completed 时必填：给 Lead 转述给用户的权威答案' },
        resultSummary: { type: 'string', description: '一句话结果摘要' },
        error: { type: 'string', description: 'failed/blocked 的错误或原因' },
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
      output: jsonOutput(),
      execute: async (args: any) => toJson(await this.updateFromWorker(args, String(agent.session.id))),
    })))
  }

  private renderRoster(parentSessionId: string): string {
    const { conversations, tasks } = this.snapshotFor(parentSessionId)
    if (conversations.length === 0) return 'Orchestrator roster: empty.'
    const lines = conversations.map((conv) => {
      const active = conv.activeTaskId ? this.taskById(conv.activeTaskId) : undefined
      const last = conv.lastTaskId ? this.taskById(conv.lastTaskId) : undefined
      return [
        `- ${conv.id} child=${conv.childSessionId} scene=${conv.scene} state=${conv.state} title=${conv.title}`,
        `  tags=${conv.outline.tags.join(',') || '-'} entities=${conv.outline.entities.join(',') || '-'} facts=${conv.outline.keyFacts.slice(-3).join(' / ') || '-'}`,
        `  active=${active ? `${active.id}:${active.status}:${active.subject}` : '-'} lastResult=${last?.resultSummary ?? last?.userAnswer ?? '-'}`,
      ].join('\n')
    })
    return `Orchestrator roster（仅摘要；完整卡用 orchestrator_get）:\n${lines.join('\n')}\nTasks: ${tasks.length}`
  }

  private leadTools(agent: Agent) {
    const output = jsonOutput()
    return [
      defineTool({
        name: 'orchestrator_route',
        description: '根据新用户请求和轻量路由卡匹配可复用持久 Conversation。强相关追问应复用原会话。',
        parameters: { query: { type: 'string', required: true, description: '用户的新需求' } },
        output: jsonOutput(),
        execute: async ({ query }: { query: string }) => {
          const conversations = this.snapshotFor(String(agent.session.id)).conversations
            .filter(conv => ['idle', 'blocked'].includes(conv.state))
          return toJson({ candidates: routeQuery(query, conversations, 6) })
        },
      }),
      defineTool({
        name: 'orchestrator_dispatch',
        description: '新建 Conversation，或向已有持久子会话排队一个新的 TaskRun。',
        parameters: {
          subject: { type: 'string', required: true, description: '短主题' },
          prompt: { type: 'string', required: true, description: '完整自包含任务说明' },
          scene: { type: 'string', required: true, enum: [...scenes] },
          conversationId: { type: 'string', description: '复用已有 Conversation 时提供' },
          responseMode: { type: 'string', required: true, enum: ['wait', 'background'] },
          acceptanceCriteria: { type: 'string', description: '可选验收标准' },
          waitTimeoutMs: { type: 'integer', description: 'wait 超时，默认 60000；超时自动转后台' },
        },
        output: jsonOutput(),
        execute: async (args: any) => toJson(await this.dispatch(args, agent)),
      }),
      defineTool({
        name: 'orchestrator_list',
        description: '列出当前主会话下全部工作流和 TaskRun 状态。',
        parameters: {},
        output: jsonOutput(),
        execute: async () => toJson(this.snapshotFor(String(agent.session.id))),
      }),
      defineTool({
        name: 'orchestrator_get',
        description: '读取一个 Conversation 的完整轻量路由卡和任务列表，不读取子会话 transcript。',
        parameters: { conversationId: { type: 'string', required: true } },
        output: jsonOutput(),
        execute: async ({ conversationId }: { conversationId: string }) => {
          const conv = this.conversationById(conversationId)
          if (!conv || conv.parentSessionId !== String(agent.session.id)) {
            return toJson({ error: 'conversation not found' })
          }
          const tasks = [...this.tasks().entries()].map(([, task]) => task).filter(task => task.conversationId === conv.id)
          return toJson({ conversation: conv, tasks })
        },
      }),
    ]
  }

  private async dispatch(rawArgs: unknown, parent: Agent): Promise<any> {
    const parsed = dispatchInputSchema.safeParse(rawArgs)
    if (!parsed.success) return { kind: 'error', error: parsed.error.issues[0]?.message ?? 'invalid orchestrator_dispatch arguments' }
    const args: DispatchInput = parsed.data
    const parentSessionId = String(parent.session.id)
    const scene: Scene = args.scene
    const responseMode = args.responseMode
    const timeout = args.waitTimeoutMs ?? 60_000

    // waitTask 必须在串行写锁外等待，否则 Worker 的 task_update 无法进入状态机。
    const provisioned = await this.serialize(() => this.provisionDispatch(args, parent, parentSessionId, scene))
    if (provisioned.ok === false) return provisioned.result
    const { conv, task } = provisioned
    if (responseMode === 'background') {
      return { kind: 'background', taskId: task.id, conversationId: conv.id, childSessionId: conv.childSessionId }
    }
    return await this.waitTask(task.id, timeout, args.subject)
  }

  private async provisionDispatch(
    args: DispatchInput,
    parent: Agent,
    parentSessionId: string,
    scene: Scene,
  ): Promise<DispatchProvision> {
    let conv: ConversationRecord
    let task: TaskRecord
    const at = timestamp()

    if (args.conversationId) {
      const existing = this.conversationById(args.conversationId)
      if (!existing || existing.parentSessionId !== parentSessionId) return { ok: false, result: { kind: 'error', error: 'conversation not found' } }
      if (existing.scene !== scene) return { ok: false, result: { kind: 'error', error: `scene mismatch: conversation is ${existing.scene}, request is ${scene}` } }
      if (existing.activeTaskId) return { ok: false, result: { kind: 'error', error: `conversation busy: ${existing.activeTaskId}` } }
      task = createTask({
        id: createId('task'),
        parentSessionId,
        conversationId: existing.id,
        predecessorTaskId: existing.lastTaskId,
        subject: args.subject,
        prompt: args.prompt,
        scene,
        responseMode: args.responseMode,
        ...args.acceptanceCriteria ? { acceptanceCriteria: args.acceptanceCriteria } : {},
      })
      conv = activateConversation(existing, task.id, at)
      await this.putPair(conv, task)
      try {
        await queueHostSubagentPrompt(
          this.hostCtx.subagents,
          parent,
          conv.childSessionId as SessionId,
          [{ type: 'text', text: workerPrompt(scene, task) }],
          { kind: 'orchestrator', form: 'notice', summary: `orchestrator task ${task.id}` },
          AbortSignal.timeout(120_000),
        )
      } catch (error) {
        return { ok: false, result: await this.failLaunch(conv, task, error) }
      }
    } else {
      const conversationId = createId('conv')
      const taskId = createId('task')
      const childSessionId = randomUUID()
      const provisional = createConversation({ id: conversationId, childSessionId, parentSessionId, scene, title: args.subject })
      conv = { ...provisional, activeTaskId: taskId, lastTaskId: taskId }
      task = createTask({
        id: taskId,
        parentSessionId,
        conversationId,
        predecessorTaskId: null,
        subject: args.subject,
        prompt: args.prompt,
        scene,
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
            prompt: [{ type: 'text', text: workerPrompt(scene, task) }],
            parent,
            persona: sceneDefinitions[scene].persona,
            // 创建窗口先继承 Lead preset；文件等工具要等 Worker preset recompose 后才可枚举。
            maxDepth: 1,
          },
          signal: AbortSignal.timeout(120_000),
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
    return { kind: 'error', error: String(error), taskId: failedTask.id, conversationId: failedConv.id }
  }

  private waitTask(taskId: string, timeoutMs: number, subject: string): Promise<unknown> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(taskId)
        void this.serialize(async () => {
          const task = this.taskById(taskId)
          if (!task || !['queued', 'running'].includes(task.status)) return
          const next: TaskRecord = {
            ...task,
            revision: task.revision + 1,
            updatedAt: timestamp(),
            responseMode: 'background',
            delivery: { state: 'pending', attempts: 0 },
          }
          await this.tasks().put(taskId, next)
          this.emitChanged()
        })
        resolve({
          kind: 'background',
          taskId,
          conversationId: this.taskById(taskId)?.conversationId,
          reason: 'timeout',
          subject,
        })
      }, timeoutMs)
      timer.unref()
      this.waiters.set(taskId, {
        resolve: task => {
          clearTimeout(timer)
          resolve({
            kind: task.status,
            taskId,
            conversationId: task.conversationId,
            answer: task.userAnswer,
            error: task.error,
            progressNote: task.progressNote,
            task,
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
    const result = await this.serialize(async () => {
      const conv = this.conversationByChild(childSessionId)
      if (!conv || !conv.activeTaskId) {
        throw new Error('task_update is only available in a managed worker with an active task')
      }
      const previous = this.taskById(conv.activeTaskId)
      if (!previous) throw new Error('active task record is missing')

      let task = transitionTask(previous, args)
      let nextConv = args.outlinePatch
        ? applyOutlinePatch(conv, args.outlinePatch as OutlinePatch)
        : conv
      if (['completed', 'blocked', 'failed'].includes(task.status)) {
        nextConv = settleConversation(nextConv, task)
        if (task.responseMode === 'background' && !task.delivery) {
          task = { ...task, delivery: { state: 'pending', attempts: 0 } }
        }
      }
      await this.putPair(nextConv, task)
      const terminal = ['completed', 'blocked', 'failed'].includes(task.status)
      if (terminal) {
        this.waiters.get(task.id)?.resolve(task)
        this.waiters.delete(task.id)
      }
      shouldDeliver = terminal && task.responseMode === 'background' && task.delivery?.state === 'pending'
      return { ok: true as const, taskId: task.id, status: task.status, conversationState: nextConv.state }
    })
    if (shouldDeliver) void this.deliverPendingTask(result.taskId)
    return result
  }

  private async onSubagentEnd(childSessionId: string): Promise<void> {
    let shouldDeliver = false
    let taskId: string | undefined
    await this.serialize(async () => {
      const conv = this.conversationByChild(childSessionId)
      if (!conv?.activeTaskId) return
      const previous = this.taskById(conv.activeTaskId)
      if (!previous || !['queued', 'running'].includes(previous.status)) return
      const now = timestamp()
      const task = failTask(previous, previous.status === 'queued' ? '子会话在任务开始前结束' : '子会话结束前未提交终态 task_update', now)
      const nextConv = failConversation(settleConversation(conv, task, now), now)
      await this.putPair(nextConv, task)
      this.waiters.get(task.id)?.resolve(task)
      this.waiters.delete(task.id)
      shouldDeliver = task.responseMode === 'background'
      taskId = task.id
    })
    if (shouldDeliver && taskId) await this.deliverPendingTask(taskId)
  }

  private async deliverPendingTask(taskId: string): Promise<void> {
    if (this.delivering.has(taskId)) return
    const task = this.taskById(taskId)
    if (!task || task.responseMode !== 'background' || task.delivery?.state !== 'pending') return
    if (!['completed', 'blocked', 'failed'].includes(task.status)) return
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
      this.hostCtx.logger.warn(`orchestrator: deliver ${taskId} failed: ${String(error)}`)
    } finally {
      this.delivering.delete(taskId)
    }
  }

  private async recoverDeliveries(): Promise<void> {
    await this.ready
    const pending = [...this.tasks().entries()]
      .map(([, task]) => task)
      .filter(task => task.responseMode === 'background'
        && task.delivery?.state === 'pending'
        && ['completed', 'blocked', 'failed'].includes(task.status))
    for (const task of pending) await this.deliverPendingTask(task.id)
  }

  /** Recover provisioning records and tasks left live by a process restart. */
  private async recoverRuntimeState(): Promise<void> {
    await this.serialize(async () => {
      const now = timestamp()
      for (const [, conv] of this.conversations().entries()) {
        const active = conv.activeTaskId ? this.taskById(conv.activeTaskId) : undefined
        if (!active) continue

        if (conv.state === 'provisioning') {
          const stat = await this.hostCtx.sessionPersistence
            .stat(conv.childSessionId as SessionId, { signal: AbortSignal.timeout(5000) })
            .catch(() => undefined)
          if (stat && ['queued', 'running'].includes(active.status)) {
            const nextConv = startConversation(conv, now)
            const nextTask = {
              ...active,
              revision: active.revision + 1,
              updatedAt: now,
              status: 'running' as const,
              startedAt: active.startedAt ?? now,
            }
            await this.putPair(nextConv, nextTask)
          } else {
            const reason = 'child session was not materialized before restart'
            const nextTask = stat ? interruptTaskAfterRestart(active, now) : failTask(active, reason, now)
            const nextConv = settleConversation(conv, nextTask, now)
            await this.putPair(nextConv, nextTask)
          }
          continue
        }

        if (['queued', 'running'].includes(active.status)) {
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
