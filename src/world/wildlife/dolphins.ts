/**
 * Bottlenose dolphins (PURE, no three.js, no allocation per frame).
 *
 * Coastal pods of 3–8 swim wandering loops in water ≥ 5 m deep, clear of every structure of the
 * sea (zones.ts). A member's place is a pure function of the sea clock: the pod's point on its
 * loop, the member's slot in the pod plus a slow weave, and a breathing cycle — most of the time
 * 1–2.5 m down, then an arc that brings the blowhole and the dorsal fin up through the surface
 * (a puff of breath as it breaks, a small splash as it goes back under), now and then a clean leap.
 *
 * Bow riding (the one stateful part): when the player drives a vessel at 6–25 kt within 300 m of a
 * pod, the pod comes over (porpoising), holds station in the bow's pressure wave — some just
 * ahead of the stem weaving across it, some beside the forward sections — surfacing every few
 * seconds, and after a minute or two peels off, dives and swims home underwater until it is back
 * on its deterministic track. Members steer with limited acceleration (positions are continuous)
 * and no member's centre ever enters the hull's plan footprint grown by a clearance.
 *
 * Ship pods play in the bow waves of the big ships (container ship, tanker, ferry) during ride
 * windows derived from the traffic clock — pure again.
 *
 * Heights are relative to the drawn sea surface (`dy`, + above it): the renderer adds the wave
 * height (surface.ts). Frame: world +X east, +Z south; heading clockwise from north; vessel body
 * frame = three.js object frame (bow −Z, +X starboard).
 */
import { samplePath, newPathSample, type Path } from '../traffic/path';
import { h01, hRange, KT, clamp, smooth } from '../traffic/rng';
import type { WaterWorld } from '../traffic/sea';
import { WILDLIFE } from './tuning';
import { fitLoop, seaDepthAt, type ZoneContext } from './zones';

const DEG = Math.PI / 180;
const RAD = 180 / Math.PI;
const T = WILDLIFE.dolphin;
const SEED = WILDLIFE.seed;

export interface PodDef {
  id: string;
  kind: 'coastal' | 'ship';
  n: number;
  /** Coastal pods: the loop and the speed along it (m/s), arc offset at t = 0. */
  route: Path | null;
  speed: number;
  phase: number;
  /** Ship pods: the traffic route id of the ship. */
  ship: string | null;
  /** Index of the pod's first member in the plan's member list. */
  first: number;
}

export interface MemberDef {
  pod: number;
  /** Index within the pod. */
  k: number;
  /** Body length (m). */
  length: number;
  /** Slot in the pod: metres ahead of / to the right of the pod's centre. */
  along: number;
  across: number;
  /** Weave phases, breathing period (s) and offset (s), depth bias (m). */
  ph1: number;
  ph2: number;
  period: number;
  offset: number;
  depth: number;
  key: number;
}

export interface DolphinPlan {
  pods: PodDef[];
  members: MemberDef[];
  /** Pods left out because no loop fitted (expected empty). */
  rejected: string[];
}

/** Builds the pods (validated loops) and their members. Deterministic from the world + tuning. */
export function createDolphinPlan(ctx: ZoneContext, water: WaterWorld, shipRoutes: readonly string[] = T.shipPods.map((s) => s.route)): DolphinPlan {
  const pods: PodDef[] = [];
  const members: MemberDef[] = [];
  const rejected: string[] = [];
  const addMembers = (podIndex: number, n: number, spread: number) => {
    for (let k = 0; k < n; k++) {
      const key = podIndex * 16 + k;
      const ring = k === 0 ? 0 : 1 + Math.floor((k - 1) / 3);
      const ang = hRange(SEED, 7100, key, 0, Math.PI * 2);
      members.push({
        pod: podIndex,
        k,
        length: T.length * (1 + (h01(SEED, 7101, key) - 0.5) * 2 * T.sizeSpread) * (k === n - 1 && n > 4 ? 0.62 : 1),
        along: Math.cos(ang) * ring * spread,
        across: Math.sin(ang) * ring * spread * 0.8,
        ph1: hRange(SEED, 7102, key, 0, Math.PI * 2),
        ph2: hRange(SEED, 7103, key, 0, Math.PI * 2),
        period: hRange(SEED, 7104, key, T.breathe.cruise[0], T.breathe.cruise[1]),
        offset: hRange(SEED, 7105, key, 0, 30),
        depth: hRange(SEED, 7106, key, -0.4, 0.6),
        key,
      });
    }
  };
  T.pods.forEach((p, i) => {
    const route = fitLoop(ctx, water, 'dolphin', p, 100 + i, T.minDepth, 18);
    if (!route) {
      rejected.push(`pod-${i}`);
      return;
    }
    const idx = pods.length;
    pods.push({ id: `pod-${i}`, kind: 'coastal', n: p.n, route, speed: p.speed, phase: h01(SEED, 7000, i) * route.length, ship: null, first: members.length });
    addMembers(idx, p.n, 3.2);
  });
  T.shipPods.forEach((s, i) => {
    if (!shipRoutes.includes(s.route)) return;
    const idx = pods.length;
    pods.push({ id: `ship-${s.route}`, kind: 'ship', n: s.n, route: null, speed: 0, phase: hRange(SEED, 7010, i, 0, T.shipRide.period), ship: s.route, first: members.length });
    addMembers(idx, s.n, 3);
  });
  return { pods, members, rejected };
}

