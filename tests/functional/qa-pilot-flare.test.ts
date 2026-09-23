/**
 * The QA pilot's landing (scripts/qa-pilot.js): the flare law as pure functions (unit + fast-check),
 * then whole approaches flown headless by the SAME pilot through the real keyboard pipeline and
 * physics (tests/functional/qa-pilot.harness.ts) for all three aircraft over a range of winds and
 * weights — the touchdown sink must stay under each aircraft's "firm" limit, on the runway.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CONFIG, F16_AIRCRAFT, A10_AIRCRAFT, A10_WEAPONS } from '../../src/config';
import { createHeadlessRun, qa, type QaProfile, type Wind } from './qa-pilot.harness';

const AIRCRAFT = ['c172rg', 'f16', 'a10'] as const;
type Id = (typeof AIRCRAFT)[number];
const CFG = { c172rg: CONFIG.aircraft, f16: F16_AIRCRAFT, a10: A10_AIRCRAFT } as const;
const profile = (id: Id): QaProfile => qa.profileFor(id, CFG[id]);
const anyNumber = fc.oneof(fc.double({ noNaN: false }), fc.double({ min: -5000, max: 5000, noNaN: true }), fc.constantFrom(NaN, Infinity, -Infinity, 0, -0));

describe('qa-pilot flare law (pure)', () => {
  it('profiles take Vr, the landing ratings and the main-gear height from the aircraft config', () => {
    const c = profile('c172rg');
    expect(c.vrKt).toBe(CONFIG.aircraft.limits.vrKt);
    expect(c.firmFpm).toBe(CONFIG.aircraft.landing.firmFpm);
    expect(c.gearOffsetFt).toBeCloseTo(-CONFIG.aircraft.geometry.leftMainWheel.y * 3.2808, 3);
    const f = profile('f16');
    expect(f.vrKt).toBe(F16_AIRCRAFT.limits.vrKt);
    expect(f.firmFpm).toBe(F16_AIRCRAFT.landing.firmFpm);
    // The F-16 has an afterburner: normal flight stays below the detent.
    expect(f.maxThrottle as number).toBeLessThan((F16_AIRCRAFT.engine.jet!.abDetent) * 100);
    const a = qa.profileFor('a10', A10_AIRCRAFT, A10_WEAPONS);
    expect(a.vrKt).toBe(A10_AIRCRAFT.limits.vrKt);
    expect((a.gun as { muzzleVelocity: number }).muzzleVelocity).toBe(A10_WEAPONS.gun!.muzzleVelocity);
    expect((a.missile as { maxRangeM: number }).maxRangeM).toBe(A10_WEAPONS.missiles!.maxRangeM);
  });

  it('flares higher for a faster sink, inside [flareMinFt, flareMaxFt]', () => {
    for (const id of AIRCRAFT) {
      const p = profile(id);
      expect(qa.flareHeightFt(0, p)).toBe(p.flareMinFt);
      expect(qa.flareHeightFt(5000, p)).toBe(p.flareMaxFt);
      expect(qa.flareHeightFt(-400, p)).toBe(qa.flareHeightFt(400, p));
      expect(qa.flareHeightFt(700, p)).toBeGreaterThan(qa.flareHeightFt(300, p) - 1e-9);
    }
  });

  it('the sink target falls from the entry sink to the touchdown sink (always < firm)', () => {
    for (const id of AIRCRAFT) {
      const p = profile(id);
      const entry = 700;
      const hF = qa.flareHeightFt(entry, p);
      expect(qa.flareSinkFpm(hF, entry, p)).toBeCloseTo(entry, 6);
      expect(qa.flareSinkFpm(0, entry, p)).toBeCloseTo(p.touchdownSinkFpm, 6);
      expect(qa.flareSinkFpm(-10, entry, p)).toBeCloseTo(p.touchdownSinkFpm, 6);
      expect(p.touchdownSinkFpm).toBeLessThan(p.firmFpm / 2);
    }
  });

  it('above the flare height it is still the approach; below, the flare (never flares too high or below 0 ft)', () => {
    const p = profile('c172rg');
    const above = qa.landingPitchTarget(40, -400, 2, 60, -3, -3, null, p);
    expect(above).toEqual({ mode: 'approach', pitch: -3 });
    const below = qa.landingPitchTarget(5, -400, 2, 60, -3, -3, null, p);
    expect(below.mode).toBe('flare');
    expect(below.pitch).toBeGreaterThan(-3);
  });

  it('fuzz: for any inputs the flare height is finite, > 0 and ≤ 40 ft, and the flare pitch stays within the tail-strike limits', () => {
    fc.assert(
      fc.property(fc.constantFrom(...AIRCRAFT), anyNumber, anyNumber, anyNumber, anyNumber, anyNumber, anyNumber, (id, h, vs, aoa, gs, pitch, entry) => {
        const p = profile(id);
        const hf = qa.flareHeightFt(vs, p);
        expect(Number.isFinite(hf)).toBe(true);
        expect(hf).toBeGreaterThan(0);
        expect(hf).toBeLessThanOrEqual(40);
        const sink = qa.flareSinkFpm(h, entry, p);
        expect(Number.isFinite(sink)).toBe(true);
        expect(sink).toBeGreaterThanOrEqual(p.touchdownSinkFpm - 1e-9);
        const th = qa.flarePitch(h, vs, aoa, gs, pitch, entry, p);
        expect(Number.isFinite(th)).toBe(true);
        expect(th).toBeLessThanOrEqual(p.maxFlarePitchDeg as number);
        expect(th).toBeGreaterThanOrEqual(p.minFlarePitchDeg as number);
      }),
      { numRuns: 400 },
    );
  });

  it('fuzz: lower is never less nose-up, and the sink target never grows as the wheels come down', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...AIRCRAFT),
        fc.double({ min: -5, max: 60, noNaN: true }), fc.double({ min: 0, max: 30, noNaN: true }),
        fc.double({ min: -1500, max: 200, noNaN: true }), fc.double({ min: -2, max: 16, noNaN: true }),
        fc.double({ min: 40, max: 200, noNaN: true }), fc.double({ min: 100, max: 1400, noNaN: true }),
        (id, h, dh, vs, aoa, gs, entry) => {
          const p = profile(id);
          const lo = h;
          const hi = h + dh;
          expect(qa.flareSinkFpm(lo, entry, p)).toBeLessThanOrEqual(qa.flareSinkFpm(hi, entry, p) + 1e-9);
          expect(qa.flarePitch(lo, vs, aoa, gs, 0, entry, p)).toBeGreaterThanOrEqual(qa.flarePitch(hi, vs, aoa, gs, 0, entry, p) - 1e-9);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('fuzz: the flare starts with at least ~2.5 s to go at any normal approach sink', () => {
    fc.assert(
      fc.property(fc.constantFrom(...AIRCRAFT), fc.double({ min: 200, max: 800, noNaN: true }), (id, sink) => {
        const p = profile(id);
        const seconds = qa.flareHeightFt(sink, p) / (sink / 60);
        expect(seconds).toBeGreaterThanOrEqual(Math.min(2.5, p.flareMaxFt / (sink / 60)) - 1e-9);
      }),
      { numRuns: 200 },
    );
  });

  it('Mach from IAS and altitude (ISA): 661 kt at sea level ≈ Mach 1; the same IAS is faster up high', () => {
    const mach = qa.machFrom;
    expect(mach(661.5, 0)).toBeCloseTo(1, 2);
    expect(mach(400, 30000)).toBeGreaterThan(mach(400, 0) * 1.5);
  });
});

/** Fly the Shift+R approach to a full stop headless; the touchdown record. */
async function land(id: Id, wind?: Wind, massFactor = 1) {
  const run = createHeadlessRun({ aircraft: id, start: 'approach', wind, massFactor, maxSimS: 400 });
  const r = await run.pilot.approachAndLand();
  return { r, run, td: run.touchdowns[0], crash: run.state.crash?.reason ?? null, stopped: run.state.derived.groundSpeed < 2.5 };
}

