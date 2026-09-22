/**
 * Air traffic (PURE, visual only — no collision with the player):
 *
 *  - Circuit traffic: GA aircraft flying left-hand circuits for runway 36 at
 *    1,000 ft AGL: upwind, crosswind, downwind, base, final; touch-and-go, or a
 *    full stop with rollout, taxi-back via taxiway A and a new take-off; a
 *    go-around (side-stepping west) when the runway is occupied by the player
 *    or another aircraft; a 360 on the downwind for spacing. A small state
 *    machine stepped at a fixed 0.1 s, so the schedule is a pure function of
 *    (seed, time, the player's positions at the decision points).
 *  - Crossing GA: straight tracks at 2,500–6,500 ft through the player's area,
 *    one cycle after another per slot, starting/ending 14 km away.
 *  - A helicopter circling over Port Chateau.
 *  - Airliners at FL300–380 crossing overhead with analytic persistent
 *    contrails (the contrail is the airliner's own past track, drifted by the
 *    upper wind).
 *  - `keepClear`: a soft radial push keeping airborne traffic ≥ R from the player.
 *
 * Frame: +X east, +Y up, +Z south; heading clockwise from north. Body frame =
 * three.js object frame (nose −Z).
 */
import { CONFIG, type Config } from '../../config';
import type { WorldLayout } from '../layout';
import { fromRunwayCoords, type RunwayFrame } from '../runway';
import { createPath, samplePath, filletPath, smoothLoop, newPathSample, arcAtTime, type Path, type PathSample, type Waypoint } from './path';
import { h01, hRange, KT, FT, clamp, smooth, DEG } from './rng';

export type AirKind = 'c172' | 'pa28' | 'heli' | 'a320';

export interface AirPose {
  x: number;
  y: number;
  z: number;
  heading: number;
  pitch: number;
  roll: number;
  /** Ground speed, m/s. */
  speed: number;
  onGround: boolean;
  /** 0..1 propeller / rotor speed. */
  rpm: number;
  landingLight: boolean;
  strobe: boolean;
  visible: boolean;
}

export function newAirPose(): AirPose {
  return { x: 0, y: 0, z: 0, heading: 0, pitch: 0, roll: 0, speed: 0, onGround: false, rpm: 1, landingLight: false, strobe: true, visible: true };
}

/** Wheel/skid contact below the model origin (m): the origin sits this high above the ground when parked. */
export const GEAR_HEIGHT: Record<AirKind, number> = { c172: 1.2, pa28: 1.05, heli: 0.1, a320: 3.8 };

export interface PlayerRef {
  x: number;
  y: number;
  z: number;
  /** Height above the ground, m. */
  agl: number;
}

// ─── Clearance ────────────────────────────────────────────────────────────────

/**
 * Pushes (x, y, z) radially away from the player so its distance is ≥ R, smoothly (softplus):
 * points far outside are unchanged, points inside end just outside R.
 */
export function keepClear(p: { x: number; y: number; z: number }, player: { x: number; y: number; z: number }, R: number, soft = 120): void {
  const dx = p.x - player.x;
  const dy = p.y - player.y;
  const dz = p.z - player.z;
  const d = Math.hypot(dx, dy, dz);
  const k = soft;
  const u = (d - R) / k;
  if (u > 8) return;
  const target = R + k * (u > 30 ? u : Math.log1p(Math.exp(u)));
  if (d < 1e-3) {
    // degenerate: push straight up
    p.y = player.y + target;
    return;
  }
  const f = target / d;
  p.x = player.x + dx * f;
  p.y = player.y + dy * f;
  p.z = player.z + dz * f;
}

// ─── Circuit ─────────────────────────────────────────────────────────────────

export type LegName = 'up' | 'down' | 'orbit' | 'final' | 'tng' | 'full' | 'hold' | 'to' | 'ga';

export interface CircuitLegs {
  legs: Record<Exclude<LegName, 'hold'>, Path>;
  /** Ground segments (on the runway/taxiways) by leg: arc length ranges where the aircraft is on the ground. */
  ground: Partial<Record<LegName, [number, number][]>>;
  /** Hold-short point (end of 'full', start of 'to'). */
  hold: { x: number; z: number; heading: number };
  elevation: number;
  rw: RunwayFrame;
}

