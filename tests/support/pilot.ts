/**
 * A scripted pilot for mission-style functional tests: cascaded PID loops that
 * turn targets (pitch / bank / airspeed / vertical speed / altitude / heading /
 * runway centreline) into elevator, aileron, rudder and throttle, plus the
 * discrete controls (flaps, gear, brakes, engine).
 *
 *   const pilot = new ScriptedPilot();
 *   pilot.set({ vertical: { mode: 'speed', kt: 75 }, lateral: { mode: 'heading', deg: 360 }, throttle: 1 });
 *   const r = flyPhase(state, pilot, { env, seconds: 120, until: (s) => s.position.y > 500 });
 *
 * The pilot only reads the AircraftState (like a human reads the instruments)
 * and only writes Controls — it never touches the physics internals.
 */
import type { AircraftState, Controls, Environment } from '../../src/types';
import { CONFIG, MS_TO_KT, RAD_TO_DEG } from '../../src/config';
import { step, FLAT_ENV } from '../../src/physics';
import { runwayFrame, toRunwayCoords } from '../../src/world/runway';

export const DT = CONFIG.sim.fixedDt;
const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const wrap180 = (d: number) => {
  const w = ((d % 360) + 360) % 360;
  return w > 180 ? w - 360 : w;
};

export const iasKt = (s: AircraftState): number => s.derived.ias * MS_TO_KT;
export const fpm = (s: AircraftState): number => s.velocity.y * 196.8504;
export const altFt = (s: AircraftState): number => s.position.y * 3.280839895;

export type Vertical =
  | { mode: 'pitch'; deg: number }
  /** Pitch for airspeed (climbs/descents at a fixed power setting). */
  | { mode: 'speed'; kt: number }
  /** Vertical speed, m/s (+ up). */
  | { mode: 'vs'; ms: number }
  /** Altitude MSL, m. */
  | { mode: 'altitude'; m: number; maxVs?: number }
  /** Follow a straight glide path: height above the runway = tan(deg)·(distance to the aim point). */
  | { mode: 'glidepath'; deg: number; aimAlongM: number; fieldElev: number }
  /** Flare: sink rate proportional to the wheel height above the runway. */
  | { mode: 'flare'; fieldElev: number }
  /** Hold the elevator at a fixed deflection (e.g. hold the nose-wheel light on the roll). */
  | { mode: 'elevator'; value: number };

export type Lateral =
  | { mode: 'bank'; deg: number }
  | { mode: 'heading'; deg: number; maxBank?: number }
  /** Track the extended centreline of runway 36 (airborne: bank; on the ground: nosewheel/rudder). */
  | { mode: 'centreline' };

export type ThrottleCmd = number | { mode: 'speed'; kt: number };

export interface PilotSettings {
  vertical: Vertical;
  lateral: Lateral;
  throttle: ThrottleCmd;
  flapsNotch: number;
  gearDown: boolean;
  brake: number;
  parkingBrake: boolean;
  engineOn: boolean;
  elevatorTrim: number;
}

const DEFAULTS: PilotSettings = {
  vertical: { mode: 'pitch', deg: 0 },
  lateral: { mode: 'bank', deg: 0 },
  throttle: 0,
  flapsNotch: 0,
  gearDown: true,
  brake: 0,
  parkingBrake: false,
  engineOn: true,
  elevatorTrim: 0,
};

export class ScriptedPilot {
  settings: PilotSettings;
  private pitchI = 0;
  private pitchBias: number | null = null;
  private thrI = 0;
  private lastVertical = '';
  private readonly rw = runwayFrame();

  constructor(init: Partial<PilotSettings> = {}) {
    this.settings = { ...DEFAULTS, ...init };
    if (typeof this.settings.throttle === 'number') this.thrI = this.settings.throttle;
  }

  /**
   * Change targets. Switching the vertical mode re-seeds the outer-loop integrator from the current
   * pitch; a numeric throttle also seeds the auto-throttle for a later { mode: 'speed' }.
   */
  set(p: Partial<PilotSettings>): this {
    this.settings = { ...this.settings, ...p };
    if (typeof p.throttle === 'number') this.thrI = p.throttle;
    return this;
  }

