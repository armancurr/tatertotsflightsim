/**
 * HUD preview: a gradient sky/ground stand-in for the 3D view plus the HUD,
 * fed synthetic readings from URL parameters, e.g.
 *   /preview/hud.html?ias=95&alt=3500&hdg=270&vs=500&pitch=4&roll=15
 *   &stall=1 &crash=1 &landing=smooth &cam=cockpit &help=1 &paused=1
 *   &flaps=20&flapsTarget=30 &gear=transit &thr=65 &rpm=2350 &trim=10
 *   &brake=1 &park=1 &engine=OFF &turn=3 &slip=0.4 &fps=60 &tod=Morning
 *   &yoke=1 &hud=0 &flash=text &animate=1
 *   &panel=1  → drawPanel() onto a 2048×1024 canvas shown full screen.
 * window.hudPreview exposes { hud, readings } for poking from DevTools.
 */
import { CONFIG } from '../config';
import type { AircraftState, CameraMode, EngineStatus, GearState, InstrumentReadings, TouchdownRecord } from '../types';
import { createHud } from '../ui/hud';
import { drawPanel } from '../ui/gauges';
import { createInitialState, defaultControls } from '../physics';

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => {
  const v = q.get(k);
  const n = v === null ? NaN : Number(v);
  return Number.isFinite(n) ? n : d;
};
const flag = (k: string) => q.get(k) === '1' || q.get(k) === 'true';

const gear = (q.get('gear') as GearState | null) ?? 'down';
const readings: InstrumentReadings & { gearHandleDown: boolean } = {
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
  rpm: num('rpm', 2350),
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
  state: flag('crash') ? 'crashed' : flag('stall') ? 'stalled' : 'airborne',
  gearHandleDown: q.get('handle') ? q.get('handle') === 'down' : gear !== 'up',
};

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
scene.style.background = 'linear-gradient(180deg, #2f6fb4 0%, #7fb3e3 44%, #cfe0ee 49.6%, #6d7f4e 50.4%, #50623a 58%, #2f3b22 100%)';
const setHorizon = (pitch: number, roll: number) => {
  scene.style.transform = `rotate(${-roll}deg) translateY(${pitch * 0.9}vh)`;
};
setHorizon(readings.pitchDeg, readings.rollDeg);

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
  });
  if (flag('help')) hud.toggleHelp();
  if (q.get('hud') === '0') hud.toggleVisible();
  const flashText = q.get('flash');
  if (flashText) hud.flash(flashText, 'info', 60);
  const info = () => ({
    cameraMode,
    paused: flag('paused'),
    fps: num('fps', 60),
    timeOfDay: q.get('tod') ?? CONFIG.atmosphere.timeOfDay[0].name,
    state,
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
    if (animate) {
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
