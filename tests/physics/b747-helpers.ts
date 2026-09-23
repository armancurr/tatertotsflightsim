/**
 * Shared helpers for the Boeing 747-400 tests (tests/physics/b747*.test.ts): the fleet's 747 config,
 * a flyer on the runway world, small scripted-pilot loops, and a keyboard pilot that flies through
 * the real control system (src/input/controlSystem.ts) with short proportional key taps — like a
 * person on a keyboard, never the physics internals.
 */
import { B747_AIRCRAFT, CONFIG, MS_TO_KT, RAD_TO_DEG, type Config } from '../../src/config';
import type { AircraftState, Controls, Vec3 } from '../../src/types';
import { simStateLabel, step } from '../../src/physics';
import { bodyToWorld } from '../../src/physics/frames';
import { createControlState, emptyInputFrame, updateControls, type ControlState, type KeyPress } from '../../src/input/controlSystem';
import { runwayFrame, toRunwayCoords } from '../../src/world/runway';
import { getAircraftDef } from '../../src/fleet';
import { headingError, RUNWAY_ENV } from './helpers';

/** The 747's full config exactly as the fleet passes it to the physics. */
export const B747_CFG: Config = getAircraftDef('b747').config;
export const B = B747_AIRCRAFT;

export const DT = CONFIG.sim.fixedDt;
export const clamp1 = (v: number): number => Math.max(-1, Math.min(1, v));
export const ias = (s: AircraftState): number => s.derived.ias * MS_TO_KT;
export const tas = (s: AircraftState): number => s.derived.tas * MS_TO_KT;
export const fpm = (s: AircraftState): number => s.velocity.y * 196.8504;
export const deg = (rad: number): number => rad * RAD_TO_DEG;

const rw = runwayFrame(B747_CFG);
/** Distance along runway 36 from its threshold, and lateral offset (m). */
export const along = (s: AircraftState): number => toRunwayCoords(s.position.x, s.position.z, rw).along;
export const across = (s: AircraftState): number => toRunwayCoords(s.position.x, s.position.z, rw).across;

/** Height of a body-frame point above the flat runway world (y = 0), m. */
export function pointHeight(s: AircraftState, p: Vec3): number {
  return s.position.y + bodyToWorld(s.orientation, p).y;
}
const TAIL_POINTS = B.geometry.structuralPoints.filter((p) => p.name === 'tailBumper' || p.name === 'tailcone');
/** Clearance of the tail (aft-body bumper or tailcone, whichever is lower) above the runway, m. */
export const tailClearance = (s: AircraftState): number => Math.min(...TAIL_POINTS.map((p) => pointHeight(s, p)));

export interface FlyOpts {
  each?: (s: AircraftState, c: Controls) => void;
  until?: (s: AircraftState) => boolean;
}

/** Fly the 747 on the runway world at 120 Hz with a pilot function, stopping on a crash or `until`. */
export function fly747(s0: AircraftState, pilot: Controls | ((s: AircraftState) => Controls), seconds: number, opts: FlyOpts = {}): AircraftState {
  let s = s0;
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    const c = typeof pilot === 'function' ? pilot(s) : pilot;
    s = step(s, c, DT, RUNWAY_ENV, B747_CFG);
    opts.each?.(s, c);
    if (s.crash || opts.until?.(s)) break;
  }
  return s;
}

/** Aileron that holds a bank angle (deg), with roll-rate damping (big roll inertia, slow roll). */
export const bankTo = (s: AircraftState, bankDeg: number): number =>
  clamp1(0.05 * (bankDeg - s.derived.rollDeg) - 0.06 * deg(s.derived.p));

/** Elevator that holds a pitch attitude (deg), with pitch-rate damping. */
export const pitchTo = (s: AircraftState, pitchDeg: number): number =>
  clamp1(0.06 * (pitchDeg - s.derived.pitchDeg) - 0.2 * deg(s.derived.q));

/**
 * A keyboard pilot: holds keys for the next frame, taps proportional pulses (pulse width within
 * 0.25 s windows), trims with ] / [ when the column stays off-centre. Everything goes through
 * updateControls with the 747 config.
 */
export class KeyboardPilot {
  cs: ControlState = createControlState(B747_CFG);
  s: AircraftState;
  held = new Set<string>();
  pressed: KeyPress[] = [];
  elevAvg = 0;
  /** The pilot "keeps pulling" until the attitude comes: an integral on the pitch error. */
  pitchI = 0;
  labels = new Set<string>();
  /** Where the throttle hand rests for the current speed target (slowly adjusted). */
  thrBase = -1;
  /** What the pilot "knows" from the last seconds: the average angle of attack (deg) and the airspeed trend (kt/s). */
  alphaAvg = NaN;
  iasRate = 0;
  private iasPrev = NaN;

  constructor(s: AircraftState) {
    this.s = s;
  }

  get t(): number {
    return this.s.time;
  }

  /** True during the first |u| fraction of each 0.25 s window. */
  pulse(u: number): boolean {
    return (this.t * 4) % 1 < Math.min(1, Math.abs(u));
  }

  press(code: string, shift = false): void {
    this.pressed.push({ code, shift } as KeyPress);
  }

