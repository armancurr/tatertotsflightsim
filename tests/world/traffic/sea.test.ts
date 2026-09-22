import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import { getHeightfield } from '../../../src/world/heightfield';
import { getLayout } from '../../../src/world/layout';
import {
  createSeaPlan, createMarina, relWind, sailingTriangle, trapezoidTime, trapezoidDist, vesselPose, vesselTrack, mooredPose, newVesselPose,
  routeMinDepth, marinaStructureDistance, toLocal, VESSEL_DIMS, type SeaPlan,
} from '../../../src/world/traffic/sea';
import { samplePath, newPathSample } from '../../../src/world/traffic/path';
import { CONFIG } from '../../../src/config';

const hf = getHeightfield();
const water = { groundHeight: (x: number, z: number) => hf.height(x, z), waterLevel: (x: number, z: number) => hf.waterLevel(x, z) };
let plan: SeaPlan;
beforeAll(() => {
  plan = createSeaPlan(getLayout(), water);
}, 60_000);
const W = CONFIG.world.traffic.windFromDeg;
const WK = CONFIG.world.traffic.windKt;

describe('sea traffic: wind and sailing', () => {
  it('relative wind: 0 head to wind, + from starboard, ±180 running', () => {
    expect(relWind(230, 230)).toBeCloseTo(0);
    expect(relWind(230, 140)).toBeCloseTo(90); // heading 140, wind from 230 = on the starboard beam
    expect(relWind(230, 320)).toBeCloseTo(-90);
    expect(Math.abs(relWind(230, 50))).toBeCloseTo(180);
  });

  it('sailing triangles close and every leg is outside the no-go zone', () => {
    for (const mirror of [false, true]) {
      const pts = sailingTriangle(0, 0, 1000, W, mirror);
      expect(pts).toHaveLength(3);
      for (let i = 0; i < 3; i++) {
        const a = pts[i];
        const b = pts[(i + 1) % 3];
        const hd = ((Math.atan2(b.x - a.x, -(b.z - a.z)) * 180) / Math.PI + 360) % 360;
        expect(Math.abs(relWind(W, hd))).toBeGreaterThanOrEqual(40);
        expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeGreaterThan(300);
      }
    }
  });

  it('trapezoidal ferry profile covers the distance with bounded speed', () => {
    const D = 2400;
    const T = trapezoidTime(D, 6.7, 0.07);
    expect(trapezoidDist(D, 6.7, 0.07, T).s).toBeCloseTo(D, 6);
    expect(trapezoidDist(D, 6.7, 0.07, 0).s).toBe(0);
    let prev = 0;
    for (let t = 0; t <= T; t += T / 50) {
      const m = trapezoidDist(D, 6.7, 0.07, t);
      expect(m.s).toBeGreaterThanOrEqual(prev - 1e-9);
      expect(m.v).toBeLessThanOrEqual(6.7 + 1e-9);
      prev = m.s;
    }
    // short hop: triangular profile
    expect(trapezoidDist(100, 6.7, 0.07, trapezoidTime(100, 6.7, 0.07)).s).toBeCloseTo(100, 6);
  });
});

describe('sea traffic: marina', () => {
  it('sits on the Port Chateau waterfront with berths in the water, inside the breakwaters', () => {
    const m = plan.marina;
    const city = getLayout().towns.find((t) => t.name === 'Port Chateau')!;
    expect(Math.abs(m.frame.ox - city.x)).toBeLessThan(600);
    expect(Math.hypot(m.frame.ux, m.frame.uz)).toBeCloseTo(1);
    expect(m.frame.ux * m.frame.wx + m.frame.uz * m.frame.wz).toBeCloseTo(0);
    expect(m.frame.wz).toBeGreaterThan(0.9); // out to sea = south
    expect(m.berths.length).toBeGreaterThan(80);
    for (const b of m.berths) {
      const { u, w } = toLocal(m.frame, b.x, b.z);
      expect(Math.abs(u)).toBeLessThan(340);
      expect(w).toBeGreaterThan(5);
      expect(w).toBeLessThan(300);
      expect(hf.waterLevel(b.x, b.z)).not.toBeNull();
    }
  });

  it('moored boats never overlap each other', () => {
    const m = plan.marina;
    const rects = m.berths.map((b) => {
      const d = VESSEL_DIMS[b.kind];
      return { b, hl: (d.length * b.scale) / 2, hb: (d.beam * b.scale) / 2 };
    });
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const A = rects[i];
        const B = rects[j];
        const dist = Math.hypot(A.b.x - B.b.x, A.b.z - B.b.z);
        if (dist > A.hl + B.hl + 2) continue;
        // separating-axis test on the two oriented rectangles
        const axes = [A.b.heading, A.b.heading + 90, B.b.heading, B.b.heading + 90].map((h) => [Math.sin((h * Math.PI) / 180), -Math.cos((h * Math.PI) / 180)]);
        const proj = (r: typeof A, ax: number[]) => {
          const h = (r.b.heading * Math.PI) / 180;
          const f = [Math.sin(h), -Math.cos(h)];
          const s = [-f[1], f[0]];
          const c = r.b.x * ax[0] + r.b.z * ax[1];
          const e = r.hl * Math.abs(f[0] * ax[0] + f[1] * ax[1]) + r.hb * Math.abs(s[0] * ax[0] + s[1] * ax[1]);
          return [c - e, c + e];
        };
        const separated = axes.some((ax) => {
          const [a0, a1] = proj(A, ax);
          const [b0, b1] = proj(B, ax);
          return a1 < b0 || b1 < a0;
        });
        expect(separated, `berths ${i} and ${j} overlap`).toBe(true);
      }
  });

  it('berths are clear of the breakwaters and quay', () => {
    const m = createMarina(getLayout());
    const noPontoon = { ...m, pontoons: [] };
    for (const b of m.berths) expect(marinaStructureDistance(noPontoon, b.x, b.z)).toBeGreaterThan(VESSEL_DIMS[b.kind].length * b.scale * 0.5);
  });
});

