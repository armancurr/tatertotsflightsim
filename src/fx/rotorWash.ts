/**
 * PURE rotor downwash (no three.js, no DOM): where a helicopter's wash reaches the surface below it,
 * how strong it is there, what the surface throws up, and a particle recipe that spreads it out
 * along the ground. The system (src/game/systems/rotorWash.ts) samples the world, calls
 * `rotorWashAt()` every frame, feeds the result to a `RotorWashEmitter` that emits into the shared
 * effects smoke pool (so the wash is drawn, lit, fogged and sorted with the rest of the particles —
 * no extra draw call), and draws a ripple ring on water (washRing.ts).
 *
 * The model, in plain words:
 *  - The wake leaves the disc along −mast at about 1.6 × the induced velocity vi (the far wake
 *    accelerates toward 2 vi) and is carried by the wind; relative to the moving hub it also trails
 *    behind by the aircraft's own velocity. It hits the surface where that line meets it — under the
 *    hub in the hover, displaced downwind / behind as speed builds (wake skew), and not at all once
 *    the wake runs nearly flat (it is gone long before it reaches the ground).
 *  - Strength ∝ induced power per disc area (T·vi / A: thrust × wash velocity, 1 for a JetRanger in
 *    the hover) × a fall-off with the wake's path length to the surface (full within ½ diameter,
 *    nothing beyond ~2.3 diameters) × rotor speed (nothing with the rotor stopped). vi already falls
 *    with forward speed, so the wash fades in the transition to cruise.
 *  - The wash turns at the surface into a radial wall jet: particles start on a ring at ~0.55–0.95 R
 *    around the impact point and are thrown outward at ~1.1 × the wake speed, slowing (drag toward the
 *    wind) to reach ~2–3 R, lifting a little.
 *  - What is thrown up depends on the surface: tan/brown dust on dirt, sand and fields, a faint light
 *    dust and grass-coloured flecks on grass (leaf bits under trees), almost nothing (a faint haze)
 *    on pavement and rock, snow powder on snow, and mist + droplets on water (plus a ripple ring).
 */
import type { RotorcraftConfig } from '../config';
import type { Quat, SurfaceType, Vec3 } from '../types';
import { newParticleInit, type ParticleInit, type ParticlePool } from './pool';

/** Tunables of the downwash effect. */
export const WASH = {
  /** Wash is at full strength within this many rotor diameters of the surface (wake path length)… */
  fullHeightDiameters: 0.5,
  /** …and gone beyond this many. */
  maxHeightDiameters: 2.3,
  /** Induced power per disc area (T·vi/A, W/m²) that counts as strength 1 (a JetRanger in the hover ≈ 1250). */
  refDiskPower: 1250,
  /** Strength is capped here (a heavy pull of collective kicks up more, but not without limit). */
  maxStrength: 1.6,
  /** The far wake moves at this × vi (momentum theory: → 2 vi far below the disc). */
  wakeSpeedFactor: 1.6,
  /** A wake descending slower than this (m/s) never reaches the surface in the near field. */
  minWakeDescent: 0.8,
  /** Rotor speed (fraction of nominal): no wash below the first, full above the second. */
  rotorSpeedRange: [0.2, 0.6] as [number, number],
  /** Impact points further than this many rotor radii from the hub (fast, low flight) are ignored. */
  maxOffsetRadii: 5,
  /** Particles start on a ring of this many radii around the impact point (inner, outer). */
  ringRadii: [0.55, 0.95] as [number, number],
  /** Radial wall-jet speed at the ring, × the wake speed. */
  outwashFactor: 1.1,
  /** Smoke-pool slots the wash always leaves free (a crash or explosion needs them more). */
  reserve: 600,
  /** At most this many particles per frame (long frames, tab switches). */
  maxPerFrame: 30,
} as const;

export type WashKind = 'none' | 'dust' | 'grass' | 'haze' | 'snow' | 'spray';
type Rgb = readonly [number, number, number];