  /** The pilot's "hands": column gains fall with dynamic pressure (the column gets heavier with speed). */
  gain(): number {
    return Math.min(1.5, (160 / Math.max(110, ias(this.s))) ** 2);
  }

  /**
   * ↓/↑ taps toward a pitch attitude. `u` is the column position the pilot wants; a tap of duty d
   * moves the column ≈ d² on average (it ramps while held and eases back when released), so the tap
   * duty is √|u|.
   */
  pitch(target: number): void {
    const k = this.gain();
    const err = target - this.s.derived.pitchDeg;
    const iMax = 0.05 + 0.2 * k;
    this.pitchI = Math.max(-iMax, Math.min(iMax, this.pitchI + 0.012 * k * err * DT));
    const u = k * (0.035 * err - 0.12 * deg(this.s.derived.q)) + this.pitchI;
    if (this.pulse(Math.sqrt(Math.abs(u)))) this.held.add(u > 0 ? 'ArrowDown' : 'ArrowUp');
  }

  /** Pitch target that holds an altitude (m) with a vertical-speed limit (m/s); `vsBias` = the path's own climb rate. */
  altitude(targetY: number, maxVs = 12, vsBias = 0): void {
    const s = this.s;
    const vsWant = vsBias + Math.max(-maxVs, Math.min(maxVs, 0.06 * (targetY - s.position.y)));
    const V = Math.max(40, s.derived.tas);
    const gammaWant = deg(Math.asin(Math.max(-0.5, Math.min(0.5, vsWant / V))));
    const a = Number.isFinite(this.alphaAvg) ? this.alphaAvg : deg(s.derived.alpha);
    this.pitch(a * Math.cos((s.derived.rollDeg * Math.PI) / 180) + gammaWant + 0.25 * (vsWant - s.velocity.y));
  }

  /** ←/→ taps toward a bank angle. */
  bank(target: number): void {
    const u = 0.05 * (target - this.s.derived.rollDeg) - 0.08 * deg(this.s.derived.p);
    if (this.pulse(u)) this.held.add(u > 0 ? 'ArrowRight' : 'ArrowLeft');
  }

  /** Bank toward a heading (max bank), rolling out on it. */
  heading(target: number, maxBank = 30): void {
    this.bank(Math.max(-maxBank, Math.min(maxBank, -1.5 * headingError(this.s, target))));
  }

  /** A/D taps to keep the nose on a runway heading and the centreline (on the ground). */
  track(courseDeg = 0): void {
    const u = -0.1 * headingError(this.s, courseDeg) - 0.04 * across(this.s);
    if (this.pulse(u)) this.held.add(u > 0 ? 'KeyD' : 'KeyA');
  }

  /** W/S toward a throttle lever position. */
  throttle(target: number): void {
    const th = this.cs.controls.throttle;
    if (th < target - 0.01) this.held.add('KeyW');
    else if (th > target + 0.01) this.held.add('KeyS');
  }

  /** W/S toward an airspeed: a resting power setting, nudged slowly, plus a little for the error (the fans spool slowly). */
  speed(kt: number): void {
    const err = kt - ias(this.s);
    if (this.thrBase < 0) this.thrBase = this.cs.controls.throttle;
    this.thrBase = Math.max(0, Math.min(1, this.thrBase + 0.002 * err * DT));
    this.throttle(Math.max(0, Math.min(1, this.thrBase + 0.012 * err - 0.08 * this.iasRate)));
  }

  /** ] / [ taps while the pilot has been holding the column off-centre for a while. */
  trim(): void {
    if (Math.abs(this.elevAvg) > 0.03 && this.pulse(Math.min(0.3, Math.abs(this.elevAvg)) * Math.min(1, this.gain()))) this.held.add(this.elevAvg > 0 ? 'BracketRight' : 'BracketLeft');
  }

  /** Advance one physics step with the keys set for this frame. */
  step(): AircraftState {
    this.cs = updateControls(this.cs, { ...emptyInputFrame(), held: this.held, pressed: this.pressed }, DT, B747_CFG).state;
    this.s = step(this.s, this.cs.controls, DT, RUNWAY_ENV, B747_CFG);
    this.elevAvg += (this.cs.controls.elevator - this.elevAvg) * (DT / 3);
    const a = deg(this.s.derived.alpha);
    this.alphaAvg = Number.isFinite(this.alphaAvg) ? this.alphaAvg + (a - this.alphaAvg) * (DT / 3) : a;
    const v = ias(this.s);
    if (Number.isFinite(this.iasPrev)) this.iasRate += ((v - this.iasPrev) / DT - this.iasRate) * (DT / 1);
    this.iasPrev = v;
    this.labels.add(simStateLabel(this.s));
    this.held = new Set();
    this.pressed = [];
    return this.s;
  }

  /** Fly `seconds` with a per-frame key script, stopping on a crash or `until`. */
  fly(seconds: number, keys: () => void, until?: (s: AircraftState) => boolean): AircraftState {
    for (let i = 0; i < Math.round(seconds / DT); i++) {
      keys();
      this.step();
      if (this.s.crash || until?.(this.s)) break;
    }
    return this.s;
  }
}