  /** Pitch command (deg) from the vertical mode. */
  private pitchCommand(s: AircraftState, dt: number): number | null {
    const v = this.settings.vertical;
    const d = s.derived;
    const key = v.mode;
    if (key !== this.lastVertical) {
      this.lastVertical = key;
      this.pitchBias = d.pitchDeg;
    }
    const bias = this.pitchBias ?? d.pitchDeg;
    const vsLoop = (target: number, kp = 1.8, ki = 0.6) => {
      const err = target - s.velocity.y;
      this.pitchBias = clamp(bias + ki * err * dt, -10, 15);
      return clamp(this.pitchBias + kp * err, -12, 16);
    };
    switch (v.mode) {
      case 'elevator':
        return null;
      case 'pitch':
        return v.deg;
      case 'speed': {
        const err = iasKt(s) - v.kt; // fast → pitch up
        this.pitchBias = clamp(bias + 0.06 * err * dt, -10, 15);
        return clamp(this.pitchBias + 0.5 * err, -10, 16);
      }
      case 'vs':
        return vsLoop(v.ms);
      case 'altitude': {
        const maxVs = v.maxVs ?? 5;
        return vsLoop(clamp(0.12 * (v.m - s.position.y), -maxVs, maxVs));
      }
      case 'glidepath': {
        const c = toRunwayCoords(s.position.x, s.position.z, this.rw);
        const want = v.fieldElev + Math.tan((v.deg * Math.PI) / 180) * (v.aimAlongM - c.along);
        const gs = d.groundSpeed;
        const nominal = -Math.tan((v.deg * Math.PI) / 180) * gs;
        return vsLoop(clamp(nominal + 0.15 * (want - s.position.y), -6, 2));
      }
      case 'flare': {
        const h = Math.max(0, wheelHeight(s) - v.fieldElev);
        return vsLoop(-clamp(0.25 * h, 0.15, 2.5), 5, 2.5);
      }
    }
  }

  controls(s: AircraftState, dt = DT): Controls {
    const st = this.settings;
    const d = s.derived;

    // ── Longitudinal ──
    let elevator: number;
    const pc = this.pitchCommand(s, dt);
    if (pc === null) {
      elevator = (st.vertical as { value: number }).value;
      this.pitchI = 0;
    } else {
      const err = pc - d.pitchDeg;
      this.pitchI = clamp(this.pitchI + 0.03 * err * dt, -0.6, 0.6);
      elevator = clamp(0.07 * err - 0.045 * d.q * RAD_TO_DEG + this.pitchI, -1, 1);
    }

    // ── Lateral / directional ──
    let bankCmd = 0;
    let groundHeading: number | null = null;
    const lat = st.lateral;
    const rwCoords = toRunwayCoords(s.position.x, s.position.z, this.rw);
    const centrelineHeading = this.rw.headingDeg + clamp(-rwCoords.across * 0.25, -15, 15);
    if (lat.mode === 'bank') bankCmd = lat.deg;
    else if (lat.mode === 'heading') {
      const maxBank = lat.maxBank ?? 25;
      bankCmd = clamp(1.5 * wrap180(lat.deg - d.headingDeg), -maxBank, maxBank);
      groundHeading = lat.deg;
    } else {
      bankCmd = clamp(1.5 * wrap180(centrelineHeading - d.headingDeg), -15, 15);
      groundHeading = centrelineHeading;
    }
    let aileron = clamp(0.05 * (bankCmd - d.rollDeg) - 0.015 * d.p * RAD_TO_DEG, -1, 1);
    let rudder: number;
    if (s.onGround) {
      // Steer with the nosewheel/rudder toward the heading (or hold the current one), wings level.
      const hdg = groundHeading ?? this.rw.headingDeg;
      rudder = clamp(0.12 * wrap180(hdg - d.headingDeg) - 0.08 * d.r * RAD_TO_DEG, -1, 1);
      aileron = clamp(-0.05 * d.rollDeg, -1, 1);
    } else {
      // Coordination: rudder into the slip.
      rudder = clamp(0.06 * d.beta * RAD_TO_DEG, -1, 1);
    }

    // ── Throttle ──
    let throttle: number;
    if (typeof st.throttle === 'number') {
      throttle = st.throttle;
      this.thrI = throttle;
    } else {
      const err = st.throttle.kt - iasKt(s);
      this.thrI = clamp(this.thrI + 0.01 * err * dt, 0, 1);
      throttle = clamp(this.thrI + 0.05 * err, 0, 1);
    }

    return {
      throttle,
      elevator,
      aileron,
      rudder,
      elevatorTrim: st.elevatorTrim,
      flapsNotch: st.flapsNotch,
      gearDown: st.gearDown,
      brake: st.brake,
      parkingBrake: st.parkingBrake,
      engineOn: st.engineOn,
    };
  }
}