/** What a surface throws up in the wash. Rates are particles/s at strength 1 and full quality. */
export interface WashStyle {
  kind: WashKind;
  /** Soft puffs (dust, snow powder, mist). */
  puffRate: number;
  puffAlpha: number;
  /** Grown puff diameter, m (min, max). */
  puffSize: readonly [number, number];
  puffLife: readonly [number, number];
  puffColor: Rgb;
  /** Settling (m/s²): mist and powder fall back, dust hangs. */
  puffGravity: number;
  /** Small solid bits: grass/leaf flecks, straw, water droplets. */
  fleckRate: number;
  fleckColor: Rgb;
  fleckSize: readonly [number, number];
  fleckAlpha: number;
  /** Draw the ripple / darkened ring on the surface (water). */
  ring: boolean;
}

const DUST: Rgb = [0.56, 0.46, 0.34];
const SAND: Rgb = [0.78, 0.7, 0.56];
const FIELD: Rgb = [0.6, 0.52, 0.4];
const GRASS_DUST: Rgb = [0.62, 0.6, 0.5];
const PAVE: Rgb = [0.68, 0.68, 0.67];
const ROCK: Rgb = [0.56, 0.52, 0.47];
const SNOW: Rgb = [0.92, 0.94, 0.97];
const SPRAY: Rgb = [0.85, 0.88, 0.9];

const style = (kind: WashKind, puffRate: number, puffAlpha: number, puffSize: [number, number], puffLife: [number, number], puffColor: Rgb, puffGravity: number, fleckRate = 0, fleckColor: Rgb = DUST, fleckSize: [number, number] = [0.15, 0.25], fleckAlpha = 0.85, ring = false): WashStyle => ({
  kind, puffRate, puffAlpha, puffSize, puffLife, puffColor, puffGravity, fleckRate, fleckColor, fleckSize, fleckAlpha, ring,
});

const STYLES: Record<SurfaceType, WashStyle> = {
  dirt: style('dust', 90, 0.3, [4.5, 8], [2, 3.2], DUST, 0),
  sand: style('dust', 100, 0.3, [4.5, 8.5], [2, 3.4], SAND, 0),
  field: style('dust', 70, 0.24, [4.5, 7.5], [1.8, 3], FIELD, 0, 12, [0.55, 0.47, 0.24]),
  grass: style('grass', 30, 0.09, [3.5, 6], [1.5, 2.4], GRASS_DUST, 0, 45, [0.4, 0.47, 0.19], [0.2, 0.34]),
  forest: style('grass', 12, 0.05, [3, 5], [1.4, 2.2], GRASS_DUST, 0, 22, [0.3, 0.32, 0.14], [0.2, 0.34]),
  rock: style('haze', 9, 0.07, [3, 5], [1.4, 2.2], ROCK, 0),
  runway: style('haze', 7, 0.045, [3, 5], [1.4, 2.2], PAVE, 0),
  asphalt: style('haze', 7, 0.045, [3, 5], [1.4, 2.2], PAVE, 0),
  urban: style('haze', 7, 0.045, [3, 5], [1.4, 2.2], PAVE, 0),
  snow: style('snow', 90, 0.42, [4.5, 8], [1.8, 2.8], SNOW, 0.5),
  water: style('spray', 90, 0.07, [4, 7.5], [1.4, 2.4], SPRAY, 0.6, 30, [0.85, 0.88, 0.9], [0.08, 0.15], 0.5, true),
};

const NONE: WashStyle = style('none', 0, 0, [1, 1], [1, 1], DUST, 0);

/** The wash recipe for a surface (unknown surfaces throw nothing up). */
export function washStyle(surface: SurfaceType | string | null | undefined): WashStyle {
  return (surface && (STYLES as Record<string, WashStyle>)[surface]) || NONE;
}

/** The world as the wash needs it (the system passes the WorldEnvironment). */
export interface WashSampler {
  groundHeight(x: number, z: number): number;
  waterLevel(x: number, z: number): number | null;
  surfaceAt(x: number, z: number): SurfaceType;
}

