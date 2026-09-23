/**
 * PURE crash planning: what kind of impact it was (nose-in, skid, obstacle, ditching, bump), how
 * hard (0..1), and how each airframe part leaves the impact — the momentum it keeps (the ground
 * soaks up most of a dive but little of a skid), the explosion push away from the impact point
 * (∝ 1/√mass: heavy parts fly less), random tumbling (wings cartwheel, the engine pitches over),
 * and which parts stay on the ploughing fuselage and shear off later. Also the slow-motion and
 * crash-camera curves. No three.js; deterministic for a given random source.
 */
import { CONFIG } from '../config';
import type { CameraMode } from '../types';

export type ImpactKind = 'noseIn' | 'skid' | 'obstacle' | 'ditch' | 'bump';
export type PartRole = 'core' | 'wing' | 'tail' | 'engine' | 'prop' | 'gear' | 'canopy' | 'surface' | 'misc';

const C = CONFIG.crash;
const MS_TO_KT = 1.943844;

const fin = (v: number | undefined, d = 0) => (v !== undefined && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v: number) => clamp(v, 0, 1);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

/** The role of a breakup part from its name. */
export function partRole(name: string): PartRole {
  const n = String(name ?? '').toLowerCase();
  if (/flap|aileron|slat|spoiler|speedbrake|airbrake/.test(n)) return 'surface';
  if (/prop|spinner|blade|rotor/.test(n)) return 'prop';
  if (/gear|wheel|strut|leg|tyre|tire/.test(n)) return 'gear';
  if (/canopy|glass|door|window|windshield|windscreen/.test(n)) return 'canopy';
  if (/engine|cowl|nacelle|intake|nozzle|exhaust/.test(n)) return 'engine';
  if (/tail|fin|stab|elevator|rudder|empennage/.test(n)) return 'tail';
  if (/wing/.test(n)) return 'wing';
  if (/fuselage|body|exterior|hull|core|airframe/.test(n)) return 'core';
  return 'misc';
}

export interface ImpactInput {
  /** Velocity just before the impact, world m/s. */
  vx: number; vy: number; vz: number;
  /** The physics' crash reason ('Hit an obstacle', 'Ditched in water', …). */
  reason?: string;
  /** Impact on water. */
  water: boolean;
}

/** What kind of crash this is. */
export function classifyImpact(i: ImpactInput): ImpactKind {
  const reason = String(i.reason ?? '');
  if (i.water || /ditch|water/i.test(reason)) return 'ditch';
  const vx = fin(i.vx), vy = fin(i.vy), vz = fin(i.vz);
  const kt = Math.hypot(vx, vy, vz) * MS_TO_KT;
  if (kt < C.bumpKt) return 'bump';
  if (/obstacle|tree|building/i.test(reason)) return 'obstacle';
  const gamma = (Math.atan2(-vy, Math.hypot(vx, vz)) * 180) / Math.PI;
  return gamma >= C.noseInDeg ? 'noseIn' : 'skid';
}

/** 0 (a bump) … 1 (total break-up and explosion) from the impact speed in knots. */
export function impactSeverity(speedKt: number): number {
  if (!Number.isFinite(speedKt)) return 0;
  return smooth(C.bumpKt, C.fullKt, speedKt);
}

export interface PartSpec {
  name: string;
  mass: number;
  /** World centre of the part's collision box and its half extents. */
  x: number; y: number; z: number;
  hx: number; hy: number; hz: number;
  burning?: boolean;
}

export interface ImpactSpec {
  kind: ImpactKind;
  severity: number;
  /** Aircraft velocity and angular velocity (world) just before the impact. */
  vx: number; vy: number; vz: number;
  wx: number; wy: number; wz: number;
  /** Aircraft CG and the impact point (world). */
  cgx: number; cgy: number; cgz: number;
  ix: number; iy: number; iz: number;
}

export interface PartPlan {
  role: PartRole;
  vx: number; vy: number; vz: number;
  wx: number; wy: number; wz: number;
  /** Stays on the core body until detachAt (s, sim time) or a strike above breakImpulse (N·s). */
  attach: boolean;
  detachAt: number;
  breakImpulse: number;
  restitution: number;
  friction: number;
  float: number;
  floodTime: number;
  burning: boolean;
}

