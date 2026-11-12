import React, { useEffect } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import remoteContribution from '../remote.ts'
import { Board } from './Board.tsx'
import { registerSettingsCard } from './settings-card.tsx'
import { adoptStyles } from './styles.ts'
import { BOARD_KIND, watchInputRequired } from './task-attention.ts'

const PLUGIN_ID = '@cmjt/dsh-orchestrator'
const TAB_ID = `${PLUGIN_ID}/board`
export const inject = ['remote', 'slots', 'uiWorkspace', 'sidebarRightTabs', 'sidebarRight', 'configForms']

function HeaderButton(props: any): React.ReactElement {
  const sessionId = String(props.sessionId ?? '')
  useEffect(() => {
    if (!sessionId.startsWith('session-')) return
    return watchInputRequired({
      sessionId,
      orchestrator: props.orchestrator,
      remoteEvents: props.remoteEvents,
      sidebarRight: props.sidebarRight,
    })
  }, [sessionId, props.orchestrator, props.remoteEvents, props.sidebarRight])

  // Worker 是无 session- 前缀的一级会话；这里不提供看板入口，避免用 child sessionId 拉到空看板。
  if (!sessionId.startsWith('session-')) return <></>
  return <button
    className="dsho-headerButton"
    type="button"
    onClick={() => props.sidebarRight.openTab(BOARD_KIND, { params: { sessionId } })}
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
    kind: BOARD_KIND,
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
          orchestrator,
          remoteEvents: ctx.remote,
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

  let settings: { dispose(): Promise<void> } | undefined
  // 设置卡片挂载失败不拖垮看板；remote.session 必须在显式 inject 子作用域读取。
  try {
    settings = client.inject(['remote.session'], registerSettingsCard)
    await settings
  } catch (error) {
    console.error('orchestrator settings card mount failed', error)
    await settings?.dispose()
    settings = undefined
  }

  const ui = client.inject(
    ['remote.orchestrator', 'remote', 'remote.session', 'slots', 'uiWorkspace', 'sidebarRightTabs', 'sidebarRight'],
    registerUi,
  )
  try {
    await ui
  } catch (error) {
    await ui.dispose()
    await settings?.dispose()
    await disposeRemote()
    throw error
  }

  return async () => {
    await ui.dispose()
    await settings?.dispose()
    await disposeRemote()
  }
}
