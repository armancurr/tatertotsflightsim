/**
 * The A-10's pitch trim at keyboard gunnery speeds (RESUME §5 item 9: "needs ~10° nose-down trim at
 * 280–300 kt"). Finding: the config's trim authority is ample — the trim solver needs only
 * ≈ −0.14…−0.17 of the ±1 range at 280–300 KIAS ("TRIM 14–17 DN" on the strip) and stays inside
 * the stops from 120 to 400 KIAS clean (and 115–200 kt with gear and flaps) — so no config change:
 * the fix is the pilot's (keyboard) trim technique, which the QA pilot now does (auto-trim taps in
 * steady ~1 g flight only). Unit: the trim range; functional: the QA pilot holds 290 kt level by
 * keyboard, trimming itself nose-down, and the attitude stays steady.
 */
import { describe, expect, it } from 'vitest';
import { solveTrim } from '../../src/physics/trim';
import { getAircraftDef } from '../../src/fleet';
import { createHeadlessRun } from './qa-pilot.harness';

const A10 = getAircraftDef('a10').config;

describe('A-10 trim authority', () => {
  it('covers 120–400 KIAS clean and 115–200 kt with gear down and flaps (the trim never hits a stop)', () => {
    for (let kt = 120; kt <= 400; kt += 10) {
      const r = solveTrim({ altitudeM: 460, iasKt: kt, flapsNotch: 0, gearDown: false }, A10);
      expect(Math.abs(r.elevatorTrim), `${kt} kt clean`).toBeLessThan(1);
    }
    for (const flaps of [1, 2]) {
      for (let kt = 115; kt <= 200; kt += 5) {
        const r = solveTrim({ altitudeM: 460, iasKt: kt, flapsNotch: flaps, gearDown: true }, A10);
        expect(Math.abs(r.elevatorTrim), `${kt} kt flaps ${flaps}`).toBeLessThan(1);
      }
    }
    // gunnery speeds: a small nose-down trim, nowhere near the stop
    const t290 = solveTrim({ altitudeM: 460, iasKt: 290, flapsNotch: 0, gearDown: false }, A10).elevatorTrim;
    expect(t290).toBeLessThan(0);
    expect(t290).toBeGreaterThan(-0.3);
  });

  it('functional: the QA pilot holds 290 kt level by keyboard, trimming nose-down itself; the attitude stays steady', async () => {
    // spawned trimmed for 200 kt, then accelerated to 290 kt: the aircraft wants to climb until re-trimmed
    const run = createHeadlessRun({ aircraft: 'a10', start: { x: 0, z: 2000, aglFt: 3000, headingDeg: 180, speedKt: 200 }, maxSimS: 300 });
    const pilot = run.pilot as unknown as { gotoPoint(x: number, z: number, o: object): Promise<string>; level(ms: number): Promise<string> };
    const trim0 = run.controls.elevatorTrim;
    await pilot.gotoPoint(0, 40000, { altFt: 3100, speedKt: 290, arriveM: 100, timeoutMs: 60_000, throttle: 90 });
    const alt0 = run.state.position.y;
    const t0 = run.t;
    await pilot.level(30_000);
    const seg = run.trace.filter((x) => x.t >= t0);
    expect(run.state.phase).toBe('airborne');
    expect(run.controls.elevatorTrim).toBeLessThan(trim0 - 0.1); // it trimmed nose-down
    expect(Math.abs(run.state.position.y - alt0) * 3.28).toBeLessThan(250);
    const pitches = seg.map((x) => x.pitch);
    expect(Math.max(...pitches) - Math.min(...pitches)).toBeLessThan(5);
  }, 60_000);
});
