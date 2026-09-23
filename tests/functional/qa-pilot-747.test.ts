/**
 * The QA pilot's Boeing 747-400 profile (scripts/qa-pilot.js): the numbers (Vr ~145–150, approach
 * ~150 / Vref ~130, flaps 20 for take-off and 30 for landing, the mains ~16 ft below the reference,
 * gentle hands) and a functional take-off from runway 36 in the headless harness: flaps 20 set
 * before the roll, the nose held on the runway to Vr, a ~2°/s rotation well short of the tail-strike
 * attitude, positive climb, flaps up on schedule.
 */
import { describe, expect, it } from 'vitest';
import { createHeadlessRun, qa } from './qa-pilot.harness';
import { getAircraftDef } from '../../src/fleet';

describe('QA pilot: 747 profile', () => {
  it('Vr, approach/Vref, take-off and landing flaps, gear height, gentle hands', () => {
    const def = getAircraftDef('b747' as never);
    const p = qa.profileFor('b747', def.config.aircraft, def.config.weapons) as Record<string, number | boolean | string>;
    const a10 = qa.profileFor('a10', getAircraftDef('a10').config.aircraft) as Record<string, number>;
    expect(p.id).toBe('b747');
    expect(p.vrKt).toBeGreaterThanOrEqual(140);
    expect(p.vrKt).toBeLessThanOrEqual(155);
    expect(p.approachKt).toBe(150);
    expect(p.vrefKt).toBe(130);
    const notches = def.config.aircraft.flaps.notchesDeg;
    expect(notches[p.takeoffFlapsNotch as number]).toBe(20);
    expect(notches[p.finalFlapsNotch as number]).toBe(30);
    expect(p.gearOffsetFt as number).toBeGreaterThan(14);
    expect(p.pitchKp as number).toBeLessThan(a10.pitchKp);
    expect(p.maxFlarePitchDeg as number).toBeLessThan(10); // well short of the ~11° tail strike
    expect(p.autoTrim).toBe(true);
  });

  it('functional: take-off from runway 36 — flaps 20, nose held to Vr, gentle rotation, climbs out and cleans up', async () => {
    const run = createHeadlessRun({ aircraft: 'b747' as never, start: 'runway', maxSimS: 300 });
    const pilot = run.pilot as unknown as { takeoff(): Promise<string>; log: { tag: string; flaps: number; ias: number; pitch: number }[]; stats: { takeoffDistM: number | null } };
    const r = await pilot.takeoff();
    expect(r).not.toBe('crashed');
    expect(run.state.phase).toBe('airborne');
    const vr = pilot.log.find((e) => e.tag === 'Vr')!;
    expect(vr.flaps).toBe(20);
    expect(vr.ias).toBeGreaterThanOrEqual(140);
    const groundPitch = Math.max(...run.trace.filter((x) => x.agl < 20).map((x) => x.pitch));
    expect(groundPitch).toBeLessThan(10);
    expect(pilot.stats.takeoffDistM!).toBeLessThan(1600);
    expect(run.state.derived.altitudeAGL * 3.28).toBeGreaterThan(450);
    expect(run.controls.flapsNotch).toBe(0);
  }, 60_000);
});