interface Keep { h: number; b: number }
/** Horizontal speed kept, and the fraction of the downward speed turned into an upward bounce. */
const KEEP: Record<ImpactKind, Partial<Record<PartRole, Keep>> & { other: Keep }> = {
  noseIn: { core: { h: 0.35, b: 0.12 }, wing: { h: 0.45, b: 0.3 }, tail: { h: 0.4, b: 0.42 }, engine: { h: 0.55, b: 0.3 }, prop: { h: 0.6, b: 0.35 }, other: { h: 0.5, b: 0.32 } },
  skid: { core: { h: 0.85, b: 0.05 }, engine: { h: 0.95, b: 0.25 }, prop: { h: 1.0, b: 0.3 }, gear: { h: 0.6, b: 0.2 }, other: { h: 0.8, b: 0.12 } },
  obstacle: { core: { h: 0.45, b: 0.1 }, wing: { h: 0.3, b: 0.2 }, tail: { h: 0.5, b: 0.2 }, engine: { h: 0.6, b: 0.2 }, prop: { h: 0.6, b: 0.3 }, other: { h: 0.45, b: 0.2 } },
  ditch: { core: { h: 0.55, b: 0.02 }, engine: { h: 0.6, b: 0.1 }, other: { h: 0.55, b: 0.05 } },
  bump: { core: { h: 0.8, b: 0 }, other: { h: 0.8, b: 0 } },
};

const REST: Record<PartRole, number> = { core: 0.12, wing: 0.3, tail: 0.3, engine: 0.22, prop: 0.35, gear: 0.4, canopy: 0.25, surface: 0.35, misc: 0.3 };
const FRICTION: Record<PartRole, number> = { core: 0.6, wing: 0.75, tail: 0.7, engine: 0.6, prop: 0.55, gear: 0.6, canopy: 0.6, surface: 0.7, misc: 0.65 };
/** Buoyancy (fraction of weight) and flooding time range (s). */
const FLOAT: Record<PartRole, [number, number, number]> = {
  core: [1.35, 14, 22], wing: [1.6, 25, 45], tail: [1.4, 18, 30], surface: [1.5, 20, 40], canopy: [1.2, 4, 8],
  engine: [0, 1, 1], prop: [0, 1, 1], gear: [0, 1, 1], misc: [0.8, 5, 10],
};
/** Shed times (s after the impact) for parts that ride the ploughing fuselage (skids, ditchings). */
const SHED: Partial<Record<PartRole, [number, number]>> = { wing: [0.25, 1.6], tail: [0.8, 2.6], surface: [0.1, 0.9], canopy: [0.3, 1.4], misc: [0.2, 1.8], gear: [0.05, 0.6] };

/**
 * Launch plan for every part: velocities, spins, attachments. `rnd` is a [0,1) source.
 * The core (fuselage) is the part with role 'core', else the heaviest; it is never attached.
 */