describe('sea traffic: routes (functional, real world)', () => {
  it('every route validates (no hull ever touches land or shallows)', () => {
    expect(plan.rejected).toEqual([]);
    const kinds = new Set(plan.routes.map((r) => r.kind));
    for (const k of ['sail', 'motor', 'fish', 'launch', 'ferry', 'container', 'tanker'] as const) expect(kinds.has(k)).toBe(true);
    expect(plan.routes.filter((r) => r.level > 100).length).toBeGreaterThanOrEqual(2); // lake boats
  });

  it('big ships run 5–10 km offshore in deep water', () => {
    const coastZ = getLayout().coast.zAt;
    for (const r of plan.routes.filter((q) => q.kind === 'container' || q.kind === 'tanker')) {
      expect(routeMinDepth(r, water, 400)).toBeGreaterThan(VESSEL_DIMS[r.kind].draft + 2);
      const p = newVesselPose();
      vesselPose(r, 0, W, WK, p);
      const off = p.z - coastZ(p.x);
      expect(off).toBeGreaterThan(5000);
      expect(off).toBeLessThan(11000);
      expect(Math.abs(p.x)).toBeLessThan(12000); // in view of the coast at t = 0
    }
  });

  it('routes never cross each other (vessels cannot collide)', () => {
    const pts = plan.routes.map((r) => {
      const out: { x: number; z: number }[] = [];
      const s = newPathSample();
      const n = Math.ceil(r.path.length / 30);
      for (let i = 0; i < n; i++) {
        samplePath(r.path, (i / n) * r.path.length, s);
        out.push({ x: s.x, z: s.z });
      }
      return out;
    });
    for (let a = 0; a < pts.length; a++)
      for (let b = a + 1; b < pts.length; b++) {
        let lo = Infinity;
        for (const p of pts[a]) for (const q of pts[b]) {
          const d = Math.abs(p.x - q.x) + Math.abs(p.z - q.z);
          if (d < lo) lo = d;
        }
        expect(lo, `${plan.routes[a].id} vs ${plan.routes[b].id}`).toBeGreaterThan(60);
      }
  });

  it('the harbour launch threads the marina entrance without touching a structure', () => {
    const r = plan.routes.find((q) => q.kind === 'launch' && q.level < 1)!;
    const s = newPathSample();
    let inside = 0;
    for (let d = 0; d < r.path.length; d += 5) {
      samplePath(r.path, d, s);
      expect(marinaStructureDistance(plan.marina, s.x, s.z)).toBeGreaterThan(VESSEL_DIMS.launch.beam / 2 + 3);
      if (toLocal(plan.marina.frame, s.x, s.z).w < 320) inside++;
    }
    expect(inside).toBeGreaterThan(20);
  });

  it('the ferry shuttles across the bay: dwells at each terminal, never exceeds its speed', () => {
    const r = plan.routes.find((q) => q.kind === 'ferry')!;
    const f = r.ferry!;
    const p = newVesselPose();
    const seen = { atA: false, atB: false, moving: false };
    const a = { x: r.path.x[0], z: r.path.z[0] };
    const b = { x: r.path.x[r.path.n - 1], z: r.path.z[r.path.n - 1] };
    for (let t = 0; t < f.period * 2; t += 3) {
      vesselPose(r, t, W, WK, p);
      expect(p.speed).toBeLessThanOrEqual(f.vmax + 1e-6);
      if (Math.hypot(p.x - a.x, p.z - a.z) < 1) seen.atA = true;
      if (Math.hypot(p.x - b.x, p.z - b.z) < 1) seen.atB = true;
      if (p.speed > f.vmax * 0.9) seen.moving = true;
      // double-ended: the hull keeps its orientation, the course flips
      expect(Math.abs(((p.heading - r.path.psi[0] * 57.29578) % 180 + 540) % 180 - 0) < 40 || Math.abs(((p.heading - r.path.psi[0] * 57.29578) % 180 + 540) % 180 - 180) < 40).toBe(true);
    }
    expect(seen).toEqual({ atA: true, atB: true, moving: true });
    expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeGreaterThan(1500);
  });

  it('sailing yachts heel to leeward with the boom out to leeward', () => {
    const r = plan.routes.find((q) => q.kind === 'sail')!;
    const p = newVesselPose();
    let checked = 0;
    for (let t = 0; t < r.path.duration; t += 7) {
      vesselPose(r, t, W, WK, p);
      const rel = relWind(W, p.course);
      if (Math.abs(rel) < 45 || Math.abs(rel) > 150) continue;
      // wind from starboard (rel > 0) → heel to port (roll < 0), boom to port (< 0)
      expect(Math.sign(p.roll)).toBe(-Math.sign(rel));
      expect(Math.sign(p.boom)).toBe(-Math.sign(rel));
      checked++;
    }
    expect(checked).toBeGreaterThan(10);
  });
});

