/**
 * The wake for ANY vessel (src/world/water/wakeField.ts): a 3.3 m jet ski, the 15.5 m Princess V50
 * and a 265 m ship read the same field, scaled by their length, beam, speed, planing fraction and
 * propulsor load. Covers: the measured wedge (≈ 19.5° at displacement speed, narrowing at high
 * Froude numbers), sizes (lifetimes, trail width, the map's extent and the strip's reach grow with
 * the hull; a ship's turquoise propwash lane is kilometres long), foam that decays and breaks into
 * lace (the per-pixel coverage threshold the sea shader uses), the aerated lane outliving the white
 * water, the "paper water" regression from 5d92507 (no smooth lifted swell in the churned wash;
 * slopes over ≥ 2 texels, clamped), fuzz over random sizes / speeds / turns, and a CPU guard on the
 * per-frame strip build (no allocation, well under a millisecond).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  KELVIN_DEG, WAKE_FIELD, WAKE_FIELD_GLSL, WAKE_SLOPE, STRIP_MAX, STRIP_ACROSS, buildWakeStrip, foamCoverage, foamMeanCoverage, kelvinHeight,
  newWakeStrip, wakeField, wakeFroude, wakeLifetimes, wakeLift, wakeMapExtent, wakeScale, wakeAmplitude, trailHalfWidth, type TrackSource,
} from '../../../src/world/water/wakeField';
import { WATER_BEGIN_VERTEX, WATER_SURFACE_FRAGMENT } from '../../../src/world/water/shaders';
import { HullTrack } from '../../../src/world/traffic/hullTrack';
import { fcParams } from '../../support/fc';

const SKI = { L: 3.3, B: 1.2 };
const V50 = { L: 14.2, B: 4.11 };
const SHIP = { L: 265, B: 32 };
const kMaxFor = (L: number) => (2 * Math.PI) / (4 * (wakeMapExtent(L) / 1024));

/** Angle (deg) of the strongest wave envelope at distance x behind the source (max |h| over y). */
function peakAngle(x: number, U: number, L: number, B: number, planing: number): number {
  const kMax = kMaxFor(L);
  let best = 0;
  let by = 0;
  const dy = Math.max(0.05, x / 4000);
  for (let y = dy; y < x * 0.5; y += dy) {
    const h = Math.abs(kelvinHeight(x, y, U, L, B, planing, kMax));
    if (h > best) {
      best = h;
      by = y;
    }
  }
  return (Math.atan(by / x) * 180) / Math.PI;
}

describe('wake: the measured wedge', () => {
  it('a ship at displacement speed (Fr ≈ 0.2) keeps the full Kelvin angle', () => {
    const U = 10.3; // 20 kt
    expect(wakeFroude(U, SHIP.L)).toBeLessThan(0.25);
    const a = peakAngle(1500, U, SHIP.L, SHIP.B, 0);
    expect(a).toBeGreaterThan(KELVIN_DEG - 3);
    expect(a).toBeLessThan(KELVIN_DEG + 1);
  });

  it('a displacement-speed V50 is at the Kelvin angle; planing at 30 kt narrows it (Rabaud–Moisy)', () => {
    const slow = peakAngle(160, 3.2, V50.L, V50.B, 0);
    const fast = peakAngle(160, 15.4, V50.L, V50.B, 0.85);
    expect(slow).toBeGreaterThan(KELVIN_DEG - 3.5);
    expect(fast).toBeLessThan(slow - 4);
    expect(fast).toBeGreaterThan(4);
  });

  it('wave heights stay physical for every size: centimetres for a jet ski, under 2 m for a ship', () => {
    const peak = (h: { L: number; B: number }, U: number, planing: number) => {
      let m = 0;
      const kMax = kMaxFor(h.L);
      for (let x = h.L * 0.5; x < h.L * 12; x += h.L / 12) for (let y = 0; y < x * 0.4; y += Math.max(0.1, h.B / 20)) m = Math.max(m, Math.abs(kelvinHeight(x, y, U, h.L, h.B, planing, kMax)));
      return m;
    };
    const ski = peak(SKI, 18, 1);
    const ship = peak(SHIP, 10.3, 0);
    expect(ski).toBeGreaterThan(0.02);
    expect(ski).toBeLessThan(0.45);
    expect(ship).toBeGreaterThan(0.2);
    expect(ship).toBeLessThan(2);
    // a ship crawling at 4 kt makes almost no waves (low Froude number)
    expect(wakeAmplitude(2, SHIP.B, 0, SHIP.L)).toBeLessThan(0.25 * wakeAmplitude(10.3, SHIP.B, 0, SHIP.L));
  });
});

