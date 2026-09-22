/** Shared fixtures for the towns/roads tests: the real layout, the stand-in terrain and random synthetic layouts. */
import { getLayout, type WorldLayout, type Town, type Road, type TownKind } from '../../../src/world/layout';
import { createStandInHeight } from '../../../src/world/towns/standin';
import { mulberry32 } from '../../../src/world/noise';

export const LAYOUT = getLayout();
export const HEIGHT = createStandInHeight(LAYOUT);

/**
 * A small synthetic world: the real coast/river/lakes/airport, but 1–3 random
 * settlements in the band between the airport and the coast/river, each with a
 * random road through it. Deterministic in `seed`.
 */
export function syntheticLayout(seed: number): WorldLayout {
  const rnd = mulberry32(seed * 7919 + 13);
  const kinds: TownKind[] = ['city', 'town', 'village', 'hamlet'];
  const towns: Town[] = [];
  const roads: Road[] = [];
  const n = 1 + Math.floor(rnd() * 3);
  for (let i = 0; i < n; i++) {
    const kind = kinds[Math.floor(rnd() * kinds.length)];
    const radius = kind === 'city' ? 700 + rnd() * 600 : kind === 'town' ? 450 + rnd() * 400 : kind === 'village' ? 220 + rnd() * 160 : 150 + rnd() * 80;
    // anywhere in a wide box (some overlap the sea, the river, a lake or the airport: that is the point)
    const x = -9000 + rnd() * 18000;
    const z = -9000 + rnd() * 17000;
    towns.push({
      name: `T${i}`,
      kind,
      x,
      z,
      radius,
      density: 0.4 + rnd() * 0.5,
      gridAngleDeg: Math.round(rnd() * 90),
      blockSize: kind === 'city' ? 90 : kind === 'town' ? 75 : 60,
    });
    const a = rnd() * Math.PI;
    const len = radius * 3;
    const pts = [];
    for (let s = -len; s <= len; s += 25) pts.push({ x: x + Math.cos(a) * s + Math.sin(s / 300) * 20, z: z + Math.sin(a) * s });
    const rk = rnd() < 0.3 ? 'highway' : 'road';
    roads.push({ name: `R${i}`, kind: rk, width: rk === 'highway' ? 11 : 7, points: pts });
  }
  return { ...LAYOUT, towns, roads, bridges: [] };
}
