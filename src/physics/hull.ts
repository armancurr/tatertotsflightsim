/**
 * Boats and ships (PURE, deterministic): the hull, its engines and propulsors, for any vessel whose
 * config sets `watercraft` — step() in ./aircraft.ts hands such a config to stepVessel() the way it
 * hands a helicopter to ./rotor.ts. One model for every size, from a sports yacht to a battleship:
 * everything below scales from the station table and a handful of coefficients.
 *
 * ─── The model ────────────────────────────────────────────────────────────────────────────────
 * Hydrostatics. The hull (config `hull.stations`, the same table the 3D model lofts) is resampled
 *   into a grid of vertical columns. Each column is a prism from the hull bottom to the deck edge;
 *   the part below the local water surface displaces water: ρ g V, applied at the centroid of the
 *   wet part. The surface is the SAME Gerstner sea the renderer draws (src/world/water/waves.ts,
 *   with the shader's shoaling in shallow water), sampled on a coarse grid over the hull at the
 *   vessel's wave clock (`vessel.seaTime`) and interpolated per column — so heave, pitch, roll,
 *   the righting moment and riding the waves all come from the shape, not from tuned springs.
 * Vertical damping. Each wet column feels linear (radiation) + quadratic (viscous) damping on its
 *   vertical speed relative to the moving surface (the waves' orbital heave), plus extra roll damping.
 * Planing lift (Savitsky 1964, dynamic term). C_L0 = τ^1.1 · 0.012 λ^½ (τ trim in degrees, λ mean
 *   wetted length / beam from the wet columns), corrected for deadrise β: C_Lβ = C_L0 − 0.0065 β
 *   C_L0^0.6; L = ½ ρ V² B² C_Lβ, acting normal to the bottom at Savitsky's centre of pressure. The
 *   hydrostatic half of Savitsky's lift is the column buoyancy itself. Because the lift is normal to
 *   the keel, its aft tilt is the pressure drag Δ tan τ, and the hull rising out of the water shrinks
 *   the wetted area — the planing transition emerges.
 * Resistance. ITTC-57 friction on the live wetted surface, × form factor; residuary (wave-making)
 *   resistance from a Cr(Fn) table on the static wetted surface (Holtrop-style shape: rising to the
 *   hump, falling as the hull planes); windage on the superstructure.
 * The hull's own wave. A Kelvin transverse wave (λ = 2πU²/g, crest at the bow, less its mean over
 *   the waterline: it moves the pressure, it adds no displacement) is added to the surface the columns float in: near Fn 0.5 its trough lies under the stern, which settles while
 *   the bow rises — the hump trim of a planing hull and the sinkage and trim of a ship at speed.
 * Manoeuvring. Clarke's (1982) linear derivatives Y_v, Y_r, N_v, N_r from the live wetted length,
 *   draft, beam and block coefficient (the regression Fossen recommends), plus strip cross-flow drag
 *   (nonlinear sway / yaw damping), plus added mass per axis scaled by the immersion.
 * Propulsion. Each propulsor has its own marine diesel (governor, torque rise, turbo lag) driving a
 *   propeller with linear open-water curves KT(J), KQ(J); the shaft speed comes from the torque
 *   balance, so the engines lug at the hump and in a crash stop. Pods (Volvo IPS, azipods) turn the
 *   whole thrust line; shaft drives have a rudder in the propeller's slipstream. Either way the leg /
 *   rudder is also a foil with lift and stall. Trim tabs add stern lift (bow down).
 * Contacts. Points round the hull (keel, chines, deck edge, pods) are held out of the sea bed, the
 *   shore (env.groundHeight) and structures (env.obstacleTop: marina pontoons, quays) by spring-
 *   dampers with friction; hitting hard holes the hull (crash). Lying on the beam too long capsizes.
 * Mooring. At the berth, lines hold the boat until the lever first goes into gear.
 *
 * Frames and signs follow src/types.ts: body +X starboard, +Y up, −Z bow; steerDeg + turns the bow
 * to starboard. Controls: throttle = the helm lever (−1 full astern … +1 full ahead, neutral inside
 * ±neutralDetent), rudder + aileron = the helm, elevatorTrim < 0 = trim tabs down, engineOn = E.
 *
 * ─── Calibration: Princess V50 (14.2 t half load, 2 × Volvo Penta IPS 600 / D6-435; calm sea) ───
 * Checked by tests/physics/v50.test.ts and v50-fuzz.test.ts.
 *
 *   Quantity                                   Measured                              Real / target
 *   ─────────────────────────────────────────  ────────────────────────────────────  ───────────────────
 *   Displacement / waterline length / draft   14.2 t (13.85 m³) / 13.2 m / 0.63 m hull, 1.03 m to the drives   14.2 t / — / 1.14 m
 *   Static trim, calm                          −0.07° (level)                        level
 *   Full ahead from rest: hump trim            ~6° bow up at 12–16 kt                5–7°
 *   …on the plane (> 50 % dynamic lift)        ~12 s; 25 kt in ~17 s; 30 kt in ~30 s  "on the plane in seconds"
 *   Top speed, full ahead                      34.4 kt at 3,500 rpm (rated), trim 3.7°, 87 % dynamic lift   34 kt, 3,500 rpm
 *   Cruise 30 kt                               lever ~0.9, trim ~4°                  32 kt cruise
 *   Slow ahead, lever 0.2                      ~7.5 kt at ~1,070 rpm                 6–8 kt at ~1,000 rpm
 *   Full astern from rest                      ~12 kt astern                         —
 *   Crash stop from 30 kt (full astern)        stopped in ~12 s                      —
 *   Hard over at 30 kt                         banks 9° INTO the turn, ~12 °/s, circle ~120 m, 30 → 25 kt   banks in, no capsize
 *   Hard over at 6 kt (drives 22°)             circle ~65 m, heels 1.4° outward       3–5 lengths
 *   Rights from a 30° heel                     < 3° within 25 s                      positive stability
 *   Default sea (12 kt wind), full ahead       rides it at ~33 kt, pitching a few degrees with the waves
 *   Grounding: dead slow onto a 1 : 10 beach   aground, no damage, backs off astern; at > 17 kt: holed
 *   Pontoon: at 2 kt held off it; at 20 kt     holed
 *   step() cost (node)                         ~35 µs (28 × 12 buoyancy columns, 15 wave samples, 47 contacts)
 */
import { CONFIG, MS_TO_KT, type Config, type HullStation, type PropulsorConfig, type WatercraftConfig } from '../config';
import type { AircraftState, Controls, DerivedData, EngineState, Environment, MarineGear, PropulsorState, Quat, Vec3, VesselState } from '../types';
import { clamp, moveToward, smoothstep, wrap180 } from '../math/vec3';
import { qIntegrateBody } from '../math/quat';
import { bodyToWorld, eulerFromQuat, pqrFromOmega, quatFromEuler, worldToBody } from './frames';
import { airDensity } from './atmosphere';
import { getSeaSpectrum, type WaveSpectrum } from '../world/water/waves';

const DEG = Math.PI / 180;
const TAU = 2 * Math.PI;
/** Kinematic viscosity of sea water at 15 °C, m²/s. */
const NU_WATER = 1.19e-6;
const ZERO: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 });

// ─── Hull geometry (precomputed once per config) ───────────────────────────────────────────────

/** A station interpolated at body z (linear between the table's stations; clamped at the ends). */
export function stationAt(stations: readonly HullStation[], z: number): HullStation {
  const n = stations.length;
  if (z <= stations[0].z) return { ...stations[0], z };
  if (z >= stations[n - 1].z) return { ...stations[n - 1], z };
  let i = 0;
  while (i < n - 2 && stations[i + 1].z < z) i++;
  const a = stations[i];
  const b = stations[i + 1];
  const t = (z - a.z) / Math.max(1e-9, b.z - a.z);
  const l = (p: number, q: number) => p + (q - p) * t;
  return { z, keelY: l(a.keelY, b.keelY), chineHalf: l(a.chineHalf, b.chineHalf), chineY: l(a.chineY, b.chineY), deckHalf: l(a.deckHalf, b.deckHalf), deckY: l(a.deckY, b.deckY) };
}

/** Height of the hull surface (body y) at half-breadth |x| of a station: the V bottom, then the topsides. */
export function hullBottomY(s: HullStation, x: number): number {
  const ax = Math.abs(x);
  if (ax <= s.chineHalf && s.chineHalf > 1e-6) return s.keelY + ((s.chineY - s.keelY) * ax) / s.chineHalf;
  if (s.deckHalf - s.chineHalf < 1e-6) return s.chineY;
  return s.chineY + ((s.deckY - s.chineY) * (ax - s.chineHalf)) / (s.deckHalf - s.chineHalf);
}

