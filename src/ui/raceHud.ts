/**
 * The race lap-timer panel (jet-ski course): shown while a vessel is on or near the course, styled
 * like the marine helm HUD (dark glass, rounded, cyan caps labels, SF numerals). Top-left, under
 * the FPS/camera chip — clear of the compass tape (top centre), the annunciators under it and the
 * helm blocks in the bottom corners.
 *
 *   TATER BEACH PWC · LAP 3                  (status: CROSS THE START / RACING / INVALID)
 *   1:12.4                                   current lap
 *   LAST 1:43.21   BEST 1:39.80
 *   SPLIT T3  +0.42                          split vs best at the last mark (green = ahead)
 *   ● ● ● ○ ○ ○ …                            marks: rounded / missed / next
 *   ➤ NEXT T4 · keep it to port · 180 m      the arrow points at it, relative to the bow
 *
 * `raceHudView` (tracker + craft pose → strings, pure), `formatLapTime`, `formatSplit`,
 * `relativeBearing` and `raceHudRect` are pure and tested; `createRaceHud` writes the DOM only when
 * a string changed.
 */
import { CONFIG, type Config } from '../config';
import { computeHudLayout, type Rect } from './hud';
import { nextMark, type RaceTracker } from '../world/offshore/raceCourse';

const FONT = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", "Helvetica Neue", Arial, sans-serif';
const NUM_FONT = '"SF Pro Display", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif';

/** "1:23.45" (minutes:seconds.hundredths); "—" for none. `digits` = decimals (1 or 2). */
export function formatLapTime(s: number, digits = 2): string {
  if (!Number.isFinite(s) || s < 0) return '—';
  const k = 10 ** digits;
  // round once, in whole units, then split: 59.996 s → 1:00.00 (never "0:60.00")
  const total = Math.round(Math.min(s, 5999.99) * k);
  const m = Math.floor(total / (60 * k));
  const sec = (total - m * 60 * k) / k;
  const txt = sec.toFixed(digits);
  return `${Math.min(m, 99)}:${sec < 10 ? '0' : ''}${txt}`;
}

/** "+0.42" / "−1.20" / "±0.00"; "" for none. */
export function formatSplit(d: number): string {
  if (!Number.isFinite(d)) return '';
  const a = Math.min(Math.abs(d), 999.99).toFixed(2);
  if (a === '0.00') return '±0.00';
  return d < 0 ? `−${a}` : `+${a}`;
}

/** Bearing of (tx, tz) from (x, z) relative to the heading (deg, −180 … 180, + = to starboard). */
export function relativeBearing(x: number, z: number, headingDeg: number, tx: number, tz: number): number {
  const brg = (Math.atan2(tx - x, -(tz - z)) * 180) / Math.PI;
  let r = brg - headingDeg;
  if (!Number.isFinite(r)) return 0;
  r = ((r % 360) + 540) % 360 - 180;
  return r === -180 ? 180 : r;
}

export interface RaceHudView {
  title: string;
  status: string;
  statusTone: 'idle' | 'racing' | 'bad' | 'good';
  current: string;
  last: string;
  lastInvalid: boolean;
  best: string;
  splitLabel: string;
  split: string;
  splitTone: 'ahead' | 'behind' | 'none';
  /** Per mark (course order, skipping the gate): 'done' | 'missed' | 'next' | 'todo'. */
  dots: ('done' | 'missed' | 'next' | 'todo')[];
  nextLabel: string;
  nextDetail: string;
  /** Relative bearing of the next mark, deg (+ starboard). */
  arrowDeg: number;
}

/** The panel's contents for a tracker, the craft's pose and the clock (pure). */
export function raceHudView(t: RaceTracker, x: number, z: number, headingDeg: number, time: number): RaceHudView {
  const c = t.course;
  const n = c.marks.length;
  const racing = t.phase === 'racing';
  const m = nextMark(t);
  const dist = Math.hypot(m.x - x, m.z - z);
  const dots: RaceHudView['dots'] = [];
  for (let i = 1; i < n; i++) {
    if (!racing) dots.push('todo');
    else if (Number.isFinite(t.splits[i])) dots.push('done');
    else if (i === t.next) dots.push('next');
    else if (t.next === 0 || i < t.next) dots.push('missed');
    else dots.push('todo');
  }
  const split = racing ? t.delta : NaN;
  let lastSplitMark = '';
  if (racing) {
    for (let i = 1; i < n; i++) if (Number.isFinite(t.splits[i])) lastSplitMark = c.marks[i].id;
  }
  const status = !racing ? 'CROSS THE START' : t.penalties > 0 ? `MISSED ${t.penalties} · LAP WON'T COUNT` : 'RACING';
  const statusTone: RaceHudView['statusTone'] = !racing ? 'idle' : t.penalties > 0 ? 'bad' : 'racing';
  const side = m.kind === 'gate' ? 'through the arch' : m.side === 'port' ? 'keep it to port' : 'keep it to starboard';
  const d = dist < 1000 ? `${Math.round(dist / 5) * 5} m` : `${(dist / 1000).toFixed(1)} km`;
  return {
    title: `${c.name.toUpperCase()}${racing ? ` · LAP ${t.lap}` : ''}`,
    status,
    statusTone,
    current: racing ? formatLapTime(time - t.lapStart, 1) : formatLapTime(0, 1),
    last: formatLapTime(t.last),
    lastInvalid: Number.isFinite(t.last) && !t.lastValid,
    best: formatLapTime(t.best),
    splitLabel: Number.isFinite(split) ? `SPLIT ${lastSplitMark}` : 'SPLIT',
    split: formatSplit(split) || '—',
    splitTone: !Number.isFinite(split) ? 'none' : split <= 0 ? 'ahead' : 'behind',
    dots,
    nextLabel: m.kind === 'gate' ? (racing ? 'FINISH' : 'START') : m.id,
    nextDetail: `${side} · ${d}`,
    arrowDeg: Math.round(relativeBearing(x, z, headingDeg, m.x, m.z)),
  };
}

