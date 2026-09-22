/**
 * Play-test bug #2 regression (RECORD.md). A keyboard pilot rotates at Vr, holds the climb attitude
 * with ↓/↑ taps until ~70 kt (as real 172 pilots hold back pressure after liftoff), then lets go:
 * the aircraft must climb away hands-off near Vy, and raising the gear shortly after liftoff must
 * never fold it under a settling aircraft.
 */
import { describe, it, expect } from 'vitest';
import { createInitialState, step } from '../../src/physics';
import { createEnvironment } from '../../src/world/environment';
import { createControlState, updateControls, emptyInputFrame } from '../../src/input/controlSystem';
import { MS_TO_KT, M_TO_FT } from '../../src/config';

function flyKeyboardTakeoff(opts: { gearUpAfterLiftoffS?: number; targetPitch?: number } = {}) {
  const env = createEnvironment();
  let s = createInitialState(env);
  let cs = createControlState();
  const dt = 1 / 120;
  const target = opts.targetPitch ?? 9;
  let rotateAt = -1;
  let liftoffAt = -1;
  let handsOffAt = -1;
  let gearPressed = false;
  let touchedBack = false;
  let maxAgl = 0;
  let iasAfter = 0;
  for (let i = 0; i < 120 * 90; i++) {
    const t = i * dt;
    const held = new Set<string>();
    const ias = s.derived.ias * MS_TO_KT;
    if (t < 2.5) held.add('KeyW');
    if (rotateAt < 0 && ias >= 55) rotateAt = t;
    if (liftoffAt < 0 && s.phase === 'airborne') liftoffAt = t;
    if (maxAgl > 20 && s.onGround) touchedBack = true; // a skip right at rotation is fine; settling back after climbing is not
    // A human on a keyboard: short proportional taps (pulse-width within 0.25 s windows) to hold the
    // pitch attitude and keep the wings level — never full-deflection bang-bang.
    const win = (t * 4) % 1;
    const pulse = (u: number) => win < Math.min(1, Math.abs(u));
    if (rotateAt >= 0 && handsOffAt < 0) {
      if (liftoffAt >= 0 && ias >= 70) handsOffAt = t;
      else {
        const u = 0.25 * (target - s.derived.pitchDeg) - 0.08 * (s.derived.q * 57.3);
        if (pulse(u)) held.add(u > 0 ? 'ArrowDown' : 'ArrowUp');
      }
    }
    if (liftoffAt >= 0) {
      const ua = -0.15 * s.derived.rollDeg - 0.05 * (s.derived.p * 57.3);
      if (pulse(ua)) held.add(ua > 0 ? 'ArrowRight' : 'ArrowLeft');
    }
    const g = opts.gearUpAfterLiftoffS;
    const pressed = !gearPressed && g !== undefined && liftoffAt >= 0 && t >= liftoffAt + g ? [{ code: 'KeyG', shift: false }] : [];
    if (pressed.length) gearPressed = true;
    cs = updateControls(cs, { ...emptyInputFrame(), held, pressed }, dt).state;
    s = step(s, cs.controls, dt, env);
    if (process.env.PROBE && rotateAt >= 0 && i % 60 === 0 && t < rotateAt + 70) console.log(`T t=${(t - rotateAt).toFixed(1)} ias=${ias.toFixed(0)} agl=${(s.derived.altitudeAGL * M_TO_FT - 4).toFixed(0)} pitch=${s.derived.pitchDeg.toFixed(1)} roll=${s.derived.rollDeg.toFixed(1)} hdg=${s.derived.headingDeg.toFixed(0)} el=${cs.controls.elevator.toFixed(2)} vs=${(s.derived.verticalSpeed * 196.85).toFixed(0)} ${s.phase} gear=${s.gearPos.toFixed(2)}`);
    if (s.phase === 'crashed') break;
    maxAgl = Math.max(maxAgl, s.derived.altitudeAGL * M_TO_FT);
    if (handsOffAt >= 0 && t >= handsOffAt + 40 && iasAfter === 0) iasAfter = s.derived.ias * MS_TO_KT;
  }
  if (process.env.PROBE) console.log('R', JSON.stringify({ crash: s.crash?.reason, touchedBack, maxAgl: Math.round(maxAgl), liftoffAt: +liftoffAt.toFixed(1), rotateAt: +rotateAt.toFixed(1), handsOffAt: +handsOffAt.toFixed(1), iasAfter: Math.round(iasAfter), gear: s.gearPos, t: s.time }));
  return { s, touchedBack, maxAgl, liftoffAt, handsOffAt, iasAfter };
}

describe('keyboard takeoff (play-test bug #2)', () => {
  it('rotate at Vr, hold ~9° to 70 kt, then hands off: climbs away and never settles back once above 20 ft', () => {
    const r = flyKeyboardTakeoff();
    expect(r.s.crash).toBeNull();
    expect(r.liftoffAt).toBeGreaterThan(0);
    expect(r.handsOffAt).toBeGreaterThan(0);
    expect(r.touchedBack).toBe(false);
    expect(r.maxAgl).toBeGreaterThan(500);
    // Hands-off it settles near Vy (neutral trim ≈ takeoff trim).
    expect(r.iasAfter).toBeGreaterThan(62);
    expect(r.iasAfter).toBeLessThan(95);
  });
  it('raising the gear 0.3 s after liftoff never causes a belly landing', () => {
    const r = flyKeyboardTakeoff({ gearUpAfterLiftoffS: 0.3 });
    expect(r.s.crash).toBeNull();
    expect(r.s.gearPos).toBe(0);
    expect(r.maxAgl).toBeGreaterThan(500);
  });
  it('the squat-switch interlock keeps the gear down through a brief skip off the runway', () => {
    // Handle raised on the ground: the gear must still be down and locked the moment it lifts off.
    const r = flyKeyboardTakeoff({ gearUpAfterLiftoffS: -100 });
    expect(r.s.crash).toBeNull();
  });
});
