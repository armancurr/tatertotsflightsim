/**
 * Road builder worker: plans the network and builds chunk geometry off the
 * main thread (builder.ts). Uses the real heightfield (terrainHeight) and
 * layout, exactly like the main-thread fallback with those inputs.
 *   in:  { type: 'init' } | { type: 'build', key, far }
 *   out: { type: 'summary', summary } | { type: 'built', build }
 */
import { RoadBuilder, type ChunkBuild, type RoadSummary } from './builder';
import { getLayout } from '../layout';
import { terrainHeight } from '../heightfield';

let builder: RoadBuilder | null = null;

function summaryTransfer(s: RoadSummary): Transferable[] {
  const l = s.lanes;
  return [l.pieceI.buffer, l.pieceF.buffer, l.pts.buffer, l.nodes.buffer, l.nodeStart.buffer, l.nodeEnds.buffer, s.lights.buffer];
}

export function buildTransfer(b: ChunkBuild): Transferable[] {
  const g = b.geometry;
  const out: Transferable[] = [g.position.buffer, g.normal.buffer, g.road.buffer, g.junc.buffer, g.junc2.buffer, g.index.buffer];
  for (const p of b.profiles) out.push(p.s.buffer, p.yL.buffer, p.yC.buffer, p.yR.buffer);
  return out;
}

const ctx = self as unknown as { postMessage(m: unknown, t?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };

ctx.onmessage = (e: MessageEvent) => {
  const m = e.data as { type: string; key?: string; far?: boolean };
  try {
    if (m.type === 'init') {
      builder = new RoadBuilder(getLayout(), terrainHeight);
      const summary = builder.summary();
      ctx.postMessage({ type: 'summary', summary }, summaryTransfer(summary));
    } else if (m.type === 'build' && builder && m.key !== undefined) {
      const build = builder.build(m.key, !!m.far);
      ctx.postMessage({ type: 'built', build }, buildTransfer(build));
    }
  } catch (err) {
    ctx.postMessage({ type: 'error', message: String((err as Error)?.stack ?? err), key: m.key, far: m.far });
  }
};