export function planBreakup(parts: readonly PartSpec[], imp: ImpactSpec, rnd: () => number): { core: number; plans: PartPlan[] } {
  const D = C.debris;
  const E = C.explosion;
  const R = () => {
    const r = rnd();
    return Number.isFinite(r) ? clamp(r, 0, 0.999999) : 0.5;
  };
  const kind: ImpactKind = imp.kind in KEEP ? imp.kind : 'bump';
  const sev = clamp01(fin(imp.severity));
  const cap = (x: number, m: number) => clamp(fin(x), -m, m);
  const vx = cap(imp.vx, D.maxSpeed), vy = cap(imp.vy, D.maxSpeed), vz = cap(imp.vz, D.maxSpeed);
  const wx = cap(imp.wx, D.maxSpin), wy = cap(imp.wy, D.maxSpin), wz = cap(imp.wz, D.maxSpin);
  const cgx = fin(imp.cgx), cgy = fin(imp.cgy), cgz = fin(imp.cgz);
  const ix = fin(imp.ix, cgx), iy = fin(imp.iy, cgy), iz = fin(imp.iz, cgz);
  const hs = Math.hypot(vx, vz);
  const fx = hs > 0.5 ? vx / hs : 0, fz = hs > 0.5 ? vz / hs : -1; // horizontal travel direction

  const roles = parts.map((p) => partRole(p.name));
  const massOf = (p: PartSpec) => clamp(fin(p.mass, 1), 0.5, 1e5);
  let core = roles.indexOf('core');
  if (core < 0) {
    core = 0;
    for (let i = 1; i < parts.length; i++) if (massOf(parts[i]) > massOf(parts[core])) core = i;
  }
  const lowSev = sev < 0.35;

  const plans: PartPlan[] = parts.map((p, i) => {
    const role = roles[i];
    const m = massOf(p);
    const px = fin(p.x, cgx), py = fin(p.y, cgy), pz = fin(p.z, cgz);
    // rigid-body velocity of this point of the aircraft
    const rx = px - cgx, ry = py - cgy, rz = pz - cgz;
    const vrx = vx + (wy * rz - wz * ry), vry = vy + (wz * rx - wx * rz), vrz = vz + (wx * ry - wy * rx);
    // the ground/obstacle reaction
    const K = KEEP[kind][role] ?? KEEP[kind].other;
    let ox = vrx * K.h, oz = vrz * K.h;
    let oy = vry < 0 ? -vry * K.b : vry * 0.5;
    // explosion push away from the impact point (up-biased)
    let push = kind === 'bump' ? 0 : E.speed * sev * Math.sqrt(E.refMass / m) * (0.6 + 0.8 * R());
    if (role === 'core') push *= 0.4;
    if (kind === 'ditch') push *= 0.3;
    push = Math.min(push, E.maxDv);
    let dx = px - ix, dy = py - iy, dz = pz - iz;
    const dl = Math.hypot(dx, dy, dz);
    if (dl > 1e-6) { dx /= dl; dy /= dl; dz /= dl; } else { dx = 0; dy = 1; dz = 0; }
    dy = Math.abs(dy) + 0.7;
    dx += (R() - 0.5) * 0.7; dy += (R() - 0.5) * 0.4; dz += (R() - 0.5) * 0.7;
    const nl = Math.hypot(dx, dy, dz) || 1;
    ox += (dx / nl) * push; oy += (dy / nl) * push; oz += (dz / nl) * push;
    // tumbling: random axis, lighter parts spin faster
    let spin = kind === 'bump' ? 0 : E.spin * sev * Math.pow(E.refMass / m, 0.4) * (0.4 + 0.9 * R());
    if (role === 'core') spin *= kind === 'skid' || kind === 'ditch' ? 0.15 : 0.45;
    let ax = R() * 2 - 1, ay = R() * 2 - 1, az = R() * 2 - 1;
    const al = Math.hypot(ax, ay, az) || 1;
    ax /= al; ay /= al; az /= al;
    let owx = wx + ax * spin, owy = wy + ay * spin, owz = wz + az * spin;
    if (role === 'wing' && kind !== 'bump') {
      // cartwheel: roll about the direction of travel
      const s = (R() < 0.5 ? -1 : 1) * (2 + 4 * R()) * sev;
      owx += fx * s; owz += fz * s;
    } else if ((role === 'engine' || role === 'prop') && kind !== 'bump') {
      // pitch over forward: about the lateral axis (travel × up)
      const s = (2 + 5 * R()) * sev;
      owx += -fz * s; owz += fx * s;
    } else if (role === 'core' && kind === 'skid') {
      // the fuselage slews round as it slides (a ground loop)
      owy += (R() < 0.5 ? -1 : 1) * (0.3 + 0.9 * R()) * sev;
    }
    // attachments: parts that ride the fuselage and shear off later
    let attach = false;
    let detachAt = 0;
    let breakImpulse = Infinity;
    if (i !== core) {
      if (kind === 'bump') {
        attach = true;
        detachAt = Infinity;
      } else if (kind === 'skid' || kind === 'ditch') {
        const shed = SHED[role];
        if (shed && !(kind === 'skid' && role === 'gear')) {
          attach = true;
          const lowKeep = lowSev && (role === 'wing' || role === 'tail');
          detachAt = lowKeep ? Infinity : shed[0] + (shed[1] - shed[0]) * R();
          breakImpulse = m * (lowKeep ? 20 : 6 + 6 * R());
        }
      } else if (lowSev && (role === 'wing' || role === 'tail' || role === 'surface' || role === 'canopy')) {
        attach = true;
        detachAt = Infinity;
        breakImpulse = m * 14;
      }
    }
    const fl = FLOAT[role];
    const burning = (p.burning ?? (role === 'core' || role === 'wing')) && kind !== 'ditch' && kind !== 'bump' && sev >= 0.25;
    let friction = FRICTION[role];
    if (role === 'core' && kind === 'skid') friction = 0.42;
    const plan: PartPlan = {
      role,
      vx: ox, vy: oy, vz: oz,
      wx: owx, wy: owy, wz: owz,
      attach, detachAt, breakImpulse,
      restitution: REST[role],
      friction,
      float: fl[0],
      floodTime: fl[1] + (fl[2] - fl[1]) * R(),
      burning,
    };
    return plan;
  });
  // Attached parts start with the core's motion at their point (no spurious spin from the merge).
  const cp = plans[core];
  const cc = parts[core];
  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    if (!p.attach) continue;
    const rx = fin(parts[i].x) - fin(cc.x), ry = fin(parts[i].y) - fin(cc.y), rz = fin(parts[i].z) - fin(cc.z);
    p.vx = cp.vx + (cp.wy * rz - cp.wz * ry);
    p.vy = cp.vy + (cp.wz * rx - cp.wx * rz);
    p.vz = cp.vz + (cp.wx * ry - cp.wy * rx);
    p.wx = cp.wx; p.wy = cp.wy; p.wz = cp.wz;
  }
  for (const p of plans) {
    const s = Math.hypot(p.vx, p.vy, p.vz);
    if (!(s <= D.maxSpeed)) {
      const k = Number.isFinite(s) && s > 0 ? D.maxSpeed / s : 0;
      p.vx *= k; p.vy *= k; p.vz *= k;
    }
    const w = Math.hypot(p.wx, p.wy, p.wz);
    if (!(w <= D.maxSpin)) {
      const k = Number.isFinite(w) && w > 0 ? D.maxSpin / w : 0;
      p.wx *= k; p.wy *= k; p.wz *= k;
    }
    for (const k of ['vx', 'vy', 'vz', 'wx', 'wy', 'wz'] as const) if (!Number.isFinite(p[k])) p[k] = 0;
  }
  return { core, plans };
}

