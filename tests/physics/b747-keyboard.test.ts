/**
 * Boeing 747-400 keyboard sortie (functional): a "human on a keyboard" flies the whole mission through
 * the real control system (src/input/controlSystem.ts updateControls with the 747 config) — short
 * proportional key taps, never the physics internals:
 *   F F (flaps 10), ] taps (take-off trim), W to full thrust, A/D on the centreline, ↓ taps to rotate at
 *   Vr 145 KIAS toward 8°, G (gear up) once climbing, V V (flaps up) past 200 KIAS, climb and level at
 *   5,000 ft with ↑/↓ taps and ] / [ trim, S back to cruise power, a 30° left turn onto west and a right
 *   turn back to north, S to idle and a straight stall (stick shaker, nose-down break), recovery (↑ to
 *   unload, W), Shift+R (reset on final approach: flaps 30, gear down, trimmed), fly the 3° glide at
 *   Vref + 5, flare, touch down on runway 36, Space (brakes; the ground spoilers deploy at idle) to a stop.
 * Set B747_DEBUG=1 to print the flight log.
 */
import { describe, it, expect, vi } from 'vitest';
import { FT_TO_M, M_TO_FT } from '../../src/config';
import type { AircraftState } from '../../src/types';
import { approachControls, createApproachState, createInitialState, simStateLabel, stallAlphaRad } from '../../src/physics';
import { resetControls } from '../../src/input/controlSystem';
import { across, along, B, B747_CFG, deg, DT, ias, KeyboardPilot, tailClearance } from './b747-helpers';
import { headingError, RUNWAY_ENV } from './helpers';

vi.setConfig({ testTimeout: 120000 });

const log = (...a: unknown[]) => { if (process.env.B747_DEBUG) console.log(...a); };
const env = RUNWAY_ENV;
const fmtShort = (s: AircraftState) => `t ${s.time.toFixed(0)} ${simStateLabel(s)} ${ias(s).toFixed(0)} KIAS ${(s.position.y * M_TO_FT).toFixed(0)} ft pitch ${s.derived.pitchDeg.toFixed(1)}`;

/** Line up with flaps 10, full thrust, and at Vr hold ↓ for `holdS` seconds, then let go; fly 15 s. */
function yank(holdS: number) {
  const k = new KeyboardPilot(createInitialState(env, B747_CFG));
  k.press('KeyF');
  k.fly(0.2, () => {});
  k.press('KeyF');
  k.fly(8, () => {});
  let vrAt = 0;
  let minTail = Infinity;
  let maxQ = 0;
  k.fly(90, () => {
    k.throttle(1);
    if (k.s.onGround) k.track(0);
    if (!vrAt && ias(k.s) >= B.limits.vrKt) vrAt = k.t;
    if (vrAt && k.t < vrAt + holdS) k.held.add('ArrowDown');
  }, (s) => {
    if (vrAt) { minTail = Math.min(minTail, tailClearance(s)); maxQ = Math.max(maxQ, deg(s.derived.q)); }
    return vrAt > 0 && s.time > vrAt + 15;
  });
  return { s: k.s, minTail, maxQ };
}

describe('747 keyboard rotation', () => {
  it('a short ↓ tap at Vr rotates cleanly (≈ 3 °/s, the tail stays > 1 m clear) and it flies away', () => {
    const r = yank(0.35);
    log(`↓ 0.35 s at Vr: max pitch rate ${r.maxQ.toFixed(1)} °/s, min tail clearance ${r.minTail.toFixed(2)} m, ${fmtShort(r.s)}`);
    expect(r.s.crash).toBeNull();
    expect(r.minTail).toBeGreaterThan(1);
    expect(r.s.phase).toBe('airborne');
  });

  it('holding ↓ for a whole second (a yank: 8–9 °/s, like a real full-aft pull) scrapes the tail but the take-off continues', () => {
    const r = yank(1);
    log(`↓ 1 s at Vr: max pitch rate ${r.maxQ.toFixed(1)} °/s, min tail clearance ${r.minTail.toFixed(2)} m, ${fmtShort(r.s)}`);
    expect(r.maxQ).toBeGreaterThan(6);
    expect(r.minTail).toBeLessThan(0.05);
    expect(r.s.crash).toBeNull();
    expect(r.s.phase).toBe('airborne');
    expect(r.s.velocity.y).toBeGreaterThan(0);
  });
});