/** Height (m MSL) of the lowest main-wheel contact point, using the configured geometry. */
export function wheelHeight(s: AircraftState): number {
  const g = CONFIG.aircraft.geometry.leftMainWheel;
  const q = s.orientation;
  // Rotate the wheel offset (body) into world and take the y component.
  const tx = 2 * (q.y * g.z - q.z * g.y);
  const ty = 2 * (q.z * g.x - q.x * g.z);
  const tz = 2 * (q.x * g.y - q.y * g.x);
  const y = g.y + q.w * ty + (q.z * tx - q.x * tz);
  return s.position.y + y;
}

export interface PhaseStats {
  seconds: number;
  minY: number;
  maxY: number;
  maxAbsRoll: number;
  minIasKt: number;
  maxIasKt: number;
  stalledSeen: boolean;
  /** Sim time at which `until` first returned true, or null when the phase ran to its time limit. */
  metAt: number | null;
  labels: Set<string>;
}

export interface FlyOptions {
  env?: Environment;
  seconds: number;
  until?: (s: AircraftState) => boolean;
  each?: (s: AircraftState, c: Controls) => void;
}

/** Fly the pilot at the fixed physics rate until `until` is met or the time runs out. */
export function flyPhase(state: AircraftState, pilot: ScriptedPilot, opts: FlyOptions): { state: AircraftState; stats: PhaseStats } {
  const env = opts.env ?? FLAT_ENV;
  const n = Math.round(opts.seconds / DT);
  let s = state;
  const stats: PhaseStats = {
    seconds: 0, minY: s.position.y, maxY: s.position.y, maxAbsRoll: Math.abs(s.derived.rollDeg),
    minIasKt: iasKt(s), maxIasKt: iasKt(s), stalledSeen: false, metAt: null, labels: new Set(),
  };
  for (let i = 0; i < n; i++) {
    const c = pilot.controls(s);
    s = step(s, c, DT, env);
    stats.seconds += DT;
    stats.minY = Math.min(stats.minY, s.position.y);
    stats.maxY = Math.max(stats.maxY, s.position.y);
    stats.maxAbsRoll = Math.max(stats.maxAbsRoll, Math.abs(s.derived.rollDeg));
    stats.minIasKt = Math.min(stats.minIasKt, iasKt(s));
    stats.maxIasKt = Math.max(stats.maxIasKt, iasKt(s));
    if (s.stalled) stats.stalledSeen = true;
    stats.labels.add(s.phase === 'airborne' && s.stalled ? 'stalled' : s.phase);
    opts.each?.(s, c);
    if (opts.until?.(s)) {
      stats.metAt = s.time;
      break;
    }
    if (s.phase === 'crashed' && !opts.until) break;
  }
  return { state: s, stats };
}

/** Human-readable one-liner for assertion messages. */
export function describeState(s: AircraftState): string {
  const d = s.derived;
  return `t=${s.time.toFixed(1)}s phase=${s.phase}${s.stalled ? '(stalled)' : ''} ` +
    `alt=${altFt(s).toFixed(0)}ft agl=${(d.altitudeAGL * 3.2808).toFixed(0)}ft ias=${iasKt(s).toFixed(1)}kt ` +
    `vs=${fpm(s).toFixed(0)}fpm hdg=${d.headingDeg.toFixed(1)} pitch=${d.pitchDeg.toFixed(1)} roll=${d.rollDeg.toFixed(1)} ` +
    `pos=(${s.position.x.toFixed(0)},${s.position.z.toFixed(0)})${s.crash ? ` crash="${s.crash.reason}"` : ''}`;
}
