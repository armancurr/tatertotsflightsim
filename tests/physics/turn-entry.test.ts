/**
 * Turn entry with the ailerons alone (a keyboard pilot: no rudder). The nose must follow the bank:
 * the heading starts moving toward the turn within ~0.5 s and never swings the wrong way by more
 * than ~1° (Cessna — a little adverse yaw is real) or at all (F-16 — the fly-by-wire coordinates).
 * The input system's keyboard ramp (controls.rollRate / returnRate) is reproduced here.
 */
import { describe, it, expect } from 'vitest';
import { CONFIG, type Config } from '../../src/config';
import type { AircraftState, Controls } from '../../src/types';
import { clamp, wrap180 } from '../../src/math/vec3';
import { F16_CFG, fly, trimmed } from './helpers';

interface Entry {
  /** Worst heading change away from the bank, deg (≥ 0). */
  wrongWayDeg: number;
  /** From this time on the heading only moves toward the bank (the last reversal), s. */
  towardFromS: number;
  /** Heading change toward the bank after 3 s, deg. */
  after3sDeg: number;
  end: AircraftState;
}

/**
 * Roll into a `bankDeg` turn with the ailerons alone, the stick moving no faster than the keyboard
 * ramps it (controls.rollRate / returnRate) toward a simple bank-capture command. No rudder.
 */
function rollIn(dir: 1 | -1, cfg: Config, iasKt: number, bankDeg = 30): Entry {
  const { state, controls } = trimmed({ altitudeM: 1500, iasKt, gearDown: false }, cfg);
  const base: Controls = { ...controls, gearDown: false };
  const up = CONFIG.controls.rollRate / 120;
  const ret = CONFIG.controls.returnRate / 120;
  const h0 = state.derived.headingDeg;
  const pMax = cfg.aircraft.fbw ? 0.02 : 0.05; // bank-capture gain (per degree of bank error)
  let stick = 0;
  let wrongWay = 0;
  let prev = 0;
  let towardFrom = 0;
  const end = fly(state, (x) => {
    const want = clamp(pMax * (bankDeg - dir * x.derived.rollDeg), 0, 1);
    stick = want > stick ? Math.min(want, stick + up) : Math.max(want, stick - ret);
    return { ...base, aileron: dir * stick };
  }, 3, {
    cfg,
    each: (x) => {
      const dh = dir * wrap180(x.derived.headingDeg - h0);
      wrongWay = Math.max(wrongWay, -dh);
      if (dh < prev - 1e-6) towardFrom = x.time - state.time; // still (or again) moving away
      prev = dh;
    },
  });
  return { wrongWayDeg: wrongWay, towardFromS: towardFrom, after3sDeg: dir * wrap180(end.derived.headingDeg - h0), end };
}

describe('aileron-only turn entry (keyboard, no rudder)', () => {
  for (const dir of [1, -1] as const) {
    const side = dir > 0 ? 'right' : 'left';
    it(`Cessna, 90 KIAS, roll ${side} to 30°: heading follows the bank within 0.5 s, ≤ 1° the wrong way`, () => {
      const e = rollIn(dir, CONFIG, 90);
      expect(e.wrongWayDeg).toBeLessThanOrEqual(1);
      expect(e.towardFromS).toBeLessThan(0.5);
      expect(e.after3sDeg).toBeGreaterThan(5);
      expect(Math.abs(e.end.derived.rollDeg - dir * 30)).toBeLessThan(6);
    });
    it(`F-16, 350 KIAS, roll ${side} to 30°: no wrong-way yaw at all`, () => {
      const e = rollIn(dir, F16_CFG, 350);
      expect(e.wrongWayDeg).toBeLessThan(0.2);
      expect(e.towardFromS).toBeLessThan(0.5);
      expect(e.after3sDeg).toBeGreaterThan(3);
    });
    it(`F-16, 180 KIAS (slow, higher α), roll ${side} to 45°: no wrong-way yaw`, () => {
      const e = rollIn(dir, F16_CFG, 180, 45);
      expect(e.wrongWayDeg).toBeLessThan(0.2);
      expect(e.towardFromS).toBeLessThan(0.5);
      expect(e.after3sDeg).toBeGreaterThan(10);
    });
  }
});
