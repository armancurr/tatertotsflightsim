/**
 * PURE naval gunnery maths (no three.js): the turret geometry, the shell's exterior ballistics, a
 * range table and the fire-control solution for a ship's main battery (the USS Iowa's 16-inch/50
 * guns, `IOWA_WEAPONS.naval`). Game-level artillery: unguided shells, a gun elevation and train that
 * put a ballistic shell on a point — nothing more.
 *
 * FRAMES (as everywhere): world +X east, +Y up, +Z south; the ship's BODY frame is three.js object
 * space: +X starboard, +Y up, −Z the bow. Quaternions rotate body → world.
 *
 * TURRET SIGN CONVENTIONS (the contract with the ship's 3D model, see NavalTurretConfig):
 *   trainDeg   0 = the guns point at the bow (body −Z); + = toward starboard (+X), i.e. clockwise
 *              seen from above. The turret turns by rotateY(−train) about body +Y.
 *   elevDeg    0 = level with the deck; + = muzzles up. The barrels pitch by rotateX(+elev) about the
 *              trunnion axis (turret +X).
 *   gun k      0 … n−1 from PORT to starboard in the turret's own frame (lateral offset
 *              (k − (n−1)/2) · barrelSpacing along turret +X).
 *   muzzle     = turretPos + Ry(−train) · ( (lateral, trunnionHeight, −trunnionForward)
 *                                            + Rx(elev) · (0, 0, −barrelLength) )
 *   bore dir   = Ry(−train) · Rx(elev) · (0, 0, −1) = (sin T cos E, sin E, −cos T cos E)
 *
 * BALLISTICS: a = g − k·(ρ(y)/ρ₀)·|v|·v (k = NavalGunsConfig.dragK, ISA density), integrated with
 * classic RK4 on the full state (the density sampled at every stage's height), so the live shells
 * (frame-sized steps) and the fire control (0.25 s steps) fly the same trajectory to a few metres.
 *
 * FIRE CONTROL (`solveFireControl`): the low-angle solution. The elevation for a horizontal range is
 * found by a safeguarded secant on the range function (warm-started from a range table); the ship's
 * own velocity (the shell inherits it) and a moving target (lead by the time of flight) are folded
 * in by re-aiming at the miss until the simulated shell lands on the point. The caller turns the
 * world bore direction into deck angles with `deckAngles` (the ship's roll and pitch are thereby
 * accounted for: the turrets see where "level" is at this instant).
 */
import { CONFIG, IOWA_WEAPONS, type NavalGunsConfig, type NavalTurretConfig, type WeaponsConfig } from '../config';
import type { Quat, Vec3 } from '../types';
import { airDensity } from '../physics/atmosphere';

