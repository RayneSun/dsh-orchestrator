import React, { useState } from 'react'
import type { ConversationRecord, ProgressStep, TaskRecord, TaskSnapshot } from '../types.ts'
import { modelDisplayName } from '../model-info.ts'

/** Material do_not_disturb_on：静默标识（与 DSH 应用内图标同源，内联避免依赖应用内部 alias）。 */
function SilentIcon(): React.ReactElement {
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm5 11H7v-2h10v2z" /></svg>
}

/** Material schedule：定时标识。 */
function ScheduleIcon(): React.ReactElement {
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M11.99 2C6.47 2 2 6.48 2 12s4.47 10 9.99 10C17.52 22 22 17.52 22 12S17.52 2 11.99 2zM12 20c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm.5-13H11v6l5.25 3.15.75-1.23-4.5-2.67z" /></svg>
}

function FileIcon(): React.ReactElement {
  return <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M14 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V8l-6-6zM6 20V4h7v5h5v11H6z" /></svg>
}

export function TagChip(props: { kind: 'silent' | 'scheduled' | 'card'; title: string }): React.ReactElement {
  return <span className={`dsho-tag dsho-tag-${props.kind}`} title={props.title} aria-label={props.title}>
    {props.kind === 'silent' ? <SilentIcon /> : props.kind === 'scheduled' ? <ScheduleIcon /> : <CardIcon />}
  </span>
}

function CardIcon(): React.ReactElement {
  return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3"><rect x="2.5" y="3.5" width="11" height="9" rx="2"/><path d="M5 6.5h6M5 9h4"/></svg>
}

