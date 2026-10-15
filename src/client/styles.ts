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
.dsho-badge{flex:none;display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:600;line-height:16px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsho-badge-queued,.dsho-badge-provisioning{background:color-mix(in srgb,var(--dsw-alias-brand-primary,#1a73e8) 13%,transparent);color:color-mix(in srgb,var(--dsw-alias-brand-primary,#1a73e8) 82%,#000 8%)}
.dsho-badge-running{background:color-mix(in srgb,var(--dsw-alias-label-positive,#188038) 15%,transparent);color:color-mix(in srgb,var(--dsw-alias-label-positive,#188038) 85%,#000 5%);padding-left:7px}
.dsho-badge-running::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor;animation:dsho-pulse 1.5s ease-in-out infinite}
@keyframes dsho-pulse{0%,100%{opacity:1}50%{opacity:.3}}
@media (prefers-reduced-motion:reduce){.dsho-badge-running::before{animation:none}}
.dsho-badge-completed{background:var(--dsw-alias-label-positive,#188038);color:#fff}
.dsho-badge-idle{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsho-badge-input_required{background:color-mix(in srgb,#b26b00 15%,transparent);color:#965400}
.dsho-badge-failed{background:color-mix(in srgb,var(--dsw-alias-label-error,#d93025) 11%,transparent);color:color-mix(in srgb,var(--dsw-alias-label-error,#d93025) 85%,#000 5%)}
.dsho-badge-interrupted,.dsho-badge-cancelled{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}
.dsho-taskMuted{opacity:.7}
.dsho-taskMuted .dsho-taskSubject{text-decoration:line-through}
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
.dsho-stepsActive{color:var(--dsw-alias-label-positive,#188038)}
.dsho-steps ul{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:3px;max-height:150px;overflow:auto}
.dsho-step{display:flex;align-items:flex-start;gap:6px;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.4}
.dsho-stepIcon{flex:none;width:16px;text-align:center}
.dsho-step-in_progress{color:var(--dsw-alias-label-positive,#188038)}
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