export interface WashInput {
  /** CG, world m; world velocity m/s; body → world rotation. */
  position: Vec3;
  velocity: Vec3;
  orientation: Quat;
  /** The rotor state (thrust N, vi m/s, omega rad/s); absent on fixed-wing aircraft. */
  rotor: { thrust: number; vi: number; omega: number } | null | undefined;
  /** `def.config.aircraft.rotorcraft` (null on fixed-wing aircraft). */
  rotorcraft: RotorcraftConfig | null | undefined;
  /** Wind at the hub (world m/s, where the air goes). */
  wind?: Vec3 | null;
  /** Crashed aircraft make no wash (the effects are busy with the crash). */
  crashed?: boolean;
}

export interface RotorWash {
  /** 0 (nothing) … WASH.maxStrength. */
  strength: number;
  /** Where the wake meets the surface (world; y = the surface height there). */
  x: number;
  y: number;
  z: number;
  /** Rotor radius, m. */
  radius: number;
  /** Wake path length from the hub to the surface / rotor diameter. */
  heightRatio: number;
  /** Horizontal distance from below the hub to the impact point, m (wake skew). */
  offset: number;
  surface: SurfaceType | null;
  water: boolean;
  kind: WashKind;
  /** Wake speed at the surface, m/s (sets the outwash). */
  wakeSpeed: number;
  /** Horizontal ground-relative velocity of the wake air (wind + tilted wash), m/s: biases the outwash. */
  driftX: number;
  driftZ: number;
}

export function newRotorWash(): RotorWash {
  return { strength: 0, x: 0, y: 0, z: 0, radius: 0, heightRatio: Infinity, offset: 0, surface: null, water: false, kind: 'none', wakeSpeed: 0, driftX: 0, driftZ: 0 };
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v: number) => (v > 0 ? (v < 1 ? v : 1) : 0);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

function none(out: RotorWash, radius = 0): RotorWash {
  out.strength = 0;
  out.radius = fin(radius) ? radius : 0;
  out.heightRatio = Infinity;
  out.offset = 0;
  out.surface = null;
  out.water = false;
  out.kind = 'none';
  out.wakeSpeed = 0;
  out.driftX = 0;
  out.driftZ = 0;
  return out;
}

/** Surface height (terrain or water, whichever is higher) at x,z; sets `water` on the scratch. */
function surfaceY(env: WashSampler, x: number, z: number, hit: { water: boolean }): number {
  const g = env.groundHeight(x, z);
  const w = env.waterLevel(x, z);
  const gy = fin(g) ? g : -1e9;
  if (fin(w) && w >= gy - 0.01) {
    hit.water = true;
    return w;
  }
  hit.water = false;
  return gy;
}

const HIT = { water: false };
const HUB = { x: 0, y: 0, z: 0 };
const MAST = { x: 0, y: 0, z: 0 };

/** Rotate (x,y,z) by the unit quaternion (qx,qy,qz,qw) into o: v' = v + 2w(q×v) + 2 q×(q×v). */
function rotate(qx: number, qy: number, qz: number, qw: number, x: number, y: number, z: number, o: { x: number; y: number; z: number }): void {
  const tx = 2 * (qy * z - qz * y), ty = 2 * (qz * x - qx * z), tz = 2 * (qx * y - qy * x);
  o.x = x + qw * tx + (qy * tz - qz * ty);
  o.y = y + qw * ty + (qz * tx - qx * tz);
  o.z = z + qw * tz + (qx * ty - qy * tx);
}

/**
 * Where and how strongly the rotor wash meets the surface (writes into `out`, returns it). Never
 * throws: missing or non-finite inputs, a fixed-wing aircraft, a stopped rotor or a hub too high
 * all give strength 0.
 */
export function rotorWashAt(input: WashInput, env: WashSampler, out: RotorWash = newRotorWash()): RotorWash {
  try {
    return compute(input, env, out);
  } catch {
    return none(out);
  }
}

