import { describe, it, expect } from 'vitest';
import { getHeightfield } from '../../src/world/heightfield';
import { getLayout } from '../../src/world/layout';
import { CONFIG } from '../../src/config';
import { playerBerth, seaStart, portInfo, portMarina, checkDock, hullFootprint, seaDepth, BERTH_YACHT, MIN_UNDER_KEEL, SEA_START } from '../../src/world/port';
import { createMarina, createSeaPlan, marinaStructureDistance, toLocal, VESSEL_DIMS } from '../../src/world/traffic/sea';
import { marinaObstacleTop } from '../../src/world/traffic/harbourObstacles';
import { samplePath, newPathSample } from '../../src/world/traffic/path';

const hf = getHeightfield();
const water = { groundHeight: (x: number, z: number) => hf.height(x, z), waterLevel: (x: number, z: number) => hf.waterLevel(x, z) };
const layout = getLayout();
const m = portMarina(layout);
const DEG = Math.PI / 180;

describe('player port: the berth', () => {
  const b = playerBerth(layout);

  it('is the visitors\' berth at Port Chateau, alongside the pontoon, bow toward the entrance', () => {
    expect(portInfo().name).toBe('Port Chateau');
    expect(b.berthIndex).toBe(-1);
    expect(b.headingDeg).toBeCloseTo(m.frame.headingW, 6);
    // the heading points out through the harbour entrance
    const e = portInfo().entrance;
    const bearing = ((Math.atan2(e.x - b.x, -(e.z - b.z)) / DEG) + 360) % 360;
    expect(Math.abs(((bearing - b.headingDeg + 540) % 360) - 180)).toBeLessThan(12);
    // south-ish: out to sea
    expect(Math.cos(b.headingDeg * DEG)).toBeLessThan(-0.9);
    const { u, w } = toLocal(m.frame, b.x, b.z);
    const v = m.visitor;
    expect(w).toBeGreaterThan(v.w0);
    expect(w).toBeLessThan(v.w1);
    // hull clear of the pontoon face by the fender gap, but close enough for the lines
    const gap = (u - BERTH_YACHT.halfBeam) - (v.u + v.half);
    expect(gap).toBeGreaterThan(0.2);
    expect(gap).toBeLessThan(1);
    expect(b.side).toBe('starboard');
  });

  it('fits a 15.5 m × 4.1 m yacht with room, inside its reserved water', () => {
    expect(b.lengthM).toBeGreaterThan(15.5 + 6);
    expect(b.beamM).toBeGreaterThan(4.11 + 1);
    const vb = m.visitor.berth;
    for (const p of hullFootprint(b)) {
      const { u, w } = toLocal(m.frame, p.x, p.z);
      expect(u).toBeGreaterThanOrEqual(vb.u0 - 1e-6);
      expect(u).toBeLessThanOrEqual(vb.u1);
      expect(w).toBeGreaterThanOrEqual(vb.w0);
      expect(w).toBeLessThanOrEqual(vb.w1);
    }
  });

  it('has ≥ 2.5 m under a 1.2 m draft and nothing solid under the hull', () => {
    const c = checkDock(b, m, water);
    expect(c.minDepth).toBeGreaterThan(BERTH_YACHT.draft + MIN_UNDER_KEEL);
    expect(c.blocked).toBe(false);
    for (const p of hullFootprint(b)) expect(marinaStructureDistance(m, p.x, p.z)).toBeGreaterThan(0.2);
  });

  it('no moored boat lies in it or next to it', () => {
    for (const bt of m.berths) {
      const d = VESSEL_DIMS[bt.kind];
      expect(Math.hypot(bt.x - b.x, bt.z - b.z)).toBeGreaterThan((d.length * bt.scale) / 2 + 8);
    }
  });

  it('drives straight out: 400 m ahead along the heading is deep, free water', () => {
    const fx = Math.sin(b.headingDeg * DEG);
    const fz = -Math.cos(b.headingDeg * DEG);
    for (let s = 0; s <= 400; s += 2) {
      // the hull's width plus 0.3 m (alongside the pontoon), then beam + 3 m either side once past it
      const lats = s < 30 ? [-1, 0, 1].map((k) => k * (BERTH_YACHT.halfBeam + 0.3)) : [-1, -0.5, 0, 0.5, 1].map((k) => k * (BERTH_YACHT.halfBeam + 3));
      for (const off of lats) {
        const along = s - BERTH_YACHT.bowZ; // from the bow
        const x = b.x + fx * along - fz * off;
        const z = b.z + fz * along + fx * off;
        expect(seaDepth(water, x, z), `depth at ${s} m, ${off} m`).toBeGreaterThan(BERTH_YACHT.draft + MIN_UNDER_KEEL);
        expect(marinaObstacleTop(m, x, z), `structure at ${s} m, ${off} m`).toBe(-Infinity);
      }
    }
    // and it is out of the harbour by then
    const out = toLocal(m.frame, b.x + fx * 400, b.z + fz * 400);
    expect(out.w).toBeGreaterThan(m.entrance.w + 100);
  });

  it('no traffic route passes through it', () => {
    const plan = createSeaPlan(layout, water);
    expect(plan.rejected).toEqual([]);
    const s = newPathSample();
    for (const r of plan.routes) {
      for (let d = 0; d < r.path.length; d += 10) {
        samplePath(r.path, d, s);
        if (Math.abs(s.x - b.x) > 2000 || Math.abs(s.z - b.z) > 2000) continue;
        expect(Math.hypot(s.x - b.x, s.z - b.z), r.id).toBeGreaterThan(30);
      }
    }
  }, 60_000);

  it('is deterministic', () => {
    const again = playerBerth(getLayout(), CONFIG);
    expect(again).toEqual(b);
    // (a fresh marina from scratch agrees)
    const m2 = createMarina(getLayout());
    expect(m2.visitor).toEqual(m.visitor);
  });
});

