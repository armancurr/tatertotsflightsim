/**
 * Harbour seals hauled out on Seal Rock (PURE): a few spots on the rock just above the waterline
 * (terrain between `minH` and `maxH`, gentle slope), each with a heading (mostly facing the sea)
 * and a size. Their idle life (the head lifting and looking round, the "banana" pose) is animated
 * in the vertex shader from a per-seal phase; nothing to simulate on the CPU.
 */
import { h01, hRange } from '../traffic/rng';
import { WILDLIFE } from './tuning';

const S = WILDLIFE.seal;

export interface SealSpot {
  x: number;
  y: number;
  z: number;
  heading: number;
  /** Body length (m). */
  length: number;
  phase: number;
}

export function createSeals(groundHeight: (x: number, z: number) => number): SealSpot[] {
  const out: SealSpot[] = [];
  const { x: cx, z: cz, r } = S.rock;
  const seed = WILDLIFE.seed;
  for (let k = 0; k < 400 && out.length < S.n; k++) {
    // a few clusters round the rock (seals haul out together)
    const cluster = Math.floor(h01(seed, 9900, k) * 3);
    const a = (cluster * 2.1 + 0.6) + hRange(seed, 9901, k, -0.35, 0.35);
    // search inward from beyond the rock's radius for the band above the waterline
    for (let d = r + 40; d > r * 0.3; d -= 4) {
      const x = cx + Math.cos(a) * d;
      const z = cz + Math.sin(a) * d;
      const h = groundHeight(x, z);
      if (h < S.minH || h > S.maxH) continue;
      const slope = Math.abs(groundHeight(x + 1.5, z) - groundHeight(x - 1.5, z)) / 3 + Math.abs(groundHeight(x, z + 1.5) - groundHeight(x, z - 1.5)) / 3;
      if (slope > 0.45) break;
      if (out.some((s) => Math.hypot(s.x - x, s.z - z) < 3.2)) break;
      // facing the sea (outward), give or take
      const out0 = (Math.atan2(Math.cos(a), -Math.sin(a)) * 180) / Math.PI;
      out.push({ x, y: h, z, heading: (out0 + hRange(seed, 9902, k, -70, 70) + 720) % 360, length: hRange(seed, 9903, k, 1.35, 1.8), phase: hRange(seed, 9904, k, 0, 100) });
      break;
    }
  }
  return out;
}
