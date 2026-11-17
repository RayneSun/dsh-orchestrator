import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { QuestionAnswer, QuestionItem } from '../types.ts'

export interface QuestionRequest { id: string; taskId?: string; questions: QuestionItem[] }

function mediaUrl(sessionId: string, requestId: string, source: string): string {
  const params = new URLSearchParams({ session: sessionId, id: requestId, source })
  return '/api/orchestrator/question-media?' + params
}

function Media({ item, sessionId, requestId, selectable = false }: { item: NonNullable<QuestionItem['media']>[number]; sessionId: string; requestId: string; selectable?: boolean }): React.ReactElement {
  const src = mediaUrl(sessionId, requestId, item.source)
  const [failed, setFailed] = useState(false)
  if (failed) return <div className="dsho-mediaError">无法加载：{item.caption ?? item.source}</div>
  return <div className="dsho-mediaItem">
    {item.kind === 'image' && (selectable
      ? <img src={src} alt={item.caption ?? item.source} onError={() => setFailed(true)} />
      : <a href={src} target="_blank" rel="noopener noreferrer"><img src={src} alt={item.caption ?? item.source} onError={() => setFailed(true)} /></a>)}
    {item.kind === 'audio' && <audio src={src} controls preload="metadata" onError={() => setFailed(true)} />}
    {item.kind === 'video' && <video src={src} poster={item.poster && mediaUrl(sessionId, requestId, item.poster)} controls preload="metadata" onError={() => setFailed(true)} />}
    {item.kind === 'file' && <a href={src} target="_blank" rel="noopener noreferrer">打开文件 · {item.caption ?? item.source}</a>}
    {item.caption && item.kind !== 'file' && <small>{item.caption}</small>}
  </div>
}

export function QuestionDialog({ request, sessionId, onSubmit, onHide }: {
  request: QuestionRequest; sessionId: string; onSubmit(answers: QuestionAnswer[]): Promise<void>; onHide(): void
}): React.ReactElement {
  const [picked, setPicked] = useState<Record<string, string[]>>({})
  const [custom, setCustom] = useState<Record<string, string>>({})
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [index, setIndex] = useState(0)
  const [scale, setScale] = useState(1)
  const dialogRef = useRef<HTMLElement>(null)
  const question = request.questions[index]
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onHide() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onHide])
  useLayoutEffect(() => {
    const dialog = dialogRef.current
    if (!dialog) return
    const fit = () => {
      const viewport = window.visualViewport
      setScale(Math.min(1, ((viewport?.width ?? window.innerWidth) - 32) / dialog.offsetWidth, ((viewport?.height ?? window.innerHeight) - 32) / dialog.offsetHeight))
    }
    const observer = new ResizeObserver(fit)
    observer.observe(dialog)
    window.addEventListener('resize', fit)
    window.visualViewport?.addEventListener('resize', fit)
    fit()
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', fit)
      window.visualViewport?.removeEventListener('resize', fit)
    }
  }, [index])

  const submit = async () => {
    const answers = request.questions.map(item => ({ id: item.id, selected: picked[item.id] ?? [], ...custom[item.id]?.trim() ? { custom: custom[item.id].trim() } : {} }))
    const missing = answers.findIndex(answer => answer.selected.length === 0 && !answer.custom)
    if (missing >= 0) { setIndex(missing); setError('请回答全部问题'); return }
    setBusy(true)
    setError(undefined)
    try { await onSubmit(answers) }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); setBusy(false) }
  }
  if (!question) return <></>
  return createPortal(<div className="dsho-qBackdrop" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onHide() }}>
    <section ref={dialogRef} className="dsho-qDialog" role="dialog" aria-modal="true" aria-label="待你回答" style={{ transform: 'scale(' + scale + ')' }}>
      <header className="dsho-qHead"><span>待你回答 · {index + 1}/{request.questions.length}</span><button type="button" onClick={onHide} aria-label="收起问题">×</button></header>
      {question.header && <small className="dsho-qKicker">{question.header}</small>}
      <h2>{question.question}</h2>
      {question.detail && <p className="dsho-qDetail">{question.detail}</p>}
      {!!question.media?.length && <div className="dsho-qMedia">{question.media.map((item, i) => <Media key={i} item={item} sessionId={sessionId} requestId={request.id} />)}</div>}
      {!!question.options?.length && <div className="dsho-qOptions">{question.options.map(option => {
        const selected = picked[question.id]?.includes(option.id) ?? false
        const toggle = () => setPicked(prev => {
            const current = prev[question.id] ?? []
            return { ...prev, [question.id]: question.multi_select ? current.includes(option.id) ? current.filter(id => id !== option.id) : [...current, option.id] : [option.id] }
          })
        return <div key={option.id} className={'dsho-qOption' + (selected ? ' selected' : '') + (option.preview ? '' : ' flat')}
          role={question.multi_select ? 'checkbox' : 'radio'} aria-checked={selected} tabIndex={0}
          onClick={event => { if (!(event.target as HTMLElement).closest('button, textarea, a, audio, video, input')) toggle() }}
          onKeyDown={event => { if ((event.key === 'Enter' || event.key === ' ') && event.target === event.currentTarget) { event.preventDefault(); toggle() } }}>
          {option.preview && <Media item={option.preview} sessionId={sessionId} requestId={request.id} selectable />}
          <div className="dsho-qOptionHead"><span className="dsho-qOptionDot" aria-hidden="true" />
            <span><b>{option.label}</b>{option.description && <small>{option.description}</small>}</span>
          </div>
        </div>
      })}</div>}
      <textarea rows={2} maxLength={2000} value={custom[question.id] ?? ''} onChange={event => setCustom(prev => ({ ...prev, [question.id]: event.target.value }))} placeholder={question.options?.length ? '补充原因（可选）' : '输入回答'} />
      {error && <p className="dsho-qError" role="alert">{error}</p>}
      <footer className="dsho-qFoot"><button type="button" onClick={onHide}>稍后回答</button><div>
        {index > 0 && <button type="button" onClick={() => setIndex(index - 1)}>上一题</button>}
        {index + 1 < request.questions.length && <button type="button" onClick={() => setIndex(index + 1)}>下一题</button>}
        <button type="button" disabled={busy} onClick={() => void submit()}>{busy ? '提交中…' : '提交回答'}</button>
      </div></footer>
    </section>
  </div>, document.body)
}
