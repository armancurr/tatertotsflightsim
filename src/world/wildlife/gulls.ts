/**
 * Herring gulls (PURE, no three.js, no allocation per frame).
 *
 *  - Flocks wheel over the marina and the harbour: each bird circles its flock's drifting centre
 *    on its own radius, height and sense, gliding with bursts of flapping (a pure function of time).
 *  - Perched birds stand on the breakwater crests, piles, entrance beacons and the quay, facing
 *    the wind. A boat, an aircraft or the camera coming close flushes them: they take off, circle
 *    nearby and land again on the same spot once it is clear.
 *  - Birds trail every fishing boat (from the traffic plan's poses), wheeling astern and dipping
 *    to the water; a few follow the player's boat when it is underway, hovering over its wake.
 *  - Flying birds shy away from a boat / aircraft passing close (a sprung displacement that pushes
 *    them away and eases back), and no bird ever comes within `cameraClearance` of the camera.
 *
 * `GullSim.update` writes each bird's pose (absolute world position, heading, pitch, bank, wing
 * flapping and folding) into flat arrays for the renderer. Frame: world +X east, +Y up, +Z south;
 * heading clockwise from north.
 */
import { HARBOUR_DIMS, marinaObstacleTop } from '../traffic/harbourObstacles';
import { toWorld, type MarinaLayout } from '../traffic/sea';
import { h01, hRange, clamp, smooth } from '../traffic/rng';
import { WILDLIFE } from './tuning';

const G = WILDLIFE.gull;
const SEED = WILDLIFE.seed;
const RAD = 180 / Math.PI;
const DEG = Math.PI / 180;
const TAU = Math.PI * 2;

export type GullRole = 'flock' | 'perch' | 'fishing' | 'player';

export interface GullDef {
  role: GullRole;
  /** Flock index (flock), fishing boat index (fishing), −1 otherwise. */
  group: number;
  key: number;
  /** Orbit: radius (m), height (m), angular sense (±1), phase (rad), speed (m/s). */
  r: number;
  alt: number;
  sense: number;
  ph: number;
  speed: number;
  /** Perch: the spot (world, top of the structure) and the heading it faces. */
  px: number;
  py: number;
  pz: number;
  heading: number;
  /** Follower slot (player): metres aft of the transom, to starboard, above the water. */
  aft: number;
  side: number;
}

export interface FlockDef {
  x: number;
  z: number;
  r: number;
  alt: number;
}

export interface GullPlan {
  gulls: GullDef[];
  flocks: FlockDef[];
  /** Where the perched birds are (their centre, for the "near the camera" test). */
  perchCentre: { x: number; z: number; r: number };
  fishingBoats: number;
}

function orbitDef(role: GullRole, group: number, key: number, r: number, alt: number): GullDef {
  return {
    role,
    group,
    key,
    r: r * hRange(SEED, 9001, key, 0.35, 1.1),
    alt: alt * hRange(SEED, 9002, key, 0.6, 1.4),
    sense: h01(SEED, 9003, key) < 0.75 ? 1 : -1,
    ph: hRange(SEED, 9004, key, 0, TAU),
    speed: hRange(SEED, 9005, key, 7.5, 10.5),
    px: 0,
    py: 0,
    pz: 0,
    heading: 0,
    aft: 0,
    side: 0,
  };
}