// ─── Pure pieces ──────────────────────────────────────────────────────────────

export interface PodFrame {
  x: number;
  z: number;
  heading: number;
  speed: number;
}

const _ps = newPathSample();

/** A coastal pod's centre at sea-clock time t. */
export function podFrame(pod: PodDef, t: number, out: PodFrame): PodFrame {
  if (!pod.route) {
    out.x = out.z = out.heading = out.speed = 0;
    return out;
  }
  samplePath(pod.route, pod.phase + pod.speed * t, _ps);
  out.x = _ps.x;
  out.z = _ps.z;
  out.heading = _ps.heading;
  out.speed = pod.speed;
  return out;
}

export type BreathStyle = 'cruise' | 'porpoise' | 'ride' | 'deep';

interface StyleDef {
  depth: number;
  rollH: number;
  rollA: number;
  leapH: number;
  leapA: number;
  leap: number;
  /** Period scale (× the member's cruising period) or fixed range. */
  period: (m: MemberDef) => number;
}

const STYLES: Record<BreathStyle, StyleDef> = {
  cruise: { depth: 1.8, rollH: 0.2, rollA: 2.0, leapH: 1.9, leapA: 2.6, leap: T.leap.cruise, period: (m) => m.period },
  porpoise: { depth: 1.0, rollH: 0.45, rollA: 1.45, leapH: 1.4, leapA: 2.1, leap: 0.3, period: (m) => 2.6 + (m.period - T.breathe.cruise[0]) * 0.08 },
  ride: { depth: 0.6, rollH: 0.34, rollA: 1.5, leapH: 1.4, leapA: 2.0, leap: T.leap.ride, period: (m) => T.breathe.ride[0] + ((m.period - T.breathe.cruise[0]) / (T.breathe.cruise[1] - T.breathe.cruise[0])) * (T.breathe.ride[1] - T.breathe.ride[0]) },
  deep: { depth: 3.0, rollH: 0.04, rollA: 1.6, leapH: 0.04, leapA: 1.6, leap: 0, period: (m) => m.period * 1.3 },
};

export interface Breath {
  /** Body centre height above the surface (m) and its rate (m/s). */
  dy: number;
  rate: number;
  /** In a surfacing arc: its start time (s), duration (s), cruise depth and peak (m), leap. */
  arcStart: number;
  arcLen: number;
  depth: number;
  peak: number;
  leap: boolean;
  inArc: boolean;
}

export const newBreath = (): Breath => ({ dy: 0, rate: 0, arcStart: 0, arcLen: 1, depth: 1, peak: 0, leap: false, inArc: false });

function arcOf(m: MemberDef, style: BreathStyle, k: number, out: Breath): void {
  const s = STYLES[style];
  const leap = s.leap > 0 && h01(SEED, 7200 + (style === 'ride' ? 1 : 0), m.key * 7919 + k) < s.leap;
  out.leap = leap;
  out.peak = leap ? s.leapH * (0.8 + 0.4 * h01(SEED, 7201, m.key * 31 + k)) * Math.sqrt(m.length / T.length) : s.rollH * Math.sqrt(m.length / T.length);
  out.arcLen = leap ? s.leapA : s.rollA;
}

/**
 * The breathing cycle of member m at time t: a smooth cruising depth, then (at the start of each
 * cycle) a sine arc up through the surface and back. Pure.
 */
export function breath(m: MemberDef, style: BreathStyle, t: number, out: Breath): Breath {
  const s = STYLES[style];
  const P = s.period(m);
  const tt = t + m.offset;
  const k = Math.floor(tt / P);
  const tau = tt - k * P;
  const D = Math.max(0.5, s.depth + m.depth * (style === 'ride' ? 0.3 : 1) + 0.35 * Math.sin(0.23 * t + m.ph1));
  const dD = 0.35 * 0.23 * Math.cos(0.23 * t + m.ph1);
  arcOf(m, style, k, out);
  out.depth = D;
  out.arcStart = t - tau;
  if (tau < out.arcLen) {
    const a = Math.PI * (tau / out.arcLen);
    out.dy = -D + (D + out.peak) * Math.sin(a);
    out.rate = -dD + dD * Math.sin(a) + ((D + out.peak) * Math.PI * Math.cos(a)) / out.arcLen;
    out.inArc = true;
  } else {
    out.dy = -D;
    out.rate = -dD;
    out.inArc = false;
  }
  return out;
}

