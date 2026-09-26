/**
 * HUD preview: a gradient sky/ground stand-in for the 3D view plus the HUD and the app chrome
 * (top bar, aircraft picker, pause menu), fed synthetic readings from URL parameters, e.g.
 *   &jet=1 → the F-16 head-up display (&mach=0.85 &ab=1 &beta=2 &sb=1 speed brake, &g=6.5)
 *   &glass=1 → the 747's airliner PFD + EICAS (&rpm=90 core %, &fpa=2 flight path, &state=ground)
 *   &marine=1 (or &style=marine) → the Princess V50's helm display: &stw=24.6 &sog=25.1 kt, &rpmp=2950
 *     &rpms=2980 (port / starboard rpm), &loadp=78 &loads=80 %, &lever=85 (−100…100), &drive=6 (deg,
 *     + starboard), &tabs=30 %, &trim=3.2 &heel=-4 deg, &depth=12.4 m (or &depth=deep), &planing=85 %,
 *     &moored=1 &aground=1 &engine=OFF; &cam=cockpit for the compact strip
 *   &menu=1 | &menu=controls → the pause menu open · &picker=1 → the aircraft picker open · &bar=0 → no top bar
 *   /preview/hud.html?ias=95&alt=3500&hdg=270&vs=500&pitch=4&roll=15
 *   &stall=1 &crash=1 &landing=smooth &cam=cockpit &help=1 &paused=1
 *   &flaps=20&flapsTarget=30 &gear=transit &thr=65 &rpm=2350 &trim=10
 *   &brake=1 &park=1 &engine=OFF &turn=3 &slip=0.4 &fps=60 &tod=Morning
 *   &yoke=1 &hud=0 &flash=text &animate=1
 *   &panel=1  → drawPanel() onto a 2048×1024 canvas shown full screen.
 *   &veil=boot|streaming|ready → the start-up loading veil, frozen in that state.
 * window.hudPreview exposes { hud, readings } for poking from DevTools.
 */
