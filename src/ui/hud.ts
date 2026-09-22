/**
 * The HUD overlay: DOM + canvases over the 3D view. Bottom-left cluster
 * ASI · attitude · altimeter, bottom-right heading · VSI · tach, a slim
 * systems strip between them, a compass tape top-centre, an FPS/camera/time
 * chip top-left, and the message layer (annunciators, crash banner, landing
 * toast, PAUSED, start hint, help sheet). The middle of the screen stays
 * clear; nothing takes pointer events (the 3D canvas needs mouse drags).
 *
 * Layout is computed in JS (computeHudLayout, pure and property-tested) and
 * applied as px; it scales with the viewport. Canvases are sized at
 * devicePixelRatio and only redrawn when what they show has changed.
 */
import { CONFIG, type Config } from '../config';
import type { AircraftState, CameraMode, Controls, InstrumentReadings } from '../types';
import {
  drawAirspeed, drawAttitude, drawAltimeter, drawHeading, drawVsi, drawTachometer, drawSystemsStrip, drawCompassTape, drawPanel,
  systemsStripWidth, type GaugeDrawer,
} from './gauges';
import { annunciationActive, annunciationList, crashText, describeTouchdown, startHint, type AnnunciationId, type MessageLevel } from './messages';
import { createHelpOverlay } from './help';
import { installHudStyle, removeHudStyle } from './hudStyle';

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 'normal' = all clusters; in cockpit view the clusters are hidden (or compact, per config.hud.cockpitGauges). */
export type HudMode = 'normal' | 'cockpitHidden' | 'cockpitCompact';

