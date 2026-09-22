/**
 * The start-up loading veil: a full-screen title card ("Flight Simulator", a
 * Cessna 172RG silhouette, a progress bar and what is being prepared) that
 * hides the start-up hitch — the aircraft build, the first terrain tiles,
 * shader compiles — and then fades to the aircraft on the runway. It fades by
 * itself once frames run smoothly (+ config.hud.veil.autoDismissS), or at once
 * on the first key/click ("Click or press any key to start" — the gesture that
 * also unlocks audio). Keys are never swallowed: the simulator still gets them.
 *
 *   createVeilModel/veilMark/veilFrame/veilTick/veilGesture — PURE state machine
 *   createLoadingVeil(document) — the DOM (no <canvas>: the e2e tests measure the
 *     largest canvas as the 3D view), driven by the model.
 *   veilActive() — whether a veil still covers the screen (the HUD's start hint waits).
 */
import { CONFIG, type Config } from '../config';

export type VeilPhase = 'loading' | 'ready' | 'fading' | 'gone';

/** Loading stages: 0 boot (module load) · 1 aircraft + renderer built · 2 world systems streaming · 3 first frame · 4 smooth. */
export const VEIL_STAGES: readonly { target: number; status: string }[] = [
  { target: 0.12, status: 'Building the aircraft' },
  { target: 0.4, status: 'Shaping the world' },
  { target: 0.68, status: 'Streaming terrain and scenery' },
  { target: 0.88, status: 'Warming up' },
  { target: 1, status: 'Ready' },
];
const LAST = VEIL_STAGES.length - 1;
const FIRST_FRAME_STAGE = 3;

export interface VeilModel {
  phase: VeilPhase;
  stage: number;
  /** Progress the bar is heading for, and the displayed progress (monotone, 0..1). */
  target: number;
  progress: number;
  status: string;
  /** Seconds since the veil went up, and since the current stage began. */
  t: number;
  stageT: number;
  firstFrame: boolean;
  sinceFirstFrame: number;
  smoothFrames: number;
  readyFor: number;
  wantDismiss: boolean;
  /** 0..1 progress of the fade-out; opacity of the veil. */
  fade: number;
  opacity: number;
}

const fin = (v: number) => (Number.isFinite(v) && v > 0 ? Math.min(v, 0.5) : 0);

export function createVeilModel(): VeilModel {
  return {
    phase: 'loading', stage: 0, target: VEIL_STAGES[0].target, progress: 0.02, status: VEIL_STAGES[0].status,
    t: 0, stageT: 0, firstFrame: false, sinceFirstFrame: 0, smoothFrames: 0, readyFor: 0, wantDismiss: false, fade: 0, opacity: 1,
  };
}

function setStage(m: VeilModel, s: number): void {
  if (m.phase !== 'loading' || !(s > m.stage)) return;
  m.stage = Math.min(LAST, Math.floor(s));
  m.target = VEIL_STAGES[m.stage].target;
  m.status = VEIL_STAGES[m.stage].status;
  m.stageT = 0;
  if (m.stage >= LAST) {
    m.phase = 'ready';
    m.readyFor = 0;
  }
}

function startFade(m: VeilModel): void {
  if (m.phase === 'loading' || m.phase === 'ready') {
    m.phase = 'fading';
    m.fade = 0;
    m.target = 1;
    m.status = VEIL_STAGES[LAST].status;
  }
}

