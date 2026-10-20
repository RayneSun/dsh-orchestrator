export const STYLE_ID = 'may-dsh-orchestrator-style'
export const CSS = `
.dsho-headerButton{font:inherit;border:.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);border-radius:8px;padding:3px 9px;cursor:pointer}
.dsho-headerButton:hover{border-color:var(--dsw-alias-label-dimmed);background:var(--dsw-alias-interactive-bg-hover)}
.dsho-board{box-sizing:border-box;height:100%;overflow:auto;padding:14px;color:var(--dsw-alias-label-primary,light-dark(#1f2329,#e8eaed));background:var(--dsw-alias-bg-layer-1,light-dark(#f7f8fa,#181818));--dsho-brand:light-dark(#1a73e8,#7ab8ff);--dsho-brand-ink:light-dark(#1557b0,#9cc4ff);--dsho-pos:light-dark(#188038,#4caf7d);--dsho-pos-ink:light-dark(#146c2f,#7ecfa2);--dsho-err:light-dark(#d93025,#ff6b61);--dsho-err-ink:light-dark(#b3261e,#ff8a80);--dsho-warn:light-dark(#a35200,#e8a04c);--dsho-line:var(--dsw-alias-border-l4,light-dark(#e4e7eb,rgb(255 255 255 / 10%)))}
.dsho-title{font-size:15px;font-weight:650;margin:0 0 12px}
.dsho-empty{color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:1.6;border:.5px dashed var(--dsw-alias-border-l4);border-radius:12px;padding:18px;text-align:center}
.dsho-conv{position:relative;border:.5px solid var(--dsw-alias-border-l4);border-radius:12px;background:var(--dsw-alias-bg-layer-2,light-dark(#fff,#1f1f1f));margin:0 0 12px;overflow:hidden}
.dsho-convHead{display:flex;align-items:center;gap:8px;padding:12px 13px;border-bottom:.5px solid var(--dsw-alias-border-l2);cursor:pointer;user-select:none;outline:none}
.dsho-convHead:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsho-convHead:focus-visible{box-shadow:inset 0 0 0 2px color-mix(in srgb,var(--dsho-brand) 45%,transparent)}
.dsho-conv-collapsed .dsho-convHead{border-bottom-color:transparent}
.dsho-chevron{flex:none;width:7px;height:7px;margin:0 2px 0 1px;border-right:1.5px solid var(--dsw-alias-label-tertiary);border-bottom:1.5px solid var(--dsw-alias-label-tertiary);transform:rotate(45deg) translateY(-1px);transition:transform .22s ease}
.dsho-conv-collapsed .dsho-chevron{transform:rotate(-45deg) translateY(-1px)}
.dsho-convTitle{min-width:0;flex:1;font-size:13px;font-weight:620;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* 折叠态摘要行 */
.dsho-strip{display:flex;align-items:center;gap:8px;padding:0 13px 11px 26px;min-width:0}
.dsho-strip .dsho-badge{flex:none}
.dsho-stripText{flex:1;min-width:0;font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsho-stripTime{flex:none;font-size:10px;color:var(--dsw-alias-label-tertiary)}
/* 高度折叠动画（grid 0fr/1fr） */
.dsho-body{display:grid;grid-template-rows:1fr;transition:grid-template-rows .24s ease}
.dsho-conv-collapsed .dsho-body{grid-template-rows:0fr}
.dsho-body>div{min-height:0;overflow:hidden}
/* 运行中：绿色描边 + 顶部扫光 */
.dsho-conv-active{border-color:color-mix(in srgb,var(--dsho-pos) 26%,transparent)}
/* 顶部柔光扫过：低亮度绿色光带，入场/出场整体淡入淡出，避免边缘突变 */
.dsho-conv-active::before{content:'';position:absolute;z-index:1;pointer-events:none;top:0;left:0;right:0;height:1.5px;background:linear-gradient(90deg,transparent 0%,color-mix(in srgb,var(--dsho-pos) 55%,transparent) 50%,transparent 100%);background-size:55% 100%;background-repeat:no-repeat;opacity:0;animation:dsho-sweep 2.6s ease-in-out infinite}
@keyframes dsho-sweep{0%{background-position:-45% 0;opacity:0}20%{opacity:.9}80%{opacity:.9}100%{background-position:145% 0;opacity:0}}
@media (prefers-reduced-motion:reduce){.dsho-conv-active::before,.dsho-chevron{animation:none;transition:none}.dsho-body{transition:none}}
.dsho-badge{flex:none;display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:2px 9px;font-size:11px;font-weight:600;line-height:16px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);white-space:nowrap}
.dsho-badge-queued,.dsho-badge-provisioning{background:color-mix(in srgb,var(--dsho-brand) 13%,transparent);color:var(--dsho-brand-ink)}
.dsho-badge-running{background:color-mix(in srgb,var(--dsho-pos) 14%,transparent);color:var(--dsho-pos-ink);padding-left:7px}
.dsho-badge-running::before{content:'';width:6px;height:6px;border-radius:50%;background:currentColor;animation:dsho-pulse 1.5s ease-in-out infinite}
@keyframes dsho-pulse{0%,100%{opacity:1}50%{opacity:.3}}
@media (prefers-reduced-motion:reduce){.dsho-badge-running::before{animation:none}}
.dsho-badge-completed{background:var(--dsho-pos);color:#fff}
.dsho-badge-idle{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dsho-badge-input_required{background:color-mix(in srgb,var(--dsho-warn) 15%,transparent);color:var(--dsho-warn)}
.dsho-badge-blocked{background:color-mix(in srgb,var(--dsho-warn) 16%,transparent);color:var(--dsho-warn)}
.dsho-badge-failed{background:color-mix(in srgb,var(--dsho-err) 11%,transparent);color:var(--dsho-err-ink)}
.dsho-badge-interrupted{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}
.dsho-taskMuted{opacity:.75}
.dsho-meta{padding:6px 13px;color:var(--dsw-alias-label-tertiary,#9aa0a6);font-size:11px;line-height:1.6;border-bottom:.5px dashed var(--dsho-line)}
.dsho-open{font:inherit;flex:none;cursor:pointer;font-size:11px;line-height:16px;padding:3px 8px;border-radius:6px;border:1px solid var(--dsho-line);background:transparent;color:var(--dsho-brand)}
.dsho-open:hover{background:color-mix(in srgb,var(--dsho-brand) 8%,transparent)}
.dsho-open:active{background:color-mix(in srgb,var(--dsho-brand) 16%,transparent)}
.dsho-tasks{list-style:none;margin:0;padding:0}
.dsho-task{border-top:.5px dashed var(--dsw-alias-border-l2);padding:10px 13px;display:flex;flex-direction:column;gap:5px}
.dsho-task:first-child{border-top:none}
.dsho-taskHead{display:flex;align-items:center;gap:8px;font-size:12px}
.dsho-taskSubject{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-primary)}
.dsho-note{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5}
.dsho-subtle{margin:0;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1.5}
.dsho-answer{margin:0;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.55;display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden}
.dsho-times{color:var(--dsw-alias-label-tertiary);font-size:10px}
.dsho-tag{flex:none;display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:6px}
.dsho-tag svg{width:13px;height:13px;display:block}
.dsho-tag-silent{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-tertiary)}
.dsho-tag-scheduled{background:color-mix(in srgb,var(--dsho-brand) 13%,transparent);color:var(--dsho-brand-ink)}
.dsho-note{display:flex;gap:6px;align-items:baseline}
.dsho-noteText{flex:1;min-width:0}
.dsho-note-live .dsho-noteText{background:linear-gradient(90deg,var(--dsw-alias-label-primary) 30%,var(--dsho-brand) 50%,var(--dsw-alias-label-primary) 70%);background-size:200% 100%;-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;animation:dsho-shimmer 1.8s linear infinite}
@keyframes dsho-shimmer{0%{background-position:120% 0}100%{background-position:-80% 0}}
@media (prefers-reduced-motion:reduce){.dsho-note-live .dsho-noteText{animation:none;background:none;-webkit-text-fill-color:currentcolor}}
.dsho-expander{flex:none;border:none;background:none;color:var(--dsho-brand);font-size:11px;cursor:pointer;padding:0}
.dsho-detail{margin-top:2px;padding:8px 10px;background:var(--dsw-alias-bg-layer-3);border-radius:8px;font-size:12px;color:var(--dsw-alias-label-secondary);line-height:1.6;max-height:220px;overflow:auto;display:flex;flex-direction:column;gap:6px}
.dsho-detailSec b{color:var(--dsw-alias-label-primary);font-weight:600}
.dsho-arts{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
.dsho-art{display:inline-flex;align-items:center;gap:5px;border:.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1,#fff);border-radius:6px;padding:3px 8px;font-size:11px;color:var(--dsho-brand);cursor:pointer}
.dsho-art:hover{background:color-mix(in srgb,var(--dsho-brand) 8%,transparent)}
.dsho-art svg{width:12px;height:12px}
.dsho-taskFoot{display:flex;gap:10px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.dsho-dur{font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.dsho-dur-live{color:var(--dsho-pos-ink);font-weight:600}
.dsho-toast{position:sticky;bottom:12px;left:0;right:0;margin:8px auto 0;width:fit-content;max-width:90%;background:#1f2329;color:#fff;font-size:12px;padding:6px 14px;border-radius:999px;box-shadow:0 4px 14px rgb(0 0 0 / 18%);z-index:5;animation:dsho-toast-in .18s ease}
@keyframes dsho-toast-in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
.dsho-error{color:var(--dsw-alias-label-error,#d93025)}
.dsho-blocked{color:#a35200}

.dsho-steps{list-style:none;margin:6px 0 0;padding:6px 10px;border:.5px solid var(--dsw-alias-border-l4);border-radius:8px;background:var(--dsw-alias-bg-layer-3);display:inline-block;min-width:220px;max-width:100%}
.dsho-steps li{display:flex;align-items:center;gap:7px;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary)}
.dsho-steps li.dsho-step-in_progress{color:var(--dsw-alias-label-primary);font-weight:500}
.dsho-steps li.dsho-step-completed{color:var(--dsw-alias-label-tertiary)}
.dsho-stepIcon{flex:none;width:14px;height:14px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:10px;border:1.5px solid var(--dsw-alias-border-l4)}
.dsho-step-completed .dsho-stepIcon{background:color-mix(in srgb,var(--dsho-pos) 15%,transparent);color:var(--dsho-pos-ink);border-color:transparent}
.dsho-step-in_progress .dsho-stepIcon{background:color-mix(in srgb,var(--dsho-brand) 15%,transparent);color:var(--dsho-brand-ink);border-color:transparent;animation:dsho-pulse 1.5s ease-in-out infinite}
`
export function adoptStyles(): void {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return
  const tag = document.createElement('style')
  tag.id = STYLE_ID
  tag.textContent = CSS
  document.head.appendChild(tag)
}