// ── Time and camera curves ─────────────────────────────────────────────────

/** Debris/effects time scale `t` s (real time) after the impact: slow motion, then real time. */
export function crashTimeScale(t: number, S = C.slowMo): number {
  if (!Number.isFinite(t)) return 1;
  if (t <= S.hold) return S.scale;
  if (t >= S.hold + S.ramp) return 1;
  return S.scale + (1 - S.scale) * smooth(S.hold, S.hold + S.ramp, t);
}

/** How far (0..1) the crash camera has taken over from the player's camera, `t` s after the impact. */
export function crashCameraBlend(t: number, mode: CameraMode, K = C.camera): number {
  if (!Number.isFinite(t) || t <= 0) return 0;
  if (mode === 'cockpit') return smooth(0.05, 0.8, t);
  return smooth(K.blendStart, K.blendEnd, t);
}

/** Camera distance that frames a debris field of RMS radius `spread` m. */
export function frameDistance(spread: number, K = C.camera): number {
  if (!Number.isFinite(spread) || spread <= 0) return K.minDistance;
  return clamp(spread * K.fitScale, K.minDistance, K.maxDistance);
}

/** Impact shake envelope 0..1, `t` s (real time) after the impact. */
export function crashShake(t: number, K = C.camera): number {
  if (!Number.isFinite(t) || t < 0) return 0;
  return Math.exp(-t / K.shakeTau);
}
