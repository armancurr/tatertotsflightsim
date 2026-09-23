/**
 * Road traffic simulation (PURE, deterministic): a pool of vehicles driving on
 * the lane graph (lanes.ts) around the camera, stepped at a fixed rate.
 *
 * - Longitudinal: the Intelligent Driver Model (idm.ts) toward a desired
 *   speed = the driver's factor × the lane's allowed speed (limit, curves,
 *   braking for curves ahead) capped by the approach to the next junction
 *   (turn speed), with the vehicle ahead — on the lane, in the junction box or
 *   on the lane beyond — as the leader. A hard spacing constraint makes
 *   overlaps impossible even when a car pulls out in front of another.
 * - Routes: a vehicle picks its exit when it enters a lane (weighted by road
 *   rank, staying on its road, turn type; buses/trucks only where they fit;
 *   tractors only on farm tracks), so it signals and brakes in time.
 * - Junctions: a vehicle must hold its connector before its front passes the
 *   stop line. A grant needs: no conflicting connector held (lanes.ts), a stop
 *   of ≥ 1 s at town stop signs, no higher-priority vehicle arriving within
 *   5 s on a conflicting movement (yield / stop approaches), room on the lane
 *   beyond, and — farm tracks — nobody on the single-lane piece. The priority
 *   road passes freely. Holds are released once the vehicle has left the box.
 * - Streaming: vehicles exist within `radius` of the camera; each lane in range
 *   keeps a target count (density × length in range). New vehicles appear out
 *   of sight (beyond `spawnHideDistance`, or behind the camera) except for the
 *   first fill; they are released beyond `despawnRadius`, at the map edge, or
 *   when stuck out of sight (gridlock safety valve).
 * - Determinism: every choice is a hash of (seed, a vehicle serial, a counter);
 *   the same seed + step count + camera path gives the same traffic.
 */
import { LaneGraph, KIND, type Connector, type LanePoint } from './lanes';
import { SPECS, SEMI, VT } from './specs';
import { idmAccel, approachSpeed, type IdmParams } from './idm';
import { paintFor, trailerPaint } from './paint';
import { hash2i } from '../noise';
import { CONFIG } from '../../config';

export type CarsConfig = typeof CONFIG.world.cars;

export interface SimCamera {
  x: number;
  z: number;
  /** Camera forward direction in xz (unit or zero). */
  fx: number;
  fz: number;
}

/** A point on a vehicle's path, with what the renderer needs for the road height there. */
export interface PathPoint extends LanePoint {
  /** Piece and arc length / across offset (lane points); piece −1 on a connector. */
  piece: number;
  s: number;
  across: number;
  /** Connector id and the fraction along it (connector points). */
  conn: number;
  frac: number;
}

export interface VehiclePose {
  /** Body origin (midway between the axles) and heading (unit, xz). */
  x: number;
  z: number;
  hx: number;
  hz: number;
  /** Front / rear axle points on the path. */
  fx: number;
  fz: number;
  rx: number;
  rz: number;
  /** Front wheel steering angle, rad (+ = right). */
  steer: number;
  front: PathPoint;
  rear: PathPoint;
  /** Semi: kingpin (on the tractor), trailer axle (on the path) and the trailer heading. */
  kx: number;
  kz: number;
  ax: number;
  az: number;
  thx: number;
  thz: number;
  axle: PathPoint;
}

/** Vehicle mix per road kind (weights per VT index). */
const MIX: readonly (readonly number[])[] = [
  [26, 8, 26, 14, 6, 6, 12, 2, 0], // highway
  [28, 10, 28, 18, 6, 5, 0, 2, 0], // road
  [30, 10, 28, 16, 8, 5, 0, 2, 0], // access
  [25, 10, 30, 30, 5, 0, 0, 0, 0], // lane
  [33, 15, 30, 12, 5, 2, 0, 3, 0], // street
  [0, 0, 0, 0, 0, 0, 0, 0, 1], // drive
];
/** Route weight of the road kind a connector leads onto. */
const ROUTE_W = [8, 5, 3, 2, 2.5, 1];

/** Junction holds per vehicle (its own box, the boxes chained through short lanes, the ones its body still covers). */
const HOLDS = 6;

const newPathPoint = (): PathPoint => ({ x: 0, z: 0, hx: 0, hz: 1, piece: -1, s: 0, across: 0, conn: -1, frac: 0 });

export class TrafficSim {
  readonly cfg: CarsConfig;
  readonly seed: number;
  readonly cap: number;
  readonly alive: Uint8Array;
  readonly type: Uint8Array;
  /** Lane (−1 while on a connector), position (vehicle centre, lane u) — or connector and distance along it. */
  readonly lane: Int32Array;
  readonly u: Float64Array;
  readonly conn: Int32Array;
  readonly w: Float64Array;
  readonly v: Float32Array;
  readonly acc: Float32Array;
  /** Chosen exit connector (−1 = leave the map at the lane end); the connector last driven (for poses behind). */
  readonly next: Int32Array;
  readonly prev: Int32Array;
  /** Connectors after `next`, planned ahead when the lanes between are too short to stop on. */
  readonly plan1: Int32Array;
  readonly plan2: Int32Array;
  /** Connectors held (junction right of way): up to HOLDS per vehicle, each released at an odometer reading once clear. */
  readonly holds: Int32Array;
  readonly holdOdo: Float64Array;
  readonly nHold: Uint8Array;
  readonly desire: Float32Array;
  readonly serial: Int32Array;
  readonly odo: Float64Array;
  readonly paint: Uint32Array;
  readonly paint2: Uint32Array;
  readonly stopT: Float32Array;
  readonly stopped: Uint8Array;
  readonly still: Float32Array;
  readonly decisions: Int32Array;
  /** Centre position at the last step. */
  readonly cx: Float64Array;
  readonly cz: Float64Array;
  count = 0;
  time = 0;
  steps = 0;
  spawned = 0;
  released = 0;
  stuckReleased = 0;
  junctions = 0;

