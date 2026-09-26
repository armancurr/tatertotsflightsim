/**
 * The start-up loading veil: a full-screen title card (Tater the mascot flying
 * over "Tater's Flight Sim", the aircraft and airfield, a progress bar and what
 * is being prepared) that
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
import { mascotSvg } from './mascot';

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

// ─── DOM ─────────────────────────────────────────────────────────────────────

export const VEIL_STYLE_ID = 'fsv-style';

const VEIL_CSS = `
.fsv-veil {
  position: fixed; inset: 0; z-index: 1000; display: flex; align-items: center; justify-content: center; overflow: hidden;
  background:
    radial-gradient(90% 55% at 50% 112%, rgba(255,170,90,0.30) 0%, rgba(232,57,47,0.10) 35%, rgba(0,0,0,0) 65%),
    radial-gradient(70% 50% at 50% 38%, rgba(64,110,170,0.22) 0%, rgba(0,0,0,0) 70%),
    linear-gradient(180deg, #050912 0%, #0b1628 48%, #1a2640 78%, #3a2f3a 100%);
  color: #f4f1ea; cursor: pointer; user-select: none; -webkit-user-select: none;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  transition: opacity 0.12s linear;
}
.fsv-veil::before {
  content: ""; position: absolute; inset: 0; pointer-events: none; opacity: 0.55;
  background-image: radial-gradient(1px 1px at 12% 18%, #fff 50%, transparent 51%), radial-gradient(1px 1px at 72% 12%, #fff 50%, transparent 51%),
    radial-gradient(1.5px 1.5px at 34% 30%, #fff 50%, transparent 51%), radial-gradient(1px 1px at 88% 34%, #fff 50%, transparent 51%),
    radial-gradient(1px 1px at 55% 8%, #fff 50%, transparent 51%), radial-gradient(1px 1px at 22% 44%, #fff 50%, transparent 51%);
}
.fsv-card { position: relative; z-index: 1; display: flex; flex-direction: column; align-items: center; width: min(620px, calc(100vw - 32px)); }
.fsv-mascot { width: min(230px, 42vw); aspect-ratio: 64 / 48; margin-bottom: 14px; animation: fsv-bob 2.6s ease-in-out infinite; filter: drop-shadow(0 16px 24px rgba(0,0,0,0.5)); }
.fsv-mascot svg { width: 100%; height: 100%; display: block; overflow: visible; }
@keyframes fsv-bob { 0%, 100% { transform: translate(0, 0) rotate(0deg); } 50% { transform: translate(6px, -9px) rotate(-2deg); } }
.fsv-title {
  margin: 0; font-weight: 850; font-size: clamp(34px, 5.4vw, 60px); letter-spacing: 0.01em; line-height: 1.02; white-space: nowrap; color: #fff4e0;
  text-shadow: 0 6px 30px rgba(0,0,0,0.45);
}
.fsv-title span { background: linear-gradient(180deg, #ffe09a, #ffc15c 45%, #f29a2e); -webkit-background-clip: text; background-clip: text; color: transparent; }
.fsv-full { margin-top: 10px; font-size: 12px; font-weight: 700; letter-spacing: 0.34em; text-indent: 0.34em; text-transform: uppercase; color: rgba(255,210,140,0.72); }
.fsv-sub { margin-top: 18px; font-size: 13px; font-weight: 600; letter-spacing: 0.06em; color: rgba(214,226,240,0.66); text-align: center; }
.fsv-progress { margin-top: 30px; width: min(340px, 70vw); }
.fsv-track { position: relative; height: 3px; border-radius: 3px; overflow: hidden; background: rgba(255,255,255,0.10); }
.fsv-bar, .fsv-boot { position: absolute; inset: 0; transform-origin: 0 50%; border-radius: 3px;
  background: linear-gradient(90deg, #f29a2e, #ffc15c 60%, #ffe6b0); box-shadow: 0 0 12px rgba(255,180,80,0.8); }
.fsv-bar { transform: scaleX(0); transition: transform 0.25s ease-out; }
/* Runs on the compositor, so it keeps moving while the main thread builds the aircraft. */
.fsv-boot { animation: fsv-boot 3.2s cubic-bezier(0.2, 0.7, 0.3, 1) both; }
@keyframes fsv-boot { from { transform: scaleX(0.02); } to { transform: scaleX(0.34); } }
.fsv-row { display: flex; justify-content: space-between; margin-top: 10px; font-size: 11px; font-weight: 650; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(214,226,240,0.58); }
.fsv-start {
  margin-top: 28px; padding: 9px 20px; border-radius: 999px; font-size: 14px; font-weight: 700; letter-spacing: 0.08em; color: #241503;
  background: linear-gradient(180deg, #ffd27e, #ffc15c 50%, #f29a2e); box-shadow: 0 8px 24px rgba(242,154,46,0.35);
  opacity: 0; transform: translateY(6px); transition: opacity 0.5s ease, transform 0.5s ease;
}
.fsv-ready .fsv-start { opacity: 1; transform: none; animation: fsv-pulse 1.8s ease-in-out 0.5s infinite; }
@keyframes fsv-pulse { 0%, 100% { box-shadow: 0 8px 24px rgba(242,154,46,0.35); } 50% { box-shadow: 0 8px 34px rgba(255,193,92,0.7); } }
.fsv-ready .fsv-row .fsv-status { color: rgba(170,230,190,0.85); }
@media (max-height: 560px) { .fsv-mascot { width: 150px; margin-bottom: 6px; } .fsv-progress { margin-top: 18px; } .fsv-start { margin-top: 14px; } }
@media (prefers-reduced-motion: reduce) { .fsv-mascot, .fsv-boot, .fsv-ready .fsv-start { animation: none; } }
`;

/** Live veils → their teardown (an error screen removes them). */
const instances = new Map<object, () => void>();

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

export interface VeilOptions {
  /** The aircraft about to be flown (default: the config's). */
  aircraftName?: string;
  /** The runway end it starts on, e.g. '03' for ?rwy=03 (default: '36'). */
  runway?: string;
  /** Where a vessel starts instead of the airport and runway, e.g. 'Port Chateau · Naval pier'. */
  place?: string;
}

export function createLoadingVeil(doc: Document, cfg: Config = CONFIG, opts: VeilOptions = {}): LoadingVeil {
  const win = doc.defaultView ?? (globalThis as unknown as Window);
  const model = createVeilModel();
  const token = {};
  instances.set(token, () => teardown());

  if (!doc.getElementById(VEIL_STYLE_ID)) {
    const st = doc.createElement('style');
    st.id = VEIL_STYLE_ID;
    st.textContent = VEIL_CSS;
    doc.head.appendChild(st);
  }
  const el = doc.createElement('div');
  el.className = 'fsv-veil';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', `${cfg.menu.productName} is loading`);
  const card = doc.createElement('div');
  card.className = 'fsv-card';
  const mascot = doc.createElement('div');
  mascot.className = 'fsv-mascot';
  mascot.innerHTML = mascotSvg({ title: 'Tater, the flying potato' });
  const title = doc.createElement('h1');
  title.className = 'fsv-title';
  const name = cfg.menu.productName;
  const sp = name.indexOf(' ');
  const first = doc.createElement('span');
  first.textContent = sp > 0 ? name.slice(0, sp) : name;
  title.appendChild(first);
  if (sp > 0) title.appendChild(doc.createTextNode(name.slice(sp)));
  const full = doc.createElement('div');
  full.className = 'fsv-full';
  full.textContent = cfg.menu.fullName;
  const sub = doc.createElement('div');
  sub.className = 'fsv-sub';
  const ap = cfg.world.airport as { name?: string; icao?: string };
  sub.textContent = opts.place
    ? `${opts.aircraftName ?? cfg.aircraft.name} · ${opts.place}`
    : `${opts.aircraftName ?? cfg.aircraft.name} · ${ap.name ?? 'Tater Field'}${ap.icao ? ` (${ap.icao})` : ''} · Runway ${opts.runway ?? '36'}`;
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
  card.append(mascot, title, full, sub, progress, start);
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

// ─── Error screens ───────────────────────────────────────────────────────────
//
// What a stranger sees when the simulator can't run: a clear, friendly card (never a blank page),
// what to try, and — for real errors — the details to paste into an issue. The content builders are
// pure; showErrorScreen() draws one (above any loading veil, which it removes).

export interface ErrorContent {
  title: string;
  message: string;
  tips: string[];
  /** Technical details (error message/stack), shown collapsed. */
  details?: string;
  /** Offer a Reload button. */
  reload: boolean;
}

type Browser = 'chrome' | 'edge' | 'firefox' | 'safari' | 'other';

export function browserFamily(userAgent: string): Browser {
  const ua = userAgent || '';
  if (/Edg\//.test(ua)) return 'edge';
  if (/Firefox\//.test(ua)) return 'firefox';
  if (/Chrome\/|Chromium\/|CriOS\//.test(ua)) return 'chrome';
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return 'safari';
  return 'other';
}

function accelerationTip(b: Browser): string {
  switch (b) {
    case 'chrome':
      return 'Turn on hardware acceleration: Chrome Settings → System → "Use graphics acceleration when available", then relaunch Chrome.';
    case 'edge':
      return 'Turn on hardware acceleration: Edge Settings → System and performance → "Use graphics acceleration when available", then restart Edge.';
    case 'firefox':
      return 'Turn on hardware acceleration: Firefox Settings → General → Performance → "Use hardware acceleration when available" (and make sure webgl.disabled is false in about:config).';
    case 'safari':
      return 'Update Safari: WebGL 2 needs Safari 15 or newer (macOS 12 / iOS 15).';
    default:
      return 'Make sure hardware (GPU) acceleration is turned on in your browser settings.';
  }
}

/** The card for a browser that can't give us a WebGL 2 context. */
export function webglErrorContent(problem: 'no-webgl2' | 'webgl1-only' | 'context-failed', userAgent = ''): ErrorContent {
  const b = browserFamily(userAgent);
  const update = 'Update your browser — current Chrome, Edge, Firefox and Safari all support WebGL 2.';
  if (problem === 'context-failed') {
    return {
      title: "Your graphics card didn't start",
      message: "Your browser supports WebGL 2, but it couldn't create a 3D context right now. That usually means graphics acceleration is off, the GPU is blocked by the browser, or too many 3D tabs are open.",
      tips: [accelerationTip(b), 'Close other tabs or apps that use 3D, then reload.', 'Restart the browser (or the computer) if it still fails.'],
      reload: true,
    };
  }
  return {
    title: 'This browser can’t show 3D graphics',
    message:
      problem === 'webgl1-only'
        ? "Tater's Flight Sim needs WebGL 2. Your browser only offers the older WebGL 1."
        : "Tater's Flight Sim needs WebGL 2 to draw the world, and this browser doesn't provide it.",
    tips: [update, accelerationTip(b), 'Try another browser: Chrome, Edge, Firefox or Safari.'],
    reload: false,
  };
}

/** Whatever was thrown, as text (never throws: objects without a prototype, cycles, undefined…). */
const safeString = (e: unknown): string => {
  try {
    if (typeof e === 'string') return e;
    const j = JSON.stringify(e);
    if (typeof j === 'string') return j;
  } catch {
    /* cyclic, BigInt… */
  }
  try {
    return String(e);
  } catch {
    return Object.prototype.toString.call(e);
  }
};

const errText = (e: unknown): string => {
  if (e instanceof Error) {
    const head = `${e.name}: ${e.message}`;
    return typeof e.stack === 'string' && e.stack.includes(e.message) ? e.stack : `${head}\n${e.stack ?? ''}`;
  }
  return safeString(e);
};

/** The card for an exception while loading or starting the simulator. */
export function startupErrorContent(error: unknown, userAgent = ''): ErrorContent {
  const details = errText(error).slice(0, 4000);
  const msg = error instanceof Error ? String(error.message) : safeString(error);
  if (/dynamically imported module|Importing a module script failed|error loading dynamically imported module|Failed to fetch|Load failed|ChunkLoadError/i.test(msg)) {
    return {
      title: "The game didn't finish loading",
      message: 'Some of the game files could not be downloaded — the connection dropped, or a new version was published while this page was open.',
      tips: ['Reload the page.', 'If you host it yourself, serve the whole dist/ folder and build with --base set to the folder it lives in.'],
      details,
      reload: true,
    };
  }
  if (/WebGL|context|GPU|shader/i.test(msg)) {
    return {
      title: "The 3D graphics couldn't start",
      message: 'Your browser refused to create the 3D view the simulator draws into.',
      tips: [accelerationTip(browserFamily(userAgent)), 'Close other 3D tabs, then reload.'],
      details,
      reload: true,
    };
  }
  return {
    title: 'Something went wrong while starting the simulator',
    message: 'Sorry — the simulator hit an error before it could take off.',
    tips: ['Reload the page.', 'If it keeps happening, please open an issue on the project’s GitHub page and paste the details below.'],
    details,
    reload: true,
  };
}

export const ERROR_STYLE_ID = 'fse-style';
const ERROR_CSS = `
.fse-screen { position: fixed; inset: 0; z-index: 2000; display: flex; align-items: center; justify-content: center; overflow: auto;
  padding: 16px; box-sizing: border-box; background: linear-gradient(180deg, #050912 0%, #0b1628 55%, #1a2640 100%); color: #f4f1ea;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", "Helvetica Neue", Arial, sans-serif; -webkit-font-smoothing: antialiased; }
.fse-card { width: min(620px, 100%); padding: 28px 30px; border-radius: 16px; background: rgba(12, 20, 36, 0.92);
  border: 1px solid rgba(255, 255, 255, 0.10); box-shadow: 0 24px 60px rgba(0, 0, 0, 0.5); box-sizing: border-box; }
.fse-mascot { width: 110px; aspect-ratio: 64 / 48; margin-bottom: 8px; }
.fse-mascot svg { width: 100%; height: 100%; display: block; overflow: visible; }
.fse-title { margin: 0 0 10px; font-size: clamp(22px, 3.4vw, 30px); font-weight: 800; line-height: 1.15; color: #fff4e0; }
.fse-message { margin: 0 0 14px; font-size: 15px; line-height: 1.5; color: rgba(226, 234, 244, 0.86); }
.fse-tips { margin: 0 0 18px; padding-left: 20px; font-size: 14px; line-height: 1.5; color: rgba(214, 226, 240, 0.8); }
.fse-tips li { margin: 4px 0; }
.fse-reload { font: inherit; font-size: 14px; font-weight: 700; letter-spacing: 0.04em; padding: 9px 20px; border: 0; border-radius: 999px; cursor: pointer;
  color: #241503; background: linear-gradient(180deg, #ffd27e, #ffc15c 50%, #f29a2e); }
.fse-details { margin-top: 16px; font-size: 12px; color: rgba(214, 226, 240, 0.6); }
.fse-details pre { max-height: 220px; overflow: auto; white-space: pre-wrap; word-break: break-word; padding: 10px; border-radius: 8px; background: rgba(0, 0, 0, 0.35); }
.fse-notice { position: fixed; left: 50%; top: 56px; transform: translateX(-50%); z-index: 1500; max-width: calc(100vw - 32px); box-sizing: border-box;
  padding: 10px 16px; border-radius: 10px; background: rgba(12, 20, 36, 0.92); color: #f4f1ea; border: 1px solid rgba(255, 255, 255, 0.14);
  font: 600 14px -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif; display: flex; gap: 12px; align-items: center; }
.fse-notice button { font: inherit; padding: 4px 12px; border-radius: 999px; border: 0; cursor: pointer; color: #241503; background: #ffc15c; }
`;

function ensureErrorStyle(doc: Document): void {
  if (doc.getElementById(ERROR_STYLE_ID)) return;
  const st = doc.createElement('style');
  st.id = ERROR_STYLE_ID;
  st.textContent = ERROR_CSS;
  doc.head.appendChild(st);
}

/** Replace whatever is on screen with an error card (removes any loading veil). Text only — no HTML injection. */
export function showErrorScreen(doc: Document, content: ErrorContent): HTMLElement {
  for (const teardown of Array.from(instances.values())) teardown();
  doc.querySelectorAll('.fse-screen').forEach((e) => e.remove());
  ensureErrorStyle(doc);
  const el = doc.createElement('div');
  el.className = 'fse-screen';
  el.setAttribute('role', 'alert');
  const card = doc.createElement('div');
  card.className = 'fse-card';
  const mascot = doc.createElement('div');
  mascot.className = 'fse-mascot';
  mascot.innerHTML = mascotSvg({ title: 'Tater, the flying potato' });
  const title = doc.createElement('h1');
  title.className = 'fse-title';
  title.textContent = content.title;
  const msg = doc.createElement('p');
  msg.className = 'fse-message';
  msg.textContent = content.message;
  card.append(mascot, title, msg);
  if (content.tips.length) {
    const ul = doc.createElement('ul');
    ul.className = 'fse-tips';
    for (const t of content.tips) {
      const li = doc.createElement('li');
      li.textContent = t;
      ul.appendChild(li);
    }
    card.appendChild(ul);
  }
  if (content.reload) {
    const b = doc.createElement('button');
    b.className = 'fse-reload';
    b.type = 'button';
    b.textContent = 'Reload';
    b.addEventListener('click', () => doc.defaultView?.location.reload());
    card.appendChild(b);
  }
  if (content.details) {
    const d = doc.createElement('details');
    d.className = 'fse-details';
    const sum = doc.createElement('summary');
    sum.textContent = 'Technical details';
    const pre = doc.createElement('pre');
    pre.textContent = content.details;
    d.append(sum, pre);
    card.appendChild(d);
  }
  el.appendChild(card);
  (doc.body ?? doc.documentElement).appendChild(el);
  return el;
}

export interface Notice {
  readonly element: HTMLElement;
  setText(text: string): void;
  remove(): void;
}

/** A small banner over the game (e.g. "graphics were reset — restoring…"), with an optional button. */
export function showNotice(doc: Document, text: string, action?: { label: string; onClick: () => void }): Notice {
  ensureErrorStyle(doc);
  const el = doc.createElement('div');
  el.className = 'fse-notice';
  el.setAttribute('role', 'status');
  const span = doc.createElement('span');
  span.textContent = text;
  el.appendChild(span);
  if (action) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.textContent = action.label;
    b.addEventListener('click', action.onClick);
    el.appendChild(b);
  }
  (doc.body ?? doc.documentElement).appendChild(el);
  return {
    element: el,
    setText: (t) => {
      span.textContent = t;
    },
    remove: () => el.remove(),
  };
}