describe('qa-pilot landings, headless (real keyboard pipeline + physics)', () => {
  // The brief's bars: the Cessna and the A-10 smooth/firm (here: never worse than firm, usually smooth),
  // the F-16 firm or better.
  for (const id of AIRCRAFT) {
    it(`${id}: still air, nominal weight → a smooth (or better) landing on the centreline, stopped on the runway`, async () => {
      const { td, crash, stopped } = await land(id);
      expect(crash).toBeNull();
      expect(td).toBeDefined();
      expect(['butter', 'smooth']).toContain(td.rating);
      expect(td.onRunway).toBe(true);
      expect(Math.abs(td.centerlineOffsetM ?? 99)).toBeLessThan(3);
      expect(td.pitchDeg, 'mains first').toBeGreaterThan(0);
      expect(stopped).toBe(true);
    }, 60_000);

    it(`${id}: fuzz over winds (−5…+20 kt along, ±6 kt across, gusts) and weights (±12 %) → sink at touchdown below "firm"`, async () => {
      const p = profile(id);
      await fc.assert(
        fc.asyncProperty(
          fc.double({ min: -5, max: 20, noNaN: true }), fc.double({ min: -6, max: 6, noNaN: true }),
          fc.double({ min: 0, max: 4, noNaN: true }), fc.double({ min: 0.88, max: 1.12, noNaN: true }),
          async (head, cross, gust, mass) => {
            const kt = Math.hypot(head, cross);
            // Runway 36: a headwind blows FROM the north (360°); a crosswind from the east is +.
            const fromDeg = kt < 1e-6 ? 0 : (Math.atan2(cross, head) * 180) / Math.PI;
            const { td, crash } = await land(id, { fromDeg: (fromDeg + 360) % 360, kt, gustKt: gust }, mass);
            expect(crash).toBeNull();
            expect(td).toBeDefined();
            expect(Math.abs(td.verticalSpeedFpm)).toBeLessThan(p.firmFpm);
            expect(td.onRunway).toBe(true);
          },
        ),
        { numRuns: 6 },
      );
    }, 180_000);
  }
});