const DEG = Math.PI / 180;
const RHO0 = CONFIG.sim.seaLevelDensity;
const G = CONFIG.sim.gravity;
const fin = (v: number, d = 0) => (Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// ─── Which vessels carry naval guns ──────────────────────────────────────────

/**
 * The naval battery a vehicle carries: `config.weapons.naval`, or — dev harness until a ship with
 * turrets is in the fleet — the Iowa's battery on any vessel when the page URL has `?naval=iowa`.
 */
export function navalGunsOf(def: { kind?: string; config?: { weapons?: WeaponsConfig | null } } | null | undefined, search?: string): NavalGunsConfig | null {
  const own = def?.config?.weapons?.naval;
  if (own) return own;
  if (def?.kind !== 'vessel') return null;
  let q = search;
  if (q === undefined) {
    try {
      q = typeof location !== 'undefined' ? location.search : '';
    } catch {
      q = '';
    }
  }
  try {
    return new URLSearchParams(q).get('naval') === 'iowa' ? IOWA_WEAPONS.naval ?? null : null;
  } catch {
    return null;
  }
}

// ─── Turret geometry (body frame) ────────────────────────────────────────────

/** Unit bore direction in the ship's body frame for a train / elevation (deg). */
export function gunDirection(trainDeg: number, elevDeg: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const t = fin(trainDeg) * DEG;
  const e = fin(elevDeg) * DEG;
  const ce = Math.cos(e);
  out.x = Math.sin(t) * ce;
  out.y = Math.sin(e);
  out.z = -Math.cos(t) * ce;
  return out;
}

/** Lateral offset (turret +X) of gun k of n, m. */
export const gunLateral = (t: NavalTurretConfig, k: number): number => (k - (t.barrels - 1) / 2) * t.barrelSpacing;

/** Muzzle of gun `k` in the ship's body frame (see the header for the formula). */
export function muzzlePosition(t: NavalTurretConfig, trainDeg: number, elevDeg: number, k: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const tr = fin(trainDeg) * DEG;
  const e = fin(elevDeg) * DEG;
  // turret frame: trunnion + lateral + Rx(elev)·(0,0,−L)
  const lx = gunLateral(t, k);
  const ly = t.trunnionHeight + t.barrelLength * Math.sin(e);
  const lz = -t.trunnionForward - t.barrelLength * Math.cos(e);
  // Ry(−train): x' = x cos(−T) + z sin(−T) = x cos T − z sin T ; z' = −x sin(−T) + z cos(−T) = x sin T + z cos T
  const c = Math.cos(tr);
  const s = Math.sin(tr);
  out.x = t.position.x + lx * c - lz * s;
  out.y = t.position.y + ly;
  out.z = t.position.z + lx * s + lz * c;
  return out;
}

/** The turret's trunnion centre (centre gun's pivot) in the body frame. */
export function trunnionPosition(t: NavalTurretConfig, trainDeg: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const tr = fin(trainDeg) * DEG;
  out.x = t.position.x + t.trunnionForward * Math.sin(tr);
  out.y = t.position.y + t.trunnionHeight;
  out.z = t.position.z - t.trunnionForward * Math.cos(tr);
  return out;
}

// ─── Training arcs ───────────────────────────────────────────────────────────

/**
 * The angle `trainDeg` (any representation) expressed inside the turret's arc [trainMinDeg,
 * trainMaxDeg] (e.g. −170 → 190 for an aft turret with the arc 30…330), or null when it is in the
 * blind sector. The arcs never span 360°, so the turret never trains through its blind sector.
 */
export function toArc(t: NavalTurretConfig, trainDeg: number): number | null {
  if (!Number.isFinite(trainDeg)) return null;
  let a = ((trainDeg % 360) + 360) % 360; // 0..360
  // shift into [min, min + 360)
  a += Math.ceil((t.trainMinDeg - a) / 360) * 360;
  return a <= t.trainMaxDeg + 1e-9 ? a : null;
}

/** The arc limit nearest (angularly) to a blind-sector bearing. */
export function nearestArcLimit(t: NavalTurretConfig, trainDeg: number): number {
  const d = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);
  return d(trainDeg, t.trainMinDeg) <= d(trainDeg, t.trainMaxDeg) ? t.trainMinDeg : t.trainMaxDeg;
}

// ─── Frames ──────────────────────────────────────────────────────────────────

/** Rotate v by unit quaternion q (body → world). No allocation (out may alias v). */
export function rotateByQuat(q: Quat, vx: number, vy: number, vz: number, out: Vec3): Vec3 {
  const qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out.x = vx + qw * tx + (qy * tz - qz * ty);
  out.y = vy + qw * ty + (qz * tx - qx * tz);
  out.z = vz + qw * tz + (qx * ty - qy * tx);
  return out;
}

/** Rotate v by the inverse of q (world → body). */
export function rotateByQuatInv(q: Quat, vx: number, vy: number, vz: number, out: Vec3): Vec3 {
  return rotateByQuat({ x: -q.x, y: -q.y, z: -q.z, w: q.w }, vx, vy, vz, out);
}