interface Column {
  /** Body position of the column's bottom (x, y, z) and its top (deck) height. */
  x: number;
  y: number;
  z: number;
  top: number;
  /** Plan area (m²) and wetted-surface area of its bottom panel (m², plan × slope factor). */
  area: number;
  surface: number;
  /** On the bottom (inside the chine): a planing surface. */
  bottom: boolean;
  /** Index of its long strip, and 0 = the strip's centreline-most column. */
  strip: number;
  centre: boolean;
  /** The column nearest the chine (for the chine wetted length). */
  chine: boolean;
  /** Buttock slope at the column, rad (+ = the bottom rising toward the bow: the forefoot's rocker). */
  rocker: number;
}

interface HullGeom {
  cols: Column[];
  strips: number;
  stripZ: number[];
  dz: number;
  zBow: number;
  zStern: number;
  /** Chine beam (planing beam B) and the largest beam. */
  chineBeam: number;
  maxBeam: number;
  /** Deadrise at the transom, deg. */
  deadriseDeg: number;
  /** Keel-line slope aft (rad, + = keel rising toward the stern: the bottom sits bow-down in the body frame). */
  keelSlope: number;
  /** Forward end of the static waterline (body z): where the hull's own bow wave crest stands. */
  zWlBow: number;
  /** Static waterline (body y) at rest, level; displaced volume ∇ (m³); waterline length, beam, draft, block coefficient, wetted surface. */
  waterlineY: number;
  volume: number;
  lwl: number;
  bwl: number;
  draft: number;
  cb: number;
  s0: number;
  /** Contact points (body) round the hull, and the index where the deck-edge points start. */
  contacts: Vec3[];
  /** Wave sample positions (body x, z). */
  waveX: number[];
  waveZ: number[];
}

const geomCache = new WeakMap<WatercraftConfig, Map<number, HullGeom>>();

/** The hull's column grid, contacts, static waterline and form coefficients (cached per config and mass). */
export function hullGeometry(wc: WatercraftConfig, mass: number): HullGeom {
  let byMass = geomCache.get(wc);
  if (!byMass) {
    byMass = new Map();
    geomCache.set(wc, byMass);
  }
  const hit = byMass.get(mass);
  if (hit) return hit;
  const h = wc.hull;
  const st = h.stations;
  const zBow = st[0].z;
  const zStern = st[st.length - 1].z;
  const strips = Math.max(4, Math.round(h.gridLong));
  const nt = Math.max(2, Math.round(h.gridTrans));
  const dz = (zStern - zBow) / strips;
  const cols: Column[] = [];
  const stripZ: number[] = [];
  let chineBeam = 0;
  let maxBeam = 0;
  for (const s of st) {
    chineBeam = Math.max(chineBeam, 2 * s.chineHalf);
    maxBeam = Math.max(maxBeam, 2 * s.deckHalf);
  }
  for (let i = 0; i < strips; i++) {
    const z = zBow + (i + 0.5) * dz;
    stripZ.push(z);
    const s = stationAt(st, z);
    const half = s.deckHalf;
    const dx = half / nt;
    // the column nearest the chine (still on the bottom)
    let chineJ = 0;
    for (let j = 0; j < nt; j++) if ((j + 0.5) * dx <= s.chineHalf) chineJ = j;
    for (let j = 0; j < nt; j++) {
      const x = (j + 0.5) * dx;
      const y = hullBottomY(s, x);
      const slope = (hullBottomY(s, x + 0.5 * dx) - hullBottomY(s, Math.max(0, x - 0.5 * dx))) / dx;
      const area = dx * dz;
      const surface = area * Math.sqrt(1 + slope * slope);
      const bottom = x <= s.chineHalf;
      const e = 0.25 * dz;
      const rocker = Math.atan2(hullBottomY(stationAt(st, z - e), x) - hullBottomY(stationAt(st, z + e), x), 2 * e);
      for (const side of [-1, 1]) {
        cols.push({ x: side * x, y, z, top: Math.max(s.deckY, y + 0.05), area, surface, bottom, strip: i, centre: j === 0, chine: j === chineJ, rocker });
      }
    }
  }
  const tr = st[st.length - 1];
  const deadriseDeg = tr.chineHalf > 1e-6 ? Math.atan2(tr.chineY - tr.keelY, tr.chineHalf) / DEG : 0;
  // keel slope over the aft 60 % (the planing surface)
  const zA = zBow + 0.4 * (zStern - zBow);
  const keelSlope = Math.atan2(stationAt(st, zStern).keelY - stationAt(st, zA).keelY, zStern - zA);

  // Static waterline: level hull, displaced volume = m / ρ (bisection).
  const vol = mass / wc.waterDensity;
  const volumeAt = (wl: number) => {
    let v = 0;
    for (const c of cols) v += c.area * clamp(wl - c.y, 0, c.top - c.y);
    return v;
  };
  let lo = Math.min(...cols.map((c) => c.y));
  let hi = Math.max(...cols.map((c) => c.top));
  for (let it = 0; it < 60; it++) {
    const mid = 0.5 * (lo + hi);
    if (volumeAt(mid) > vol) hi = mid;
    else lo = mid;
  }
  const waterlineY = 0.5 * (lo + hi);
  let zF = Infinity;
  let zA2 = -Infinity;
  let bwl = 0;
  let s0 = 0;
  let keelMin = Infinity;
  for (const c of cols) {
    if (c.y < waterlineY) {
      zF = Math.min(zF, c.z - dz / 2);
      zA2 = Math.max(zA2, c.z + dz / 2);
      bwl = Math.max(bwl, 2 * Math.abs(c.x) + (2 * stationAt(st, c.z).deckHalf) / nt);
      s0 += c.surface;
    }
    keelMin = Math.min(keelMin, c.y);
  }
  const lwl = Math.max(0.5, zA2 - zF);
  const draft = Math.max(0.05, waterlineY - keelMin);
  const cb = clamp(vol / (lwl * bwl * draft), 0.2, 0.95);

  // Contacts: keel, chines and deck edges at every station (and midway), the stem head, the pods.
  const contacts: Vec3[] = [];
  const zs: number[] = [];
  for (let i = 0; i < st.length; i++) {
    zs.push(st[i].z);
    if (i + 1 < st.length) zs.push(0.5 * (st[i].z + st[i + 1].z));
  }
  for (const z of zs) {
    const s = stationAt(st, z);
    contacts.push({ x: 0, y: s.keelY, z });
    if (s.chineHalf > 0.05) {
      contacts.push({ x: -s.chineHalf, y: s.chineY, z });
      contacts.push({ x: s.chineHalf, y: s.chineY, z });
    }
  }
  for (const z of zs) {
    const s = stationAt(st, z);
    if (s.deckHalf > 0.05) {
      contacts.push({ x: -s.deckHalf, y: s.deckY, z });
      contacts.push({ x: s.deckHalf, y: s.deckY, z });
    } else contacts.push({ x: 0, y: s.deckY, z });
  }
  for (const p of wc.propulsors) contacts.push({ x: p.position.x, y: p.position.y - p.diameter / 2, z: p.position.z });

  const nl = Math.max(2, Math.round(h.waveSamplesLong));
  const ntw = Math.max(1, Math.round(h.waveSamplesTrans));
  const waveX: number[] = [];
  const waveZ: number[] = [];
  for (let i = 0; i < nl; i++) waveZ.push(zBow + ((zStern - zBow) * i) / (nl - 1));
  for (let j = 0; j < ntw; j++) waveX.push(ntw === 1 ? 0 : -maxBeam / 2 + (maxBeam * j) / (ntw - 1));

  const g: HullGeom = {
    cols, strips, stripZ, dz, zBow, zStern, chineBeam: Math.max(0.3, chineBeam), maxBeam, deadriseDeg, keelSlope,
    zWlBow: Number.isFinite(zF) ? zF : zBow, waterlineY, volume: vol, lwl, bwl, draft, cb, s0, contacts, waveX, waveZ,
  };
  byMass.set(mass, g);
  return g;
}

// ─── The sea surface over the hull ─────────────────────────────────────────────────────────────

const specCache = new WeakMap<object, WaveSpectrum>();
function seaSpectrum(cfg: Config): WaveSpectrum {
  let s = specCache.get(cfg.world.water);
  if (!s) {
    s = getSeaSpectrum(cfg);
    specCache.set(cfg.world.water, s);
  }
  return s;
}