/** Water events of an arc: the blowhole breaking the surface (puff) and the re-entry (splash), s after the arc's start. */
export function arcEvents(b: Pick<Breath, 'depth' | 'peak' | 'arcLen'>): { up: number; down: number } {
  const f = Math.asin(clamp(b.depth / (b.depth + b.peak), 0, 1)) / Math.PI;
  return { up: f * b.arcLen, down: (1 - f) * b.arcLen };
}

export interface DolphinPose {
  x: number;
  z: number;
  /** Body centre above the drawn surface (m). */
  dy: number;
  heading: number;
  pitch: number;
  roll: number;
  /** Speed through the water (m/s). */
  speed: number;
  visible: boolean;
}

export const newDolphinPose = (): DolphinPose => ({ x: 0, z: 0, dy: -2, heading: 0, pitch: 0, roll: 0, speed: 0, visible: false });

const _pf: PodFrame = { x: 0, z: 0, heading: 0, speed: 0 };
const _br = newBreath();

/** Where member m of a coastal pod swims at time t (pure): slot + weave on the pod's loop, breathing. */
export function freeMemberXZ(pod: PodDef, m: MemberDef, t: number, out: { x: number; z: number; heading: number; speed: number }): void {
  podFrame(pod, t, _pf);
  const along = m.along + 1.6 * Math.sin(0.21 * t + m.ph1);
  const across = m.across + 1.2 * Math.sin(0.17 * t + m.ph2);
  const dAlong = 1.6 * 0.21 * Math.cos(0.21 * t + m.ph1);
  const dAcross = 1.2 * 0.17 * Math.cos(0.17 * t + m.ph2);
  const h = _pf.heading * DEG;
  const fx = Math.sin(h);
  const fz = -Math.cos(h);
  out.x = _pf.x + fx * along - fz * across;
  out.z = _pf.z + fz * along + fx * across;
  const vf = _pf.speed + dAlong;
  out.heading = (_pf.heading + Math.atan2(dAcross, Math.max(0.3, vf)) * RAD + 360) % 360;
  out.speed = Math.hypot(vf, dAcross);
}

export function freeMemberPose(pod: PodDef, m: MemberDef, t: number, out: DolphinPose): DolphinPose {
  freeMemberXZ(pod, m, t, out);
  breath(m, 'cruise', t, _br);
  out.dy = _br.dy;
  out.pitch = clamp(Math.atan2(_br.rate, Math.max(0.8, out.speed)) * RAD, -75, 75);
  out.roll = 6 * Math.sin(0.31 * t + m.ph2);
  out.visible = true;
  return out;
}

// ─── Bow slots ───────────────────────────────────────────────────────────────

export interface HullBox {
  /** Body z of the stem and transom (bow −z), m. */
  stemZ: number;
  transomZ: number;
  beam: number;
}

/**
 * Member k's place in the bow wave (body frame of the vessel: bx + starboard, bz along, bow −z) at
 * time t: "crossers" hold 3–7 m ahead of the stem and weave across it; "flankers" ride beside the
 * forward sections just outside the beam. Always outside the hull box grown by `clear` + half a body.
 */
export function bowSlot(k: number, t: number, hull: HullBox, bodyLen: number, out: { bx: number; bz: number }): { bx: number; bz: number } {
  const clear = T.ride.hullClearance;
  const half = hull.beam / 2;
  const L = hull.transomZ - hull.stemZ;
  const ph = k * 1.93;
  const role = SLOT_ROLE[k % SLOT_ROLE.length];
  const rank = Math.floor(k / SLOT_ROLE.length) + role.rank;
  if (role.side === 0) {
    // ahead of the stem, far enough that the tail clears the forefoot, weaving across the bow
    const ahead = 0.5 * bodyLen + clear + 1.2 + 2.7 * rank + 0.5 * (1 + Math.sin(0.37 * t + ph));
    out.bz = hull.stemZ - ahead;
    out.bx = Math.min(half + 1, 2.2) * Math.sin(0.29 * t + ph);
  } else if (role.side === 4 || role.side === -4) {
    // surfing the crest of the diverging bow wave, out from the forward quarter
    const aft = 3 + 3 * rank + 1.2 * Math.sin(0.19 * t + ph);
    out.bz = hull.stemZ + aft;
    out.bx = Math.sign(role.side) * (half + clear + 1.5 + 0.36 * aft + 1.5 * (1 + Math.sin(0.23 * t + ph)));
  } else if (role.side === 3 || role.side === -3) {
    // alongside the after body, in the quarter wave
    out.bz = hull.transomZ - 0.35 * L + 2.5 * rank + 1.5 * Math.sin(0.17 * t + ph);
    out.bx = Math.sign(role.side) * (half + clear + 1.0 + 0.8 * rank + 0.6 * (1 + Math.sin(0.27 * t + ph)));
  } else if (role.side === 2) {
    // out ahead in the pressure wave's leading edge, weaving wide
    const ahead = 0.5 * bodyLen + clear + 7 + 3.5 * rank + 1.0 * (1 + Math.sin(0.19 * t + ph));
    out.bz = hull.stemZ - ahead;
    out.bx = Math.min(half + 3, 4.5) * Math.sin(0.21 * t + ph);
  } else {
    const aft = Math.min(0.3 * L, 1.2 + 2.2 * rank) + 0.7 * Math.sin(0.23 * t + ph);
    out.bz = hull.stemZ + aft;
    out.bx = role.side * (half + clear + 0.7 + 1.3 * rank + 0.5 * (1 + Math.sin(0.41 * t + ph)));
  }
  return out;
}