describe('747 keyboard sortie', () => {
  it('take-off → 5,000 ft → turns → stall + recovery → approach → landing, all on the keyboard', () => {
    const k = new KeyboardPilot(createInitialState(env, B747_CFG));
    const fmt = (s: AircraftState) => `t ${s.time.toFixed(0)} ${simStateLabel(s)} ${ias(s).toFixed(0)} KIAS ${(s.position.y * M_TO_FT).toFixed(0)} ft vs ${(s.velocity.y * 196.85).toFixed(0)} pitch ${s.derived.pitchDeg.toFixed(1)} α ${deg(s.derived.alpha).toFixed(1)} bank ${s.derived.rollDeg.toFixed(1)} hdg ${s.derived.headingDeg.toFixed(0)} thr ${k.cs.controls.throttle.toFixed(2)} el ${k.cs.controls.elevator.toFixed(2)} trim ${k.cs.controls.elevatorTrim.toFixed(2)} gear ${s.gearPos.toFixed(2)} flaps ${s.flapsDeg.toFixed(0)}`;

    // ── Line-up: F F (flaps 10), a few ] taps of nose-up take-off trim while the flaps run. ──
    k.press('KeyF');
    k.fly(0.2, () => {});
    k.press('KeyF');
    k.fly(8, () => { if (k.cs.controls.elevatorTrim < 0.25) k.held.add('BracketRight'); });
    expect(k.cs.controls.flapsNotch).toBe(2);

    // ── Take-off: hold W, keep straight, rotate at Vr with ↓ taps toward 8°. ──
    let rotateKt = 0;
    let liftoff: AircraftState | null = null;
    let gearUpAt = -1;
    let maxPitchGround = 0;
    let minTail = Infinity;
    const a0 = along(k.s);
    k.fly(90, () => {
      const s = k.s;
      k.throttle(1);
      if (!rotateKt && ias(s) >= B.limits.vrKt) rotateKt = ias(s);
      if (rotateKt) k.pitch(8);
      if (s.onGround) k.track(0);
      else k.bank(0);
      if (!liftoff && !s.onGround) liftoff = s;
      if (liftoff && gearUpAt < 0 && s.airborneTime > 3 && s.velocity.y > 3) { k.press('KeyG'); gearUpAt = s.time; }
    }, (s) => {
      if (s.onGround) maxPitchGround = Math.max(maxPitchGround, s.derived.pitchDeg);
      if (s.derived.altitudeAGL < 30) minTail = Math.min(minTail, tailClearance(s));
      return gearUpAt > 0 && s.time > gearUpAt + 12;
    });
    expect(k.s.crash, k.s.crash?.reason).toBeNull();
    expect(liftoff).not.toBeNull();
    const lo = liftoff as unknown as AircraftState;
    const rollM = along(lo) - a0;
    log(`take-off: rotate ${rotateKt.toFixed(0)} KIAS, lift-off ${ias(lo).toFixed(0)} KIAS at ${lo.derived.pitchDeg.toFixed(1)}° after ${rollM.toFixed(0)} m (at ${along(lo).toFixed(0)} m of 1,600), max pitch on the wheels ${maxPitchGround.toFixed(1)}°, min tail clearance ${minTail.toFixed(2)} m`);
    log(fmt(k.s));
    expect(rotateKt).toBeGreaterThanOrEqual(144);
    expect(ias(lo)).toBeGreaterThan(145);
    expect(ias(lo)).toBeLessThan(175);
    expect(rollM).toBeGreaterThan(850);
    expect(rollM).toBeLessThan(1350);
    // Off the 1,600 m runway comfortably, the tail never touched (strike at ≈ 10° on the wheels).
    expect(along(lo)).toBeLessThan(1450);
    expect(maxPitchGround).toBeLessThan(9.5);
    expect(minTail).toBeGreaterThan(0.3);

    // ── Climb: flaps up past 200 KIAS (V twice), pitch for ~250 KIAS, trim; level at 5,000 ft, cruise power. ──
    const level = 5000 * FT_TO_M;
    let flapsUp = 0;
    let lastV = -99;
    let climbPitch = 10;
    let vsSum = 0;
    let vsN = 0;
    k.fly(240, () => {
      const s = k.s;
      // Flap retraction schedule: 10 → 5 at 200 KIAS, 5 → up at 220 KIAS.
      if (flapsUp < 2 && ias(s) > 200 + 20 * flapsUp && s.time > lastV + 2) {
        k.press('KeyV');
        flapsUp++;
        lastV = s.time;
      }
      if (s.position.y < level - 200) {
        k.throttle(1);
        climbPitch = Math.max(3, Math.min(18, climbPitch + 0.25 * (1 / 120) * (ias(s) - 250)));
        k.pitch(climbPitch);
      } else {
        k.speed(280);
        k.altitude(level);
      }
      k.bank(0);
      k.trim();
      if (s.position.y > 1500 * FT_TO_M && s.position.y < 4000 * FT_TO_M) { vsSum += s.velocity.y * 196.85; vsN++; }
    }, (s) => s.time > 90 && Math.abs(s.position.y - level) < 30 && Math.abs(s.velocity.y) < 1.5 && Math.abs(ias(s) - 280) < 15);
    const climbFpm = vsSum / Math.max(1, vsN);
    log(`climb: ${climbFpm.toFixed(0)} fpm mean from 1,500 to 4,000 ft; levelled: ${fmt(k.s)}`);
    expect(k.s.crash, k.s.crash?.reason).toBeNull();
    expect(k.s.gearPos).toBe(0);
    expect(k.s.flapsDeg).toBe(0);
    expect(climbFpm).toBeGreaterThan(2500);
    expect(climbFpm).toBeLessThan(7000);
    expect(Math.abs(k.s.position.y - level) * M_TO_FT).toBeLessThan(200);

    // ── Turns: 30° bank left onto west (270°), then right back to north, holding 5,000 ft. ──
    let maxDevFt = 0;
    let maxBank = 0;
    for (const target of [270, 0]) {
      k.fly(150, () => {
        k.heading(target, 30);
        k.altitude(level);
        k.speed(280);
        k.trim();
      }, (s) => {
        if (process.env.B747_TRACE && Math.round(s.time * 120) % 240 === 0) log(fmt(s));
        maxDevFt = Math.max(maxDevFt, Math.abs(s.position.y - level) * M_TO_FT);
        maxBank = Math.max(maxBank, Math.abs(s.derived.rollDeg));
        return Math.abs(headingError(s, target)) < 3 && Math.abs(s.derived.rollDeg) < 3;
      });
      log(`turn to ${target}: ${fmt(k.s)}`);
      expect(k.s.crash, k.s.crash?.reason).toBeNull();
      expect(Math.abs(headingError(k.s, target))).toBeLessThan(5);
    }
    log(`turns: max altitude deviation ${maxDevFt.toFixed(0)} ft, max bank ${maxBank.toFixed(0)}°`);
    expect(maxDevFt).toBeLessThan(350);
    expect(maxBank).toBeGreaterThan(20);
    expect(maxBank).toBeLessThan(40);

    // ── Stall: idle, hold the altitude (more and more back pressure) until the break; recover. ──
    let warnAt = 0;
    let stalledAt = 0;
    let breakKt = 0;
    const aStall = stallAlphaRad(0, B747_CFG);
    const warnA = aStall - B.stall.warningMarginDeg * (Math.PI / 180);
    // Hold the altitude at idle while the speed bleeds off (trimming), then from 175 KIAS keep raising the
    // nose ~1°/s (more and more back pressure) until the break.
    let slowAt = 0;
    let pitchCmd = 0;
    k.fly(180, () => {
      const s = k.s;
      k.throttle(0);
      k.bank(0);
      if (!slowAt && ias(s) < 175) { slowAt = s.time; pitchCmd = s.derived.pitchDeg; }
      if (!slowAt) {
        k.altitude(level);
        k.trim();
      } else {
        pitchCmd += DT;
        k.pitch(pitchCmd);
      }
    }, (s) => {
      if (!warnAt && s.derived.alpha >= warnA) warnAt = s.time;
      if (!stalledAt && s.stalled) { stalledAt = s.time; breakKt = ias(s); }
      return stalledAt > 0 && s.time > stalledAt + 1.5;
    });
    log(`stall: shaker at t ${warnAt.toFixed(1)}, break at t ${stalledAt.toFixed(1)} ${breakKt.toFixed(0)} KIAS; ${fmt(k.s)}`);
    expect(k.s.crash, k.s.crash?.reason).toBeNull();
    expect(stalledAt).toBeGreaterThan(0);
    // The shaker gives a clear warning before the break.
    expect(stalledAt - warnAt).toBeGreaterThan(2);
    expect(breakKt).toBeGreaterThan(120);
    expect(breakKt).toBeLessThan(150);
    const pitchAtBreak = k.s.derived.pitchDeg;
    // Recovery: release, ↑ to unload, full thrust, wings level; climb away without a secondary stall.
    let minPitch = pitchAtBreak;
    let lostFt = 0;
    const yBreak = k.s.position.y;
    let recoveredAt = 0;
    k.fly(60, () => {
      k.throttle(1);
      k.bank(0);
      if (k.s.stalled || deg(k.s.derived.alpha) > 8) k.held.add('ArrowUp');
      else k.pitch(3);
    }, (s) => {
      minPitch = Math.min(minPitch, s.derived.pitchDeg);
      lostFt = Math.max(lostFt, (yBreak - s.position.y) * M_TO_FT);
      if (!recoveredAt && !s.stalled && s.velocity.y > 0 && ias(s) > 170) recoveredAt = s.time;
      return recoveredAt > 0;
    });
    log(`recovery: nose down to ${minPitch.toFixed(1)}°, ${lostFt.toFixed(0)} ft lost; ${fmt(k.s)}`);
    expect(k.s.crash, k.s.crash?.reason).toBeNull();
    expect(recoveredAt).toBeGreaterThan(0);
    expect(minPitch).toBeLessThan(pitchAtBreak - 3);
    expect(lostFt).toBeLessThan(2000);
    expect(k.labels.has('stalled')).toBe(true);

    // ── Shift+R: on final, 9 km out, flaps 30, gear down, trimmed. Fly the 3° glide at Vref + 5 ≈ 132 KIAS. ──
    k.s = createApproachState(env, B747_CFG);
    k.cs = resetControls(k.cs, approachControls(B747_CFG));
    k.thrBase = -1;
    k.pitchI = 0;
    k.elevAvg = 0;
    k.alphaAvg = NaN;
    const gsTan = Math.tan((3 * Math.PI) / 180);
    const aim = B.spawn.approach.aimPointM;
    let flareAt: AircraftState | null = null;
    let maxBankFinal = 0;
    k.fly(240, () => {
      const s = k.s;
      const wheel = s.position.y + B.geometry.leftMainWheel.y; // flat world at y = 0
      const gp = Math.max(0, (aim - along(s)) * gsTan);
      if (!flareAt && wheel < 9) flareAt = s;
      if (!s.touchdown && !flareAt) {
        k.speed(132);
        const gsVs = -s.derived.groundSpeed * gsTan;
        k.altitude(gp - B.geometry.leftMainWheel.y + 0.5, 6, gsVs);
        k.trim();
      } else if (!s.touchdown) {
        k.throttle(0);
        // Flare: ease the sink off with ↓ taps (pitch up a few degrees), keep the wings level.
        const want = -Math.max(0.8, wheel * 0.2);
        k.pitch(deg(s.derived.alpha) + deg(Math.asin(want / s.derived.tas)) + 1.2 * (want - s.velocity.y));
      } else {
        k.throttle(0);
        if (s.onGround && s.time > s.touchdown.time + 1) k.held.add('Space');
        if (s.derived.pitchDeg > 0.5) k.pitch(0);
      }
      if (!s.onGround) k.bank(-0.4 * across(s) - 0.5 * headingError(s, 0));
      else k.track(0);
      if (!s.onGround) maxBankFinal = Math.max(maxBankFinal, Math.abs(s.derived.rollDeg));
    }, (s) => {
      if (process.env.B747_TRACE && Math.round(s.time * 120) % (s.position.y < 60 ? 30 : 600) === 0) log(`along ${along(s).toFixed(0)} wheel ${(s.position.y + B.geometry.leftMainWheel.y).toFixed(1)} gp ${Math.max(0, (aim - along(s)) * gsTan).toFixed(1)} ${fmt(s)}`);
      return !!s.touchdown && s.derived.groundSpeed < 0.5;
    });
    const td = k.s.touchdown;
    log(`landing: ${td ? `${td.rating} ${td.verticalSpeedFpm.toFixed(0)} fpm at ${td.airspeedKt.toFixed(0)} KIAS, pitch ${td.pitchDeg.toFixed(1)}°, ${td.centerlineOffsetM?.toFixed(1)} m off the centreline` : 'none'}; stopped at ${along(k.s).toFixed(0)} m; ${fmt(k.s)}`);
    expect(k.s.crash, k.s.crash?.reason).toBeNull();
    expect(td).not.toBeNull();
    expect(td!.onRunway).toBe(true);
    expect(['butter', 'smooth', 'firm']).toContain(td!.rating);
    expect(td!.airspeedKt).toBeGreaterThan(115);
    expect(td!.airspeedKt).toBeLessThan(145);
    expect(maxBankFinal).toBeLessThan(8);
    expect(k.s.phase).toBe('landed');
    expect(along(k.s)).toBeLessThan(1600);
  });
});
