import { describe, it, expect } from 'vitest';
import { landcoverAt, surfaceAt, treeDensity, LANDCOVER_KEYS } from '../../src/world/landcover';
import { terrainHeight, terrainNormal, getHeightfield } from '../../src/world/heightfield';
import { getLayout } from '../../src/world/layout';
import { runwayFrame } from '../../src/world/runway';
import { CONFIG } from '../../src/config';
import type { SurfaceType } from '../../src/types';

const L = getLayout();
const rw = runwayFrame();

describe('landcover weights', () => {
  it('are 8 weights in [0,1] that sum to 1, deterministically', () => {
    expect(LANDCOVER_KEYS).toEqual(['forest', 'field', 'grass', 'rock', 'snow', 'sand', 'urban', 'water']);
    for (let i = 0; i < 2000; i++) {
      const x = ((i * 7919) % 70000) - 35000;
      const z = ((i * 104729) % 70000) - 35000;
      const w = landcoverAt(x, z);
      let sum = 0;
      for (const k of LANDCOVER_KEYS) {
        expect(w[k]).toBeGreaterThanOrEqual(0);
        expect(w[k]).toBeLessThanOrEqual(1);
        sum += w[k];
      }
      expect(sum).toBeCloseTo(1, 6);
      expect(landcoverAt(x, z)).toEqual(w);
    }
  });

  it('puts farmland on the plains, forest in the foothills, snow and rock on the high peaks', () => {
    const frac = (x0: number, x1: number, z0: number, z1: number, key: keyof ReturnType<typeof landcoverAt>) => {
      let s = 0;
      let n = 0;
      for (let z = z0; z < z1; z += 211)
        for (let x = x0; x < x1; x += 223) {
          if (Math.hypot(x, z) < 3000) continue;
          s += landcoverAt(x, z)[key];
          n++;
        }
      return s / n;
    };
    expect(frac(-20000, 20000, -5000, 4000, 'field')).toBeGreaterThan(0.3);
    expect(frac(-20000, 20000, -5000, 4000, 'forest')).toBeGreaterThan(0.05);
    expect(frac(-20000, 20000, -11000, -7000, 'forest')).toBeGreaterThan(0.25);
    // the highest ground is snow or rock
    let hi = { h: -Infinity, x: 0, z: 0 };
    for (let z = -30000; z <= -12000; z += 200)
      for (let x = -20000; x <= 20000; x += 200) {
        const h = terrainHeight(x, z);
        if (h > hi.h) hi = { h, x, z };
      }
    const w = landcoverAt(hi.x, hi.z);
    expect(w.snow + w.rock).toBeGreaterThan(0.7);
  });

  it('marks water where there is water and urban in town centres', () => {
    expect(landcoverAt(0, L.coast.zAt(0) + 4000).water).toBe(1);
    expect(landcoverAt(L.lakes[0].center.x, L.lakes[0].center.z).water).toBe(1);
    for (const t of L.towns.filter((t) => t.kind !== 'hamlet')) {
      if (terrainHeight(t.x, t.z) < 0.5) continue;
      expect(landcoverAt(t.x, t.z).urban).toBeGreaterThan(0.4);
    }
  });
});

