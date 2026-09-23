/**
 * Boeing 747-400 flight deck — what the displays show (pure). One lumped engine in the sim becomes
 * four PW4056 readouts: N1 / EGT / N2 / fuel flow / oil from the core speed (instruments.rpm, the
 * N2 %) with small fixed engine-to-engine differences, the fuel totaliser counts down with the fuel
 * flow, and the V-speeds / flap manoeuvre speeds / placards come from the aircraft config. N1 and the
 * V-speeds use the same functions as the glass HUD overlay (src/ui/glassHud.ts), so both read alike.
 *
 * `updateDeckReadings` writes into a preallocated `DeckReadings` (no allocations); every number is
 * finite and inside the range its display can show, whatever the visual state holds.
 */
import type { AircraftVisualState } from '../types';
import type { AircraftConfig, Config } from '../../config';
import { B747_AIRCRAFT, CONFIG } from '../../config';
import { engineN1, glassVSpeeds } from '../../ui/glassHud';

export interface EngineReadout {
  /** % */
  n1: number;
  /** °C */
  egt: number;
  /** % */
  n2: number;
  /** × 1000 kg/h */
  ff: number;
  /** psi, °C, quarts, units */
  oilP: number;
  oilT: number;
  oilQ: number;
  vib: number;
}

export interface DeckReadings {
  ias: number;
  mach: number;
  altFt: number;
  aglFt: number;
  vsFpm: number;
  pitch: number;
  roll: number;
  hdg: number;
  /** Ground track, deg (heading + drift; here = heading unless the ground speed says otherwise). */
  track: number;
  gsKt: number;
  tasKt: number;
  /** Flight path angle, deg (+ up). */
  fpa: number;
  /** Slip/skid -1..1 (+ ball right). */
  slip: number;
  onGround: boolean;
  running: boolean;
  starting: boolean;
  engines: [EngineReadout, EngineReadout, EngineReadout, EngineReadout];
  /** Thrust reference (the green N1 target) and its mode label. */
  n1Ref: number;
  thrustMode: string;
  flapsDeg: number;
  flapsTargetDeg: number;
  gear: 'down' | 'up' | 'transit';
  gearHandleDown: boolean;
  speedBrake: boolean;
  parkingBrake: boolean;
  /** Total fuel, tonnes (× 1000 kg). */
  fuelT: number;
  tat: number;
  /** V-speeds and bugs, kt. */
  v1: number;
  vr: number;
  v2: number;
  vref: number;
  /** Selected (MCP) speed, altitude, heading. */
  selSpd: number;
  selAlt: number;
  selHdg: number;
  /** Top of the red/black barber pole (max speed for the configuration) and the stall speed. */
  vmax: number;
  vstall: number;
  /** Minimum manoeuvring speed (top of the amber band). */
  vminMan: number;
  /** World position (m, +X east, +Z south) for the map. */
  x: number;
  z: number;
  /** Seconds (flashing, clocks). */
  time: number;
  stall: boolean;
  overspeed: boolean;
  /** EICAS alert/memo lines (fixed pool; `alertCount` are valid): text + level 0 memo, 1 caution, 2 warning. */
  alerts: { text: string; level: number }[];
  alertCount: number;
}

const ENGINE_BIAS = [
  { n1: -0.3, egt: -7, n2: -0.2, ff: -0.03, oilP: 2, oilT: -3, oilQ: 0.5, vib: 0.1 },
  { n1: 0.2, egt: 5, n2: 0.3, ff: 0.02, oilP: -1, oilT: 2, oilQ: -0.3, vib: -0.1 },
  { n1: 0.0, egt: 2, n2: 0.1, ff: 0.0, oilP: 0, oilT: 0, oilQ: 0.2, vib: 0.2 },
  { n1: 0.4, egt: 9, n2: 0.4, ff: 0.04, oilP: 1, oilT: 4, oilQ: -0.5, vib: 0.0 },
] as const;

/** PW4056-class engine map from the core fraction (0 idle … 1 takeoff). */
export const ENGINE_MAP = { n1Idle: 22.4, n1Max: 100.8, egtIdle: 365, egtMax: 598, egtRed: 650, n1Red: 111.4, n2Idle: 60, n2Max: 100, ffIdle: 0.55, ffMax: 9.1, fuelStartT: 41.2 } as const;

/** 747-400 flap placard speeds (kt) by flap angle; gear-down limit is config.gear.vleKt. */
const FLAP_PLACARD: readonly [number, number][] = [
  [1, 280],
  [5, 260],
  [10, 240],
  [20, 230],
  [25, 205],
  [30, 180],
];