describe('wake: sizes', () => {
  it('lifetimes, trail width, the map and the strip all grow with the hull', () => {
    const s = [SKI, V50, SHIP].map((h) => wakeScale(h.L, h.B));
    expect(s[1]).toBeCloseTo(1, 1);
    expect(s[0]).toBeLessThan(0.5);
    expect(s[2]).toBeGreaterThan(5);
    const life = [SKI, V50, SHIP].map((h) => wakeLifetimes(h.L, h.B));
    for (const k of ['white', 'lace', 'churn', 'slick', 'wave'] as const) {
      expect(life[0][k]).toBeLessThan(life[1][k]);
      expect(life[1][k]).toBeLessThan(life[2][k]);
    }
    // the V50 keeps its tuned numbers
    expect(life[1].white).toBeCloseTo(WAKE_FIELD.whiteLife, 0);
    expect(life[1].churn).toBeCloseTo(WAKE_FIELD.churnLife, 0);
    // a ship's aerated propwash lane lasts minutes: kilometres at 20 kt
    expect(life[2].churn * 10.3).toBeGreaterThan(1500);
    expect(trailHalfWidth(60, SHIP.B, life[2].spread)).toBeGreaterThan(trailHalfWidth(60, V50.B, life[1].spread) * 4);
    expect(wakeMapExtent(V50.L)).toBe(520);
    expect(wakeMapExtent(SHIP.L)).toBeGreaterThan(1800);
    expect(wakeMapExtent(SKI.L)).toBeLessThanOrEqual(520);
  });

  it('a ship leaves turquoise aerated water long after its white propwash has gone', () => {
    const kMax = kMaxFor(SHIP.L);
    const at = (age: number) => wakeField({ x: SHIP.L + 10.3 * age, y: 0, s: 0, U: 10.3, age, planing: 0, L: SHIP.L, B: SHIP.B, kMax, wash: 0.8 });
    const young = at(5);
    const old = at(150);
    expect(young.foam).toBeGreaterThan(0.6);
    expect(young.churn).toBeGreaterThan(0.6);
    expect(old.foam).toBeLessThan(0.25);
    expect(old.churn).toBeGreaterThan(0.25);
    expect(old.churn).toBeGreaterThan(old.foam);
  });

  it('a ship pushes a white bow wave along its sides; a planing hull does not', () => {
    const kMax = kMaxFor(SHIP.L);
    const bow = wakeField({ x: 0.15 * SHIP.L, y: 0.5 * SHIP.B + 2, s: 0, U: 11, age: 0, planing: 0, L: SHIP.L, B: SHIP.B, kMax, wash: 0.8 });
    expect(bow.foam).toBeGreaterThan(0.2);
    const clear = wakeField({ x: 0.15 * SHIP.L, y: 3 * SHIP.B, s: 0, U: 11, age: 0, planing: 0, L: SHIP.L, B: SHIP.B, kMax, wash: 0.8 });
    expect(clear.foam).toBeLessThan(bow.foam);
  });

  it('propulsor load feeds the wash: a boat coasting with the drives idle churns less', () => {
    const kMax = kMaxFor(V50.L);
    const p = { x: V50.L + 6, y: 0, s: 0, U: 9, age: 0.6, planing: 0.4, L: V50.L, B: V50.B, kMax };
    expect(wakeField({ ...p, wash: 1 }).foam).toBeGreaterThan(wakeField({ ...p, wash: 0 }).foam);
  });
});