/** The birds: flocks, perches on the marina's structures, fishing-boat and player followers. */
export function createGullPlan(marina: MarinaLayout | null, opts: { windFromDeg: number; fishingBoats: number }): GullPlan {
  const gulls: GullDef[] = [];
  const flocks: FlockDef[] = [];
  let key = 0;
  G.flocks.forEach((f, fi) => {
    if (f.frame === 'marina' && !marina) return;
    const c = f.frame === 'marina' && marina ? toWorld(marina.frame, f.u, f.w) : { x: f.u, z: f.w };
    flocks.push({ x: c.x, z: c.z, r: f.r, alt: f.alt });
    for (let k = 0; k < f.n; k++) gulls.push(orbitDef('flock', flocks.length - 1, key++, f.r, f.alt));
    void fi;
  });
  let perchCentre = { x: 0, z: 0, r: 0 };
  if (marina) {
    const spots: { x: number; y: number; z: number }[] = [];
    const pick = <T>(list: readonly T[], n: number, salt: number): T[] => {
      const idx = list.map((_, i) => i).sort((a, b) => h01(SEED, salt, a) - h01(SEED, salt, b));
      return idx.slice(0, Math.min(n, list.length)).map((i) => list[i]);
    };
    // breakwater crests: points along the centrelines
    const crest: { u: number; w: number }[] = [];
    for (const b of marina.breakwaters) {
      for (let i = 1; i < b.pts.length; i++) {
        const a = b.pts[i - 1];
        const c = b.pts[i];
        const len = Math.hypot(c.u - a.u, c.w - a.w);
        for (let s = 4; s < len - 4; s += 7) crest.push({ u: a.u + ((c.u - a.u) * s) / len, w: a.w + ((c.w - a.w) * s) / len });
      }
    }
    for (const p of pick(crest, G.perched.breakwater, 9100)) {
      const q = toWorld(marina.frame, p.u, p.w);
      spots.push({ x: q.x, y: marinaObstacleTop(marina, q.x, q.z), z: q.z });
    }
    for (const p of pick(marina.piles, G.perched.piles, 9101)) {
      const q = toWorld(marina.frame, p.u, p.w);
      spots.push({ x: q.x, y: HARBOUR_DIMS.pileTop, z: q.z });
    }
    // the visitors' pontoon piles, beside the player's berth: flushed as the boat casts off
    for (const p of marina.visitor.piles.slice(0, G.perched.visitorPiles)) {
      const q = toWorld(marina.frame, p.u, p.w);
      spots.push({ x: q.x, y: HARBOUR_DIMS.pileTop, z: q.z });
    }
    for (const p of pick(marina.beacons, G.perched.beacons, 9102)) {
      const q = toWorld(marina.frame, p.u, p.w);
      spots.push({ x: q.x, y: HARBOUR_DIMS.beaconTop, z: q.z });
    }
    const quay: { u: number; w: number }[] = [];
    for (let u = marina.quay.u0 + 20; u < marina.quay.u1 - 20; u += 9) quay.push({ u, w: marina.quay.w1 - 0.8 });
    for (const p of pick(quay, G.perched.quay, 9103)) {
      const q = toWorld(marina.frame, p.u, p.w);
      spots.push({ x: q.x, y: Math.max(marina.quay.top, marinaObstacleTop(marina, q.x, q.z)), z: q.z });
    }
    let cx = 0;
    let cz = 0;
    for (const s of spots) {
      const g = orbitDef('perch', -1, key++, 26, 18);
      g.px = s.x;
      g.py = s.y;
      g.pz = s.z;
      g.heading = (opts.windFromDeg + hRange(SEED, 9104, g.key, -28, 28) + 360) % 360;
      gulls.push(g);
      cx += s.x;
      cz += s.z;
    }
    if (spots.length) {
      cx /= spots.length;
      cz /= spots.length;
      let r = 0;
      for (const s of spots) r = Math.max(r, Math.hypot(s.x - cx, s.z - cz));
      perchCentre = { x: cx, z: cz, r };
    }
  }
  for (let b = 0; b < opts.fishingBoats; b++) {
    for (let k = 0; k < G.fishing; k++) {
      const g = orbitDef('fishing', b, key++, 20, 9);
      g.speed = hRange(SEED, 9200, g.key, 6, 8.5);
      gulls.push(g);
    }
  }
  for (let k = 0; k < G.player; k++) {
    const g = orbitDef('player', -1, key++, 4, 9);
    // from abeam of the cockpit to a boat length astern, out over the wake's arms
    g.aft = hRange(SEED, 9300, g.key, -12, 16);
    g.side = (k % 2 === 0 ? 1 : -1) * hRange(SEED, 9301, g.key, 4, 15);
    g.alt = hRange(SEED, 9302, g.key, 5, 12);
    g.r = hRange(SEED, 9303, g.key, 2, 5);
    gulls.push(g);
  }
  return { gulls, flocks, perchCentre, fishingBoats: opts.fishingBoats };
}