function advance(m: VeilModel, dt: number, cfg: Config): void {
  m.t += dt;
  m.stageT += dt;
  // Between marks the bar keeps creeping toward (never reaching) the next stage, so it never looks stuck.
  let goal = m.target;
  if (m.phase === 'loading' && m.stage < LAST) {
    const next = VEIL_STAGES[m.stage + 1].target;
    goal = m.target + (next - m.target) * 0.75 * (1 - Math.exp(-m.stageT / 3));
  }
  const k = 1 - Math.exp(-dt / 0.3);
  const p = m.progress + (goal - m.progress) * k;
  m.progress = Math.min(1, Math.max(m.progress, Number.isFinite(p) ? p : m.progress));
  if (m.phase === 'ready') {
    m.readyFor += dt;
    if (m.wantDismiss || m.readyFor >= cfg.hud.veil.autoDismissS) startFade(m);
  }
  if (m.phase === 'fading') {
    m.progress = Math.max(m.progress, Math.min(1, m.progress + k));
    m.fade = Math.min(1, m.fade + dt / Math.max(0.05, cfg.hud.veil.fadeS));
    const s = m.fade * m.fade * (3 - 2 * m.fade);
    m.opacity = 1 - s;
    if (m.fade >= 1) {
      m.phase = 'gone';
      m.opacity = 0;
      m.progress = 1;
    }
  }
}

/** A loading milestone was reached (stages 1–2 are marked by the loading system; 3–4 come from frames). */
export function veilMark(m: VeilModel, stage: number, _cfg: Config = CONFIG): void {
  if (!Number.isFinite(stage)) return;
  setStage(m, Math.max(0, Math.min(LAST, Math.floor(stage))));
}

/** Time passes without a simulator frame (the veil's own animation loop while the world loads). */
export function veilTick(m: VeilModel, dt: number, cfg: Config = CONFIG): void {
  advance(m, fin(dt), cfg);
  // Never trap the page behind the veil (e.g. the app failed to start and no frame will ever come).
  if (m.t >= cfg.hud.veil.maxTotalS) startFade(m);
}

/** The simulator rendered a frame that took `dt` seconds. */
export function veilFrame(m: VeilModel, dtIn: number, cfg: Config = CONFIG): void {
  const dt = fin(dtIn);
  const v = cfg.hud.veil;
  if (!m.firstFrame) {
    m.firstFrame = true;
    setStage(m, FIRST_FRAME_STAGE);
  } else {
    m.sinceFirstFrame += dt;
    m.smoothFrames = dt * 1000 <= v.smoothFrameMs ? m.smoothFrames + 1 : 0;
  }
  if (m.phase === 'loading' && (m.smoothFrames >= v.smoothFrames || m.sinceFirstFrame >= v.maxWarmupS)) setStage(m, LAST);
  if (m.wantDismiss) startFade(m);
  advance(m, dt, cfg);
}

/** A key press or click: dismiss as soon as the simulator is rendering. */
export function veilGesture(m: VeilModel): void {
  m.wantDismiss = true;
  if (m.firstFrame) startFade(m);
}

// ─── Artwork ─────────────────────────────────────────────────────────────────

type P = [number, number];

/** Body-frame profile (z aft, y up, metres; wheel contact at y = −1.22) → SVG units. */
const S = 44;
const X0 = 398;
const Y0 = 128;
const sx = (z: number) => X0 - (z + 2.3) * S;
const sy = (y: number) => Y0 - (y + 1.22) * S;
const f1 = (v: number) => Math.round(v * 10) / 10;

/** Closed Catmull-Rom spline through the points as cubic Béziers (a smooth outline). */
function smooth(points: P[], closed = true, tension = 0.5): string {
  const p = points.map(([z, y]) => [sx(z), sy(y)] as P);
  const n = p.length;
  const at = (i: number) => (closed ? p[(i + n) % n] : p[Math.max(0, Math.min(n - 1, i))]);
  let d = `M${f1(p[0][0])} ${f1(p[0][1])}`;
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    const c1: P = [p1[0] + ((p2[0] - p0[0]) * tension) / 3, p1[1] + ((p2[1] - p0[1]) * tension) / 3];
    const c2: P = [p2[0] - ((p3[0] - p1[0]) * tension) / 3, p2[1] - ((p3[1] - p1[1]) * tension) / 3];
    d += `C${f1(c1[0])} ${f1(c1[1])} ${f1(c2[0])} ${f1(c2[1])} ${f1(p2[0])} ${f1(p2[1])}`;
  }
  return closed ? `${d}Z` : d;
}

