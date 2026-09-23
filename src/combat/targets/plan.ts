/**
 * The range layout (PURE, deterministic): given the ground and the site, lay out a Cold-War
 * scene the way a real one would look from the air —
 *
 *  - a dirt track loop (a tank trail) around the site centre, found with A* on a coarse grid
 *    between waypoints on a circle (keeping clear of trees, farm yards and water; crossing roads
 *    only where it must), string-pulled and Chaikin-smoothed, sampled every 2 m;
 *  - a march column on the track (BTR in front, T-72s, BMP-2s, Urals at the back);
 *  - a tank platoon in a line facing the airport, each hull-down behind an earth berm;
 *  - an AAA site: two ZSU-23-4s in horseshoe revetments;
 *  - a logistics park: Ural trucks and BTRs in a row;
 *
 * plus, for every track station, how far a vehicle may pull off to each side (scatter / bypass)
 * without leaving valid ground. Heavy (A* over thousands of cells): runs in a worker in the
 * browser (layout.worker.ts) and directly in node tests.
 */
import { CONFIG, type Config } from '../../config';
import type { TargetKind } from '../types';
import { clearAt, footprintOk, headingOf, openAt, slopeDeg, type RangeConfig, type RangeGround } from './ground';
import { chaikin, makePath, nearestOnPath, newPathSample, resample, sampleAt, type TrackPath, type XZ } from './path';
import { hash01, mulberry32 } from './rng';

export type VehicleGroup = 'convoy' | 'platoon' | 'aaa' | 'logistics';

export interface PlannedVehicle {
  kind: TargetKind;
  group: VehicleGroup;
  x: number;
  z: number;
  headingDeg: number;
  /** Column order (0 = lead) for the convoy, else the index in its group. */
  slot: number;
  /** Arc length on the track (convoy only, else 0). */
  s: number;
  /** Paint: 0 plain 4BO green, 1 two-tone, 2 three-tone camouflage. */
  camo: number;
  /** 0..1 per-vehicle variation (weathering, turret angle…). */
  seed: number;
}

export interface Berm {
  x: number;
  z: number;
  headingDeg: number;
  length: number;
  width: number;
  height: number;
}

export interface PlannedTrack {
  kind: 'loop' | 'outback';
  /** Stations every ~2 m (closed loop: the last connects to the first). */
  points: XZ[];
  width: number;
  /** Per station: how far (m) a vehicle may pull off to the left / right of travel. */
  scatterL: number[];
  scatterR: number[];
}

export interface RangePlan {
  site: { x: number; z: number; headingDeg: number };
  track: PlannedTrack | null;
  vehicles: PlannedVehicle[];
  berms: Berm[];
  stats: { ms: number; cells: number; points: number; trackRadius: number; attempts: number };
}

const DEG = Math.PI / 180;

interface Rect {
  x: number;
  z: number;
  h: number;
  hl: number;
  hw: number;
}

/** Oriented rectangles (grown by `margin`) overlap — separating axis test. */
export function rectsOverlap(a: Rect, b: Rect, margin = 0): boolean {
  const axes: [number, number][] = [];
  for (const r of [a, b]) {
    const h = r.h * DEG;
    axes.push([Math.sin(h), -Math.cos(h)], [Math.cos(h), Math.sin(h)]);
  }
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  for (const [ax, az] of axes) {
    const proj = (r: Rect) => {
      const h = r.h * DEG;
      const fx = Math.sin(h);
      const fz = -Math.cos(h);
      return Math.abs(fx * ax + fz * az) * (r.hl + margin) + Math.abs(-fz * ax + fx * az) * (r.hw + margin);
    };
    if (Math.abs(dx * ax + dz * az) > proj(a) + proj(b)) return false;
  }
  return true;
}