// ─── Pure orbits ─────────────────────────────────────────────────────────────

/** A flock's wandering centre at time t (a slow figure-of-eight around its home). */
export function flockCentre(f: FlockDef, index: number, t: number, out: { x: number; z: number }): void {
  const w = TAU / (240 + 40 * index);
  out.x = f.x + f.r * 0.7 * Math.cos(w * t + index);
  out.z = f.z + f.r * 0.45 * Math.sin(2 * w * t + index);
}

/** A bird circling (cx, cz): position at time t (pure). */
export function orbitAt(g: GullDef, cx: number, cz: number, alt: number, t: number, out: { x: number; y: number; z: number }): void {
  const r = g.r * (1 + 0.28 * Math.sin(0.071 * t + g.ph));
  const theta = g.ph + (g.sense * g.speed * t) / Math.max(4, g.r);
  out.x = cx + r * Math.cos(theta);
  out.z = cz + r * Math.sin(theta);
  out.y = alt + 0.25 * alt * Math.sin(0.11 * t + g.ph * 1.7) + 2 * Math.sin(0.37 * t + g.ph);
}

/** How much a bird flaps (0 glide … 1 flapping) at time t: bursts every 5–12 s, more when climbing. */
export function flapAmount(g: GullDef, t: number, climb: number): number {
  const p = 5 + 7 * h01(SEED, 9400, g.key);
  const s = 0.5 + 0.5 * Math.sin((TAU * t) / p + g.ph);
  return clamp(smooth(0.62, 0.8, s) + smooth(0.3, 1.5, climb), 0, 1);
}

// ─── The simulation ──────────────────────────────────────────────────────────

export interface BoatPose {
  x: number;
  z: number;
  /** Direction of travel (deg), speed (m/s) and the hull's length (m). */
  heading: number;
  speed: number;
  length: number;
  valid: boolean;
}

export interface GullFrame {
  /** Sea clock (s): orbits. */
  t: number;
  /** Frame step (s, 0 while paused). */
  dt: number;
  camX: number;
  camY: number;
  camZ: number;
  /** Fishing boats (plan.fishingBoats of them). */
  fishing: readonly BoatPose[];
  /** The player's boat (null when flying / none). */
  player: BoatPose | null;
  /** Threats that flush / push birds (besides the camera, always one): [x, y, z, radius] × `threatCount`. */
  threats: Float64Array;
  threatCount: number;
  /** Index of the threat that is the player's own craft (the birds following it ignore it), or −1. */
  playerThreat?: number;
}

/** Pose arrays: position, heading/pitch/bank (deg), flap amount, flap phase (rad), fold (0 flying … 1 perched), visibility. */
export interface GullPoses {
  x: Float64Array;
  y: Float64Array;
  z: Float64Array;
  heading: Float64Array;
  pitch: Float64Array;
  bank: Float64Array;
  flap: Float64Array;
  phase: Float64Array;
  fold: Float64Array;
  visible: Uint8Array;
}