/**
 * Bow-wave roles by member: 0 = just ahead of the stem (weaving), 2 = further ahead, ±1 = flanking
 * the forward sections to starboard / port, ±4 = out on the diverging bow wave's crest, ±3 = alongside
 * the after body in the quarter wave; rank = how far out.
 */
const SLOT_ROLE: readonly { side: 0 | 1 | -1 | 2 | 3 | -3 | 4 | -4; rank: number }[] = [
  { side: 0, rank: 0 },
  { side: 1, rank: 0 },
  { side: -1, rank: 0 },
  { side: 3, rank: 0 },
  { side: 4, rank: 0 },
  { side: -3, rank: 0 },
  { side: -4, rank: 0 },
  { side: 2, rank: 0 },
];

/** True when the segment between two body-frame points (endpoints excluded) passes through the hull box grown by `clear`. */
export function segmentHitsHull(ax: number, az: number, bx: number, bz: number, hull: HullBox, clear: number): boolean {
  for (let s = 1; s < 12; s++) {
    const f = s / 12;
    if (insideHull(ax + (bx - ax) * f, az + (bz - az) * f, hull, clear)) return true;
  }
  return false;
}

/** True when a point (body frame) is inside the hull box grown by `clear`. */
export function insideHull(bx: number, bz: number, hull: HullBox, clear: number): boolean {
  return Math.abs(bx) < hull.beam / 2 + clear && bz > hull.stemZ - clear && bz < hull.transomZ + clear;
}

// ─── The simulation (bow riding) ─────────────────────────────────────────────

export interface VesselInfo {
  x: number;
  z: number;
  /** Hull heading (bow direction), deg. */
  heading: number;
  /** Speed through the water (m/s, + ahead) and world velocity (m/s). */
  speed: number;
  vx: number;
  vz: number;
  hull: HullBox;
}

export type RideMode = 'free' | 'approach' | 'ride' | 'peel' | 'home';

export interface ShipTrack {
  x: number;
  z: number;
  /** Direction of travel (deg) and speed (m/s). */
  course: number;
  speed: number;
  hull: HullBox;
  valid: boolean;
}

export interface DolphinFrame {
  /** Sea clock (s): coastal pods. */
  t: number;
  /** Frame step (s, 0 while paused). */
  dt: number;
  /** Traffic clock (s): ship pods. */
  trafficT: number;
  camX: number;
  camZ: number;
  /** The player's vessel (null when flying or none). */
  vessel: VesselInfo | null;
  /** Ship tracks by ship pod index order (plan.pods of kind 'ship'). */
  ships: readonly ShipTrack[];
}

export interface PodState {
  mode: RideMode;
  /** Seconds in the current mode; seconds left before this pod may engage again. */
  timer: number;
  cooldown: number;
  engagements: number;
  rideFor: number;
  outside: number;
}

/**
 * Runs every pod: pure poses for the free ones (near the camera), the bow-riding state machine for
 * an engaged one. `poses[i]` is member i's pose after `update`.
 */
export class DolphinSim {
  readonly plan: DolphinPlan;
  readonly poses: DolphinPose[];
  readonly pods: PodState[];
  /** Stateful member kinematics (world x, z, velocity), smoothed height and heading. */
  private readonly px: Float64Array;
  private readonly pz: Float64Array;
  private readonly vx: Float64Array;
  private readonly vz: Float64Array;
  private readonly dyS: Float64Array;
  private readonly rateS: Float64Array;
  private readonly hdg: Float64Array;
  /** Members' breathing style this frame (events use it). */
  readonly styles: BreathStyle[];
  private readonly water: WaterWorld | null;
  private readonly tmp = { x: 0, z: 0, heading: 0, speed: 0 };
  private readonly tmp2 = { x: 0, z: 0, heading: 0, speed: 0 };
  private readonly slot = { bx: 0, bz: 0 };
  private readonly br = newBreath();
  /** Pod index riding the player, or −1. */
  riding = -1;

  constructor(plan: DolphinPlan, water: WaterWorld | null = null) {
    this.plan = plan;
    this.water = water;
    const n = plan.members.length;
    this.poses = plan.members.map(() => newDolphinPose());
    this.pods = plan.pods.map(() => ({ mode: 'free' as RideMode, timer: 0, cooldown: 0, engagements: 0, rideFor: 0, outside: 0 }));
    this.px = new Float64Array(n);
    this.pz = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vz = new Float64Array(n);
    this.dyS = new Float64Array(n);
    this.rateS = new Float64Array(n);
    this.hdg = new Float64Array(n);
    this.styles = plan.members.map(() => 'cruise' as BreathStyle);
  }