/** The sea shader's shoaling: waves shrink over shallow water (src/world/traffic/buoyancy.ts shoalFactor). */
const shoal = (depth: number): number => 0.3 + 0.7 * smoothstep(0.3, 8, depth);

/**
 * Gerstner height and vertical velocity above world (x, z) at time t (× gain), inverting the
 * horizontal displacement by fixed-point iteration (a contraction: Σ k s ≤ choppiness < 1).
 */
function waveAt(spec: WaveSpectrum, gain: number, x: number, z: number, t: number, out: { h: number; vy: number }): void {
  out.h = 0;
  out.vy = 0;
  if (!(gain > 0)) return;
  const tr = spec.trains;
  let x0 = x;
  let z0 = z;
  for (let it = 0; it < 5; it++) {
    let dx = 0;
    let dz = 0;
    for (let i = 0; i < tr.length; i++) {
      const w = tr[i];
      const c = Math.cos(w.k * (w.dirX * x0 + w.dirZ * z0) - w.omega * t + w.phase);
      dx += w.chop * w.dirX * c;
      dz += w.chop * w.dirZ * c;
    }
    x0 = x - gain * dx;
    z0 = z - gain * dz;
  }
  let h = 0;
  let vy = 0;
  for (let i = 0; i < tr.length; i++) {
    const w = tr[i];
    const th = w.k * (w.dirX * x0 + w.dirZ * z0) - w.omega * t + w.phase;
    h += w.amp * Math.sin(th);
    vy -= w.amp * w.omega * Math.cos(th);
  }
  out.h = h * gain;
  out.vy = vy * gain;
}

interface SeaPatch {
  /** Still-water level under the hull (sea, lake or river), or null on dry land. */
  level: number | null;
  /** Wave height / vertical velocity at the sample grid [iz * nx + ix]. */
  h: Float64Array;
  vy: Float64Array;
}

function samplePatch(g: HullGeom, pos: Vec3, q: Quat, t: number, env: Environment, cfg: Config): SeaPatch {
  const nx = g.waveX.length;
  const nz = g.waveZ.length;
  const h = new Float64Array(nx * nz);
  const vy = new Float64Array(nx * nz);
  const level = env.waterLevel(pos.x, pos.z);
  if (level === null) return { level, h, vy };
  // Waves only on the open sea (lakes and the river are drawn nearly flat at this scale).
  const isSea = Math.abs(level - cfg.world.seaLevel) < 1e-3;
  if (!isSea) return { level, h, vy };
  const gain = shoal(level - env.groundHeight(pos.x, pos.z));
  const spec = seaSpectrum(cfg);
  const o = { h: 0, vy: 0 };
  for (let iz = 0; iz < nz; iz++) {
    for (let ix = 0; ix < nx; ix++) {
      const w = bodyToWorld(q, { x: g.waveX[ix], y: 0, z: g.waveZ[iz] });
      waveAt(spec, gain, pos.x + w.x, pos.z + w.z, t, o);
      h[iz * nx + ix] = o.h;
      vy[iz * nx + ix] = o.vy;
    }
  }
  return { level, h, vy };
}

/** Bilinear interpolation of a patch field at body (x, z). */
function patchAt(g: HullGeom, f: Float64Array, x: number, z: number): number {
  const nx = g.waveX.length;
  const nz = g.waveZ.length;
  const fz = clamp(((z - g.zBow) / (g.zStern - g.zBow)) * (nz - 1), 0, nz - 1);
  const iz = Math.min(nz - 2, Math.floor(fz));
  const tz = fz - iz;
  let ix = 0;
  let tx = 0;
  if (nx > 1) {
    const fx = clamp(((x + g.maxBeam / 2) / g.maxBeam) * (nx - 1), 0, nx - 1);
    ix = Math.min(nx - 2, Math.floor(fx));
    tx = fx - ix;
  }
  const a = f[iz * nx + ix];
  const b = nx > 1 ? f[iz * nx + ix + 1] : a;
  const c = f[(iz + 1) * nx + ix];
  const d = nx > 1 ? f[(iz + 1) * nx + ix + 1] : c;
  return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
}

/** The sea surface height (MSL) at a world point, as the physics sees it this step (for tests and effects). */
export function vesselSurfaceAt(env: Environment, x: number, z: number, t: number, cfg: Config = CONFIG): number | null {
  const level = env.waterLevel(x, z);
  if (level === null) return null;
  if (Math.abs(level - cfg.world.seaLevel) >= 1e-3) return level;
  const o = { h: 0, vy: 0 };
  waveAt(seaSpectrum(cfg), shoal(level - env.groundHeight(x, z)), x, z, t, o);
  return level + o.h;
}

// ─── Small helpers ─────────────────────────────────────────────────────────────────────────────

const cross = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });

/** Linear interpolation in an ascending [x, y] table (clamped). */
function table(t: readonly (readonly [number, number])[], x: number): number {
  if (x <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) {
    if (x <= t[i][0]) {
      const [x0, y0] = t[i - 1];
      const [x1, y1] = t[i];
      return y0 + ((y1 - y0) * (x - x0)) / Math.max(1e-9, x1 - x0);
    }
  }
  return t[t.length - 1][1];
}

/** Accumulates world forces and their moments about the CG. */
class Wrench {
  fx = 0;
  fy = 0;
  fz = 0;
  tx = 0;
  ty = 0;
  tz = 0;
  /** Add world force f at world offset r from the CG. */
  add(f: Vec3, r: Vec3): void {
    this.fx += f.x;
    this.fy += f.y;
    this.fz += f.z;
    this.tx += r.y * f.z - r.z * f.y;
    this.ty += r.z * f.x - r.x * f.z;
    this.tz += r.x * f.y - r.y * f.x;
  }
  force(f: Vec3): void {
    this.fx += f.x;
    this.fy += f.y;
    this.fz += f.z;
  }
  torque(t: Vec3): void {
    this.tx += t.x;
    this.ty += t.y;
    this.tz += t.z;
  }
}

// ─── Engines and propulsors ────────────────────────────────────────────────────────────────────

/** The lever → gearbox and the commanded engine rpm. */
export function leverCommand(lever: number, wc: WatercraftConfig): { gear: MarineGear; rpm: number } {
  const e = wc.engine;
  const a = Math.abs(lever);
  if (!(a > wc.neutralDetent)) return { gear: 'neutral', rpm: e.idleRpm };
  const f = (a - wc.neutralDetent) / (1 - wc.neutralDetent);
  const top = lever > 0 ? e.maxRpm : e.idleRpm + (e.maxRpm - e.idleRpm) * wc.asternRpmFraction;
  return { gear: lever > 0 ? 'ahead' : 'astern', rpm: e.idleRpm + (top - e.idleRpm) * f };
}

/** Largest steering angle at this speed (drives limit their angle at speed). */
export function maxSteerAt(p: PropulsorConfig, speedKt: number): number {
  const t = clamp(speedKt / Math.max(1, p.highSpeedKt), 0, 1);
  return p.maxSteerDeg + (p.highSpeedSteerDeg - p.maxSteerDeg) * t;
}

/** Foil lift coefficient with a soft stall. */
function foilCl(alpha: number, slope: number, stallDeg: number): number {
  const s = stallDeg * DEG;
  const a = Math.abs(alpha);
  if (a <= s) return slope * alpha;
  const post = slope * s * Math.max(0.55, 1 - (a - s) / (60 * DEG));
  return Math.sign(alpha) * post;
}

// ─── State creation ────────────────────────────────────────────────────────────────────────────

export interface VesselStart {
  x: number;
  z: number;
  headingDeg: number;
  /** Speed ahead through the water, kt (0 = at rest). Starting fast pre-runs the hull onto its running attitude. */
  speedKt?: number;
  /** Moored at this spot: lines hold the boat until the lever goes into gear. */
  moored?: boolean;
  /** The sea's wave clock at the start, s (the renderer's sea clock, so the hull sits on the drawn waves). */
  seaTime?: number;
}

function newPropulsors(wc: WatercraftConfig): PropulsorState[] {
  return wc.propulsors.map(() => ({ rpm: wc.engine.idleRpm, n: 0, gear: 'neutral' as MarineGear, thrust: 0, steerDeg: 0, load: 0.05, boost: 0 }));
}

function baseVesselState(wc: WatercraftConfig, seaTime: number, mooring: VesselState['mooring']): VesselState {
  return {
    seaTime,
    propulsors: newPropulsors(wc),
    tabs: 0,
    mooring,
    speedMs: 0,
    leewayDeg: 0,
    trimDeg: 0,
    planing: 0,
    wettedLength: 0,
    wettedArea: 0,
    displacedVolume: 0,
    resistance: 0,
    depthUnderKeel: Infinity,
    aground: false,
    touching: false,
    capsizeTime: 0,
    surfaceY: 0,
  };
}

