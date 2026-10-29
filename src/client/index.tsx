import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import remoteContribution from '../remote.ts'
import { Board } from './Board.tsx'
import { registerSettingsCard } from './settings-card.tsx'
import { adoptStyles } from './styles.ts'

const PLUGIN_ID = '@may/dsh-orchestrator'
const TAB_ID = `${PLUGIN_ID}/board`
const KIND = 'orchestratorBoard'

export const inject = ['remote', 'slots', 'uiWorkspace', 'sidebarRightTabs', 'sidebarRight', 'configForms']

function HeaderButton(props: any): React.ReactElement {
  // Worker 是无 session- 前缀的一级会话；这里不提供看板入口，避免用 child sessionId 拉到空看板。
  if (!String(props.sessionId ?? '').startsWith('session-')) return <></>
  return <button
    className="dsho-headerButton"
    type="button"
    onClick={() => props.sidebarRight.openTab(KIND, { params: { sessionId: props.sessionId } })}
  >任务看板</button>
}

function BoardBody(props: any): React.ReactElement {
  return <Board
    sessionId={props.sessionId}
    useTabInfo={props.useTabInfo}
    orchestrator={props.orchestrator}
    remoteEvents={props.remoteEvents}
    uiWorkspace={props.uiWorkspace}
  />
}

function BoardTitle(): React.ReactElement {
  return <>任务看板</>
}

function registerUi(ctx: any): void {
  // $mount 创建的是独立服务键 remote.orchestrator；必须在这个 inject fiber 内取出。
  const orchestrator = ctx.remote.orchestrator
  ctx.effect(() => ctx.sidebarRightTabs.register({
    id: TAB_ID,
    kind: KIND,
    priority: 'extension',
    title: () => '任务看板',
  }))

  ctx.effect(() => {
    const disposeHeader = ctx.slots.inject(
      'conversation.session.header.utilities',
      () => ctx.slots.register({
        name: 'conversation.session.header.utilities',
        id: `${PLUGIN_ID}/header`,
        order: -6,
        inject: (sessionId: string) => ({
          sessionId,
          sidebarRight: ctx.sidebarRight,
        }),
      }, HeaderButton),
    )
    const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab',
      key: TAB_ID,
      inject: (sessionId: string) => ({
        sessionId,
        orchestrator,
        remoteEvents: ctx.remote,
        uiWorkspace: ctx.uiWorkspace,
      }),
    }, BoardBody))
    const disposeTitle = ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
      name: 'sidebar.right.pane.tab.title',
      key: TAB_ID,
      inject: () => ({}),
    }, BoardTitle))
    return async () => {
      for (const dispose of [disposeTitle, disposeBody, disposeHeader]) await Promise.resolve(dispose())
    }
  })
}

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  adoptStyles()
  const client = ctx as any
  let disposeRemote: () => Promise<void>
  try {
    disposeRemote = await client.remote.$mount(remoteContribution)
  } catch (error) {
    console.error('orchestrator remote mount failed', error)
    throw error
  }

  // 设置卡片（终态投递开关）挂载失败不拖垮看板。
  try {
    registerSettingsCard(client)
  } catch (error) {
    console.error('orchestrator settings card mount failed', error)
  }

  const ui = client.inject(
    ['remote.orchestrator', 'remote', 'remote.session', 'slots', 'uiWorkspace', 'sidebarRightTabs', 'sidebarRight'],
    registerUi,
  )
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await disposeRemote()
    throw error
  }

  return async () => {
    await ui.dispose()
    await disposeRemote()
  }
}