export class GullSim {
  readonly plan: GullPlan;
  readonly poses: GullPoses;
  /** Sprung displacement (scatter / join / leave) per bird and its velocity. */
  private readonly dx: Float64Array;
  private readonly dy: Float64Array;
  private readonly dz: Float64Array;
  private readonly vx: Float64Array;
  private readonly vy: Float64Array;
  private readonly vz: Float64Array;
  /** Perched birds: 0 perched … 1 fully away; excursion clock and takeoff time/direction. */
  private readonly blend: Float64Array;
  private readonly flyT: Float64Array;
  private readonly away: Float64Array;
  private readonly offDir: Float64Array;
  /** Player followers: joined, seconds the boat has been too slow. */
  private joined = false;
  private slowFor = 0;
  private active = false;
  private readonly tmp = { x: 0, y: 0, z: 0 };
  private readonly tmp2 = { x: 0, y: 0, z: 0 };
  private readonly c = { x: 0, z: 0 };
  private readonly flushed = { count: 0 };
  private readonly prevX: Float64Array;
  private readonly prevY: Float64Array;
  private readonly prevZ: Float64Array;
  private readonly primed: Uint8Array;

  constructor(plan: GullPlan) {
    this.plan = plan;
    const n = plan.gulls.length;
    const f = () => new Float64Array(n);
    this.poses = { x: f(), y: f(), z: f(), heading: f(), pitch: f(), bank: f(), flap: f(), phase: f(), fold: f(), visible: new Uint8Array(n) };
    this.dx = f();
    this.dy = f();
    this.dz = f();
    this.vx = f();
    this.vy = f();
    this.vz = f();
    this.blend = f();
    this.flyT = f();
    this.away = f();
    this.offDir = f();
    this.prevX = f();
    this.prevY = f();
    this.prevZ = f();
    this.primed = new Uint8Array(n);
    plan.gulls.forEach((g, i) => {
      this.poses.phase[i] = g.ph;
      this.poses.heading[i] = g.heading;
    });
  }

  reset(): void {
    this.dx.fill(0);
    this.dy.fill(0);
    this.dz.fill(0);
    this.vx.fill(0);
    this.vy.fill(0);
    this.vz.fill(0);
    this.blend.fill(0);
    this.flyT.fill(0);
    this.away.fill(0);
    this.primed.fill(0);
    this.joined = false;
    this.active = false;
    this.slowFor = 0;
  }

  /** Nearest threat to (x, y, z) relative to its radius: returns d / r (< 1 = inside) and writes the direction away into tmp2. */
  private threat(f: GullFrame, x: number, y: number, z: number, skip = -1): number {
    // the camera is always a threat (birds shy away from it before the hard clearance applies)
    let best = Infinity;
    {
      const d = Math.hypot(x - f.camX, y - f.camY, z - f.camZ);
      const q = d / G.scatter.camera;
      if (q < 1) {
        best = q;
        const l = Math.max(1e-3, d);
        this.tmp2.x = (x - f.camX) / l;
        this.tmp2.y = Math.max(0.35, (y - f.camY) / l);
        this.tmp2.z = (z - f.camZ) / l;
      }
    }
    for (let k = 0; k < f.threatCount; k++) {
      if (k === skip) continue;
      const tx = f.threats[k * 4];
      const ty = f.threats[k * 4 + 1];
      const tz = f.threats[k * 4 + 2];
      const r = f.threats[k * 4 + 3];
      if (!(r > 0.5)) continue;
      const d = Math.hypot(x - tx, y - ty, z - tz);
      const q = d / r;
      if (q < best) {
        best = q;
        const l = Math.max(1e-3, d);
        this.tmp2.x = (x - tx) / l;
        this.tmp2.y = Math.max(0.35, (y - ty) / l);
        this.tmp2.z = (z - tz) / l;
      }
    }
    return best;
  }