const settleCache = new WeakMap<WatercraftConfig, Map<number, { dy: number; pitchDeg: number }>>();

/** Level-water equilibrium: the CG's height above the still level and the static trim (Newton on heave and pitch). */
export function staticFloat(cfg: Config): { dy: number; pitchDeg: number } {
  const wc = cfg.aircraft.watercraft!;
  const m = cfg.aircraft.mass;
  let byMass = settleCache.get(wc);
  if (!byMass) {
    byMass = new Map();
    settleCache.set(wc, byMass);
  }
  const hit = byMass.get(m);
  if (hit) return hit;
  const g = hullGeometry(wc, m);
  const rhoG = wc.waterDensity * cfg.sim.gravity;
  // residuals: net vertical force (buoyancy − weight) and pitch moment, for CG height y above level 0 and pitch θ
  const res = (y: number, th: number): [number, number] => {
    const q = quatFromEuler(0, th, 0);
    const up = bodyToWorld(q, { x: 0, y: 1, z: 0 });
    const cu = Math.max(0.35, Math.abs(up.y));
    let F = 0;
    let M = 0;
    for (const c of g.cols) {
      const b = bodyToWorld(q, { x: c.x, y: c.y, z: c.z });
      const t = bodyToWorld(q, { x: c.x, y: c.top, z: c.z });
      const y0 = y + Math.min(b.y, t.y);
      const y1 = y + Math.max(b.y, t.y);
      const sub = clamp(-y0, 0, y1 - y0);
      if (sub <= 0) continue;
      const f = (rhoG * c.area * sub) / cu;
      const lo = b.y < t.y ? b : t;
      const hi = b.y < t.y ? t : b;
      const k = sub / Math.max(1e-6, y1 - y0) / 2;
      const rz = lo.z + (hi.z - lo.z) * k;
      F += f;
      // world moment about x of an upward force at world z offset rz: torque.x = r.y f.z − r.z f.y = −rz f
      M += -rz * f;
    }
    return [F - m * cfg.sim.gravity, M];
  };
  let y = -g.waterlineY;
  let th = 0;
  for (let it = 0; it < 30; it++) {
    const [f0, m0] = res(y, th);
    if (Math.abs(f0) < 1e-3 * m * cfg.sim.gravity && Math.abs(m0) < 10) break;
    const ey = 1e-3;
    const et = 1e-3;
    const [f1, m1] = res(y + ey, th);
    const [f2, m2] = res(y, th + et);
    const a = (f1 - f0) / ey;
    const b = (f2 - f0) / et;
    const c = (m1 - m0) / ey;
    const d = (m2 - m0) / et;
    const det = a * d - b * c;
    if (Math.abs(det) < 1e-9) break;
    y -= clamp((d * f0 - b * m0) / det, -0.5, 0.5);
    th -= clamp((-c * f0 + a * m0) / det, -2, 2);
  }
  const out = { dy: y, pitchDeg: th };
  byMass.set(m, out);
  return out;
}

function vesselDerived(pos: Vec3, vel: Vec3, q: Quat, w: Vec3, loadFactor: number, v: VesselState): DerivedData {
  const e = eulerFromQuat(q);
  const { p, q: qr, r } = pqrFromOmega(w);
  const gs = Math.hypot(vel.x, vel.z);
  return {
    tas: Math.abs(v.speedMs),
    ias: Math.abs(v.speedMs),
    groundSpeed: gs,
    alpha: v.trimDeg * DEG,
    beta: v.leewayDeg * DEG,
    verticalSpeed: vel.y,
    altitudeAGL: pos.y - v.surfaceY,
    headingDeg: e.headingDeg,
    pitchDeg: e.pitchDeg,
    rollDeg: e.rollDeg,
    loadFactor,
    density: airDensity(pos.y),
    p,
    q: qr,
    r,
  };
}

function vesselEngine(v: VesselState, running: boolean, starting: boolean, startTimer: number, failed: boolean): EngineState {
  const ps = v.propulsors;
  let load = 0;
  let thrust = 0;
  for (const p of ps) {
    load += p.load;
    thrust += p.thrust;
  }
  return { running, starting, startTimer, failed, power: ps.length ? clamp(load / ps.length, 0, 1.2) : 0, rpm: ps.length ? ps[0].rpm : 0, thrust, afterburner: 0 };
}

/**
 * A vessel afloat at (x, z), bow on `headingDeg`, floating at its static waterline and trim on the
 * still level there, engines idling in neutral. Moored → lines to this spot. With `speedKt` the hull
 * is pre-run (a speed-holding helmsman, calm water) onto its running attitude and the controls that
 * hold that speed are returned.
 */
export function createVesselState(env: Environment, cfg: Config, start: VesselStart): { state: AircraftState; controls: Partial<Controls> } {
  const wc = cfg.aircraft.watercraft!;
  const level = env.waterLevel(start.x, start.z) ?? env.groundHeight(start.x, start.z);
  const fl = staticFloat(cfg);
  const heading = start.headingDeg;
  const orientation = quatFromEuler(heading, fl.pitchDeg, 0);
  const seaTime = start.seaTime ?? 0;
  const position = { x: start.x, y: level + fl.dy, z: start.z };
  const vessel = baseVesselState(wc, seaTime, start.moored ? { x: start.x, z: start.z, headingDeg: heading } : null);
  vessel.surfaceY = level;
  vessel.displacedVolume = hullGeometry(wc, cfg.aircraft.mass).volume;
  vessel.depthUnderKeel = Math.max(0, level - env.groundHeight(start.x, start.z) - hullGeometry(wc, cfg.aircraft.mass).draft);
  let state: AircraftState = {
    time: 0,
    position,
    velocity: { x: 0, y: 0, z: 0 },
    orientation,
    angularVelocity: { x: 0, y: 0, z: 0 },
    engine: vesselEngine(vessel, true, false, 0, false),
    flapsDeg: 0,
    gearPos: 1,
    phase: 'afloat',
    stalled: false,
    onGround: false,
    wheelContact: [false, false, false],
    wheelCompression: [0, 0, 0],
    airborneTime: 0,
    touchdown: null,
    crash: null,
    derived: vesselDerived(position, ZERO, orientation, ZERO, 1, vessel),
    vessel,
  };
  const kt = start.speedKt ?? 0;
  if (!(kt > 0.5)) return { state, controls: { throttle: 0 } };

  // Pre-run in calm water (a flat, deep, obstacle-free copy of the world) with a speed-holding helmsman.
  const calm: Environment = {
    groundHeight: () => level - 1000,
    surfaceAt: () => 'water',
    waterLevel: () => level,
  };
  const target = kt / MS_TO_KT;
  const h = quatFromEuler(heading, 0, 0);
  const fwd = bodyToWorld(h, { x: 0, y: 0, z: -1 });
  state = { ...state, velocity: { x: fwd.x * target, y: 0, z: fwd.z * target }, vessel: { ...vessel, mooring: null } };
  let lever = clamp(0.3 + 0.7 * (kt / 34), 0.15, 1);
  const dt = cfg.sim.fixedDt;
  const cfgCalm: Config = { ...cfg, world: { ...cfg.world, seaLevel: level + 12345 } }; // never "the sea": no waves
  for (let i = 0; i < Math.round(25 / dt); i++) {
    state = stepVessel(state, { throttle: lever, elevator: 0, aileron: 0, rudder: 0, elevatorTrim: 0, flapsNotch: 0, gearDown: true, brake: 0, parkingBrake: false, engineOn: true }, dt, calm, cfgCalm);
    // keep it on the heading and on the line; steer the speed with the lever
    const err = target - state.vessel!.speedMs;
    lever = clamp(lever + err * 0.02 * dt * 60, wc.neutralDetent + 0.02, 1);
    const e = eulerFromQuat(state.orientation);
    state = { ...state, orientation: quatFromEuler(heading, e.pitchDeg, e.rollDeg), position: { ...state.position, x: start.x, z: start.z } };
    const sp = Math.hypot(state.velocity.x, state.velocity.z);
    state = { ...state, velocity: { x: fwd.x * sp, y: state.velocity.y, z: fwd.z * sp }, angularVelocity: { x: state.angularVelocity.x, y: 0, z: 0 } };
  }
  const y = state.position.y - level + (env.waterLevel(start.x, start.z) ?? level);
  const vs = state.vessel!;
  state = {
    ...state,
    time: 0,
    position: { x: start.x, y, z: start.z },
    vessel: { ...vs, seaTime, mooring: null },
  };
  return { state, controls: { throttle: lever } };
}

