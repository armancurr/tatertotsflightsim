/**
 * Pure layout of the fair-weather cumulus field: where the clouds are, the
 * puffs each one is built from, per-puff sun self-shadowing, wrapping around
 * the camera and the in-cloud density used for the fly-through whiteout.
 *
 * World frame: +X east, +Y up, +Z south. Clouds live in a square tile of side
 * 2·areaRadius; at render time each cloud is shifted by whole tiles so it lies
 * within half a tile of the camera (wrapCoord), so there are always clouds
 * around the aircraft however far it flies.
 */
import type { Vec3 } from '../types';
import { fbm2, mulberry32 } from './noise';

export interface CloudLayoutOptions {
  seed: number;
  /** Number of clouds in the tile. */
  count: number;
  /** 0..1: 0 = clear sky; higher = clumpier fields of bigger clouds. */
  coverage: number;
  /** Cloud base altitude, m MSL. */
  baseAltitude: number;
  /** Maximum cloud thickness, m. */
  thickness: number;
  /** Half-size of the square tile, m. */
  areaRadius: number;
  /** Optional terrain height: clouds are lifted to stay `minClearance` above it. */
  groundHeight?: (x: number, z: number) => number;
  minClearance?: number;
}

export interface Cloud {
  /** Centre in the origin tile. */
  x: number;
  z: number;
  /** Base altitude (flat bottom), m MSL. */
  base: number;
  /** Horizontal radius, m. */
  radius: number;
  /** Vertical extent above the base, m. */
  height: number;
  firstPuff: number;
  puffCount: number;
}

/** Floats per puff in CloudField.puffs. */
export const PUFF_STRIDE = 8;
/** Offsets within a puff record. */
export const P_DX = 0; // x offset from the cloud centre
export const P_Y = 1; // absolute y of the puff centre (before any terrain lift at render time)
export const P_DZ = 2; // z offset from the cloud centre
export const P_R = 3; // billboard radius
export const P_HFRAC = 4; // 0 at the base … 1 at the top of the cloud
export const P_VAR = 5; // texture variant 0..3
export const P_ROT = 6; // billboard rotation, radians
export const P_OCC = 7; // 0..1 how much of the direct sun this puff loses to the rest of its cloud

export interface CloudField {
  tile: number;
  clouds: Cloud[];
  puffs: Float32Array;
  puffCount: number;
}

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** v shifted by whole tiles into [center − tile/2, center + tile/2). */
export function wrapCoord(v: number, center: number, tile: number): number {
  const d = v - center + tile / 2;
  return center + (((d % tile) + tile) % tile) - tile / 2;
}

/** Highest terrain under a cloud footprint (centre + 8 points on its rim). */
export function maxGroundUnder(g: (x: number, z: number) => number, x: number, z: number, r: number): number {
  let m = g(x, z);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    m = Math.max(m, g(x + Math.cos(a) * r, z + Math.sin(a) * r));
  }
  return m;
}

export function generateCloudField(o: CloudLayoutOptions): CloudField {
  const rng = mulberry32(o.seed ^ 0x5eed);
  const tile = 2 * o.areaRadius;
  const clouds: Cloud[] = [];
  const puffList: number[] = [];
  const count = o.coverage <= 0 ? 0 : o.count;
  const sizeScale = 0.6 + 0.8 * Math.min(1, o.coverage);
  const lo = 0.62 - 0.6 * o.coverage;
  const hi = lo + 0.3;
  const clearance = o.minClearance ?? 250;

  let attempts = 0;
  while (clouds.length < count && attempts < count * 400) {
    attempts++;
    const x = (rng() * 2 - 1) * o.areaRadius;
    const z = (rng() * 2 - 1) * o.areaRadius;
    // Clumping: favour a low-frequency "convection" field, but never leave big holes.
    const n = fbm2(x / 10000 + 50, z / 10000 + 50, 3, o.seed);
    if (rng() > 0.3 + 0.7 * smoothstep(lo, hi, n) && attempts < count * 300) continue;
    const u = rng();
    const radius = Math.min(1400, (260 + 740 * Math.pow(u, 1.8)) * sizeScale);
    // keep clouds from merging into one blob
    let tooClose = false;
    for (const c of clouds) {
      const dx = wrapCoord(c.x, x, tile) - x;
      const dz = wrapCoord(c.z, z, tile) - z;
      if (dx * dx + dz * dz < Math.pow(0.9 * (c.radius + radius), 2)) {
        tooClose = true;
        break;
      }
    }
    if (tooClose && attempts < count * 300) continue;
    const r01 = Math.min(1, radius / 1300);
    const height = Math.min(o.thickness, Math.max(150, o.thickness * (0.3 + 0.7 * r01) * (0.8 + 0.3 * rng())));
    let base = o.baseAltitude + (rng() * 200 - 80);
    if (o.groundHeight) base = Math.max(base, maxGroundUnder(o.groundHeight, x, z, radius) + clearance);

    const firstPuff = puffList.length / PUFF_STRIDE;
    const nPuffs = Math.min(40, Math.max(12, Math.round(8 + radius / 32)));
    const nBase = Math.max(4, Math.round(nPuffs * 0.3));
    const maxR = height / 1.2;
    for (let k = 0; k < nPuffs; k++) {
      let r: number, y: number, rho: number;
      if (k < nBase) {
        // broad, flat-bottomed base layer
        r = Math.min(maxR, radius * (0.28 + 0.1 * rng()));
        y = base + 0.6 * r;
        rho = Math.sqrt(rng()) * radius * 0.72;
      } else {
        // cauliflower dome: smaller puffs toward the top, pulled toward the centre
        const yf = k === nBase ? 0.35 : 0.25 + 0.75 * Math.pow(rng(), 0.9);
        r = Math.min(maxR, Math.min(radius, height * 1.3) * (0.36 - 0.17 * yf) * (0.8 + 0.4 * rng()));
        y = base + 0.6 * r + yf * (height - 1.2 * r);
        // stay attached to the body: the dome narrows with height
        rho = rng() * radius * 0.62 * Math.sqrt(Math.max(0, 1 - yf * yf));
      }
      rho = Math.min(rho, radius - 1e-3);
      const a = rng() * Math.PI * 2;
      puffList.push(
        Math.cos(a) * rho,
        y,
        Math.sin(a) * rho,
        r,
        Math.min(1, Math.max(0, (y - base) / height)),
        Math.floor(rng() * 4),
        rng() * Math.PI * 2,
        0,
      );
    }
    clouds.push({ x, z, base, radius, height, firstPuff, puffCount: nPuffs });
  }
  const puffs = new Float32Array(puffList);
  return { tile, clouds, puffs, puffCount: puffs.length / PUFF_STRIDE };
}