/** Deck angles (train, elevation, deg) of a world direction on a ship with orientation q. */
export function deckAngles(q: Quat, dir: Vec3, out: { trainDeg: number; elevDeg: number } = { trainDeg: 0, elevDeg: 0 }): { trainDeg: number; elevDeg: number } {
  const b = rotateByQuatInv(q, dir.x, dir.y, dir.z, { x: 0, y: 0, z: 0 });
  const n = Math.hypot(b.x, b.y, b.z) || 1;
  out.elevDeg = Math.asin(clamp(b.y / n, -1, 1)) / DEG;
  out.trainDeg = Math.atan2(b.x, -b.z) / DEG;
  return out;
}

/** World direction of a bore at (train, elev) on a ship with orientation q. */
export function worldBore(q: Quat, trainDeg: number, elevDeg: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const d = gunDirection(trainDeg, elevDeg, out);
  return rotateByQuat(q, d.x, d.y, d.z, out);
}

// ─── Exterior ballistics ─────────────────────────────────────────────────────

export interface ShellState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
}

export const newShellState = (): ShellState => ({ x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0 });

/** ρ/ρ₀ at a height (ISA). */
export const shellDensityRatio = (y: number): number => airDensity(y) / RHO0;

/** Longest single RK4 step, s (longer requests are split). */
export const SHELL_MAX_STEP = 0.25;

/**
 * Advance a shell by dt (split into ≤ 0.25 s classic RK4 steps on position + velocity, density at
 * each stage's height). Non-finite inputs are treated as 0: a bad frame never poisons the state.
 */
export function stepShell(s: ShellState, dtIn: number, dragKIn: number, g: number = G): void {
  let dt = Number.isFinite(dtIn) && dtIn > 0 ? Math.min(dtIn, 30) : 0;
  const k = Number.isFinite(dragKIn) && dragKIn > 0 ? dragKIn : 0;
  const gg = Number.isFinite(g) ? g : 0;
  while (dt > 1e-12) {
    const h = dt > SHELL_MAX_STEP ? SHELL_MAX_STEP : dt;
    dt -= h;
    const x = s.x, y = s.y, z = s.z, vx = s.vx, vy = s.vy, vz = s.vz;
    // k1
    let kd = k * shellDensityRatio(y);
    let sp = kd * Math.sqrt(vx * vx + vy * vy + vz * vz);
    const a1x = -sp * vx, a1y = -gg - sp * vy, a1z = -sp * vz;
    // k2
    const v2x = vx + 0.5 * h * a1x, v2y = vy + 0.5 * h * a1y, v2z = vz + 0.5 * h * a1z;
    kd = k * shellDensityRatio(y + 0.5 * h * vy);
    sp = kd * Math.sqrt(v2x * v2x + v2y * v2y + v2z * v2z);
    const a2x = -sp * v2x, a2y = -gg - sp * v2y, a2z = -sp * v2z;
    // k3
    const v3x = vx + 0.5 * h * a2x, v3y = vy + 0.5 * h * a2y, v3z = vz + 0.5 * h * a2z;
    kd = k * shellDensityRatio(y + 0.5 * h * v2y);
    sp = kd * Math.sqrt(v3x * v3x + v3y * v3y + v3z * v3z);
    const a3x = -sp * v3x, a3y = -gg - sp * v3y, a3z = -sp * v3z;
    // k4
    const v4x = vx + h * a3x, v4y = vy + h * a3y, v4z = vz + h * a3z;
    kd = k * shellDensityRatio(y + h * v3y);
    sp = kd * Math.sqrt(v4x * v4x + v4y * v4y + v4z * v4z);
    const a4x = -sp * v4x, a4y = -gg - sp * v4y, a4z = -sp * v4z;

    s.x = x + (h / 6) * (vx + 2 * v2x + 2 * v3x + v4x);
    s.y = y + (h / 6) * (vy + 2 * v2y + 2 * v3y + v4y);
    s.z = z + (h / 6) * (vz + 2 * v2z + 2 * v3z + v4z);
    s.vx = vx + (h / 6) * (a1x + 2 * a2x + 2 * a3x + a4x);
    s.vy = vy + (h / 6) * (a1y + 2 * a2y + 2 * a3y + a4y);
    s.vz = vz + (h / 6) * (a1z + 2 * a2z + 2 * a3z + a4z);
  }
}