/** The panel's rectangle (CSS px) for a viewport: top-left, under the HUD's chip. */
export function raceHudRect(width: number, height: number, cfg: Config = CONFIG): Rect {
  const w = Number.isFinite(width) && width > 0 ? width : 1024;
  const h = Number.isFinite(height) && height > 0 ? height : 768;
  const L = computeHudLayout(w, h, cfg, 'normal', 'marine');
  const pw = Math.round(Math.min(Math.max(w * 0.2, 232), 300, L.compass.x - 2 * L.margin));
  const y = L.chip.y + L.chip.h + 10;
  const ph = Math.round(Math.min(188, Math.max(150, h * 0.2)));
  return { x: L.margin, y, w: Math.max(0, pw), h: ph };
}

const CSS = `
.frh-root { position: fixed; z-index: 18; pointer-events: none; font-family: ${FONT}; color: #eef4fb;
  background: linear-gradient(180deg, rgba(22,28,38,0.50), rgba(8,11,17,0.62)); border: 1px solid rgba(255,255,255,0.10);
  border-radius: 14px; box-shadow: 0 10px 28px rgba(0,0,0,0.32), inset 0 1px 0 rgba(255,255,255,0.07);
  backdrop-filter: blur(9px) saturate(1.25); -webkit-backdrop-filter: blur(9px) saturate(1.25);
  padding: 10px 12px 10px; box-sizing: border-box; overflow: hidden; line-height: 1.15; }
.frh-root[hidden] { display: none !important; }
.frh-top { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.frh-title { font-size: 10.5px; font-weight: 700; letter-spacing: 0.08em; color: #6fd3ff; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.frh-status { font-size: 10px; font-weight: 800; letter-spacing: 0.06em; white-space: nowrap; }
.frh-status.idle { color: rgba(214,226,240,0.62); } .frh-status.racing { color: #4fe08a; } .frh-status.bad { color: #ff4b4b; } .frh-status.good { color: #4fe08a; }
.frh-cur { font-family: ${NUM_FONT}; font-weight: 700; font-size: 34px; letter-spacing: 0.01em; margin: 4px 0 4px; font-variant-numeric: tabular-nums; }
.frh-row { display: flex; gap: 14px; font-size: 13px; font-variant-numeric: tabular-nums; }
.frh-row b { font-size: 9.5px; font-weight: 700; color: #6fd3ff; letter-spacing: 0.08em; margin-right: 5px; }
.frh-inv { color: #ffb347; font-size: 9.5px; font-weight: 800; margin-left: 4px; }
.frh-split { font-family: ${NUM_FONT}; font-weight: 700; font-size: 15px; margin-top: 5px; min-height: 18px; font-variant-numeric: tabular-nums; color: rgba(214,226,240,0.62); }
.frh-split.ahead { color: #4fe08a; } .frh-split.behind { color: #ff6b5b; }
.frh-split small { font-size: 10px; color: rgba(214,226,240,0.62); font-weight: 700; margin-right: 6px; letter-spacing: 0.06em; }
.frh-dots { display: flex; gap: 4px; margin: 6px 0 6px; }
.frh-dot { width: 9px; height: 9px; border-radius: 50%; background: rgba(255,255,255,0.14); border: 1px solid rgba(255,255,255,0.18); box-sizing: border-box; }
.frh-dot.done { background: #4fe08a; border-color: #4fe08a; } .frh-dot.missed { background: #ff4b4b; border-color: #ff4b4b; }
.frh-dot.next { background: transparent; border: 2px solid #39c6ff; }
.frh-next { display: flex; align-items: center; gap: 8px; font-size: 12px; }
.frh-arrow { width: 22px; height: 22px; flex: 0 0 22px; }
.frh-next b { font-weight: 800; color: #eef4fb; letter-spacing: 0.04em; }
.frh-next span { color: rgba(214,226,240,0.75); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
`;

