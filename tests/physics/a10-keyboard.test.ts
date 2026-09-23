/**
 * A-10C keyboard mission (functional): a "human on a keyboard" flies the whole sortie through the real
 * control system (src/input/controlSystem.ts updateControls with the A-10 config) — short proportional
 * key taps (pulse width within 0.25 s windows, like keyboard-takeoff.test.ts), never the physics
 * internals:
 *   W to full power, F (flaps MVR), roll, ↓ taps to rotate at Vr ≈ 120 KIAS, G (gear up) once climbing,
 *   V (flaps up), climb, level at 3,000 ft with ↑/↓ taps and ] / [ trim, S back to cruise power,
 *   a 45° left turn onto west and a right turn back to north, S to idle and a straight stall, recovery
 *   (↑ to unload, W full power), Shift+R (reset on final approach), fly the 3° glide at 140 KIAS,
 *   flare, touch down on runway 36, X (decelerons) + Space (brakes) to a stop.
 * Set A10_DEBUG=1 to print the flight log.
 */
import { describe, it, expect, vi } from 'vitest';
import { A10_AIRCRAFT, FT_TO_M, M_TO_FT } from '../../src/config';
import type { AircraftState } from '../../src/types';
import { approachControls, createApproachState, createInitialState, simStateLabel, step } from '../../src/physics';
import { createControlState, emptyInputFrame, resetControls, updateControls, type ControlState, type KeyPress } from '../../src/input/controlSystem';
import { A10_CFG, across, along, deg, DT, ias } from './a10-helpers';
import { headingError, RUNWAY_ENV } from './helpers';

vi.setConfig({ testTimeout: 120000 });

const log = (...a: unknown[]) => { if (process.env.A10_DEBUG) console.log(...a); };
const A = A10_AIRCRAFT;
const env = RUNWAY_ENV;

/** A keyboard pilot: holds keys for the next frame, taps proportional pulses, trims when the stick stays off-centre. */
class KeyboardPilot {
  cs: ControlState = createControlState(A10_CFG);
  s: AircraftState;
  held = new Set<string>();
  pressed: KeyPress[] = [];
  elevAvg = 0;
  /** The pilot "keeps pulling" until the attitude comes: an integral on the pitch error. */
  pitchI = 0;
  labels = new Set<string>();

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

  /** ↓/↑ taps toward a pitch attitude; gains fall with dynamic pressure (the stick gets heavier with speed). */
  pitch(target: number): void {
    const k = Math.min(1.5, (150 / Math.max(90, ias(this.s))) ** 2);
    const err = target - this.s.derived.pitchDeg;
    this.pitchI = Math.max(-0.5, Math.min(0.5, this.pitchI + 0.04 * k * err * DT));
    const u = k * (0.06 * err - 0.1 * deg(this.s.derived.q)) + this.pitchI;
    if (this.pulse(u)) this.held.add(u > 0 ? 'ArrowDown' : 'ArrowUp');
  }

  /** Pitch target that holds an altitude (m) with a vertical-speed limit (m/s); `vsBias` = the path's own climb rate. */
  altitude(targetY: number, maxVs = 12, vsBias = 0): void {
    const s = this.s;
    const vsWant = vsBias + Math.max(-maxVs, Math.min(maxVs, 0.08 * (targetY - s.position.y)));
    const V = Math.max(40, s.derived.tas);
    const gammaWant = deg(Math.asin(Math.max(-0.5, Math.min(0.5, vsWant / V))));
    this.pitch(deg(s.derived.alpha) * Math.cos((s.derived.rollDeg * Math.PI) / 180) + gammaWant + 0.6 * (vsWant - s.velocity.y));
  }

  /** ←/→ taps toward a bank angle. */
  bank(target: number): void {
    const u = 0.04 * (target - this.s.derived.rollDeg) - 0.02 * deg(this.s.derived.p);
    if (this.pulse(u)) this.held.add(u > 0 ? 'ArrowRight' : 'ArrowLeft');
  }

  /** Bank toward a heading (max bank), rolling out on it. */
  heading(target: number, maxBank = 45): void {
    this.bank(Math.max(-maxBank, Math.min(maxBank, -1.5 * headingError(this.s, target))));
  }

