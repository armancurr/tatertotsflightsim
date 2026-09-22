import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { buildRoadNetwork, type NetRoad } from '../../../src/world/roads/network';
import { createConstraints } from '../../../src/world/towns/constraints';
import { CONFIG } from '../../../src/config';
import { LAYOUT, HEIGHT, syntheticLayout } from './fixtures';
import { createStandInHeight } from '../../../src/world/towns/standin';
import { pointSegmentDistance } from '../../../src/world/towns/geom';

// whole-world placements are CPU-heavy: generous timeouts so the suite stays green under parallel load
vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const NET = buildRoadNetwork(LAYOUT, HEIGHT);
const C = createConstraints(LAYOUT);

const streetsOf = (ti: number): NetRoad[] => NET.roads.filter((r) => r.kind === 'street' && r.town === ti);
const distToRoads = (x: number, z: number, roads: { points: { x: number; z: number }[] }[]): number => {
  let best = Infinity;
  for (const r of roads) for (let i = 1; i < r.points.length; i++) best = Math.min(best, pointSegmentDistance(x, z, r.points[i - 1].x, r.points[i - 1].z, r.points[i].x, r.points[i].z));
  return best;
};

describe('road network', () => {
  it('is deterministic', () => {
    const b = buildRoadNetwork(LAYOUT, HEIGHT);
    expect(JSON.stringify(b.roads)).toBe(JSON.stringify(NET.roads));
    expect(JSON.stringify(b.farms)).toBe(JSON.stringify(NET.farms));
  });

  it('starts with every layout road, unchanged', () => {
    LAYOUT.roads.forEach((r, i) => {
      expect(NET.roads[i].name).toBe(r.name);
      expect(NET.roads[i].kind).toBe(r.kind);
      expect(NET.roads[i].points).toEqual(r.points);
    });
  });

  it('gives the city and the town a street grid aligned with their grid angle', () => {
    LAYOUT.towns.forEach((t, ti) => {
      if (t.kind !== 'city' && t.kind !== 'town') return;
      const streets = streetsOf(ti);
      expect(streets.length).toBeGreaterThan(t.kind === 'city' ? 40 : 12);
      for (const s of streets) {
        const a = s.points[0];
        const b = s.points[s.points.length - 1];
        const ang = ((Math.atan2(b.z - a.z, b.x - a.x) * 180) / Math.PI + 360) % 90;
        const diff = Math.min(Math.abs(ang - (t.gridAngleDeg % 90)), 90 - Math.abs(ang - (t.gridAngleDeg % 90)));
        expect(diff).toBeLessThan(0.5);
      }
    });
  });

  it('gives villages a few winding streets and hamlets at least one', () => {
    LAYOUT.towns.forEach((t, ti) => {
      if (t.kind === 'village') expect(streetsOf(ti).length).toBeGreaterThanOrEqual(2);
      if (t.kind === 'hamlet') expect(streetsOf(ti).length).toBeGreaterThanOrEqual(1);
    });
  });

  it('keeps streets inside their town, out of the water and off the airport', () => {
    for (const s of NET.roads) {
      if (s.kind !== 'street') continue;
      const t = LAYOUT.towns[s.town];
      for (const p of s.points) {
        expect(Math.hypot(p.x - t.x, p.z - t.z)).toBeLessThan(t.radius * 1.2 + 1);
        expect(C.waterClearance(p.x, p.z)).toBeGreaterThan(s.width / 2);
        expect(C.inAirport(p.x, p.z, 0)).toBe(false);
      }
    }
  });

  it('streets have evenly spaced points (≤ 12 m) and a sensible width', () => {
    for (const s of NET.roads) {
      if (s.kind !== 'street') continue;
      expect(s.width).toBeGreaterThanOrEqual(5);
      expect(s.width).toBeLessThanOrEqual(12);
      for (let i = 1; i < s.points.length; i++) expect(Math.hypot(s.points[i].x - s.points[i - 1].x, s.points[i].z - s.points[i - 1].z)).toBeLessThanOrEqual(12.001);
    }
  });

  describe('farmsteads', () => {
    const cfg = CONFIG.world.towns;
    it('scatters many farm sites over the countryside', () => {
      expect(NET.farms.length).toBeGreaterThan(150);
    });
    it('keeps farms away from towns, water, the airport, the mountains and each other', () => {
      for (const f of NET.farms) {
        for (const t of LAYOUT.towns) expect(Math.hypot(f.x - t.x, f.z - t.z)).toBeGreaterThan(t.radius + 300);
        expect(C.waterClearance(f.x, f.z)).toBeGreaterThan(120);
        expect(C.inAirport(f.x, f.z, 400)).toBe(false);
        expect(HEIGHT(f.x, f.z)).toBeLessThan(cfg.farmMaxHeight);
      }
      let minD = Infinity;
      for (let i = 0; i < NET.farms.length; i++)
        for (let j = i + 1; j < NET.farms.length; j++) minD = Math.min(minD, Math.hypot(NET.farms[i].x - NET.farms[j].x, NET.farms[i].z - NET.farms[j].z));
      expect(minD).toBeGreaterThan(300);
    });
    it('connects most farms by a driveway/track that starts on a road or another track and ends at the farm', () => {
      const drives = NET.roads.filter((r) => r.kind === 'drive');
      expect(drives.length).toBeGreaterThan(NET.farms.length * 0.6);
      const vertexKeys = new Set<string>();
      for (const d of drives) for (const p of d.points) vertexKeys.add(`${p.x.toFixed(6)},${p.z.toFixed(6)}`);
      for (const d of drives) {
        const a = d.points[0];
        const b = d.points[d.points.length - 1];
        const onRoad = distToRoads(a.x, a.z, LAYOUT.roads) < 0.5;
        const onTrack = vertexKeys.has(`${a.x.toFixed(6)},${a.z.toFixed(6)}`);
        expect(onRoad || onTrack).toBe(true);
        const f = NET.farms[d.farm];
        expect(f.drive).toBe(NET.roads.indexOf(d));
        expect(Math.hypot(b.x - f.x, b.z - f.z)).toBeLessThan(1e-6);
        for (const p of d.points.slice(1)) expect(C.waterClearance(p.x, p.z)).toBeGreaterThan(d.width / 2);
      }
    });
  });

  it('fuzz: streets of random settlements never enter water or the airport and stay near their town', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1_000_000 }), (seed) => {
        const L = syntheticLayout(seed);
        const net = buildRoadNetwork(L, createStandInHeight(L), { ...CONFIG.world.towns, farmsteadChance: 0 });
        const c = createConstraints(L);
        for (const s of net.roads) {
          if (s.kind !== 'street') continue;
          const t = L.towns[s.town];
          for (const p of s.points) {
            expect(c.waterClearance(p.x, p.z)).toBeGreaterThan(s.width / 2);
            expect(c.inAirport(p.x, p.z, 0)).toBe(false);
            expect(Math.hypot(p.x - t.x, p.z - t.z)).toBeLessThan(t.radius * 1.2 + 1);
          }
        }
      }),
      { numRuns: 25 },
    );
  }, 60_000);
});