const rc = (rw: RunwayFrame, along: number, across: number) => fromRunwayCoords(along, across, rw);

export function buildCircuit(layout: WorldLayout, cfg: Config = CONFIG, kind: AirKind = 'c172'): CircuitLegs {
  const rw = layout.airport.runway;
  const E = rw.elevation;
  const ac = cfg.world.traffic.air;
  const PA = ac.patternAltitudeFt * FT;
  const OFF = -ac.downwindOffset; // left traffic: west of the runway (negative across)
  const g = GEAR_HEIGHT[kind];
  const sp = kind === 'pa28' ? 1.06 : 1;
  const V = { vr: 55 * KT * sp, vy: 72 * KT * sp, down: 90 * KT * sp, base: 75 * KT * sp, final: 65 * KT * sp, td: 52 * KT * sp, tngMin: 43 * KT * sp, taxi: 7, taxiTurn: 4 };
  const wp = (along: number, across: number, h: number, v: number, r = 0, ease?: Waypoint['ease']): Waypoint => {
    const p = rc(rw, along, across);
    return { x: p.x, z: p.z, y: E + h, v, r, ease };
  };
  const path = (wps: Waypoint[]) => createPath(filletPath(wps, 4), false, 4);
  const L = rw.length;
  // Every take-off / touch-and-go joins the upwind leg here, climbing through 60 m AGL.
  const UP = { along: 1300, h: 60 };
  const D = { along: L, across: OFF };
  // Final approach: from the base-to-final turn (along −1500, 120 m) down a ~3.7° glide to a flare
  // that touches down 250 m past the threshold. B = go-around decision point, 700 m before the threshold.
  const B = { along: -700, h: 120 - (800 * (120 - 6.5)) / 1600 };
  const glideTail = [wp(100, 0, 6.5, V.td + 5, 0, 'linear'), wp(250, 0, g, V.td, 0, 'out')];
  const lift = (along: number, s: number): Waypoint[] => [wp(along + 150, 0, g + 75 * s, V.vr + 4, 0, 'in'), wp(UP.along, 0, UP.h, V.vy, 0, 'linear')];
  const sTng = (UP.h - g) / (UP.along - 760 - 150 + 75);
  const sTo = (UP.h - g) / (UP.along - 450 - 150 + 75);
  const legs = {
    up: path([wp(UP.along, 0, UP.h, V.vy), wp(L + 750, 0, 170, V.vy, 280, 'linear'), wp(L + 750, OFF, 290, V.vy + 3, 300, 'linear'), wp(D.along, D.across, PA, V.down, 0, 'out')]),
    down: path([wp(D.along, D.across, PA, V.down), wp(0, OFF, PA, V.down)]),
    final: path([wp(0, OFF, PA, V.down), wp(-1500, OFF, 235, V.base, 300), wp(-1500, 0, 120, V.final, 300), wp(B.along, 0, B.h, V.final, 0, 'linear')]),
    tng: path([wp(B.along, 0, B.h, V.final), ...glideTail, wp(430, 0, g, V.tngMin), wp(760, 0, g, V.vr), ...lift(760, sTng)]),
    full: path([
      wp(B.along, 0, B.h, V.final), ...glideTail,
      wp(650, 0, g, V.taxi + 2), wp(L / 2, 0, g, V.taxiTurn, 22), wp(L / 2, 104, g, V.taxiTurn, 20), wp(25, 104, g, V.taxi, 18), wp(25, 44, g, 0.5),
    ]),
    to: path([wp(25, 44, g, 0.8), wp(25, 0, g, V.taxiTurn, 16), wp(70, 0, g, 3), wp(450, 0, g, V.vr), ...lift(450, sTo)]),
    ga: path([wp(B.along, 0, B.h, V.final), wp(-420, 0, B.h + 30, V.vy, 380, 'linear'), wp(-60, -400, 150, V.vy, 380, 'linear'), wp(L + 750, -400, 240, V.vy, 280, 'linear'), wp(L + 750, OFF, 295, V.vy + 3, 300, 'linear'), wp(D.along, D.across, PA, V.down, 0, 'out')]),
    orbit: orbitPath(rw, D.along, D.across, E + PA, V.down, 330),
  };
  // mark ground arc ranges (y ≤ E + g + 0.3)
  const ground: CircuitLegs['ground'] = {};
  for (const [name, p] of Object.entries(legs) as [LegName, Path][]) {
    const ranges: [number, number][] = [];
    let start = -1;
    for (let i = 0; i < p.n; i++) {
      const on = p.y[i] <= E + g + 0.3;
      if (on && start < 0) start = p.s[i];
      if (!on && start >= 0) {
        ranges.push([start, p.s[i]]);
        start = -1;
      }
    }
    if (start >= 0) ranges.push([start, p.length]);
    if (ranges.length) ground[name] = ranges;
  }
  const h = rc(rw, 25, 44);
  return { legs, ground, hold: { x: h.x, z: h.z, heading: (rw.headingDeg + 270) % 360 }, elevation: E, rw };
}

