import React, { useState } from 'react'
import type { QuestionItem, TaskRecord } from '../types.ts'
import type { AnswerQuestionsRequest } from '../remote.ts'

/** 问题卡：看板侧的作答入口（Worker 原生问题卡共用同一 RPC 路由）。 */
export function AskCard({ task, onSubmit }: {
  task: TaskRecord
  onSubmit: (answers: AnswerQuestionsRequest['answers']) => Promise<void>
}): React.ReactElement {
  const questions = task.questions ?? []
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [customs, setCustoms] = useState<Record<string, string>>({})
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string>()
  const togglePick = (item: QuestionItem, label: string): void => {
    setPicked(prev => {
      const current = prev[item.id] ?? []
      if (item.multi_select) {
        return { ...prev, [item.id]: current.includes(label) ? current.filter(v => v !== label) : [...current, label] }
      }
      return { ...prev, [item.id]: current.includes(label) ? [] : [label] }
    })
  }
  const submit = async (): Promise<void> => {
    if (submitting) return
    const answers = questions.map(item => ({
      id: item.id,
      ...(picked[item.id]?.length ? { selected: picked[item.id] } : {}),
      ...(customs[item.id]?.trim() ? { custom: customs[item.id]!.trim() } : {}),
    })).filter(answer => (answer.selected?.length ?? 0) > 0 || answer.custom !== undefined)
    if (answers.length === 0) { setError('请先选择或填写至少一项回答'); return }
    setSubmitting(true)
    setError(undefined)
    try {
      await onSubmit(answers)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }
  return <div className="dsho-ask">
    <div className="dsho-askHead"><span className="dsho-askIcon">?</span>子会话向你提问 · {task.subject}</div>
    {questions.map(item => <div key={item.id} className="dsho-askItem">
      <div className="dsho-askQ">{item.header ? <b>{item.header}：</b> : null}{item.question}</div>
      {item.detail && <div className="dsho-askDetail">{item.detail}</div>}
      {item.options && item.options.length > 0 && <div className="dsho-askOpts">
        {item.options.map(option => {
          const selected = picked[item.id]?.includes(option.label) ?? false
          return <button key={option.label} type="button"
            className={`dsho-opt${selected ? ' dsho-opt-sel' : ''}`}
            title={option.description}
            onClick={() => togglePick(item, option.label)}>{option.label}</button>
        })}
      </div>}
      {!item.options?.length && <input
        className="dsho-askCustom"
        placeholder="输入回答（可选）"
        value={customs[item.id] ?? ''}
        onChange={event => setCustoms(prev => ({ ...prev, [item.id]: event.target.value }))}
      />}
      {item.options?.length > 0 && <input
        className="dsho-askCustom"
        placeholder="补充说明（可选）"
        value={customs[item.id] ?? ''}
        onChange={event => setCustoms(prev => ({ ...prev, [item.id]: event.target.value }))}
      />}
    </div>)}
    {error && <div className="dsho-askError">{error}</div>}
    <button type="button" className="dsho-askSubmit" disabled={submitting} onClick={() => void submit()}>
      {submitting ? '提交中…' : '提交回答'}
    </button>
  </div>
}