export interface ShellFlight {
  /** Reached the height on the way down. */
  landed: boolean;
  /** Time of flight to the crossing (or maxT), s. */
  tof: number;
  x: number;
  y: number;
  z: number;
  /** Velocity at the crossing, m/s. */
  vx: number;
  vy: number;
  vz: number;
  /** Highest point, m. */
  apex: number;
}

export const newShellFlight = (): ShellFlight => ({ landed: false, tof: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, apex: 0 });

/**
 * Fly a shell (the state is advanced in place) until it comes DOWN through height `yStop`, stepping
 * `h` s; the crossing is interpolated linearly within the last step. Stops at maxT.
 */
export function flyToHeight(s: ShellState, dragK: number, yStop: number, maxT: number, out: ShellFlight = newShellFlight(), h = SHELL_MAX_STEP): ShellFlight {
  let t = 0;
  let apex = s.y;
  out.landed = false;
  const step = Number.isFinite(h) && h > 0 ? h : SHELL_MAX_STEP;
  const T = Number.isFinite(maxT) && maxT > 0 ? Math.min(maxT, 600) : 120;
  if (s.y <= yStop && s.vy <= 0) {
    Object.assign(out, { landed: true, tof: 0, x: s.x, y: s.y, z: s.z, vx: s.vx, vy: s.vy, vz: s.vz, apex });
    return out;
  }
  while (t < T) {
    const px = s.x, py = s.y, pz = s.z, pvx = s.vx, pvy = s.vy, pvz = s.vz;
    stepShell(s, step, dragK);
    t += step;
    if (s.y > apex) apex = s.y;
    if (s.vy < 0 && s.y <= yStop) {
      const f = py - s.y > 1e-9 ? clamp((py - yStop) / (py - s.y), 0, 1) : 1;
      out.landed = true;
      out.tof = t - step + f * step;
      out.x = px + (s.x - px) * f;
      out.y = yStop;
      out.z = pz + (s.z - pz) * f;
      out.vx = pvx + (s.vx - pvx) * f;
      out.vy = pvy + (s.vy - pvy) * f;
      out.vz = pvz + (s.vz - pvz) * f;
      out.apex = apex;
      return out;
    }
    if (!Number.isFinite(s.x + s.y + s.z)) break;
  }
  out.tof = t;
  out.x = s.x;
  out.y = s.y;
  out.z = s.z;
  out.vx = s.vx;
  out.vy = s.vy;
  out.vz = s.vz;
  out.apex = apex;
  return out;
}

// ─── Range table ─────────────────────────────────────────────────────────────

export interface RangeTable {
  v0: number;
  dragK: number;
  maxFlightS: number;
  elevMinDeg: number;
  elevMaxDeg: number;
  stepDeg: number;
  /** Per elevation step from elevMinDeg: horizontal range (m) and time of flight (s) to the muzzle's height. */
  elev: Float64Array;
  range: Float64Array;
  tof: Float64Array;
  /** Longest range within the elevation limits and the elevation that gives it. */
  maxRangeM: number;
  maxRangeElevDeg: number;
}

const tables = new WeakMap<NavalGunsConfig, RangeTable>();

/**
 * The battery's range table (range and time of flight vs elevation, fired level from sea level and
 * landing back at it). Cached per config object; ~100 flights, a few ms.
 */