/** A right-hand 360 starting and ending at the downwind entry point, heading down the downwind. */
function orbitPath(rw: RunwayFrame, along: number, across: number, y: number, v: number, r: number): Path {
  const p0 = rc(rw, along, across);
  // downwind direction = −runway dir; its right-hand side (for a right turn) = runway's left = −right
  const dx = -rw.dir.x;
  const dz = -rw.dir.z;
  const rx = -dz;
  const rz = dx;
  const cx = p0.x + rx * r;
  const cz = p0.z + rz * r;
  const a0 = Math.atan2(p0.z - cz, p0.x - cx);
  const pts: { x: number; y: number; z: number; v: number }[] = [];
  const n = 72;
  for (let i = 0; i <= n; i++) {
    const a = a0 + (i / n) * Math.PI * 2;
    pts.push({ x: cx + Math.cos(a) * r, y, z: cz + Math.sin(a) * r, v });
  }
  // prepend/append a short straight so the joins are tangent (the circle starts tangent already)
  return createPath(pts, false, 4);
}

export interface CircuitAircraft {
  id: number;
  kind: AirKind;
  livery: number;
  leg: LegName;
  /** Seconds into the current leg. */
  t: number;
  laps: number;
  /** Number of decisions taken (for hashing). */
  n: number;
}

export interface CircuitState {
  legs: Record<AirKind, CircuitLegs>;
  aircraft: CircuitAircraft[];
  /** Accumulated time not yet stepped (s), and total stepped time. */
  acc: number;
  time: number;
  seed: number;
  /** Decision log (last few), for tests/debug. */
  log: string[];
}

export const CIRCUIT_STEP = 0.1;

export function createCircuitState(layout: WorldLayout, cfg: Config = CONFIG): CircuitState {
  const seed = cfg.world.traffic.seed;
  const n = cfg.world.traffic.air.circuit;
  const legs = { c172: buildCircuit(layout, cfg, 'c172'), pa28: buildCircuit(layout, cfg, 'pa28') } as Record<AirKind, CircuitLegs>;
  const aircraft: CircuitAircraft[] = [];
  const starts: [LegName, number][] = [['down', 0.35], ['final', 0.25], ['up', 0.45], ['down', 0.9]];
  for (let i = 0; i < n; i++) {
    const kind: AirKind = i % 2 === 0 ? 'c172' : 'pa28';
    const [leg, f] = starts[i % starts.length];
    const p = legs[kind].legs[leg as Exclude<LegName, 'hold'>];
    aircraft.push({ id: i, kind, livery: Math.floor(h01(seed, 9100, i) * 2), leg, t: p.duration * f, laps: 0, n: 0 });
  }
  return { legs, aircraft, acc: 0, time: 0, seed, log: [] };
}

const legPath = (s: CircuitState, a: CircuitAircraft, leg: LegName): Path | null => (leg === 'hold' ? null : s.legs[a.kind].legs[leg]);