  private readonly g: LaneGraph;
  private readonly freeList: Int32Array;
  private freeTop: number;
  private readonly occ: Int32Array;
  /** Connectors swept by a long vehicle's (or a turn-back's) held connector. */
  private readonly occWide: Int32Array;
  private readonly holdWide: Uint8Array;
  private readonly holdsInto: Int32Array;
  private readonly hint: Int32Array;
  // per-step lists
  private readonly laneCnt: Int32Array;
  private readonly laneOff: Int32Array;
  private readonly connCnt: Int32Array;
  private readonly connOff: Int32Array;
  private readonly touchedL: Int32Array;
  private readonly touchedC: Int32Array;
  private nTL = 0;
  private nTC = 0;
  private readonly lorder: Int32Array;
  private readonly corder: Int32Array;
  private readonly ahead: Int32Array;
  // streaming
  private activeLanes: number[] = [];
  private activeTarget: number[] = [];
  private activeDrive: number[] = [];
  private refX = NaN;
  private refZ = NaN;
  private lastX = NaN;
  private lastZ = NaN;
  private firstFill = true;
  private cursor = 0;
  private serialNext = 1;
  private tractors = 0;
  private readonly newL: number[] = [];
  private readonly newU: number[] = [];
  private readonly params: IdmParams[];
  private readonly pp: PathPoint = newPathPoint();

  constructor(graph: LaneGraph, opts: { cfg?: CarsConfig; seed?: number } = {}) {
    this.g = graph;
    this.cfg = opts.cfg ?? CONFIG.world.cars;
    this.seed = (opts.seed ?? this.cfg.seed) | 0;
    const N = Math.max(1, this.cfg.maxMoving | 0);
    this.cap = N;
    this.alive = new Uint8Array(N);
    this.type = new Uint8Array(N);
    this.lane = new Int32Array(N).fill(-1);
    this.u = new Float64Array(N);
    this.conn = new Int32Array(N).fill(-1);
    this.w = new Float64Array(N);
    this.v = new Float32Array(N);
    this.acc = new Float32Array(N);
    this.next = new Int32Array(N).fill(-1);
    this.prev = new Int32Array(N).fill(-1);
    this.plan1 = new Int32Array(N).fill(-1);
    this.plan2 = new Int32Array(N).fill(-1);
    this.holds = new Int32Array(N * HOLDS).fill(-1);
    this.holdOdo = new Float64Array(N * HOLDS);
    this.nHold = new Uint8Array(N);
    this.desire = new Float32Array(N);
    this.serial = new Int32Array(N);
    this.odo = new Float64Array(N);
    this.paint = new Uint32Array(N);
    this.paint2 = new Uint32Array(N);
    this.stopT = new Float32Array(N);
    this.stopped = new Uint8Array(N);
    this.still = new Float32Array(N);
    this.decisions = new Int32Array(N);
    this.cx = new Float64Array(N);
    this.cz = new Float64Array(N);
    this.hint = new Int32Array(N).fill(-1);
    this.freeList = new Int32Array(N);
    for (let i = 0; i < N; i++) this.freeList[i] = N - 1 - i;
    this.freeTop = N;
    this.occ = new Int32Array(graph.connectors.length);
    this.occWide = new Int32Array(graph.connectors.length);
    this.holdWide = new Uint8Array(N * HOLDS);
    this.holdsInto = new Int32Array(graph.pieceCount);
    this.laneCnt = new Int32Array(graph.laneCount);
    this.laneOff = new Int32Array(graph.laneCount);
    this.connCnt = new Int32Array(graph.connectors.length);
    this.connOff = new Int32Array(graph.connectors.length);
    this.touchedL = new Int32Array(N);
    this.touchedC = new Int32Array(N);
    this.lorder = new Int32Array(N);
    this.corder = new Int32Array(N);
    this.ahead = new Int32Array(N).fill(-1);
    const idm = this.cfg.idm;
    this.params = SPECS.map((s) => ({ T: idm.timeHeadway * (s.length > 7 ? 1.25 : 1), s0: idm.minGap, a: Math.min(idm.accel, s.accel), b: Math.min(idm.decel, s.decel), maxDecel: idm.maxDecel }));
  }

  static newPose(): VehiclePose {
    return { x: 0, z: 0, hx: 0, hz: -1, fx: 0, fz: 0, rx: 0, rz: 0, steer: 0, front: newPathPoint(), rear: newPathPoint(), kx: 0, kz: 0, ax: 0, az: 0, thx: 0, thz: -1, axle: newPathPoint() };
  }

  /** Connectors held (for tests). */
  occupancy(c: number): number {
    return this.occ[c];
  }

  /** Releases everything (teleport / reset). */
  reset(): void {
    for (let i = 0; i < this.cap; i++) if (this.alive[i]) this.release(i);
    this.firstFill = true;
    this.refX = NaN;
    this.refZ = NaN;
  }

  /** Runs whole steps for dt seconds of clock (at most 4); returns the time since the last step (for extrapolation). */
  private acc_t = 0;
  advance(dt: number, cam: SimCamera): number {
    const h = this.cfg.step;
    this.acc_t += Math.max(0, Math.min(dt, 0.25));
    let n = 0;
    while (this.acc_t >= h && n < 4) {
      this.step(cam);
      this.acc_t -= h;
      n++;
    }
    if (this.acc_t > h) this.acc_t = h;
    return this.acc_t;
  }

