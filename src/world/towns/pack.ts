/**
 * Building[] ⇄ Float64Array, so the placement can be computed in a worker and
 * transferred without structured-cloning 10k+ objects. PURE.
 */
import { ARCHETYPES, type Building } from './placement';

const USES: Building['use'][] = ['house', 'apartment', 'shop', 'office', 'tower', 'industrial', 'warehouse', 'church', 'steeple', 'farmhouse', 'barn', 'silo', 'shed', 'tree', 'pool', 'garage', 'watertower', 'school', 'townhall', 'tank'];

export const PACK_STRIDE = 22;

export function packBuildings(bs: readonly Building[]): Float64Array {
  const a = new Float64Array(bs.length * PACK_STRIDE);
  bs.forEach((b, i) => {
    const o = i * PACK_STRIDE;
    a[o] = b.x;
    a[o + 1] = b.z;
    a[o + 2] = b.y;
    a[o + 3] = b.headingDeg;
    a[o + 4] = b.width;
    a[o + 5] = b.depth;
    a[o + 6] = b.wallHeight;
    a[o + 7] = b.roofHeight;
    a[o + 8] = b.ridge;
    a[o + 9] = b.ridgeAxis;
    a[o + 10] = ARCHETYPES.indexOf(b.archetype);
    a[o + 11] = USES.indexOf(b.use);
    a[o + 12] = b.wallColor;
    a[o + 13] = b.roofColor;
    a[o + 14] = b.floorHeight;
    a[o + 15] = b.style;
    a[o + 16] = b.rand;
    a[o + 17] = b.town;
    a[o + 18] = b.farm;
    a[o + 19] = b.plinth ?? 0;
    a[o + 20] = b.tierHeight ?? 0;
    a[o + 21] = b.tierInset ?? 0;
  });
  return a;
}

export function unpackBuildings(a: Float64Array): Building[] {
  const n = Math.floor(a.length / PACK_STRIDE);
  const out: Building[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * PACK_STRIDE;
    const b: Building = {
      x: a[o],
      z: a[o + 1],
      y: a[o + 2],
      headingDeg: a[o + 3],
      width: a[o + 4],
      depth: a[o + 5],
      wallHeight: a[o + 6],
      roofHeight: a[o + 7],
      ridge: a[o + 8],
      ridgeAxis: a[o + 9] as 0 | 1,
      archetype: ARCHETYPES[a[o + 10]],
      use: USES[a[o + 11]],
      wallColor: a[o + 12],
      roofColor: a[o + 13],
      floorHeight: a[o + 14],
      style: a[o + 15],
      rand: a[o + 16],
      town: a[o + 17],
      farm: a[o + 18],
      plinth: a[o + 19],
    };
    if (a[o + 20] > 0) {
      b.tierHeight = a[o + 20];
      b.tierInset = a[o + 21];
    }
    out[i] = b;
  }
  return out;
}