export function rangeTable(guns: NavalGunsConfig, stepDeg = 0.5): RangeTable {
  const hit = tables.get(guns);
  if (hit && hit.stepDeg === stepDeg) return hit;
  const lo = Math.min(guns.turrets.reduce((m, t) => Math.min(m, t.elevMinDeg), Infinity), 0);
  const hi = Math.max(...guns.turrets.map((t) => t.elevMaxDeg), 1);
  const lo0 = Math.max(0.25, lo); // below ~0 the shell lands at once
  const n = Math.max(2, Math.ceil((hi - lo0) / stepDeg) + 1);
  const elev = new Float64Array(n);
  const range = new Float64Array(n);
  const tof = new Float64Array(n);
  const s = newShellState();
  const f = newShellFlight();
  let best = 0;
  let bestE = hi;
  for (let i = 0; i < n; i++) {
    const e = Math.min(hi, lo0 + i * stepDeg);
    elev[i] = e;
    s.x = s.y = s.z = 0;
    s.vx = guns.muzzleVelocity * Math.cos(e * DEG);
    s.vy = guns.muzzleVelocity * Math.sin(e * DEG);
    s.vz = 0;
    flyToHeight(s, guns.dragK, 0, Math.max(guns.maxFlightS, 200), f);
    range[i] = f.landed ? f.x : 0;
    tof[i] = f.tof;
    if (range[i] > best) {
      best = range[i];
      bestE = e;
    }
  }
  const table: RangeTable = {
    v0: guns.muzzleVelocity, dragK: guns.dragK, maxFlightS: guns.maxFlightS, elevMinDeg: lo0, elevMaxDeg: hi, stepDeg,
    elev, range, tof, maxRangeM: best, maxRangeElevDeg: bestE,
  };
  tables.set(guns, table);
  return table;
}

/** Table lookup: elevation (deg) for a range on the rising branch, linear interpolation. */
export function tableElevation(t: RangeTable, rangeM: number): number {
  const r = fin(rangeM);
  if (r <= t.range[0]) return t.elev[0] * Math.max(0, r) / Math.max(1, t.range[0]);
  for (let i = 1; i < t.elev.length; i++) {
    if (t.elev[i] > t.maxRangeElevDeg + 1e-9) break;
    if (r <= t.range[i]) {
      const f = (r - t.range[i - 1]) / Math.max(1e-9, t.range[i] - t.range[i - 1]);
      return t.elev[i - 1] + f * (t.elev[i] - t.elev[i - 1]);
    }
  }
  return t.maxRangeElevDeg;
}

/** Table lookup: time of flight (s) and range slope dR/dElev (m per deg) at an elevation. */
export function tableAt(t: RangeTable, elevDeg: number, out: { tofS: number; rangeM: number; dRdElev: number } = { tofS: 0, rangeM: 0, dRdElev: 0 }): { tofS: number; rangeM: number; dRdElev: number } {
  const n = t.elev.length;
  const u = clamp((fin(elevDeg) - t.elev[0]) / t.stepDeg, 0, n - 1.000001);
  const i = Math.floor(u);
  const f = u - i;
  out.tofS = t.tof[i] + f * (t.tof[i + 1] - t.tof[i]);
  out.rangeM = t.range[i] + f * (t.range[i + 1] - t.range[i]);
  out.dRdElev = (t.range[i + 1] - t.range[i]) / t.stepDeg;
  return out;
}

// ─── Elevation for a range (vertical plane) ──────────────────────────────────

export interface ElevationSolution {
  ok: boolean;
  /** Beyond the guns' reach (elev = the max-range elevation) / closer than the lowest elevation reaches. */
  tooFar: boolean;
  tooClose: boolean;
  elevDeg: number;
  tofS: number;
  /** Range the returned elevation actually reaches, m. */
  rangeM: number;
  /** Shells simulated. */
  flights: number;
}

const S2 = newShellState();
const F2 = newShellFlight();

/** Horizontal range (m) and time of flight at elevation e (deg) to a point dh m above the muzzle. */
function rangeFor(v0: number, dragK: number, e: number, dh: number, maxT: number, out: { r: number; t: number }): void {
  S2.x = S2.y = S2.z = 0;
  S2.vx = v0 * Math.cos(e * DEG);
  S2.vy = v0 * Math.sin(e * DEG);
  S2.vz = 0;
  flyToHeight(S2, dragK, dh, maxT, F2);
  out.r = F2.landed ? F2.x : -1; // never came down to that height: "short"
  out.t = F2.tof;
}

