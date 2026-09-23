/**
 * The in-page QA pilot (scripts/qa-pilot.js) flies the 747 headless through the real keyboard pipeline
 * and the real world (tests/functional/qa-pilot.harness.ts) — the same code and profile that fly it in
 * Chrome for Testing: flaps 10 take-off off the 1,600 m runway, a climbing turn south to 4,000 ft over
 * the coast (straight ahead are the mountains), a 90° turn at 25° of bank; and from
 * the Shift+R approach, the 3° final at Vref30 + 5, flare, touchdown and rollout on runway 36.
 * Set B747_DEBUG=1 to print the pilot's log.
 */
import { describe, it, expect, vi } from 'vitest';
import { B747_AIRCRAFT } from '../../src/config';
import { createHeadlessRun, qa } from '../functional/qa-pilot.harness';

vi.setConfig({ testTimeout: 180000 });

const log = (...a: unknown[]) => { if (process.env.B747_DEBUG) console.log(...a); };

describe('QA pilot flies the 747 (headless, keyboard only)', () => {
  it('profile: Vr, flaps 30 final, flaps 10 take-off, the main gear 16 ft below the CG, no afterburner', () => {
    const p = qa.profileFor('b747', B747_AIRCRAFT);
    expect(p.id).toBe('b747');
    expect(p.vrKt).toBe(B747_AIRCRAFT.limits.vrKt);
    expect(p.finalFlapsNotch).toBe(5);
    expect(p.takeoffFlapsNotch).toBe(2);
    expect(p.gearOffsetFt).toBeCloseTo(16.4, 1);
    expect(p.afterburner).toBe(false);
    expect(p.maxThrottle).toBe(100);
    expect(p.firmFpm).toBe(B747_AIRCRAFT.landing.firmFpm);
  });

  it('take-off (flaps 10) → climbing turn south to 4,000 ft → a 90° turn', async () => {
    const run = createHeadlessRun({ aircraft: 'b747', start: 'runway', maxSimS: 600 });
    const r1 = await run.pilot.takeoff();
    const dist = run.pilot.stats.takeoffDistM as number;
    log(`takeoff: ${r1}, lift-off after ${dist?.toFixed(0)} m; t ${run.t.toFixed(0)} s`);
    expect(run.state.crash, run.state.crash?.reason).toBeNull();
    expect(dist).toBeGreaterThan(700);
    expect(dist).toBeLessThan(1450);
    const r2 = await run.pilot.climbTo(4000, { headingDeg: 180 });
    const r3 = await run.pilot.turn(90, 25);
    const s = run.state;
    log(`climb ${r2}, turn ${r3}: ${(s.derived.altitudeAGL * 3.2808).toFixed(0)} ft AGL, hdg ${s.derived.headingDeg.toFixed(0)}, ${(s.derived.ias * 1.943844).toFixed(0)} KIAS, gear ${s.gearPos}, flaps ${s.flapsDeg}`);
    expect(s.crash, s.crash?.reason).toBeNull();
    expect(r2).toBe('done');
    expect(r3).toBe('done');
    expect(s.gearPos).toBe(0);
    expect(s.flapsDeg).toBe(0);
    expect(s.derived.altitudeAGL * 3.2808).toBeGreaterThan(2500);
    expect(s.derived.ias * 1.943844).toBeLessThan(B747_AIRCRAFT.limits.vneKt);
  });

  it('Shift+R approach → flare → touchdown on runway 36 (smooth/firm) → rollout to a stop', async () => {
    const run = createHeadlessRun({ aircraft: 'b747', start: 'approach', maxSimS: 600 });
    const r = await run.pilot.approachAndLand();
    const td = run.touchdowns[0];
    log(`approach: ${r}; touchdown ${td?.rating} ${td?.verticalSpeedFpm.toFixed(0)} fpm at ${td?.airspeedKt.toFixed(0)} KIAS, pitch ${td?.pitchDeg.toFixed(1)}°, ${td?.centerlineOffsetM?.toFixed(1)} m off; ${run.touchdowns.length} contact(s); stopped: ${run.state.derived.groundSpeed.toFixed(1)} m/s`);
    expect(run.state.crash, run.state.crash?.reason).toBeNull();
    expect(td).toBeDefined();
    expect(td.onRunway).toBe(true);
    expect(['butter', 'smooth', 'firm']).toContain(td.rating);
    expect(run.touchdowns.length).toBe(1);
    expect(run.state.derived.groundSpeed).toBeLessThan(2);
  });
});
