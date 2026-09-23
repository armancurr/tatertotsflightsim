/** Synthetic grounds for the target-range tests. */
import type { SurfaceType, Vec3 } from '../../../src/types';
import type { RangeGround } from '../../../src/combat/targets/ground';

const UP: Vec3 = { x: 0, y: 1, z: 0 };

export interface FakeGroundOpts {
  surface?: (x: number, z: number) => SurfaceType;
  height?: (x: number, z: number) => number;
  obstacle?: (x: number, z: number) => number;
  water?: (x: number, z: number) => number | null;
  keepOut?: (x: number, z: number) => number;
}

/** Flat open field everywhere unless overridden. */
export function fakeGround(o: FakeGroundOpts = {}): RangeGround {
  const height = o.height ?? (() => 50);
  return {
    height,
    normal: (x, z) => {
      if (!o.height) return UP;
      const e = 1;
      const hx = (height(x + e, z) - height(x - e, z)) / (2 * e);
      const hz = (height(x, z + e) - height(x, z - e)) / (2 * e);
      const l = Math.hypot(hx, 1, hz);
      return { x: -hx / l, y: 1 / l, z: -hz / l };
    },
    surface: o.surface ?? (() => 'field'),
    water: o.water ?? (() => null),
    obstacle: o.obstacle ?? (() => -Infinity),
    keepOut: o.keepOut,
  };
}