/**
 * The low-angle elevation (deg, above the horizon) that carries a shell `rangeM` horizontally to a
 * point `dh` m above the muzzle, within [elevMinDeg, min(elevMaxDeg, the max-range elevation)].
 * Safeguarded secant (regula falsi, Illinois), warm-started from `guessDeg` or the range table.
 */
export function solveElevation(
  guns: NavalGunsConfig, rangeM: number, dh: number, elevMinDeg: number, elevMaxDeg: number,
  guessDeg?: number, out: ElevationSolution = { ok: false, tooFar: false, tooClose: false, elevDeg: 0, tofS: 0, rangeM: 0, flights: 0 },
): ElevationSolution {
  const table = rangeTable(guns);
  const v0 = guns.muzzleVelocity;
  const k = guns.dragK;
  const maxT = Math.max(guns.maxFlightS, 30) * 1.5;
  const D = Math.max(0, fin(rangeM));
  const h = clamp(fin(dh), -5000, 5000);
  const lo0 = fin(elevMinDeg, -2);
  const hi0 = Math.min(fin(elevMaxDeg, 45), table.maxRangeElevDeg + 0.5);
  out.flights = 0;
  out.ok = false;
  out.tooFar = false;
  out.tooClose = false;
  const r = { r: 0, t: 0 };
  const f = (e: number) => {
    rangeFor(v0, k, e, h, maxT, r);
    out.flights++;
    return r.r - D;
  };
  // Upper end: can it reach at all?
  let fb = f(hi0);
  let tb = r.t;
  if (fb < 0) {
    out.tooFar = true;
    out.elevDeg = hi0;
    out.tofS = tb;
    out.rangeM = Math.max(0, r.r);
    return out;
  }
  // First guess (warm start or the table, corrected for the height difference ~ atan(dh / D)).
  let g = Number.isFinite(guessDeg) ? (guessDeg as number) : tableElevation(table, D) + (D > 1 ? Math.atan2(h, D) / DEG : 0);
  g = clamp(g, lo0, hi0);
  let a = g;
  let fa = f(a);
  let ta = r.t;
  if (Math.abs(fa) < 0.5) return done(a, ta, fa + D);
  // Bracket: step from the guess toward the root with a growing step.
  let b = hi0;
  if (fa > 0) {
    // too long: go lower
    let step = 0.25;
    let x = a;
    let fx = fa;
    let tx = ta;
    for (;;) {
      const nx = Math.max(lo0, x - step);
      const fn = f(nx);
      const tn = r.t;
      if (fn <= 0) {
        a = nx; fa = fn; ta = tn;
        b = x; fb = fx; tb = tx;
        break;
      }
      x = nx; fx = fn; tx = tn;
      if (nx <= lo0) {
        out.tooClose = true;
        out.elevDeg = lo0;
        out.tofS = tn;
        out.rangeM = Math.max(0, fn + D);
        return out;
      }
      step *= 2;
    }
  } else {
    let step = 0.25;
    let x = a;
    let fx = fa;
    let tx = ta;
    for (;;) {
      const nx = Math.min(hi0, x + step);
      const fn = nx >= hi0 ? fb : f(nx);
      const tn = nx >= hi0 ? tb : r.t;
      if (fn >= 0) {
        a = x; fa = fx; ta = tx;
        b = nx; fb = fn; tb = tn;
        break;
      }
      x = nx; fx = fn; tx = tn;
      step *= 2;
    }
  }
  // Regula falsi (Illinois) inside [a (short, f ≤ 0), b (long, f ≥ 0)].
  let side = 0;
  for (let it = 0; it < 30; it++) {
    const c = fb - fa > 1e-9 ? a - (fa * (b - a)) / (fb - fa) : 0.5 * (a + b);
    const fc = f(c);
    const tc = r.t;
    if (Math.abs(fc) < 0.5 || b - a < 1e-6) return done(c, tc, fc + D);
    if (fc < 0) {
      a = c; fa = fc; ta = tc;
      if (side === -1) fb *= 0.5;
      side = -1;
    } else {
      b = c; fb = fc; tb = tc;
      if (side === 1) fa *= 0.5;
      side = 1;
    }
  }
  const e = 0.5 * (a + b);
  const fe = f(e);
  return done(e, r.t, fe + D);

  function done(e: number, t: number, reached: number): ElevationSolution {
    out.ok = true;
    out.elevDeg = e;
    out.tofS = t;
    out.rangeM = reached;
    return out;
  }
}