/** Is the runway (plus a protected zone around it and the short final) occupied by the player? */
export function runwayOccupiedByPlayer(rw: RunwayFrame, player: PlayerRef | null): boolean {
  if (!player) return false;
  if (player.agl > 150) return false;
  const dx = player.x - rw.threshold.x;
  const dz = player.z - rw.threshold.z;
  const along = dx * rw.dir.x + dz * rw.dir.z;
  const across = dx * rw.right.x + dz * rw.right.z;
  return along > -1200 && along < rw.length + 300 && Math.abs(across) < 120;
}

/** Player near the taxi-back route / the airport ground (full stops are only flown when the field is empty). */
function playerNearField(rw: RunwayFrame, player: PlayerRef | null): boolean {
  if (!player) return false;
  return Math.hypot(player.x - rw.center.x, player.z - rw.center.z) < 2500 && player.agl < 600;
}

/** Legs during which an aircraft occupies (or is about to occupy) the runway. */
const RUNWAY_LEGS: LegName[] = ['tng', 'full', 'to'];

/** Seconds until aircraft `o` is off the runway (0 if it is not on / about to use it). */
export function timeToClearRunway(s: CircuitState, o: CircuitAircraft): number {
  if (!RUNWAY_LEGS.includes(o.leg)) return 0;
  const cl = s.legs[o.kind];
  const p = cl.legs[o.leg as 'tng' | 'full' | 'to'];
  const r = cl.ground[o.leg];
  if (!r || !r.length) return 0;
  // clear at the end of the runway part of the ground run: lift-off, or the mid-field turn-off
  const endArc = o.leg === 'full' ? Math.min(r[0][1], clearArcFull(cl)) : r[0][1];
  const tEnd = timeAtArcOf(p, endArc);
  return Math.max(0, tEnd - o.t);
}

const _clearCache = new WeakMap<CircuitLegs, number>();
function clearArcFull(cl: CircuitLegs): number {
  let v = _clearCache.get(cl);
  if (v === undefined) {
    // arc length where the rollout leaves the runway centreline (turn-off at mid-field)
    const p = cl.legs.full;
    const smp = newPathSample();
    v = p.length;
    for (let s = 0; s < p.length; s += 4) {
      samplePath(p, s, smp);
      const dx = smp.x - cl.rw.threshold.x;
      const dz = smp.z - cl.rw.threshold.z;
      if (Math.abs(dx * cl.rw.right.x + dz * cl.rw.right.z) > cl.rw.halfWidth + 5) {
        v = s;
        break;
      }
    }
    _clearCache.set(cl, v);
  }
  return v;
}

function timeAtArcOf(p: Path, arc: number): number {
  let lo = 0;
  let hi = p.n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (p.s[mid] <= arc) lo = mid;
    else hi = mid;
  }
  return p.t[lo];
}

/** Would another aircraft still be on the runway when `self` (at the decision point) gets there? */
function othersOnRunway(s: CircuitState, self: CircuitAircraft): boolean {
  for (const o of s.aircraft) {
    if (o === self) continue;
    if (o.leg === 'to' && o.t < 25) return true; // lining up
    if (timeToClearRunway(s, o) > 20) return true;
  }
  return false;
}

function remaining(s: CircuitState, a: CircuitAircraft): number {
  const p = legPath(s, a, a.leg);
  return p ? p.duration - a.t : Infinity;
}

/** Decide the next leg when `a` finishes its current one. */
function nextLeg(s: CircuitState, a: CircuitAircraft, player: PlayerRef | null): LegName {
  const cl = s.legs[a.kind];
  const rw = cl.rw;
  a.n++;
  switch (a.leg) {
    case 'up':
    case 'ga':
    case 'orbit': {
      // merging onto the downwind: keep ≥ 40 s behind the aircraft ahead on the downwind
      for (const o of s.aircraft) {
        if (o === a) continue;
        if (o.leg === 'down' && o.t < 40) return 'orbit';
        if ((o.leg === 'up' || o.leg === 'ga') && remaining(s, o) < 25 && remaining(s, o) > 0 && o.id < a.id) return 'orbit';
      }
      return 'down';
    }
    case 'down':
      return 'final';
    case 'final': {
      if (runwayOccupiedByPlayer(rw, player) || othersOnRunway(s, a)) {
        s.log.push(`${a.id}:ga`);
        return 'ga';
      }
      const wantFull = h01(s.seed, 9200 + a.id, a.n) < 0.34;
      return wantFull && !playerNearField(rw, player) ? 'full' : 'tng';
    }
    case 'tng':
    case 'to':
      a.laps++;
      return 'up';
    case 'full':
      return 'hold';
    default:
      return 'up';
  }
}

