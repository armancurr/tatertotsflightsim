/**
 * The HUD's stylesheet (CSS-in-TS, system fonts only — nothing loads from the
 * network). Sizes that depend on the viewport come from CSS variables set by
 * hud.ts (--fsh-fs = base font size in px).
 */

import { CONTROLS_CSS } from './controls';

export const HUD_STYLE_ID = 'fsh-style';

export const HUD_CSS = `
.fsh-root {
  position: fixed; inset: 0; z-index: 20; overflow: hidden;
  pointer-events: none; user-select: none; -webkit-user-select: none;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  font-size: var(--fsh-fs, 13px); color: #eef3fa;
  -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  --fsh-glass-bg: linear-gradient(180deg, rgba(22,28,38,0.50), rgba(8,11,17,0.62));
  --fsh-glass-border: rgba(255,255,255,0.10);
}
.fsh-root * { pointer-events: none; box-sizing: border-box; }
.fsh-root [hidden] { display: none !important; }
.fsh-glass {
  position: absolute;
  background: var(--fsh-glass-bg);
  border: 1px solid var(--fsh-glass-border);
  border-radius: 14px;
  box-shadow: 0 10px 28px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.07);
  backdrop-filter: blur(9px) saturate(1.25);
  -webkit-backdrop-filter: blur(9px) saturate(1.25);
}
.fsh-root canvas { position: absolute; display: block; }
.fsh-jet { position: absolute; }
.fsh-cluster { border-radius: 16px; }
.fsh-compass { border-radius: 12px; }
.fsh-strip { border-radius: 12px; }
.fsh-chip {
  position: absolute; display: flex; align-items: center; gap: 0.55em;
  height: 24px; padding: 0 10px; border-radius: 8px;
  font: 600 11px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  letter-spacing: 0.04em; color: rgba(226,234,244,0.86); white-space: nowrap;
}
.fsh-chip .fsh-sep { opacity: 0.35; }
.fsh-chip .fsh-fps-good { color: #7dffa0; }
.fsh-chip .fsh-fps-ok { color: #ffd27a; }
.fsh-chip .fsh-fps-bad { color: #ff8a7e; }
.fsh-chip .fsh-yoke { color: #8fd3ff; }

.fsh-anns {
  position: absolute; left: 0; right: 0; display: flex; justify-content: center; gap: 8px; flex-wrap: wrap;
}
.fsh-ann {
  padding: 0.42em 0.95em; border-radius: 6px;
  font-weight: 800; font-size: 1em; letter-spacing: 0.14em; line-height: 1;
  border: 1px solid rgba(0,0,0,0.35);
  transition: opacity 0.08s linear;
}
.fsh-ann.fsh-warning { background: linear-gradient(180deg, #f0443a, #b8160d); color: #fff; box-shadow: 0 0 22px rgba(255,50,35,0.55), inset 0 1px 0 rgba(255,255,255,0.35); text-shadow: 0 1px 0 rgba(0,0,0,0.35); }
.fsh-ann.fsh-caution { background: linear-gradient(180deg, #ffc043, #e08a0b); color: #231400; box-shadow: 0 0 16px rgba(255,170,40,0.35), inset 0 1px 0 rgba(255,255,255,0.4); }
.fsh-ann.fsh-dim { opacity: 0.28; }
.fsh-ann[data-ann="stall"] { font-size: 1.35em; padding: 0.38em 1.1em; }

.fsh-paused {
  position: absolute; left: 50%; transform: translateX(-50%);
  padding: 0.55em 1.4em; border-radius: 10px; text-align: center;
  font-weight: 800; font-size: 1.35em; letter-spacing: 0.28em;
}
.fsh-paused small { display: block; margin-top: 0.35em; font-size: 0.55em; font-weight: 600; letter-spacing: 0.08em; opacity: 0.7; }

.fsh-banner {
  position: absolute; left: 50%; transform: translateX(-50%);
  max-width: calc(100vw - 32px); padding: 0.8em 1.8em 0.75em; text-align: center; border-radius: 12px;
  --fsh-glass-bg: linear-gradient(180deg, rgba(120,16,10,0.72), rgba(60,6,4,0.78));
  --fsh-glass-border: rgba(255,120,100,0.45);
}
.fsh-banner .fsh-title { font-weight: 800; font-size: 1.9em; letter-spacing: 0.06em; line-height: 1.1; }
.fsh-banner .fsh-sub { margin-top: 0.45em; font-size: 0.95em; font-weight: 600; color: rgba(255,225,220,0.85); letter-spacing: 0.05em; }

.fsh-toasts {
  position: absolute; left: 0; right: 0; display: flex; flex-direction: column-reverse; align-items: center; gap: 6px;
}
.fsh-toast, .fsh-hint {
  position: relative; padding: 0.5em 1.05em; border-radius: 9px;
  font-weight: 700; font-size: 1em; letter-spacing: 0.03em; white-space: nowrap;
  animation: fsh-in 0.25s ease-out both;
  transition: opacity 0.4s ease, transform 0.4s ease;
}
.fsh-toast.fsh-good { --fsh-glass-border: rgba(90,230,130,0.55); color: #c9ffd8; }
.fsh-toast.fsh-warn { --fsh-glass-border: rgba(255,170,60,0.6); color: #ffe2b0; }
.fsh-toast.fsh-landing { font-size: 1.15em; }
.fsh-toast.fsh-out, .fsh-hint.fsh-out { opacity: 0; transform: translateY(6px); }
.fsh-hint { font-weight: 600; color: rgba(230,238,248,0.9); }
.fsh-hint kbd, .fsh-help kbd {
  display: inline-block; min-width: 1.7em; padding: 0.18em 0.45em; margin: 0 0.1em;
  border-radius: 5px; text-align: center;
  font: 700 0.86em/1.2 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-bottom-width: 2px;
  color: #fff;
}
@keyframes fsh-in { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: none; } }

.fsh-help {
  left: 50%; top: calc(50% + 24px); transform: translate(-50%, -50%);
  width: min(780px, calc(100vw - 32px)); max-height: calc(100vh - 64px); overflow: auto;
  padding: 20px 24px 22px; border-radius: 16px;
  --fsh-glass-bg: linear-gradient(180deg, rgba(16,22,32,0.86), rgba(6,9,14,0.9));
  font-size: 13px;
}
.fsh-help-head { display: flex; align-items: baseline; justify-content: space-between; gap: 16px; margin-bottom: 12px; }
.fsh-help-head h2 { margin: 0; font-size: 20px; font-weight: 800; letter-spacing: 0.02em; }
.fsh-help-head span { font-size: 12px; opacity: 0.6; }
.fsh-help-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 28px; }
.fsh-help h3 { margin: 0 0 6px; font-size: 11px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; color: #8fd3ff; }
.fsh-help-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 4px 0; border-top: 1px solid rgba(255,255,255,0.06); }
.fsh-help-action { opacity: 0.88; }
.fsh-help-keys { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 3px; align-items: center; }
.fsh-help-sep { opacity: 0.45; margin: 0 2px; }
@media (max-width: 700px) { .fsh-help-grid { grid-template-columns: 1fr; } }
${CONTROLS_CSS}
`;

const users = new WeakMap<Document, number>();

/** Add the stylesheet once per document (reference-counted with removeHudStyle). */
export function installHudStyle(doc: Document): void {
  users.set(doc, (users.get(doc) ?? 0) + 1);
  if (doc.getElementById(HUD_STYLE_ID)) return;
  const el = doc.createElement('style');
  el.id = HUD_STYLE_ID;
  el.textContent = HUD_CSS;
  doc.head.appendChild(el);
}

export function removeHudStyle(doc: Document): void {
  const n = (users.get(doc) ?? 1) - 1;
  users.set(doc, Math.max(0, n));
  if (n <= 0) doc.getElementById(HUD_STYLE_ID)?.remove();
}
