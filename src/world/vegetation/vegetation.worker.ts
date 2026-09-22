/**
 * Vegetation worker: generates tree chunks (and grass cells) from the same pure
 * placement, heightfield and landcover the main thread uses, and transfers the
 * packed typed arrays back (zero-copy).
 */
import { createRealVegWorld } from './world';
import { generateChunk } from './pack';
import { generateGrassCell, type GrassParams } from '../grass/placement';
import type { PlacementParams, VegWorld } from './placement';

interface InitMsg {
  type: 'init';
  seed: number;
  params: PlacementParams;
  cellsPerSide: number;
  grass?: GrassParams;
}
interface ChunkMsg {
  type: 'chunk';
  key: number;
  kx: number;
  kz: number;
  rankMax: number;
}
interface GrassMsg {
  type: 'grass';
  key: number;
  cx: number;
  cz: number;
}

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent<InitMsg | ChunkMsg | GrassMsg>) => void) | null;
  postMessage(msg: unknown, transfer: Transferable[]): void;
};

let world: VegWorld | null = null;
let init: InitMsg | null = null;

ctx.onmessage = (e) => {
  const m = e.data;
  if (m.type === 'init') {
    init = m;
    world = createRealVegWorld();
    ctx.postMessage({ type: 'ready' }, []);
    return;
  }
  if (!world || !init) return;
  if (m.type === 'chunk') {
    const p = generateChunk(m.kx, m.kz, init.cellsPerSide, world, init.seed, init.params, m.rankMax);
    ctx.postMessage({ type: 'chunk', key: m.key, packed: p }, [p.data.buffer, p.rankCdf.buffer, p.cellStart.buffer, p.cellItems.buffer]);
    return;
  }
  if (m.type === 'grass' && init.grass) {
    const g = generateGrassCell(m.cx, m.cz, world, init.seed, init.grass);
    ctx.postMessage({ type: 'grass', key: m.key, cell: g }, [g.data.buffer]);
  }
};
