import React from 'react'
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import * as clientStore from '@deepseek-ai/dsh-client-store'

/**
 * 终态投递开关的设置卡片（插件管理 → @may/dsh-orchestrator → 行"配置"）。
 * 结构沿用 dsh-ciri 的设置卡片模式：SettingsFormModel 暂存编辑，Switch 直写布尔。
 * runtime external：primitives/store 由前端 ModuleLoader 提供（dsh.client.external）。
 */

/** Host 设置命名空间（cordis.patch.yml 的 loader 行 id）。 */
const HOST_NAMESPACE = 'may-dsh-orchestrator'
/** plugins.row.config 槽 key：<包名>#<行 id>。 */
const SLOT_KEY = '@may/dsh-orchestrator#may-dsh-orchestrator'

const SUMMARY = '子会话终态消息的投递开关：按状态勾选是否通知主会话。'
const SECTION_HINT = '勾选子会话 task_update 的各终态是否投递消息给主会话。'
  + '无论是否投递，任务状态、进度与待办都会实时更新到任务看板；静默（silent）会话始终不投递。'
  + '改动即时生效；关闭期间产生的终态不补投。'
  + '「等待用户操作」默认关闭：问题卡（看板/子会话，开启后含主会话原生卡）已覆盖可见性；打开后主会话会渲染原生问题卡。'

const STATUS_FIELDS = [
  { field: 'deliverOnCompleted', label: '已完成（completed）' },
  { field: 'deliverOnFailed', label: '失败（failed，含系统阻碍）' },
  { field: 'deliverOnInterrupted', label: '已中断（interrupted）', hint: '仅手动停止会投递；改单与重启中断本就不投递。' },
] as ReadonlyArray<{ field: string; label: string; hint?: string }>

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

/** 插件管理页插件命名空间上的暂存表单。 */
class DeliveryCardController {
  private readonly section: any
  private readonly store: any
  private readonly unsubscribe: Array<() => void>

  constructor(scope: any) {
    this.section = new primitives.SettingsFormModel(scope, STATUS_FIELDS.map(({ field }) => boolField(field)))
    this.store = clientStore.createSnapshotStore(this.projection())
    const publish = () => this.publish()
    this.unsubscribe = [this.section.bind(() => this.section.shell()).subscribe(publish)]
  }

  private projection(): Record<string, unknown> {
    const shell = this.section.shell()
    const fields: Record<string, unknown> = {}
    for (const { field } of STATUS_FIELDS) fields[field] = this.section.field(field)
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
      hooks: { deliveryCard: this.store },
      edit: (field: string, text: string) => {
        this.section.actions().edit(field, text)
      },
      save: () => {
        void this.save()
      },
      discard: () => {
        this.section.actions().discard()
      },
    }
  }
}

function DeliveryCard(props: any): React.ReactElement {
  const state = props.useDeliveryCard((snapshot: any) => snapshot)
  if (props.view === 'summary') return <>{SUMMARY}</>
  const disabled = !state.writable || state.saving
  return (
    <primitives.SettingsForm labels={FORM_LABELS} state={state} onSave={props.save} onDiscard={props.discard}>
      <p style={{ opacity: 0.7, fontSize: '12px', margin: '0 0 4px' }}>{SECTION_HINT}</p>
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
  const controller = new DeliveryCardController(ctx.configForms.get(HOST_NAMESPACE))
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
      }, DeliveryCard),
    )),
    'orchestrator: settings slot',
  )
}
