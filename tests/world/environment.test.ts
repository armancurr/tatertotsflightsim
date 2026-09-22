import { describe, it, expect } from 'vitest';
import { createEnvironment } from '../../src/world/environment';
import { terrainHeight, terrainNormal } from '../../src/world/heightfield';
import { surfaceAt } from '../../src/world/landcover';
import { getLayout } from '../../src/world/layout';
import { runwayFrame } from '../../src/world/runway';
import { CONFIG } from '../../src/config';

const L = getLayout();

describe('world Environment', () => {
  const env = createEnvironment();

  it('ground height and normal come from the shared heightfield', () => {
    for (const [x, z] of [
      [0, 0],
      [5000, -15000],
      [-8000, 3000],
      [1234, 9876],
    ]) {
      expect(env.groundHeight(x, z)).toBe(terrainHeight(x, z));
      expect(env.groundNormal!(x, z)).toEqual(terrainNormal(x, z));
      expect(env.surfaceAt(x, z)).toBe(surfaceAt(x, z));
    }
    const rw = runwayFrame();
    const off = CONFIG.aircraft.spawn.runwayStartOffset;
    const sx = rw.threshold.x + rw.dir.x * off;
    const sz = rw.threshold.z + rw.dir.z * off;
    expect(env.surfaceAt(sx, sz)).toBe('runway');
    expect(env.groundHeight(sx, sz)).toBeCloseTo(CONFIG.world.airport.elevation, 6);
  });

  it('reports water levels: sea 0, lake level, null on dry land', () => {
    expect(env.waterLevel(0, L.coast.zAt(0) + 3000)).toBe(0);
    const lake = L.lakes[0];
    expect(env.waterLevel(lake.center.x, lake.center.z)).toBe(lake.level);
    expect(env.waterLevel(0, 0)).toBeNull();
    expect(env.waterLevel(-3000, -3000)).toBeNull();
  });

  it('obstacleTop is -Infinity until sources register, then the max over sources', () => {
    const e = createEnvironment();
    expect(e.obstacleTop!(10, 10)).toBe(-Infinity);
    e.registerObstacleSource((x) => (x > 0 ? 50 : -Infinity));
    e.registerObstacleSource((_, z) => (z > 0 ? 80 : -Infinity));
    expect(e.obstacleTop!(10, -10)).toBe(50);
    expect(e.obstacleTop!(10, 10)).toBe(80);
    expect(e.obstacleTop!(-10, -10)).toBe(-Infinity);
  });
});
