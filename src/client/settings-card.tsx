import React from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import * as clientStore from '@deepseek-ai/dsh-client-store'

/**
 * Worker 默认模型与终态投递开关（插件管理 → @cmjt/dsh-orchestrator → 行"配置"）。
 * 结构沿用 dsh-ciri 的设置卡片模式：SettingsFormModel 暂存编辑，Switch 直写布尔。
 * runtime external：primitives/store 由前端 ModuleLoader 提供（dsh.client.external）。
 */

/** Host 设置命名空间（cordis.patch.yml 的 loader 行 id）。 */
const HOST_NAMESPACE = 'may-dsh-orchestrator'
/** plugins.row.config 槽 key：<包名>#<行 id>。 */
const SLOT_KEY = '@cmjt/dsh-orchestrator#may-dsh-orchestrator'

const SUMMARY = '设置新 Worker 的默认模型，以及子会话终态消息的投递开关。'
const MODEL_HINT = '默认模型只用于新建 Worker；留空则继承主会话。已有 Worker 保持原模型，失效时才按此顺序重选。'
const DELIVERY_HINT = '勾选子会话各终态（completed/failed/interrupted）是否投递消息给主会话。'
  + '无论是否投递，任务状态、进度与日程都会实时更新到任务看板；静默（silent）会话始终不投递。'
  + '改动即时生效；关闭期间产生的终态不补投。'

const STATUS_FIELDS = [
  { field: 'deliverOnCompleted', label: '已完成（completed）' },
  { field: 'deliverOnFailed', label: '失败（failed，含系统阻碍）' },
  { field: 'deliverOnInterrupted', label: '已中断（interrupted）', hint: '仅手动停止会投递；改单与重启中断本就不投递。' },
] as ReadonlyArray<{ field: string; label: string; hint?: string }>
const MODEL_FIELDS = ['workerProvider', 'workerModel', 'workerReasoningEffort'] as const

const FORM_LABELS = {
  unavailable: '该插件当前未加载，暂时无法配置。',
  readOnly: '本部署的设置为只读。',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  save: '保存',
  saving: '保存中…',
}

/** 布尔配置作为 "true"/"false" 文本 spec（Switch 渲染）；空文本视为清除覆盖、回到默认。 */
function boolField(field: string): unknown {
  return {
    field,
    format: (value: unknown) => (value === false ? 'false' : 'true'),
    parse: (text?: string) => {
      const trimmed = (text ?? '').trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed !== 'false' }
    },
  }
}

function textField(field: string): unknown {
  return {
    field,
    format: (value: unknown) => typeof value === 'string' ? value : '',
    parse: (text?: string) => {
      const trimmed = (text ?? '').trim()
      return trimmed === '' ? { kind: 'clear' } : { kind: 'set', value: trimmed }
    },
  }
}

/** 插件管理页插件命名空间上的暂存表单。 */
class SettingsCardController {
  private readonly section: any
  private readonly store: any
  private readonly unsubscribe: Array<() => void>

  constructor(scope: any, private readonly loadModelCatalog: () => Promise<any>) {
    this.section = new primitives.SettingsFormModel(scope, [
      ...STATUS_FIELDS.map(({ field }) => boolField(field)),
      ...MODEL_FIELDS.map(field => textField(field)),
    ])
    this.store = clientStore.createSnapshotStore(this.projection())
    const publish = () => this.publish()
    this.unsubscribe = [this.section.bind(() => this.section.shell()).subscribe(publish)]
  }

