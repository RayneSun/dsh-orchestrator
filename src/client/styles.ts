export const STYLE_ID = 'may-dsh-orchestrator-style'
export const CSS = `
.dsho-headerButton{font:inherit;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:3px 9px;cursor:pointer}
.dsho-headerButton:hover{border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-interactive-bg-hover)}
.dsho-board{box-sizing:border-box;height:100%;overflow:auto;padding:14px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-1)}
.dsho-title{font-size:15px;font-weight:650;margin:0 0 12px}
.dsho-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.6;border:.5px dashed var(--dsw-alias-border-l4);border-radius:12px;padding:18px;text-align:center}
.dsho-conv{border:.5px solid var(--dsw-alias-border-l4);border-radius:14px;background:var(--dsw-alias-bg-layer-2);margin:0 0 12px;overflow:hidden}
.dsho-convHead{display:flex;align-items:center;gap:8px;padding:12px 13px;border-bottom:.5px solid var(--dsw-alias-border-l2)}
.dsho-convTitle{min-width:0;flex:1;font-size:13px;font-weight:620;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsho-badge{flex:none;border-radius:999px;padding:1px 8px;font-size:11px;line-height:18px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsho-badge-running,.dsho-badge-queued,.dsho-badge-provisioning{color:var(--dsw-alias-brand-primary)}
.dsho-badge-completed,.dsho-badge-idle{color:var(--dsw-alias-label-positive,#34a853)}
.dsho-badge-blocked{color:#b26b00}
.dsho-badge-interrupted,.dsho-badge-cancelled{color:#7a7a7a}
.dsho-taskMuted{opacity:.62}
.dsho-taskMuted .dsho-taskSubject{text-decoration:line-through}
.dsho-badge-failed{color:var(--dsw-alias-label-error,#d93025)}
.dsho-meta{padding:10px 13px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.6}
.dsho-open{font:inherit;border:0;background:none;color:var(--dsw-alias-brand-primary);cursor:pointer;padding:0;font-size:12px;flex:none}
.dsho-tasks{list-style:none;margin:0;padding:0}
.dsho-task{border-top:.5px solid var(--dsw-alias-border-l2);padding:10px 13px;display:flex;flex-direction:column;gap:5px}
.dsho-taskHead{display:flex;align-items:center;gap:8px;font-size:12px}
.dsho-taskSubject{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}
.dsho-mode{color:var(--dsw-alias-label-tertiary);font-size:11px}
.dsho-note{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}
.dsho-subtle{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
.dsho-answer{margin:0;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.55;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}
.dsho-times{color:var(--dsw-alias-label-tertiary);font-size:10px}
.dsho-error{color:var(--dsw-alias-label-error,#d93025)}

.dsho-steps{border:.5px solid var(--dsw-alias-border-l4);border-radius:10px;padding:8px 9px;background:var(--dsw-alias-bg-layer-3)}
.dsho-stepsHead{display:flex;justify-content:space-between;align-items:center;color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:620;margin-bottom:5px}
.dsho-stepsActive{color:var(--dsw-alias-brand-primary)}
.dsho-steps ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;max-height:150px;overflow:auto}
.dsho-step{display:flex;align-items:flex-start;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4}
.dsho-stepIcon{flex:none;width:16px;text-align:center}
.dsho-step-in_progress{color:var(--dsw-alias-brand-primary)}
.dsho-step-completed{color:var(--dsw-alias-label-secondary)}
.dsho-step-completed span:last-child{text-decoration:line-through;text-decoration-color:var(--dsw-alias-border-l4)}
`
export function adoptStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}
