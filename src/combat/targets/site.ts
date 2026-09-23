/**
 * Where the target range goes (PURE, deterministic, cheap enough for the main thread): the most
 * open, flat patch of farmland/grass between minDistance and maxDistance from the runway centre,
 * preferring the bearing `bearingDeg` (straight ahead after a runway-36 take-off).
 *
 * A coarse grid of "open" cells (surface + slope + dry) is sampled once over the search sector;
 * every candidate centre on a polar grid is scored by the open fraction of the patch around it,
 * minus a cost for straying off the preferred bearing and for distance beyond minDistance.
 */
import { CONFIG } from '../../config';
import type { RangeInfo } from '../types';
import { openAt, type RangeConfig, type RangeGround } from './ground';

export interface RangeSite extends RangeInfo {
  /** Bearing and distance of the site from the runway centre (0, 0). */
  bearingDeg: number;
  distance: number;
  /** Open fraction of the scored patch 0..1, and the final score. */
  open: number;
  score: number;
  /** Grid cells sampled (for stats/tests). */
  samples: number;
}

const DEG = Math.PI / 180;

export function findRangeSite(g: Pick<RangeGround, 'surface' | 'normal' | 'water'>, cfg: RangeConfig = CONFIG.combat.range): RangeSite {
  const S = cfg.search;
  const step = S.step;
  const cells = new Map<number, boolean>();
  const OFF = 1 << 15;
  let samples = 0;
  const open = (i: number, j: number): boolean => {
    const k = (i + OFF) * 65536 + (j + OFF);
    let v = cells.get(k);
    if (v === undefined) {
      v = openAt(g, i * step, j * step, cfg);
      cells.set(k, v);
      samples++;
    }
    return v;
  };
  // Patch offsets (grid cells within patchRadius).
  const R = S.patchRadius;
  const n = Math.ceil(R / step);
  const offs: number[] = [];
  for (let dj = -n; dj <= n; dj++) for (let di = -n; di <= n; di++) if (Math.hypot(di, dj) * step <= R) offs.push(di, dj);
  const patchCells = offs.length / 2;

  let best: RangeSite | null = null;
  const b0 = cfg.bearingDeg;
  for (let db = 0; db <= S.bearingSpanDeg; db += S.bearingStepDeg) {
    for (const sign of db === 0 ? [1] : [1, -1]) {
      const brg = b0 + sign * db;
      const h = brg * DEG;
      for (let d = cfg.minDistance; d <= cfg.maxDistance + 1e-6; d += S.distanceStep) {
        const x = Math.sin(h) * d;
        const z = -Math.cos(h) * d;
        const ci = Math.round(x / step);
        const cj = Math.round(z / step);
        let good = 0;
        for (let k = 0; k < offs.length; k += 2) if (open(ci + offs[k], cj + offs[k + 1])) good++;
        const frac = good / patchCells;
        const score = frac - S.bearingWeight * db - S.distanceWeight * (d - cfg.minDistance);
        if (!best || score > best.score + 1e-9) {
          best = { x, z, headingDeg: 0, bearingDeg: ((brg % 360) + 360) % 360, distance: d, open: frac, score, samples: 0 };
        }
      }
    }
  }
  const site = best!;
  // Pull the centre toward the middle of the open ground around it (centroid of open cells).
  let sx = 0;
  let sz = 0;
  let cnt = 0;
  const ci = Math.round(site.x / step);
  const cj = Math.round(site.z / step);
  for (let k = 0; k < offs.length; k += 2) {
    if (!open(ci + offs[k], cj + offs[k + 1])) continue;
    sx += (ci + offs[k]) * step;
    sz += (cj + offs[k + 1]) * step;
    cnt++;
  }
  if (cnt > 0) {
    const cx = sx / cnt;
    const cz = sz / cnt;
    const d = Math.hypot(cx, cz);
    if (d >= cfg.minDistance && d <= cfg.maxDistance) {
      site.x = cx;
      site.z = cz;
    }
  }
  site.distance = Math.hypot(site.x, site.z);
  site.bearingDeg = ((Math.atan2(site.x, -site.z) / DEG) % 360 + 360) % 360;
  site.headingDeg = site.bearingDeg;
  site.samples = samples;
  return site;
}