  /** Back to the deterministic tracks (reset / vessel change). */
  reset(): void {
    for (const s of this.pods) {
      s.mode = 'free';
      s.timer = 0;
      s.cooldown = 0;
      s.outside = 0;
    }
    this.riding = -1;
  }

  update(f: DolphinFrame): void {
    const { pods, members } = this.plan;
    const drawR = T.drawDistance + 250;
    // engage: the nearest free coastal pod in reach of a vessel in the speed window
    const v = f.vessel;
    if (v && this.riding < 0) {
      const kt = v.speed / KT;
      if (kt >= T.ride.minKt && kt <= T.ride.maxKt) {
        let best = -1;
        let bd: number = T.ride.reach;
        for (let p = 0; p < pods.length; p++) {
          const pod = pods[p];
          const st = this.pods[p];
          if (pod.kind !== 'coastal' || st.mode !== 'free' || st.cooldown > 0) continue;
          podFrame(pod, f.t, _pf);
          const d = Math.hypot(_pf.x - v.x, _pf.z - v.z);
          if (d < bd) {
            bd = d;
            best = p;
          }
        }
        if (best >= 0) this.engage(best, f.t);
      }
    }
    let shipIdx = 0;
    for (let p = 0; p < pods.length; p++) {
      const pod = pods[p];
      const st = this.pods[p];
      if (st.cooldown > 0) st.cooldown = Math.max(0, st.cooldown - f.dt);
      if (pod.kind === 'ship') {
        const track = f.ships[shipIdx++];
        for (let k = 0; k < pod.n; k++) this.shipMember(pod, members[pod.first + k], f, track, this.poses[pod.first + k]);
        continue;
      }
      if (st.mode === 'free' && v && Math.hypot(v.x - podFrame(pod, f.t, _pf).x, v.z - _pf.z) < DODGE_RANGE + (v.hull.transomZ - v.hull.stemZ)) {
        this.dodge(p, f.t);
      }
      if (st.mode === 'free') {
        podFrame(pod, f.t, _pf);
        const far = Math.hypot(_pf.x - f.camX, _pf.z - f.camZ) > drawR;
        for (let k = 0; k < pod.n; k++) {
          const i = pod.first + k;
          const pose = this.poses[i];
          if (far) {
            pose.visible = false;
            continue;
          }
          freeMemberPose(pod, members[i], f.t, pose);
          this.styles[i] = 'cruise';
          if (v) this.guard(pose, v);
        }
        continue;
      }
      this.stepEngaged(p, f);
    }
  }

  private engage(p: number, t: number): void {
    const st = this.pods[p];
    st.mode = 'approach';
    st.timer = 0;
    st.outside = 0;
    st.rideFor = hRange(SEED, 7300, p * 97 + st.engagements, T.ride.duration[0], T.ride.duration[1]);
    st.engagements++;
    this.riding = p;
    this.handOver(p, t);
  }

  /** A vessel passing through a free pod: the members dodge it (steered, so they move continuously) and then rejoin their track. */
  private dodge(p: number, t: number): void {
    const st = this.pods[p];
    st.mode = 'home';
    st.timer = 0;
    this.handOver(p, t);
  }

  /** Hand over from the pure track: position, velocity, height and heading carry on smoothly. */
  private handOver(p: number, t: number): void {
    const pod = this.plan.pods[p];
    for (let k = 0; k < pod.n; k++) {
      const i = pod.first + k;
      const m = this.plan.members[i];
      freeMemberXZ(pod, m, t, this.tmp);
      freeMemberXZ(pod, m, t + 0.1, this.tmp2);
      this.px[i] = this.tmp.x;
      this.pz[i] = this.tmp.z;
      this.vx[i] = (this.tmp2.x - this.tmp.x) / 0.1;
      this.vz[i] = (this.tmp2.z - this.tmp.z) / 0.1;
      breath(m, 'cruise', t, this.br);
      this.dyS[i] = this.br.dy;
      this.rateS[i] = this.br.rate;
      this.hdg[i] = this.tmp.heading;
    }
  }

  private setMode(p: number, mode: RideMode): void {
    const st = this.pods[p];
    st.mode = mode;
    st.timer = 0;
    if (mode === 'peel') st.cooldown = T.ride.cooldown + T.ride.peel;
    if (mode === 'free' || mode === 'home') {
      if (this.riding === p) this.riding = -1;
    }
  }