describe('sea traffic: fuzz', () => {
  it('any route at any time: finite pose, on water, sane motion; deterministic', () => {
    fc.assert(
      fc.property(fc.nat({ max: 1000 }), fc.double({ min: -1e6, max: 1e7, noNaN: true }), (ri, t) => {
        const r = plan.routes[ri % plan.routes.length];
        const p = vesselPose(r, t, W, WK, newVesselPose());
        for (const k of ['x', 'y', 'z', 'heading', 'course', 'speed', 'pitch', 'roll', 'boom', 'travelled'] as const) expect(Number.isFinite(p[k]), k).toBe(true);
        expect(p.speed).toBeGreaterThanOrEqual(0);
        expect(p.speed).toBeLessThan(16);
        expect(Math.abs(p.roll)).toBeLessThan(30);
        expect(Math.abs(p.pitch)).toBeLessThan(10);
        expect(Math.abs(p.y - r.level)).toBeLessThan(0.6);
        expect(hf.waterLevel(p.x, p.z)).not.toBeNull();
        expect(hf.height(p.x, p.z)).toBeLessThan(r.level - 0.5);
        const q = vesselPose(r, t, W, WK, newVesselPose());
        expect(q).toEqual(p);
        const tr = { x: 0, z: 0, course: 0, speed: 0, travelled: 0 };
        vesselTrack(r, t, tr);
        expect(tr.x).toBeCloseTo(p.x, 6);
        expect(tr.travelled).toBeCloseTo(p.travelled, 3);
      }),
      { numRuns: 400 },
    );
  });

  it('distance travelled is monotonic in time (wakes never fold back)', () => {
    fc.assert(
      fc.property(fc.nat({ max: 1000 }), fc.double({ min: 0, max: 1e5, noNaN: true }), fc.double({ min: 0.01, max: 200, noNaN: true }), (ri, t, dt) => {
        const r = plan.routes[ri % plan.routes.length];
        const a = { x: 0, z: 0, course: 0, speed: 0, travelled: 0 };
        const b = { ...a };
        vesselTrack(r, t, a);
        vesselTrack(r, t + dt, b);
        expect(b.travelled).toBeGreaterThanOrEqual(a.travelled - 1e-6);
        expect(b.travelled - a.travelled).toBeLessThan(16 * dt + 1);
      }),
      { numRuns: 300 },
    );
  });

  it('moored boats bob gently in place', () => {
    fc.assert(
      fc.property(fc.nat({ max: 10000 }), fc.double({ min: -1e5, max: 1e6, noNaN: true }), (bi, t) => {
        const b = plan.marina.berths[bi % plan.marina.berths.length];
        const p = mooredPose(b, bi, t, 0, newVesselPose());
        expect(p.x).toBe(b.x);
        expect(Math.abs(p.y)).toBeLessThan(0.2);
        expect(Math.abs(p.roll)).toBeLessThan(3);
        expect(Math.abs(p.pitch)).toBeLessThan(3);
      }),
      { numRuns: 200 },
    );
  });
});
