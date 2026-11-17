import React from 'react'
import type { TaskRecord } from '../types.ts'

/** 看板只给问题入口；媒体与完整作答在共享弹窗里。 */
export function AskCard({ task, onOpen }: { task: TaskRecord; onOpen(): void }): React.ReactElement {
  const questions = task.questions ?? []
  return <button className="dsho-ask dsho-askEntry" type="button" onClick={onOpen}>
    <span className="dsho-askIcon">?</span>
    <span><b>待你操作</b><small>{questions[0]?.question}{questions.length > 1 ? ' 等 ' + questions.length + ' 个问题' : ''}</small></span>
    <span>回答 ›</span>
  </button>
}
