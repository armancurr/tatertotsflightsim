/**
 * Where marine animals may be (PURE): water depth, the other features of the sea they keep away
 * from (the naval gunnery range, the oil platform, the wind farm, the jet-ski race course, the
 * cruise terminal and the naval pier, the marina's structures, the islands, the land), and the
 * wandering loops the pods and whales swim along (validated against all of it).
 *
 * Frame: world +X east, +Z south; heading clockwise from north.
 */
import type { WorldLayout } from '../layout';
import type { MarinaLayout, WaterWorld } from '../traffic/sea';
import { marinaStructureDistance } from '../traffic/sea';
import { createPath, smoothLoop, type Path } from '../traffic/path';
import { h01 } from '../traffic/rng';
import { WILDLIFE, type Box, type Circle } from './tuning';

export type Species = 'dolphin' | 'whale' | 'gull' | 'seal';

/** Water depth (m) at a point of the open sea, or −Infinity on land / on a lake or river. */
export function seaDepthAt(water: WaterWorld, x: number, z: number): number {
  const wl = water.waterLevel(x, z);
  if (wl === null || Math.abs(wl) > 0.5) return -Infinity;
  return wl - water.groundHeight(x, z);
}

const inCircle = (c: Circle, x: number, z: number, grow = 0): boolean => Math.hypot(x - c.x, z - c.z) < c.r + grow;
const inBox = (b: Box, x: number, z: number, z0 = 0): boolean => x >= b.x0 && x <= b.x1 && z >= b.z0 + z0 && z <= b.z1 + z0;

export interface ZoneContext {
  layout: Pick<WorldLayout, 'coast' | 'islands'>;
  marina: MarinaLayout | null;
}

/**
 * The name of the exclusion zone (x, z) lies in for a species, or null when it may be there.
 * Gulls fly anywhere but the gunnery range; swimming animals avoid every structure of the sea.
 */
export function exclusionAt(ctx: ZoneContext, species: Species, x: number, z: number): string | null {
  const Z = WILDLIFE.zones;
  if (inCircle(Z.gunnery, x, z)) return 'gunnery';
  if (species === 'gull') return null;
  if (inCircle(Z.oilRig, x, z)) return 'oilRig';
  if (inBox(Z.windFarm, x, z)) return 'windFarm';
  if (inBox(Z.jetSkiCourse, x, z)) return 'jetSkiCourse';
  const cz = ctx.layout.coast.zAt(x);
  if (inBox(Z.cruiseTerminal, x, z, cz)) return 'cruiseTerminal';
  if (inBox(Z.navalPier, x, z, cz)) return 'navalPier';
  for (const i of ctx.layout.islands) if (Math.hypot(x - i.x, z - i.z) < i.radius + (species === 'seal' ? -1e9 : Z.islandMargin)) return 'island';
  if (ctx.marina && marinaStructureDistance(ctx.marina, x, z) < Z.marinaMargin) return 'marina';
  return null;
}

/** True where a swimming animal of `species` may be: deep enough and in no exclusion zone. */
export function swimmable(ctx: ZoneContext, water: WaterWorld, species: Species, x: number, z: number, minDepth: number): boolean {
  if (exclusionAt(ctx, species, x, z)) return false;
  return seaDepthAt(water, x, z) >= minDepth;
}

/**
 * A wandering closed loop around (cx, cz): an ellipse of radii (rx, rz) with its control points
 * jittered in and out (seeded), as a constant-speed path. Heading clockwise or not by `ccw`.
 */
export function wanderLoop(cx: number, cz: number, rx: number, rz: number, seed: number, key: number, speed: number, ccw = false, n = 9): Path {
  const pts: { x: number; z: number; v: number }[] = [];
  const rot = (h01(seed, key, 999) - 0.5) * 0.6;
  const cr = Math.cos(rot);
  const sr = Math.sin(rot);
  for (let k = 0; k < n; k++) {
    const a = ((ccw ? -k : k) / n) * Math.PI * 2;
    const j = 0.72 + 0.5 * h01(seed, key, k);
    const ex = rx * Math.cos(a) * j;
    const ez = rz * Math.sin(a) * j;
    pts.push({ x: cx + ex * cr - ez * sr, z: cz + ex * sr + ez * cr, v: speed });
  }
  return createPath(smoothLoop(pts, 16).map((p) => ({ x: p.x, y: 0, z: p.z, v: speed })), true, 6);
}

/**
 * Least clearance of a path: every `step` m checks `ok(x, z)` across a band of half-width `half`
 * (the pod's spread). Returns true when every sample passes.
 */
export function pathClear(p: Path, half: number, step: number, ok: (x: number, z: number) => boolean): boolean {
  const n = Math.max(2, Math.ceil(p.length / step));
  for (let i = 0; i < n; i++) {
    const k = Math.min(p.n - 1, Math.floor((i / n) * p.n));
    const x = p.x[k];
    const z = p.z[k];
    if (!ok(x, z)) return false;
    if (half > 0) {
      const psi = p.psi[k];
      // across the track: (cos ψ, sin ψ) with heading ψ clockwise from north → right = (cos, sin)
      const rx = Math.cos(psi);
      const rz = Math.sin(psi);
      if (!ok(x + rx * half, z + rz * half) || !ok(x - rx * half, z - rz * half)) return false;
    }
  }
  return true;
}

/**
 * A loop for an animal: tries the configured loop, then shrinks it and nudges its centre seaward
 * until every sample is swimmable. Returns null when nothing fits (the animal is left out).
 */
export function fitLoop(ctx: ZoneContext, water: WaterWorld, species: Species, spec: { x: number; z: number; rx: number; rz: number; speed: number }, key: number, minDepth: number, half: number, extra?: (x: number, z: number) => boolean): Path | null {
  const ok = (x: number, z: number) => swimmable(ctx, water, species, x, z, minDepth) && (!extra || extra(x, z));
  for (let attempt = 0; attempt < 12; attempt++) {
    const shrink = Math.pow(0.85, attempt);
    const push = attempt * 60;
    const p = wanderLoop(spec.x, spec.z + push, spec.rx * shrink, spec.rz * shrink, WILDLIFE.seed, key * 31 + attempt, spec.speed, key % 2 === 1);
    if (pathClear(p, half, 25, ok)) return p;
  }
  return null;
}