export interface RaceHud {
  root: HTMLElement;
  update(v: RaceHudView): void;
  setVisible(on: boolean): void;
  readonly visible: boolean;
  layout(width: number, height: number): void;
  dispose(): void;
}

/** The panel's DOM (under `parent`); `update` is cheap when nothing changed. */
export function createRaceHud(parent: HTMLElement, cfg: Config = CONFIG): RaceHud {
  const doc = parent.ownerDocument ?? document;
  let style = doc.getElementById('frh-style') as HTMLStyleElement | null;
  if (!style) {
    style = doc.createElement('style');
    style.id = 'frh-style';
    style.textContent = CSS;
    doc.head.appendChild(style);
  }
  const el = (tag: string, cls: string, into: HTMLElement): HTMLElement => {
    const e = doc.createElement(tag);
    e.className = cls;
    into.appendChild(e);
    return e;
  };
  const root = doc.createElement('div');
  root.className = 'frh-root';
  root.setAttribute('data-hud', 'race');
  root.setAttribute('aria-hidden', 'true');
  root.hidden = true;
  const top = el('div', 'frh-top', root);
  const title = el('div', 'frh-title', top);
  const status = el('div', 'frh-status idle', top);
  const cur = el('div', 'frh-cur', root);
  const row = el('div', 'frh-row', root);
  const lastBox = el('span', '', row);
  const bestBox = el('span', '', row);
  const split = el('div', 'frh-split', root);
  const dotsBox = el('div', 'frh-dots', root);
  const next = el('div', 'frh-next', root);
  const svgNS = 'http://www.w3.org/2000/svg';
  const arrow = doc.createElementNS(svgNS, 'svg') as unknown as HTMLElement;
  arrow.setAttribute('class', 'frh-arrow');
  arrow.setAttribute('viewBox', '-12 -12 24 24');
  const path = doc.createElementNS(svgNS, 'path');
  path.setAttribute('d', 'M0,-10 L7,8 L0,4 L-7,8 Z');
  path.setAttribute('fill', '#39c6ff');
  arrow.appendChild(path);
  next.appendChild(arrow);
  const nextText = el('div', '', next);
  parent.appendChild(root);

  const last: Record<string, string> = {};
  const set = (key: string, e: HTMLElement | Element, html: string, asHtml = false) => {
    if (last[key] === html) return;
    last[key] = html;
    if (asHtml) (e as HTMLElement).innerHTML = html;
    else e.textContent = html;
  };
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  let visible = false;
  const api: RaceHud = {
    root,
    get visible() {
      return visible;
    },
    update(v) {
      set('title', title, v.title);
      set('status', status, v.status);
      if (last.tone !== v.statusTone) {
        last.tone = v.statusTone;
        status.className = `frh-status ${v.statusTone}`;
      }
      set('cur', cur, v.current);
      set('last', lastBox, `<b>LAST</b>${esc(v.last)}${v.lastInvalid ? '<i class="frh-inv">INVALID</i>' : ''}`, true);
      set('best', bestBox, `<b>BEST</b>${esc(v.best)}`, true);
      set('split', split, `<small>${esc(v.splitLabel)}</small>${esc(v.split)}`, true);
      if (last.splitTone !== v.splitTone) {
        last.splitTone = v.splitTone;
        split.className = `frh-split ${v.splitTone === 'none' ? '' : v.splitTone}`;
      }
      const dk = v.dots.join(',');
      if (last.dots !== dk) {
        last.dots = dk;
        while (dotsBox.childElementCount > v.dots.length) dotsBox.lastElementChild!.remove();
        while (dotsBox.childElementCount < v.dots.length) el('div', 'frh-dot', dotsBox);
        v.dots.forEach((d, i) => ((dotsBox.children[i] as HTMLElement).className = `frh-dot ${d}`));
      }
      set('next', nextText, `<b>${esc(v.nextLabel)}</b> <span>${esc(v.nextDetail)}</span>`, true);
      const a = String(v.arrowDeg);
      if (last.arrow !== a) {
        last.arrow = a;
        arrow.style.transform = `rotate(${v.arrowDeg}deg)`;
      }
    },
    setVisible(on) {
      if (on === visible) return;
      visible = on;
      root.hidden = !on;
    },
    layout(width, height) {
      const r = raceHudRect(width, height, cfg);
      root.style.left = `${r.x}px`;
      root.style.top = `${r.y}px`;
      root.style.width = `${r.w}px`;
      root.style.minHeight = `${r.h}px`;
    },
    dispose() {
      root.remove();
    },
  };
  return api;
}
