/**
 * The QA pilot's Boeing 747-400 profile (scripts/qa-pilot.js — the calibrated values validated against
 * the 747 flight model, tests/physics/b747-qapilot.test.ts): Vr ~145–150, final at Vref30 + 5 ≈ 132 KIAS
 * with flaps 30, flaps 10 for take-off, a 2.5°/s rotation, the mains ~16 ft below the reference, the
 * aim point 450 m down the runway, gentle √-pulsed hands; and a functional take-off from runway 36 in
 * the headless harness: flaps 10 set before the roll, a rotation well short of the tail-strike
 * attitude, positive climb, flaps up on schedule.
 */
import { describe, expect, it } from 'vitest';
import { createHeadlessRun, qa } from './qa-pilot.harness';
import { getAircraftDef } from '../../src/fleet';

describe('QA pilot: 747 profile', () => {
  it('Vr, approach speed, take-off and landing flaps, rotation rate, gear height, aim point, gentle hands', () => {
    const def = getAircraftDef('b747' as never);
    const p = qa.profileFor('b747', def.config.aircraft, def.config.weapons) as Record<string, number | boolean | string>;
    const a10 = qa.profileFor('a10', getAircraftDef('a10').config.aircraft) as Record<string, number>;
    expect(p.id).toBe('b747');
    expect(p.vrKt).toBeGreaterThanOrEqual(140);
    expect(p.vrKt).toBeLessThanOrEqual(155);
    expect(p.approachKt).toBe(132);
    const notches = def.config.aircraft.flaps.notchesDeg;
    expect(notches[p.takeoffFlapsNotch as number]).toBe(10);
    expect(notches[p.finalFlapsNotch as number]).toBe(30);
    expect(p.rotateRateDegS).toBe(2.5);
    expect(p.flapsUpKt as number).toBeGreaterThan(p.vrKt as number);
    expect(p.aimM).toBe(450);
    expect(p.dutySqrt).toBe(true);
    expect(p.stickTrim).toBeUndefined(); // the 747 keeps its own validated trim law
    expect(p.gearOffsetFt as number).toBeGreaterThan(14);
    expect(p.pitchKp as number).toBeLessThan(a10.pitchKp);
    expect(p.maxFlarePitchDeg as number).toBeLessThan(10); // well short of the ~11° tail strike
    expect(p.autoTrim).toBe(true);
  });

  it('functional: take-off from runway 36 — flaps 10, gentle rotation, climbs out and cleans up', async () => {
    const run = createHeadlessRun({ aircraft: 'b747' as never, start: 'runway', maxSimS: 300 });
    const pilot = run.pilot as unknown as { takeoff(): Promise<string>; log: { tag: string; flaps: number; ias: number; pitch: number }[]; stats: { takeoffDistM: number | null } };
    const r = await pilot.takeoff();
    expect(r).not.toBe('crashed');
    expect(run.state.phase).toBe('airborne');
    const vr = pilot.log.find((e) => e.tag === 'Vr')!;
    expect(vr.flaps).toBe(10);
    expect(vr.ias).toBeGreaterThanOrEqual(140);
    const groundPitch = Math.max(...run.trace.filter((x) => x.agl < 20).map((x) => x.pitch));
    expect(groundPitch).toBeLessThan(10);
    expect(pilot.stats.takeoffDistM!).toBeLessThan(1600);
    expect(run.state.derived.altitudeAGL * 3.28).toBeGreaterThan(450);
    expect(run.controls.flapsNotch).toBe(0);
  }, 60_000);
});
