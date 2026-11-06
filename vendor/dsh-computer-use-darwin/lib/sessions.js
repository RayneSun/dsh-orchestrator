import { AsyncLocalStorage } from 'node:async_hooks'

const activeSession = new AsyncLocalStorage()

export function computerSession() {
  const session = activeSession.getStore()
  if (!session) throw new Error('桌面工具缺少会话上下文，请在会话中调用。')
  return session
}

export function createComputerSessionScope(prefix) {
  const sessions = new WeakMap()
  return (exec, operation) => {
    const agent = exec?.agent
    const sessionId = agent?.session?.id
    if (!agent || !sessionId) throw new Error('桌面工具缺少会话上下文，请在会话中调用。')
    let session = sessions.get(agent)
    if (!session) {
      session = { id: `${prefix}-${sessionId}`, snapshot: null, initialized: false, chain: Promise.resolve() }
      sessions.set(agent, session)
    }
    const result = session.chain.then(() => activeSession.run(session, () => {
      exec.signal?.throwIfAborted()
      return operation()
    }))
    session.chain = result.then(() => undefined, () => undefined)
    return result
  }
}