export interface HudLayout {
  width: number;
  height: number;
  /** Gauge diameter, CSS px. */
  gauge: number;
  margin: number;
  gap: number;
  pad: number;
  /** Base font size of the message layer, px. */
  fontSize: number;
  clustersVisible: boolean;
  left: Rect;
  right: Rect;
  strip: Rect;
  stripRows: 1 | 2;
  compass: Rect;
  chip: { x: number; y: number; h: number; maxW: number };
  /** Top of the annunciator row, of the PAUSED pill and of the crash banner. */
  annunciatorY: number;
  pausedY: number;
  bannerY: number;
  /** Toasts and the start hint stack upward from here. */
  toastBottom: number;
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** Pure HUD layout for a viewport (CSS px). */
export function computeHudLayout(width: number, height: number, cfg: Config = CONFIG, mode: HudMode = 'normal'): HudLayout {
  const w = Number.isFinite(width) && width > 0 ? width : 1024;
  const h = Number.isFinite(height) && height > 0 ? height : 768;
  const hc = cfg.hud;
  const t = (w - 1024) / (1440 - 1024);
  let g0 = hc.gaugeSize1024 + (hc.gaugeSize1440 - hc.gaugeSize1024) * t;
  g0 = Math.min(clamp(g0, hc.gaugeMin, hc.gaugeMax), h * hc.gaugeMaxHeightFraction);
  g0 = Math.max(24, Math.round(g0));
  const g = mode === 'cockpitCompact' ? Math.round(g0 * 0.72) : g0;
  const clustersVisible = mode !== 'cockpitHidden';
  const margin = Math.round(clamp(w * 0.012, 10, 20));
  const pad = Math.max(4, Math.round(g * 0.07));
  const gap = Math.max(4, Math.round(g * 0.08));
  const cw = 3 * g + 2 * gap + 2 * pad;
  const ch = g + 2 * pad;
  const cy = h - margin - ch;
  const left: Rect = { x: margin, y: cy, w: cw, h: ch };
  const right: Rect = { x: w - margin - cw, y: cy, w: cw, h: ch };

  // Systems strip: one slim row if it fits, else two rows of three, else a row above the clusters.
  const cell0 = Math.round(clamp(g0 * 0.42, 34, 54));
  const oneRow = systemsStripWidth(1, 1);
  const twoRow = systemsStripWidth(1, 2);
  let strip: Rect;
  let stripRows: 1 | 2 = 1;
  if (!clustersVisible) {
    const cell = Math.max(24, Math.min(cell0, Math.floor((w - 2 * margin) / oneRow)));
    const sw = Math.round(oneRow * cell);
    strip = { x: Math.round((w - sw) / 2), y: h - margin - cell, w: sw, h: cell };
  } else {
    const x0 = left.x + cw + gap;
    const avail = right.x - gap - x0;
    const cellOne = Math.min(cell0, Math.floor(avail / oneRow));
    const cellTwo = Math.min(cell0, Math.floor(avail / twoRow));
    if (cellOne >= 40 || (cellOne >= 34 && cellOne >= cellTwo)) {
      const sw = Math.round(oneRow * cellOne);
      strip = { x: Math.round(x0 + (avail - sw) / 2), y: h - margin - cellOne, w: sw, h: cellOne };
    } else if (cellTwo >= 30) {
      stripRows = 2;
      const sw = Math.round(twoRow * cellTwo);
      strip = { x: Math.round(x0 + (avail - sw) / 2), y: h - margin - cellTwo * 2, w: sw, h: cellTwo * 2 };
    } else {
      const cell = Math.max(24, Math.min(cell0, Math.floor((w - 2 * margin) / oneRow)));
      const sw = Math.round(oneRow * cell);
      strip = { x: Math.round((w - sw) / 2), y: cy - gap - cell, w: sw, h: cell };
    }
  }

  const compassW = Math.round(clamp(w * 0.3, 240, 460));
  const compassH = Math.round(clamp(g0 * 0.44, 40, 56));
  const compass: Rect = { x: Math.round((w - compassW) / 2), y: margin, w: compassW, h: compassH };
  const chip = { x: margin, y: margin, h: 24, maxW: Math.max(0, Math.min(300, compass.x - 2 * margin)) };
  const fontSize = Math.round(clamp(g0 * 0.105, 11, 15));
  const annunciatorY = compass.y + compass.h + 10;
  const pausedY = annunciatorY + Math.round(fontSize * 3.2);
  const bannerY = Math.round(Math.min(Math.max(h * 0.2, pausedY + fontSize * 4.4), h / 3 - fontSize * 7));
  const bottomTop = clustersVisible ? Math.min(left.y, strip.y) : strip.y;
  return {
    width: w,
    height: h,
    gauge: g,
    margin,
    gap,
    pad,
    fontSize,
    clustersVisible,
    left,
    right,
    strip,
    stripRows,
    compass,
    chip,
    annunciatorY,
    pausedY,
    bannerY: Math.max(annunciatorY, bannerY),
    toastBottom: bottomTop - 12,
  };
}

// ─── The overlay ─────────────────────────────────────────────────────────────

export interface HudInfo {
  cameraMode: CameraMode;
  paused: boolean;
  fps: number;
  timeOfDay: string;
  state: AircraftState;
  controls: Controls;
  mouseYoke: boolean;
  /** Landing light switch (L); a change is confirmed with a toast. */
  landingLight?: boolean;
  /** True while the start-up loading veil covers the screen (the start hint waits for it). */
  veil?: boolean;
}

export type PanelDrawerFn = (ctx: CanvasRenderingContext2D, w: number, h: number, r: InstrumentReadings) => void;

export interface HudOptions {
  /** The aircraft model; receives drawPanel for its cockpit panel texture. */
  aircraft?: { setPanelDrawer(fn: PanelDrawerFn): void };
  /** Config override (tests); defaults to CONFIG. */
  config?: Config;
}

export interface Hud {
  update(r: InstrumentReadings, info: HudInfo, dt: number): void;
  toggleHelp(): void;
  toggleVisible(): void;
  flash(text: string, level?: MessageLevel, seconds?: number): void;
  resize(): void;
  dispose(): void;
  /** The overlay's root element (child of the root passed in). */
  readonly element: HTMLElement;
}

interface Slot {
  el: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D | null;
  w: number;
  h: number;
  dpr: number;
  s0: number;
  s1: number;
  s2: number;
  s3: number;
  dirty: boolean;
}

interface Toast {
  el: HTMLElement;
  until: number;
}

const CAMERA_NAME: Record<CameraMode, string> = { cockpit: 'Cockpit', chase: 'Chase', external: 'External', orbit: 'Orbit' };

export function createHud(root: HTMLElement, opts: HudOptions = {}): Hud {
  const cfg = opts.config ?? CONFIG;
  const doc = root.ownerDocument;
  const win = (doc.defaultView ?? (globalThis as unknown as Window));
  installHudStyle(doc);

  const div = (cls: string, parent: HTMLElement): HTMLElement => {
    const e = doc.createElement('div');
    e.className = cls;
    parent.appendChild(e);
    return e;
  };
  const el = doc.createElement('div');
  el.className = 'fsh-root';
  el.style.pointerEvents = 'none';
  el.setAttribute('aria-hidden', 'true');
  root.appendChild(el);

  // Instruments layer.
  const instruments = div('fsh-instruments', el);
  const leftEl = div('fsh-cluster fsh-left fsh-glass', instruments);
  const rightEl = div('fsh-cluster fsh-right fsh-glass', instruments);
  const stripEl = div('fsh-strip fsh-glass', instruments);
  const compassEl = div('fsh-compass fsh-glass', instruments);
  const chipEl = div('fsh-chip fsh-glass', instruments);
  const chipFps = doc.createElement('span');
  const chipCam = doc.createElement('span');
  const chipTod = doc.createElement('span');
  const chipYoke = doc.createElement('span');
  chipYoke.className = 'fsh-yoke';
  const sep = () => {
    const s = doc.createElement('span');
    s.className = 'fsh-sep';
    s.textContent = '·';
    return s;
  };
  const yokeSep = sep();
  chipEl.append(chipFps, sep(), chipCam, sep(), chipTod, yokeSep, chipYoke);

  const slot = (parent: HTMLElement, gauge?: string): Slot => {
    const c = doc.createElement('canvas');
    if (gauge) c.setAttribute('data-gauge', gauge);
    parent.appendChild(c);
    let ctx: CanvasRenderingContext2D | null = null;
    try {
      ctx = c.getContext('2d');
    } catch {
      ctx = null;
    }
    return { el: c, ctx, w: 0, h: 0, dpr: 1, s0: NaN, s1: NaN, s2: NaN, s3: NaN, dirty: true };
  };
  const gauges: { slot: Slot; draw: GaugeDrawer; kind: number }[] = [
    { slot: slot(leftEl, 'airspeed'), draw: drawAirspeed, kind: 0 },
    { slot: slot(leftEl, 'attitude'), draw: drawAttitude, kind: 1 },
    { slot: slot(leftEl, 'altimeter'), draw: drawAltimeter, kind: 2 },
    { slot: slot(rightEl, 'heading'), draw: drawHeading, kind: 3 },
    { slot: slot(rightEl, 'vsi'), draw: drawVsi, kind: 4 },
    { slot: slot(rightEl, 'tach'), draw: drawTachometer, kind: 5 },
  ];
  const stripSlot = slot(stripEl);
  const compassSlot = slot(compassEl);

  // Message layer.
  const messages = div('fsh-messages', el);
  const annsEl = div('fsh-anns', messages);
  const annDefs = annunciationList(cfg);
  const anns = annDefs.map((a) => {
    const e = div(`fsh-ann fsh-${a.level}`, annsEl);
    e.setAttribute('data-ann', a.id);
    e.textContent = a.text;
    e.hidden = true;
    return { id: a.id as AnnunciationId, el: e, on: false, dim: false };
  });
  const pausedEl = div('fsh-paused fsh-glass', messages);
  pausedEl.textContent = 'PAUSED';
  const pausedSmall = doc.createElement('small');
  pausedSmall.textContent = 'P to resume · H help';
  pausedEl.appendChild(pausedSmall);
  pausedEl.hidden = true;
  const bannerEl = div('fsh-banner fsh-glass', messages);
  const bannerTitle = div('fsh-title', bannerEl);
  const bannerSub = div('fsh-sub', bannerEl);
  bannerEl.hidden = true;
  const toastsEl = div('fsh-toasts', messages);
  const hintEl = div('fsh-hint fsh-glass', toastsEl);
  hintEl.textContent = startHint(cfg);
  const help = createHelpOverlay(doc, cfg);
  el.appendChild(help);

  // ── State ──────────────────────────────────────────────────────────────
  let layout: HudLayout;
  let mode: HudMode = 'normal';
  let visible = true;
  let time = 0;
  let disposed = false;
  let chipTimer = Infinity;
  let lastCamera: CameraMode | null = null;
  let lastYoke: boolean | null = null;
  let lastTod: string | null = null;
  let lastLight: boolean | null = null;
  let hintTime = 0;
  let lastTouchdown: number | null = null;
  let lastCrash: string | null = null;
  let pausedShown = false;
  let hintState = 0; // 0 visible, 1 fading, 2 gone
  const toasts: Toast[] = [];

  const place = (e: HTMLElement, r: Rect) => {
    e.style.left = `${r.x}px`;
    e.style.top = `${r.y}px`;
    e.style.width = `${r.w}px`;
    e.style.height = `${r.h}px`;
  };
  const sizeSlot = (s: Slot, x: number, y: number, w: number, h: number, dpr: number) => {
    place(s.el, { x, y, w, h });
    s.w = w;
    s.h = h;
    s.dpr = dpr;
    s.el.width = Math.max(1, Math.round(w * dpr));
    s.el.height = Math.max(1, Math.round(h * dpr));
    s.dirty = true;
  };
  const changed = (s: Slot, a: number, b: number, c: number, d: number): boolean => {
    if (!s.dirty && a === s.s0 && b === s.s1 && c === s.s2 && d === s.s3) return false;
    s.s0 = a;
    s.s1 = b;
    s.s2 = c;
    s.s3 = d;
    s.dirty = false;
    return true;
  };
  const begin = (s: Slot): CanvasRenderingContext2D | null => {
    const c = s.ctx;
    if (!c) return null;
    c.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
    c.clearRect(0, 0, s.w, s.h);
    return c;
  };

  const applyLayout = () => {
    const vw = win.innerWidth || doc.documentElement.clientWidth || 1024;
    const vh = win.innerHeight || doc.documentElement.clientHeight || 768;
    const dpr = Math.min(cfg.hud.maxPixelRatio, Math.max(1, Number(win.devicePixelRatio) || 1));
    layout = computeHudLayout(vw, vh, cfg, mode);
    const L = layout;
    el.style.setProperty('--fsh-fs', `${L.fontSize}px`);
    leftEl.hidden = !L.clustersVisible;
    rightEl.hidden = !L.clustersVisible;
    place(leftEl, L.left);
    place(rightEl, L.right);
    const b = 1; // glass border
    gauges.forEach((gs, i) => {
      const k = i % 3;
      sizeSlot(gs.slot, L.pad - b + k * (L.gauge + L.gap), L.pad - b, L.gauge, L.gauge, dpr);
    });
    place(stripEl, L.strip);
    sizeSlot(stripSlot, 0, 0, L.strip.w - 2 * b, L.strip.h - 2 * b, dpr);
    place(compassEl, L.compass);
    sizeSlot(compassSlot, 0, 0, L.compass.w - 2 * b, L.compass.h - 2 * b, dpr);
    chipEl.style.left = `${L.chip.x}px`;
    chipEl.style.top = `${L.chip.y}px`;
    chipEl.style.height = `${L.chip.h}px`;
    chipEl.style.maxWidth = `${L.chip.maxW}px`;
    chipEl.hidden = L.chip.maxW < 80;
    annsEl.style.top = `${L.annunciatorY}px`;
    pausedEl.style.top = `${L.pausedY}px`;
    bannerEl.style.top = `${L.bannerY}px`;
    toastsEl.style.top = '';
    toastsEl.style.bottom = `${L.height - L.toastBottom}px`;
  };
  applyLayout();

  const onResize = () => applyLayout();
  win.addEventListener('resize', onResize);
  opts.aircraft?.setPanelDrawer(drawPanel);

  const flash = (text: string, level: MessageLevel = 'info', seconds = cfg.hud.flashSeconds, extraClass = '') => {
    const t = doc.createElement('div');
    t.className = `fsh-toast fsh-glass fsh-${level}${extraClass ? ` ${extraClass}` : ''}`;
    t.textContent = text;
    toastsEl.appendChild(t);
    toasts.push({ el: t, until: time + Math.max(0.1, Number.isFinite(seconds) ? seconds : cfg.hud.flashSeconds) });
    while (toasts.length > 3) toasts.shift()!.el.remove();
  };

  const drawInstruments = (r: InstrumentReadings) => {
    if (layout.clustersVisible) {
      for (const gs of gauges) {
        const s = gs.slot;
        let a = 0;
        let b = 0;
        switch (gs.kind) {
          case 0: a = Math.round(r.airspeedKt * 10); break;
          case 1: a = Math.round(r.pitchDeg * 20); b = Math.round(r.rollDeg * 20); break;
          case 2: a = Math.round(r.altitudeFt * 2); break;
          case 3: a = Math.round(r.headingDeg * 20); break;
          case 4: a = Math.round(r.verticalSpeedFpm); break;
          default: a = Math.round(r.rpm / 2); break;
        }
        if (!changed(s, a, b, 0, 0)) continue;
        const c = begin(s);
        if (c) gs.draw(c, s.w / 2, s.h / 2, s.w, r);
      }
    }
    const gearCode = r.gear === 'down' ? 0 : r.gear === 'up' ? 1 : 2;
    const engCode = r.engineStatus === 'RUNNING' ? 0 : r.engineStatus === 'STARTING' ? 1 : r.engineStatus === 'OFF' ? 2 : 3;
    const flags = gearCode + 4 * (r.gearLight === 'green' ? 0 : r.gearLight === 'red' ? 1 : 2) + 16 * (r.brakes ? 1 : 0) + 32 * (r.parkingBrake ? 1 : 0) + 64 * engCode;
    if (
      changed(
        stripSlot,
        Math.round(r.throttlePct) + 1000 * Math.round(r.trimPct + 100),
        Math.round(r.flapsDeg * 10) + 10000 * Math.round(r.flapsTargetDeg),
        flags,
        Math.round(r.rpm / 10),
      )
    ) {
      const c = begin(stripSlot);
      if (c) drawSystemsStrip(c, 0, 0, stripSlot.w, stripSlot.h, r, layout.stripRows);
    }
    if (changed(compassSlot, Math.round(r.headingDeg * 10), 0, 0, 0)) {
      const c = begin(compassSlot);
      if (c) drawCompassTape(c, 0, 0, compassSlot.w, compassSlot.h, r.headingDeg);
    }
  };

  const updateChip = (info: HudInfo) => {
    const fps = Number.isFinite(info.fps) ? Math.round(info.fps) : 0;
    const fpsText = `${fps} FPS`;
    if (chipFps.textContent !== fpsText) chipFps.textContent = fpsText;
    const target = cfg.render.targetFps;
    const cls = fps >= target * 0.9 ? 'fsh-fps-good' : fps >= target * 0.6 ? 'fsh-fps-ok' : 'fsh-fps-bad';
    if (chipFps.className !== cls) chipFps.className = cls;
    const cam = (CAMERA_NAME[info.cameraMode] ?? String(info.cameraMode)).toUpperCase();
    if (chipCam.textContent !== cam) chipCam.textContent = cam;
    if (chipTod.textContent !== info.timeOfDay) chipTod.textContent = info.timeOfDay;
    chipYoke.textContent = info.mouseYoke ? 'MOUSE YOKE' : '';
    chipYoke.hidden = !info.mouseYoke;
    yokeSep.hidden = !info.mouseYoke;
  };

  const update = (r: InstrumentReadings, info: HudInfo, dt: number) => {
    if (disposed) return;
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 1) : 0;
    time += step;

    // Camera mode drives the layout (cockpit view: the 3D panel shows the six-pack).
    const nextMode: HudMode = info.cameraMode === 'cockpit' ? (cfg.hud.cockpitGauges === 'compact' ? 'cockpitCompact' : 'cockpitHidden') : 'normal';
    if (nextMode !== mode) {
      mode = nextMode;
      applyLayout();
    }

    // Short confirmations when a setting changes.
    if (lastCamera !== null && info.cameraMode !== lastCamera) flash(`${CAMERA_NAME[info.cameraMode] ?? info.cameraMode} view`, 'info', 1.4);
    if (lastYoke !== null && info.mouseYoke !== lastYoke) flash(info.mouseYoke ? 'Mouse yoke ON — the mouse flies the aircraft' : 'Mouse yoke OFF', 'info');
    if (lastTod !== null && info.timeOfDay !== lastTod) flash(`Time of day — ${info.timeOfDay}`, 'info', 1.6);
    const light = typeof info.landingLight === 'boolean' ? info.landingLight : null;
    if (light !== null && lastLight !== null && light !== lastLight) flash(light ? 'Landing light ON' : 'Landing light OFF', 'info', 1.4);
    lastLight = light;
    const chipDirty = info.cameraMode !== lastCamera || info.mouseYoke !== lastYoke || info.timeOfDay !== lastTod;
    lastCamera = info.cameraMode;
    lastYoke = info.mouseYoke;
    lastTod = info.timeOfDay;

    if (visible) {
      drawInstruments(r);
      chipTimer += step;
      if (chipDirty || chipTimer >= 0.25) {
        chipTimer = 0;
        updateChip(info);
      }
    }

    // Annunciators; STALL and GEAR blink.
    const dim = Math.floor(time * cfg.hud.stallBlinkHz * 2) % 2 === 1;
    const gearDim = Math.floor(time * cfg.hud.gearWarning.blinkHz * 2) % 2 === 1;
    for (const a of anns) {
      const on = annunciationActive(a.id, r, cfg);
      if (on !== a.on) {
        a.on = on;
        a.el.hidden = !on;
      }
      const d = on && ((a.id === 'stall' && dim) || (a.id === 'gearUnsafe' && gearDim));
      if (d !== a.dim) {
        a.dim = d;
        a.el.classList.toggle('fsh-dim', d);
      }
    }

    if (info.paused !== pausedShown) {
      pausedShown = info.paused;
      pausedEl.hidden = !info.paused;
    }

    // Crash banner.
    const crash = info.state.crash;
    const reason = crash ? crash.reason : null;
    if (reason !== lastCrash) {
      lastCrash = reason;
      if (crash) {
        const t = crashText(crash);
        bannerTitle.textContent = t.title;
        bannerSub.textContent = t.hint;
      }
      bannerEl.hidden = !crash;
    }

    // Landing toast, once per touchdown.
    const td = info.state.touchdown;
    if (!td) lastTouchdown = null;
    else if (td.time !== lastTouchdown) {
      lastTouchdown = td.time;
      if (!crash) {
        const d = describeTouchdown(td);
        flash(d.text, d.level, cfg.hud.landingToastSeconds, 'fsh-landing');
      }
    }

    // Toast expiry (fade for the last 0.4 s).
    for (let i = toasts.length - 1; i >= 0; i--) {
      const t = toasts[i];
      if (time >= t.until) {
        t.el.remove();
        toasts.splice(i, 1);
      } else if (t.until - time < 0.4 && !t.el.classList.contains('fsh-out')) t.el.classList.add('fsh-out');
    }

    // Start hint for the first seconds after the loading veil has gone.
    if (!info.veil) hintTime += step;
    if (hintState < 2) {
      const left = cfg.hud.startHintSeconds - hintTime;
      if (left <= 0 || crash) {
        hintState = 2;
        hintEl.hidden = true;
      } else if (left < 0.5 && hintState === 0) {
        hintState = 1;
        hintEl.classList.add('fsh-out');
      }
    }
  };

  return {
    element: el,
    update,
    flash: (text, level, seconds) => flash(text, level, seconds),
    toggleHelp() {
      help.hidden = !help.hidden;
    },
    toggleVisible() {
      visible = !visible;
      instruments.hidden = !visible;
      if (visible) {
        for (const g of gauges) g.slot.dirty = true;
        stripSlot.dirty = true;
        compassSlot.dirty = true;
        chipTimer = Infinity;
      }
    },
    resize: applyLayout,
    dispose() {
      if (disposed) return;
      disposed = true;
      win.removeEventListener('resize', onResize);
      el.remove();
      removeHudStyle(doc);
    },
  };
}