function poly(points: P[]): string {
  return `M${points.map(([z, y]) => `${f1(sx(z))} ${f1(sy(y))}`).join('L')}Z`;
}

/** Side profile of the Cessna 172RG Cutlass on its wheels (nose right), as a self-contained SVG. */
export function cessnaSilhouetteSvg(): string {
  const fuselage = smooth([
    [-2.3, 0.04], [-2.12, 0.2], [-1.98, 0.3], [-1.6, 0.41], [-1.2, 0.47], [-1.04, 0.52], [-0.8, 0.76], [-0.62, 0.98],
    [0.4, 1.0], [1.1, 0.95], [1.7, 0.74], [2.6, 0.54], [3.6, 0.44], [4.5, 0.37], [5.4, 0.3], [6.28, 0.16], [6.3, 0.02],
    [6.0, -0.07], [5.0, -0.1], [3.8, -0.2], [2.4, -0.36], [1.1, -0.52], [0.0, -0.58], [-0.9, -0.56], [-1.4, -0.48],
    [-1.8, -0.36], [-2.02, -0.2], [-2.18, -0.08],
  ]);
  // Swept fin with the dorsal fillet, and the rudder.
  const fin = smooth([[3.2, 0.44], [4.2, 0.5], [4.75, 0.62], [5.55, 1.44], [5.66, 1.5], [6.07, 1.5], [6.14, 1.42], [6.3, 0.2], [5.4, 0.3]], true, 0.25);
  const hstab = smooth([[4.68, 0.06], [4.9, 0.15], [5.7, 0.15], [6.46, 0.1], [6.48, 0.05], [5.7, 0.0], [4.9, -0.02]], true, 0.4);
  // The high wing seen end-on: the root airfoil sitting on the cabin roof.
  const wing = smooth([[-0.7, 1.02], [-0.6, 1.13], [-0.2, 1.21], [0.4, 1.21], [1.14, 1.09], [1.2, 1.04], [0.6, 0.99], [-0.1, 0.96], [-0.6, 0.96]], true, 0.45);
  const windows = [
    poly([[-0.97, 0.55], [-0.62, 0.93], [0.28, 0.93], [0.3, 0.52], [-0.4, 0.46]]),
    poly([[0.4, 0.93], [1.08, 0.91], [1.1, 0.56], [0.42, 0.52]]),
    smooth([[1.2, 0.9], [1.62, 0.76], [2.1, 0.62], [1.9, 0.56], [1.25, 0.58]], true, 0.3),
  ];
  const stripe = smooth([[-1.95, 0.12], [-1.2, 0.2], [0.2, 0.24], [2.0, 0.22], [3.8, 0.2], [5.3, 0.18], [5.3, 0.1], [3.8, 0.1], [2.0, 0.1], [0.2, 0.1], [-1.2, 0.07], [-1.97, 0.02]], true, 0.3);
  const strut = poly([[0.33, -0.4], [0.41, -0.38], [-0.08, 0.96], [-0.17, 0.96]]);
  const noseLeg = poly([[-1.52, -0.44], [-1.38, -0.44], [-1.2, -1.0], [-1.32, -1.0]]);
  const mainLeg = poly([[0.08, -0.5], [0.26, -0.53], [0.52, -0.98], [0.38, -1.0]]);
  const wheel = (z: number, r: number) =>
    `<circle cx="${f1(sx(z))}" cy="${f1(sy(-1.22 + r))}" r="${f1(r * S)}" fill="#141a23" stroke="#2a3340" stroke-width="0.8"/>` +
    `<circle cx="${f1(sx(z))}" cy="${f1(sy(-1.22 + r))}" r="${f1(r * S * 0.45)}" fill="#a9b4c2"/>`;
  const propX = f1(sx(-2.08));
  const propY = f1(sy(0.05));
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 420 150" role="img" aria-label="Cessna 172RG Cutlass">` +
    `<defs>` +
    `<linearGradient id="fsvBody" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f4f7fb"/><stop offset="0.55" stop-color="#d9e1ea"/><stop offset="1" stop-color="#8e9aa9"/></linearGradient>` +
    `<linearGradient id="fsvWing" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#b9c4d1"/></linearGradient>` +
    `<linearGradient id="fsvGlass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b5572"/><stop offset="1" stop-color="#101a27"/></linearGradient>` +
    `<radialGradient id="fsvShadow"><stop offset="0" stop-color="#000" stop-opacity="0.55"/><stop offset="1" stop-color="#000" stop-opacity="0"/></radialGradient>` +
    `<linearGradient id="fsvProp" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#cfd8e3" stop-opacity="0"/><stop offset="0.5" stop-color="#cfd8e3" stop-opacity="0.55"/><stop offset="1" stop-color="#cfd8e3" stop-opacity="0"/></linearGradient>` +
    `</defs>` +
    `<ellipse cx="${f1(sx(1.8))}" cy="${Y0 + 1}" rx="200" ry="7" fill="url(#fsvShadow)"/>` +
    `<path d="${noseLeg}" fill="#7d8896"/><path d="${mainLeg}" fill="#7d8896"/>` +
    wheel(-1.26, 0.21) + wheel(0.45, 0.23) +
    `<path d="${fin}" fill="url(#fsvBody)"/>` +
    `<path d="${fuselage}" fill="url(#fsvBody)"/>` +
    `<path d="${hstab}" fill="url(#fsvWing)" stroke="#7a8796" stroke-width="0.6"/>` +
    `<path d="${stripe}" fill="#1f4f8f"/>` +
    windows.map((w) => `<path d="${w}" fill="url(#fsvGlass)"/>`).join('') +
    `<path d="${strut}" fill="#c4ceda"/>` +
    `<path d="${wing}" fill="url(#fsvWing)" stroke="#6f7c8c" stroke-width="0.7"/>` +
    `<ellipse class="fsv-prop" cx="${propX}" cy="${propY}" rx="2.4" ry="${f1(0.96 * S)}" fill="url(#fsvProp)"/>` +
    `</svg>`
  );
}

