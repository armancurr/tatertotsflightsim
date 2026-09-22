/**
 * Sea traffic plan (PURE): the Port Chateau marina (quay, breakwaters,
 * pontoons, berths), the moored boats, and every moving vessel's route and
 * schedule — sailing yachts on triangle courses that respect the wind, motor
 * yachts, fishing boats, a harbour launch, the bay ferry (double-ended,
 * ping-pong with dwell), a container ship and a tanker 6–10 km offshore, and
 * boats on Tater Lake.
 *
 * Everything is a pure function of (config, layout, time): `vesselPose(route,
 * t, out)` gives position, hull heading, course, speed, heave/pitch/roll, sail
 * trim. Routes are hand-shaped around the layout's landmarks (coast, bay,
 * lake) and validated against the water (`validateRoute`): a route whose hull
 * would touch land or shallow water is dropped at runtime.
 *
 * Frame: +X east, +Z south; heading clockwise from north. Vessel body frame =
 * three.js object frame (bow −Z, +X starboard, +Y up).
 */
import { CONFIG, type Config } from '../../config';
import type { WorldLayout } from '../layout';
import { createPath, samplePath, filletPath, smoothLoop, smoothLine, newPathSample, arcAtTime, type Path, type PathSample, type Waypoint } from './path';
import { h01, hRange, KT, clamp, smooth, wrap180 } from './rng';

export type VesselKind = 'sail' | 'motor' | 'fish' | 'launch' | 'ferry' | 'container' | 'tanker';

export interface VesselDims {
  length: number;
  beam: number;
  draft: number;
  /** Deck height above the waterline at mid-ships. */
  freeboard: number;
}

export const VESSEL_DIMS: Record<VesselKind, VesselDims> = {
  sail: { length: 12, beam: 3.9, draft: 2.0, freeboard: 1.1 },
  motor: { length: 18, beam: 5.0, draft: 1.3, freeboard: 1.9 },
  fish: { length: 20, beam: 6.2, draft: 2.6, freeboard: 1.8 },
  launch: { length: 7.5, beam: 2.6, draft: 0.5, freeboard: 0.9 },
  ferry: { length: 92, beam: 20, draft: 4.2, freeboard: 3.6 },
  container: { length: 294, beam: 32.3, draft: 12, freeboard: 10.5 },
  tanker: { length: 250, beam: 44, draft: 14, freeboard: 7.5 },
};

/** Minimum water depth a route of this kind must keep under the whole hull, m. */
const MIN_DEPTH: Record<VesselKind, number> = { sail: 2.6, motor: 2, fish: 3.5, launch: 0.7, ferry: 2, container: 14, tanker: 16 };

export interface WaterWorld {
  groundHeight(x: number, z: number): number;
  waterLevel(x: number, z: number): number | null;
}

export interface XZ {
  x: number;
  z: number;
}

// ─── Wind and sailing ─────────────────────────────────────────────────────────

/** Relative wind angle for a course: 0 = head to wind, + = wind over the starboard side, ±180 = running. */
export const relWind = (windFromDeg: number, courseDeg: number): number => wrap180(windFromDeg - courseDeg);

