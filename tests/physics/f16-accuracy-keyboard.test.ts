/**
 * F-16C (and A-10C) keyboard feel, through the real control system (src/input/controlSystem.ts
 * updateControls, default key rates — what the app uses) and step():
 *   F-16 roll: a short tap of → gives a modest bank change and a held key builds up to the full
 *     ~300 °/s over ~0.5–0.8 s (FBW roll-acceleration limit — a real pilot's full-stick input still
 *     reaches the rate in < 1 s), and a released roll stops quickly.
 *   F-16 pitch: a tap of ↓ does not slam the g on (curved stick gradient + the slowly relaxing keyboard
 *     elevator give ~3 g); a held key still reaches ~9 g.
 *   A-10 (direct controls): the same taps give a gentler, heavier response.
 * Set F16_DEBUG=1 to print the numbers.
 */
import { describe, it, expect, vi } from 'vitest';
import { FT_TO_M, RAD_TO_DEG, type Config } from '../../src/config';
import type { AircraftState } from '../../src/types';
import { createTrimmedState, step, FLAT_ENV } from '../../src/physics';
import { createControlState, emptyInputFrame, resetControls, updateControls } from '../../src/input/controlSystem';
import { F16_CFG } from './helpers';
import { A10_CFG } from './a10-helpers';

vi.setConfig({ testTimeout: 60000 });

const log = (...a: unknown[]) => { if (process.env.F16_DEBUG) console.log(...a); };
const DT = 1 / 120;

/** Hold `key` for `holdS` seconds from trimmed flight, then let go; fly `totalS`. Records bank, roll rate and g. */
function keyTest(cfg: Config, iasKt: number, key: string, holdS: number, totalS: number) {
  const { state, controls } = createTrimmedState({ altitudeM: 10000 * FT_TO_M, iasKt, gearDown: false }, FLAT_ENV, cfg);
  let cs = resetControls(createControlState(), { ...controls, gearDown: false });
  let s: AircraftState = state;
  let maxP = 0;
  let maxN = -Infinity;
  let t90 = Infinity;
  const bank0 = s.derived.rollDeg;
  const rates: number[] = [];
  for (let i = 0; i < Math.round(totalS / DT); i++) {
    const t = i * DT;
    const held = new Set<string>(t < holdS ? [key] : []);
    cs = updateControls(cs, { ...emptyInputFrame(), held }, DT).state;
    s = step(s, cs.controls, DT, FLAT_ENV, cfg);
    const p = Math.abs(s.derived.p * RAD_TO_DEG);
    rates.push(p);
    maxP = Math.max(maxP, p);
    maxN = Math.max(maxN, s.derived.loadFactor);
  }
  // Time to 90 % of the peak roll rate.
  for (let i = 0; i < rates.length; i++) if (rates[i] >= 0.9 * maxP) { t90 = (i + 1) * DT; break; }
  return { s, maxP, maxN, t90, bankChange: Math.abs(s.derived.rollDeg - bank0) };
}

describe('F-16 keyboard roll feel (FBW roll-acceleration limit)', () => {
  it('a 0.3 s tap of → at 350 KIAS rolls 20–60°; a 0.6 s tap 60–115° (was 132–190°); both stop by themselves', () => {
    const short = keyTest(F16_CFG, 350, 'ArrowRight', 0.3, 3);
    const med = keyTest(F16_CFG, 350, 'ArrowRight', 0.6, 3);
    log(`F-16 taps at 350 KIAS: 0.3 s → ${short.bankChange.toFixed(0)}° (peak ${short.maxP.toFixed(0)} °/s); 0.6 s → ${med.bankChange.toFixed(0)}° (peak ${med.maxP.toFixed(0)} °/s)`);
    expect(short.bankChange).toBeGreaterThan(20);
    expect(short.bankChange).toBeLessThan(60);
    expect(med.bankChange).toBeGreaterThan(60);
    expect(med.bankChange).toBeLessThan(115);
    for (const r of [short, med]) expect(Math.abs(r.s.derived.p * RAD_TO_DEG)).toBeLessThan(3);
  });

  it('a held → builds up to the full ~300 °/s over 0.5–0.8 s (not a step)', () => {
    const held = keyTest(F16_CFG, 350, 'ArrowRight', 2, 2);
    log(`F-16 held →: peak ${held.maxP.toFixed(0)} °/s, 90 % of it after ${held.t90.toFixed(2)} s`);
    expect(held.maxP).toBeGreaterThan(280);
    expect(held.maxP).toBeLessThan(320);
    expect(held.t90).toBeGreaterThan(0.5);
    expect(held.t90).toBeLessThan(1.0);
  });
});

describe('F-16 keyboard pitch feel', () => {
  it('a 0.25 s tap of ↓ at 350 KIAS stays under 4 g; holding ↓ still reaches 8.5 g within 1.5 s', () => {
    const tap = keyTest(F16_CFG, 350, 'ArrowDown', 0.25, 2.5);
    const held = keyTest(F16_CFG, 480, 'ArrowDown', 2, 2);
    log(`F-16 pitch: 0.25 s tap → peak ${tap.maxN.toFixed(2)} g; held → ${held.maxN.toFixed(2)} g`);
    expect(tap.maxN).toBeLessThan(4);
    expect(tap.maxN).toBeGreaterThan(1.5);
    expect(held.maxN).toBeGreaterThan(8.5);
    expect(held.maxN).toBeLessThan(9.6);
  });
});

describe('A-10 keyboard feel (direct controls, heavy)', () => {
  it('at 275 KIAS: a 0.3 s tap of → rolls 10–40°, a 0.6 s tap 30–80°; held builds to ~100 °/s in ~1 s', () => {
    const short = keyTest(A10_CFG, 275, 'ArrowRight', 0.3, 3);
    const med = keyTest(A10_CFG, 275, 'ArrowRight', 0.6, 3);
    const held = keyTest(A10_CFG, 275, 'ArrowRight', 2, 2);
    log(`A-10 taps at 275 KIAS: 0.3 s → ${short.bankChange.toFixed(0)}°, 0.6 s → ${med.bankChange.toFixed(0)}°; held: peak ${held.maxP.toFixed(0)} °/s, 90 % after ${held.t90.toFixed(2)} s`);
    expect(short.bankChange).toBeGreaterThan(10);
    expect(short.bankChange).toBeLessThan(40);
    expect(med.bankChange).toBeGreaterThan(30);
    expect(med.bankChange).toBeLessThan(80);
    expect(held.maxP).toBeGreaterThan(90);
    expect(held.maxP).toBeLessThan(120);
    expect(held.t90).toBeGreaterThan(0.6);
    expect(held.t90).toBeLessThan(1.6);
  });

  it('a 0.25 s tap of ↓ at 300 KIAS gives a firm but bounded pull (1.5–4 g)', () => {
    const tap = keyTest(A10_CFG, 300, 'ArrowDown', 0.25, 2.5);
    log(`A-10 pitch: 0.25 s tap → peak ${tap.maxN.toFixed(2)} g`);
    expect(tap.maxN).toBeGreaterThan(1.5);
    expect(tap.maxN).toBeLessThan(4);
    expect(tap.s.crash).toBeNull();
  });
});