describe('player port: the sea start', () => {
  const p = seaStart(layout);

  it('is 1.5–3 km off the marina entrance, heading out to sea', () => {
    const e = portInfo().entrance;
    const d = Math.hypot(p.x - e.x, p.z - e.z);
    expect(d).toBeGreaterThan(SEA_START.minOff - 1);
    expect(d).toBeLessThan(SEA_START.maxOff * 1.3);
    expect(p.z - layout.coast.zAt(p.x)).toBeGreaterThan(1400);
    expect(Math.cos(p.headingDeg * DEG)).toBeLessThan(-0.9); // south-ish
  });

  it('is deep open water, far from land, the islands and the traffic', () => {
    const c = checkDock(p, m, water);
    expect(c.minDepth).toBeGreaterThan(SEA_START.minDepth);
    expect(c.blocked).toBe(false);
    for (let a = 0; a < 360; a += 30) for (const r of [300, 800]) expect(seaDepth(water, p.x + r * Math.cos(a * DEG), p.z + r * Math.sin(a * DEG))).toBeGreaterThan(8);
    for (const i of layout.islands) expect(Math.hypot(i.x - p.x, i.z - p.z)).toBeGreaterThan(i.radius + 1000);
    expect(marinaStructureDistance(m, p.x, p.z)).toBeGreaterThan(1000);
    const plan = createSeaPlan(layout, null);
    const s = newPathSample();
    for (const r of plan.routes) {
      if (r.level > 1) continue;
      for (let d = 0; d < r.path.length; d += 25) {
        samplePath(r.path, d, s);
        expect(Math.hypot(s.x - p.x, s.z - p.z), r.id).toBeGreaterThan(SEA_START.routeClearance - 30);
      }
    }
  }, 30_000);

  it('is deterministic', () => {
    expect(seaStart(getLayout(), CONFIG)).toEqual(p);
  });
});
