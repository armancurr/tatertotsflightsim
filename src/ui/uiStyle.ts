/**
 * Stylesheet of the app chrome (top bar, aircraft picker, pause menu): CSS-in-TS with system fonts
 * only — nothing is fetched. Warm "tater gold" on dark glass, the mascot's cape red as the accent.
 * Reference-counted like the HUD's stylesheet.
 */
import { CONTROLS_CSS } from './controls';

export const UI_STYLE_ID = 'tfs-style';

export const UI_CSS = `
.tfs-root {
  position: fixed; inset: 0; z-index: 30; pointer-events: none; user-select: none; -webkit-user-select: none;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  color: #f4f1ea; -webkit-font-smoothing: antialiased;
  --tfs-gold: #ffc15c; --tfs-gold-2: #f29a2e; --tfs-red: #e8392f; --tfs-cream: #fff4e0;
  --tfs-glass: linear-gradient(180deg, rgba(20,26,38,0.93), rgba(9,12,19,0.95));
  --tfs-line: rgba(255,255,255,0.1);
}
.tfs-root [hidden] { display: none !important; }
.tfs-root button { font: inherit; color: inherit; cursor: pointer; }
.tfs-root button:focus { outline: none; }
.tfs-root button:focus-visible, .tfs-picker-list:focus-visible { outline: 2px solid var(--tfs-gold); outline-offset: 2px; }

/* ── Top bar ─────────────────────────────────────────────────────────── */
.tfs-topbar {
  position: absolute; left: 0; right: 0; top: 0; height: var(--tfs-bar-h, 40px);
  display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 10px 0 8px;
  background: linear-gradient(180deg, rgba(15,20,30,0.80), rgba(8,11,18,0.70));
  border-bottom: 1px solid rgba(255,255,255,0.07);
  box-shadow: 0 6px 20px rgba(0,0,0,0.22);
  backdrop-filter: blur(10px) saturate(1.3); -webkit-backdrop-filter: blur(10px) saturate(1.3);
}
.tfs-topbar::after {
  content: ""; position: absolute; left: 0; right: 0; bottom: -1px; height: 1px;
  background: linear-gradient(90deg, rgba(255,193,92,0.85), rgba(232,57,47,0.65) 22%, rgba(232,57,47,0) 55%);
}
.tfs-brand { display: flex; align-items: center; gap: 7px; min-width: 0; }
.tfs-brand svg { height: calc(var(--tfs-bar-h, 40px) * 0.78); width: auto; flex: none; filter: drop-shadow(0 2px 3px rgba(0,0,0,0.35)); }
.tfs-name { font-size: calc(var(--tfs-bar-h, 40px) * 0.4); font-weight: 800; letter-spacing: 0.01em; white-space: nowrap; line-height: 1; color: var(--tfs-cream); }
.tfs-name-a { background: linear-gradient(180deg, #ffe09a, var(--tfs-gold) 45%, var(--tfs-gold-2)); -webkit-background-clip: text; background-clip: text; color: transparent; }
.tfs-name small { margin-left: 8px; font-size: 0.62em; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255,244,224,0.45); }
.tfs-actions { display: flex; align-items: center; gap: 8px; }
.tfs-menu-btn, .tfs-picker-button {
  pointer-events: auto; height: calc(var(--tfs-bar-h, 40px) - 12px); border-radius: 8px;
  background: rgba(255,255,255,0.07); border: 1px solid rgba(255,255,255,0.14);
  transition: background 0.15s ease, border-color 0.15s ease;
}
.tfs-menu-btn:hover, .tfs-picker-button:hover, .tfs-open .tfs-picker-button { background: rgba(255,255,255,0.14); border-color: rgba(255,193,92,0.45); }
.tfs-menu-btn { width: calc(var(--tfs-bar-h, 40px) - 6px); display: grid; place-items: center; padding: 0; }
.tfs-menu-btn svg { width: 16px; height: 16px; }

/* ── Aircraft picker ─────────────────────────────────────────────────── */
.tfs-picker { position: relative; }
.tfs-picker-button { display: flex; align-items: center; gap: 7px; padding: 0 10px 0 9px; font-size: 13px; font-weight: 650; white-space: nowrap; }
.tfs-picker-icon { width: 15px; height: 15px; color: var(--tfs-gold); transform: rotate(45deg); }
.tfs-chevron { width: 11px; height: 11px; opacity: 0.7; transition: transform 0.15s ease; }
.tfs-open .tfs-chevron { transform: rotate(180deg); }
.tfs-picker-list {
  position: absolute; right: 0; top: calc(100% + 7px); width: min(320px, calc(100vw - 24px)); margin: 0; padding: 6px; list-style: none;
  background: var(--tfs-glass); border: 1px solid var(--tfs-line); border-radius: 12px;
  box-shadow: 0 16px 40px rgba(0,0,0,0.45); pointer-events: auto;
  animation: tfs-pop 0.14s ease-out both;
}
.tfs-picker-list [role="option"] { position: relative; display: block; padding: 9px 30px 9px 11px; border-radius: 8px; cursor: pointer; }
.tfs-picker-list [role="option"].tfs-active { background: rgba(255,193,92,0.13); }
.tfs-picker-list [role="option"][aria-selected="true"]::after { content: "✓"; position: absolute; right: 11px; top: 9px; color: var(--tfs-gold); font-weight: 800; }
.tfs-opt-name { display: block; font-size: 13.5px; font-weight: 700; }
.tfs-picker-list .tfs-picker-group { margin: 6px 4px 2px; padding: 6px 7px 2px; border-top: 1px solid rgba(255,255,255,0.09); font-size: 10.5px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; color: rgba(143,211,255,0.85); cursor: default; }
.tfs-card .tfs-tag { display: inline-block; margin-left: 7px; padding: 1px 6px; border-radius: 5px; font-size: 10px; font-weight: 800; font-style: normal; letter-spacing: 0.1em; vertical-align: 2px; color: #bfeaff; background: rgba(57,198,255,0.16); border: 1px solid rgba(111,211,255,0.4); }
.tfs-opt-desc { display: block; margin-top: 2px; font-size: 11.5px; line-height: 1.35; color: rgba(244,241,234,0.68); }
@keyframes tfs-pop { from { opacity: 0; transform: translateY(-4px) scale(0.98); } to { opacity: 1; transform: none; } }

/* ── Pause menu ──────────────────────────────────────────────────────── */
.tfs-backdrop { position: fixed; inset: 0; pointer-events: none; background: radial-gradient(120% 90% at 50% 45%, rgba(4,7,12,0.28), rgba(4,7,12,0.62)); animation: tfs-fade 0.18s ease-out both; }
.tfs-panel {
  position: fixed; left: 50%; top: calc(50% + var(--tfs-bar-h, 40px) / 2); transform: translate(-50%, -50%);
  width: min(700px, calc(100vw - 32px)); max-height: calc(100vh - var(--tfs-bar-h, 40px) - 28px); overflow: auto;
  padding: 20px 22px 18px; border-radius: 18px; pointer-events: auto; user-select: text;
  background: var(--tfs-glass); border: 1px solid var(--tfs-line);
  box-shadow: 0 30px 80px rgba(0,0,0,0.55), inset 0 1px 0 rgba(255,255,255,0.06);
  animation: tfs-in 0.2s cubic-bezier(0.2, 0.8, 0.3, 1) both;
}
@keyframes tfs-in { from { opacity: 0; transform: translate(-50%, calc(-50% + 10px)) scale(0.98); } to { opacity: 1; transform: translate(-50%, -50%); } }
@keyframes tfs-fade { from { opacity: 0; } to { opacity: 1; } }
.tfs-head { display: flex; align-items: center; gap: 12px; margin-bottom: 16px; }
.tfs-head svg { width: 64px; height: auto; flex: none; filter: drop-shadow(0 4px 8px rgba(0,0,0,0.4)); }
.tfs-head h2 { margin: 0; font-size: 22px; font-weight: 850; letter-spacing: 0.005em; line-height: 1.1; }
.tfs-head p { margin: 3px 0 0; font-size: 12px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255,244,224,0.5); }
.tfs-head .tfs-paused { margin-left: auto; align-self: flex-start; padding: 4px 9px; border-radius: 6px; font-size: 11px; font-weight: 800; letter-spacing: 0.18em; color: #1a1206; background: var(--tfs-gold); }
.tfs-close { align-self: flex-start; width: 30px; height: 30px; border-radius: 8px; border: 1px solid var(--tfs-line); background: rgba(255,255,255,0.05); font-size: 14px; line-height: 1; }
.tfs-close:hover { background: rgba(255,255,255,0.12); }
.tfs-primary { display: grid; grid-template-columns: 1.1fr 1fr 1fr; gap: 10px; }
.tfs-btn {
  display: flex; align-items: center; justify-content: center; gap: 8px; min-height: 44px; padding: 8px 12px; border-radius: 11px;
  border: 1px solid rgba(255,255,255,0.13); background: rgba(255,255,255,0.06); font-size: 14px; font-weight: 700;
  transition: background 0.15s ease, border-color 0.15s ease, transform 0.08s ease;
}
.tfs-btn:hover { background: rgba(255,255,255,0.12); border-color: rgba(255,193,92,0.4); }
.tfs-btn:active { transform: translateY(1px); }
.tfs-btn svg { width: 16px; height: 16px; flex: none; }
.tfs-btn.tfs-go { background: linear-gradient(180deg, #ffd27e, var(--tfs-gold) 50%, var(--tfs-gold-2)); color: #231503; border-color: rgba(0,0,0,0.25); box-shadow: 0 6px 18px rgba(242,154,46,0.28), inset 0 1px 0 rgba(255,255,255,0.5); }
.tfs-btn.tfs-go:hover { filter: brightness(1.06); }
.tfs-section { margin-top: 18px; }
.tfs-section h3 { margin: 0 0 8px; font-size: 11px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; color: var(--tfs-gold); }
.tfs-cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
.tfs-card {
  position: relative; display: block; text-align: left; padding: 11px 36px 11px 13px; border-radius: 12px;
  border: 1px solid rgba(255,255,255,0.12); background: rgba(255,255,255,0.045);
  transition: background 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}
.tfs-card:hover { background: rgba(255,255,255,0.09); }
.tfs-card[aria-checked="true"] { border-color: rgba(255,193,92,0.75); background: rgba(255,193,92,0.09); box-shadow: 0 0 0 1px rgba(255,193,92,0.35), 0 8px 24px rgba(242,154,46,0.12); }
.tfs-card[aria-checked="true"]::after { content: "✓"; position: absolute; right: 13px; top: 11px; font-weight: 800; color: var(--tfs-gold); }
.tfs-card b { display: block; font-size: 14px; font-weight: 750; }
.tfs-card span { display: block; margin-top: 3px; font-size: 12px; line-height: 1.4; color: rgba(244,241,234,0.66); }
.tfs-settings { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 22px; }
.tfs-setting { display: flex; flex-direction: column; gap: 6px; min-width: 0; }
.tfs-setting > label, .tfs-setting > .tfs-label { font-size: 12px; font-weight: 650; color: rgba(244,241,234,0.72); }
.tfs-seg { display: flex; padding: 3px; gap: 3px; border-radius: 10px; background: rgba(0,0,0,0.28); border: 1px solid rgba(255,255,255,0.08); }
.tfs-seg button { flex: 1 1 auto; min-width: 0; padding: 6px 7px; border: 0; border-radius: 7px; background: transparent; font-size: 12.5px; font-weight: 650; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: rgba(244,241,234,0.8); }
.tfs-seg button:hover { background: rgba(255,255,255,0.08); }
.tfs-seg button[aria-pressed="true"] { background: var(--tfs-gold); color: #211404; box-shadow: 0 2px 8px rgba(242,154,46,0.35); }
.tfs-switch { display: inline-flex; align-items: center; gap: 10px; align-self: flex-start; padding: 3px 12px 3px 3px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.12); background: rgba(0,0,0,0.28); font-size: 12.5px; font-weight: 700; }
.tfs-switch i { position: relative; width: 38px; height: 22px; border-radius: 999px; background: rgba(255,255,255,0.18); transition: background 0.15s ease; }
.tfs-switch i::after { content: ""; position: absolute; left: 3px; top: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.4); transition: transform 0.15s ease; }
.tfs-switch[aria-checked="true"] i { background: #3fbf6a; }
.tfs-switch[aria-checked="true"] i::after { transform: translateX(16px); }
.tfs-foot { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-top: 18px; padding-top: 14px; border-top: 1px solid var(--tfs-line); }
.tfs-foot .tfs-btn { min-height: 36px; font-size: 13px; }
.tfs-hint { font-size: 12px; color: rgba(244,241,234,0.55); }
.tfs-hint kbd { font: 700 11px/1 ui-monospace, "SF Mono", Menlo, Consolas, monospace; padding: 2px 5px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.2); background: rgba(255,255,255,0.08); color: #fff; }
.tfs-view-head { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.tfs-view-head h2 { margin: 0; font-size: 19px; font-weight: 800; }
.tfs-view-head .tfs-btn { min-height: 32px; padding: 4px 12px; font-size: 13px; }
@media (max-width: 640px) { .tfs-primary { grid-template-columns: 1fr; } .tfs-settings { grid-template-columns: 1fr; } .tfs-name small { display: none; } }
@media (max-height: 760px) { .tfs-panel { padding: 16px 18px 14px; } .tfs-head { margin-bottom: 10px; } .tfs-head svg { width: 48px; } .tfs-section { margin-top: 12px; } .tfs-foot { margin-top: 12px; padding-top: 10px; } }
@media (prefers-reduced-motion: reduce) { .tfs-panel, .tfs-backdrop, .tfs-picker-list { animation: none; } }
${CONTROLS_CSS}
`;

const users = new WeakMap<Document, number>();

export function installUiStyle(doc: Document): void {
  users.set(doc, (users.get(doc) ?? 0) + 1);
  if (doc.getElementById(UI_STYLE_ID)) return;
  const el = doc.createElement('style');
  el.id = UI_STYLE_ID;
  el.textContent = UI_CSS;
  doc.head.appendChild(el);
}

export function removeUiStyle(doc: Document): void {
  const n = (users.get(doc) ?? 1) - 1;
  users.set(doc, Math.max(0, n));
  if (n <= 0) doc.getElementById(UI_STYLE_ID)?.remove();
}