// ─── DOM ─────────────────────────────────────────────────────────────────────

export const VEIL_STYLE_ID = 'fsv-style';

const VEIL_CSS = `
.fsv-veil {
  position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center;
  background:
    radial-gradient(120% 70% at 50% 108%, rgba(255,170,110,0.20) 0%, rgba(120,90,120,0.10) 30%, rgba(0,0,0,0) 60%),
    radial-gradient(90% 60% at 50% 100%, #1d3552 0%, rgba(13,26,44,0) 70%),
    linear-gradient(180deg, #03060c 0%, #07101d 45%, #0f213a 100%);
  color: #eaf1fa; cursor: pointer; user-select: none; -webkit-user-select: none;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  transition: opacity 0.12s linear;
}
.fsv-card { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; width: min(560px, calc(100vw - 32px)); }
.fsv-plane { width: min(460px, 80vw); aspect-ratio: 420 / 150; margin-bottom: 26px; filter: drop-shadow(0 10px 24px rgba(0,0,0,0.45)); }
.fsv-plane svg { width: 100%; height: 100%; display: block; overflow: visible; }
.fsv-prop { transform-box: fill-box; transform-origin: 50% 50%; animation: fsv-prop 0.09s steps(3) infinite; }
@keyframes fsv-prop { 0% { transform: scaleY(1); opacity: 0.9; } 33% { transform: scaleY(0.55); opacity: 0.6; } 66% { transform: scaleY(0.85); opacity: 0.8; } 100% { transform: scaleY(1); opacity: 0.9; } }
.fsv-title {
  margin: 0; font-weight: 200; font-size: clamp(30px, 4.4vw, 50px); letter-spacing: 0.34em; text-indent: 0.34em;
  text-transform: uppercase; line-height: 1.05; white-space: nowrap;
  background: linear-gradient(180deg, #ffffff 30%, #9fb4cc 100%); -webkit-background-clip: text; background-clip: text; color: transparent;
}
.fsv-sub { margin-top: 12px; font-size: 12px; font-weight: 600; letter-spacing: 0.22em; text-transform: uppercase; color: rgba(190,210,232,0.62); text-align: center; }
.fsv-progress { margin-top: 40px; width: min(320px, 70vw); }
.fsv-track { position: relative; height: 2px; border-radius: 2px; overflow: hidden; background: rgba(255,255,255,0.10); }
.fsv-bar, .fsv-boot { position: absolute; inset: 0; transform-origin: 0 50%; border-radius: 2px;
  background: linear-gradient(90deg, #5fa8ff, #bfe0ff); box-shadow: 0 0 10px rgba(120,190,255,0.8); }
.fsv-bar { transform: scaleX(0); transition: transform 0.25s ease-out; }
/* Runs on the compositor, so it keeps moving while the main thread builds the aircraft. */
.fsv-boot { animation: fsv-boot 3.2s cubic-bezier(0.2, 0.7, 0.3, 1) both; }
@keyframes fsv-boot { from { transform: scaleX(0.02); } to { transform: scaleX(0.34); } }
.fsv-row { display: flex; justify-content: space-between; margin-top: 10px; font-size: 11px; font-weight: 600; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(200,218,238,0.58); }
.fsv-start {
  margin-top: 30px; font-size: 14px; font-weight: 500; letter-spacing: 0.14em; color: #f2f7fd;
  opacity: 0; transform: translateY(6px); transition: opacity 0.5s ease, transform 0.5s ease;
}
.fsv-ready .fsv-start { opacity: 1; transform: none; animation: fsv-pulse 1.8s ease-in-out 0.5s infinite; }
@keyframes fsv-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
.fsv-ready .fsv-row .fsv-status { color: rgba(170,230,190,0.85); }
@media (max-height: 560px) { .fsv-plane { margin-bottom: 12px; } .fsv-progress { margin-top: 22px; } .fsv-start { margin-top: 16px; } }
@media (prefers-reduced-motion: reduce) { .fsv-prop, .fsv-boot, .fsv-ready .fsv-start { animation: none; } }
`;