describe('wake: foam decays and breaks into lace', () => {
  it('the white water behind the transom thins with age, monotonically, for every size', () => {
    for (const h of [SKI, V50, SHIP]) {
      const kMax = kMaxFor(h.L);
      let prev = Infinity;
      for (let age = 0.2; age < wakeLifetimes(h.L, h.B).lace * 3; age *= 1.35) {
        const f = wakeField({ x: h.L + 8 * age, y: 0, s: 0, U: 8, age, planing: 0.5, L: h.L, B: h.B, kMax, wash: 0.8 }).foam;
        expect(f).toBeLessThanOrEqual(prev + 1e-9);
        prev = f;
      }
      expect(prev).toBeLessThan(0.05);
    }
  });

  it('the coverage threshold: solid white when fresh (with dark holes), lace when old, nothing at zero', () => {
    // edge = how deep inside a boil of clear water (0 between boils, where foam gathers; 1 at a boil's centre)
    expect(foamCoverage(0, 0)).toBe(0);
    expect(foamCoverage(1, 0)).toBeGreaterThan(0.99);
    expect(foamCoverage(1, 0.45)).toBeGreaterThan(0.9);
    expect(foamCoverage(1, 0.95)).toBeLessThan(0.5); // the holes of upwelling clear water
    expect(foamCoverage(0.3, 0.02)).toBeGreaterThan(0.6); // lace: the walls stay white…
    expect(foamCoverage(0.3, 0.4)).toBeLessThan(0.05); // …the cells open up
    // monotone in density, and the far-field mean matches
    let prev = -1;
    for (let d = 0; d <= 1.0001; d += 0.05) {
      const m = foamMeanCoverage(d);
      expect(m).toBeGreaterThanOrEqual(prev);
      prev = m;
      let sum = 0;
      for (let e = 0; e < 1; e += 0.001) sum += foamCoverage(d, e) * 0.001;
      expect(Math.abs(m - sum)).toBeLessThan(0.12);
    }
  });
});

describe('wake: the paper-water regression (5d92507)', () => {
  it('no vertex lift in the churned wash; half the height elsewhere', () => {
    expect(wakeLift(0.4, 0)).toBeCloseTo(0.2, 6);
    expect(Math.abs(wakeLift(0.4, 1))).toBeLessThan(0.04);
    // the GLSL carries the same numbers
    expect(WATER_BEGIN_VERTEX).toContain('wm.r * 0.5 * ( 1.0 - 0.85 * clamp( wm.b, 0.0, 1.0 ) )');
  });

  it('slopes are taken over ≥ 2 texels and clamped (soft swells, never a creased fold)', () => {
    expect(WAKE_SLOPE.spanTexels).toBeGreaterThanOrEqual(2);
    expect(WAKE_SLOPE.clamp).toBeLessThanOrEqual(0.8);
    expect(WATER_SURFACE_FRAGMENT).toContain(`float tx = ${WAKE_SLOPE.spanTexels.toFixed(1)} * uWakeTexel.y;`);
    expect(WATER_SURFACE_FRAGMENT).toContain(`clamp( grad, vec2( -${WAKE_SLOPE.clamp} ), vec2( ${WAKE_SLOPE.clamp} ) )`);
  });

  it('right behind the transom at 11 kt the water is churned (so it boils instead of lifting)', () => {
    const kMax = kMaxFor(V50.L);
    for (let dx = 0.5; dx < 12; dx += 1.5) {
      const w = wakeField({ x: V50.L + dx, y: 0, s: 0, U: 5.7, age: dx / 5.7, planing: 0.1, L: V50.L, B: V50.B, kMax, wash: 0.7 });
      expect(w.churn).toBeGreaterThan(0.6);
      expect(Math.abs(wakeLift(w.height, w.churn))).toBeLessThan(0.12);
    }
  });
});