  /** W/S toward a throttle lever position. */
  throttle(target: number): void {
    const th = this.cs.controls.throttle;
    if (th < target - 0.01) this.held.add('KeyW');
    else if (th > target + 0.01) this.held.add('KeyS');
  }

  /** Where the pilot's throttle hand "rests" for the current speed target (slowly adjusted). */
  thrBase = -1;

  /** W/S toward an airspeed: a resting power setting, nudged slowly, plus a little for the error (the TF34s spool slowly). */
  speed(kt: number): void {
    const err = kt - ias(this.s);
    if (this.thrBase < 0) this.thrBase = this.cs.controls.throttle;
    this.thrBase = Math.max(0, Math.min(1, this.thrBase + 0.004 * err * DT));
    this.throttle(Math.max(0, Math.min(1, this.thrBase + 0.02 * err)));
  }

  /** ] / [ taps while the pilot has been holding the stick off-centre for a while. */
  trim(): void {
    if (Math.abs(this.elevAvg) > 0.03 && this.pulse(Math.min(0.3, Math.abs(this.elevAvg)))) this.held.add(this.elevAvg > 0 ? 'BracketRight' : 'BracketLeft');
  }

  /** Advance one physics step with the keys set for this frame. */
  step(): AircraftState {
    this.cs = updateControls(this.cs, { ...emptyInputFrame(), held: this.held, pressed: this.pressed }, DT, A10_CFG).state;
    this.s = step(this.s, this.cs.controls, DT, env, A10_CFG);
    this.elevAvg += (this.cs.controls.elevator - this.elevAvg) * (DT / 3);
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

describe('A-10 keyboard sortie', () => {
  it('take-off → climb → level at 3,000 ft → turns → stall + recovery → approach → landing, all on the keyboard', () => {
    const k = new KeyboardPilot(createInitialState(env, A10_CFG));
    const fmt = (s: AircraftState) => `t ${s.time.toFixed(0)} ${simStateLabel(s)} ${ias(s).toFixed(0)} KIAS ${(s.position.y * M_TO_FT).toFixed(0)} ft pitch ${s.derived.pitchDeg.toFixed(1)} bank ${s.derived.rollDeg.toFixed(1)} hdg ${s.derived.headingDeg.toFixed(0)} thr ${k.cs.controls.throttle.toFixed(2)} el ${k.cs.controls.elevator.toFixed(2)} trim ${k.cs.controls.elevatorTrim.toFixed(2)} gear ${s.gearPos.toFixed(2)} flaps ${s.flapsDeg.toFixed(0)}`;

    // ── Take-off: F (MVR), hold W, keep straight, rotate at Vr with ↓ taps toward 9°. ──
    k.press('KeyF');
    let rotateKt = 0;
    let liftoff: AircraftState | null = null;
    let gearUpAt = -1;
    let maxPitchGround = 0;
    const a0 = along(k.s);
    k.fly(80, () => {
      const s = k.s;
      k.throttle(1);
      if (!rotateKt && ias(s) >= A.limits.vrKt) rotateKt = ias(s);
      if (rotateKt) k.pitch(9);
      if (s.onGround) {
        const u = -0.08 * headingError(s, 0) - 0.03 * across(s);
        if (k.pulse(u)) k.held.add(u > 0 ? 'KeyD' : 'KeyA');
      } else k.bank(0);
      if (!liftoff && !s.onGround) liftoff = s;
      if (liftoff && gearUpAt < 0 && s.airborneTime > 2 && s.velocity.y > 2) { k.press('KeyG'); gearUpAt = s.time; }
    }, (s) => {
      if (s.onGround) maxPitchGround = Math.max(maxPitchGround, s.derived.pitchDeg);
      return gearUpAt > 0 && s.time > gearUpAt + 8;
    });
    expect(k.s.crash, k.s.crash?.reason).toBeNull();
    expect(liftoff).not.toBeNull();
    const lo = liftoff as unknown as AircraftState;
    const rollM = along(lo) - a0;
    log(`take-off: rotate ${rotateKt.toFixed(0)} KIAS, lift-off ${ias(lo).toFixed(0)} KIAS after ${rollM.toFixed(0)} m, max pitch on the wheels ${maxPitchGround.toFixed(1)}°`);
    log(fmt(k.s));
    expect(rotateKt).toBeGreaterThanOrEqual(119);
    expect(ias(lo)).toBeGreaterThan(122);
    expect(ias(lo)).toBeLessThan(150);
    expect(rollM).toBeGreaterThan(600);
    expect(rollM).toBeLessThan(1100);
    expect(maxPitchGround).toBeLessThan(10);

    // ── Climb: flaps up past 170 KIAS, pitch for ~200 KIAS, trim; level at 3,000 ft, S back to cruise power. ──
    const level = 3000 * FT_TO_M;
    let flapsUp = false;
    let climbPitch = 9;
    let vsSum = 0;
    let vsN = 0;
    k.fly(150, () => {
      const s = k.s;
      if (!flapsUp && ias(s) > 170) { k.press('KeyV'); flapsUp = true; }
      if (s.position.y < level - 150) {
        k.throttle(1);
        climbPitch = Math.max(3, Math.min(20, climbPitch + 0.3 * DT * (ias(s) - 200)));
        k.pitch(climbPitch);
      } else {
        k.speed(280);
        k.altitude(level);
      }
      k.bank(0);
      k.trim();
      if (s.position.y > 1000 * FT_TO_M && s.position.y < 2500 * FT_TO_M) { vsSum += s.velocity.y * 196.85; vsN++; }
    }, (s) => s.time > 60 && Math.abs(s.position.y - level) < 30 && Math.abs(s.velocity.y) < 1 && Math.abs(ias(s) - 280) < 15);
    const climbFpm = vsSum / Math.max(1, vsN);
    log(`climb: ${climbFpm.toFixed(0)} fpm mean from 1,000 to 2,500 ft; levelled: ${fmt(k.s)}`);
    expect(k.s.crash, k.s.crash?.reason).toBeNull();
    expect(k.s.gearPos).toBe(0);
    expect(k.s.flapsDeg).toBe(0);
    expect(climbFpm).toBeGreaterThan(3500);
    expect(climbFpm).toBeLessThan(7000);
    expect(Math.abs(k.s.position.y - level) * M_TO_FT).toBeLessThan(150);

    // ── Turns: 45° bank left onto west (270°), then right back to north, holding 3,000 ft. ──
    let maxDevFt = 0;
    let maxBank = 0;
    k.thrBase = -1;
    for (const hdg of [270, 0]) {
      k.fly(90, () => {
        k.heading(hdg, 45);
        k.altitude(level);
        k.speed(280);
        k.trim();
      }, (s) => {
        maxDevFt = Math.max(maxDevFt, Math.abs(s.position.y - level) * M_TO_FT);
        maxBank = Math.max(maxBank, Math.abs(s.derived.rollDeg));
        return Math.abs(headingError(s, hdg)) < 2 && Math.abs(s.derived.rollDeg) < 3;
      });
      log(`turned onto ${hdg}: ${fmt(k.s)}`);
      expect(Math.abs(headingError(k.s, hdg))).toBeLessThan(3);
    }
    log(`turns: max bank ${maxBank.toFixed(0)}°, max altitude deviation ${maxDevFt.toFixed(0)} ft`);
    expect(k.s.crash).toBeNull();
    expect(maxBank).toBeGreaterThan(35);
    expect(maxBank).toBeLessThan(60);
    expect(maxDevFt).toBeLessThan(400);

    // ── Stall: S to idle, hold the altitude as it slows, then hold ↓ until it breaks. ──
    let stallKt = 0;
    let noseUpFrom = -1;
    let noseUpPitch = 0;
    k.fly(120, () => {
      const s = k.s;
      k.throttle(0);
      // Hold the altitude (trimming) while it slows, then raise the nose ~1 °/s until it breaks.
      if (ias(s) > 130) {
        k.altitude(level);
        k.trim();
      } else {
        if (noseUpFrom < 0) { noseUpFrom = s.time; noseUpPitch = s.derived.pitchDeg; }
        k.pitch(noseUpPitch + 1 * (s.time - noseUpFrom));
      }
      k.bank(0);
    }, (s) => { if (s.stalled && !stallKt) stallKt = ias(s); return stallKt > 0 && s.time > 0; });
    const yStall = k.s.position.y;
    expect(k.labels.has('stalled')).toBe(true);
    log(`stalled at ${stallKt.toFixed(0)} KIAS: ${fmt(k.s)}`);
    // Recovery: ↑ to unload, W to full, wings level, ease out and climb back.
    let minY = yStall;
    let recoveredAt = -1;
    const tRec = k.t;
    k.fly(40, () => {
      const s = k.s;
      k.throttle(1);
      if (s.stalled) k.held.add('ArrowUp');
      else k.pitch(ias(s) > 150 ? 8 : 0);
      k.bank(0);
    }, (s) => {
      minY = Math.min(minY, s.position.y);
      if (recoveredAt < 0 && !s.stalled) recoveredAt = s.time - tRec;
      return recoveredAt > 0 && s.velocity.y > 5;
    });
    const lossFt = (yStall - minY) * M_TO_FT;
    log(`recovered after ${recoveredAt.toFixed(1)} s, lost ${lossFt.toFixed(0)} ft: ${fmt(k.s)}`);
    expect(stallKt).toBeGreaterThan(105);
    expect(stallKt).toBeLessThan(125);
    expect(k.s.crash).toBeNull();
    expect(recoveredAt).toBeGreaterThan(0);
    expect(recoveredAt).toBeLessThan(4);
    expect(lossFt).toBeLessThan(1000);

    // ── Shift+R: reset on final (as the app does), fly the glide at 140 KIAS, flare, land, stop. ──
    k.press('KeyR', true);
    k.step(); // the action is emitted; the app then resets:
    k.s = createApproachState(env, A10_CFG);
    k.cs = resetControls(k.cs, approachControls(A10_CFG));
    k.thrBase = -1;
    const aim = A.spawn.approach.aimPointM;
    let td: AircraftState | null = null;
    let sbPressed = false;
    k.fly(240, () => {
      const s = k.s;
      if (s.onGround || td) {
        k.throttle(0);
        if (!sbPressed) { k.press('KeyX'); sbPressed = true; }
        if (s.wheelContact[0]) k.held.add('Space');
        else k.pitch(0);
        const u = -0.08 * headingError(s, 0) - 0.05 * across(s);
        if (k.pulse(u)) k.held.add(u > 0 ? 'KeyD' : 'KeyA');
        return;
      }
      const h = s.derived.altitudeAGL + A.geometry.leftMainWheel.y;
      const glide = Math.max(0, Math.tan((3 * Math.PI) / 180) * (aim - along(s)));
      if (h > 14) {
        k.speed(h > 45 ? 140 : 130);
        const glideVs = -Math.tan((3 * Math.PI) / 180) * s.derived.groundSpeed;
        k.altitude(glide - A.geometry.leftMainWheel.y, 4, along(s) < aim ? glideVs : 0);
      } else {
        // Flare: idle, raise the nose progressively as the wheels near the runway.
        k.throttle(0);
        k.pitch(Math.min(7, 3 + 0.4 * (14 - h)));
      }
      k.bank(Math.max(-8, Math.min(8, -0.2 * across(s) - 1.0 * headingError(s, 0))));
    }, (s) => { if (!td && s.touchdown) td = s; return !!td && s.derived.groundSpeed < 0.5; });
    expect(k.s.crash, k.s.crash?.reason).toBeNull();
    expect(td).not.toBeNull();
    const t = (td as unknown as AircraftState).touchdown!;
    log(`landing: ${t.airspeedKt.toFixed(0)} KIAS ${t.verticalSpeedFpm.toFixed(0)} fpm pitch ${t.pitchDeg.toFixed(1)}° ${t.rating} at ${along(td as unknown as AircraftState).toFixed(0)} m; stopped ${along(k.s).toFixed(0)} m, ${across(k.s).toFixed(1)} m off the centreline`);
    expect(t.onRunway).toBe(true);
    expect(t.airspeedKt).toBeGreaterThan(110);
    expect(t.airspeedKt).toBeLessThan(140);
    expect(['butter', 'smooth', 'firm']).toContain(t.rating);
    expect(k.s.derived.groundSpeed).toBeLessThan(0.5);
    expect(Math.abs(across(k.s))).toBeLessThan(15);
    expect(['ground', 'landed']).toContain(simStateLabel(k.s));
  });
});