function canTakeOff(s: CircuitState, a: CircuitAircraft, player: PlayerRef | null): boolean {
  if (runwayOccupiedByPlayer(s.legs[a.kind].rw, player)) return false;
  for (const o of s.aircraft) {
    if (o === a) continue;
    if (RUNWAY_LEGS.includes(o.leg) && timeToClearRunway(s, o) > 0) return false;
    if (o.leg === 'final' && remaining(s, o) < 90) return false;
    if (o.leg === 'down' && remaining(s, o) < 30) return false;
  }
  return true;
}

function holdOccupied(s: CircuitState, self: CircuitAircraft): boolean {
  for (const o of s.aircraft) if (o !== self && (o.leg === 'hold' || (o.leg === 'to' && o.t < 16))) return true;
  return false;
}

/** Advances the circuit by dt (fixed internal steps of CIRCUIT_STEP). */
export function stepCircuit(s: CircuitState, dt: number, player: PlayerRef | null): void {
  s.acc += Math.max(0, dt);
  let guard = 0;
  while (s.acc >= CIRCUIT_STEP && guard++ < 100000) {
    s.acc -= CIRCUIT_STEP;
    s.time += CIRCUIT_STEP;
    for (const a of s.aircraft) {
      if (a.leg === 'hold') {
        a.t += CIRCUIT_STEP;
        if (a.t > 20 && canTakeOff(s, a, player)) {
          a.leg = 'to';
          a.t = 0;
        }
        continue;
      }
      let p = legPath(s, a, a.leg)!;
      // taxi queue: stop short of an occupied hold-short point
      if (a.leg === 'full' && p.duration - a.t < 22 && holdOccupied(s, a)) continue;
      a.t += CIRCUIT_STEP;
      let hops = 0;
      while (a.t >= p.duration && hops++ < 4) {
        const over = a.t - p.duration;
        a.leg = nextLeg(s, a, player);
        a.t = a.leg === 'hold' ? 0 : over;
        if (a.leg === 'hold') break;
        p = legPath(s, a, a.leg)!;
      }
    }
    if (s.log.length > 32) s.log.splice(0, s.log.length - 32);
  }
}

const _cs = newPathSample();
const _cs2 = newPathSample();