// ─── The step ──────────────────────────────────────────────────────────────────────────────────

function vesselCrash(s: AircraftState, reason: string, time: number): AircraftState {
  const v = s.velocity;
  const vessel = s.vessel!;
  const props = vessel.propulsors.map((p) => ({ ...p, rpm: 0, n: 0, thrust: 0, load: 0, boost: 0 }));
  const ves: VesselState = { ...vessel, propulsors: props, mooring: null };
  return {
    ...s,
    time,
    position: { ...s.position },
    velocity: { x: 0, y: 0, z: 0 },
    orientation: { ...s.orientation },
    angularVelocity: { x: 0, y: 0, z: 0 },
    engine: { running: false, starting: false, startTimer: 0, failed: true, power: 0, rpm: 0, thrust: 0, afterburner: 0 },
    phase: 'crashed',
    stalled: false,
    crash: {
      time,
      reason,
      speedKt: Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) * MS_TO_KT,
      verticalSpeedFpm: v.y * 196.850394,
      position: { ...s.position },
    },
    vessel: ves,
  };
}

/** Controls for a vessel: the lever may go astern (−1); NaN → neutral. */
function sanitizeVessel(c: Controls): Controls {
  const n = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? clamp(v, lo, hi) : 0);
  return {
    throttle: n(c.throttle, -1, 1),
    elevator: n(c.elevator, -1, 1),
    aileron: n(c.aileron, -1, 1),
    rudder: n(c.rudder, -1, 1),
    elevatorTrim: n(c.elevatorTrim, -1, 1),
    flapsNotch: 0,
    gearDown: true,
    brake: n(c.brake, 0, 1),
    parkingBrake: !!c.parkingBrake,
    engineOn: c.engineOn !== false,
  };
}

/**
 * Advance a vessel by dt (called by step() in ./aircraft.ts for configs with `watercraft`).
 * Pure: returns a new state.
 */