  /** One fixed step. */
  step(cam: SimCamera): void {
    const dt = this.cfg.step;
    this.time += dt;
    this.steps++;
    // a jump (teleport, reset) refills the new place at once, like the first step
    if (Math.hypot(cam.x - this.lastX, cam.z - this.lastZ) > 1000) this.firstFill = true;
    this.lastX = cam.x;
    this.lastZ = cam.z;
    if (!(Math.abs(cam.x - this.refX) < 120 && Math.abs(cam.z - this.refZ) < 120)) this.refreshActive(cam);
    // positions, despawn, stuck
    const R2 = this.cfg.despawnRadius ** 2;
    const pp = this.pp;
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      this.pathPoint(i, 0, pp);
      this.cx[i] = pp.x;
      this.cz[i] = pp.z;
      const dx = pp.x - cam.x;
      const dz = pp.z - cam.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > R2) {
        this.release(i);
        continue;
      }
      if (this.v[i] < 0.1) this.still[i] += dt;
      else this.still[i] = 0;
      if (this.still[i] > this.cfg.stuckTimeout) {
        const d = Math.sqrt(d2);
        const behind = dx * cam.fx + dz * cam.fz < -0.2 * d;
        if (d > 250 || behind || this.still[i] > this.cfg.stuckTimeout * 3) {
          this.release(i);
          this.stuckReleased++;
        }
      }
    }
    this.buildLists();
    for (let i = 0; i < this.cap; i++) if (this.alive[i]) this.think(i, dt);
    for (let i = 0; i < this.cap; i++) if (this.alive[i]) this.move(i, dt);
    this.buildLists();
    this.enforceSpacing();
    this.spawn(cam);
    this.firstFill = false;
  }

  // ─── lists ────────────────────────────────────────────────────────────────

  private buildLists(): void {
    for (let k = 0; k < this.nTL; k++) this.laneCnt[this.touchedL[k]] = 0;
    for (let k = 0; k < this.nTC; k++) this.connCnt[this.touchedC[k]] = 0;
    this.nTL = 0;
    this.nTC = 0;
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      const c = this.conn[i];
      if (c >= 0) {
        if (this.connCnt[c]++ === 0) this.touchedC[this.nTC++] = c;
      } else {
        const l = this.lane[i];
        if (this.laneCnt[l]++ === 0) this.touchedL[this.nTL++] = l;
      }
    }
    let o = 0;
    for (let k = 0; k < this.nTL; k++) {
      const l = this.touchedL[k];
      this.laneOff[l] = o;
      o += this.laneCnt[l];
    }
    let oc = 0;
    for (let k = 0; k < this.nTC; k++) {
      const c = this.touchedC[k];
      this.connOff[c] = oc;
      oc += this.connCnt[c];
    }
    // fill (reusing the counts as cursors, then restoring them)
    for (let k = 0; k < this.nTL; k++) this.laneCnt[this.touchedL[k]] = 0;
    for (let k = 0; k < this.nTC; k++) this.connCnt[this.touchedC[k]] = 0;
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      const c = this.conn[i];
      if (c >= 0) this.corder[this.connOff[c] + this.connCnt[c]++] = i;
      else {
        const l = this.lane[i];
        this.lorder[this.laneOff[l] + this.laneCnt[l]++] = i;
      }
    }
    // sort each list by position (insertion sort: lists are short and nearly sorted) and link
    const sortLink = (order: Int32Array, off: number, n: number, pos: Float64Array) => {
      for (let a = off + 1; a < off + n; a++) {
        const x = order[a];
        const px = pos[x];
        let b = a - 1;
        while (b >= off && pos[order[b]] > px) {
          order[b + 1] = order[b];
          b--;
        }
        order[b + 1] = x;
      }
      for (let a = off; a < off + n; a++) this.ahead[order[a]] = a + 1 < off + n ? order[a + 1] : -1;
    };
    for (let k = 0; k < this.nTL; k++) {
      const l = this.touchedL[k];
      sortLink(this.lorder, this.laneOff[l], this.laneCnt[l], this.u);
    }
    for (let k = 0; k < this.nTC; k++) {
      const c = this.touchedC[k];
      sortLink(this.corder, this.connOff[c], this.connCnt[c], this.w);
    }
  }

  /** Last (rearmost) vehicle on a lane / connector, −1 if none. */
  private laneTail(l: number): number {
    return this.laneCnt[l] > 0 ? this.lorder[this.laneOff[l]] : -1;
  }
  private laneFront(l: number): number {
    return this.laneCnt[l] > 0 ? this.lorder[this.laneOff[l] + this.laneCnt[l] - 1] : -1;
  }
  private connTail(c: number): number {
    return this.connCnt[c] > 0 ? this.corder[this.connOff[c]] : -1;
  }

  // ─── behaviour ───────────────────────────────────────────────────────────

  /** Is connector k among vehicle i's holds? */
  holdsConn(i: number, k: number): boolean {
    const b = i * HOLDS;
    for (let m = 0; m < this.nHold[i]; m++) if (this.holds[b + m] === k) return true;
    return false;
  }

  /** Connectors held by vehicle i (tests). */
  holdsOf(i: number): number[] {
    const out: number[] = [];
    for (let m = 0; m < this.nHold[i]; m++) out.push(this.holds[i * HOLDS + m]);
    return out;
  }

  /** A long vehicle, or any vehicle turning back, sweeps a wide area through connector c. */
  private sweepsWide(i: number, c: Connector): boolean {
    return c.turn === 2 || (c.turn !== 0 && SPECS[this.type[i]].length > 7);
  }

  private addHold(i: number, k: number): void {
    if (this.holdsConn(i, k)) return;
    const b = i * HOLDS;
    const m = this.nHold[i]++;
    const c = this.g.connectors[k];
    this.holds[b + m] = k;
    this.holdOdo[b + m] = Infinity;
    this.occ[k]++;
    const wide = this.sweepsWide(i, c);
    this.holdWide[b + m] = wide ? 1 : 0;
    if (wide) for (const j of c.wide) this.occWide[j]++;
    const po = c.outLane >> 1;
    if (this.g.pSingle[po]) this.holdsInto[po]++;
  }

  private dropHold(i: number, m: number): void {
    const b = i * HOLDS;
    const k = this.holds[b + m];
    const c = this.g.connectors[k];
    this.occ[k]--;
    if (this.holdWide[b + m]) for (const j of c.wide) this.occWide[j]--;
    const po = c.outLane >> 1;
    if (this.g.pSingle[po]) this.holdsInto[po]--;
    const n = --this.nHold[i];
    this.holds[b + m] = this.holds[b + n];
    this.holdOdo[b + m] = this.holdOdo[b + n];
    this.holdWide[b + m] = this.holdWide[b + n];
  }

  /** Wide sweeps over connector k by vehicles other than i. */
  private occWideOthers(k: number, i: number): number {
    let own = 0;
    const b = i * HOLDS;
    for (let m = 0; m < this.nHold[i]; m++) if (this.holdWide[b + m] && this.g.connectors[this.holds[b + m]].wide.includes(k)) own++;
    return this.occWide[k] - own;
  }

  private dropAllHolds(i: number): void {
    while (this.nHold[i] > 0) this.dropHold(i, this.nHold[i] - 1);
  }

  /** Vehicle i drove off connector k: the hold ends once its rear has cleared the box. */
  private leftConnector(i: number, k: number): void {
    const b = i * HOLDS;
    for (let m = 0; m < this.nHold[i]; m++) if (this.holds[b + m] === k) this.holdOdo[b + m] = this.odo[i] + SPECS[this.type[i]].length / 2 + 1.5;
  }

  /** Occupancy of connector k by vehicles other than i. */
  private occOthers(k: number, i: number): number {
    return this.occ[k] - (this.holdsConn(i, k) ? 1 : 0);
  }

  /** Nearest vehicle on the connectors leaving in-lane l with w > wMin (−1 if none); its w in this.sw. */
  private sw = 0;
  private siblingAhead(l: number, wMin: number, self: number): number {
    const g = this.g;
    let best = -1;
    let bw = Infinity;
    const n = g.laneConnCount[l];
    const s0 = g.laneConnStart[l];
    for (let k = 0; k <= n; k++) {
      const c = k < n ? g.laneConn[s0 + k] : g.laneUturn[l];
      if (c < 0 || this.connCnt[c] === 0) continue;
      const off = this.connOff[c];
      for (let a = off; a < off + this.connCnt[c]; a++) {
        const j = this.corder[a];
        if (j === self) continue;
        // a vehicle turning back (U-turn, acute junction) swings across the queue behind it: it counts as still at the line
        const wj = g.connectors[c].turn === 2 ? Math.min(this.w[j], wMin + 1e-6) : this.w[j];
        if (wj > wMin) {
          if (wj < bw) {
            bw = wj;
            best = j;
          }
          break;
        }
      }
    }
    this.sw = bw;
    return best;
  }

  /** The vehicle ahead of i along its path (not stop lines): index or −1; bumper gap in this.lg, its speed in this.lv. */
  private lg = Infinity;
  private lv = 0;
  private leaderOf(i: number): number {
    const j = this.leaderRaw(i);
    // bodies at an angle in a turn need more room than the gap along the path
    if (j >= 0 && (this.turning(i) || this.turning(j))) this.lg -= 1.3;
    return j;
  }

  private turning(i: number): boolean {
    const c = this.conn[i];
    return c >= 0 && this.g.connectors[c].turn !== 0;
  }

  private leaderRaw(i: number): number {
    const g = this.g;
    const len = SPECS[this.type[i]].length;
    const ci = this.conn[i];
    if (ci >= 0) {
      const c = g.connectors[ci];
      const j = this.siblingAhead(c.inLane, this.w[i] - 1e-9, i);
      if (j >= 0) {
        this.lg = this.sw - this.w[i] - (len + SPECS[this.type[j]].length) / 2;
        this.lv = this.v[j];
        return j;
      }
      return this.walkAhead(i, c, c.len - this.w[i], len);
    }
    const j = this.ahead[i];
    if (j >= 0) {
      this.lg = this.u[j] - this.u[i] - (len + SPECS[this.type[j]].length) / 2;
      this.lv = this.v[j];
      return j;
    }
    const k = this.next[i];
    if (k < 0) {
      // leaving at the lane end (map edge, no route): whoever turns off this lane ahead is still ahead
      const t = this.siblingAhead(this.lane[i], -1, i);
      if (t < 0) return -1;
      const cc = g.connectors[this.conn[t]];
      this.lg = cc.inU - this.u[i] + this.sw - (len + SPECS[this.type[t]].length) / 2;
      this.lv = this.v[t];
      return t;
    }
    if (!this.holdsConn(i, k)) return -1;
    const c = g.connectors[k];
    const dIn = c.inU - this.u[i];
    const t = this.siblingAhead(this.lane[i], -1, i);
    if (t >= 0) {
      this.lg = dIn + this.sw - (len + SPECS[this.type[t]].length) / 2;
      this.lv = this.v[t];
      return t;
    }
    return this.walkAhead(i, c, dIn + c.len, len);
  }

  /** Continues the leader search past connector c (the vehicle is `dist` from its end): its out-lane, then the held planned connectors. */
  private walkAhead(i: number, c: Connector, dist: number, len: number): number {
    const g = this.g;
    let lane = c.outLane;
    let entry = c.outU;
    for (let depth = 0; depth < 3 && dist < 250; depth++) {
      const o = this.laneTail(lane);
      if (o >= 0 && o !== i) {
        this.lg = dist + (this.u[o] - entry) - (len + SPECS[this.type[o]].length) / 2;
        this.lv = this.v[o];
        return o;
      }
      const kk = depth === 0 ? this.plan1[i] : depth === 1 ? this.plan2[i] : -1;
      if (kk < 0 || !this.holdsConn(i, kk)) return -1;
      const cc = g.connectors[kk];
      if (cc.inLane !== lane) return -1;
      dist += cc.inU - entry;
      const t = this.siblingAhead(lane, -1, i);
      if (t >= 0) {
        this.lg = dist + this.sw - (len + SPECS[this.type[t]].length) / 2;
        this.lv = this.v[t];
        return t;
      }
      dist += cc.len;
      lane = cc.outLane;
      entry = cc.outU;
    }
    return -1;
  }

  private think(i: number, dt: number): void {
    const g = this.g;
    const t = this.type[i];
    const sp = SPECS[t];
    const P = this.params[t];
    const len = sp.length;
    const v = this.v[i];
    let v0: number;
    let gap = Infinity;
    let vLead = 0;
    if (this.leaderOf(i) >= 0) {
      gap = this.lg;
      vLead = this.lv;
    }
    const ci = this.conn[i];
    if (ci >= 0) {
      v0 = Math.min(sp.vmax, g.connectors[ci].vTurn * (0.9 + 0.1 * this.desire[i]));
    } else {
      const l = this.lane[i];
      const u = this.u[i];
      v0 = Math.min(sp.vmax, this.desire[i] * g.allowedSpeed(l, u, this.hint[i]));
      const k = this.next[i];
      if (k >= 0) {
        const c = g.connectors[k];
        const dLine = c.inU - u - len / 2;
        const front = this.ahead[i] < 0;
        if (front && !this.holdsConn(i, k)) this.request(i, c, dLine, dt);
        // don't block the box: at the line, a granted vehicle that could not clear it any more gives the grant back
        // (never on a lane too short to stop on: it is part of a chain through the junction)
        else if (front && dLine < 3 && g.laneExitU[l] - g.laneEntryU[l] >= len + 3 && !this.roomBeyond(i, c)) this.ungrant(i);
        if (!this.holdsConn(i, this.next[i])) {
          // the stop line is a stationary obstacle until the junction is granted
          if (front && dLine < gap) {
            gap = dLine;
            vLead = 0;
          }
          if (c.stop === 1) v0 = Math.min(v0, approachSpeed(4.5, dLine, P.b));
        } else if (c.len > 0) v0 = Math.min(v0, approachSpeed(c.vTurn, dLine, P.b));
      }
    }
    this.acc[i] = idmAccel(v, v0, gap, v - vLead, P);
  }

  /** Can vehicle i use connector c now (conflicts, priority, farm tracks)? `first`: the connector at its own stop line. */
  private free(i: number, c: Connector): boolean {
    const g = this.g;
    // a long vehicle (or a turn-back) needs its whole swept area clear; everyone keeps out of such sweeps
    const conf = this.sweepsWide(i, c) ? c.wide : c.conflicts;
    for (let k = 0; k < conf.length; k++) if (this.occOthers(conf[k], i) > 0) return false;
    if (this.occWide[c.id] > 0 && this.occWideOthers(c.id, i) > 0) return false;
    if (c.stop > 0) {
      for (let k = 0; k < conf.length; k++) {
        const cj = g.connectors[conf[k]];
        if (cj.prio <= c.prio) continue;
        const f = this.laneFront(cj.inLane);
        if (f < 0 || f === i || this.next[f] !== cj.id) continue;
        const eta = (cj.inU - this.u[f]) / Math.max(this.v[f], 2);
        if (eta < 5) return false;
      }
    }
    const po = c.outLane >> 1;
    if (g.pSingle[po] && po !== c.inLane >> 1) {
      const self = this.lane[i] >> 1 === po ? 1 : 0;
      if (this.laneCnt[po * 2] + this.laneCnt[po * 2 + 1] - self + this.holdsInto[po] > 0) return false;
    }
    return true;
  }

  /** Is there room for vehicle i beyond its (chain of) connectors starting with c? */
  private roomBeyond(i: number, c: Connector): boolean {
    const g = this.g;
    let last = c;
    const p1 = this.plan1[i];
    if (p1 >= 0 && this.holdsConn(i, p1) && g.connectors[p1].inLane === c.outLane) {
      last = g.connectors[p1];
      const p2 = this.plan2[i];
      if (p2 >= 0 && this.holdsConn(i, p2) && g.connectors[p2].inLane === last.outLane) last = g.connectors[p2];
    }
    const o = this.laneTail(last.outLane);
    if (o < 0 || o === i) return true;
    return this.u[o] - SPECS[this.type[o]].length / 2 - last.outU >= SPECS[this.type[i]].length + 1;
  }

  /** Gives back the holds of junctions not entered yet (the ones still waiting for this vehicle's body). */
  private ungrant(i: number): void {
    const b = i * HOLDS;
    for (let m = this.nHold[i] - 1; m >= 0; m--) if (this.holdOdo[b + m] === Infinity) this.dropHold(i, m);
  }

  /** Asks for the right of way through connector c (see the header), chaining through lanes too short to stop on. */
  private readonly chain: Connector[] = [];
  private request(i: number, c: Connector, dLine: number, dt: number): void {
    const g = this.g;
    const v = this.v[i];
    const P = this.params[this.type[i]];
    const len = SPECS[this.type[i]].length;
    const reach = (v * v) / (2 * P.b) + v * 1.5 + 8;
    if (dLine > reach) return;
    if (c.stop === 2 && !this.stopped[i]) {
      if (v < 0.3 && dLine < this.cfg.idm.minGap + 2.5) {
        this.stopT[i] += dt;
        if (this.stopT[i] >= 1) this.stopped[i] = 1;
      }
      if (!this.stopped[i]) return;
    }
    // the connectors this vehicle must hold at once: through every lane too short to stop on
    const chain = this.chain;
    chain.length = 0;
    chain.push(c);
    let cur = c;
    for (let depth = 0; depth < 2; depth++) {
      const ol = cur.outLane;
      if (g.laneExitNode[ol] < 0 || g.laneExitU[ol] - cur.outU >= len + 3) break;
      let nk = depth === 0 ? this.plan1[i] : this.plan2[i];
      if (nk < 0 || g.connectors[nk].inLane !== ol) {
        nk = this.chooseNext(i, ol);
        if (depth === 0) this.plan1[i] = nk;
        else this.plan2[i] = nk;
      }
      if (nk < 0) break;
      cur = g.connectors[nk];
      chain.push(cur);
    }
    for (const k of chain) {
      if (this.holdsConn(i, k.id)) continue;
      if (!this.free(i, k)) {
        // a tractor meeting another on a farm track turns round instead of waiting
        if (k === c && this.type[i] === VT.tractor && g.pSingle[c.outLane >> 1]) {
          const ut = g.laneUturn[this.lane[i]];
          if (ut >= 0 && ut !== c.id) {
            this.next[i] = ut;
            this.plan1[i] = -1;
            this.plan2[i] = -1;
          }
        }
        return;
      }
    }
    // a U-turn sweeps across the other lane and needs its own lane clear ahead
    if (c.turn === 2) {
      const j = this.ahead[i];
      if (j >= 0 && this.u[j] - this.u[i] < len + SPECS[this.type[j]].length / 2 + 9) return;
      const ol = c.outLane;
      const off = this.laneOff[ol];
      for (let a = off; a < off + this.laneCnt[ol]; a++) {
        const o = this.lorder[a];
        if (o !== i && this.u[o] < c.outU + len + SPECS[this.type[o]].length / 2 + 3) return;
      }
    }
    // room beyond the last box
    const last = chain[chain.length - 1];
    const o = this.laneTail(last.outLane);
    if (o >= 0 && o !== i) {
      const room = this.u[o] - SPECS[this.type[o]].length / 2 - last.outU;
      if (room < len + 2) return;
    }
    if (this.nHold[i] + chain.length > HOLDS) return;
    for (const k of chain) this.addHold(i, k.id);
  }

  private move(i: number, dt: number): void {
    const g = this.g;
    const sp = SPECS[this.type[i]];
    let v = this.v[i] + this.acc[i] * dt;
    v = v < 0 ? 0 : v > sp.vmax ? sp.vmax : v;
    let d = v * dt;
    for (let guard = 0; guard < 4 && d >= 0; guard++) {
      const ci = this.conn[i];
      if (ci >= 0) {
        const c = g.connectors[ci];
        const w = this.w[i] + d;
        if (w < c.len) {
          this.w[i] = w;
          break;
        }
        // onto the out lane
        d = w - c.len;
        this.conn[i] = -1;
        this.w[i] = 0;
        this.lane[i] = c.outLane;
        this.u[i] = c.outU;
        this.prev[i] = c.id;
        this.hint[i] = -1;
        this.leftConnector(i, c.id);
        this.enterLane(i);
        continue;
      }
      const l = this.lane[i];
      const k = this.next[i];
      let u = this.u[i] + d;
      if (k < 0) {
        // leaving the map (or nowhere to go): released at the lane end
        if (u >= g.laneLen[l] - 0.05) {
          this.release(i);
          return;
        }
        this.u[i] = u;
        break;
      }
      const c = g.connectors[k];
      if (!this.holdsConn(i, k)) {
        // the front may not pass the stop line
        const lim = c.inU - sp.length / 2;
        if (u > lim) {
          u = Math.max(this.u[i], lim);
          v = 0;
        }
        this.u[i] = Math.min(u, g.laneLen[l]);
        break;
      }
      if (u < c.inU) {
        this.u[i] = u;
        break;
      }
      // into the junction
      d = u - c.inU;
      this.u[i] = c.inU;
      this.lane[i] = -1;
      this.conn[i] = k;
      this.w[i] = 0;
      this.junctions++;
      if (c.len <= 0) continue;
    }
    this.v[i] = v;
    this.odo[i] += v * dt;
    // holds end once the vehicle is clear of their boxes
    const b = i * HOLDS;
    for (let m = this.nHold[i] - 1; m >= 0; m--) if (this.odo[i] >= this.holdOdo[b + m]) this.dropHold(i, m);
  }

  /** A vehicle arrived on a lane: take the planned exit (or pick one), reset the stop sign state. */
  private enterLane(i: number): void {
    this.stopped[i] = 0;
    this.stopT[i] = 0;
    const l = this.lane[i];
    const p1 = this.plan1[i];
    if (p1 >= 0 && this.g.connectors[p1].inLane === l) {
      this.next[i] = p1;
      this.plan1[i] = this.plan2[i];
      this.plan2[i] = -1;
    } else {
      this.plan1[i] = -1;
      this.plan2[i] = -1;
      this.next[i] = this.chooseNext(i, l);
    }
  }

  private chooseNext(i: number, l: number): number {
    const g = this.g;
    if (g.laneDespawn[l]) return -1;
    const t = this.type[i];
    const W = SPECS[t].width;
    const n = g.laneConnCount[l];
    const s0 = g.laneConnStart[l];
    const road = g.pRoad[l >> 1];
    let sum = 0;
    for (let k = 0; k < n; k++) sum += this.routeWeight(g.connectors[g.laneConn[s0 + k]], t, W, road);
    // nowhere to go: turn round (a long vehicle cannot — it leaves at the lane end)
    const fallback = SPECS[t].length > 7 ? -1 : g.laneUturn[l];
    if (sum <= 0) return fallback;
    let x = hash2i(this.serial[i], this.decisions[i]++, this.seed ^ 0x51f3) * sum;
    for (let k = 0; k < n; k++) {
      const c = g.connectors[g.laneConn[s0 + k]];
      x -= this.routeWeight(c, t, W, road);
      if (x < 0) return c.id;
    }
    return fallback;
  }

  /** May a vehicle of type t be spawned on lane l (a road it may use, and a way on or off it)? */
  private admissible(t: number, l: number): boolean {
    const g = this.g;
    const kind = g.pKind[l >> 1];
    if (t === VT.semi && kind !== KIND.highway) return false;
    if (t === VT.bus && kind === KIND.street && g.pWidth[l >> 1] < 8) return false;
    // a long vehicle cannot turn round: it needs an exit it may take (or the map edge)
    if (SPECS[t].length > 7 && !g.laneDespawn[l]) {
      const n = g.laneConnCount[l];
      const s0 = g.laneConnStart[l];
      let ok = false;
      for (let k = 0; k < n && !ok; k++) if (this.routeWeight(g.connectors[g.laneConn[s0 + k]], t, SPECS[t].width, g.pRoad[l >> 1]) > 0) ok = true;
      if (!ok) return false;
    }
    return true;
  }

  private routeWeight(c: Connector, t: number, W: number, road: number): number {
    const g = this.g;
    const po = c.outLane >> 1;
    const kind = g.pKind[po];
    if ((t === VT.tractor) !== (kind === KIND.drive)) return 0;
    if (W > g.laneMaxW[c.outLane] + 1e-6) return 0;
    // semis keep to highways, buses to roads and wide streets (their swept path is wide)
    if (t === VT.semi && kind !== KIND.highway) return 0;
    if (t === VT.bus && kind === KIND.street && g.pWidth[po] < 8) return 0;
    let w = ROUTE_W[kind] * (g.pRoad[po] === road ? 3 : 1);
    if (c.turn === -1) w *= 0.8;
    // avoid lanes that end at the map edge
    if (g.laneDespawn[c.outLane]) w *= 0.3;
    return w;
  }

  /** Hard spacing: nobody ends a step closer than 0.3 m behind the vehicle ahead (pushed back, speed matched). */
  private enforceSpacing(): void {
    for (let sweep = 0; sweep < 3; sweep++) {
      let moved = false;
      for (let i = 0; i < this.cap; i++) {
        if (!this.alive[i]) continue;
        const j = this.leaderOf(i);
        if (j < 0 || this.lg >= 0.3) continue;
        const back = 0.3 - this.lg;
        if (this.conn[i] >= 0) this.w[i] = Math.max(0, this.w[i] - back);
        else this.u[i] = Math.max(0, this.u[i] - back);
        if (this.v[i] > this.v[j]) this.v[i] = this.v[j];
        moved = true;
      }
      if (!moved) break;
    }
  }

  // ─── streaming ───────────────────────────────────────────────────────────

  private refreshActive(cam: SimCamera): void {
    const g = this.g;
    this.refX = cam.x;
    this.refZ = cam.z;
    const R = this.cfg.radius;
    const R2 = R * R;
    const dens = this.cfg.density;
    const perKind = [dens.highway, dens.road, dens.access, dens.lane, dens.street, dens.drive];
    this.activeLanes.length = 0;
    this.activeTarget.length = 0;
    this.activeDrive.length = 0;
    for (let p = 0; p < g.pieceCount; p++) {
      const bx0 = g.pBox[p * 4];
      const bz0 = g.pBox[p * 4 + 1];
      const bx1 = g.pBox[p * 4 + 2];
      const bz1 = g.pBox[p * 4 + 3];
      const dx = cam.x < bx0 ? bx0 - cam.x : cam.x > bx1 ? cam.x - bx1 : 0;
      const dz = cam.z < bz0 ? bz0 - cam.z : cam.z > bz1 ? cam.z - bz1 : 0;
      if (dx * dx + dz * dz > R2) continue;
      const a = g.pStart[p];
      const n = g.pCount[p];
      let inLen = 0;
      for (let k = a; k < a + n - 1; k++) {
        const mx = (g.px[k] + g.px[k + 1]) / 2 - cam.x;
        const mz = (g.pz[k] + g.pz[k + 1]) / 2 - cam.z;
        if (mx * mx + mz * mz < R2) inLen += g.ps[k + 1] - g.ps[k];
      }
      if (inLen < 5) continue;
      const kind = g.pKind[p];
      if (kind === KIND.drive) {
        this.activeDrive.push(p);
        continue;
      }
      let d = perKind[kind];
      if (kind === KIND.street && !(g.pFlags[p] & 1)) d *= this.cfg.villageStreetFactor;
      const target = (d * inLen) / 1000;
      if (target <= 0) continue;
      this.activeLanes.push(p * 2, p * 2 + 1);
      this.activeTarget.push(target, target);
    }
  }

  private spawn(cam: SimCamera): void {
    const n = this.activeLanes.length;
    this.newL.length = 0;
    this.newU.length = 0;
    if (n > 0 && this.count < this.cap) {
      if (this.firstFill) {
        for (let idx = 0; idx < n && this.count < this.cap; idx++) {
          const l = this.activeLanes[idx];
          const want = Math.floor(this.activeTarget[idx] + hash2i(l, 0x77, this.seed));
          for (let tries = 0; tries < want * 2 + 3 && this.laneCnt[l] + this.countNew(l) < want && this.count < this.cap; tries++) this.trySpawn(l, cam, tries * 7919 + idx);
        }
      } else {
        for (let a = 0; a < 6 && this.count < this.cap; a++) {
          const idx = this.cursor++ % n;
          const l = this.activeLanes[idx];
          const want = Math.floor(this.activeTarget[idx] + hash2i(l, 0x77, this.seed));
          if (this.laneCnt[l] + this.countNew(l) >= want) continue;
          this.trySpawn(l, cam, a);
        }
      }
    }
    // tractors on farm tracks
    if (this.tractors < this.cfg.tractors && this.activeDrive.length > 0 && (this.firstFill || this.steps % 15 === 0)) {
      const tries = this.firstFill ? this.cfg.tractors * 3 : 1;
      for (let k = 0; k < tries && this.tractors < this.cfg.tractors && this.count < this.cap; k++) {
        const h = hash2i(this.steps, k + 991, this.seed);
        const p = this.activeDrive[Math.floor(h * this.activeDrive.length)];
        if (this.laneCnt[p * 2] + this.laneCnt[p * 2 + 1] + this.holdsInto[p] + this.countNew(p * 2) + this.countNew(p * 2 + 1) > 0) continue;
        if (this.g.pLen[p] < 40) continue;
        this.trySpawn(p * 2 + (hash2i(this.steps, k + 17, this.seed) < 0.5 ? 0 : 1), cam, k + 5000, VT.tractor);
      }
    }
  }

  private countNew(l: number): number {
    let c = 0;
    for (let k = 0; k < this.newL.length; k++) if (this.newL[k] === l) c++;
    return c;
  }

  private trySpawn(l: number, cam: SimCamera, salt: number, forceType = -1): number {
    const g = this.g;
    const u0 = g.laneEntryU[l] + 20;
    const u1 = g.laneExitU[l] - 20;
    if (u1 <= u0) return -1;
    const h1 = hash2i(this.steps * 131 + salt, l, this.seed ^ 0x1234);
    const u = u0 + (u1 - u0) * h1;
    const pp = this.pp;
    g.lanePoint(l, u, pp);
    const dx = pp.x - cam.x;
    const dz = pp.z - cam.z;
    const d = Math.hypot(dx, dz);
    if (d > this.cfg.radius) return -1;
    if (!this.firstFill) {
      const behind = d > 150 && dx * cam.fx + dz * cam.fz < -0.25 * d;
      if (d < this.cfg.spawnHideDistance && !behind) return -1;
    }
    // vehicle type for this road
    const p = l >> 1;
    let t = forceType;
    if (t < 0) {
      const mix = MIX[g.pKind[p]];
      let sum = 0;
      for (let k = 0; k < mix.length; k++) sum += mix[k];
      let x = hash2i(this.steps * 7 + salt, l, this.seed ^ 0x2f1) * sum;
      t = 0;
      for (let k = 0; k < mix.length; k++) {
        x -= mix[k];
        if (x < 0) {
          t = k;
          break;
        }
      }
      if (SPECS[t].width > g.laneMaxW[l] || !this.admissible(t, l)) t = VT.sedan;
    }
    const sp = SPECS[t];
    if (sp.width > g.laneMaxW[l] + 1e-6) return -1;
    // spacing to the vehicles on this lane (and ones spawned this step)
    const clear = 22;
    const off = this.laneOff[l];
    const cnt = this.laneCnt[l];
    let vLead = Infinity;
    let dLead = Infinity;
    for (let k = 0; k < cnt; k++) {
      const j = this.lorder[off + k];
      const gap = this.u[j] - u;
      const need = clear + (sp.length + SPECS[this.type[j]].length) / 2;
      if (Math.abs(gap) < need) return -1;
      if (gap > 0 && gap < dLead) {
        dLead = gap;
        vLead = this.v[j];
      }
    }
    for (let k = 0; k < this.newL.length; k++) if (this.newL[k] === l && Math.abs(this.newU[k] - u) < clear + 22) return -1;
    // vehicles in the junction boxes at either end of the lane count as on it
    for (let k = 0; k < this.nTC; k++) {
      const ck = this.touchedC[k];
      const c = g.connectors[ck];
      if (c.inLane !== l && c.outLane !== l) continue;
      for (let a = this.connOff[ck]; a < this.connOff[ck] + this.connCnt[ck]; a++) {
        const j = this.corder[a];
        const ue = c.inLane === l ? c.inU + this.w[j] : c.outU - (c.len - this.w[j]);
        if (Math.abs(ue - u) < clear + (sp.length + SPECS[this.type[j]].length) / 2 + 10) return -1;
      }
    }
    // cars in the junction boxes at either end
    const i = this.alloc();
    if (i < 0) return -1;
    const serial = this.serialNext++;
    this.type[i] = t;
    this.lane[i] = l;
    this.u[i] = u;
    this.conn[i] = -1;
    this.w[i] = 0;
    this.serial[i] = serial;
    this.decisions[i] = 0;
    const hd = hash2i(serial, 3, this.seed);
    const [f0, f1] = this.cfg.speedFactor;
    this.desire[i] = f0 + (f1 - f0) * hd;
    let v = Math.min(sp.vmax, this.desire[i] * g.allowedSpeed(l, u) * 0.85);
    if (dLead < 80) v = Math.min(v, vLead);
    this.v[i] = v;
    this.acc[i] = 0;
    this.prev[i] = -1;
    this.plan1[i] = -1;
    this.plan2[i] = -1;
    this.odo[i] = hash2i(serial, 5, this.seed) * 10;
    this.paint[i] = paintFor(t, hash2i(serial, 7, this.seed));
    this.paint2[i] = trailerPaint(hash2i(serial, 11, this.seed));
    this.still[i] = 0;
    this.hint[i] = -1;
    this.cx[i] = pp.x;
    this.cz[i] = pp.z;
    this.enterLane(i);
    this.newL.push(l);
    this.newU.push(u);
    this.spawned++;
    if (t === VT.tractor) this.tractors++;
    return i;
  }

  private alloc(): number {
    if (this.freeTop <= 0) return -1;
    const i = this.freeList[--this.freeTop];
    this.alive[i] = 1;
    this.count++;
    return i;
  }

  private release(i: number): void {
    if (!this.alive[i]) return;
    this.dropAllHolds(i);
    this.alive[i] = 0;
    if (this.type[i] === VT.tractor) this.tractors--;
    this.lane[i] = -1;
    this.conn[i] = -1;
    this.next[i] = -1;
    this.freeList[this.freeTop++] = i;
    this.count--;
    this.released++;
  }

  /** Places a vehicle (tests, tools): returns its index or −1 when the pool is full. */
  place(type: number, lane: number, u: number, v: number): number {
    const i = this.alloc();
    if (i < 0) return -1;
    const serial = this.serialNext++;
    this.type[i] = type;
    this.lane[i] = lane;
    this.u[i] = u;
    this.conn[i] = -1;
    this.w[i] = 0;
    this.v[i] = v;
    this.acc[i] = 0;
    this.serial[i] = serial;
    this.decisions[i] = 0;
    this.desire[i] = 1;
    this.prev[i] = -1;
    this.plan1[i] = -1;
    this.plan2[i] = -1;
    this.odo[i] = 0;
    this.paint[i] = paintFor(type, hash2i(serial, 7, this.seed));
    this.paint2[i] = trailerPaint(hash2i(serial, 11, this.seed));
    this.still[i] = 0;
    this.hint[i] = -1;
    if (type === VT.tractor) this.tractors++;
    this.enterLane(i);
    this.buildLists();
    return i;
  }

  // ─── poses ───────────────────────────────────────────────────────────────

  /** The point `off` metres ahead of (behind, if negative) vehicle i's centre along its path. */
  pathPoint(i: number, off: number, out: PathPoint): void {
    const ci = this.conn[i];
    if (ci >= 0) this.connWalk(ci, this.w[i] + off, out, i);
    else this.laneWalk(i, this.lane[i], this.u[i] + off, out);
  }

  private laneWalk(i: number, l: number, target: number, out: PathPoint): void {
    const g = this.g;
    const k = this.next[i];
    if (k >= 0 && target > g.connectors[k].inU) {
      this.connWalk(k, target - g.connectors[k].inU, out, i);
      return;
    }
    const pv = this.prev[i];
    if (pv >= 0) {
      const c = g.connectors[pv];
      if (c.outLane === l && target < c.outU) {
        this.connWalk(pv, c.len - (c.outU - target), out, i);
        return;
      }
    }
    this.lanePt(l, target, out, i);
  }

  private connWalk(k: number, w: number, out: PathPoint, i: number): void {
    const c = this.g.connectors[k];
    if (w > c.len) {
      this.lanePt(c.outLane, c.outU + (w - c.len), out, -1);
      return;
    }
    if (w < 0) {
      this.lanePt(c.inLane, c.inU + w, out, -1);
      return;
    }
    this.g.connPoint(c, w, out);
    out.piece = -1;
    out.conn = k;
    out.frac = c.len > 0 ? w / c.len : 0;
    out.s = 0;
    out.across = 0;
    void i;
  }

  private lanePt(l: number, u: number, out: PathPoint, i: number): void {
    const g = this.g;
    const h = g.lanePoint(l, u, out, i >= 0 ? this.hint[i] : -1);
    if (i >= 0) this.hint[i] = h;
    out.piece = l >> 1;
    out.s = g.laneS(l, u);
    out.across = g.laneAcross[l];
    out.conn = -1;
    out.frac = 0;
  }

  /** Pose of vehicle i, `ahead` metres further along its path (extrapolation between steps). */
  pose(i: number, ahead: number, out: VehiclePose): void {
    const sp = SPECS[this.type[i]];
    const fa = sp.length / 2 - sp.frontOverhang;
    const ra = fa - sp.wheelbase;
    this.pathPoint(i, ahead + fa, out.front);
    this.pathPoint(i, ahead + ra, out.rear);
    const f = out.front;
    const r = out.rear;
    out.fx = f.x;
    out.fz = f.z;
    out.rx = r.x;
    out.rz = r.z;
    let hx = f.x - r.x;
    let hz = f.z - r.z;
    const l = Math.hypot(hx, hz);
    if (l > 1e-4) {
      hx /= l;
      hz /= l;
    } else {
      hx = f.hx;
      hz = f.hz;
    }
    out.hx = hx;
    out.hz = hz;
    out.x = (f.x + r.x) / 2;
    out.z = (f.z + r.z) / 2;
    const st = Math.atan2(hx * f.hz - hz * f.hx, hx * f.hx + hz * f.hz);
    out.steer = st > 0.6 ? 0.6 : st < -0.6 ? -0.6 : st;
    if (this.type[i] === VT.semi) {
      // kingpin rigidly on the tractor, a little ahead of its rear axle; the trailer axle follows the path
      const kb = sp.frontOverhang + sp.wheelbase - SEMI.kingpin;
      out.kx = r.x + hx * kb;
      out.kz = r.z + hz * kb;
      this.pathPoint(i, ahead + sp.length / 2 - SEMI.trailerAxle, out.axle);
      out.ax = out.axle.x;
      out.az = out.axle.z;
      let tx = out.kx - out.ax;
      let tz = out.kz - out.az;
      const tl = Math.hypot(tx, tz);
      if (tl > 1e-4) {
        tx /= tl;
        tz /= tl;
      } else {
        tx = hx;
        tz = hz;
      }
      out.thx = tx;
      out.thz = tz;
    }
  }

  stats(): Record<string, number> {
    let moving = 0;
    let speed = 0;
    for (let i = 0; i < this.cap; i++) {
      if (!this.alive[i]) continue;
      speed += this.v[i];
      if (this.v[i] > 0.5) moving++;
    }
    return {
      vehicles: this.count,
      moving,
      meanSpeed: this.count ? Math.round((speed / this.count) * 10) / 10 : 0,
      activeLanes: this.activeLanes.length,
      tractors: this.tractors,
      spawned: this.spawned,
      released: this.released,
      stuckReleased: this.stuckReleased,
      junctions: this.junctions,
    };
  }
}
