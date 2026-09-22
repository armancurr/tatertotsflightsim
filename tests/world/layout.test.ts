import { describe, it, expect } from 'vitest';
import { createLayout, getLayout, type OrientedRect } from '../../src/world/layout';
import { runwayFrame, isOnRunway, toRunwayCoords } from '../../src/world/runway';
import { CONFIG } from '../../src/config';

const L = getLayout();
const rw = runwayFrame();

function rectCorners(r: OrientedRect): { x: number; z: number }[] {
  const h = (r.headingDeg * Math.PI) / 180;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  const rx = Math.cos(h);
  const rz = Math.sin(h);
  const out = [];
  for (const a of [-1, 1]) for (const b of [-1, 1]) out.push({ x: r.center.x + fx * r.halfLength * a + rx * r.halfWidth * b, z: r.center.z + fz * r.halfLength * a + rz * r.halfWidth * b });
  return out;
}

describe('world layout', () => {
  it('is deterministic from config + seed', () => {
    const a = createLayout(CONFIG);
    const b = createLayout(CONFIG);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.seed).toBe(CONFIG.world.seed);
  });

  describe('airport', () => {
    const ap = L.airport;
    it('uses the runway from runway.ts at the field elevation', () => {
      expect(ap.elevation).toBe(CONFIG.world.airport.elevation);
      expect(ap.runway.threshold).toEqual(rw.threshold);
      expect(ap.runway.farEnd).toEqual(rw.farEnd);
    });
    it('has a parallel taxiway off the runway, with connectors that touch the runway', () => {
      const parallel = ap.taxiways.find((t) => t.kind === 'parallel')!;
      expect(parallel).toBeTruthy();
      expect(parallel.rect.headingDeg % 180).toBeCloseTo(rw.headingDeg % 180);
      const c = toRunwayCoords(parallel.rect.center.x, parallel.rect.center.z);
      expect(Math.abs(c.across)).toBeGreaterThan(60);
      expect(Math.abs(c.across)).toBeLessThan(250);
      expect(parallel.rect.halfLength * 2).toBeGreaterThan(rw.length * 0.8);
      for (const p of rectCorners(parallel.rect)) expect(isOnRunway(p.x, p.z)).toBe(false);
      const connectors = ap.taxiways.filter((t) => t.kind === 'connector');
      expect(connectors.length).toBeGreaterThanOrEqual(2);
      for (const t of connectors) {
        const cc = rectCorners(t.rect).map((p) => toRunwayCoords(p.x, p.z));
        const minAcross = Math.min(...cc.map((q) => Math.abs(q.across)));
        expect(minAcross).toBeLessThanOrEqual(rw.halfWidth + 0.5);
      }
    });
    it('has an apron next to the taxiway and building/parking spots on the airfield', () => {
      const apron = ap.apron;
      for (const p of rectCorners(apron)) expect(isOnRunway(p.x, p.z)).toBe(false);
      const spots = [...ap.hangars.map((h) => h.center), ap.tower.center, ap.terminal.center, ap.fuel, ...ap.parkingSpots];
      expect(ap.hangars.length).toBeGreaterThanOrEqual(3);
      expect(ap.parkingSpots.length).toBeGreaterThanOrEqual(4);
      for (const s of spots) {
        expect(Math.hypot(s.x - rw.center.x, s.z - rw.center.z)).toBeLessThan(CONFIG.world.airport.flatRadius - 100);
        expect(isOnRunway(s.x, s.z)).toBe(false);
      }
      expect(ap.pavedAreas.length).toBeGreaterThanOrEqual(3);
    });
  });

  describe('coast and sea', () => {
    it('puts the coastline 6–9 km south of the airport with a bay', () => {
      const z0 = L.coast.zAt(0);
      expect(z0).toBeGreaterThan(6000);
      expect(z0).toBeLessThan(9000);
      const bay = L.coast.bay;
      expect(L.coast.zAt(bay.x)).toBeLessThan(L.coast.zAt(bay.x - 5000) - 700);
      expect(L.coast.zAt(bay.x)).toBeLessThan(L.coast.zAt(bay.x + 5000) - 700);
      expect(L.coast.polyline.length).toBeGreaterThan(100);
    });
    it('has islands offshore', () => {
      expect(L.islands.length).toBeGreaterThanOrEqual(1);
      for (const isl of L.islands) expect(isl.z).toBeGreaterThan(L.coast.zAt(isl.x) + isl.radius);
    });
  });

  describe('water features', () => {
    it('has at least one lake with its own level above the sea', () => {
      expect(L.lakes.length).toBeGreaterThanOrEqual(1);
      for (const lake of L.lakes) {
        expect(lake.level).toBeGreaterThan(5);
        expect(lake.shoreline.length).toBeGreaterThan(16);
      }
    });
    it('has a river from the mountains to the sea passing a few km east of the airport', () => {
      const river = L.rivers[0];
      expect(river.points.length).toBeGreaterThan(100);
      expect(river.levels.length).toBe(river.points.length);
      expect(river.halfWidths.length).toBe(river.points.length);
      const src = river.points[0];
      const mouth = river.points[river.points.length - 1];
      expect(-src.z).toBeGreaterThan(12000);
      expect(mouth.z).toBeGreaterThan(L.coast.zAt(mouth.x));
      for (let i = 1; i < river.levels.length; i++) expect(river.levels[i]).toBeLessThanOrEqual(river.levels[i - 1] + 1e-9);
      expect(river.levels[river.levels.length - 1]).toBe(0);
      expect(river.levels[0]).toBeGreaterThan(200);
      // where it crosses the airport's latitude (z = 0) it is 1.5–6 km east
      let crossX = NaN;
      for (let i = 1; i < river.points.length; i++) {
        const a = river.points[i - 1];
        const b = river.points[i];
        if ((a.z - 0) * (b.z - 0) <= 0) crossX = a.x + ((0 - a.z) / (b.z - a.z)) * (b.x - a.x);
      }
      expect(crossX).toBeGreaterThan(1500);
      expect(crossX).toBeLessThan(6000);
    });
  });

  describe('settlements and roads', () => {
    it('has a town ~3 km SE, a coastal city ~9 km S/SW and several villages', () => {
      const town = L.towns.find((t) => t.kind === 'town')!;
      const d = Math.hypot(town.x, town.z);
      expect(d).toBeGreaterThan(2000);
      expect(d).toBeLessThan(4000);
      expect(town.x).toBeGreaterThan(0);
      expect(town.z).toBeGreaterThan(0);
      const city = L.towns.find((t) => t.kind === 'city')!;
      const dc = Math.hypot(city.x, city.z);
      expect(dc).toBeGreaterThan(7000);
      expect(dc).toBeLessThan(11500);
      expect(city.x).toBeLessThanOrEqual(0);
      expect(L.coast.zAt(city.x) - city.z).toBeLessThan(city.radius + 600);
      expect(L.towns.filter((t) => t.kind === 'village').length).toBeGreaterThanOrEqual(4);
    });
    it('connects the airport to the town, runs a coastal highway and a valley road into the mountains', () => {
      const town = L.towns.find((t) => t.kind === 'town')!;
      const access = L.roads.find((r) => r.kind === 'access')!;
      const a0 = access.points[0];
      const a1 = access.points[access.points.length - 1];
      expect(Math.hypot(a0.x - L.airport.apron.center.x, a0.z - L.airport.apron.center.z)).toBeLessThan(500);
      expect(Math.hypot(a1.x - town.x, a1.z - town.z)).toBeLessThan(town.radius);
      const hwy = L.roads.find((r) => r.kind === 'highway')!;
      const xs = hwy.points.map((p) => p.x);
      expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(30000);
      const valley = L.roads.find((r) => r.name.toLowerCase().includes('valley'))!;
      expect(Math.max(...valley.points.map((p) => -p.z))).toBeGreaterThan(12000);
      for (const r of L.roads) {
        expect(r.width).toBeGreaterThan(3);
        for (let i = 1; i < r.points.length; i++) {
          const seg = Math.hypot(r.points[i].x - r.points[i - 1].x, r.points[i].z - r.points[i - 1].z);
          expect(seg).toBeLessThan(60);
        }
      }
    });
    it('keeps roads off the runway and records bridges where roads cross the river', () => {
      for (const r of L.roads) for (const p of r.points) expect(isOnRunway(p.x, p.z)).toBe(false);
      expect(L.bridges.length).toBeGreaterThanOrEqual(1);
      for (const b of L.bridges) expect(b.length).toBeGreaterThan(20);
    });
  });
});