export function stepVessel(state: AircraftState, raw: Controls, dt: number, env: Environment, cfg: Config): AircraftState {
  const time = state.time + dt;
  if (state.phase === 'crashed') return { ...structuredClone(state), time };
  const ac = cfg.aircraft;
  const wc = ac.watercraft!;
  const hull = wc.hull;
  const c = sanitizeVessel(raw);
  const m = ac.mass;
  const grav = cfg.sim.gravity;
  const rho = wc.waterDensity;
  const geo = hullGeometry(wc, m);
  const pos = state.position;
  const vel = state.velocity;
  const q = state.orientation;
  const w = state.angularVelocity;
  const prevV = state.vessel ?? baseVesselState(wc, 0, null);
  const seaTime = prevV.seaTime + dt;
  const up = bodyToWorld(q, { x: 0, y: 1, z: 0 });
  const omegaW = bodyToWorld(q, w);
  const W = new Wrench();

  // ── The water over the hull ──
  const sea = samplePatch(geo, pos, q, seaTime, env, cfg);
  const level = sea.level;
  let surfaceY = env.groundHeight(pos.x, pos.z);
  if (level !== null) {
    const isSea = Math.abs(level - cfg.world.seaLevel) < 1e-3;
    const o = { h: 0, vy: 0 };
    if (isSea) waveAt(seaSpectrum(cfg), shoal(level - surfaceY), pos.x, pos.z, seaTime, o);
    surfaceY = level + o.h;
  }

  // ── Hydrostatics + vertical damping, column by column ──
  // At planing speed the transom runs dry and part of the hydrostatic pressure becomes the dynamic
  // lift below (Savitsky): fade that share out with the length Froude number.
  const vbPre = worldToBody(q, vel);
  const FnPre = Math.hypot(vbPre.x, vbPre.z) / Math.sqrt(grav * geo.lwl);
  const rhoG = rho * grav;
  const hydro = 1 - (hull.planingLift > 0 ? hull.planingBuoyancyLoss * smoothstep(0.4, 1.3, FnPre) * (vbPre.z < 0 ? 1 : 0) : 0);
  // The hull's own wave (ahead only): ζ(s) = a cos(k s), s aft of the bow crest, k = g / U².
  const Upre = -vbPre.z;
  const swA = Upre > 0.3 ? hull.selfWave * (geo.bwl / geo.lwl) * ((Upre * Upre) / (2 * grav)) * smoothstep(0.25, 0.4, FnPre) * (1 - smoothstep(hull.selfWaveFadeFn[0], hull.selfWaveFadeFn[1], FnPre)) : 0;
  const swK = Upre > 0.3 ? grav / (Upre * Upre) : 0;
  // …less its mean over the waterline: the wave system moves the pressure (bow up, stern down), it adds no displacement
  const swMean = swK > 0 ? Math.sin(swK * geo.lwl) / (swK * geo.lwl) : 0;
  const cu = Math.max(0.35, Math.abs(up.y));
  const bLin = hull.dampingLinear * rho * Math.sqrt(grav * geo.maxBeam);
  const bQuad = hull.dampingQuadratic * rho;
  let volume = 0;
  let wetArea = 0;
  let wetBottomArea = 0;
  let zFwdKeel = Infinity;
  let zFwdChine = Infinity;
  let zFwdAny = Infinity;
  let wetCz = 0;
  let wetCy = 0;
  let rockerSum = 0;
  // immersion-weighted lateral centroid of the wet bottom (the planing lift's lateral centre)
  let latW = 0;
  let latX = 0;
  const stripDepth = new Float64Array(geo.strips);
  if (level !== null) {
    for (const col of geo.cols) {
      const rb = bodyToWorld(q, { x: col.x, y: col.y, z: col.z });
      const rt = bodyToWorld(q, { x: col.x, y: col.top, z: col.z });
      const yb = pos.y + rb.y;
      const yt = pos.y + rt.y;
      const lo = Math.min(yb, yt);
      const hi = Math.max(yb, yt);
      const surf = level + patchAt(geo, sea.h, col.x, col.z) + (swA > 0 ? swA * (Math.cos(swK * Math.max(0, col.z - geo.zWlBow)) - swMean) : 0);
      const sub = clamp(surf - lo, 0, hi - lo);
      if (sub <= 0) continue;
      const vol = (col.area * sub) / cu;
      volume += vol;
      // centroid of the wet part: from the low end up the column
      const rLo = yb <= yt ? rb : rt;
      const rHi = yb <= yt ? rt : rb;
      const k = sub / Math.max(1e-6, hi - lo) / 2;
      const r = { x: rLo.x + (rHi.x - rLo.x) * k, y: rLo.y + (rHi.y - rLo.y) * k, z: rLo.z + (rHi.z - rLo.z) * k };
      W.add({ x: 0, y: rhoG * vol * hydro, z: 0 }, r);
      // vertical damping relative to the moving surface (ramped in over the first 10 cm of immersion)
      const vp = cross(omegaW, rLo);
      const vrel = vel.y + vp.y - patchAt(geo, sea.vy, col.x, col.z);
      const wet = Math.min(1, sub / 0.1);
      const fd = -col.area * wet * (bLin * vrel + bQuad * vrel * Math.abs(vrel));
      W.add({ x: 0, y: fd, z: 0 }, rLo);
      wetArea += col.surface * wet;
      wetCz += col.z * col.surface * wet;
      wetCy += col.y * col.surface * wet;
      if (col.bottom) {
        wetBottomArea += col.area * wet;
        rockerSum += col.rocker * col.area * wet;
        const wgt = col.area * Math.min(sub, 0.6);
        latW += wgt;
        latX += wgt * col.x;
      }
      const zf = col.z - geo.dz / 2;
      if (zf < zFwdAny) zFwdAny = zf;
      if (col.centre && zf < zFwdKeel) zFwdKeel = zf;
      if (col.chine && zf < zFwdChine) zFwdChine = zf;
      if (col.centre) stripDepth[col.strip] = Math.max(stripDepth[col.strip], sub / cu);
    }
  }
  const immersion = clamp(volume / geo.volume, 0, 1.5);
  const wetted = wetArea > 1e-6;
  const wetLen = wetted ? Math.max(0.1, geo.zStern - zFwdAny) : 0;
  if (wetted) {
    wetCz /= wetArea;
    wetCy /= wetArea;
  }

  // ── Flow over the hull (water at rest; the waves' orbital drift is second order at these scales) ──
  const vb = worldToBody(q, vel);
  const u = -vb.z;
  const vSide = vb.x;
  const Vh = Math.hypot(u, vSide);
  const speedKt = Math.abs(u) * MS_TO_KT;
  // Running trim: the flow's angle to the body, plus the mean rocker of the wetted bottom (the
  // forefoot meets the water at an angle; it fades as the bow lifts clear and only the flat aft
  // buttocks run wet — then this is Savitsky's trim of the keel).
  const rocker = wetBottomArea > 1e-6 ? rockerSum / wetBottomArea : 0;
  const trimRad = Math.atan2(-vb.y, Math.max(0.5, Math.abs(u))) + rocker;
  const trimDeg = trimRad / DEG;
  const leewayDeg = Vh > 0.3 ? Math.atan2(vSide, Math.abs(u)) / DEG : 0;
  const Uref = Math.max(0.5, Vh);

  // ── Planing lift (Savitsky, dynamic part) ──
  let planingLift = 0;
  if (hull.planingLift > 0 && wetted && u > 0.5) {
    const B = geo.chineBeam;
    const Lk = Number.isFinite(zFwdKeel) ? geo.zStern - zFwdKeel : 0;
    const Lc = Number.isFinite(zFwdChine) ? geo.zStern - zFwdChine : 0;
    const lambda = clamp((Lk + Lc) / (2 * B), 0.3, 8);
    const tau = clamp(trimDeg, 0, hull.planingMaxTrimDeg);
    const cl0 = Math.pow(tau, 1.1) * 0.012 * Math.sqrt(lambda);
    const clb = Math.max(0, cl0 - 0.0065 * geo.deadriseDeg * Math.pow(cl0, 0.6));
    // negative trim digs the bow in: a small down force instead of lift
    const neg = trimDeg < 0 ? -Math.min(2, -trimDeg) * 0.004 * Math.sqrt(lambda) : 0;
    // the lift needs a wetted bottom; fade it as the bottom leaves the water
    const wetFrac = clamp(wetBottomArea / (0.25 * geo.lwl * B), 0, 1);
    const L = 0.5 * rho * u * u * B * B * (clb + neg) * hull.planingLift * wetFrac;
    const Cv = u / Math.sqrt(grav * B);
    const lp = clamp(lambda * B * (0.75 - 1 / ((5.21 * Cv * Cv) / (lambda * lambda) + 2.39)), 0, geo.zStern - geo.zBow);
    const zCp = geo.zStern - lp;
    const st = stationAt(hull.stations, zCp);
    // laterally at the wet bottom's immersion centroid: the deeper side of a heeled V-bottom carries
    // more of the pressure, which is what keeps a planing hull upright once the buoyancy has faded
    // …and toward the side leading into a sideslip: skidding sideways, the leading half of the V
    // meets the flow at a larger angle (β / tan deadrise) — why a planing hull banks INTO a turn
    const slip = Math.atan2(vSide, Math.max(0.5, u));
    const lead = geo.deadriseDeg > 1 ? clamp(slip / Math.tan(geo.deadriseDeg * DEG), -1, 1) : 0;
    const xCp = clamp((latW > 0 ? latX / latW : 0) + 0.5 * B * lead, -0.5 * B, 0.5 * B);
    const r = bodyToWorld(q, { x: xCp, y: 0.5 * (st.keelY + st.chineY), z: zCp });
    W.add({ x: up.x * L, y: up.y * L, z: up.z * L }, r);
    planingLift = L;
    // pitch damping of the lift spread along the wet bottom: a pitch rate q changes the local angle
    // of attack by −q x / U along it, so M_q = −(dL/dτ) q Lw² / (12 U), dL/dτ ≈ 1.1 L / τ
    if (tau > 0.2 && L > 0) {
      const Lw = 0.5 * (Lk + Lc);
      const dLdTau = (1.1 * L) / (tau * DEG);
      const Mq = (-dLdTau * pqrFromOmega(w).q * Lw * Lw) / (12 * Math.max(1, u));
      // pitch moment M (+ nose up) → torque_body.x = +M
      W.torque(bodyToWorld(q, { x: Mq, y: 0, z: 0 }));
    }
  }

  // ── Resistance: friction, residuary ──
  let resistance = 0;
  if (wetted && Vh > 0.01) {
    const Re = Math.max(1e5, (Vh * wetLen) / NU_WATER);
    const lg = Math.log10(Re) - 2;
    const cf = 0.075 / (lg * lg);
    const Rf = 0.5 * rho * Vh * Vh * wetArea * cf * hull.formFactor;
    const Fn = Vh / Math.sqrt(grav * geo.lwl);
    const Rr = 0.5 * rho * Vh * Vh * geo.s0 * table(hull.residuary, Fn) * Math.min(1, immersion);
    const R = Rf + Rr;
    resistance = R;
    // opposite the horizontal velocity through the water, at the wetted surface's centroid
    const dir = { x: -vb.x / Vh, y: 0, z: -vb.z / Vh };
    const fW = bodyToWorld(q, { x: dir.x * R, y: 0, z: dir.z * R });
    W.add(fW, bodyToWorld(q, { x: 0, y: wetCy, z: wetCz }));
  }

  // ── Manoeuvring: Clarke's linear derivatives + strip cross-flow drag ──
  if (wetted && Vh > 0.05) {
    let aLat = 0;
    for (let i = 0; i < geo.strips; i++) aLat += stripDepth[i] * geo.dz;
    const L = Math.max(0.5, wetLen);
    const T = clamp(aLat / L, 0.02, 3 * geo.draft);
    const B = geo.bwl;
    const r = pqrFromOmega(w).r;
    const k = Math.PI * (T / L) * (T / L) * hull.clarkeScale;
    const Yv = -k * (1 + 0.4 * geo.cb * (B / T));
    const Yr = -k * (-0.5 + 2.2 * (B / L) - 0.08 * (B / T));
    const Nv = -k * (0.5 + 2.4 * (T / L));
    const Nr = -k * (0.25 + 0.039 * (B / T) - 0.56 * (B / L));
    const U = Uref;
    const Y = 0.5 * rho * L * L * U * (Yv * vSide + Yr * r * L);
    const N = 0.5 * rho * L * L * L * U * (Nv * vSide + Nr * r * L);
    W.add(bodyToWorld(q, { x: Y, y: 0, z: 0 }), bodyToWorld(q, { x: 0, y: geo.waterlineY - 0.5 * T, z: 0 }));
    W.torque(bodyToWorld(q, { x: 0, y: -N, z: 0 }));
    // cross-flow drag per strip (lateral velocity v + r × arm; arm + forward = −z)
    for (let i = 0; i < geo.strips; i++) {
      const d = stripDepth[i];
      if (d <= 0) continue;
      const z = geo.stripZ[i];
      const vl = vSide + r * -z;
      const f = -0.5 * rho * hull.crossFlowCd * d * geo.dz * vl * Math.abs(vl);
      W.add(bodyToWorld(q, { x: f, y: 0, z: 0 }), bodyToWorld(q, { x: 0, y: geo.waterlineY - 0.5 * d, z }));
    }
  }
  // extra roll damping (chines, spray rails)
  if (wetted) {
    const p = pqrFromOmega(w).p;
    const L = -hull.rollDamping * rhoG * geo.volume * geo.maxBeam * p * Math.min(1, immersion);
    // roll moment L (+ right wing down) → torque_body.z = −L
    W.torque(bodyToWorld(q, { x: 0, y: 0, z: -L }));
  }

  // ── Windage (superstructure) ──
  {
    const wind = env.wind ? env.wind(pos.x, pos.y, pos.z, state.time) : ZERO;
    const ar = worldToBody(q, { x: wind.x - vel.x, y: 0, z: wind.z - vel.z });
    const rhoA = airDensity(pos.y);
    const wd = wc.windage;
    const f = { x: 0.5 * rhoA * wd.cdSide * wd.sideArea * ar.x * Math.abs(ar.x), y: 0, z: 0.5 * rhoA * wd.cdFront * wd.frontArea * ar.z * Math.abs(ar.z) };
    W.add(bodyToWorld(q, f), bodyToWorld(q, wd.centre));
  }

  // ── Engines, propellers, pods / rudders ──
  const eng = wc.engine;
  let engineRunning = state.engine.running;
  let starting = state.engine.starting;
  let startTimer = state.engine.startTimer;
  const failed = state.engine.failed;
  if (!c.engineOn || failed) {
    engineRunning = false;
    starting = false;
    startTimer = 0;
  } else if (!engineRunning) {
    starting = true;
    startTimer += dt;
    if (startTimer >= eng.startTime) {
      engineRunning = true;
      starting = false;
      startTimer = 0;
    }
  }
  const cmd = leverCommand(c.throttle, wc);
  const helm = clamp(c.rudder + c.aileron, -1, 1);
  const nMaxProp = eng.maxRpm / eng.gearRatio / 60;
  const qRated = eng.maxPowerW / (TAU * nMaxProp);
  const props: PropulsorState[] = [];
  let totalThrust = 0;
  for (let i = 0; i < wc.propulsors.length; i++) {
    const pc = wc.propulsors[i];
    const ps = prevV.propulsors[i] ?? newPropulsors(wc)[0];
    // steering
    const steerTarget = helm * maxSteerAt(pc, speedKt);
    const steerDeg = moveToward(ps.steerDeg, steerTarget, pc.steerRateDegPerSec * dt);
    const sd = steerDeg * DEG;
    // the drive's axis (forward along the thrust line); + steer swings the thrust to port → the stern to port → the bow to starboard
    const axis = pc.type === 'pod' ? { x: -Math.sin(sd), y: 0, z: -Math.cos(sd) } : { x: 0, y: 0, z: -1 };
    // local water flow at the propeller
    const rp = pc.position;
    const vpB = { x: vb.x + (w.y * rp.z - w.z * rp.y), y: vb.y + (w.z * rp.x - w.x * rp.z), z: vb.z + (w.x * rp.y - w.y * rp.x) };
    const va = (vpB.x * axis.x + vpB.z * axis.z) * (1 - pc.wakeFraction);
    // immersion of the propeller (ventilates as it leaves the water)
    const pw = bodyToWorld(q, rp);
    const propY = pos.y + pw.y;
    const surfP = level === null ? -Infinity : level + patchAt(geo, sea.h, rp.x, rp.z);
    const imm = clamp((surfP - (propY - pc.diameter / 2)) / pc.diameter, 0, 1);
    const D = pc.diameter;
    // shaft dynamics
    const gear: MarineGear = engineRunning ? cmd.gear : 'neutral';
    const dir = gear === 'ahead' ? 1 : gear === 'astern' ? -1 : 0;
    let n = ps.n;
    const J = Math.abs(n) > 0.3 ? va / (n * D) : 0;
    const kq = clamp(pc.kq0 * (1 - J / pc.j0Q), -pc.kq0, 2 * pc.kq0) * (0.15 + 0.85 * imm);
    const kt = clamp(pc.kt0 * (1 - J / pc.j0T), -pc.kt0, 2 * pc.kt0) * imm;
    const Qp = kq * rho * n * Math.abs(n) * D ** 5;
    let rpm: number;
    let boost = ps.boost;
    let load = 0;
    if (dir !== 0) {
      const engRpm = Math.abs(n) * 60 * eng.gearRatio;
      const curve = eng.torqueRise + (1 - eng.torqueRise) * clamp((engRpm - eng.idleRpm) / (eng.maxRpm - eng.idleRpm), 0, 1);
      // the turbo: full boost from ~60 % rpm under load (exhaust flow), building with the lag
      boost = moveToward(boost, clamp(0.15 + (0.85 * (engRpm - eng.idleRpm)) / (0.55 * (eng.maxRpm - eng.idleRpm)), 0.15, 1), dt / Math.max(0.05, eng.turboLagS));
      const qAvail = qRated * curve * (0.35 + 0.65 * boost);
      // governor: carry the propeller's load, correct the rpm error (engine rpm → shaft torque), never over max rpm
      const err = cmd.rpm - engRpm;
      const qGov = Math.abs(Qp) * (dir * n >= 0 ? 1 : -1) + eng.governorGain * err * eng.gearRatio;
      const Qe = engRpm > eng.maxRpm * 1.02 ? 0 : clamp(qGov, 0, qAvail);
      load = Qe / qRated;
      const omega = TAU * n + ((dir * Qe - Qp) / eng.shaftInertia) * dt;
      n = omega / TAU;
      // an idling engine in gear never stalls: at least idle rpm in the selected direction
      const nIdle = eng.idleRpm / eng.gearRatio / 60;
      if (dir * n < nIdle * 0.98 && Math.abs(Qp) < qAvail) n = moveToward(n, dir * nIdle, nIdle * 4 * dt);
      rpm = Math.abs(n) * 60 * eng.gearRatio;
    } else {
      // neutral: the engine spins free toward idle (or down when stopped); the propeller windmills down
      // (the starter cranks at ~200 rpm until it catches)
      const target = engineRunning ? eng.idleRpm : starting ? 200 : 0;
      rpm = moveToward(ps.rpm, target, (engineRunning || starting ? 3000 : 900) * dt);
      boost = moveToward(boost, 0.1, dt / Math.max(0.05, eng.turboLagS));
      const omega = TAU * n - (Qp / (eng.shaftInertia * 0.3)) * dt;
      n = Math.abs(omega) < 0.05 ? 0 : omega / TAU;
      load = engineRunning ? 0.05 : 0;
    }
    // thrust (along the drive's axis), astern efficiency, thrust deduction
    let T = kt * rho * n * Math.abs(n) * D ** 4;
    if (T < 0) T *= pc.asternEfficiency;
    const Teff = T * (1 - pc.thrustDeduction);
    const ta = pc.thrustAngleDeg * DEG;
    W.add(bodyToWorld(q, { x: axis.x * Teff * Math.cos(ta), y: Teff * Math.sin(ta), z: axis.z * Teff * Math.cos(ta) }), pw);
    totalThrust += T;
    // the leg / rudder as a foil (in the propeller's slipstream for rudders)
    const rf = pc.foilCentre;
    const vf = { x: vb.x + (w.y * rf.z - w.z * rf.y), z: vb.z + (w.x * rf.y - w.y * rf.x) };
    const fw = bodyToWorld(q, rf);
    const surfF = level === null ? -Infinity : level + patchAt(geo, sea.h, rf.x, rf.z);
    const fImm = clamp((surfF - (pos.y + fw.y)) / 0.3 + 0.5, 0, 1);
    const V2 = vf.x * vf.x + vf.z * vf.z;
    if (fImm > 0 && V2 > 0.01) {
      const chord = { x: -Math.sin(sd), z: -Math.cos(sd) };
      const nrm = { x: -chord.z, z: chord.x };
      const vc = vf.x * chord.x + vf.z * chord.z;
      const vn = vf.x * nrm.x + vf.z * nrm.z;
      const alpha = Math.atan2(vn, Math.abs(vc));
      let qd = 0.5 * rho * V2;
      if (pc.type === 'shaft' && T > 0) qd += T / (Math.PI * D * D * 0.25);
      const cl = foilCl(alpha, pc.foilLiftSlope, pc.foilStallDeg) * (vc < 0 ? 0.5 : 1);
      // lift ⟂ the flow, resisting the sideslip across the foil; plus a little drag along the flow
      const V = Math.sqrt(V2);
      const vhat = { x: vf.x / V, z: vf.z / V };
      let px = nrm.x - (nrm.x * vhat.x + nrm.z * vhat.z) * vhat.x;
      let pz = nrm.z - (nrm.x * vhat.x + nrm.z * vhat.z) * vhat.z;
      const pl = Math.hypot(px, pz);
      if (pl > 1e-6) {
        px /= pl;
        pz /= pl;
        const Lf = -cl * qd * pc.foilArea * fImm;
        const Df = -(0.012 + 0.1 * cl * cl) * qd * pc.foilArea * fImm;
        W.add(bodyToWorld(q, { x: px * Lf + vhat.x * Df, y: 0, z: pz * Lf + vhat.z * Df }), fw);
      }
    }
    props.push({ rpm, n, gear, thrust: T, steerDeg, load, boost });
  }

  // ── Trim tabs ──
  const tabs = wc.trimTabs ? moveToward(prevV.tabs, clamp(-c.elevatorTrim, 0, 1), wc.trimTabs.ratePerSec * dt) : 0;
  if (wc.trimTabs && tabs > 0 && u > 0.5) {
    for (const p of wc.trimTabs.positions) {
      const pw = bodyToWorld(q, p);
      const surfT = level === null ? -Infinity : level + patchAt(geo, sea.h, p.x, p.z);
      if (pos.y + pw.y > surfT + 0.05) continue;
      const Lt = 0.5 * rho * u * u * wc.trimTabs.area * wc.trimTabs.clFull * tabs;
      W.add(bodyToWorld(q, { x: 0, y: Lt, z: 0.08 * Lt }), pw);
    }
  }

  // ── Mooring lines ──
  let mooring = prevV.mooring;
  if (mooring && cmd.gear !== 'neutral' && engineRunning) mooring = null;
  if (mooring) {
    const mo = wc.mooring;
    W.force({ x: -mo.stiffness * (pos.x - mooring.x) - mo.damping * vel.x, y: 0, z: -mo.stiffness * (pos.z - mooring.z) - mo.damping * vel.z });
    const e = eulerFromQuat(q);
    const dpsi = wrap180(e.headingDeg - mooring.headingDeg) * DEG;
    const r = pqrFromOmega(w).r;
    // yaw moment N (+ nose right) → torque_body.y = −N
    W.torque(bodyToWorld(q, { x: 0, y: -(-mo.yawStiffness * dpsi - mo.yawDamping * r), z: 0 }));
  }

  // ── Contacts: sea bed / shore, structures ──
  const ct = wc.contact;
  let aground = false;
  let touching = false;
  let crashReason: string | null = null;
  let depthUnderKeel = Infinity;
  const ptW: Vec3[] = [];
  for (const b of geo.contacts) ptW.push(bodyToWorld(q, b));
  // broad phase: the ground at the CG and the hull's ends, against the hull's lowest point
  let lowest = Infinity;
  for (const r of ptW) lowest = Math.min(lowest, pos.y + r.y);
  const probe = [0, geo.zBow, geo.zStern];
  let groundTop = -Infinity;
  for (const z of probe) {
    const r = bodyToWorld(q, { x: 0, y: 0, z });
    groundTop = Math.max(groundTop, env.groundHeight(pos.x + r.x, pos.z + r.z));
  }
  const nearBottom = groundTop > lowest - 4;
  const checkObstacles = typeof env.obstacleTop === 'function';
  for (let i = 0; i < ptW.length; i++) {
    const r = ptW[i];
    const P = { x: pos.x + r.x, y: pos.y + r.y, z: pos.z + r.z };
    const vp = cross(omegaW, r);
    const vP = { x: vel.x + vp.x, y: vel.y + vp.y, z: vel.z + vp.z };
    if (nearBottom) {
      const g = env.groundHeight(P.x, P.z);
      if (P.y - g < depthUnderKeel && i < geo.contacts.length) depthUnderKeel = Math.min(depthUnderKeel, P.y - g);
      if (P.y < g) {
        const pen = g - P.y;
        aground = true;
        const nrm = env.groundNormal ? env.groundNormal(P.x, P.z) : { x: 0, y: 1, z: 0 };
        const vn = vP.x * nrm.x + vP.y * nrm.y + vP.z * nrm.z;
        // hitting the bottom hard, or at speed at all (a planing hull or its drives don't survive it)
        if (-vn > ct.crashSpeedMs * 1.5 || Math.hypot(vP.x, vP.z) > ct.crashSpeedMs * 2) crashReason = 'Ran aground — hull holed';
        const fn = Math.max(0, ct.stiffness * pen - ct.damping * vn);
        const vt = { x: vP.x - vn * nrm.x, y: vP.y - vn * nrm.y, z: vP.z - vn * nrm.z };
        const vtl = Math.hypot(vt.x, vt.y, vt.z);
        const ff = vtl > 1e-3 ? (ct.friction * fn) / Math.max(vtl, 0.2) : 0;
        W.add({ x: nrm.x * fn - vt.x * ff, y: nrm.y * fn - vt.y * ff, z: nrm.z * fn - vt.z * ff }, r);
      }
    }
    if (checkObstacles && P.y < (level ?? P.y) + 3) {
      const top = env.obstacleTop!(P.x, P.z);
      if (top > P.y) {
        // push the hull back inboard: outward = the point's horizontal offset from the CG
        let nx = r.x;
        let nz = r.z;
        const nl = Math.hypot(nx, nz);
        if (nl < 1e-3) continue;
        nx /= nl;
        nz /= nl;
        // penetration: march inboard until the structure ends
        let pen = 0.05;
        for (const s of [0.1, 0.2, 0.4, 0.8, 1.6]) {
          pen = s;
          if (env.obstacleTop!(P.x - nx * s, P.z - nz * s) <= P.y) break;
        }
        const vn = vP.x * nx + vP.z * nz; // + = moving further into it
        touching = true;
        if (vn > ct.crashSpeedMs) crashReason = 'Collision — hull holed';
        const fn = Math.max(0, ct.stiffness * pen + ct.damping * vn);
        const vt = { x: vP.x - vn * nx, y: vP.y, z: vP.z - vn * nz };
        const vtl = Math.hypot(vt.x, vt.y, vt.z);
        const ff = vtl > 1e-3 ? (ct.friction * fn) / Math.max(vtl, 0.2) : 0;
        W.add({ x: -nx * fn - vt.x * ff, y: -vt.y * ff, z: -nz * fn - vt.z * ff }, r);
      }
    }
  }
  if (!nearBottom && level !== null) depthUnderKeel = Math.max(0, lowest - groundTop);

  // ── Integrate (semi-implicit Euler, added mass per body axis scaled by the immersion) ──
  W.force({ x: 0, y: -m * grav, z: 0 });
  const am = hull.addedMass;
  const imm = clamp(immersion, 0, 1);
  const fb = worldToBody(q, { x: W.fx, y: W.fy, z: W.fz });
  // gravity + buoyancy mostly act along world vertical: split them out so a rolled hull's added
  // mass along its own axes doesn't distort the weight
  const ab = {
    x: fb.x / (m * (1 + am.sway * imm)),
    y: fb.y / (m * (1 + am.heave * imm)),
    z: fb.z / (m * (1 + am.surge * imm)),
  };
  const aw = bodyToWorld(q, ab);
  const velocity = { x: vel.x + aw.x * dt, y: vel.y + aw.y * dt, z: vel.z + aw.z * dt };
  const position = { x: pos.x + velocity.x * dt, y: pos.y + velocity.y * dt, z: pos.z + velocity.z * dt };
  const tb = worldToBody(q, { x: W.tx, y: W.ty, z: W.tz });
  const I = ac.inertia;
  const Ip = I.pitch * (1 + am.pitch * imm);
  const Iy = I.yaw * (1 + am.yaw * imm);
  const Ir = I.roll * (1 + am.roll * imm);
  const hx = I.pitch * w.x;
  const hy = I.yaw * w.y;
  const hz = I.roll * w.z;
  const wMax = ac.limits.maxAngularRate;
  const angularVelocity = {
    x: clamp(w.x + ((tb.x - (w.y * hz - w.z * hy)) / Ip) * dt, -wMax, wMax),
    y: clamp(w.y + ((tb.y - (w.z * hx - w.x * hz)) / Iy) * dt, -wMax, wMax),
    z: clamp(w.z + ((tb.z - (w.x * hy - w.y * hx)) / Ir) * dt, -wMax, wMax),
  };
  const orientation = qIntegrateBody(q, angularVelocity, dt);

  // ── Capsize ──
  const e = eulerFromQuat(orientation);
  const capsizeTime = Math.abs(e.rollDeg) > ct.capsizeRollDeg || up.y < 0 ? prevV.capsizeTime + dt : 0;

  const vessel: VesselState = {
    seaTime,
    propulsors: props,
    tabs,
    mooring,
    speedMs: u,
    leewayDeg,
    trimDeg: e.pitchDeg,
    planing: clamp(planingLift / (m * grav), 0, 2),
    wettedLength: wetLen,
    wettedArea: wetArea,
    displacedVolume: volume,
    resistance,
    depthUnderKeel,
    aground,
    touching,
    capsizeTime,
    surfaceY,
  };
  const loadFactor = (fb.y + m * grav * up.y) / (m * grav);
  const next: AircraftState = {
    time,
    position,
    velocity,
    orientation,
    angularVelocity,
    engine: vesselEngine(vessel, engineRunning, starting, startTimer, failed),
    flapsDeg: 0,
    gearPos: 1,
    phase: 'afloat',
    stalled: false,
    onGround: false,
    wheelContact: [false, false, false],
    wheelCompression: [0, 0, 0],
    airborneTime: 0,
    touchdown: null,
    crash: null,
    derived: vesselDerived(position, velocity, orientation, angularVelocity, loadFactor, vessel),
    vessel,
  };
  if (crashReason) return vesselCrash({ ...next, velocity: vel }, crashReason, time);
  if (capsizeTime > ct.capsizeTimeS) return vesselCrash(next, 'Capsized', time);
  if (!Number.isFinite(position.x + position.y + position.z + orientation.w)) return vesselCrash(state, 'Foundered', time);
  return next;
}
