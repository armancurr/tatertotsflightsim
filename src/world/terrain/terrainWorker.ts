/**
 * Terrain tile builder worker: builds chunks from the same pure heightfield and
 * landcover the physics uses, and transfers the typed arrays back (zero-copy).
 */
import { getHeightfield } from '../heightfield';
import { getLandcover } from '../landcover';
import { buildChunk } from './chunk';

interface BuildMsg {
  type: 'build';
  id: number;
  x0: number;
  z0: number;
  size: number;
  res: number;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<BuildMsg | { type: 'warmup' }>) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
};

ctx.onmessage = (e) => {
  const m = e.data;
  const hf = getHeightfield();
  const lc = getLandcover();
  if (m.type === 'warmup') {
    ctx.postMessage({ type: 'ready' }, []);
    return;
  }
  if (m.type !== 'build') return;
  const c = buildChunk(hf, lc, m);
  ctx.postMessage({ type: 'built', id: m.id, chunk: c }, [c.positions.buffer, c.normals.buffer, c.lc0.buffer, c.lc1.buffer, c.morph.buffer]);
};