function compute(input: WashInput, env: WashSampler, out: RotorWash): RotorWash {
  const rc = input.rotorcraft;
  const rotor = input.rotor;
  if (!rc || !rotor || input.crashed) return none(out);
  const R = rc.rotor.radius;
  if (!(fin(R) && R > 0)) return none(out);
  const { position: p, velocity: v, orientation: q } = input;
  if (!p || !v || !q) return none(out, R);
  const thrust = rotor.thrust, vi = rotor.vi, omega = rotor.omega;
  if (!(fin(thrust) && fin(vi) && fin(omega)) || thrust <= 0 || vi <= 0) return none(out, R);
  const nominal = (rc.rotor.nominalRpm * 2 * Math.PI) / 60;
  const spin = fin(nominal) && nominal > 0 ? smooth(WASH.rotorSpeedRange[0], WASH.rotorSpeedRange[1], Math.abs(omega) / nominal) : 0;
  if (spin <= 0) return none(out, R);

  // Hub and mast in the world (body → world rotation of the body-frame hub and mast axis).
  let qx = q.x, qy = q.y, qz = q.z, qw = q.w;
  const qn = Math.hypot(qx, qy, qz, qw);
  if (!(fin(qn) && qn > 1e-6)) return none(out, R);
  qx /= qn; qy /= qn; qz /= qn; qw /= qn;
  const hubB = rc.rotor.hub;
  const hub = HUB;
  rotate(qx, qy, qz, qw, fin(hubB?.x) ? hubB.x : 0, fin(hubB?.y) ? hubB.y : 0, fin(hubB?.z) ? hubB.z : 0, hub);
  hub.x += p.x; hub.y += p.y; hub.z += p.z;
  const tilt = ((fin(rc.rotor.mastTiltDeg) ? rc.rotor.mastTiltDeg : 0) * Math.PI) / 180;
  const mast = MAST;
  rotate(qx, qy, qz, qw, 0, Math.cos(tilt), -Math.sin(tilt), mast);
  if (!(fin(hub.x) && fin(hub.y) && fin(hub.z) && fin(mast.y))) return none(out, R);
  // A rotor pointing its thrust sideways or down blows no wash onto the ground below.
  if (mast.y < 0.2) return none(out, R);

  // Wake velocity relative to the moving hub: down the mast at ~1.6 vi, carried by the wind, and
  // left behind by the aircraft's own motion.
  const vw = Math.min(vi, 60) * WASH.wakeSpeedFactor;
  const w = input.wind;
  const wx = w && fin(w.x) ? w.x : 0, wy = w && fin(w.y) ? w.y : 0, wz = w && fin(w.z) ? w.z : 0;
  const vx = fin(v.x) ? v.x : 0, vy = fin(v.y) ? v.y : 0, vz = fin(v.z) ? v.z : 0;
  const ux = -mast.x * vw + wx - vx;
  const uy = -mast.y * vw + wy - vy;
  const uz = -mast.z * vw + wz - vz;
  if (!(uy < -WASH.minWakeDescent)) return none(out, R);

  // Where it meets the surface: two passes (the surface height at the impact point may differ from under the hub).
  let sx = hub.x, sz = hub.z;
  let sy = surfaceY(env, sx, sz, HIT);
  let h = hub.y - sy;
  for (let k = 0; k < 2; k++) {
    const t = Math.max(0, h) / -uy;
    sx = hub.x + ux * t;
    sz = hub.z + uz * t;
    sy = surfaceY(env, sx, sz, HIT);
    h = hub.y - sy;
  }
  if (!(fin(sx) && fin(sy) && fin(sz))) return none(out, R);
  const D = 2 * R;
  if (!(h < WASH.maxHeightDiameters * D)) return none(out, R);
  h = Math.max(0.05, h);
  const t = h / -uy;
  const path = Math.hypot(ux * t, h, uz * t);
  const offset = Math.hypot(sx - hub.x, sz - hub.z);
  if (!(offset <= WASH.maxOffsetRadii * R)) return none(out, R);
  const heightRatio = path / D;
  const fall = 1 - smooth(WASH.fullHeightDiameters, WASH.maxHeightDiameters, heightRatio);
  const power = (thrust * Math.min(vi, 60)) / (Math.PI * R * R) / WASH.refDiskPower;
  const strength = Math.min(WASH.maxStrength, power * fall * spin);
  if (!(strength > 1e-4)) return none(out, R);

  const water = HIT.water;
  const surface: SurfaceType = water ? 'water' : env.surfaceAt(sx, sz);
  out.strength = strength;
  out.x = sx;
  out.y = sy;
  out.z = sz;
  out.radius = R;
  out.heightRatio = heightRatio;
  out.offset = offset;
  out.surface = surface;
  out.water = water;
  out.kind = washStyle(surface).kind;
  out.wakeSpeed = Math.hypot(-mast.x * vw, -mast.y * vw, -mast.z * vw);
  out.driftX = wx - mast.x * vw;
  out.driftZ = wz - mast.z * vw;
  return out;
}