const fin = (x: unknown, d = 0): number => (typeof x === 'number' && Number.isFinite(x) ? x : d);
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const wrap360 = (d: number): number => {
  const h = ((fin(d) % 360) + 360) % 360;
  return h >= 360 ? 0 : h;
};

export function createDeckReadings(): DeckReadings {
  const eng = (): EngineReadout => ({ n1: 0, egt: 15, n2: 0, ff: 0, oilP: 0, oilT: 15, oilQ: 18, vib: 0 });
  return {
    ias: 0, mach: 0, altFt: 0, aglFt: 0, vsFpm: 0, pitch: 0, roll: 0, hdg: 0, track: 0, gsKt: 0, tasKt: 0, fpa: 0, slip: 0,
    onGround: true, running: false, starting: false,
    engines: [eng(), eng(), eng(), eng()],
    n1Ref: 100.8, thrustMode: 'TO',
    flapsDeg: 0, flapsTargetDeg: 0, gear: 'down', gearHandleDown: true, speedBrake: false, parkingBrake: false,
    fuelT: ENGINE_MAP.fuelStartT, tat: 15,
    v1: 145, vr: 150, v2: 162, vref: 150, selSpd: 162, selAlt: 5000, selHdg: 360,
    vmax: 365, vstall: 115, vminMan: 140,
    x: 0, z: 0, time: 0, stall: false, overspeed: false,
    alerts: Array.from({ length: 6 }, () => ({ text: '', level: 0 })),
    alertCount: 0,
  };
}

/** Core fraction (0 idle … 1 max) from the core speed (N2 %) of the sim's jet model. */
export function coreFromN2(n2: number, cfg: AircraftConfig = B747_AIRCRAFT): number {
  const lo = fin(cfg.engine.idleRpm, 60);
  const hi = fin(cfg.engine.maxRpm, 100);
  const s = clamp((fin(n2) - lo) / Math.max(1e-6, hi - lo), 0, 1);
  return s * s;
}

/** Max speed for a flap angle / gear (the top of the barber pole). */
export function maxSpeedFor(flapsDeg: number, gearDown: boolean, cfg: AircraftConfig = B747_AIRCRAFT): number {
  let v = fin(cfg.limits.vneKt, 365);
  const f = clamp(fin(flapsDeg), 0, 30);
  for (const [deg, kt] of FLAP_PLACARD) if (f >= deg - 0.5) v = Math.min(v, kt);
  if (gearDown) v = Math.min(v, fin(cfg.gear.vleKt, 270));
  return v;
}

const configs = new WeakMap<AircraftConfig, Config>();
const fullConfig = (cfg: AircraftConfig): Config => {
  let c = configs.get(cfg);
  if (!c) configs.set(cfg, (c = { ...CONFIG, aircraft: cfg }));
  return c;
};

