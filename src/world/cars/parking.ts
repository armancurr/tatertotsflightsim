/**
 * Parked cars (PURE):
 * - kerbside parking along town streets (lanes.ts decides which side(s) of
 *   which pieces): parallel-parked at the kerb facing the traffic on their
 *   side, gaps between them, clear of the junction boxes and crosswalks;
 * - car parks: the terrain shader paints car parks with bay lines in the
 *   commercial blocks of each town's street grid (terrain/terrainShader.ts
 *   tUrban, hashed with the same PCG as fields.ts) — cars fill those bays,
 *   nose-in, except where a building or tree stands (the world's obstacles,
 *   known once the towns have been placed).
 * Deterministic per (seed, slot). `ParkingField` keeps the set within
 * `parkedRadius` of the camera (nearest first, capped at `maxParked`).
 */
import { LaneGraph, PARK_KERB, FLAG } from './lanes';
import { SPECS, VT } from './specs';
import { paintFor } from './paint';
import { hash2i } from '../noise';
import { pcgHash } from '../fields';
import type { Town } from '../layout';
import { CONFIG } from '../../config';

export type CarsConfig = typeof CONFIG.world.cars;

export interface ParkedCar {
  type: number;
  paint: number;
  /** Centre (wheelbase midpoint) and facing. */
  x: number;
  z: number;
  hx: number;
  hz: number;
  /** Where it stands on the road (for the surface height); −1 = in a car park (on the terrain). */
  piece: number;
  s: number;
  across: number;
  /** Serial (stable per slot). */
  id: number;
}

/** Types parked at the kerb (weights per VT index). */
const PARK_MIX = [34, 16, 30, 12, 8, 0, 0, 0, 0];

/** The parked cars of one piece (empty if it has no kerb parking). */
export function parkedSlots(g: LaneGraph, p: number, seed: number, cfg: CarsConfig = CONFIG.world.cars): ParkedCar[] {
  const out: ParkedCar[] = [];
  const park = g.pPark[p];
  if (!park || g.pFlags[p] & FLAG.bridge) return out;
  const hw = g.pWidth[p] / 2;
  const s0 = g.pS0[p] + g.pClearS[p] + cfg.parkedJunctionClear;
  const s1 = g.pS0[p] + g.pLen[p] - g.pClearE[p] - cfg.parkedJunctionClear;
  if (s1 - s0 < 7) return out;
  let mixSum = 0;
  for (const w of PARK_MIX) mixSum += w;
  const q = { x: 0, z: 0, hx: 0, hz: 0 };
  for (const side of [1, 2]) {
    if (!(park & side)) continue;
    const n = Math.floor((s1 - s0) / cfg.parkedPitch);
    if (n < 1) continue;
    const pad = (s1 - s0 - n * cfg.parkedPitch) / 2;
    for (let k = 0; k < n; k++) {
      const key = p * 64 + side * 32 + (k & 31) + Math.floor(k / 32) * 1e6;
      if (hash2i(key, 1, seed) >= cfg.parkedFill) continue;
      let x = hash2i(key, 2, seed) * mixSum;
      let type: number = VT.sedan;
      for (let t = 0; t < PARK_MIX.length; t++) {
        x -= PARK_MIX[t];
        if (x < 0) {
          type = t;
          break;
        }
      }
      const sp = SPECS[type];
      // slot centre with a little jitter, kept inside the slot
      const room = cfg.parkedPitch - sp.length - 0.3;
      const jitter = room > 0 ? (hash2i(key, 3, seed) - 0.5) * room : 0;
      const s = s0 + pad + (k + 0.5) * cfg.parkedPitch + jitter;
      const acr = hw - PARK_KERB - sp.width / 2 - 0.05 * hash2i(key, 4, seed);
      const across = side === 1 ? acr : -acr;
      // from the lane line out to the kerb line, along the piece normal (right of increasing s)
      const lane = side === 1 ? p * 2 : p * 2 + 1;
      const u = side === 1 ? s - g.pS0[p] : g.pS0[p] + g.pLen[p] - s;
      g.lanePoint(lane, u, q);
      const nx = side === 1 ? -q.hz : q.hz;
      const nz = side === 1 ? q.hx : -q.hx;
      const d = across - g.laneAcross[lane];
      out.push({
        type,
        paint: paintFor(type, hash2i(key, 5, seed)),
        x: q.x + nx * d,
        z: q.z + nz * d,
        hx: q.hx,
        hz: q.hz,
        piece: p,
        s,
        across,
        id: key,
      });
    }
  }
  return out;
}

/** What the car parks need from the world. */
export interface CarParkEnv {
  heightAt: (x: number, z: number) => number;
  /** Top of obstacles (buildings, trees), −∞ where none. */
  obstacleTop?: (x: number, z: number) => number;
  /** Urban landcover weight (the terrain draws the town ground where it dominates). */
  urban?: (x: number, z: number) => number;
  towns?: readonly Town[];
}