// ─── The fire-control solution ───────────────────────────────────────────────

export interface FireSolution {
  /** The shell lands on the point (within ~1 m). */
  ok: boolean;
  tooFar: boolean;
  tooClose: boolean;
  /** Bore direction to fire along (world, unit), its bearing (deg clockwise from north) and elevation above the horizon (deg). */
  dir: Vec3;
  bearingDeg: number;
  elevDeg: number;
  /** Time of flight, s; horizontal range muzzle → point, m. */
  tofS: number;
  rangeM: number;
  /** Where the simulated shell lands (world) and where the target is then. */
  impact: Vec3;
  targetAtImpact: Vec3;
  /** Range change per degree of elevation at this solution, m/deg (for the on-target test). */
  dRdElev: number;
  /** Shells simulated for this solution. */
  flights: number;
}

export function newFireSolution(): FireSolution {
  return {
    ok: false, tooFar: false, tooClose: false, dir: { x: 0, y: 0, z: -1 }, bearingDeg: 0, elevDeg: 0, tofS: 0, rangeM: 0,
    impact: { x: 0, y: 0, z: 0 }, targetAtImpact: { x: 0, y: 0, z: 0 }, dRdElev: 0, flights: 0,
  };
}

export interface FireControlInput {
  /** Muzzle, world. */
  muzzle: Vec3;
  /** The ship's velocity (the shell inherits it), world m/s. */
  shipVelocity: Vec3;
  /** Point to hit, world (the sea: y = sea level). */
  target: Vec3;
  /** The target's velocity (lead by the time of flight), world m/s; null = stationary. */
  targetVelocity?: Vec3 | null;
  elevMinDeg: number;
  elevMaxDeg: number;
  /** Warm start: the last solution's elevation (deg) for this turret. */
  guessElevDeg?: number;
}

const ES: ElevationSolution = { ok: false, tooFar: false, tooClose: false, elevDeg: 0, tofS: 0, rangeM: 0, flights: 0 };
const S3 = newShellState();
const F3 = newShellFlight();
const TA = { tofS: 0, rangeM: 0, dRdElev: 0 };

/**
 * Bearing and elevation that land a shell from `muzzle` on `target` (low angle), with the ship's
 * velocity and the target's motion folded in (≤ 6 re-aims). Fills and returns `out`.
 */