/** 看板内的时间统一用短格式：10-29 09:31，避免整串年份挤占窄栏。 */
export function shortTime(value?: string): string {
  const t = Date.parse(value ?? '')
  if (Number.isNaN(t)) return value ?? '—'
  const d = new Date(t)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function durationText(task: TaskRecord, nowMs: number): string {
  const start = Date.parse(task.startedAt ?? task.createdAt)
  if (Number.isNaN(start)) return ''
  const end = task.endedAt ? Date.parse(task.endedAt) : nowMs
  if (Number.isNaN(end) || end < start) return ''
  const seconds = Math.floor((end - start) / 1000)
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  if (minutes > 0) return `耗时 ${minutes}m${String(rest).padStart(2, '0')}s`
  return `耗时 ${rest}s`
}

/** 模型来源脚注：路由发生时悬浮可分别查看传入与返回模型。 */
export function ModelCredit({ task }: { task: TaskRecord }): React.ReactElement | null {
  const model = modelDisplayName(task)
  if (!model) return null
  return <span
    className="dsho-modelCredit"
    title={`传入模型：${task.requestedModel}\n返回模型：${task.responseModel || '未返回'}`}
  >
    <span className="dsho-modelSpark" aria-hidden>✦</span>
    本次结果由<span className="dsho-modelName">“{model}”</span>提供
  </span>
}

function TaskFoot({ task, duration, live = false }: { task: TaskRecord, duration: string, live?: boolean }): React.ReactElement {
  return <div className="dsho-taskFoot">
    <span>创建 {shortTime(task.createdAt)}</span>
    {duration && <span className={`dsho-dur${live ? ' dsho-dur-live' : ''}`}>{duration}</span>}
    <ModelCredit task={task} />
  </div>
}

export const taskStatusLabels: Record<string, string> = {
  queued: '排队中', running: '进行中', input_required: '待你操作', completed: '已完成',
  failed: '失败', interrupted: '已中断',
}

const blockReasonLabels: Record<string, string> = {
  permission_denied: '权限', configuration: '配置', dependency: '依赖',
  network: '网络', resource: '资源', runtime: '运行时',
}

function firstLine(text: string | undefined): string {
  return (text ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? ''
}

/** 折叠态时间行 / 兜底标题文本。 */
function taskHeadline(task: TaskRecord): string {
  switch (task.status) {
    case 'running':
      return task.progressNote ?? ''
    case 'input_required':
      return firstLine(task.questions?.[0]?.question) || '等待用户操作'
    case 'completed':
      return firstLine(task.result) || '已完成'
    case 'failed':
      return firstLine(task.error) || '执行失败'
    case 'interrupted':
      return task.cancelledReason || '已中断'
    case 'queued':
      return '排队等待执行'
    default:
      return ''
  }
}

function StepList({ steps }: { steps: ProgressStep[] }): React.ReactElement | null {
  if (steps.length === 0) return null
  return <ul className="dsho-steps">
    {steps.map((step, index) => <li key={`${index}-${step.content}`} className={`dsho-step-${step.status}`}>
      <span className="dsho-stepIcon">
        {step.status === 'completed' ? '✓' : step.status === 'in_progress' ? '●' : ''}
      </span>
      <span>{step.content}</span>
    </li>)}
  </ul>
}

/** dsh-ui card JSON 折叠预览：默认收起，点击展开看原始 JSON。 */
function CardPreview({ card }: { card: Record<string, unknown> }): React.ReactElement {
  const [open, setOpen] = useState(false)
  return <div className="dsho-detailSec">
    <button type="button" className="dsho-expander" onClick={() => setOpen(v => !v)}>
      {open ? '收起卡片 JSON' : '查看卡片 JSON'}
    </button>
    {open && <pre className="dsho-cardJson">{JSON.stringify(card, null, 2)}</pre>}
  </div>
}

/** 任务行头：状态 badge + 静默/定时/卡片标识 + 主题。 */
function TaskHead({ task }: { task: TaskSnapshot }): React.ReactElement {
  return <div className="dsho-taskHead">
    <span className={`dsho-badge dsho-badge-${task.status}`}>{taskStatusLabels[task.status] ?? task.status}</span>
    {task.silent && <TagChip kind="silent" title="静默：终态不通知主会话" />}
    {task.hasActiveSchedule && <TagChip kind="scheduled" title="关联了活动定时任务：到点自动触发并覆盖本任务结果" />}
    {task.card && <TagChip kind="card" title="含 dsh-ui 展示卡片" />}
    <span className="dsho-taskSubject" title={task.subject}>{task.subject}</span>
  </div>
}

interface TaskLineProps {
  task: TaskSnapshot
  conv: ConversationRecord
  nowMs: number
  onOpenArtifact: (conv: ConversationRecord, artifact: string) => void
}

function TaskLine({ task, conv, nowMs, onOpenArtifact }: TaskLineProps): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const result = task.result
  const artifacts = task.artifacts ?? []
  const live = task.status === 'running' && !task.endedAt
  const duration = durationText(task, nowMs)

  // 展开区内容按状态聚合：完整结果/失败原因、用户已回答、验收、制品、投递状态。
  const detailSections: React.ReactElement[] = []
  if (result) detailSections.push(<div key="res" className="dsho-detailSec"><b>结果</b>：{result}</div>)
  if (task.answers?.length) detailSections.push(<div key="ans" className="dsho-detailSec"><b>已回答</b>：{task.answers.map(answer => {
    const parts = [answer.selected.length > 0 ? answer.selected.join('、') : '', answer.custom ?? ''].filter(Boolean)
    return `[${answer.id}] ${parts.join('；') || '（未作答）'}`
  }).join('；')}</div>)
  if (task.status === 'failed' && task.error) {
    detailSections.push(<div key="err" className="dsho-detailSec">
      <b>失败原因</b>：{task.error}
      {task.reasonCode && <>（<b>{blockReasonLabels[task.reasonCode] ?? task.reasonCode}</b> 阻碍，处理后可继续）</>}
    </div>)
  }
  if (task.acceptanceCriteria) detailSections.push(<div key="ac" className="dsho-detailSec"><b>验收标准</b>：{task.acceptanceCriteria}</div>)
  if (artifacts.length > 0) detailSections.push(<div key="arts" className="dsho-detailSec">
    <b>制品</b>（点击打开）：
    <div className="dsho-arts">{artifacts.map(artifact => <button
      key={artifact}
      type="button"
      className="dsho-art"
      title={`${conv.workspaceName ? `${conv.workspaceName}/` : ''}${artifact}`}
      onClick={() => onOpenArtifact(conv, artifact)}
    ><FileIcon />{artifact}</button>)}</div>
  </div>)
  if (task.card) detailSections.push(<CardPreview key="card" card={task.card} />)
  if (task.delivery?.state === 'pending') detailSections.push(<div key="dp" className="dsho-detailSec dsho-subtle">
    {task.delivery.attempts === 0 ? '正在把结果同步回主会话…' : `同步未成功（已重试 ${task.delivery.attempts} 次，将自动继续）${task.delivery.lastError ? ` · ${task.delivery.lastError}` : ''}`}
  </div>)
  if (task.delivery?.state === 'delivered') detailSections.push(<div key="dd" className="dsho-detailSec dsho-subtle">已同步回主会话 · {shortTime(task.delivery.deliveredAt)}</div>)

  const expanderLabel = task.status === 'failed' ? '查看错误' : '查看结果'
  if (task.status === 'interrupted') {
    return <li className="dsho-task dsho-taskMuted">
      <TaskHead task={task} />
      {task.cancelledReason && <p className="dsho-subtle">{task.cancelledReason}</p>}
      <TaskFoot task={task} duration={duration} />
    </li>
  }

  return <li className="dsho-task">
    <TaskHead task={task} />
    <StepList steps={task.progressSteps ?? []} />
    {(task.header || task.progressNote || detailSections.length > 0) && <div className={`dsho-note${live ? ' dsho-note-live' : ''}`}>
      {task.header && <><span className="dsho-noteTitle">{task.header}</span><span className="dsho-noteSep">:</span></>}
      <span className="dsho-noteText">{task.progressNote || (live ? '正在推进…' : taskHeadline(task))}</span>
      {detailSections.length > 0 && <button type="button" className="dsho-expander" onClick={() => setExpanded(v => !v)}>{expanded ? '收起' : expanderLabel}</button>}
    </div>}
    {expanded && detailSections.length > 0 && <div className={`dsho-detail${task.status === 'failed' ? ' dsho-detail-err' : ''}`}>{detailSections}</div>}
    <TaskFoot task={task} duration={duration} live={live} />
  </li>
}

/** 任务框：圈住多轮任务，默认折叠只显示最新一轮（新→旧）。 */
export function TaskBox({ conv, tasks, nowMs, onOpenArtifact }: {
  conv: ConversationRecord
  tasks: TaskSnapshot[]
  nowMs: number
  onOpenArtifact: (conv: ConversationRecord, artifact: string) => void
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false)
  const rounds = [...tasks].reverse()
  return <div className={`dsho-taskBox${expanded ? '' : ' dsho-taskBox-collapsed'}`}>
    <div className="dsho-taskBoxHead" onClick={() => setExpanded(v => !v)}>
      <span className="dsho-chevron" aria-hidden />
      任务
      <span className="dsho-taskBoxCnt">{rounds.length} 轮 · {expanded ? '全部展开' : '显示最新'}</span>
    </div>
    <ul className="dsho-tasks">
      {rounds.map(task => <TaskLine key={task.id} task={task} conv={conv} nowMs={nowMs} onOpenArtifact={onOpenArtifact} />)}
    </ul>
  </div>
}
