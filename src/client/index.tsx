import React from 'react'
import type { Context } from '@deepseek-ai/cordis'
import remoteContribution from '../remote.ts'
import { Board } from './Board.tsx'
import { adoptStyles } from './styles.ts'

const PLUGIN_ID = '@may/dsh-orchestrator'
const TAB_ID = `${PLUGIN_ID}/board`
const KIND = 'orchestratorBoard'

export const inject = ['remote', 'slots', 'uiWorkspace', 'sidebarRightTabs', 'sidebarRight']

function HeaderButton(props: any): React.ReactElement {
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
    remote={props.remote}
    uiWorkspace={props.uiWorkspace}
  />
}

function BoardTitle(): React.ReactElement {
  return <>任务看板</>
}

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  adoptStyles()
  const client = ctx as any
  const disposeRemote = await client.remote.$mount(remoteContribution)
  const disposers: Array<() => unknown> = []

  try {
    disposers.push(client.sidebarRightTabs.register({
      id: TAB_ID,
      kind: KIND,
      priority: 'extension',
      title: () => '任务看板',
    }))

    client.effect(() => {
      const disposeHeader = client.slots.inject(
        'conversation.session.header.utilities',
        () => client.slots.register({
          name: 'conversation.session.header.utilities',
          id: `${PLUGIN_ID}/header`,
          order: -6,
          inject: (sessionId: string) => ({
            sessionId,
            sidebarRight: client.sidebarRight,
          }),
        }, HeaderButton),
      )
      const disposeBody = client.slots.inject('sidebar.right.pane.tab', () => client.slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
        inject: (sessionId: string) => ({
          sessionId,
          remote: client.remote,
          uiWorkspace: client.uiWorkspace,
        }),
      }, BoardBody))
      const disposeTitle = client.slots.inject('sidebar.right.pane.tab.title', () => client.slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: TAB_ID,
        inject: () => ({}),
      }, BoardTitle))
      return async () => {
        for (const dispose of [disposeTitle, disposeBody, disposeHeader]) await Promise.resolve(dispose())
      }
    })
  } catch (error) {
    for (const dispose of disposers.reverse()) await Promise.resolve(dispose())
    await disposeRemote()
    throw error
  }

  return async () => {
    for (const dispose of disposers.reverse()) await Promise.resolve(dispose())
    await disposeRemote()
  }
}