describe('surfaceAt', () => {
  it('puts the physics spawn point on the runway', () => {
    const off = CONFIG.aircraft.spawn.runwayStartOffset;
    expect(surfaceAt(rw.threshold.x + rw.dir.x * off, rw.threshold.z + rw.dir.z * off)).toBe('runway');
    expect(surfaceAt(0, 0)).toBe('runway');
  });
  it('knows taxiways and the apron are asphalt, and the infield is grass', () => {
    for (const t of L.airport.taxiways) {
      const c = t.rect.center;
      // connectors start on the runway edge; test their outer half
      expect(['asphalt', 'runway']).toContain(surfaceAt(c.x, c.z));
    }
    const par = L.airport.taxiways.find((t) => t.kind === 'parallel')!;
    expect(surfaceAt(par.rect.center.x, par.rect.center.z)).toBe('asphalt');
    expect(surfaceAt(L.airport.apron.center.x, L.airport.apron.center.z)).toBe('asphalt');
    expect(surfaceAt(-60, 0)).toBe('grass');
    expect(surfaceAt(-400, 300)).toBe('grass');
  });
  it('classifies water, beach, roads, towns, snow and rock', () => {
    expect(surfaceAt(0, L.coast.zAt(0) + 3000)).toBe('water');
    expect(surfaceAt(L.lakes[0].center.x, L.lakes[0].center.z)).toBe('water');
    const r = L.rivers[0];
    const mid = r.points[Math.floor(r.points.length / 2)];
    expect(surfaceAt(mid.x, mid.z)).toBe('water');
    // a beach: walk south from land to the first point below 1.5 m
    let beaches = 0;
    for (let x = -12000; x <= 12000; x += 3000) {
      for (let z = L.coast.zAt(x) - 800; z < L.coast.zAt(x) + 800; z += 4) {
        const h = terrainHeight(x, z);
        if (h > 0.2 && h < 1.5) {
          if (surfaceAt(x, z) === 'sand') beaches++;
          break;
        }
      }
    }
    expect(beaches).toBeGreaterThanOrEqual(6);
    const road = L.roads.find((rd) => rd.kind === 'highway')!;
    let asphalt = 0;
    for (let i = 10; i < road.points.length; i += 97) if (surfaceAt(road.points[i].x, road.points[i].z) === 'asphalt') asphalt++;
    expect(asphalt).toBeGreaterThan(20);
    const town = L.towns.find((t) => t.kind === 'town')!;
    expect(surfaceAt(town.x + 40, town.z + 40)).toBe('urban');
    const seen = new Set<SurfaceType>();
    for (let z = -30000; z <= -12000; z += 150)
      for (let x = -15000; x <= 15000; x += 150) {
        const s = surfaceAt(x, z);
        seen.add(s);
        if (s === 'snow') expect(terrainHeight(x, z)).toBeGreaterThan(1500);
        if (s === 'rock') expect(terrainNormal(x, z).y < 0.9 || terrainHeight(x, z) > 2000).toBe(true);
      }
    expect(seen.has('snow')).toBe(true);
    expect(seen.has('rock')).toBe(true);
    expect(seen.has('forest')).toBe(true);
  });
});

describe('treeDensity', () => {
  it('is zero on paved areas, roads, water, fields and town centres', () => {
    const hf = getHeightfield();
    expect(treeDensity(0, 0)).toBe(0);
    expect(treeDensity(L.airport.apron.center.x, L.airport.apron.center.z)).toBe(0);
    for (let along = 0; along <= 1600; along += 50) expect(treeDensity(20, 800 - along)).toBe(0);
    expect(treeDensity(0, L.coast.zAt(0) + 3000)).toBe(0);
    expect(treeDensity(L.lakes[0].center.x, L.lakes[0].center.z)).toBe(0);
    for (const road of L.roads) for (let i = 0; i < road.points.length; i += 53) expect(treeDensity(road.points[i].x, road.points[i].z)).toBe(0);
    for (const t of L.towns) expect(treeDensity(t.x, t.z)).toBe(0);
    let fieldPts = 0;
    for (let z = -5000; z < 4000; z += 97)
      for (let x = -20000; x < 20000; x += 131) {
        const w = landcoverAt(x, z);
        if (w.field > 0.95) {
          fieldPts++;
          expect(treeDensity(x, z)).toBeLessThan(0.05);
        }
      }
    expect(fieldPts).toBeGreaterThan(100);
    expect(hf).toBeTruthy();
  });
  it('is high in forests and keeps the approach paths clear', () => {
    let forestPts = 0;
    let dense = 0;
    for (let z = -12000; z < -6000; z += 97)
      for (let x = -20000; x < 20000; x += 131) {
        const w = landcoverAt(x, z);
        if (w.forest > 0.9) {
          forestPts++;
          if (treeDensity(x, z) > 0.5) dense++;
        }
      }
    expect(forestPts).toBeGreaterThan(100);
    expect(dense / forestPts).toBeGreaterThan(0.9);
    // nothing tall under the final approach to either runway end (3 km out)
    for (let d = 0; d <= 3000; d += 50) {
      expect(treeDensity(0, rw.threshold.z + d)).toBe(0);
      expect(treeDensity(0, rw.farEnd.z - d)).toBe(0);
    }
  });
});