/** Pose of circuit aircraft `a` (between fixed steps: interpolated by the accumulator). */
export function circuitPose(s: CircuitState, a: CircuitAircraft, out: AirPose): AirPose {
  const cl = s.legs[a.kind];
  out.visible = true;
  out.rpm = 1;
  if (a.leg === 'hold') {
    out.x = cl.hold.x;
    out.z = cl.hold.z;
    out.y = cl.elevation + GEAR_HEIGHT[a.kind];
    out.heading = cl.hold.heading;
    out.pitch = 0;
    out.roll = 0;
    out.speed = 0;
    out.onGround = true;
    out.rpm = 0.45;
    out.landingLight = false;
    out.strobe = false;
    return out;
  }
  const p = legPath(s, a, a.leg)!;
  const tq = Math.min(p.duration, a.t + s.acc);
  const arc = arcAtTime(p, tq);
  samplePath(p, arc, _cs);
  out.x = _cs.x;
  out.y = _cs.y;
  out.z = _cs.z;
  out.heading = _cs.heading;
  out.speed = _cs.speed;
  const gh = GEAR_HEIGHT[a.kind];
  const agl = _cs.y - cl.elevation - gh;
  out.onGround = agl < 0.05;
  // bank from curvature averaged over ±2 s of flight (roll-in / roll-out)
  const v = Math.max(1, _cs.speed);
  let kSum = 0;
  let gSum = 0;
  for (let k = -2; k <= 2; k++) {
    samplePath(p, arc + k * v * 0.55, _cs2);
    kSum += _cs2.curvature;
    gSum += _cs2.grade;
  }
  const kappa = kSum / 5;
  out.roll = out.onGround ? 0 : clamp((Math.atan((v * v * kappa) / 9.81) * 180) / Math.PI, -35, 35);
  // pitch = flight-path angle + angle of attack (higher when slow), rotation/flare near the ground
  const gamma = (Math.atan(gSum / 5) * 180) / Math.PI;
  const aoa = clamp(2 + (46 - v) * 0.28, 1, 9);
  if (out.onGround) {
    const rot = a.leg === 'to' || a.leg === 'tng' ? smooth(0.85, 1, v / (55 * KT)) * 7 : 0;
    out.pitch = rot;
  } else {
    const flare = smooth(10, 0, agl) * 3;
    out.pitch = gamma + aoa + flare;
  }
  out.rpm = a.leg === 'final' ? 0.62 : a.leg === 'full' && out.onGround ? 0.45 : 1;
  out.landingLight = a.leg === 'final' || a.leg === 'tng' || a.leg === 'to' || a.leg === 'ga' || (a.leg === 'full' && arc < p.length * 0.5) || (a.leg === 'up' && agl < 250);
  out.strobe = !out.onGround || a.leg === 'to' || a.leg === 'tng';
  return out;
}

// ─── Crossing GA ─────────────────────────────────────────────────────────────

export interface CrossingSlot {
  slot: number;
  cycle: number;
  /** Traffic time at which this cycle's track starts. */
  start: number;
  duration: number;
  kind: AirKind;
  livery: number;
  /** Track start point, direction, speed, altitude. */
  x0: number;
  z0: number;
  dx: number;
  dz: number;
  speed: number;
  y: number;
  heading: number;
}

export const CROSS_HALF = 14000;

/** Deterministic crossing track for (slot, cycle) through the area around `anchor`. */
export function crossingTrack(seed: number, slot: number, cycle: number, anchor: { x: number; z: number }, start: number, heightAt: (x: number, z: number) => number, cfg: Config = CONFIG): CrossingSlot {
  const ac = cfg.world.traffic.air;
  const hd = h01(seed, 9300 + slot, cycle) * 360;
  const dx = Math.sin(hd * DEG);
  const dz = -Math.cos(hd * DEG);
  const side = h01(seed, 9301 + slot, cycle) < 0.5 ? -1 : 1;
  const miss = side * (700 + 3800 * h01(seed, 9302 + slot, cycle));
  const cx = anchor.x - dz * miss; // perpendicular (right of track) = (−dz, dx)
  const cz = anchor.z + dx * miss;
  const speed = hRange(seed, 9303 + slot, cycle, 100, 138) * KT;
  let y = hRange(seed, 9304 + slot, cycle, ac.crossingAltitudeFt[0], ac.crossingAltitudeFt[1]) * FT;
  // terrain clearance along the track: ≥ 1,500 ft above the highest ground
  let hi = -Infinity;
  for (let k = -70; k <= 70; k++) hi = Math.max(hi, heightAt(cx + dx * k * 200, cz + dz * k * 200));
  y = Math.max(y, hi + 1500 * FT + 120);
  const kind: AirKind = h01(seed, 9305 + slot, cycle) < 0.55 ? 'c172' : 'pa28';
  return {
    slot, cycle, start, duration: (2 * CROSS_HALF) / speed + hRange(seed, 9306 + slot, cycle, 5, 60), kind,
    livery: Math.floor(h01(seed, 9307 + slot, cycle) * 2),
    x0: cx - dx * CROSS_HALF, z0: cz - dz * CROSS_HALF, dx, dz, speed, y, heading: hd,
  };
}