export function updateDeckReadings(o: DeckReadings, v: AircraftVisualState, pos: { x: number; z: number } | null, dt: number, cfg: AircraftConfig = B747_AIRCRAFT): DeckReadings {
  const full = fullConfig(cfg);
  const r = v.instruments as (Partial<Record<string, unknown>> | null);
  const num = (k: string, d = 0) => fin(r?.[k], d);
  const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 1) : 0;
  o.time = clamp(fin(v.time), 0, 1e7);
  o.ias = clamp(num('airspeedKt'), 0, 999);
  o.mach = clamp(num('mach'), 0, 2);
  o.altFt = clamp(num('altitudeFt'), -2000, 99999);
  o.aglFt = clamp(num('altitudeAglFt'), 0, 99999);
  o.vsFpm = clamp(num('verticalSpeedFpm'), -9999, 9999);
  o.pitch = clamp(num('pitchDeg'), -90, 90);
  o.roll = clamp(num('rollDeg'), -180, 180);
  o.hdg = wrap360(num('headingDeg'));
  o.gsKt = clamp(num('groundSpeedKt'), 0, 999);
  o.tasKt = clamp(o.ias * (1 + o.altFt / 1000 * 0.017), 0, 999);
  o.track = o.hdg;
  o.fpa = clamp(num('flightPathDeg', o.pitch), -30, 30);
  o.slip = clamp(num('slipSkid'), -1, 1);
  o.onGround = r?.onGround === true || (r?.onGround === undefined && o.aglFt < 8);
  o.stall = r?.stallWarning === true && !o.onGround;
  o.overspeed = r?.overspeed === true;
  const status = typeof r?.engineStatus === 'string' ? r.engineStatus : v.engineRunning ? 'RUNNING' : 'OFF';
  o.running = status === 'RUNNING';
  o.starting = status === 'STARTING';
  const n2 = clamp(num('rpm', fin(v.propRpm)), 0, 110);
  const core = o.running ? coreFromN2(n2, cfg) : 0;
  const M = ENGINE_MAP;
  const spin = o.running ? 1 : clamp(n2 / M.n2Idle, 0, 1);
  for (let i = 0; i < 4; i++) {
    const e = o.engines[i];
    const b = ENGINE_BIAS[i];
    e.n2 = clamp(n2 + (n2 > 1 ? b.n2 : 0), 0, 110);
    e.n1 = clamp(engineN1(n2, o.running ? 'RUNNING' : o.starting ? 'STARTING' : 'OFF', i, full), 0, 115);
    e.egt = clamp(o.running ? M.egtIdle + (M.egtMax - M.egtIdle) * Math.pow(core, 0.8) + b.egt : 15 + spin * 180, -60, 999);
    e.ff = clamp(o.running ? M.ffIdle + (M.ffMax - M.ffIdle) * core + b.ff : o.starting ? 0.3 : 0, 0, 20);
    e.oilP = clamp(o.running ? 90 + 70 * core + b.oilP : spin * 40, 0, 200);
    e.oilT = clamp(o.running ? 80 + 45 * core + b.oilT : 15, -60, 200);
    e.oilQ = clamp(18 + b.oilQ, 0, 30);
    e.vib = clamp(o.running ? 0.3 + 0.6 * core + b.vib : 0, 0, 5);
  }
  if (step > 0) {
    let ff = 0;
    for (const e of o.engines) ff += e.ff;
    o.fuelT = clamp(o.fuelT - (ff * step) / 3600, 0, 200);
  }
  o.thrustMode = o.onGround || (o.altFt < 3000 && o.vsFpm > 300) ? 'TO' : 'CLB';
  o.n1Ref = o.thrustMode === 'TO' ? M.n1Max : 97.6;
  o.tat = clamp(15 - o.altFt * 0.00198 + (o.tasKt / 100) ** 2 * 0.5, -70, 60);
  o.flapsDeg = clamp(num('flapsDeg', fin(v.flapsDeg)), 0, 40);
  o.flapsTargetDeg = clamp(num('flapsTargetDeg', o.flapsDeg), 0, 40);
  const gearPos = clamp(fin(v.gearPos, 1), 0, 1);
  o.gear = gearPos >= 0.999 ? 'down' : gearPos <= 0.001 ? 'up' : 'transit';
  o.gearHandleDown = typeof r?.gearHandleDown === 'boolean' ? (r.gearHandleDown as boolean) : gearPos > 0.5;
  o.speedBrake = r?.speedBrake === true || fin(v.speedBrake) > 0.5;
  o.parkingBrake = r?.parkingBrake === true;

  const L = cfg.limits;
  const vsp = glassVSpeeds(full);
  o.vr = Math.round(fin(vsp.vr, 150));
  o.v1 = Math.round(fin(vsp.v1, o.vr - 6));
  o.v2 = o.vr + 12;
  o.vref = Math.round(fin(vsp.vref, 150));
  const fl = clamp(o.flapsDeg / 30, 0, 1);
  o.vstall = fin(L.vs1Kt, 140) + (fin(L.vsoKt, 115) - fin(L.vs1Kt, 140)) * fl;
  o.vminMan = o.vstall * 1.2;
  o.vmax = maxSpeedFor(o.flapsDeg, o.gear !== 'up', cfg);
  o.selSpd = o.onGround ? o.v2 : o.flapsTargetDeg >= 20 ? o.vref + 5 : o.altFt < 10000 ? 250 : 300;
  o.selAlt = o.altFt < 4500 ? 5000 : o.altFt < 9500 ? 10000 : Math.min(41000, Math.ceil((o.altFt + 500) / 1000) * 1000);
  o.selHdg = o.onGround ? Math.round(o.hdg / 10) * 10 || 360 : Math.round(o.hdg / 5) * 5 || 360;
  o.x = clamp(fin(pos?.x), -1e6, 1e6);
  o.z = clamp(fin(pos?.z), -1e6, 1e6);

  // EICAS alerts and memos (warnings first).
  let n = 0;
  const push = (text: string, level: number) => {
    if (n < o.alerts.length) {
      o.alerts[n].text = text;
      o.alerts[n].level = level;
      n++;
    }
  };
  if (o.overspeed) push('OVERSPEED', 2);
  if (r?.gearUnsafe === true) push('CONFIG GEAR', 2);
  if (!o.running && !o.starting) push('ENG 1 2 3 4 SHUTDOWN', 1);
  if (o.speedBrake && !o.onGround) push('SPEEDBRAKE EXT', 1);
  if (o.parkingBrake) push('PARK BRAKE SET', 0);
  if (o.starting) push('ENG START', 0);
  o.alertCount = n;
  return o;
}