  update(f: GullFrame): void {
    const P = this.poses;
    const dt = f.dt;
    const gulls = this.plan.gulls;
    const far = G.dotDistance + 400;
    // player followers: join when underway, leave after lingering stopped
    const pl = f.player;
    const underway = !!pl && pl.valid && pl.speed > G.playerMinKt * 0.514444 && pl.speed < 32 * 0.514444;
    if (underway) {
      this.slowFor = 0;
      if (!this.joined) this.join(pl!);
    } else if (this.joined) {
      this.slowFor += dt;
      if (this.slowFor > G.playerLinger || !pl || !pl.valid) this.joined = false;
    }
    this.flushed.count = 0;
    for (let i = 0; i < gulls.length; i++) {
      const g = gulls[i];
      let bx = 0;
      let by = 0;
      let bz = 0;
      let flying = true;
      let hide = false;
      // ── base position ──
      if (g.role === 'flock') {
        const fl = this.plan.flocks[g.group];
        flockCentre(fl, g.group, f.t, this.c);
        if (Math.hypot(this.c.x - f.camX, this.c.z - f.camZ) > far) hide = true;
        else {
          orbitAt(g, this.c.x, this.c.z, g.alt, f.t, this.tmp);
          bx = this.tmp.x;
          by = this.tmp.y;
          bz = this.tmp.z;
        }
      } else if (g.role === 'fishing') {
        const b = f.fishing[g.group];
        if (!b || !b.valid || Math.hypot(b.x - f.camX, b.z - f.camZ) > far) hide = true;
        else {
          const h = b.heading * DEG;
          const fx = Math.sin(h);
          const fz = -Math.cos(h);
          const back = b.length * 0.5 + 14;
          orbitAt(g, b.x - fx * back, b.z - fz * back, g.alt, f.t, this.tmp);
          bx = this.tmp.x;
          bz = this.tmp.z;
          // plunging to the water now and then
          const dip = smooth(0.85, 1, Math.sin(0.23 * f.t + g.ph * 3.1));
          by = Math.max(2.5, this.tmp.y * (1 - dip) + 1.8 * dip);
        }
      } else if (g.role === 'player') {
        if (!pl || !pl.valid || (!this.joined && Math.hypot(this.dx[i], this.dz[i]) > 380) || !this.active) hide = true;
        else {
          const h = pl.heading * DEG;
          const fx = Math.sin(h);
          const fz = -Math.cos(h);
          const back = pl.length * 0.5 + g.aft;
          const theta = g.ph + 0.6 * f.t * g.sense;
          const ox = -fx * back - fz * g.side + g.r * Math.cos(theta);
          const oz = -fz * back + fx * g.side + g.r * Math.sin(theta);
          bx = pl.x + ox;
          bz = pl.z + oz;
          by = g.alt + 1.5 * Math.sin(0.4 * f.t + g.ph);
        }
      } else {
        // perch: at the spot, or on an excursion circling nearby
        if (Math.hypot(g.px - f.camX, g.pz - f.camZ) > far) hide = true;
        else {
          const q = this.threat(f, g.px, g.py + 0.3, g.pz);
          if (dt > 0) {
            if (q < 1 && this.blend[i] <= 0) {
              // take off away from the threat
              this.offDir[i] = Math.atan2(this.tmp2.z, this.tmp2.x);
              this.flyT[i] = 0;
              this.away[i] = 0;
              this.flushed.count++;
            }
            const airborne = this.blend[i] > 0 || q < 1;
            if (airborne) {
              this.flyT[i] += dt;
              this.away[i] += dt;
              const minAway = 30 + 30 * h01(SEED, 9500, g.key);
              const landing = this.away[i] > minAway && q > 1.6;
              this.blend[i] = clamp(this.blend[i] + (landing ? -dt / 7 : dt / 4), 0, 1);
            }
          }
          const s = this.blend[i] * this.blend[i] * (3 - 2 * this.blend[i]);
          if (s <= 0) {
            bx = g.px;
            by = g.py;
            bz = g.pz;
            flying = false;
          } else {
            const a = this.offDir[i];
            const cx = g.px + Math.cos(a) * 34;
            const cz = g.pz + Math.sin(a) * 34;
            const r = 24;
            const th0 = a + Math.PI; // the orbit's point nearest the perch
            const th = th0 + (g.sense * this.flyT[i] * 8) / r;
            const ox = cx + r * Math.cos(th);
            const oz = cz + r * Math.sin(th);
            const oy = g.py + 16 + 3 * Math.sin(0.3 * this.flyT[i]);
            bx = g.px + (ox - g.px) * s;
            by = g.py + (oy - g.py) * s;
            bz = g.pz + (oz - g.pz) * s;
          }
        }
      }
      if (hide) {
        P.visible[i] = 0;
        this.primed[i] = 0;
        continue;
      }
      // ── sprung displacement: flee threats, ease back; followers joining / leaving ──
      if (dt > 0 && flying) {
        let ax = 0;
        let ay = 0;
        let az = 0;
        const q = this.threat(f, bx + this.dx[i], by + this.dy[i], bz + this.dz[i], g.role === 'player' ? (f.playerThreat ?? -1) : -1);
        if (q < 1) {
          const k = G.scatter.flee * 3 * (1 - q) * (1 - q) + 4;
          ax += this.tmp2.x * k;
          ay += this.tmp2.y * k;
          az += this.tmp2.z * k;
        }
        if (g.role === 'player' && !this.joined) {
          // leaving: climb away astern-ish
          const l = Math.max(1, Math.hypot(this.dx[i], this.dz[i]));
          ax += (this.dx[i] / l) * 1.2 + 0.2 * Math.cos(g.ph);
          az += (this.dz[i] / l) * 1.2 + 0.2 * Math.sin(g.ph);
          ay += 0.15;
        } else {
          const kSpring = g.role === 'player' ? 0.02 : 0.03;
          const cDamp = 2 * Math.sqrt(kSpring);
          ax += -kSpring * this.dx[i] - cDamp * this.vx[i];
          ay += -kSpring * this.dy[i] - cDamp * this.vy[i];
          az += -kSpring * this.dz[i] - cDamp * this.vz[i];
        }
        this.vx[i] += ax * dt;
        this.vy[i] += ay * dt;
        this.vz[i] += az * dt;
        const vm = Math.hypot(this.vx[i], this.vy[i], this.vz[i]);
        if (vm > 16) {
          this.vx[i] *= 16 / vm;
          this.vy[i] *= 16 / vm;
          this.vz[i] *= 16 / vm;
        }
        this.dx[i] += this.vx[i] * dt;
        this.dy[i] += this.vy[i] * dt;
        this.dz[i] += this.vz[i] * dt;
      }
      let x = bx + (flying ? this.dx[i] : 0);
      let y = by + (flying ? this.dy[i] : 0);
      let z = bz + (flying ? this.dz[i] : 0);
      if (flying) y = Math.max(y, 1.6);
      // ── never near the camera ──
      const cdx = x - f.camX;
      const cdy = y - f.camY;
      const cdz = z - f.camZ;
      const cd = Math.hypot(cdx, cdy, cdz);
      if (cd < G.cameraClearance) {
        const s = G.cameraClearance / Math.max(cd, 1e-6);
        if (cd < 1e-6) {
          x = f.camX;
          y = f.camY + G.cameraClearance;
          z = f.camZ;
        } else {
          x = f.camX + cdx * s;
          y = f.camY + cdy * s;
          z = f.camZ + cdz * s;
        }
      }
      // ── attitude from the motion ──
      if (this.primed[i] && dt > 0) {
        const mx = x - this.prevX[i];
        const my = y - this.prevY[i];
        const mz = z - this.prevZ[i];
        const mh = Math.hypot(mx, mz);
        if (flying && mh > 0.02 * dt * 30) {
          const want = Math.atan2(mx, -mz) * RAD;
          let d = want - P.heading[i];
          d = ((((d + 180) % 360) + 360) % 360) - 180;
          const k = 1 - Math.exp(-6 * dt);
          const turn = d * k;
          P.heading[i] = (P.heading[i] + turn + 360) % 360;
          const rate = turn / dt;
          const v = mh / dt;
          P.bank[i] += (clamp(Math.atan((v * rate * DEG) / 9.81) * RAD, -50, 50) - P.bank[i]) * k;
          P.pitch[i] += (clamp(Math.atan2(my, mh) * RAD, -35, 35) - P.pitch[i]) * k;
          const climb = my / dt;
          const flap = flapAmount(g, f.t, climb) + (Math.hypot(this.vx[i], this.vy[i], this.vz[i]) > 3 ? 0.8 : 0);
          P.flap[i] += (clamp(flap, 0, 1) - P.flap[i]) * (1 - Math.exp(-4 * dt));
        } else if (!flying) {
          const k = 1 - Math.exp(-5 * dt);
          let d = g.heading - P.heading[i];
          d = ((((d + 180) % 360) + 360) % 360) - 180;
          P.heading[i] = (P.heading[i] + d * k + 360) % 360;
          P.bank[i] *= 1 - k;
          P.pitch[i] += (8 - P.pitch[i]) * k;
          P.flap[i] *= 1 - k;
        }
      } else if (!this.primed[i]) {
        P.heading[i] = flying ? (g.sense > 0 ? 90 : 270) : g.heading;
        P.flap[i] = flying ? 0.3 : 0;
        P.pitch[i] = flying ? 0 : 8;
        P.bank[i] = 0;
      }
      // wingbeat ≈ 3 Hz, a little faster when working hard
      if (dt > 0) P.phase[i] = (P.phase[i] + TAU * (2.8 + 0.6 * P.flap[i]) * dt) % TAU;
      P.fold[i] = g.role === 'perch' ? 1 - smooth(0, 0.25, this.blend[i]) : 0;
      P.x[i] = x;
      P.y[i] = y;
      P.z[i] = z;
      P.visible[i] = 1;
      this.prevX[i] = x;
      this.prevY[i] = y;
      this.prevZ[i] = z;
      this.primed[i] = 1;
    }
  }