export function crossingPose(c: CrossingSlot, t: number, out: AirPose): AirPose {
  const tau = Math.max(0, t - c.start);
  const d = c.speed * tau;
  out.x = c.x0 + c.dx * d;
  out.z = c.z0 + c.dz * d;
  // a gentle altitude hold wobble
  out.y = c.y + 6 * Math.sin(tau * 0.05 + c.slot);
  out.heading = c.heading;
  out.pitch = 2.5 + 0.4 * Math.sin(tau * 0.05 + c.slot);
  out.roll = 1.5 * Math.sin(tau * 0.11 + c.cycle);
  out.speed = c.speed;
  out.onGround = false;
  out.rpm = 1;
  out.landingLight = false;
  out.strobe = true;
  out.visible = d <= 2 * CROSS_HALF;
  return out;
}

// ─── Helicopter ──────────────────────────────────────────────────────────────

export interface HeliRoute {
  path: Path;
  phase: number;
}

export function buildHeliRoute(layout: WorldLayout, heightAt: (x: number, z: number) => number, cfg: Config = CONFIG): HeliRoute {
  const city = layout.towns.find((t) => t.name === 'Port Chateau') ?? layout.towns[0];
  const seed = cfg.world.traffic.seed;
  const n = 6;
  const ctrl: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2 + 0.4;
    const r = city.radius * (0.58 + 0.12 * h01(seed, 9400, i));
    ctrl.push({ x: city.x + Math.cos(a) * r, z: city.z + Math.sin(a) * r * 0.8 });
  }
  const pts = smoothLoop(ctrl, 24);
  let hi = -Infinity;
  for (const p of pts) hi = Math.max(hi, heightAt(p.x, p.z));
  const y = Math.max(0, hi) + 300;
  const path = createPath(pts.map((p) => ({ x: p.x, y, z: p.z, v: 75 * KT })), true, 6);
  return { path, phase: h01(seed, 9401, 0) * path.length };
}

const _hs = newPathSample();
export function heliPose(h: HeliRoute, t: number, out: AirPose): AirPose {
  const p = h.path;
  const s = h.phase + (75 * KT) * t;
  samplePath(p, s, _hs);
  out.x = _hs.x;
  out.y = _hs.y + 12 * Math.sin(t * 0.07);
  out.z = _hs.z;
  out.heading = _hs.heading;
  const v = 75 * KT;
  let kSum = 0;
  for (let k = -2; k <= 2; k++) kSum += samplePath(p, s + k * v * 0.6, _cs2).curvature;
  out.roll = clamp((Math.atan((v * v * (kSum / 5)) / 9.81) * 180) / Math.PI, -30, 30);
  out.pitch = -4.5; // nose-down in forward flight
  out.speed = v;
  out.onGround = false;
  out.rpm = 1;
  out.landingLight = false;
  out.strobe = true;
  out.visible = true;
  return out;
}

// ─── Airliners ───────────────────────────────────────────────────────────────

export const AIRLINER_HALF = 60000;

export interface AirlinerSlot {
  slot: number;
  cycle: number;
  start: number;
  /** Track time (s) + contrail lifetime. */
  duration: number;
  x0: number;
  z0: number;
  dx: number;
  dz: number;
  speed: number;
  y: number;
  heading: number;
  livery: number;
  /** Contrail lifetime (s); 0 = no contrail (dry air at this level). */
  contrail: number;
}

