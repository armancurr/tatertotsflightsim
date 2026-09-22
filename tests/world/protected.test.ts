/**
 * FUNCTIONAL: the terrain realism pass may reshape the mountains, but the ground that other
 * modules build on — within 1.5 km of every town, road, the river, the lakes and the airport —
 * must stay exactly as it was (heights, landcover, surface types, tree density).
 *
 * The fixture was taken from the terrain BEFORE the realism pass. Regenerate it only for a
 * deliberate, coordinated change of the shared geography:
 *   UPDATE_PROTECTED_SNAPSHOT=1 npx vitest run tests/world/protected.test.ts
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getLayout } from '../../src/world/layout';
import { getHeightfield } from '../../src/world/heightfield';
import { getLandcover, newLandcover, LANDCOVER_KEYS } from '../../src/world/landcover';
import { mulberry32 } from '../../src/world/noise';

const FIXTURE = fileURLToPath(new URL('./fixtures/protected-snapshot.json', import.meta.url));
const RADIUS = 1500;

/** Compact integer storage: x, z in cm; h in mm; landcover and tree density in 1e-4. */
interface Snapshot {
  n: number;
  xz: number[];
  h: number[];
  lc: number[];
  td: number[];
  surf: string[];
  groupNames: string[];
  group: number[];
}
const SURF = ['runway', 'asphalt', 'grass', 'field', 'forest', 'rock', 'snow', 'sand', 'urban', 'water', 'dirt'];

/** Deterministic sample points in the protected zones (derived from the layout only). */
function protectedPoints(): { x: number; z: number; group: string }[] {
  const L = getLayout();
  const rnd = mulberry32(90210);
  const pts: { x: number; z: number; group: string }[] = [];
  const disc = (cx: number, cz: number, r: number, n: number, group: string) => {
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2;
      const d = Math.sqrt(rnd()) * r;
      pts.push({ x: cx + Math.cos(a) * d, z: cz + Math.sin(a) * d, group });
    }
  };
  for (const t of L.towns) disc(t.x, t.z, t.radius + RADIUS, t.kind === 'hamlet' ? 90 : t.kind === 'village' ? 160 : 400, `town:${t.name}`);
  disc(L.airport.runway.center.x, L.airport.runway.center.z, L.airport.flatRadius + RADIUS, 700, 'airport');
  const along = (line: { x: number; z: number }[], spacing: number, perStation: number, group: string) => {
    let next = 0; // arc length of the next station
    let arc = 0;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      const len = Math.hypot(b.x - a.x, b.z - a.z);
      if (len < 1e-6) continue;
      const nx = -(b.z - a.z) / len;
      const nz = (b.x - a.x) / len;
      while (next <= arc + len) {
        const t = (next - arc) / len;
        const px = a.x + (b.x - a.x) * t;
        const pz = a.z + (b.z - a.z) * t;
        for (let k = 0; k < perStation; k++) {
          const off = k === 0 ? 0 : (rnd() * 2 - 1) * RADIUS;
          pts.push({ x: px + nx * off, z: pz + nz * off, group });
        }
        next += spacing;
      }
      arc += len;
    }
  };
  for (const r of L.roads) along(r.points, r.kind === 'highway' ? 500 : 300, 4, `road:${r.name}`);
  for (const r of L.rivers) along(r.points, 300, 5, `river:${r.name}`);
  for (const lk of L.lakes) {
    const R = Math.max(lk.radiusX, lk.radiusZ) * 1.6 + RADIUS;
    disc(lk.center.x, lk.center.z, R, 500, `lake:${lk.name}`);
  }
  return pts;
}

function measure(points: { x: number; z: number; group: string }[]): Snapshot {
  const hf = getHeightfield();
  const lc = getLandcover();
  const w = newLandcover();
  const snap: Snapshot = { n: points.length, xz: [], h: [], lc: [], td: [], surf: [], groupNames: [], group: [] };
  const gi = new Map<string, number>();
  for (const p of points) {
    snap.xz.push(Math.round(p.x * 100), Math.round(p.z * 100));
    if (!gi.has(p.group)) {
      gi.set(p.group, snap.groupNames.length);
      snap.groupNames.push(p.group);
    }
    snap.group.push(gi.get(p.group)!);
  }
  let surf = '';
  for (let i = 0; i < points.length; i++) {
    const x = snap.xz[i * 2] / 100;
    const z = snap.xz[i * 2 + 1] / 100;
    snap.h.push(Math.round(hf.height(x, z) * 1000));
    lc.at(x, z, w);
    for (const k of LANDCOVER_KEYS) snap.lc.push(Math.round(w[k] * 10000));
    snap.td.push(Math.round(lc.treeDensity(x, z) * 10000));
    surf += SURF.indexOf(lc.surfaceAt(x, z)).toString(36);
  }
  snap.surf = [surf];
  return snap;
}

describe('protected ground (functional): unchanged near settlements, roads, water and the airport', () => {
  const points = protectedPoints();
  if (process.env.UPDATE_PROTECTED_SNAPSHOT || !existsSync(FIXTURE)) {
    if (!process.env.UPDATE_PROTECTED_SNAPSHOT) throw new Error(`missing fixture ${FIXTURE}`);
    writeFileSync(FIXTURE, JSON.stringify(measure(points)));
  }
  const ref: Snapshot = JSON.parse(readFileSync(FIXTURE, 'utf8'));

  it('samples every town, road, the river, both lakes and the airport', () => {
    expect(ref.n).toBe(points.length);
    expect(ref.n).toBeGreaterThan(8000);
    const groups = new Set(ref.groupNames);
    const L = getLayout();
    for (const t of L.towns) expect(groups.has(`town:${t.name}`)).toBe(true);
    for (const r of L.roads) expect(groups.has(`road:${r.name}`)).toBe(true);
    expect(groups.has('airport')).toBe(true);
  });

  it('heights, landcover, surface types and tree density match the pre-realism snapshot', () => {
    const now = measure(points);
    const bad: string[] = [];
    for (let i = 0; i < ref.n; i++) {
      const dh = Math.abs(now.h[i] - ref.h[i]) / 1000;
      let dl = 0;
      for (let k = 0; k < 8; k++) dl = Math.max(dl, Math.abs(now.lc[i * 8 + k] - ref.lc[i * 8 + k]) / 10000);
      const dt = Math.abs(now.td[i] - ref.td[i]) / 10000;
      const s0 = ref.surf[0][i];
      const s1 = now.surf[0][i];
      if (dh > 0.002 || dl > 0.0021 || dt > 0.0021 || s0 !== s1)
        bad.push(`${ref.groupNames[ref.group[i]]} (${ref.xz[i * 2] / 100}, ${ref.xz[i * 2 + 1] / 100}): dh ${dh.toFixed(3)} dlc ${dl.toFixed(4)} dtree ${dt.toFixed(4)} ${SURF[parseInt(s0, 36)]}→${SURF[parseInt(s1, 36)]}`);
    }
    expect(bad.slice(0, 20)).toEqual([]);
  });
});