/**
 * Per puff: fraction of direct sunlight blocked by the rest of its cloud,
 * from the summed chord lengths of the sun ray through the other puffs.
 */
export function computePuffSunOcclusion(f: CloudField, sunDir: Vec3): void {
  const p = f.puffs;
  for (const c of f.clouds) {
    const end = c.firstPuff + c.puffCount;
    for (let i = c.firstPuff; i < end; i++) {
      const oi = i * PUFF_STRIDE;
      // light enters the puff through its sun-facing surface, not its centre
      const lift = p[oi + P_R] * 0.7;
      const ox = p[oi + P_DX] + sunDir.x * lift;
      const oy = p[oi + P_Y] + sunDir.y * lift;
      const oz = p[oi + P_DZ] + sunDir.z * lift;
      let len = 0;
      for (let j = c.firstPuff; j < end; j++) {
        if (j === i) continue;
        const oj = j * PUFF_STRIDE;
        const rj = p[oj + P_R] * 0.85;
        const vx = p[oj + P_DX] - ox;
        const vy = p[oj + P_Y] - oy;
        const vz = p[oj + P_DZ] - oz;
        const proj = vx * sunDir.x + vy * sunDir.y + vz * sunDir.z;
        if (proj < -rj) continue;
        const perp2 = vx * vx + vy * vy + vz * vz - proj * proj;
        if (perp2 >= rj * rj) continue;
        const half = Math.sqrt(rj * rj - perp2);
        len += Math.max(0, proj + half - Math.max(0, proj - half));
      }
      const od = len / (0.9 * Math.max(c.radius, 1));
      p[oi + P_OCC] = 1 - Math.exp(-1.4 * od);
    }
  }
}

/**
 * 0..1 cloud density at a world point, with every cloud wrapped around the
 * camera like the renderer does. `yShift` (optional, per cloud) is the extra
 * terrain lift applied at render time.
 */
export function cloudDensityAt(
  f: CloudField,
  x: number,
  y: number,
  z: number,
  cameraX: number,
  cameraZ: number,
  yShift?: ArrayLike<number>,
): number {
  let dens = 0;
  const p = f.puffs;
  for (let ci = 0; ci < f.clouds.length; ci++) {
    const c = f.clouds[ci];
    const lift = yShift ? yShift[ci] : 0;
    const cx = wrapCoord(c.x, cameraX, f.tile);
    const cz = wrapCoord(c.z, cameraZ, f.tile);
    const dx = x - cx;
    const dz = z - cz;
    if (dx * dx + dz * dz > (c.radius + 60) * (c.radius + 60)) continue;
    if (y < c.base + lift - 60 || y > c.base + lift + c.height + 60) continue;
    const end = c.firstPuff + c.puffCount;
    for (let i = c.firstPuff; i < end; i++) {
      const o = i * PUFF_STRIDE;
      const r = p[o + P_R];
      const d = Math.hypot(dx - p[o + P_DX], y - (p[o + P_Y] + lift), dz - p[o + P_DZ]);
      if (d >= r) continue;
      dens = Math.max(dens, 1 - smoothstep(0.3 * r, r, d));
    }
  }
  return dens;
}