  /** Player followers fly in from a few hundred metres off. */
  private join(pl: BoatPose): void {
    this.joined = true;
    this.active = true;
    const gulls = this.plan.gulls;
    for (let i = 0; i < gulls.length; i++) {
      const g = gulls[i];
      if (g.role !== 'player') continue;
      // already close (rejoining): keep the displacement; else start far off to one side
      if (Math.hypot(this.dx[i], this.dz[i]) < 60 && this.primed[i]) continue;
      const a = (pl.heading + 90 + 180 * (g.side > 0 ? 0 : 1) + hRange(SEED, 9600, g.key, -40, 40)) * DEG;
      const d = hRange(SEED, 9601, g.key, 180, 300);
      this.dx[i] = Math.sin(a) * d;
      this.dz[i] = -Math.cos(a) * d;
      this.dy[i] = 25;
      this.vx[i] = this.vy[i] = this.vz[i] = 0;
      this.primed[i] = 0;
    }
  }

  /** Perched birds flushed this frame (tests / sound). */
  get flushedThisFrame(): number {
    return this.flushed.count;
  }

  /** Is perched bird i on its spot? */
  perched(i: number): boolean {
    return this.plan.gulls[i].role === 'perch' && this.blend[i] <= 0;
  }

  stats(): { gulls: number; visible: number; perched: number; airborneFromPerch: number; followers: boolean } {
    let visible = 0;
    let perched = 0;
    let up = 0;
    this.plan.gulls.forEach((g, i) => {
      if (this.poses.visible[i]) visible++;
      if (g.role === 'perch') {
        if (this.blend[i] > 0) up++;
        else perched++;
      }
    });
    return { gulls: this.plan.gulls.length, visible, perched, airborneFromPerch: up, followers: this.joined };
  }
}