const instances = new Set<object>();

/** Does a loading veil still cover the screen? */
export function veilActive(): boolean {
  return instances.size > 0;
}

export interface LoadingVeil {
  readonly element: HTMLElement | null;
  readonly model: VeilModel;
  /** A loading milestone (1 = aircraft/renderer built, 2 = world systems created and streaming). */
  mark(stage: number): void;
  /** The simulator rendered a frame of `dt` seconds. */
  frame(dt: number): void;
  /** Start the fade now (as a click would). */
  dismiss(): void;
  dispose(): void;
}

export function createLoadingVeil(doc: Document, cfg: Config = CONFIG): LoadingVeil {
  const win = doc.defaultView ?? (globalThis as unknown as Window);
  const model = createVeilModel();
  const token = {};
  instances.add(token);

  if (!doc.getElementById(VEIL_STYLE_ID)) {
    const st = doc.createElement('style');
    st.id = VEIL_STYLE_ID;
    st.textContent = VEIL_CSS;
    doc.head.appendChild(st);
  }
  const el = doc.createElement('div');
  el.className = 'fsv-veil';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Flight Simulator is loading');
  const card = doc.createElement('div');
  card.className = 'fsv-card';
  const plane = doc.createElement('div');
  plane.className = 'fsv-plane';
  plane.innerHTML = cessnaSilhouetteSvg();
  const title = doc.createElement('h1');
  title.className = 'fsv-title';
  title.textContent = 'Flight Simulator';
  const sub = doc.createElement('div');
  sub.className = 'fsv-sub';
  const ap = cfg.world.airport as { name?: string; icao?: string };
  sub.textContent = `${cfg.aircraft.name} · ${ap.name ?? 'Tater Field'}${ap.icao ? ` (${ap.icao})` : ''} · Runway 36`;
  const progress = doc.createElement('div');
  progress.className = 'fsv-progress';
  const track = doc.createElement('div');
  track.className = 'fsv-track';
  const boot = doc.createElement('div');
  boot.className = 'fsv-boot';
  const bar = doc.createElement('div');
  bar.className = 'fsv-bar';
  track.append(boot, bar);
  const row = doc.createElement('div');
  row.className = 'fsv-row';
  const status = doc.createElement('span');
  status.className = 'fsv-status';
  const pct = doc.createElement('span');
  pct.className = 'fsv-pct';
  row.append(status, pct);
  progress.append(track, row);
  const start = doc.createElement('div');
  start.className = 'fsv-start';
  start.textContent = 'Click or press any key to start';
  card.append(plane, title, sub, progress, start);
  el.appendChild(card);
  (doc.body ?? doc.documentElement).appendChild(el);

  let shownP = -1;
  let shownStatus = '';
  let shownPct = '';
  let shownOpacity = 1;
  let ready = false;
  let removed = false;
  let raf = 0;
  let lastRaf = 0;
  let simFrames = 0;

  const render = () => {
    if (removed) return;
    if (Math.abs(model.progress - shownP) > 0.002) {
      shownP = model.progress;
      bar.style.transform = `scaleX(${shownP.toFixed(4)})`;
    }
    const s = model.phase === 'loading' ? `${model.status}…` : model.status;
    if (s !== shownStatus) status.textContent = shownStatus = s;
    const p = `${Math.round(model.progress * 100)}%`;
    if (p !== shownPct) pct.textContent = shownPct = p;
    const isReady = model.phase !== 'loading';
    if (isReady !== ready) {
      ready = isReady;
      el.classList.toggle('fsv-ready', ready);
    }
    if (model.phase === 'fading' || model.phase === 'gone') {
      el.style.pointerEvents = 'none';
      el.style.cursor = 'default';
    }
    if (Math.abs(model.opacity - shownOpacity) > 0.004) {
      shownOpacity = model.opacity;
      el.style.opacity = shownOpacity.toFixed(3);
    }
    if (model.phase === 'gone') teardown();
  };

  const onGesture = () => {
    veilGesture(model);
    render();
  };
  win.addEventListener('keydown', onGesture);
  win.addEventListener('pointerdown', onGesture);

  // Own animation loop while the world loads (no simulator frames yet); stops when frames arrive or it is gone.
  const loop = (now: number) => {
    raf = 0;
    if (removed) return;
    const dt = lastRaf ? (now - lastRaf) / 1000 : 0;
    lastRaf = now;
    if (simFrames === 0) veilTick(model, dt, cfg);
    simFrames = 0;
    render();
    if (!removed && typeof win.requestAnimationFrame === 'function') raf = win.requestAnimationFrame(loop);
  };
  if (typeof win.requestAnimationFrame === 'function') raf = win.requestAnimationFrame(loop);

  function teardown() {
    if (removed) return;
    removed = true;
    instances.delete(token);
    win.removeEventListener('keydown', onGesture);
    win.removeEventListener('pointerdown', onGesture);
    if (raf && typeof win.cancelAnimationFrame === 'function') win.cancelAnimationFrame(raf);
    raf = 0;
    el.remove();
    if (instances.size === 0) doc.getElementById(VEIL_STYLE_ID)?.remove();
  }

  render();
  return {
    get element() {
      return removed ? null : el;
    },
    model,
    mark(stage) {
      veilMark(model, stage, cfg);
      render();
    },
    frame(dt) {
      if (removed) return;
      simFrames++;
      veilFrame(model, dt, cfg);
      render();
    },
    dismiss() {
      onGesture();
    },
    dispose: teardown,
  };
}