  private stepEngaged(p: number, f: DolphinFrame): void {
    const pod = this.plan.pods[p];
    const st = this.pods[p];
    const R = T.ride;
    const dt = f.dt;
    const v = f.vessel;
    st.timer += dt;
    // ── mode transitions ──
    if (st.mode === 'approach' || st.mode === 'ride') {
      const kt = v ? v.speed / KT : 0;
      const inWindow = !!v && kt >= R.holdMinKt && kt <= R.holdMaxKt;
      st.outside = inWindow ? 0 : st.outside + dt;
      if (!v || st.outside > 4) this.setMode(p, 'peel');
      else if (st.mode === 'approach') {
        let worst = 0;
        for (let k = 0; k < pod.n; k++) {
          const i = pod.first + k;
          this.slotWorld(k, f.t, v, this.plan.members[i].length);
          worst = Math.max(worst, Math.hypot(this.tmp.x - this.px[i], this.tmp.z - this.pz[i]));
        }
        if (worst < 4) this.setMode(p, 'ride');
        else if (st.timer > R.approachTimeout) this.setMode(p, 'peel');
      } else if (st.timer > st.rideFor) this.setMode(p, 'peel');
    } else if (st.mode === 'peel' && st.timer > R.peel) {
      this.setMode(p, 'home');
    }
    const mode = st.mode;
    let worstHome = 0;
    for (let k = 0; k < pod.n; k++) {
      const i = pod.first + k;
      const m = this.plan.members[i];
      const pose = this.poses[i];
      // ── target position / velocity ──
      let tx = this.px[i];
      let tz = this.pz[i];
      let tvx = 0;
      let tvz = 0;
      let kp = 0.9;
      let vmax: number = R.burst;
      let style: BreathStyle = 'cruise';
      if ((mode === 'approach' || mode === 'ride') && v) {
        this.slotWorld(k, f.t, v, m.length);
        tx = this.tmp.x;
        tz = this.tmp.z;
        tvx = v.vx;
        tvz = v.vz;
        const vs = Math.hypot(v.vx, v.vz);
        vmax = mode === 'approach' ? Math.max(R.burst, vs + R.catchUp) : vs + R.catchUp;
        kp = mode === 'approach' ? 0.6 : 1.4;
        style = mode === 'approach' ? 'porpoise' : 'ride';
        // never through the hull: go round it (along the near side, then round the stem)
        this.toBody(tx, tz, v);
        const tbx = this.slot.bx;
        const tbz = this.slot.bz;
        this.toBody(this.px[i], this.pz[i], v);
        const dbx = this.slot.bx;
        const dbz = this.slot.bz;
        if (segmentHitsHull(dbx, dbz, tbx, tbz, v.hull, R.hullClearance + 0.3)) {
          const half = v.hull.beam / 2 + R.hullClearance + 2.5;
          const front = v.hull.stemZ - R.hullClearance - 2.5;
          if (dbz < v.hull.stemZ - R.hullClearance - 1.5) this.fromBody((tbx >= 0 ? 1 : -1) * half, front, v);
          else this.fromBody((dbx >= 0 ? 1 : -1) * half, Math.max(front, dbz - 8), v);
          tx = this.tmp.x;
          tz = this.tmp.z;
        }
      } else if (mode === 'peel') {
        // veer off, slow and dive
        const h = this.hdg[i] * DEG;
        const side = k % 2 === 0 ? 1 : -1;
        tvx = Math.sin(h) * 2.5 + Math.cos(h) * side * 2.5;
        tvz = -Math.cos(h) * 2.5 + Math.sin(h) * side * 2.5;
        tx = this.px[i] + tvx;
        tz = this.pz[i] + tvz;
        kp = 0;
        vmax = R.burst;
        style = 'deep';
      } else if (mode === 'home') {
        freeMemberXZ(pod, m, f.t, this.tmp);
        freeMemberXZ(pod, m, f.t + 0.1, this.tmp2);
        tx = this.tmp.x;
        tz = this.tmp.z;
        tvx = (this.tmp2.x - this.tmp.x) / 0.1;
        tvz = (this.tmp2.z - this.tmp.z) / 0.1;
        const d = Math.hypot(tx - this.px[i], tz - this.pz[i]);
        worstHome = Math.max(worstHome, d);
        vmax = d > 25 ? R.homeSpeed + pod.speed : R.burst;
        kp = 0.7;
        style = d > 25 ? 'deep' : 'cruise';
      }
      // ── steer: desired velocity = feed-forward + proportional, limited acceleration ──
      if (dt > 0) {
        let dvx = tvx + kp * (tx - this.px[i]);
        let dvz = tvz + kp * (tz - this.pz[i]);
        const dm = Math.hypot(dvx, dvz);
        if (dm > vmax) {
          dvx *= vmax / dm;
          dvz *= vmax / dm;
        }
        let ax = (dvx - this.vx[i]) / dt;
        let az = (dvz - this.vz[i]) / dt;
        const am = Math.hypot(ax, az);
        const amax = mode === 'ride' ? R.accel * 2 : R.accel;
        if (am > amax) {
          ax *= amax / am;
          az *= amax / am;
        }
        this.vx[i] += ax * dt;
        this.vz[i] += az * dt;
        this.px[i] += this.vx[i] * dt;
        this.pz[i] += this.vz[i] * dt;
      }
      // ── height: the style's breathing, low-passed across style changes ──
      breath(m, style, f.t, this.br);
      if (dt > 0) {
        const kk = 1 - Math.exp(-7 * dt);
        this.dyS[i] += (this.br.dy - this.dyS[i]) * kk;
        this.rateS[i] += (this.br.rate - this.rateS[i]) * kk;
      }
      this.styles[i] = style;
      // ── heading along the velocity through the water, rate limited ──
      const wvx = this.vx[i];
      const wvz = this.vz[i];
      const spd = Math.hypot(wvx, wvz);
      if (spd > 0.3 && dt > 0) {
        const want = Math.atan2(wvx, -wvz) * RAD;
        let d = want - this.hdg[i];
        d = ((((d + 180) % 360) + 360) % 360) - 180;
        const maxTurn = 140 * dt;
        this.hdg[i] = (this.hdg[i] + clamp(d, -maxTurn, maxTurn) + 360) % 360;
      }
      pose.x = this.px[i];
      pose.z = this.pz[i];
      pose.dy = this.dyS[i];
      pose.heading = this.hdg[i];
      pose.speed = spd;
      pose.pitch = clamp(Math.atan2(this.rateS[i], Math.max(0.8, spd)) * RAD, -75, 75);
      pose.roll = mode === 'ride' ? 10 * Math.sin(0.5 * f.t + m.ph2) : 5 * Math.sin(0.31 * f.t + m.ph2);
      pose.visible = true;
      if (v) {
        if (this.guard(pose, v)) {
          this.px[i] = pose.x;
          this.pz[i] = pose.z;
          // no velocity into the hull: take the vessel's
          this.vx[i] = v.vx;
          this.vz[i] = v.vz;
        }
      }
    }
    // back on the pure track — but only once clear of the vessel (hysteresis over the dodge range)
    const clearOfVessel = !v || Math.hypot(v.x - podFrame(pod, f.t, _pf).x, v.z - _pf.z) > DODGE_RANGE + 25 + (v.hull.transomZ - v.hull.stemZ);
    if (mode === 'home' && clearOfVessel && (worstHome < 0.15 || st.timer > 240)) this.setMode(p, 'free');
  }