const lerpTable = (tbl: readonly (readonly [number, number])[], x: number): number => {
  if (x <= tbl[0][0]) return tbl[0][1];
  for (let i = 1; i < tbl.length; i++) {
    if (x <= tbl[i][0]) {
      const [x0, y0] = tbl[i - 1];
      const [x1, y1] = tbl[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
    }
  }
  return tbl[tbl.length - 1][1];
};

/** Boat speed (kt) of a 12 m cruiser at 13 kt true wind vs |relative wind| (deg). */
const POLAR: readonly (readonly [number, number])[] = [[0, 1.2], [30, 1.6], [40, 4.6], [52, 5.8], [75, 6.6], [100, 6.9], [130, 6.4], [155, 5.6], [180, 4.9]];
/** Heel (deg) vs |relative wind|: luffing head to wind, hard on the wind, eased off downwind. */
const HEEL: readonly (readonly [number, number])[] = [[0, 1.5], [28, 3], [40, 17], [60, 18], [90, 13], [130, 7], [160, 3], [180, 1.5]];
/** Boom (deg off the centreline, to leeward) vs |relative wind|. */
const BOOM: readonly (readonly [number, number])[] = [[0, 0], [30, 4], [42, 9], [60, 18], [90, 36], [130, 60], [160, 76], [180, 82]];

export function sailSpeedKt(absRel: number, lengthM = 12, windKt = 13): number {
  return lerpTable(POLAR, absRel) * Math.sqrt(lengthM / 12) * clamp(0.55 + 0.035 * windKt, 0.5, 1.2);
}

// ─── Marina ──────────────────────────────────────────────────────────────────

export interface MarinaFrame {
  ox: number;
  oz: number;
  /** Unit vector along the coast (east-ish). */
  ux: number;
  uz: number;
  /** Unit vector out to sea (south-ish). */
  wx: number;
  wz: number;
  /** Heading of +u and of +w, deg. */
  headingU: number;
  headingW: number;
}

export const toWorld = (f: MarinaFrame, u: number, w: number): XZ => ({ x: f.ox + f.ux * u + f.wx * w, z: f.oz + f.uz * u + f.wz * w });
export const toLocal = (f: MarinaFrame, x: number, z: number): { u: number; w: number } => {
  const dx = x - f.ox;
  const dz = z - f.oz;
  return { u: dx * f.ux + dz * f.uz, w: dx * f.wx + dz * f.wz };
};

export interface Breakwater {
  /** Centreline in marina (u, w) coordinates. */
  pts: { u: number; w: number }[];
  crestY: number;
  crestHalf: number;
  baseHalf: number;
  baseY: number;
}

export interface Berth {
  x: number;
  z: number;
  heading: number;
  kind: 'sail' | 'motor' | 'launch' | 'fish';
  /** Uniform scale relative to the kind's reference length. */
  scale: number;
  variant: number;
}

export interface MarinaLayout {
  frame: MarinaFrame;
  quay: { u0: number; u1: number; w0: number; w1: number; top: number };
  breakwaters: Breakwater[];
  pontoons: { u: number; w0: number; w1: number; half: number; top: number }[];
  fingers: { u0: number; u1: number; w: number; half: number }[];
  piles: { u: number; w: number }[];
  beacons: { u: number; w: number; color: 'red' | 'green' }[];
  berths: Berth[];
  entrance: { u: number; w: number };
}

const PONTOON_U = [-235, -130, -25, 80, 185];
const PONTOON_W0 = 6;
const PONTOON_W1 = 188;
const FINGER_STEP = 5.4;
const FINGER_LEN = 9;

export function marinaFrame(layout: WorldLayout, cfg: Config = CONFIG): MarinaFrame {
  const x0 = cfg.world.traffic.sea.marinaX;
  const za = layout.coast.zAt(x0 - 300);
  const zb = layout.coast.zAt(x0 + 300);
  const l = Math.hypot(600, zb - za);
  const ux = 600 / l;
  const uz = (zb - za) / l;
  const wx = -uz;
  const wz = ux;
  const hd = (dx: number, dz: number) => ((Math.atan2(dx, -dz) * 180) / Math.PI + 360) % 360;
  return { ox: x0, oz: layout.coast.zAt(x0) + 6, ux, uz, wx, wz, headingU: hd(ux, uz), headingW: hd(wx, wz) };
}

export function createMarina(layout: WorldLayout, cfg: Config = CONFIG): MarinaLayout {
  const frame = marinaFrame(layout, cfg);
  const seed = cfg.world.traffic.seed;
  const breakwaters: Breakwater[] = [
    { pts: [{ u: -350, w: -12 }, { u: -350, w: 238 }, { u: -305, w: 298 }, { u: -205, w: 322 }, { u: -48, w: 332 }], crestY: 3.4, crestHalf: 4, baseHalf: 14, baseY: -7 },
    { pts: [{ u: 350, w: -12 }, { u: 350, w: 248 }, { u: 305, w: 312 }, { u: 205, w: 338 }, { u: 48, w: 346 }], crestY: 3.4, crestHalf: 4, baseHalf: 14, baseY: -7 },
  ];
  const pontoons = PONTOON_U.map((u) => ({ u, w0: PONTOON_W0, w1: PONTOON_W1, half: 1.5, top: 0.55 }));
  const fingers: MarinaLayout['fingers'] = [];
  const piles: MarinaLayout['piles'] = [];
  const berths: Berth[] = [];
  const fill = cfg.world.traffic.sea.berthFill;
  let bi = 0;
  for (const p of pontoons) {
    for (let w = p.w0 + 14; w <= p.w1 - 2; w += 25) {
      piles.push({ u: p.u - p.half - 0.5, w }, { u: p.u + p.half + 0.5, w });
    }
    for (let k = 0; ; k++) {
      const wf = p.w0 + 10 + k * FINGER_STEP;
      if (wf > p.w1 - 1) break;
      fingers.push({ u0: p.u - p.half - FINGER_LEN, u1: p.u - p.half, w: wf, half: 0.4 });
      fingers.push({ u0: p.u + p.half, u1: p.u + p.half + FINGER_LEN, w: wf, half: 0.4 });
      const wb = wf + FINGER_STEP / 2;
      if (wb > p.w1 - 2) continue;
      for (const side of [-1, 1]) {
        bi++;
        if (h01(seed, 7001, bi) > fill) continue;
        const r = h01(seed, 7002, bi);
        const outer = smooth(40, 170, wb);
        const kind: Berth['kind'] = r < 0.58 ? 'sail' : r < 0.86 ? 'motor' : 'launch';
        const ref = VESSEL_DIMS[kind].length;
        const want = kind === 'sail' ? 8.5 + 5 * (0.4 * outer + 0.6 * h01(seed, 7003, bi)) : kind === 'motor' ? 10 + 8 * (0.5 * outer + 0.5 * h01(seed, 7003, bi)) : 6 + 2 * h01(seed, 7003, bi);
        const scale = clamp(want / ref, 0.6, 1.2);
        const len = ref * scale;
        const u = p.u + side * (p.half + 0.4 + len / 2);
        const pos = toWorld(frame, u, wb);
        // bow toward the pontoon (bow-in) for motor boats, stern-to for sailing yachts, mixed by hash
        const bowIn = kind === 'motor' ? h01(seed, 7004, bi) < 0.7 : h01(seed, 7004, bi) < 0.35;
        const towardPontoon = side < 0 ? frame.headingU : (frame.headingU + 180) % 360;
        berths.push({ x: pos.x, z: pos.z, heading: bowIn ? towardPontoon : (towardPontoon + 180) % 360, kind, scale, variant: Math.floor(h01(seed, 7005, bi) * 8) });
      }
    }
  }
  // fishing boats alongside the inner face of the east breakwater
  for (let k = 0; k < 3; k++) {
    const pos = toWorld(frame, 327, 70 + k * 34);
    berths.push({ x: pos.x, z: pos.z, heading: k % 2 ? frame.headingW : (frame.headingW + 180) % 360, kind: 'fish', scale: 0.85 + 0.1 * k, variant: k + 3 });
  }
  return {
    frame,
    quay: { u0: -360, u1: 360, w0: -26, w1: 0, top: 1.7 },
    breakwaters,
    pontoons,
    fingers,
    piles,
    beacons: [
      { u: -46, w: 332, color: 'red' },
      { u: 46, w: 346, color: 'green' },
    ],
    berths,
    entrance: { u: 0, w: 339 },
  };
}

/** Distance (m) from a world point to the nearest marina structure footprint at the waterline (negative inside). */
export function marinaStructureDistance(m: MarinaLayout, x: number, z: number): number {
  const { u, w } = toLocal(m.frame, x, z);
  let d = Infinity;
  // quay
  d = Math.min(d, boxDist(u, w, m.quay.u0, m.quay.u1, -1e4, m.quay.w1));
  for (const b of m.breakwaters) {
    // waterline half-width of the rubble mound (linear slope from crest to base)
    const half = b.crestHalf + ((b.baseHalf - b.crestHalf) * b.crestY) / (b.crestY - b.baseY);
    for (let i = 1; i < b.pts.length; i++) d = Math.min(d, segDist(u, w, b.pts[i - 1].u, b.pts[i - 1].w, b.pts[i].u, b.pts[i].w) - half);
  }
  for (const p of m.pontoons) d = Math.min(d, boxDist(u, w, p.u - p.half - FINGER_LEN, p.u + p.half + FINGER_LEN, p.w0, p.w1));
  return d;
}

function boxDist(u: number, w: number, u0: number, u1: number, w0: number, w1: number): number {
  const du = Math.max(u0 - u, 0, u - u1);
  const dw = Math.max(w0 - w, 0, w - w1);
  if (du === 0 && dw === 0) return -Math.min(u - u0, u1 - u, w - w0, w1 - w);
  return Math.hypot(du, dw);
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const vx = bx - ax;
  const vz = bz - az;
  const t = clamp(((px - ax) * vx + (pz - az) * vz) / (vx * vx + vz * vz || 1), 0, 1);
  return Math.hypot(px - ax - vx * t, pz - az - vz * t);
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export type RouteMode = 'loop' | 'ferry';

export interface SeaRoute {
  id: string;
  kind: VesselKind;
  mode: RouteMode;
  path: Path;
  /** Water surface height along the route (sea 0, lake level). */
  level: number;
  /** Arc-length offset at t = 0 (loops) or schedule offset in s (ferry). */
  phase: number;
  scale: number;
  variant: number;
  /** Relative sea state (1 open sea, <1 sheltered). */
  sea: number;
  /** Ferry schedule (mode 'ferry'). */
  ferry?: { vmax: number; accel: number; dwell: number; transit: number; period: number };
}

export interface SeaPlan {
  marina: MarinaLayout;
  routes: SeaRoute[];
  /** Routes that failed validation (their ids) — expected to be empty for the default world. */
  rejected: string[];
  windFromDeg: number;
  windKt: number;
}

const kt = (v: number) => v * KT;

/** A closed loop of straight legs with rounded corners through the vertices. */
export function filletLoop(verts: XZ[], r: number, y = 0, v = 1): (XZ & { y: number; v: number })[] {
  const n = verts.length;
  const mid = { x: (verts[n - 1].x + verts[0].x) / 2, z: (verts[n - 1].z + verts[0].z) / 2 };
  const wps: Waypoint[] = [{ ...mid, y, v }, ...verts.map((p) => ({ x: p.x, z: p.z, y, v, r })), { ...mid, y, v }];
  const pts = filletPath(wps, 6);
  pts.pop(); // closing duplicate
  return pts;
}

/** Applies a speed function (of heading) to a path's speed table. */
function setSpeeds(p: Path, fn: (heading: number, x: number, z: number) => number): Path {
  const smp = newPathSample();
  const v = p.v as Float64Array;
  for (let i = 0; i < p.n; i++) {
    samplePath(p, p.s[i], smp);
    v[i] = Math.max(0.3, fn(smp.heading, smp.x, smp.z));
  }
  // rebuild the time table
  const t = p.t as Float64Array;
  let dur = 0;
  t[0] = 0;
  for (let i = 1; i < p.n; i++) {
    dur += (p.s[i] - p.s[i - 1]) / ((v[i] + v[i - 1]) / 2);
    t[i] = dur;
  }
  if (p.closed) dur += (p.length - p.s[p.n - 1]) / ((v[p.n - 1] + v[0]) / 2);
  (p as { duration: number }).duration = dur;
  return p;
}

const rot = (cx: number, cz: number, pts: XZ[], deg: number): XZ[] => {
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  return pts.map((p) => ({ x: cx + p.x * c - p.z * s, z: cz + p.x * s + p.z * c }));
};

/**
 * A sailing triangle whose legs are all sailable in the wind: a beam reach, a close-hauled leg
 * (the boat tacks through the wind at its end) and a broad reach (gybe at its end).
 */
export function sailingTriangle(cx: number, cz: number, size: number, windFromDeg: number, mirror: boolean): XZ[] {
  // headings relative to the wind direction (from): beam reach (−90), close-hauled (+45), broad (+155)
  const rel = mirror ? [90, -45, -155] : [-90, 45, 155];
  const hd = rel.map((r) => (windFromDeg - r + 360) % 360);
  const d = hd.map((h) => ({ x: Math.sin((h * Math.PI) / 180), z: -Math.cos((h * Math.PI) / 180) }));
  // leg lengths a, b, c with a·d0 + b·d1 + c·d2 = 0 (solve for b, c with a = 1)
  const det = d[1].x * d[2].z - d[1].z * d[2].x;
  const b = (-d[0].x * d[2].z + d[0].z * d[2].x) / det;
  const c = (-d[1].x * d[0].z + d[1].z * d[0].x) / det;
  const legs = [1, b, c].map((l) => l * size);
  const pts: XZ[] = [{ x: 0, z: 0 }];
  for (let i = 0; i < 2; i++) pts.push({ x: pts[i].x + d[i].x * legs[i], z: pts[i].z + d[i].z * legs[i] });
  const mx = (pts[0].x + pts[1].x + pts[2].x) / 3;
  const mz = (pts[0].z + pts[1].z + pts[2].z) / 3;
  return pts.map((p) => ({ x: cx + p.x - mx, z: cz + p.z - mz }));
}

/**
 * Checks a route against the water: at every `step` m the hull's centre, bow, stern and both
 * sides must be on water deeper than the kind's minimum. Returns the shallowest depth found.
 */
export function routeMinDepth(route: SeaRoute, water: WaterWorld, step = 20): number {
  const dims = VESSEL_DIMS[route.kind];
  const L = (dims.length * route.scale) / 2;
  const B = (dims.beam * route.scale) / 2 + 1;
  const smp = newPathSample();
  const m = Math.max(4, Math.ceil(route.path.length / step));
  let lo = Infinity;
  for (let i = 0; i <= m; i++) {
    samplePath(route.path, (i / m) * route.path.length, smp);
    const hr = (smp.heading * Math.PI) / 180;
    const fx = Math.sin(hr);
    const fz = -Math.cos(hr);
    const pts = [
      [0, 0],
      [L, 0],
      [-L, 0],
      [0, B],
      [0, -B],
    ];
    for (const [a, c] of pts) {
      const x = smp.x + fx * a - fz * c;
      const z = smp.z + fz * a + fx * c;
      const wl = water.waterLevel(x, z);
      if (wl === null || Math.abs(wl - route.level) > 0.5) return -Infinity;
      const depth = wl - water.groundHeight(x, z);
      if (depth < lo) lo = depth;
    }
  }
  return lo;
}

export function validateRoute(route: SeaRoute, water: WaterWorld, marina: MarinaLayout | null): boolean {
  const need = MIN_DEPTH[route.kind];
  // ferry berths are dredged: check depth only away from the terminals
  if (routeMinDepth(route, water) < (route.mode === 'ferry' ? 1 : need)) return false;
  if (marina && route.kind !== 'launch') {
    const smp = newPathSample();
    const m = Math.ceil(route.path.length / 25);
    for (let i = 0; i <= m; i++) {
      samplePath(route.path, (i / m) * route.path.length, smp);
      if (marinaStructureDistance(marina, smp.x, smp.z) < 120) return false;
    }
  }
  return true;
}

/** The plan's route definitions (unvalidated). Deterministic from config + layout. */
export function defineRoutes(layout: WorldLayout, marina: MarinaLayout, cfg: Config = CONFIG): SeaRoute[] {
  const tc = cfg.world.traffic;
  const seed = tc.seed;
  const wind = tc.windFromDeg;
  const routes: SeaRoute[] = [];
  const coastZ = layout.coast.zAt;
  const loop = (id: string, kind: VesselKind, pts: (XZ & { y?: number; v?: number })[], level: number, speed: number | ((h: number, x: number, z: number) => number), opts: Partial<SeaRoute> = {}) => {
    const path = createPath(pts.map((p) => ({ x: p.x, y: level, z: p.z, v: 1 })), true, 5);
    setSpeeds(path, typeof speed === 'number' ? () => speed : speed);
    routes.push({ id, kind, mode: 'loop', path, level, phase: h01(seed, 8100, routes.length) * path.length, scale: 1, variant: routes.length, sea: 1, ...opts });
  };
  const sailSpeed = (len: number) => (h: number) => kt(sailSpeedKt(Math.abs(relWind(wind, h)), len, tc.windKt));

  // ── Sailing yachts: triangle courses off the city and the airport coast ──
  const sailSpots = [
    { x: -6300, z: 9250, a: 1150 },
    { x: -3200, z: 10050, a: 950 },
    { x: -8900, z: 9750, a: 1000 },
    { x: 1300, z: 9350, a: 1250 },
    { x: 3300, z: 8750, a: 900 },
    { x: 5900, z: 9150, a: 1100 },
  ];
  for (let i = 0; i < Math.min(tc.sea.sailingYachts, sailSpots.length); i++) {
    const s = sailSpots[i];
    const tri = sailingTriangle(s.x, Math.max(s.z, coastZ(s.x) + 1200), s.a, wind, h01(seed, 8200, i) < 0.5);
    const scale = hRange(seed, 8201, i, 0.85, 1.15);
    loop(`sail-${i}`, 'sail', filletLoop(tri, 60), 0, sailSpeed(12 * scale), { scale });
  }

  // ── Motor yachts: long loops along the coast at planing speed ──
  const motorLoops: XZ[][] = [
    [{ x: -3900, z: 8480 }, { x: -1500, z: 8560 }, { x: -350, z: 8880 }, { x: -1600, z: 9180 }, { x: -4100, z: 8980 }],
    [{ x: -500, z: 10650 }, { x: 2500, z: 10500 }, { x: 5600, z: 10250 }, { x: 4600, z: 11050 }, { x: 1000, z: 11250 }],
    [{ x: -7200, z: 8250 }, { x: -9800, z: 8150 }, { x: -12200, z: 8450 }, { x: -11000, z: 8950 }, { x: -8000, z: 8750 }],
  ];
  for (let i = 0; i < Math.min(tc.sea.motorYachts, motorLoops.length); i++) {
    const scale = hRange(seed, 8300, i, 0.85, 1.25);
    loop(`motor-${i}`, 'motor', smoothLoop(motorLoops[i], 24), 0, kt(hRange(seed, 8301, i, 17, 24)), { scale });
  }

  // ── Fishing boats: two trawling slow circles, one steaming to the grounds ──
  const circle = (cx: number, cz: number, r: number, n = 16): XZ[] => Array.from({ length: n }, (_, k) => ({ x: cx + r * Math.cos((k / n) * Math.PI * 2), z: cz + r * Math.sin((k / n) * Math.PI * 2) }));
  const fishing: { pts: XZ[]; v: number }[] = [
    { pts: circle(-5200, 12900, 600), v: kt(3.6) },
    { pts: circle(2600, 12700, 700).reverse(), v: kt(3.3) },
    { pts: [{ x: -10200, z: 11000 }, { x: -8800, z: 12600 }, { x: -7300, z: 13300 }, { x: -7100, z: 12500 }, { x: -8600, z: 11300 }], v: kt(9) },
  ];
  for (let i = 0; i < Math.min(tc.sea.fishingBoats, fishing.length); i++) {
    const f = fishing[i];
    loop(`fish-${i}`, 'fish', smoothLoop(f.pts, 20), 0, f.v, { scale: hRange(seed, 8400, i, 0.85, 1.1) });
  }

  // ── Harbour launch: in through the entrance, round the basin, out and round a buoy ──
  {
    const loc: [number, number][] = [
      [90, 980], [36, 600], [-8, 420], [-12, 330], [-40, 262], [-120, 244], [-192, 252], [-214, 268], [-194, 286], [-110, 292], [-20, 290], [13, 330], [18, 430], [70, 640], [160, 880], [150, 1020],
    ];
    const pts = loc.map(([u, w]) => toWorld(marina.frame, u, w));
    const f = marina.frame;
    loop('launch-0', 'launch', smoothLoop(pts, 16), 0, (_h, x, z) => {
      const { w } = toLocal(f, x, z);
      return kt(4 + 14 * smooth(380, 620, w));
    });
  }

  // ── Bay ferry: double-ended, W ↔ E across the bay mouth ──
  {
    const zc = layout.coast.bay.z + 800;
    const shoreW = findShore(layout, layout.coast.bay.x, zc, -1);
    const shoreE = findShore(layout, layout.coast.bay.x, zc, 1);
    const pier = 150;
    const half = VESSEL_DIMS.ferry.length / 2;
    const a = { x: shoreW + pier + half, z: zc };
    const b = { x: shoreE - pier - half, z: zc };
    const mid = { x: (a.x + b.x) / 2, z: zc + 120 };
    const pts = smoothLine([a, { x: a.x + 250, z: zc }, mid, { x: b.x - 250, z: zc }, b], 30);
    const path = createPath(pts.map((p) => ({ x: p.x, y: 0, z: p.z, v: 1 })), false, 5);
    const vmax = kt(tc.sea.ferry.speedKt);
    const accel = tc.sea.ferry.accel;
    const transit = trapezoidTime(path.length, vmax, accel);
    const period = 2 * (transit + tc.sea.ferry.dwell);
    routes.push({
      id: 'ferry-0', kind: 'ferry', mode: 'ferry', path, level: 0, phase: tc.sea.ferry.dwell * 0.6, scale: 1, variant: 0, sea: 0.8,
      ferry: { vmax, accel, dwell: tc.sea.ferry.dwell, transit, period },
    });
  }

  // ── Container ship and tanker on nested offshore loops (never cross) ──
  {
    const c = filletLoop([{ x: -46000, z: 15000 }, { x: 46000, z: 15000 }, { x: 46000, z: 17400 }, { x: -46000, z: 17400 }], 1200);
    loop('container-0', 'container', c, 0, kt(17), { sea: 0.4 });
    const r = routes[routes.length - 1];
    r.phase = arcToX(r.path, -2500, 15000);
    const t = filletLoop([{ x: 50000, z: 14000 }, { x: -50000, z: 14000 }, { x: -50000, z: 18400 }, { x: 50000, z: 18400 }], 1600);
    loop('tanker-0', 'tanker', t, 0, kt(12), { sea: 0.35 });
    const r2 = routes[routes.length - 1];
    r2.phase = arcToX(r2.path, 7000, 14000);
  }

  // ── Tater Lake ──
  {
    const lk = layout.lakes.find((l) => l.name === 'Tater Lake') ?? layout.lakes[0];
    if (lk) {
      const ell = (sx: number, sz: number, ox: number, oz: number, n = 20): XZ[] =>
        rot(lk.center.x, lk.center.z, Array.from({ length: n }, (_, k) => ({ x: ox + sx * lk.radiusX * Math.cos((k / n) * Math.PI * 2), z: oz + sz * lk.radiusZ * Math.sin((k / n) * Math.PI * 2) })), lk.rotationDeg);
      const defs = [
        { kind: 'sail' as const, pts: ell(0.18, 0.42, -800, 0), scale: 0.62 },
        { kind: 'sail' as const, pts: ell(0.17, 0.4, 580, 0).reverse(), scale: 0.55 },
        { kind: 'launch' as const, pts: ell(0.17, 0.4, -90, 0).reverse(), scale: 0.9 },
      ];
      for (let i = 0; i < Math.min(tc.sea.lakeBoats, defs.length); i++) {
        const d = defs[i];
        const speed = d.kind === 'sail' ? sailSpeed(12 * d.scale) : kt(14);
        loop(`lake-${i}`, d.kind, smoothLoop(d.pts, 12), lk.level, speed, { scale: d.scale, sea: 0.35 });
      }
    }
  }
  return routes;
}

/** Arc length of the loop point nearest (x, z). */
function arcToX(p: Path, x: number, z: number): number {
  let best = 0;
  let bd = Infinity;
  for (let i = 0; i < p.n; i++) {
    const d = Math.hypot(p.x[i] - x, p.z[i] - z);
    if (d < bd) {
      bd = d;
      best = p.s[i];
    }
  }
  return best;
}

/** x of the shoreline found by marching from (x0, z) in direction dir (±1) until the water ends. */
function findShore(layout: WorldLayout, x0: number, z: number, dir: number): number {
  // the layout's coast polyline is at the sea side; march along x on the coast function's
  // complement: land where z < coastZ(x)
  let x = x0;
  for (let i = 0; i < 2000; i++) {
    const nx = x + dir * 5;
    if (z < layout.coast.zAt(nx)) return x;
    x = nx;
  }
  return x;
}

/** Duration of a trapezoidal (or triangular) speed profile over distance D. */
export function trapezoidTime(D: number, vmax: number, a: number): number {
  const dAcc = (vmax * vmax) / (2 * a);
  if (2 * dAcc >= D) return 2 * Math.sqrt(D / a);
  return 2 * (vmax / a) + (D - 2 * dAcc) / vmax;
}

/** Distance covered after τ s of a trapezoidal profile over D. */
export function trapezoidDist(D: number, vmax: number, a: number, tau: number): { s: number; v: number } {
  const T = trapezoidTime(D, vmax, a);
  const t = clamp(tau, 0, T);
  const dAcc = (vmax * vmax) / (2 * a);
  if (2 * dAcc >= D) {
    const vp = Math.sqrt(a * D);
    if (t < T / 2) return { s: 0.5 * a * t * t, v: a * t };
    const r = T - t;
    return { s: D - 0.5 * a * r * r, v: Math.min(vp, a * r) };
  }
  const tA = vmax / a;
  if (t < tA) return { s: 0.5 * a * t * t, v: a * t };
  if (t > T - tA) {
    const r = T - t;
    return { s: D - 0.5 * a * r * r, v: a * r };
  }
  return { s: dAcc + vmax * (t - tA), v: vmax };
}

export function createSeaPlan(layout: WorldLayout, water: WaterWorld | null, cfg: Config = CONFIG): SeaPlan {
  const marina = createMarina(layout, cfg);
  const all = defineRoutes(layout, marina, cfg);
  const routes: SeaRoute[] = [];
  const rejected: string[] = [];
  for (const r of all) {
    if (!water || validateRoute(r, water, marina)) routes.push(r);
    else rejected.push(r.id);
  }
  return { marina, routes, rejected, windFromDeg: cfg.world.traffic.windFromDeg, windKt: cfg.world.traffic.windKt };
}

// ─── Poses ───────────────────────────────────────────────────────────────────

export interface VesselPose {
  x: number;
  y: number;
  z: number;
  /** Hull heading (bow direction), deg. */
  heading: number;
  /** Direction of travel, deg (= heading unless going astern, e.g. the double-ended ferry). */
  course: number;
  /** Speed through the water, m/s. */
  speed: number;
  /** Arc length along the route (monotonic distance for wakes), m. */
  travelled: number;
  /** Bow-up pitch, roll (+ starboard down), deg. */
  pitch: number;
  roll: number;
  /** Sailing: boom angle (+ swung to starboard), deg; tack +1 = wind over starboard. */
  boom: number;
  tack: number;
  /** Curvature of the track (+ right turn), 1/m. */
  curvature: number;
}

export function newVesselPose(): VesselPose {
  return { x: 0, y: 0, z: 0, heading: 0, course: 0, speed: 0, travelled: 0, pitch: 0, roll: 0, boom: 0, tack: 1, curvature: 0 };
}

const _ps: PathSample = newPathSample();

/** Arc length and speed along the route at time t (and the total distance travelled, for wakes). */
function routeState(r: SeaRoute, t: number): { s: number; v: number; dir: number; travelled: number } {
  if (r.mode === 'ferry' && r.ferry) {
    const f = r.ferry;
    const tt = t + r.phase;
    const k = Math.floor(tt / f.period);
    let q = tt - k * f.period;
    const D = r.path.length;
    const perLeg = D * 2 * k;
    if (q < f.dwell) return { s: 0, v: 0, dir: 1, travelled: perLeg };
    q -= f.dwell;
    if (q < f.transit) {
      const m = trapezoidDist(D, f.vmax, f.accel, q);
      return { s: m.s, v: m.v, dir: 1, travelled: perLeg + m.s };
    }
    q -= f.transit;
    if (q < f.dwell) return { s: D, v: 0, dir: -1, travelled: perLeg + D };
    q -= f.dwell;
    const m = trapezoidDist(D, f.vmax, f.accel, q);
    return { s: D - m.s, v: m.v, dir: -1, travelled: perLeg + D + m.s };
  }
  const p = r.path;
  const D = p.duration;
  const t0 = timeAtArc(p, r.phase);
  const tt = t + t0;
  const laps = Math.floor(tt / D);
  const s = arcAtTime(p, tt - laps * D);
  samplePath(p, s, _ps);
  return { s, v: _ps.speed, dir: 1, travelled: laps * p.length + s };
}

/** Time from the path start to arc length s (linear search on the table; cached per route by callers). */
const t0Cache = new WeakMap<Path, Map<number, number>>();
function timeAtArc(p: Path, s: number): number {
  let m = t0Cache.get(p);
  if (!m) t0Cache.set(p, (m = new Map()));
  const c = m.get(s);
  if (c !== undefined) return c;
  let lo = 0;
  for (let i = 0; i < p.n; i++) if (p.s[i] <= s) lo = i;
  const res = p.t[lo] + (lo + 1 < p.n ? ((s - p.s[lo]) / Math.max(1e-6, p.v[lo])) : 0);
  m.set(s, res);
  return res;
}

/** Deterministic sea motion: heave (m), pitch and roll (deg) for a vessel of length L. */
function seaMotion(seedK: number, L: number, sea: number, t: number, out: { heave: number; pitch: number; roll: number }): void {
  const size = clamp(12 / L, 0.03, 1.6);
  const w1 = 2 * Math.PI / (3.6 + 0.9 * Math.sqrt(L));
  const w2 = w1 * 1.37;
  const p1 = seedK * 1.7;
  const p2 = seedK * 2.9;
  out.heave = sea * (0.16 + 0.08 * size) * (0.6 * Math.sin(w1 * t + p1) + 0.4 * Math.sin(w2 * t + p2));
  out.pitch = sea * 2.2 * size * (0.6 * Math.sin(w1 * t + p1 + 1.2) + 0.4 * Math.sin(w2 * 1.1 * t + p2 + 0.4));
  out.roll = sea * 3.0 * size * (0.55 * Math.sin(w1 * 0.8 * t + p2) + 0.45 * Math.sin(w2 * 0.9 * t + p1 + 2));
}
const _motion = { heave: 0, pitch: 0, roll: 0 };

export function vesselPose(r: SeaRoute, t: number, windFromDeg: number, windKt: number, out: VesselPose): VesselPose {
  const st = routeState(r, t);
  samplePath(r.path, st.s, _ps);
  const L = VESSEL_DIMS[r.kind].length * r.scale;
  out.x = _ps.x;
  out.z = _ps.z;
  out.speed = st.v;
  out.travelled = st.travelled;
  out.curvature = _ps.curvature * st.dir;
  const course = st.dir > 0 ? _ps.heading : (_ps.heading + 180) % 360;
  out.course = course;
  out.heading = r.mode === 'ferry' ? _ps.heading : course;
  const idHash = r.variant * 7.13 + r.id.length;
  seaMotion(idHash, L, r.sea, t, _motion);
  out.y = r.level + _motion.heave;
  out.pitch = _motion.pitch;
  out.roll = _motion.roll;
  out.boom = 0;
  out.tack = 1;
  const vkt = st.v / KT;
  if (r.kind === 'sail') {
    const rel = relWind(windFromDeg, course);
    const abs = Math.abs(rel);
    const gust = 1 + 0.18 * Math.sin(0.43 * t + idHash) + 0.1 * Math.sin(1.31 * t + 2 * idHash);
    const wf = clamp(windKt / 13, 0.3, 1.6);
    out.tack = rel >= 0 ? 1 : -1;
    out.roll += -out.tack * lerpTable(HEEL, abs) * wf * gust;
    out.boom = -out.tack * lerpTable(BOOM, abs);
  } else if (r.kind === 'motor' || r.kind === 'launch') {
    // planing: bow-up trim peaking near hump speed, and banking into turns
    out.pitch += 4.2 * smooth(6, 14, vkt) - 1.2 * smooth(18, 30, vkt);
    out.roll += clamp((Math.atan((st.v * st.v * out.curvature) / 9.81) * 180) / Math.PI * 0.45, -14, 14);
  } else if (r.kind === 'fish') {
    out.pitch += 1.2 * smooth(5, 10, vkt);
  }
  return out;
}

/** Pose of a moored boat (bobbing gently in the sheltered basin). */
export function mooredPose(b: Berth, i: number, t: number, level: number, out: VesselPose): VesselPose {
  const L = VESSEL_DIMS[b.kind].length * b.scale;
  seaMotion(i * 3.31 + b.variant, L, 0.28, t, _motion);
  out.x = b.x;
  out.z = b.z;
  out.y = level + _motion.heave;
  out.heading = b.heading;
  out.course = b.heading;
  out.speed = 0;
  out.travelled = 0;
  out.pitch = _motion.pitch;
  out.roll = _motion.roll;
  out.boom = 0;
  out.tack = 1;
  out.curvature = 0;
  return out;
}

/** Track only (position, course, speed, distance travelled) — cheap, for wake sampling. */
export function vesselTrack(r: SeaRoute, t: number, out: { x: number; z: number; course: number; speed: number; travelled: number }): void {
  const st = routeState(r, t);
  samplePath(r.path, st.s, _ps);
  out.x = _ps.x;
  out.z = _ps.z;
  out.course = st.dir > 0 ? _ps.heading : (_ps.heading + 180) % 360;
  out.speed = st.v;
  out.travelled = st.travelled;
}

/** Wake parameters per vessel kind: max age (s), full-strength speed (m/s), Kelvin arm strength. */
export const WAKE_KIND: Record<VesselKind, { maxAge: number; fullSpeed: number; kelvin: number; spray: boolean }> = {
  sail: { maxAge: 30, fullSpeed: 3.6, kelvin: 0.45, spray: false },
  motor: { maxAge: 55, fullSpeed: 10, kelvin: 0.9, spray: true },
  fish: { maxAge: 55, fullSpeed: 4.5, kelvin: 0.7, spray: false },
  launch: { maxAge: 38, fullSpeed: 8, kelvin: 0.85, spray: true },
  ferry: { maxAge: 95, fullSpeed: 6, kelvin: 0.85, spray: false },
  container: { maxAge: 150, fullSpeed: 8, kelvin: 0.7, spray: false },
  tanker: { maxAge: 150, fullSpeed: 6, kelvin: 0.6, spray: false },
};