export function solveFireControl(guns: NavalGunsConfig, input: FireControlInput, out: FireSolution = newFireSolution()): FireSolution {
  const m = input.muzzle;
  const vs = input.shipVelocity;
  const tv = input.targetVelocity ?? null;
  const T = input.target;
  const v0 = guns.muzzleVelocity;
  const maxT = Math.max(guns.maxFlightS, 30) * 1.5;
  out.flights = 0;
  out.ok = false;
  out.tooFar = false;
  out.tooClose = false;
  if (!Number.isFinite(m.x + m.y + m.z + T.x + T.y + T.z)) return out;
  const svx = fin(vs.x), svy = fin(vs.y), svz = fin(vs.z);
  const tvx = tv ? fin(tv.x) : 0, tvy = tv ? fin(tv.y) : 0, tvz = tv ? fin(tv.z) : 0;
  // aim point (moves with the corrections) and the target's position at the impact time
  let ax = T.x, az = T.z;
  let tof = 0;
  let guess = input.guessElevDeg;
  let bestMiss = Infinity;
  for (let it = 0; it < 6; it++) {
    const px = T.x + tvx * tof, py = T.y + tvy * tof, pz = T.z + tvz * tof;
    if (it === 0) {
      ax = px;
      az = pz;
    }
    const dx = ax - m.x;
    const dz = az - m.z;
    const D = Math.hypot(dx, dz);
    solveElevation(guns, D, py - m.y, input.elevMinDeg, input.elevMaxDeg, guess, ES);
    out.flights += ES.flights;
    guess = ES.elevDeg;
    const bearing = Math.atan2(dx, -dz);
    const e = ES.elevDeg * DEG;
    const ce = Math.cos(e);
    out.dir.x = Math.sin(bearing) * ce;
    out.dir.y = Math.sin(e);
    out.dir.z = -Math.cos(bearing) * ce;
    out.bearingDeg = ((bearing / DEG) % 360 + 360) % 360;
    out.elevDeg = ES.elevDeg;
    out.rangeM = Math.hypot(px - m.x, pz - m.z);
    out.tooFar = ES.tooFar;
    out.tooClose = ES.tooClose;
    // fly the real shell (ship's velocity added)
    S3.x = m.x; S3.y = m.y; S3.z = m.z;
    S3.vx = out.dir.x * v0 + svx;
    S3.vy = out.dir.y * v0 + svy;
    S3.vz = out.dir.z * v0 + svz;
    flyToHeight(S3, guns.dragK, py, maxT, F3);
    out.flights++;
    tof = F3.tof;
    out.tofS = tof;
    out.impact.x = F3.x; out.impact.y = F3.y; out.impact.z = F3.z;
    const qx = T.x + tvx * tof, qy = T.y + tvy * tof, qz = T.z + tvz * tof;
    out.targetAtImpact.x = qx; out.targetAtImpact.y = qy; out.targetAtImpact.z = qz;
    if (!F3.landed || ES.tooFar || ES.tooClose) break;
    const mx = qx - F3.x;
    const mz = qz - F3.z;
    const miss = Math.hypot(mx, mz);
    if (miss < 1) {
      out.ok = true;
      break;
    }
    if (miss > bestMiss * 1.5 && it > 2) break; // diverging (should not happen): give up
    bestMiss = Math.min(bestMiss, miss);
    ax += mx;
    az += mz;
  }
  if (!out.ok && Number.isFinite(bestMiss) && bestMiss < 5 && !out.tooFar && !out.tooClose) out.ok = true;
  out.dRdElev = tableAt(rangeTable(guns), out.elevDeg, TA).dRdElev;
  return out;
}

/**
 * The predicted miss at the aim point of a bore pointing along `bore` (world unit) instead of the
 * solution's `sol.dir`, in metres: `along` the line of fire (the elevation error × dR/dElev; + = long)
 * and `across` it (the bearing error × range; + = right).
 */
export function missComponents(sol: FireSolution, bore: Vec3, out: { along: number; across: number } = { along: 0, across: 0 }): { along: number; across: number } {
  const eCur = Math.asin(clamp(bore.y, -1, 1)) / DEG;
  const bCur = Math.atan2(bore.x, -bore.z) / DEG;
  const dE = eCur - sol.elevDeg;
  const dB = ((bCur - sol.bearingDeg + 540) % 360) - 180;
  out.along = dE * Math.max(Math.abs(sol.dRdElev), 1);
  out.across = dB * DEG * Math.max(sol.rangeM, 1);
  return out;
}

const MC = { along: 0, across: 0 };

/** Predicted miss (m) at the aim point: |missComponents|. */
export function predictedMissM(sol: FireSolution, bore: Vec3): number {
  missComponents(sol, bore, MC);
  const m = Math.hypot(MC.along, MC.across);
  return Number.isFinite(m) ? m : Infinity;
}