  /** Pushes a pose out of the vessel's hull box (sideways). Returns true if it moved. */
  private guard(pose: DolphinPose, v: VesselInfo): boolean {
    const clear = T.ride.hullClearance;
    this.toBody(pose.x, pose.z, v);
    if (!insideHull(this.slot.bx, this.slot.bz, v.hull, clear)) return false;
    const half = v.hull.beam / 2 + clear + 1e-3;
    // out the nearest way: sideways, ahead of the stem or astern of the transom
    const side = this.slot.bx >= 0 ? 1 : -1;
    const dSide = half - Math.abs(this.slot.bx);
    const dAhead = this.slot.bz - (v.hull.stemZ - clear - 1e-3);
    const dAft = v.hull.transomZ + clear + 1e-3 - this.slot.bz;
    if (dAhead < dSide && dAhead <= dAft) this.fromBody(this.slot.bx, v.hull.stemZ - clear - 1e-3, v);
    else if (dAft < dSide) this.fromBody(this.slot.bx, v.hull.transomZ + clear + 1e-3, v);
    else this.fromBody(side * half, this.slot.bz, v);
    pose.x = this.tmp.x;
    pose.z = this.tmp.z;
    return true;
  }

  /** World → vessel body (into this.slot). */
  private toBody(x: number, z: number, v: VesselInfo): void {
    const h = v.heading * DEG;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    const dx = x - v.x;
    const dz = z - v.z;
    // right = (−fz, fx); body z = −forward
    this.slot.bx = dx * -fz + dz * fx;
    this.slot.bz = -(dx * fx + dz * fz);
  }

  /** Vessel body → world (into this.tmp). */
  private fromBody(bx: number, bz: number, v: VesselInfo): void {
    const h = v.heading * DEG;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    this.tmp.x = v.x - fz * bx - fx * bz;
    this.tmp.z = v.z + fx * bx - fz * bz;
  }

  private slotWorld(k: number, t: number, v: VesselInfo, len: number): void {
    bowSlot(k, t, v.hull, len, this.slot);
    this.fromBody(this.slot.bx, this.slot.bz, v);
  }

