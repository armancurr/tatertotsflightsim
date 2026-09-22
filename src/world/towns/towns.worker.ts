/**
 * Builds the world's buildings off the main thread: road network → placement
 * → instance records, posted back as transferable typed arrays. Uses the real
 * terrain (`terrainHeight`) — the same function the main thread's physics and
 * terrain use, so the result is identical to a main-thread build.
 */
import { getLayout } from '../layout';
import { terrainHeight } from '../heightfield';
import { getRoadNetwork } from '../roads/network';
import { placeBuildings } from './placement';
import { packBuildings } from './pack';
import { buildInstances } from './instances';
import { NEAR_KINDS } from './archetypes';

interface BuildMsg {
  type: 'build';
  seed?: number;
  chunkSize: number;
}

self.onmessage = (e: MessageEvent<BuildMsg>) => {
  if (e.data?.type !== 'build') return;
  const t0 = performance.now();
  const layout = getLayout();
  const net = getRoadNetwork(layout, terrainHeight);
  const buildings = placeBuildings(layout, net, terrainHeight, { seed: e.data.seed });
  const packed = packBuildings(buildings);
  const sets = buildInstances(buildings, e.data.chunkSize);
  const transfer: Transferable[] = [packed.buffer, sets.chunkIJ.buffer, sets.chunkBox.buffer, sets.mid.data.buffer, sets.mid.start.buffer];
  for (const k of NEAR_KINDS) transfer.push(sets.near[k].data.buffer, sets.near[k].start.buffer);
  (self as unknown as Worker).postMessage({ type: 'built', packed, sets, ms: performance.now() - t0 }, transfer);
};
