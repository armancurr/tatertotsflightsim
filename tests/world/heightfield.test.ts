import { describe, it, expect } from 'vitest';
import { terrainHeight, terrainNormal, createHeightfield, getHeightfield } from '../../src/world/heightfield';
import { getLayout, type OrientedRect } from '../../src/world/layout';
import { runwayFrame, fromRunwayCoords } from '../../src/world/runway';
import { CONFIG } from '../../src/config';

const L = getLayout();
const rw = runwayFrame();
const ELEV = CONFIG.world.airport.elevation;

function sampleRect(r: OrientedRect, n: number): { x: number; z: number }[] {
  const h = (r.headingDeg * Math.PI) / 180;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  const rx = Math.cos(h);
  const rz = Math.sin(h);
  const pts = [];
  for (let i = 0; i <= n; i++)
    for (let j = 0; j <= n; j++) {
      const a = (i / n) * 2 - 1;
      const b = (j / n) * 2 - 1;
      pts.push({ x: r.center.x + fx * r.halfLength * a + rx * r.halfWidth * b, z: r.center.z + fz * r.halfLength * a + rz * r.halfWidth * b });
    }
  return pts;
}

describe('heightfield', () => {
  it('is deterministic', () => {
    const other = createHeightfield(CONFIG);
    for (let i = 0; i < 500; i++) {
      const x = (i * 7919) % 60000 - 30000;
      const z = (i * 104729) % 60000 - 30000;
      expect(terrainHeight(x, z)).toBe(terrainHeight(x, z));
      expect(other.height(x, z)).toBe(terrainHeight(x, z));
    }
  });

  it('is exactly flat at the field elevation over the runway, taxiways and apron', () => {
    for (let along = -30; along <= rw.length + 30; along += 10)
      for (let across = -rw.halfWidth - 10; across <= rw.halfWidth + 10; across += 2.5) {
        const p = fromRunwayCoords(along, across);
        expect(Math.abs(terrainHeight(p.x, p.z) - ELEV)).toBeLessThan(0.01);
      }
    for (const area of L.airport.pavedAreas)
      for (const p of sampleRect(area, 24)) expect(Math.abs(terrainHeight(p.x, p.z) - ELEV)).toBeLessThan(0.01);
    const n = terrainNormal(0, 0);
    expect(n.y).toBeCloseTo(1, 6);
  });

  it('blends smoothly away from the airport plateau', () => {
    const { flatRadius, blendWidth } = CONFIG.world.airport;
    for (let a = 0; a < 360; a += 15) {
      let prev = terrainHeight(0, 0);
      for (let r = 0; r <= flatRadius + blendWidth + 200; r += 5) {
        const x = Math.sin((a * Math.PI) / 180) * r;
        const z = Math.cos((a * Math.PI) / 180) * r;
        const h = terrainHeight(x, z);
        expect(Math.abs(h - prev)).toBeLessThan(1.0); // < 20% grade over 5 m
        prev = h;
      }
    }
  });

  it('has big mountains to the north (12–30 km) and none near the airport', () => {
    let maxNorth = -Infinity;
    for (let z = -30000; z <= -12000; z += 150) for (let x = -20000; x <= 20000; x += 150) maxNorth = Math.max(maxNorth, terrainHeight(x, z));
    expect(maxNorth).toBeGreaterThan(1800);
    expect(maxNorth).toBeLessThan(3200);
    let maxNear = -Infinity;
    for (let z = -3000; z <= 3000; z += 100) for (let x = -3000; x <= 3000; x += 100) maxNear = Math.max(maxNear, terrainHeight(x, z));
    expect(maxNear).toBeLessThan(120);
  });

  it('has the sea to the south: below sea level with water at level 0', () => {
    const hf = getHeightfield();
    for (let x = -20000; x <= 20000; x += 2500) {
      const z = L.coast.zAt(x) + 3000;
      if (L.islands.some((i) => Math.hypot(x - i.x, z - i.z) < i.radius * 2)) continue;
      expect(terrainHeight(x, z)).toBeLessThan(-2);
      expect(hf.waterLevel(x, z)).toBe(0);
    }
    expect(terrainHeight(0, 30000)).toBeLessThan(-40);
  });

  it('has beaches that slope gently into the sea', () => {
    for (let x = -12000; x <= 12000; x += 1500) {
      const zc = L.coast.zAt(x);
      let crossings = 0;
      let prev = terrainHeight(x, zc - 1500);
      for (let z = zc - 1500; z <= zc + 1500; z += 5) {
        const h = terrainHeight(x, z);
        if (prev >= 0 && h < 0) crossings++;
        expect(Math.abs(h - prev)).toBeLessThan(3);
        prev = h;
      }
      expect(crossings).toBeGreaterThanOrEqual(1);
    }
  });

  it('carves lakes below their water level', () => {
    const hf = getHeightfield();
    for (const lake of L.lakes) {
      expect(terrainHeight(lake.center.x, lake.center.z)).toBeLessThan(lake.level - 2);
      expect(hf.waterLevel(lake.center.x, lake.center.z)).toBe(lake.level);
      // the shore rises above the water just outside the shoreline
      for (let i = 0; i < lake.shoreline.length; i += 4) {
        const p = lake.shoreline[i];
        const dx = p.x - lake.center.x;
        const dz = p.z - lake.center.z;
        const d = Math.hypot(dx, dz);
        const q = { x: p.x + (dx / d) * 60, z: p.z + (dz / d) * 60 };
        expect(terrainHeight(q.x, q.z)).toBeGreaterThan(lake.level);
      }
    }
  });

  it('carves the river bed below its water level along its whole length', () => {
    const hf = getHeightfield();
    const river = L.rivers[0];
    for (let i = 0; i < river.points.length; i += 5) {
      const p = river.points[i];
      const h = terrainHeight(p.x, p.z);
      expect(h).toBeLessThan(river.levels[i] - 0.5);
      const wl = hf.waterLevel(p.x, p.z);
      expect(wl).not.toBeNull();
      expect(Math.abs((wl as number) - river.levels[i])).toBeLessThan(1.5);
    }
  });

  it('has no unintended cliffs (1 m steps change height by < 2 m away from carved banks)', () => {
    const hf = getHeightfield();
    let worst = 0;
    for (let z = -32000; z <= 32000; z += 97) {
      for (let x = -32000; x <= 32000; x += 131) {
        if (hf.nearCarvedBank(x, z)) continue;
        const h = terrainHeight(x, z);
        const dx = Math.abs(terrainHeight(x + 1, z) - h);
        const dz = Math.abs(terrainHeight(x, z + 1) - h);
        worst = Math.max(worst, dx, dz);
      }
    }
    expect(worst).toBeLessThan(2);
  });

  it('is continuous across the whole feature set at fine scale', () => {
    // walk lines through the airport, river, lake and town and check 0.25 m steps
    const lines = [
      [-6000, 0, 8000, 0],
      [3000, -12000, 4500, 9000],
      [L.lakes[0].center.x - 2500, L.lakes[0].center.z, L.lakes[0].center.x + 2500, L.lakes[0].center.z],
    ];
    for (const [x0, z0, x1, z1] of lines) {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const n = Math.floor(len / 0.25);
      let prev = terrainHeight(x0, z0);
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const h = terrainHeight(x0 + (x1 - x0) * t, z0 + (z1 - z0) * t);
        expect(Math.abs(h - prev)).toBeLessThan(1.0);
        prev = h;
      }
    }
  });

  it('returns unit normals that point up and follow the slope', () => {
    for (let i = 0; i < 400; i++) {
      const x = (i * 3571) % 50000 - 25000;
      const z = -((i * 2749) % 30000);
      const n = terrainNormal(x, z);
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 6);
      expect(n.y).toBeGreaterThan(0);
      const h = terrainHeight(x, z);
      const slopeX = (terrainHeight(x + 1, z) - terrainHeight(x - 1, z)) / 2;
      if (Math.abs(slopeX) > 0.2) expect(Math.sign(n.x)).toBe(-Math.sign(slopeX));
      expect(Number.isFinite(h)).toBe(true);
    }
  });

  it('never ends: plausible, varied terrain far away in every direction', () => {
    for (const [x, z] of [
      [100000, 0],
      [-100000, 0],
      [0, -100000],
      [0, 100000],
      [2.5e6, -1.7e6],
    ]) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < 50; i++) {
        const h = terrainHeight(x + i * 311, z + i * 173);
        expect(Number.isFinite(h)).toBe(true);
        lo = Math.min(lo, h);
        hi = Math.max(hi, h);
      }
      expect(hi - lo).toBeGreaterThan(0.5);
      expect(hi).toBeLessThan(3500);
      expect(lo).toBeGreaterThan(-400);
    }
  });

  it('is fast: at least 500k terrainHeight samples per second (best of 5 batches)', () => {
    // The physics needs ~2k samples/s and the chunk workers ~200k/s; this guards against a gross
    // regression while staying robust when the whole suite (incl. headless-Chrome e2e) shares the CPU.
    let s = 0;
    for (let i = 0; i < 200000; i++) s += terrainHeight((i % 1000) * 60 - 30000, Math.floor(i / 1000) * 300 - 30000);
    const N = 200_000;
    let best = 0;
    for (let batch = 0; batch < 5; batch++) {
      const t0 = performance.now();
      for (let i = 0; i < N; i++) s += terrainHeight((i % 1000) * 60 - 30000 + 13 + batch, Math.floor(i / 1000) * 60 - 30000 + 7);
      const dt = (performance.now() - t0) / 1000;
      best = Math.max(best, N / dt);
    }
    expect(Number.isFinite(s)).toBe(true);
    expect(best).toBeGreaterThan(500_000);
  });
});