  /** A ship pod's member: in the ship's bow wave during its ride windows, joining from abeam and falling astern (pure). */
  private shipMember(pod: PodDef, m: MemberDef, f: DolphinFrame, track: ShipTrack | undefined, pose: DolphinPose): void {
    const S = T.shipRide;
    if (!track || !track.valid || track.speed < 1) {
      pose.visible = false;
      return;
    }
    const q = (((f.trafficT + pod.phase) % S.period) + S.period) % S.period;
    const d = Math.hypot(track.x - f.camX, track.z - f.camZ);
    if (q > S.ride || d > T.drawDistance + 400) {
      pose.visible = false;
      return;
    }
    const w = smooth(0, S.join, q) * (1 - smooth(S.ride - S.join, S.ride, q));
    const v: VesselInfo = SHIP_V;
    v.x = track.x;
    v.z = track.z;
    v.heading = track.course;
    v.speed = track.speed;
    v.hull = track.hull;
    const h = track.course * DEG;
    v.vx = Math.sin(h) * track.speed;
    v.vz = -Math.cos(h) * track.speed;
    bowSlot(m.k, f.trafficT, track.hull, m.length, this.slot);
    // joining / leaving: from 50 m abeam and 30 m aft, round the hull (crossers pass a point off the stem)
    const role = SLOT_ROLE[m.k % SLOT_ROLE.length];
    const side = role.side === 0 || role.side === 2 ? (m.k % 2 === 1 ? -1 : 1) : Math.sign(role.side);
    const half = track.hull.beam / 2;
    const clear = T.ride.hullClearance;
    let bx = this.slot.bx + (1 - w) * side * 50;
    let bz = this.slot.bz + (1 - w) * 30;
    if (role.side === 0 || role.side === 2) {
      const sx = side * (half + 50);
      const sz = track.hull.stemZ + 26;
      const wx = side * (half + clear + 2);
      const wz = track.hull.stemZ - clear - 2.5;
      if (w < 0.7) {
        const u = w / 0.7;
        bx = sx + (wx - sx) * u;
        bz = sz + (wz - sz) * u;
      } else {
        const u = (w - 0.7) / 0.3;
        bx = wx + (this.slot.bx - wx) * u;
        bz = wz + (this.slot.bz - wz) * u;
      }
    }
    this.fromBody(bx, bz, v);
    pose.x = this.tmp.x;
    pose.z = this.tmp.z;
    pose.heading = track.course;
    pose.speed = track.speed;
    breath(m, 'ride', f.trafficT, this.br);
    pose.dy = this.br.dy - (1 - w) * 2.5;
    pose.pitch = clamp(Math.atan2(this.br.rate, Math.max(0.8, track.speed)) * RAD, -75, 75);
    pose.roll = 10 * Math.sin(0.5 * f.trafficT + m.ph2);
    pose.visible = w > 0.01;
    this.styles[pod.first + m.k] = 'ride';
  }

  /** The clock a member's breathing runs on (ship pods: traffic time). */
  clockOf(i: number, f: Pick<DolphinFrame, 't' | 'trafficT'>): number {
    return this.plan.pods[this.plan.members[i].pod].kind === 'ship' ? f.trafficT : f.t;
  }

  /**
   * Water events of visible member i within the last `life` s: `cb(kind, age, x, z, size)` with
   * kind 0 = breath puff (blowhole breaking the surface), 1 = re-entry splash, 2 = leap splash.
   * Positions are where the member was then (its current place minus its motion since).
   */
  events(i: number, t: number, life: number, cb: (kind: number, age: number, x: number, z: number, size: number) => void): void {
    const pose = this.poses[i];
    if (!pose.visible) return;
    const m = this.plan.members[i];
    const style = this.styles[i];
    const P = STYLES[style].period(m);
    const tt = t + m.offset;
    const k0 = Math.floor(tt / P);
    const h = pose.heading * DEG;
    const vx = Math.sin(h) * pose.speed;
    const vz = -Math.cos(h) * pose.speed;
    const scale = m.length / T.length;
    for (let k = k0 - 1; k <= k0; k++) {
      arcOf(m, style, k, this.br);
      const start = k * P - m.offset;
      const D = Math.max(0.5, STYLES[style].depth + m.depth * (style === 'ride' ? 0.3 : 1));
      this.br.depth = D;
      const ev = arcEvents(this.br);
      if (this.br.peak <= 0.05) continue;
      const a1 = t - (start + ev.up);
      const a2 = t - (start + ev.down);
      if (a1 >= 0 && a1 < life) cb(0, a1, pose.x - vx * a1, pose.z - vz * a1, scale);
      if (a2 >= 0 && a2 < life) cb(this.br.leap ? 2 : 1, a2, pose.x - vx * a2, pose.z - vz * a2, scale * (this.br.leap ? 1 : 0.5));
    }
  }

  /** Depth (m) under a member, for the wave sampler's shoaling (Infinity without a world). */
  depthAt(x: number, z: number): number {
    return this.water ? seaDepthAt(this.water, x, z) : Infinity;
  }

  stats(): { pods: number; members: number; visible: number; riding: string | null; modes: Record<string, string> } {
    let visible = 0;
    for (const p of this.poses) if (p.visible) visible++;
    const modes: Record<string, string> = {};
    this.plan.pods.forEach((p, i) => {
      if (this.pods[i].mode !== 'free') modes[p.id] = this.pods[i].mode;
    });
    return { pods: this.plan.pods.length, members: this.poses.length, visible, riding: this.riding >= 0 ? this.plan.pods[this.riding].id : null, modes };
  }
}

/** A vessel within this (m, + its length) of a free pod's centre makes the pod dodge it. */
const DODGE_RANGE = 45;

const SHIP_V: VesselInfo = { x: 0, z: 0, heading: 0, speed: 0, vx: 0, vz: 0, hull: { stemZ: -10, transomZ: 10, beam: 5 } };