const DEG = Math.PI / 180;
/** Car park layout (terrain shader): bays 2.6 m wide, 16 m double rows with a 5 m aisle. */
const BAY = 2.6;
const ROW = 16;
const ROW_OFF = 5.25;
/** Keep clear of the streets on the block edges, m. */
const EDGE = 9;

/** Cars in the car parks of town ti (see the header). */
export function carParkSlots(towns: readonly Town[], ti: number, seed: number, env: CarParkEnv, cfg: CarsConfig = CONFIG.world.cars): ParkedCar[] {
  const out: ParkedCar[] = [];
  const gen = carParkGen(towns, ti, seed, env, out, cfg);
  while (!gen.next().done);
  return out;
}

/** The same, a block at a time (a generator: the world queries are too slow for one frame). */
export function* carParkGen(towns: readonly Town[], ti: number, seed: number, env: CarParkEnv, out: ParkedCar[], cfg: CarsConfig = CONFIG.world.cars): Generator<void> {
  const t = towns[ti];
  const bs = Math.max(t.blockSize, 40);
  const th = t.gridAngleDeg * DEG;
  const cs = Math.cos(th);
  const sn = Math.sin(th);
  const n = Math.ceil((t.radius * 1.05) / bs) + 1;
  let mixSum = 0;
  for (const w of PARK_MIX) mixSum += w;
  const smooth = (e0: number, e1: number, x: number) => {
    const k = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
    return k * k * (3 - 2 * k);
  };
  let slot = 0;
  for (let cj = -n; cj <= n; cj++)
    for (let ci = -n; ci <= n; ci++) {
      const bh = pcgHash(ci + 71, cj + 71);
      if (bh >= 0.06 + 0.3 * t.density) continue;
      const half = pcgHash(ci + 3, cj + 3) >= 0.5 ? 1 : 0;
      // the u axis runs across the block toward its car park half; cars park along it
      const ux = half ? -sn : cs;
      const uz = half ? cs : sn;
      const blockIdx = (cj + n) * (2 * n + 1) + (ci + n);
      yield;
      // the terrain draws the town ground (and so the car park) where the urban landcover dominates
      if (env.urban) {
        const U = 0.78 * bs;
        const V = 0.5 * bs;
        const qx = half ? ci * bs + V : ci * bs + U;
        const qz = half ? cj * bs + U : cj * bs + V;
        if (env.urban(t.x + cs * qx - sn * qz, t.z + sn * qx + cs * qz) < 0.6) continue;
      }
      for (let b = 0; b * ROW < bs; b++)
        for (const side of [-1, 1]) {
          const U = (b + 0.5) * ROW + side * ROW_OFF;
          if (U - 2.8 < 0.55 * bs + 0.3 || U + 2.8 > bs - EDGE) continue;
          for (let k = 0; (k + 0.5) * BAY < bs; k++) {
            const V = (k + 0.5) * BAY;
            if (V < EDGE || V > bs - EDGE) continue;
            const id = -1 - ((ti * 8192 + blockIdx) * 1024 + (slot++ & 1023));
            const key = ti * 7919 + blockIdx * 131 + b * 17 + (side + 1) * 5 + k * 101;
            // grid → world
            const qx = half ? ci * bs + V : ci * bs + U;
            const qz = half ? cj * bs + U : cj * bs + V;
            const x = t.x + cs * qx - sn * qz;
            const z = t.z + sn * qx + cs * qz;
            const dist = Math.hypot(x - t.x, z - t.z);
            if (dist > t.radius * 1.05) continue;
            // the terrain draws the grid of the nearest town (by distance − radius)
            let nearest = true;
            for (let o = 0; o < towns.length && nearest; o++) if (o !== ti && Math.hypot(x - towns[o].x, z - towns[o].z) - towns[o].radius < dist - t.radius) nearest = false;
            if (!nearest) continue;
            const dens = t.density * (1 - smooth(0.2, 1.05, dist / Math.max(t.radius, 1)));
            if (bh >= 0.06 + 0.3 * dens) continue;
            if (hash2i(key, 1, seed) >= Math.min(0.85, 0.35 + 0.6 * dens)) continue;
            let tx = 0;
            let tv = hash2i(key, 2, seed) * mixSum;
            for (let q = 0; q < PARK_MIX.length; q++) {
              tv -= PARK_MIX[q];
              if (tv < 0) {
                tx = q;
                break;
              }
            }
            const sp = SPECS[tx];
            const hx = ux * side;
            const hz = uz * side;
            // nothing standing there (a building, a tree)
            if (env.obstacleTop) {
              const g0 = env.heightAt(x, z);
              let blocked = false;
              for (const f of [-0.5, 0, 0.5]) {
                const px = x + hx * sp.length * f;
                const pz = z + hz * sp.length * f;
                if (env.obstacleTop(px, pz) > g0 + 0.3) blocked = true;
              }
              if (blocked) continue;
            }
            out.push({ type: tx, paint: paintFor(tx, hash2i(key, 5, seed)), x, z, hx, hz, piece: -1, s: 0, across: 0, id });
          }
        }
    }
  void cfg;
}

