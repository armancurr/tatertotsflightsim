/**
 * A stand-in heightfield for tests and the towns preview, until the real
 * `terrainHeight` is wired in: gentle rolling hills rising toward the northern
 * mountains, exactly flat at the field elevation around the airport, a coast
 * sloping into the sea, the river channel carved below its water level and the
 * lakes as flat basins. Deterministic and allocation-free per call. PURE.
 */
import type { WorldLayout } from '../layout';
import { lakeSignedDistance } from '../layout';
import { createSimplex2D, fbm } from '../noise';
import { PolylineIndex, newPolyQuery } from '../polyline';

const smooth = (e0: number, e1: number, x: number): number => {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};

export function createStandInHeight(layout: WorldLayout): (x: number, z: number) => number {
  const noise = createSimplex2D((layout.seed ^ 0x7a11) | 0);
  const ap = layout.airport;
  const cx = ap.runway.center.x;
  const cz = ap.runway.center.z;
  const river = layout.rivers[0];
  let maxHW = 0;
  for (const w of river?.halfWidths ?? []) maxHW = Math.max(maxHW, w);
  const riverIdx = river
    ? new PolylineIndex([river.points], [river.points.map((_, i) => [river.levels[i], river.halfWidths[i], river.depths[i]])], 3, maxHW + 160, 128, 12)
    : null;
  const q = newPolyQuery(3);
  const lakes = layout.lakes;
  return (x: number, z: number): number => {
    // rolling hills + a rise toward the northern range
    let h = 42 + 30 * fbm(noise, x / 2600, z / 2600, 4) + 12 * fbm(noise, x / 700 + 31.7, z / 700 - 4.1, 2);
    const north = -z;
    h += 0.018 * Math.max(0, north - 6000) * smooth(6000, 16000, north) + 0.03 * Math.max(0, north - 16000);
    // coast: ease down to the shoreline, then the sea floor
    const coastD = layout.coast.zAt(x) - z; // + inland
    if (coastD < 900) {
      const shore = 1.5 + (h - 1.5) * smooth(0, 900, coastD);
      h = coastD >= 0 ? shore : -2 + coastD * 0.03;
    }
    // lakes: flat basin below the level, shores easing up
    for (let i = 0; i < lakes.length; i++) {
      const sd = lakeSignedDistance(lakes[i], x, z);
      if (sd > 300) continue;
      const lv = lakes[i].level;
      if (sd < 0) h = lv - Math.min(lakes[i].maxDepth, 2 - sd * 0.05);
      else h = lv + 1 + (Math.max(h, lv + 1) - lv - 1) * smooth(0, 300, sd);
    }
    // river: valley floor pulled to just above the water, channel carved below it
    if (riverIdx && riverIdx.query(x, z, q)) {
      const lv = q.v[0];
      const hw = q.v[1];
      const depth = q.v[2];
      const d = q.d;
      const bank = lv + 1.6;
      if (d < hw) h = lv - depth * (1 - (d / hw) * (d / hw));
      else h = bank + (Math.max(h, bank) - bank) * smooth(hw, hw + 150, d) - (bank - lv) * (1 - smooth(hw, hw + 10, d));
    }
    // airport plateau (last: exactly flat)
    const ad = Math.hypot(x - cx, z - cz);
    if (ad < ap.flatRadius + ap.blendWidth) {
      const t = smooth(ap.flatRadius, ap.flatRadius + ap.blendWidth, ad);
      h = ap.elevation + (h - ap.elevation) * t;
    }
    return h;
  };
}