export function airlinerTrack(seed: number, slot: number, cycle: number, anchor: { x: number; z: number }, start: number, cfg: Config = CONFIG): AirlinerSlot {
  const ac = cfg.world.traffic.air;
  const hd = h01(seed, 9500 + slot, cycle) * 360;
  const dx = Math.sin(hd * DEG);
  const dz = -Math.cos(hd * DEG);
  const miss = (h01(seed, 9501 + slot, cycle) * 2 - 1) * 22000;
  const cx = anchor.x - dz * miss;
  const cz = anchor.z + dx * miss;
  const speed = hRange(seed, 9502 + slot, cycle, 440, 485) * KT;
  // flight levels in 1,000 ft steps (even/odd by direction, like real semicircular rules)
  const fl = Math.round(hRange(seed, 9503 + slot, cycle, ac.airlinerAltitudeFt[0], ac.airlinerAltitudeFt[1]) / 2000) * 2000 + (hd < 180 ? 1000 : 0);
  const y = clamp(fl, ac.airlinerAltitudeFt[0], ac.airlinerAltitudeFt[1]) * FT;
  const contrail = h01(seed, 9504 + slot, cycle) < 0.8 ? ac.contrailMaxAge * hRange(seed, 9505 + slot, cycle, 0.55, 1) : 0;
  return {
    slot, cycle, start, duration: (2 * AIRLINER_HALF) / speed + ac.contrailMaxAge, x0: cx - dx * AIRLINER_HALF, z0: cz - dz * AIRLINER_HALF, dx, dz, speed, y, heading: hd,
    livery: Math.floor(h01(seed, 9506 + slot, cycle) * 3), contrail,
  };
}

/** Upper wind (m/s, toward) that drifts and shears contrails. */
export const UPPER_WIND = { x: 14, z: 5 };

export function airlinerPose(a: AirlinerSlot, t: number, out: AirPose): AirPose {
  const tau = t - a.start;
  const d = a.speed * tau;
  out.x = a.x0 + a.dx * d;
  out.z = a.z0 + a.dz * d;
  out.y = a.y;
  out.heading = a.heading;
  out.pitch = 2.2;
  out.roll = 0;
  out.speed = a.speed;
  out.onGround = false;
  out.rpm = 1;
  out.landingLight = false;
  out.strobe = true;
  out.visible = tau >= 0 && d <= 2 * AIRLINER_HALF + 20000;
  return out;
}

/** World position of the contrail point laid down `age` s ago (drifted by the upper wind, sinking slowly). */
export function contrailPoint(a: AirlinerSlot, t: number, age: number, out: { x: number; y: number; z: number }): void {
  const tau = t - a.start - age;
  const d = a.speed * tau;
  out.x = a.x0 + a.dx * d + UPPER_WIND.x * age;
  out.z = a.z0 + a.dz * d + UPPER_WIND.z * age;
  out.y = a.y - 0.25 * age;
}

// ─── Slot scheduler (crossing GA + airliners) ────────────────────────────────

export interface SlotScheduler<T extends { start: number; duration: number; cycle: number }> {
  slots: T[];
  /** Advances to time t: starts a new cycle for every finished slot, anchored at `anchor`. */
  update(t: number, anchor: { x: number; z: number }): void;
  /** Re-anchors every slot (teleport): new cycles starting now. */
  reanchor(t: number, anchor: { x: number; z: number }): void;
}

export function createScheduler<T extends { start: number; duration: number; cycle: number }>(
  count: number,
  make: (slot: number, cycle: number, anchor: { x: number; z: number }, start: number) => T,
  /** Initial progress of cycle 0 at t0 as a fraction of its duration. */
  initialFraction: (slot: number, s: T) => number,
  t0: number,
  anchor: { x: number; z: number },
): SlotScheduler<T> {
  const slots: T[] = [];
  const cycles: number[] = [];
  const init = (i: number, t: number, a: { x: number; z: number }) => {
    const probe = make(i, cycles[i], a, t);
    const f = initialFraction(i, probe);
    const s = make(i, cycles[i], a, t - f * probe.duration);
    slots[i] = s;
  };
  for (let i = 0; i < count; i++) {
    cycles.push(0);
    init(i, t0, anchor);
  }
  return {
    slots,
    update(t, a) {
      for (let i = 0; i < count; i++) {
        let guard = 0;
        while (t > slots[i].start + slots[i].duration && guard++ < 1000) {
          cycles[i]++;
          const st = slots[i].start + slots[i].duration;
          // a long gap (e.g. fast-forward) restarts the cycle now
          slots[i] = make(i, cycles[i], a, t - st > 600 ? t : st);
        }
      }
    },
    reanchor(t, a) {
      for (let i = 0; i < count; i++) {
        cycles[i]++;
        init(i, t, a);
      }
    },
  };
}