import { CONFIG, cloneConfig, V50_AIRCRAFT, type Config } from '../config';
import { leverGear } from '../ui/instruments';
import { createLoadingVeil } from '../ui/veil';
import type { AircraftState, CameraMode, EngineStatus, GearState, InstrumentReadings, TouchdownRecord } from '../types';
import { createHud } from '../ui/hud';
import { drawPanel } from '../ui/gauges';
import { createInitialState, defaultControls } from '../physics';
import { FLEET, getAircraftDef } from '../fleet';
import { createAircraftPicker } from '../ui/picker';
import { createMenu } from '../ui/menu';
import { createTopBar } from '../ui/topBar';
import { installUiStyle } from '../ui/uiStyle';
import { topBarHeight } from '../ui/topBar';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => {
  const v = q.get(k);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const flag = (k: string) => q.get(k) === '1' || q.get(k) === 'true';

const gear = (q.get('gear') as GearState | null) ?? 'down';
const jet = flag('jet');
const glass = !jet && flag('glass');
const marine = !jet && !glass && (flag('marine') || q.get('style') === 'marine');
const marineCfg: Config = { ...cloneConfig(), aircraft: structuredClone(V50_AIRCRAFT) };
const readings: InstrumentReadings & { gearHandleDown: boolean; betaDeg: number; flightPathDeg: number; speedBrake: boolean } = {
  mach: num('mach', jet ? 0.62 : 0.15),
  afterburner: num('ab', 0),
  betaDeg: num('beta', 0),
  flightPathDeg: num('fpa', 0),
  speedBrake: flag('sb'),
  airspeedKt: num('ias', 95),
  altitudeFt: num('alt', 3500),
  altitudeAglFt: num('agl', num('alt', 3500) - 98),
  headingDeg: num('hdg', 270),
  verticalSpeedFpm: num('vs', 350),
  pitchDeg: num('pitch', 3),
  rollDeg: num('roll', 12),
  slipSkid: num('slip', 0),
  turnRateDegPerSec: num('turn', num('roll', 12) / 10),
  throttlePct: num('thr', 65),
  rpm: num('rpm', glass ? 90 : 2350),
  engineStatus: ((q.get('engine') ?? 'RUNNING').toUpperCase() as EngineStatus),
  flapsDeg: num('flaps', 0),
  flapsTargetDeg: num('flapsTarget', num('flaps', 0)),
  gear,
  gearLight: gear === 'down' ? 'green' : gear === 'transit' ? 'red' : 'off',
  brakes: flag('brake'),
  parkingBrake: flag('park'),
  trimPct: num('trim', 10),
  stallWarning: flag('stall'),
  overspeed: num('ias', 95) > CONFIG.aircraft.limits.vneKt,
  aoaDeg: num('aoa', 4),
  gLoad: num('g', 1),
  groundSpeedKt: num('gs', num('ias', 95)),
  state: flag('crash') ? 'crashed' : flag('stall') ? 'stalled' : q.get('state') === 'ground' ? 'ground' : 'airborne',
  gearHandleDown: q.get('handle') ? q.get('handle') === 'down' : gear !== 'up',
};
if (marine) {
  // Synthetic helm readings (what src/ui/instruments.ts produces for a vessel).
  const lever = num('lever', 85);
  const depth = q.get('depth') === 'deep' ? null : num('depth', 12.4);
  const running = (q.get('engine') ?? 'RUNNING').toUpperCase() === 'RUNNING';
  readings.vessel = {
    speedKt: num('stw', 24.6),
    sogKt: num('sog', 25.1),
    rpm: [num('rpmp', running ? 2950 : 0), num('rpms', running ? 2980 : 0)],
    loadPct: [num('loadp', running ? 78 : 0), num('loads', running ? 80 : 0)],
    leverPct: lever,
    gear: leverGear(lever / 100, marineCfg.aircraft.watercraft?.neutralDetent ?? 0.08),
    steerDeg: num('drive', 6),
    tabsPct: num('tabs', 30),
    trimDeg: num('trim', 3.2),
    heelDeg: num('heel', -4),
    depthM: depth,
    planingPct: num('planing', 85),
    moored: flag('moored'),
    aground: flag('aground'),
  };
  Object.assign(readings, {
    airspeedKt: Math.abs(readings.vessel.speedKt), groundSpeedKt: readings.vessel.sogKt, rpm: Math.max(...readings.vessel.rpm),
    throttlePct: Math.abs(lever), pitchDeg: readings.vessel.trimDeg, rollDeg: readings.vessel.heelDeg, altitudeFt: 0, altitudeAglFt: 0,
    verticalSpeedFpm: 0, gear: 'down', gearLight: 'off', flapsDeg: 0, flapsTargetDeg: 0, stallWarning: false, overspeed: false,
    state: flag('crash') ? 'crashed' : 'afloat',
  });
}

const base = createInitialState();
let state: AircraftState = { ...base, time: 30, phase: flag('crash') ? 'crashed' : 'airborne' };
if (flag('crash')) {
  state = { ...state, crash: { time: 29, reason: q.get('reason') ?? 'Hit terrain', speedKt: 88, verticalSpeedFpm: -2400, position: { x: 0, y: 0, z: 0 } } };
}
const landing = q.get('landing');
if (landing) {
  const td: TouchdownRecord = {
    time: 28,
    verticalSpeedFpm: num('tdfpm', landing === 'butter' ? -90 : landing === 'smooth' ? -180 : landing === 'firm' ? -420 : -760),
    airspeedKt: 58,
    rating: landing as TouchdownRecord['rating'],
    bankDeg: 1,
    pitchDeg: 5,
    surface: q.get('surface') === 'grass' ? 'grass' : 'runway',
    onRunway: q.get('surface') !== 'grass',
    centerlineOffsetM: q.get('surface') === 'grass' ? null : num('offset', 3.2),
  };
  state = { ...state, phase: 'landed', onGround: true, touchdown: td };
}

// Stand-in 3D view: sky/ground rotated and shifted like the real horizon would be.
const scene = document.getElementById('scene')!;
scene.style.background = marine
  ? 'linear-gradient(180deg, #3a78bb 0%, #8cbde6 44%, #d7e6f1 49.6%, #2d6a8c 50.4%, #1d4d6b 62%, #0d2a40 100%)'
  : 'linear-gradient(180deg, #2f6fb4 0%, #7fb3e3 44%, #cfe0ee 49.6%, #6d7f4e 50.4%, #50623a 58%, #2f3b22 100%)';
const setHorizon = (pitch: number, roll: number) => {
  scene.style.transform = `rotate(${-roll}deg) translateY(${pitch * 0.9}vh)`;
};
setHorizon(readings.pitchDeg, readings.rollDeg);

const veilMode = q.get('veil');
if (veilMode) {
  // Loading veil frozen in a state: ?veil=boot|streaming|ready (it never auto-dismisses here).
  const cfg = cloneConfig();
  cfg.hud.veil.autoDismissS = 1e9;
  cfg.hud.veil.maxTotalS = 1e9;
  const v = createLoadingVeil(document, cfg);
  if (veilMode !== 'boot') v.mark(2);
  if (veilMode === 'ready') for (let i = 0; i < 60; i++) v.frame(1 / 60);
}

if (flag('panel')) {
  const c = document.getElementById('panel') as HTMLCanvasElement;
  c.style.display = 'block';
  c.width = num('pw', 2048);
  c.height = num('ph', 1024);
  const ctx = c.getContext('2d')!;
  drawPanel(ctx, c.width, c.height, readings);
  (window as unknown as { hudPreview: unknown }).hudPreview = { readings, redraw: () => drawPanel(ctx, c.width, c.height, readings) };
} else {
  const cameraMode = (q.get('cam') as CameraMode | null) ?? 'chase';
  const hud = createHud(document.getElementById('hud')!, {
    aircraft: { setPanelDrawer: () => undefined },
    style: jet ? 'jet' : glass ? 'glass' : marine ? 'marine' : 'steam',
    config: glass ? getAircraftDef('b747').config : marine ? marineCfg : undefined,
  });
  if (q.get('bar') !== '0') {
    // The app chrome with a stub host (nothing to reset or switch here).
    installUiStyle(document);
    const root = document.createElement('div');
    root.className = 'tfs-root';
    root.style.setProperty('--tfs-bar-h', `${topBarHeight(innerWidth)}px`);
    const items = FLEET.map((d) => ({ id: d.id, name: d.name, shortName: d.shortName, description: d.description, kind: d.kind ?? ('aircraft' as const) }));
    if (!items.some((i) => i.kind === 'vessel')) {
      items.push({ id: 'v50', name: 'Princess V50', shortName: 'V50', description: 'A 50 ft sports yacht on twin Volvo IPS pods — start at the marina berth.', kind: 'vessel' });
    }
    let current = jet ? 'f16' : glass ? 'b747' : marine ? 'v50' : 'c172rg';
    const picker = createAircraftPicker(document, { items, current, onSelect: (id) => picker.setCurrent((current = id)) });
    let paused = true;
    const menu = createMenu(document, {
      reset: () => undefined, selectAircraft: (id) => picker.setCurrent((current = id)), setPaused: (p) => (paused = p), isPaused: () => paused,
      setCamera: () => undefined, cameraMode: () => (q.get('cam') as CameraMode | null) ?? 'chase', setTimeOfDay: () => undefined, getTimeOfDay: () => 0,
      timeOfDayNames: CONFIG.atmosphere.timeOfDay.map((t) => t.name), fleet: () => items, currentAircraft: () => current,
      toggleSound: () => undefined, soundOn: () => true, toggleHud: () => hud.toggleVisible(), hudOn: () => hud.isVisible(),
      onOpenChange: (open) => hud.setMenuOpen(open),
    });
    const bar = createTopBar(document, {
      productName: CONFIG.menu.productName, fullName: CONFIG.menu.fullName, widgets: [picker.element], onMenu: () => (menu.isOpen() ? menu.close() : menu.open()),
    });
    root.append(bar.element, menu.element);
    document.getElementById('hud')!.appendChild(root);
    const m = q.get('menu');
    if (m) menu.open(m === 'controls' ? 'controls' : 'main');
    if (flag('picker')) picker.open();
  }
  if (flag('help')) hud.toggleHelp();
  if (q.get('hud') === '0') hud.toggleVisible();
  const flashText = q.get('flash');
  if (flashText) hud.flash(flashText, 'info', 60);
  const vesselState = marine
    ? { ...state, phase: (flag('crash') ? 'crashed' : 'afloat') as AircraftState['phase'], touchdown: null }
    : state;
  const info = () => ({
    cameraMode,
    paused: flag('paused'),
    fps: num('fps', 60),
    timeOfDay: q.get('tod') ?? CONFIG.atmosphere.timeOfDay[0].name,
    state: vesselState,
    controls: defaultControls(),
    mouseYoke: flag('yoke'),
  });
  const start = performance.now();
  let last = start;
  const animate = flag('animate');
  const frame = () => {
    const now = performance.now();
    const dt = (now - last) / 1000;
    last = now;
    if (animate && readings.vessel) {
      const t = (now - start) / 1000;
      const v = readings.vessel;
      v.leverPct = 100 * Math.sin(t * 0.25);
      v.gear = leverGear(v.leverPct / 100, 0.08);
      v.rpm = v.rpm.map((_, i) => 700 + 2900 * Math.abs(Math.sin(t * 0.25)) + 20 * i);
      v.loadPct = v.rpm.map((r) => (r / 3500) * 90);
      v.speedKt = 34 * Math.sin(t * 0.25);
      v.steerDeg = 25 * Math.sin(t * 0.7);
      v.heelDeg = 8 * Math.sin(t * 0.6);
      v.trimDeg = 4 * Math.sin(t * 0.3);
      v.depthM = 1 + 6 * (1 + Math.sin(t * 0.2));
      readings.headingDeg = (readings.headingDeg + dt * 6) % 360;
      setHorizon(v.trimDeg, v.heelDeg);
    } else if (animate) {
      const t = (now - start) / 1000;
      readings.airspeedKt = 95 + 25 * Math.sin(t * 0.5);
      readings.altitudeFt += readings.verticalSpeedFpm * (dt / 60);
      readings.headingDeg = (readings.headingDeg + dt * 6) % 360;
      readings.rollDeg = 20 * Math.sin(t * 0.4);
      readings.pitchDeg = 4 * Math.sin(t * 0.3);
      readings.turnRateDegPerSec = readings.rollDeg / 7;
      readings.verticalSpeedFpm = 800 * Math.sin(t * 0.3);
      readings.rpm = 2300 + 150 * Math.sin(t * 0.7);
      setHorizon(readings.pitchDeg, readings.rollDeg);
    }
    hud.update(readings, info(), dt);
    requestAnimationFrame(frame);
  };
  hud.update(readings, info(), 1 / 60);
  requestAnimationFrame(frame);
  (window as unknown as { hudPreview: unknown }).hudPreview = { hud, readings };
}