describe('wake: the strip for any size and any turn', () => {
  const drive = (L: number, U: number, turnDegPerS: number, seconds: number, dt = 0.1) => {
    const tr = new HullTrack(Math.ceil(seconds / dt) + 10, dt);
    let x = 0;
    let z = 0;
    let h = 0;
    for (let t = 0; t <= seconds; t += dt) {
      tr.push(t, x, z, ((h % 360) + 360) % 360, U, 0.5);
      h += turnDegPerS * dt;
      x += Math.sin((h * Math.PI) / 180) * U * dt;
      z -= Math.cos((h * Math.PI) / 180) * U * dt;
    }
    return { tr, now: seconds };
  };

  it('reaches ahead to the bow and, for a ship, kilometres behind', () => {
    const { tr, now } = drive(SHIP.L, 10.3, 0, 400, 0.2);
    const strip = newWakeStrip();
    buildWakeStrip(tr as unknown as TrackSource, now, SHIP.L, SHIP.B, strip, wakeMapExtent(SHIP.L) / 520);
    let minX = Infinity;
    let maxX = -Infinity;
    for (let j = 0; j < strip.count; j++) {
      const x = tr.travelled - strip.track[j * STRIP_ACROSS * 4] + SHIP.L / 2;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
    expect(minX).toBeLessThanOrEqual(0); // the bow (and a little ahead of it)
    expect(maxX).toBeGreaterThan(1800);
  });

  it('fuzz: random sizes, speeds and turns give finite strips that never fold over themselves', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 2.5, max: 300, noNaN: true }),
        fc.double({ min: 0, max: 22, noNaN: true }),
        fc.double({ min: -40, max: 40, noNaN: true }),
        (L, U, turn) => {
          const B = Math.max(0.8, L * 0.14);
          const { tr, now } = drive(L, U, turn, 60, 0.1);
          const strip = newWakeStrip();
          buildWakeStrip(tr as unknown as TrackSource, now, L, B, strip, wakeMapExtent(L) / 520);
          if (strip.count > STRIP_MAX) return false;
          for (let i = 0; i < strip.count * STRIP_ACROSS; i++) {
            if (!Number.isFinite(strip.xz[i * 2]) || !Number.isFinite(strip.xz[i * 2 + 1])) return false;
            for (let k = 0; k < 4; k++) if (!Number.isFinite(strip.track[i * 4 + k]) || !Number.isFinite(strip.extra[i * 4 + k])) return false;
          }
          // no wider than the turn radius (plus the hull) where it turns
          const R = Math.abs(turn) > 0.5 && U > 0.5 ? (U / ((Math.abs(turn) * Math.PI) / 180)) : Infinity;
          for (let j = 0; j < strip.count; j++) if (strip.extra[j * STRIP_ACROSS * 4 + 1] > Math.max(R, 0) + B + 4 + 1e-6 && R < 1e5) return false;
          return true;
        },
      ),
      fcParams(120),
    );
  });

  it('fuzz: the field is finite and bounded for any vessel, speed, planing and propulsor load', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 2.5, max: 320, noNaN: true }),
        fc.double({ min: 0.6, max: 45, noNaN: true }),
        fc.double({ min: -100, max: 3000, noNaN: true }),
        fc.double({ min: -800, max: 800, noNaN: true }),
        fc.double({ min: 0, max: 30, noNaN: true }),
        fc.double({ min: 0, max: 900, noNaN: true }),
        fc.double({ min: 0, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 1.3, noNaN: true }),
        (L, B, x, y, U, age, planing, wash) => {
          const o = wakeField({ x, y, s: x, U, age, planing, L, B, kMax: kMaxFor(L), wash });
          return Number.isFinite(o.height) && Math.abs(o.height) < 4 && [o.foam, o.churn, o.slick].every((v) => v >= 0 && v <= 1);
        },
      ),
      fcParams(500),
    );
  });

  it('CPU guard: a strip build reuses its buffers and stays well under a millisecond', () => {
    const { tr, now } = drive(V50.L, 14, 8, 90, 0.1);
    const strip = newWakeStrip();
    const xz = strip.xz;
    buildWakeStrip(tr as unknown as TrackSource, now, V50.L, V50.B, strip);
    const t0 = performance.now();
    const N = 200;
    for (let i = 0; i < N; i++) buildWakeStrip(tr as unknown as TrackSource, now, V50.L, V50.B, strip);
    const ms = (performance.now() - t0) / N;
    expect(strip.xz).toBe(xz);
    expect(ms).toBeLessThan(1.5); // ~0.05 ms idle; generous for a loaded machine
  });

  it('the GLSL takes the propulsor load and the size scale', () => {
    expect(WAKE_FIELD_GLSL).toMatch(/vec4 wakeField\( float x, float y, float s, float U, float age, float planing, float W, float L, float B, float kMax, float wash \)/);
    expect(WAKE_FIELD_GLSL).not.toMatch(/pow\(\s*[a-zA-Z_]\w*\s*,/);
  });
});
