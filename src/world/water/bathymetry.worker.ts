/**
 * Water worker: bakes the bathymetry clipmap levels (depth + shore distance,
 * half-float RG) and the detail tile's mip chain off the main thread, from the
 * same pure heightfield the terrain and physics use. Transfers the buffers.
 */
import { getHeightfield } from '../heightfield';
import { bakeBathymetry, makeWaterDepthFn, newBathyLevel, packBathymetryHalf, shoreDistanceTransform, type BathyLevel } from './bathymetry';
import { bakeDetailTile, toHalf } from './detail';

type Msg =
  | { type: 'detail'; size: number; seed: number }
  | { type: 'bathy'; id: number; level: number; cx: number; cz: number; extent: number; res: number };

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<Msg>) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
};

let depthAt: ((x: number, z: number) => number) | null = null;
const levels = new Map<number, BathyLevel>();

ctx.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'detail') {
    const t0 = performance.now();
    const tile = bakeDetailTile(m.size, m.seed);
    const out = tile.levels.map((l) => {
      const u = new Uint16Array(l.length);
      for (let i = 0; i < l.length; i++) u[i] = toHalf(l[i]);
      return u;
    });
    ctx.postMessage({ type: 'detail', size: m.size, levels: out, ms: performance.now() - t0 }, out.map((u) => u.buffer));
    return;
  }
  if (m.type === 'bathy') {
    const t0 = performance.now();
    if (!depthAt) depthAt = makeWaterDepthFn(getHeightfield());
    let lv = levels.get(m.level);
    if (!lv || lv.res !== m.res) {
      lv = newBathyLevel(m.res);
      levels.set(m.level, lv);
    }
    bakeBathymetry(depthAt, m.cx, m.cz, m.extent, m.res, lv);
    shoreDistanceTransform(lv);
    const data = packBathymetryHalf(lv, new Uint16Array(m.res * m.res * 2));
    ctx.postMessage({ type: 'bathy', id: m.id, level: m.level, cx: m.cx, cz: m.cz, extent: m.extent, res: m.res, data, ms: performance.now() - t0 }, [data.buffer]);
  }
};
