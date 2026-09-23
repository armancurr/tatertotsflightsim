/**
 * `obstacleTop(x, z)` for the physics environment: the height (m MSL) of the
 * top of the building under (x, z) — its roof surface — or −Infinity where
 * there is none. A spatial hash over the same placement the renderer draws, so
 * what you see is what you hit. Allocation-free queries.
 */
import { roofTopAt, buildingRect, type Building } from './placement';
import { rectRadius } from './geom';

export function createObstacleIndex(buildings: readonly Building[], cellSize = 24): (x: number, z: number) => number {
  const inv = 1 / cellSize;
  const lists = new Map<number, number[]>();
  const key = (i: number, j: number): number => (i + 0x8000) * 0x10000 + (j + 0x8000);
  // bounding circles: most candidates in a cell are rejected without the (trigonometric) roof query
  const circ = new Float64Array(buildings.length * 3);
  buildings.forEach((b, idx) => {
    const r = rectRadius(buildingRect(b));
    circ[idx * 3] = b.x;
    circ[idx * 3 + 1] = b.z;
    circ[idx * 3 + 2] = (r + 1e-6) * (r + 1e-6);
    const i0 = Math.floor((b.x - r) * inv);
    const i1 = Math.floor((b.x + r) * inv);
    const j0 = Math.floor((b.z - r) * inv);
    const j1 = Math.floor((b.z + r) * inv);
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = key(i, j);
        const l = lists.get(k);
        if (l) l.push(idx);
        else lists.set(k, [idx]);
      }
  });
  const cells = new Map<number, Int32Array>();
  for (const [k, l] of lists) cells.set(k, Int32Array.from(l));
  return (x: number, z: number): number => {
    if (!(Number.isFinite(x) && Number.isFinite(z))) return -Infinity;
    const i = Math.floor(x * inv);
    const j = Math.floor(z * inv);
    if (i < -0x8000 || i >= 0x8000 || j < -0x8000 || j >= 0x8000) return -Infinity;
    const list = cells.get(key(i, j));
    if (!list) return -Infinity;
    let top = -Infinity;
    for (let n = 0; n < list.length; n++) {
      const k = list[n] * 3;
      const dx = x - circ[k];
      const dz = z - circ[k + 1];
      if (dx * dx + dz * dz > circ[k + 2]) continue;
      const t = roofTopAt(buildings[list[n]], x, z);
      if (t > top) top = t;
    }
    return top;
  };
}