/** Particle budget for a quality preset (fewer particles on low). */
export function washQuality(level: string | null | undefined): number {
  return level === 'low' ? 0.4 : level === 'medium' ? 0.7 : 1;
}

/**
 * Emits the wash into a particle pool (the effects' smoke pool): puffs and flecks on the ring
 * around the impact point, thrown outward. Deterministic for a seed; allocation-free per frame.
 */
export class RotorWashEmitter {
  /** Particles emitted since the last reset. */
  emitted = 0;
  private puffAcc = 0;
  private fleckAcc = 0;
  private rngState: number;
  private readonly seed0: number;
  private readonly tpl: ParticleInit = newParticleInit();

  constructor(seed = 0x5a17e) {
    this.seed0 = seed >>> 0;
    this.rngState = this.seed0;
  }

  private rnd(): number {
    this.rngState = (this.rngState + 0x6d2b79f5) >>> 0;
    let t = this.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  reset(): void {
    this.puffAcc = 0;
    this.fleckAcc = 0;
    this.emitted = 0;
    this.rngState = this.seed0;
  }

  /** Emit this frame's share (dt in s; quality 0..1 from washQuality). Returns how many were emitted. */
  update(pool: ParticlePool, wash: RotorWash, dtIn: number, quality = 1): number {
    const dt = fin(dtIn) && dtIn > 0 ? Math.min(dtIn, 0.1) : 0;
    const s = fin(wash.strength) ? Math.min(WASH.maxStrength, Math.max(0, wash.strength)) : 0;
    const st = washStyle(wash.surface);
    const qf = fin(quality) ? Math.min(1, Math.max(0, quality)) : 1;
    if (dt <= 0 || s <= 0 || st.kind === 'none' || qf <= 0 || !(fin(wash.x) && fin(wash.y) && fin(wash.z) && wash.radius > 0)) {
      this.puffAcc = 0;
      this.fleckAcc = 0;
      return 0;
    }
    // Rate grows with strength; opacity grows more slowly (a weak wash is thin, not just sparse).
    const k = s * qf * dt;
    this.puffAcc += st.puffRate * k;
    this.fleckAcc += st.fleckRate * k * (0.4 + 0.6 * Math.min(1, s));
    let n = 0;
    const room = () => pool.count < pool.capacity - WASH.reserve && n < WASH.maxPerFrame;
    while (this.puffAcc >= 1 && room()) {
      this.puffAcc -= 1;
      this.puff(pool, wash, st, s);
      n++;
    }
    while (this.fleckAcc >= 1 && room()) {
      this.fleckAcc -= 1;
      this.fleck(pool, wash, st, s);
      n++;
    }
    // Out of room: drop the backlog instead of bursting later.
    if (this.puffAcc > 4) this.puffAcc = 0;
    if (this.fleckAcc > 4) this.fleckAcc = 0;
    this.emitted += n;
    return n;
  }

  /** Start on the ring and throw outward (writes position and velocity into the template). */
  private place(t: ParticleInit, wash: RotorWash, s: number, speedK: number, y0: number): void {
    const R = wash.radius;
    const th = this.rnd() * Math.PI * 2;
    const c = Math.cos(th), sn = Math.sin(th);
    const r = R * (WASH.ringRadii[0] + (WASH.ringRadii[1] - WASH.ringRadii[0]) * this.rnd());
    t.x = wash.x + c * r;
    t.z = wash.z + sn * r;
    t.y = wash.y + y0;
    const v0 = Math.min(30, wash.wakeSpeed * WASH.outwashFactor) * (0.55 + 0.45 * this.rnd()) * (0.6 + 0.4 * Math.min(1, s)) * speedK;
    // The outwash is stronger where the tilted wake blows (drift), weaker upstream of it.
    t.vx = c * v0 + 0.35 * wash.driftX;
    t.vz = sn * v0 + 0.35 * wash.driftZ;
    t.groundY = wash.y;
    t.seed = this.rnd();
    t.rot = this.rnd() * Math.PI * 2;
  }

  private base(): ParticleInit {
    const t = this.tpl;
    t.vy = 0; t.life = 1; t.size0 = 1; t.size1 = 1; t.growTau = 1; t.drag = 0; t.buoyancy = 0; t.buoyTau = 1e9; t.gravity = 0;
    t.alpha = 1; t.fadeIn = 0; t.fadeOut = 0; t.visibleAt = 0; t.rotRate = 0; t.heat = 0; t.heatTau = 1; t.lighten = 0;
    t.bounce = 0; t.friction = 0; t.turbulence = 0; t.aspect = 1;
    t.tile = Math.floor(this.rnd() * 4); // smoke puff tiles 0–3
    return t;
  }

  private puff(pool: ParticlePool, wash: RotorWash, st: WashStyle, s: number): void {
    const t = this.base();
    this.place(t, wash, s, 1, 0.3 + 0.5 * this.rnd());
    t.vy = 0.4 + 1.4 * this.rnd() * (0.5 + 0.5 * Math.min(1, s));
    t.life = st.puffLife[0] + (st.puffLife[1] - st.puffLife[0]) * this.rnd();
    t.size0 = 1.2 + 0.8 * this.rnd();
    t.size1 = (st.puffSize[0] + (st.puffSize[1] - st.puffSize[0]) * this.rnd()) * (0.75 + 0.25 * Math.min(1, s));
    t.growTau = 0.7;
    t.drag = 1.0 + 0.4 * this.rnd();
    // The wall jet rolls up and lifts at its outer edge as it slows.
    t.buoyancy = st.puffGravity > 0 ? 0 : 1.1;
    t.buoyTau = 2.5;
    t.gravity = st.puffGravity;
    t.alpha = st.puffAlpha * Math.min(1.2, 0.35 + 0.65 * s) * (0.7 + 0.3 * this.rnd());
    t.fadeIn = 0.15;
    t.fadeOut = 0.6;
    const sh = 0.9 + 0.2 * this.rnd();
    t.r = st.puffColor[0] * sh; t.g = st.puffColor[1] * sh; t.b = st.puffColor[2] * sh;
    t.lighten = 0.35;
    t.turbulence = 1.6;
    t.rotRate = (this.rnd() - 0.5) * 0.8;
    pool.emit(t);
  }

  private fleck(pool: ParticlePool, wash: RotorWash, st: WashStyle, s: number): void {
    const t = this.base();
    const droplet = st.kind === 'spray';
    this.place(t, wash, s, droplet ? 0.8 : 0.7, 0.1 + 0.3 * this.rnd());
    t.vy = (droplet ? 1.5 : 1.2) + (droplet ? 3.5 : 2.8) * this.rnd() * (0.5 + 0.5 * Math.min(1, s));
    t.life = droplet ? 0.7 + 0.6 * this.rnd() : 0.8 + 0.7 * this.rnd();
    const size = st.fleckSize[0] + (st.fleckSize[1] - st.fleckSize[0]) * this.rnd();
    t.size0 = size;
    t.size1 = droplet ? size * 1.2 : size;
    t.growTau = 0.6;
    // Droplets fly ballistic; grass bits flutter (strong drag toward the air, slow fall).
    t.drag = droplet ? 0.5 : 1.8;
    t.gravity = droplet ? 9.8 : 5.5;
    t.bounce = droplet ? 0 : 0.15;
    t.friction = 5;
    t.alpha = st.fleckAlpha * (0.7 + 0.3 * this.rnd());
    t.fadeIn = 0.05;
    t.fadeOut = droplet ? 0.5 : 0.35;
    const sh = 0.8 + 0.4 * this.rnd();
    t.r = st.fleckColor[0] * sh; t.g = st.fleckColor[1] * sh; t.b = st.fleckColor[2] * sh;
    t.turbulence = droplet ? 0.4 : 2.5;
    t.rotRate = (this.rnd() - 0.5) * 12;
    pool.emit(t);
  }
}