  private projection(): Record<string, unknown> {
    const shell = this.section.shell()
    const fields: Record<string, unknown> = {}
    for (const field of [...STATUS_FIELDS.map(item => item.field), ...MODEL_FIELDS]) fields[field] = this.section.field(field)
    return {
      available: shell.available,
      writable: shell.writable,
      dirty: shell.dirty,
      invalid: shell.invalid,
      saving: shell.saving,
      failed: shell.failed,
      ...fields,
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }

  private async save(): Promise<void> {
    const state = this.projection()
    if (!state.available || state.invalid || state.saving) return
    if (this.section.shell().dirty) await this.section.save()
  }

  dispose(): void {
    for (const off of this.unsubscribe) off()
    this.section.dispose()
  }

  inject(): Record<string, unknown> {
    return {
      hooks: { settingsCard: this.store },
      edit: (field: string, text: string) => {
        this.section.actions().edit(field, text)
      },
      save: () => {
        void this.save()
      },
      discard: () => {
        this.section.actions().discard()
      },
      loadModelCatalog: this.loadModelCatalog,
    }
  }

}

function ModelSelectionFields(props: any): React.ReactElement {
  const [catalog, setCatalog] = React.useState<any>()
  const [error, setError] = React.useState('')
  const [revision, setRevision] = React.useState(0)
  React.useEffect(() => {
    let active = true
    props.loadModelCatalog().then((value: any) => {
      if (active) { setCatalog(value); setError('') }
    }).catch((reason: unknown) => {
      if (active) setError(String(reason instanceof Error ? reason.message : reason))
    })
    return () => { active = false }
  }, [props.loadModelCatalog, revision])

  const provider = props.state.workerProvider?.text ?? ''
  const model = props.state.workerModel?.text ?? ''
  const effort = props.state.workerReasoningEffort?.text ?? ''
  const selectedValue = provider && model ? JSON.stringify([provider, model]) : ''
  const selectedGroup = catalog?.groups?.find((group: any) => group.id === provider)
  const selectedModel = selectedGroup?.models?.find((item: any) => item.id === model)
  const known = !selectedValue || !catalog || selectedModel
  const efforts = selectedModel?.reasoning?.efforts ?? []
  const selectStyle = { width: '100%', boxSizing: 'border-box' as const, margin: '4px 0 10px', padding: '7px 9px' }

  return <fieldset disabled={props.disabled} style={{ border: 0, padding: 0, margin: '0 0 16px' }}>
    <legend style={{ fontWeight: 600, padding: 0 }}>Worker 默认模型</legend>
    <p style={{ opacity: 0.7, fontSize: '12px', margin: '4px 0 10px' }}>{MODEL_HINT}</p>
    <label htmlFor="dsho-worker-model">模型 ID</label>
    <select id="dsho-worker-model" style={selectStyle} value={selectedValue} onChange={event => {
      const value = event.target.value
      if (!value) {
        props.edit('workerProvider', '')
        props.edit('workerModel', '')
      } else {
        const [nextProvider, nextModel] = JSON.parse(value)
        props.edit('workerProvider', nextProvider)
        props.edit('workerModel', nextModel)
      }
      props.edit('workerReasoningEffort', '')
    }}>
      <option value="">跟随主会话（默认）</option>
      {!known && <option value={selectedValue}>当前配置不可用：{provider}/{model}</option>}
      {catalog?.groups?.map((group: any) => <optgroup key={group.id} label={group.name}>
        {group.models.map((item: any) => {
          const value = JSON.stringify([group.id, item.id])
          return <option key={value} value={value}>{item.name}（{item.id}）</option>
        })}
      </optgroup>)}
    </select>
    {error && <div style={{ color: 'var(--dsw-alias-state-error-label)', fontSize: '12px', margin: '-4px 0 10px' }}>
      模型列表加载失败：{error} <button type="button" onClick={() => setRevision(value => value + 1)}>重试</button>
    </div>}
    {selectedValue && <><label htmlFor="dsho-worker-effort">推理强度</label>
      <select id="dsho-worker-effort" style={selectStyle} value={effort} disabled={props.disabled || efforts.length === 0} onChange={event => {
        props.edit('workerReasoningEffort', event.target.value)
      }}>
        <option value="">模型默认{selectedModel?.reasoning?.defaultEffort ? `（${selectedModel.reasoning.defaultEffort}）` : ''}</option>
        {effort && !efforts.some((item: any) => item.id === effort) && <option value={effort}>当前配置：{effort}</option>}
        {efforts.map((item: any) => <option key={item.id} value={item.id}>{item.name}（{item.id}）</option>)}
      </select></>}
  </fieldset>
}

function SettingsCard(props: any): React.ReactElement {
  const state = props.useSettingsCard((snapshot: any) => snapshot)
  if (props.view === 'summary') return <>{SUMMARY}</>
  const disabled = !state.writable || state.saving
  return (
    <primitives.SettingsForm labels={FORM_LABELS} state={state} onSave={props.save} onDiscard={props.discard}>
      <ModelSelectionFields {...props} state={state} disabled={disabled} />
      <p style={{ opacity: 0.7, fontSize: '12px', margin: '0 0 4px' }}>{DELIVERY_HINT}</p>
      {STATUS_FIELDS.map(({ field, label, hint }) => (
        <div key={field} style={{ display: 'flex', alignItems: 'center', gap: '8px', margin: '8px 0' }}>
          <primitives.Switch
            checked={(state[field]?.text ?? 'false') !== 'false'}
            disabled={disabled}
            label={label}
            title={hint ?? label}
            onChange={(checked: boolean) => {
              props.edit(field, String(checked))
            }}
          />
          <span>{label}</span>
        </div>
      ))}
    </primitives.SettingsForm>
  )
}

/** 在 Host 提供本命名空间期间挂载行配置卡片（随 configForms 服务 fiber 卸载）。 */
export function registerSettingsCard(ctx: any): void {
  const controller = new SettingsCardController(
    ctx.configForms.get(HOST_NAMESPACE),
    async () => {
      const result = await ctx.remote.session.modelCatalog()
      if (!result?.ok) throw new Error(result?.error?.message ?? '模型目录请求失败')
      return result.value
    },
  )
  ctx.effect(() => () => {
    controller.dispose()
  }, 'orchestrator: settings form')
  ctx.effect(
    () => ctx.configForms.whileServed([HOST_NAMESPACE], () => ctx.slots.inject(
      'plugins.row.config',
      () => ctx.slots.register({
        name: 'plugins.row.config',
        key: SLOT_KEY,
        inject: () => controller.inject(),
      }, SettingsCard),
    )),
    'orchestrator: settings slot',
  )
}