export class ParkingField {
  readonly cars: ParkedCar[] = [];
  count = 0;
  /** Bumped whenever the set changes. */
  version = 0;
  private cache = new Map<number, ParkedCar[]>();
  private pieces: number[] = [];

  private parks = new Map<number, ParkedCar[]>();

  constructor(
    private g: LaneGraph,
    private cfg: CarsConfig = CONFIG.world.cars,
    private seed = cfg.seed,
    private env: CarParkEnv | null = null,
  ) {
    for (let p = 0; p < g.pieceCount; p++) if (g.pPark[p]) this.pieces.push(p);
  }

  private pending = new Map<number, { gen: Generator<void>; out: ParkedCar[] }>();

  /** Advances the car park generation for up to `ms`; true when a town's car parks were completed (refresh again). */
  work(ms: number): boolean {
    if (this.pending.size === 0) return false;
    const t0 = performance.now();
    let done = false;
    for (const [ti, p] of this.pending) {
      while (performance.now() - t0 < ms) {
        if (p.gen.next().done) {
          this.parks.set(ti, p.out);
          this.pending.delete(ti);
          done = true;
          break;
        }
      }
      if (performance.now() - t0 >= ms) break;
    }
    return done;
  }

  /** A town's car parks (null while they are being generated or its buildings are not known yet). */
  private townParks(ti: number, lazy: boolean): ParkedCar[] | null {
    const env = this.env!;
    const hit = this.parks.get(ti);
    if (hit) return hit;
    if (this.pending.has(ti)) return null;
    const t = env.towns![ti];
    if (env.obstacleTop) {
      // buildings stand in the centre (trees do not grow there): until a few are found the towns are not placed yet
      let hits = 0;
      for (let j = -4; j <= 4; j++)
        for (let i = -4; i <= 4; i++) {
          const x = t.x + (i / 4) * t.radius * 0.45;
          const z = t.z + (j / 4) * t.radius * 0.45;
          if (env.obstacleTop(x, z) > env.heightAt(x, z) + 3.5) hits++;
        }
      if (hits < 3) return null;
    }
    if (lazy) {
      const out: ParkedCar[] = [];
      this.pending.set(ti, { gen: carParkGen(env.towns!, ti, this.seed, env, out, this.cfg), out });
      return null;
    }
    const list = carParkSlots(env.towns!, ti, this.seed, env, this.cfg);
    this.parks.set(ti, list);
    return list;
  }

  /** Rebuilds the set around (x, z): nearest first, capped. `lazy`: car parks are generated by work() over the next frames. */
  refresh(x: number, z: number, lazy = false): void {
    const g = this.g;
    const R = this.cfg.parkedRadius;
    const cand: ParkedCar[] = [];
    for (const p of this.pieces) {
      const b = p * 4;
      const dx = x < g.pBox[b] ? g.pBox[b] - x : x > g.pBox[b + 2] ? x - g.pBox[b + 2] : 0;
      const dz = z < g.pBox[b + 1] ? g.pBox[b + 1] - z : z > g.pBox[b + 3] ? z - g.pBox[b + 3] : 0;
      if (dx * dx + dz * dz > R * R) continue;
      let list = this.cache.get(p);
      if (!list) this.cache.set(p, (list = parkedSlots(g, p, this.seed, this.cfg)));
      for (const c of list) if ((c.x - x) ** 2 + (c.z - z) ** 2 <= R * R) cand.push(c);
    }
    if (this.env?.towns) {
      const towns = this.env.towns;
      for (let ti = 0; ti < towns.length; ti++) {
        const t = towns[ti];
        if (Math.hypot(t.x - x, t.z - z) > R + t.radius) continue;
        const list = this.townParks(ti, lazy);
        if (!list) continue;
        for (const c of list) if ((c.x - x) ** 2 + (c.z - z) ** 2 <= R * R) cand.push(c);
      }
    }
    if (cand.length > this.cfg.maxParked) {
      cand.sort((a, b) => (a.x - x) ** 2 + (a.z - z) ** 2 - ((b.x - x) ** 2 + (b.z - z) ** 2));
      cand.length = this.cfg.maxParked;
    }
    this.cars.length = 0;
    for (const c of cand) this.cars.push(c);
    this.count = this.cars.length;
    this.version++;
  }
}