export function planRange(g: RangeGround, site: { x: number; z: number; headingDeg: number }, cfgAll: Config = CONFIG): RangePlan {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const cfg: RangeConfig = cfgAll.combat.range;
  const classes = cfgAll.combat.targets;
  const C = { x: site.x, z: site.z };
  // Direction from the site back to the airport (0, 0): the platoon faces it.
  const toAirport = headingOf(-C.x, -C.z);
  const rnd = mulberry32(Math.round(C.x * 7 + C.z * 13) ^ 0x7a3b);

  // ── Point tests (cached on a 1 m lattice) ──────────────────────────────────
  let points = 0;
  const OFF = 1 << 15;
  const cache = new Map<number, number>();
  /** 0 = blocked, 1 = passable but a road (soft), 2 = free. Clearance r around the point. */
  const passAt = (x: number, z: number, r: number): number => {
    const qx = Math.round(x);
    const qz = Math.round(z);
    const key = ((qx + OFF) * 65536 + (qz + OFF)) * 8 + Math.min(7, Math.round(r));
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    points++;
    const px = qx;
    const pz = qz;
    let v = 2;
    const gap = r > 0 && hedgeGapAt(px, pz);
    if (!gap && !openAt(g, px, pz, cfg)) v = 0;
    else {
      const ko = g.keepOut ? g.keepOut(px, pz) : 0;
      if (ko >= 2) v = 0;
      else {
        if (ko >= 1 || gap) v = 1;
        if (!clearAt(g, px, pz)) v = 0;
        else if (r > 0) {
          for (let k = 0; k < 12 && v > 0; k++) {
            const rr = k < 8 ? r : r * 0.5;
            const a = k < 8 ? (k * Math.PI) / 4 : ((k - 8) * Math.PI) / 2 + Math.PI / 4;
            const sx = px + Math.cos(a) * rr;
            const sz = pz + Math.sin(a) * rr;
            if (!clearAt(g, sx, sz) || (g.keepOut && g.keepOut(sx, sz) >= 2)) v = 0;
          }
        }
      }
    }
    cache.set(key, v);
    return v;
  };
  /**
   * A gap in a hedgerow: landcover calls the strip forest, but there is no tree here, the ground is
   * dry and gentle and there is open field within a few metres (farm tracks pass through such gaps).
   */
  const hedgeGapAt = (x: number, z: number): boolean => {
    if (g.surface(x, z) !== 'forest' || g.water(x, z) !== null) return false;
    if (slopeDeg(g.normal(x, z)) > cfg.ground.maxSlopeDeg) return false;
    let open = 0;
    for (let k = 0; k < 4; k++) {
      const a = (k * Math.PI) / 2;
      if (cfg.ground.surfaces.includes(g.surface(x + Math.cos(a) * 5, z + Math.sin(a) * 5))) open++;
    }
    return open >= 2;
  };
  const segPass = (a: XZ, b: XZ, r: number): boolean => {
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(L / 2));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      if (passAt(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t, r) === 0) return false;
    }
    return true;
  };

  const trackHalf = cfg.track.width / 2;
  const trackClear = cfg.track.clearance;

  // ── The track loop ─────────────────────────────────────────────────────────
  let track: PlannedTrack | null = null;
  let trackPath: TrackPath | null = null;
  let trackRadius = 0;
  let attempts = 0;
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const budgetEnd = t0 + 2500;
  for (const R0 of cfg.track.radii) {
    if (now() > budgetEnd) break;
    attempts++;
    const pts = findLoop(C, R0, toAirport);
    if (!pts) continue;
    const smooth = smoothLoop(pts);
    if (!smooth) continue;
    const p = makePath(smooth, true);
    if (p.length < cfg.track.minLength) continue;
    track = { kind: 'loop', points: smooth, width: cfg.track.width, scatterL: [], scatterR: [] };
    trackPath = p;
    trackRadius = R0;
    break;
  }
  if (!track) {
    // Fallback: an out-and-back trail (two lanes, U-turns at the ends).
    for (const R0 of cfg.track.radii) {
      attempts++;
      const ob = findOutAndBack(C, R0, toAirport);
      if (!ob) continue;
      track = { kind: 'outback', points: ob, width: cfg.track.width, scatterL: [], scatterR: [] };
      trackPath = makePath(ob, true);
      trackRadius = R0;
      break;
    }
  }

  // ── Vehicles ───────────────────────────────────────────────────────────────
  const vehicles: PlannedVehicle[] = [];
  const berms: Berm[] = [];
  const rects: Rect[] = [];
  const rectOf = (kind: TargetKind, x: number, z: number, h: number): Rect => ({ x, z, h, hl: classes[kind].length / 2, hw: classes[kind].width / 2 });
  const camoOf = (): number => {
    const r = rnd();
    return r < 0.62 ? 0 : r < 0.88 ? 1 : 2;
  };
  const trackDist = (x: number, z: number): number => (trackPath ? nearestOnPath(trackPath, x, z).d : Infinity);
  const PARK_TRACK_CLEAR = cfg.convoy.scatter[1] + 12;
  const free = (r: Rect, margin: number): boolean => {
    for (const q of rects) if (rectsOverlap(r, q, margin)) return false;
    return true;
  };

  // The column on the track, front first: its lead starts on the airport side of the loop.
  if (trackPath) {
    const near = nearestOnPath(trackPath, C.x + Math.sin(toAirport * DEG) * trackRadius, C.z - Math.cos(toAirport * DEG) * trackRadius);
    const smp = newPathSample();
    cfg.convoy.kinds.forEach((kind, k) => {
      const s = (((near.s - k * cfg.convoy.spacing) % trackPath!.length) + trackPath!.length) % trackPath!.length;
      sampleAt(trackPath!, s, smp);
      const h = headingOf(smp.tx, smp.tz);
      vehicles.push({ kind, group: 'convoy', x: smp.x, z: smp.z, headingDeg: h, slot: k, s, camo: camoOf(), seed: rnd() });
      rects.push(rectOf(kind, smp.x, smp.z, h));
    });
  }

  /** A line of vehicles (facing `face`, spread across it) near `pref`; berms per vehicle optional. */
  const placeLine = (
    group: VehicleGroup,
    kinds: TargetKind[],
    pref: XZ,
    face: number,
    spacing: number,
    bermsFor: ((v: { x: number; z: number; h: number; kind: TargetKind }) => Berm[]) | null,
    column = false,
  ): boolean => {
    const maxTries = 900;
    let tries = 0;
    for (let ring = 0; ring <= 22 && tries < maxTries; ring++) {
      const rad = ring * 18;
      const nAng = ring === 0 ? 1 : Math.max(6, Math.round((2 * Math.PI * rad) / 30));
      for (let a = 0; a < nAng && tries < maxTries; a++) {
        const ang = (a / nAng) * 2 * Math.PI + ring * 0.37;
        const ax = pref.x + Math.cos(ang) * rad;
        const az = pref.z + Math.sin(ang) * rad;
        if (passAt(ax, az, 0) === 0) continue;
        for (const dFace of [0, 20, -20, 40, -40]) {
          for (const sp of [spacing, spacing * 0.8, spacing * 1.25]) {
            if (++tries > maxTries) break;
            const h = face + dFace;
            // across the facing direction (a line abreast), or along it (a column, front first)
            const lx = column ? -Math.sin(h * DEG) : Math.cos(h * DEG);
            const lz = column ? Math.cos(h * DEG) : Math.sin(h * DEG);
            const cand: { x: number; z: number; h: number; kind: TargetKind }[] = [];
            const cRects: Rect[] = [];
            const cBerms: Berm[] = [];
            let ok = true;
            for (let k = 0; k < kinds.length && ok; k++) {
              const off = (k - (kinds.length - 1) / 2) * sp;
              const j1 = (hash01(k, ring, a, 11) - 0.5) * 4;
              const j2 = (hash01(k, ring, a, 12) - 0.5) * 4;
              const hj = h + (hash01(k, ring, a, 13) - 0.5) * 10;
              const x = ax + lx * off + Math.sin(h * DEG) * j1 + lx * j2 * 0.5;
              const z = az + lz * off - Math.cos(h * DEG) * j1 + lz * j2 * 0.5;
              const kind = kinds[k];
              const cls = classes[kind];
              const r = rectOf(kind, x, z, hj);
              if (!free(r, 3) || cRects.some((q) => rectsOverlap(r, q, 3))) ok = false;
              else if (trackDist(x, z) < PARK_TRACK_CLEAR) ok = false;
              else if (!footprintOk(g, x, z, hj, cls.length, cls.width, cfg.ground.clearance, cfg)) ok = false;
              if (!ok) break;
              const v = { x, z, h: hj, kind };
              if (bermsFor) {
                for (const b of bermsFor(v)) {
                  if (!footprintOk(g, b.x, b.z, b.headingDeg, b.length, b.width, 0.5, cfg)) {
                    ok = false;
                    break;
                  }
                  cBerms.push(b);
                }
              }
              cand.push(v);
              cRects.push(r);
            }
            if (!ok) continue;
            cand.forEach((v, k) => {
              vehicles.push({ kind: v.kind, group, x: v.x, z: v.z, headingDeg: ((v.h % 360) + 360) % 360, slot: k, s: 0, camo: camoOf(), seed: rnd() });
              rects.push(cRects[k]);
            });
            berms.push(...cBerms);
            return true;
          }
        }
      }
    }
    return false;
  };

  /** One vehicle at a time near `pref` (the fallback when a whole line will not fit). */
  const placeSingles = (group: VehicleGroup, kinds: TargetKind[], pref: XZ, face: number) => {
    kinds.forEach((kind, k) => {
      const cls = classes[kind];
      for (let ring = 0; ring <= 30; ring++) {
        const rad = ring * 15;
        const nAng = ring === 0 ? 1 : Math.max(6, Math.round((2 * Math.PI * rad) / 25));
        for (let a = 0; a < nAng; a++) {
          const ang = (a / nAng) * 2 * Math.PI + k;
          const x = pref.x + Math.cos(ang) * rad;
          const z = pref.z + Math.sin(ang) * rad;
          if (passAt(x, z, 0) === 0) continue;
          const r = rectOf(kind, x, z, face);
          if (!free(r, 3) || trackDist(x, z) < PARK_TRACK_CLEAR) continue;
          if (!footprintOk(g, x, z, face, cls.length, cls.width, cfg.ground.clearance, cfg)) continue;
          vehicles.push({ kind, group, x, z, headingDeg: ((face % 360) + 360) % 360, slot: k, s: 0, camo: camoOf(), seed: rnd() });
          rects.push(r);
          return;
        }
      }
    });
  };

  const off = (dist: number, brg: number): XZ => ({ x: C.x + Math.sin(brg * DEG) * dist, z: C.z - Math.cos(brg * DEG) * dist });
  const R = trackRadius || 250;

  // No track found: the column has halted on the march (a line of vehicles, front first).
  if (!trackPath) {
    const colKinds = cfg.convoy.kinds;
    if (!placeLine('convoy', colKinds, C, toAirport + 90, cfg.convoy.spacing * 0.7, null, true)) placeSingles('convoy', colKinds, C, toAirport + 90);
  }

  // Tank platoon: outside the loop on the airport side, facing the airport, hull-down behind berms.
  const bermAhead = (v: { x: number; z: number; h: number; kind: TargetKind }): Berm[] => {
    const cls = classes[v.kind];
    const d = cls.length / 2 + 2.6;
    return [{ x: v.x + Math.sin(v.h * DEG) * d, z: v.z - Math.cos(v.h * DEG) * d, headingDeg: v.h, length: 3.2, width: cls.width + 4.5, height: 1.35 }];
  };
  const platoonKinds: TargetKind[] = Array.from({ length: cfg.platoon.count }, () => 'tank');
  if (!placeLine('platoon', platoonKinds, off(R + 110, toAirport + 25), toAirport, cfg.platoon.spacing, bermAhead)) {
    placeSingles('platoon', platoonKinds, off(R + 110, toAirport + 25), toAirport);
  }

  // AAA: inside the loop (covering the column), guns toward the likely attack, in horseshoe revetments.
  const revetment = (v: { x: number; z: number; h: number; kind: TargetKind }): Berm[] => {
    const cls = classes[v.kind];
    const fx = Math.sin(v.h * DEG);
    const fz = -Math.cos(v.h * DEG);
    const rx = -fz;
    const rz = fx;
    const f = cls.length / 2 + 2.4;
    const sd = cls.width / 2 + 2.4;
    return [
      { x: v.x + fx * f, z: v.z + fz * f, headingDeg: v.h, length: 2.8, width: cls.width + 6, height: 1.5 },
      { x: v.x + rx * sd + fx * 0.8, z: v.z + rz * sd + fz * 0.8, headingDeg: v.h + 90, length: 2.6, width: cls.length + 1.5, height: 1.4 },
      { x: v.x - rx * sd + fx * 0.8, z: v.z - rz * sd + fz * 0.8, headingDeg: v.h + 90, length: 2.6, width: cls.length + 1.5, height: 1.4 },
    ];
  };
  const aaaKinds: TargetKind[] = Array.from({ length: cfg.aaa.count }, () => 'aaa');
  if (!placeLine('aaa', aaaKinds, off(R * 0.35, toAirport - 70), toAirport - 20, cfg.aaa.spacing, revetment)) {
    placeSingles('aaa', aaaKinds, off(R * 0.35, toAirport - 70), toAirport - 20);
  }

  // Logistics park: far side of the loop, trucks in a row.
  const logKinds = cfg.logistics.kinds;
  if (!placeLine('logistics', logKinds, off(R + 100, toAirport + 180), toAirport + 90, cfg.logistics.spacing, null)) {
    placeSingles('logistics', logKinds, off(R + 100, toAirport + 180), toAirport + 90);
  }

  // ── Scatter clearances along the track (after the parked groups are known) ──
  if (track && trackPath) {
    const smp = newPathSample();
    const maxD = cfg.convoy.scatter[1];
    const parked = rects.slice(cfg.convoy.kinds.length);
    const n = trackPath.n;
    const every = 3;
    // bucket grid of the track stations (is an off-track point near another stretch of the track?)
    const BK = 16;
    const buckets = new Map<number, number[]>();
    const bkey = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096);
    for (let i = 0; i < n; i++) {
      const k = bkey(Math.floor(trackPath.x[i] / BK), Math.floor(trackPath.z[i] / BK));
      (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(i);
    }
    const trackNear = (x: number, z: number, r: number): boolean => {
      const i0 = Math.floor((x - r) / BK);
      const i1 = Math.floor((x + r) / BK);
      const j0 = Math.floor((z - r) / BK);
      const j1 = Math.floor((z + r) / BK);
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const l = buckets.get(bkey(i, j));
          if (l) for (const q of l) if (Math.hypot(trackPath!.x[q] - x, trackPath!.z[q] - z) < r) return true;
        }
      return false;
    };
    const coarseL: number[] = [];
    const coarseR: number[] = [];
    for (let i = 0; i < n; i += every) {
      sampleAt(trackPath, trackPath.s[i], smp);
      const nx = smp.tz; // left of travel = (tz, −tx)
      const nz = -smp.tx;
      for (const side of [1, -1]) {
        let best = 0;
        for (let d = 2; d <= maxD; d += 2) {
          const x = smp.x + nx * d * side;
          const z = smp.z + nz * d * side;
          if (passAt(x, z, 3) === 0) break;
          let hitParked = false;
          for (const q of parked) if (Math.hypot(q.x - x, q.z - z) < q.hl + 9) hitParked = true;
          if (hitParked) break;
          // don't pull off onto another stretch of the track
          if (d > 4 && trackNear(x, z, d - 2.5)) break;
          best = d;
        }
        (side > 0 ? coarseL : coarseR).push(best);
      }
    }
    for (let i = 0; i < n; i++) {
      const k = Math.floor(i / every);
      const k2 = Math.min(coarseL.length - 1, k + 1);
      track.scatterL.push(Math.min(coarseL[k], coarseL[k2]));
      track.scatterR.push(Math.min(coarseR[k], coarseR[k2]));
    }
  }

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    site: { x: C.x, z: C.z, headingDeg: site.headingDeg },
    track,
    vehicles,
    berms,
    stats: { ms: t1 - t0, cells: cache.size, points, trackRadius, attempts },
  };

  // ── helpers (hoisted) ──────────────────────────────────────────────────────

  /**
   * A loop around the centre: an ellipse (semi-axes R0·k and R0/k, a few orientations tried) whose
   * blocked stretches (hedgerows, woodlots, farm yards) are repaired with a local A* detour — to the
   * nearest gap in the hedge and back, as farm tracks do. Null when no ellipse can be repaired.
   */
  function findLoop(center: XZ, R0: number, startBrg: number): XZ[] | null {
    const cell = cfg.track.cell;
    for (const dOrient of [90, 60, 120, 30, 150, 0]) {
      for (const k of [1.3, 1.0, 1.6]) {
        if (now() > budgetEnd) return null;
        const ea = R0 * k;
        const eb = R0 / k;
        const th = (startBrg + dOrient) * DEG;
        const ux = Math.sin(th);
        const uz = -Math.cos(th);
        const per = 2 * Math.PI * Math.sqrt((ea * ea + eb * eb) / 2);
        const n = Math.max(24, Math.round(per / cell));
        const base: XZ[] = [];
        const ok: boolean[] = [];
        let blocked = 0;
        for (let i = 0; i < n; i++) {
          const t = (i / n) * 2 * Math.PI;
          const a = Math.cos(t) * ea;
          const b = Math.sin(t) * eb;
          const p = { x: center.x + ux * a - uz * b, z: center.z + uz * a + ux * b };
          base.push(p);
          const pv = passAt(p.x, p.z, trackClear);
          ok.push(pv > 0);
          if (pv === 0) blocked++;
        }
        if (blocked > n * 0.45 || blocked === n) continue;
        // runs of blocked samples (cyclic), each with its anchors (the ok samples around it)
        let s0 = 0;
        while (!ok[s0]) s0++;
        const runs: [number, number][] = [];
        for (let q = 1; q <= n; q++) {
          const i = (s0 + q) % n;
          if (!ok[i] && ok[(i - 1 + n) % n]) runs.push([(i - 1 + n) % n, -1]);
          if (ok[i] && !ok[(i - 1 + n) % n] && runs.length) runs[runs.length - 1][1] = i;
        }
        const detours = new Map<number, XZ[]>();
        const accepted: XZ[] = base.filter((_, i) => ok[i]);
        let failed = false;
        for (const [a0, b0] of runs) {
          if (b0 < 0) {
            failed = true;
            break;
          }
          const inRun = (i: number) => (a0 <= b0 ? i >= a0 && i <= b0 : i >= a0 || i <= b0);
          const near = (i: number) => {
            for (let d = -4; d <= 4; d++) if (inRun((i + d + n) % n)) return true;
            return false;
          };
          const avoid = base.filter((_, i) => ok[i] && !near(i));
          const others: XZ[] = [];
          for (const [, pts] of detours) others.push(...pts);
          const path = detour(base[a0], base[b0], [...avoid, ...others]);
          if (!path) {
            failed = true;
            break;
          }
          detours.set(a0, path);
          accepted.push(...path);
        }
        if (failed) continue;
        // assemble: base samples, with each blocked run replaced by its detour
        const out: XZ[] = [];
        let i = s0;
        for (let q = 0; q < n; q++) {
          const d = detours.get(i);
          if (d) {
            out.push(...d.slice(0, -1));
            const run = runs.find((r) => r[0] === i)!;
            const skip = (run[1] - i + n) % n;
            q += skip - 1;
            i = run[1];
            continue;
          }
          out.push(base[i]);
          i = (i + 1) % n;
        }
        return out;
      }
    }
    return null;
  }

  /** Local A* from a to b (both on clear ground) that keeps ≥ 12 m from `avoid`; string-pulled; null if none. */
  function detour(a: XZ, b: XZ, avoid: XZ[]): XZ[] | null {
    const cell = cfg.track.cell;
    const pad = 160;
    const minX = Math.min(a.x, b.x) - pad;
    const minZ = Math.min(a.z, b.z) - pad;
    const NX = Math.ceil((Math.abs(a.x - b.x) + 2 * pad) / cell) + 1;
    const NZ = Math.ceil((Math.abs(a.z - b.z) + 2 * pad) / cell) + 1;
    const cx = (i: number) => minX + i * cell;
    const cz = (j: number) => minZ + j * cell;
    const N = NX * NZ;
    const pass = new Int8Array(N).fill(-1);
    const forbid = new Uint8Array(N);
    for (const p of avoid) {
      const i0 = Math.floor((p.x - 12 - minX) / cell);
      const i1 = Math.ceil((p.x + 12 - minX) / cell);
      const j0 = Math.floor((p.z - 12 - minZ) / cell);
      const j1 = Math.ceil((p.z + 12 - minZ) / cell);
      for (let j = Math.max(0, j0); j <= Math.min(NZ - 1, j1); j++)
        for (let i = Math.max(0, i0); i <= Math.min(NX - 1, i1); i++) if (Math.hypot(cx(i) - p.x, cz(j) - p.z) < 12) forbid[j * NX + i] = 1;
    }
    const idxOf = (p: XZ) => Math.round((p.z - minZ) / cell) * NX + Math.round((p.x - minX) / cell);
    const start = idxOf(a);
    const goal = idxOf(b);
    forbid[start] = 0;
    forbid[goal] = 0;
    const passCell = (idx: number): number => {
      let v = pass[idx];
      if (v < 0) {
        v = passAt(cx(idx % NX), cz(Math.floor(idx / NX)), trackClear);
        pass[idx] = v;
      }
      return v;
    };
    const chordX = b.x - a.x;
    const chordZ = b.z - a.z;
    const chordL2 = chordX * chordX + chordZ * chordZ || 1;
    const off = (x: number, z: number) => {
      const t = Math.max(0, Math.min(1, ((x - a.x) * chordX + (z - a.z) * chordZ) / chordL2));
      return Math.hypot(a.x + chordX * t - x, a.z + chordZ * t - z);
    };
    const gs = new Float32Array(N).fill(Infinity);
    const parent = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const heapI: number[] = [];
    const heapF: number[] = [];
    const push = (idx: number, f: number) => {
      heapI.push(idx);
      heapF.push(f);
      let c = heapI.length - 1;
      while (c > 0) {
        const p = (c - 1) >> 1;
        if (heapF[p] <= heapF[c]) break;
        [heapF[p], heapF[c]] = [heapF[c], heapF[p]];
        [heapI[p], heapI[c]] = [heapI[c], heapI[p]];
        c = p;
      }
    };
    const pop = (): number => {
      const top = heapI[0];
      const li = heapI.pop()!;
      const lf = heapF.pop()!;
      if (heapI.length > 0) {
        heapI[0] = li;
        heapF[0] = lf;
        let c = 0;
        for (;;) {
          const l = 2 * c + 1;
          const r = l + 1;
          let m = c;
          if (l < heapI.length && heapF[l] < heapF[m]) m = l;
          if (r < heapI.length && heapF[r] < heapF[m]) m = r;
          if (m === c) break;
          [heapF[m], heapF[c]] = [heapF[c], heapF[m]];
          [heapI[m], heapI[c]] = [heapI[c], heapI[m]];
          c = m;
        }
      }
      return top;
    };
    const gx = goal % NX;
    const gz = Math.floor(goal / NX);
    gs[start] = 0;
    push(start, 0);
    let expanded = 0;
    while (heapI.length > 0) {
      const cur = pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (cur === goal) break;
      if (++expanded > 30000) return null;
      const ci = cur % NX;
      const cj = Math.floor(cur / NX);
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          if (!di && !dj) continue;
          const ni = ci + di;
          const nj = cj + dj;
          if (ni < 0 || nj < 0 || ni >= NX || nj >= NZ) continue;
          const nIdx = nj * NX + ni;
          if (closed[nIdx] || forbid[nIdx]) continue;
          const pv = nIdx === goal ? 2 : passCell(nIdx);
          if (pv === 0) continue;
          if (di && dj && (passCell(cj * NX + ni) === 0 || passCell(nj * NX + ci) === 0)) continue;
          const step = (di && dj ? Math.SQRT2 : 1) * cell * (pv === 1 ? 3 : 1) * (1 + off(cx(ni), cz(nj)) / 70);
          const ng = gs[cur] + step;
          if (ng < gs[nIdx]) {
            gs[nIdx] = ng;
            parent[nIdx] = cur;
            push(nIdx, ng + 1.1 * cell * Math.hypot(ni - gx, nj - gz));
          }
        }
    }
    if (!closed[goal]) return null;
    const cells: XZ[] = [];
    for (let c = goal; c !== -1; c = parent[c]) cells.push({ x: cx(c % NX), z: cz(Math.floor(c / NX)) });
    cells.reverse();
    cells[0] = { x: a.x, z: a.z };
    cells[cells.length - 1] = { x: b.x, z: b.z };
    // string-pull (validated segments only)
    const pulled: XZ[] = [cells[0]];
    let i = 0;
    while (i < cells.length - 1) {
      let j = i + 1;
      for (let k = Math.min(cells.length - 1, i + 40); k > i + 1; k--) {
        if (segPass(cells[i], cells[k], trackClear)) {
          j = k;
          break;
        }
      }
      pulled.push(cells[j]);
      i = j;
    }
    // densify to ~cell spacing so the smoothing rounds the corners tightly
    const dense: XZ[] = [];
    for (let k = 0; k < pulled.length - 1; k++) {
      const p = pulled[k];
      const q = pulled[k + 1];
      const m = Math.max(1, Math.ceil(Math.hypot(q.x - p.x, q.z - p.z) / cell));
      for (let t = 0; t < m; t++) dense.push({ x: p.x + ((q.x - p.x) * t) / m, z: p.z + ((q.z - p.z) * t) / m });
    }
    dense.push(pulled[pulled.length - 1]);
    return dense;
  }

  /** Round the corners where that stays on clear ground, sample every 2 m; null if a station leaves clear ground. */
  function smoothLoop(loopPts: XZ[]): XZ[] | null {
    const dense = loopPts;
    // Chaikin passes that keep a corner wherever cutting it would leave clear ground.
    let c = dense;
    for (let it = 0; it < 3; it++) {
      const n2 = c.length;
      const next: XZ[] = [];
      for (let k = 0; k < n2; k++) {
        const a = c[k];
        const b = c[(k + 1) % n2];
        const d = c[(k + 2) % n2];
        const r1 = { x: 0.25 * a.x + 0.75 * b.x, z: 0.25 * a.z + 0.75 * b.z };
        const q2 = { x: 0.75 * b.x + 0.25 * d.x, z: 0.75 * b.z + 0.25 * d.z };
        next.push({ x: 0.75 * a.x + 0.25 * b.x, z: 0.75 * a.z + 0.25 * b.z }, r1);
        if (!segPass(r1, q2, trackClear)) next.push({ x: b.x, z: b.z });
      }
      c = next;
    }
    const r = resample(c, 2, true);
    let bad = 0;
    for (const p of r) if (!trackPointOk(p.x, p.z)) bad++;
    if (bad) return null;
    return r;
  }

  /** Exact test of a track station: open ground, no keep-out, nothing over the vehicle's core width. */
  function trackPointOk(x: number, z: number): boolean {
    if (!openAt(g, x, z, cfg) && !hedgeGapAt(x, z)) return false;
    if (g.keepOut && g.keepOut(x, z) >= 2) return false;
    if (!clearAt(g, x, z)) return false;
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4;
      if (!clearAt(g, x + Math.cos(a) * 1.3, z + Math.sin(a) * 1.3)) return false;
    }
    return true;
  }

  /** An out-and-back trail through the centre (two lanes 4 m apart, U-turns at the ends), or null. */
  function findOutAndBack(center: XZ, R0: number, brg: number): XZ[] | null {
    for (const dB of [90, 60, 120, 30, 150, 0]) {
      const h = (brg + dB) * DEG;
      const a = { x: center.x - Math.sin(h) * R0, z: center.z + Math.cos(h) * R0 };
      const b = { x: center.x + Math.sin(h) * R0, z: center.z - Math.cos(h) * R0 };
      if (!segPass(a, b, trackClear + 4)) continue;
      const fx = Math.sin(h);
      const fz = -Math.cos(h);
      const lx = fz;
      const lz = -fx;
      const w = 4;
      const pts: XZ[] = [];
      const L = 2 * R0;
      const n = Math.ceil(L / 2);
      for (let k = 0; k <= n; k++) pts.push({ x: a.x + fx * (L * k) / n - lx * w, z: a.z + fz * (L * k) / n - lz * w });
      for (let k = 1; k < 12; k++) {
        const t = (k / 12) * Math.PI;
        pts.push({ x: b.x + fx * Math.sin(t) * w - lx * Math.cos(t) * w, z: b.z + fz * Math.sin(t) * w - lz * Math.cos(t) * w });
      }
      for (let k = 0; k <= n; k++) pts.push({ x: b.x - fx * (L * k) / n + lx * w, z: b.z - fz * (L * k) / n + lz * w });
      for (let k = 1; k < 12; k++) {
        const t = (k / 12) * Math.PI;
        pts.push({ x: a.x - fx * Math.sin(t) * w + lx * Math.cos(t) * w, z: a.z - fz * Math.sin(t) * w + lz * Math.cos(t) * w });
      }
      const r = resample(pts, 2, true);
      if (r.every((q) => passAt(q.x, q.z, trackHalf) !== 0)) return r;
    }
    return null;
  }
}
