/**
 * PURE rigid-body debris simulation for the crash break-up (no three.js; no allocation after
 * construction). Every airframe part is an oriented box with a full inertia tensor:
 *
 *   gravity, air drag, spin damping                      free flight: tumbling, cartwheeling
 *   corner contacts vs the terrain height function       impulses with restitution + Coulomb friction
 *     (sequential impulses at the penetrating corners;   applied at the corner, so a wingtip strike
 *      penetration pushed straight up)                   spins the part; bodies slide, roll, rest
 *   compound bodies: parts attached to a parent          the fuselage ploughs along with its wings
 *     (exact merged COM + inertia tensor)                and tail until a strike or a timer shears
 *                                                        them off with the velocity at their point
 *   water: slap, drag, buoyancy that floods away         parts float, then sink out of sight
 *   tree/building canopies: heavy damping                wreckage crashes down through the trees
 *   sleep after a short time at rest                     zero cost once everything has settled
 *
 * State is struct-of-arrays. Angular momentum L (world, about the COM) is the rotational state;
 * the angular velocity w = I⁻¹L is derived. Only-dissipative impulses + symplectic gravity mean
 * the mechanical energy only drains (apart from the push-out of a penetration).
 */
import { CONFIG } from '../config';

export interface DebrisEnv {
  groundHeight(x: number, z: number): number;
  waterLevel?(x: number, z: number): number | null;
  /** Top of the tallest obstacle (tree, building) at x,z, or −Infinity. */
  obstacleTop?(x: number, z: number): number;
}

export interface BodyInit {
  /** Centre of the box (world), orientation (body → world), velocity, angular velocity (world, rad/s). */
  x: number; y: number; z: number;
  qx?: number; qy?: number; qz?: number; qw?: number;
  vx?: number; vy?: number; vz?: number;
  wx?: number; wy?: number; wz?: number;
  /** kg */
  mass: number;
  /** Half extents of the collision box, m (body frame). */
  hx: number; hy: number; hz: number;
  restitution?: number;
  friction?: number;
  /** Buoyancy as a fraction of the weight when submerged (> 1 floats; 0 sinks at once), and the time (s) it takes to flood. */
  float?: number;
  floodTime?: number;
}

export type DebrisConfig = typeof CONFIG.crash.debris;

export const FREE = 0;
export const ASLEEP = 1;
export const ATTACHED = 2;
export const SUNK = 3;

export const EV_GROUND = 1;
export const EV_WATER = 2;
export const EV_DETACH = 3;
export const EV_SINK = 4;

const EVENT_CAP = 64;
const MAX_CONTACTS = 8 * 12;

export class DebrisEvents {
  count = 0;
  readonly type = new Uint8Array(EVENT_CAP);
  readonly body = new Int16Array(EVENT_CAP);
  readonly x = new Float64Array(EVENT_CAP);
  readonly y = new Float64Array(EVENT_CAP);
  readonly z = new Float64Array(EVENT_CAP);
  /** Impact speed, m/s. */
  readonly strength = new Float64Array(EVENT_CAP);
  push(type: number, body: number, x: number, y: number, z: number, strength: number): void {
    if (this.count >= EVENT_CAP) return;
    const k = this.count++;
    this.type[k] = type;
    this.body[k] = body;
    this.x[k] = x;
    this.y[k] = y;
    this.z[k] = z;
    this.strength[k] = strength;
  }
}

const fin = (v: number | undefined, d: number) => (v !== undefined && Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

// ── Scratch (module-level, no allocation) ───────────────────────────────────
const V = new Float64Array(3);
const W = new Float64Array(3);
const M6 = new Float64Array(6);

/** Rotate (x,y,z) by quaternion q into V. */
function qrot(qx: number, qy: number, qz: number, qw: number, x: number, y: number, z: number, out: Float64Array = V): Float64Array {
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
  return out;
}

/** Symmetric 3×3 (xx,yy,zz,xy,xz,yz) × vector. */
function symMul(m: Float64Array, o: number, x: number, y: number, z: number, out: Float64Array) {
  out[0] = m[o] * x + m[o + 3] * y + m[o + 4] * z;
  out[1] = m[o + 3] * x + m[o + 1] * y + m[o + 5] * z;
  out[2] = m[o + 4] * x + m[o + 5] * y + m[o + 2] * z;
}

/** Invert a symmetric 3×3 in place (xx,yy,zz,xy,xz,yz); near-singular → a tiny diagonal fallback. */
function symInvert(m: Float64Array, o: number, out: Float64Array, oo: number) {
  const a = m[o], d = m[o + 1], f = m[o + 2], b = m[o + 3], c = m[o + 4], e = m[o + 5];
  const A = d * f - e * e;
  const B = c * e - b * f;
  const C = b * e - c * d;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-18) || !Number.isFinite(det)) {
    out[oo] = a > 0 ? 1 / a : 1;
    out[oo + 1] = d > 0 ? 1 / d : 1;
    out[oo + 2] = f > 0 ? 1 / f : 1;
    out[oo + 3] = out[oo + 4] = out[oo + 5] = 0;
    return;
  }
  const inv = 1 / det;
  out[oo] = A * inv;
  out[oo + 1] = (a * f - c * c) * inv;
  out[oo + 2] = (a * d - b * b) * inv;
  out[oo + 3] = B * inv;
  out[oo + 4] = C * inv;
  out[oo + 5] = (b * c - a * e) * inv;
}

export class DebrisWorld {
  readonly capacity: number;
  readonly cfg: DebrisConfig;
  count = 0;
  /** Simulated seconds since the last clear(). */
  time = 0;
  /** Work done by pushing bodies out of the ground (J, since clear()) — the only way energy can rise. */
  pushWork = 0;
  readonly events = new DebrisEvents();

  // pose / motion
  readonly px: Float64Array; readonly py: Float64Array; readonly pz: Float64Array;
  readonly qx: Float64Array; readonly qy: Float64Array; readonly qz: Float64Array; readonly qw: Float64Array;
  /** Velocity of the body's centre of mass (for an attached part: of its centre). */
  readonly vx: Float64Array; readonly vy: Float64Array; readonly vz: Float64Array;
  /** Angular velocity, world rad/s (derived from the angular momentum). */
  readonly wx: Float64Array; readonly wy: Float64Array; readonly wz: Float64Array;
  private readonly lx: Float64Array; private readonly ly: Float64Array; private readonly lz: Float64Array;
  // shape / material
  readonly mass: Float64Array;
  readonly hx: Float64Array; readonly hy: Float64Array; readonly hz: Float64Array;
  private readonly rest: Float64Array; private readonly mu: Float64Array;
  private readonly float: Float64Array; private readonly flood: Float64Array;
  // compound (root bodies): total mass, COM offset (body frame), inertia and inverse (body frame, about the COM), bounding radius about the centre
  private readonly mT: Float64Array;
  private readonly cox: Float64Array; private readonly coy: Float64Array; private readonly coz: Float64Array;
  private readonly iB: Float64Array; private readonly iInv: Float64Array;
  private readonly radius: Float64Array;
  // attachment
  readonly parent: Int16Array;
  private readonly lpx: Float64Array; private readonly lpy: Float64Array; private readonly lpz: Float64Array;
  private readonly lqx: Float64Array; private readonly lqy: Float64Array; private readonly lqz: Float64Array; private readonly lqw: Float64Array;
  private readonly detachAt: Float64Array; private readonly breakImpulse: Float64Array; private readonly impulse: Float64Array;
  // status
  readonly state: Uint8Array;
  private readonly sleepT: Float64Array;
  /** Sim time of the last ground contact (a resting body may lose contact for a substep). */
  private readonly touchT: Float64Array;
  /** Low-passed motion (m/s: speed, and spin × half the radius) — what decides sleep, so a rocking body settles. */
  private readonly motion: Float64Array;
  private readonly wetT: Float64Array;
  readonly inWater: Uint8Array;
  /** 1 while touching the ground this step; slideSpeed = tangential speed there; cx/cy/cz = the deepest contact. */
  readonly contact: Uint8Array;
  readonly slideSpeed: Float64Array;
  readonly cx: Float64Array; readonly cy: Float64Array; readonly cz: Float64Array;
  private readonly waterY: Float64Array;
  private readonly canopyY: Float64Array;
  // contact scratch
  private readonly ctx = new Float64Array(MAX_CONTACTS);
  private readonly cty = new Float64Array(MAX_CONTACTS);
  private readonly ctz = new Float64Array(MAX_CONTACTS);
  private readonly ctOwner = new Int16Array(MAX_CONTACTS);
  private readonly ctTarget = new Float64Array(MAX_CONTACTS);
  private readonly ctAcc = new Float64Array(MAX_CONTACTS);
  private readonly ctK = new Float64Array(MAX_CONTACTS);

  constructor(capacity: number = CONFIG.crash.debris.capacity, cfg: DebrisConfig = CONFIG.crash.debris) {
    const n = Math.max(1, Math.min(4096, Math.floor(Number.isFinite(capacity) ? capacity : 1)));
    this.capacity = n;
    this.cfg = cfg;
    const f = () => new Float64Array(n);
    this.px = f(); this.py = f(); this.pz = f();
    this.qx = f(); this.qy = f(); this.qz = f(); this.qw = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.wx = f(); this.wy = f(); this.wz = f();
    this.lx = f(); this.ly = f(); this.lz = f();
    this.mass = f(); this.hx = f(); this.hy = f(); this.hz = f();
    this.rest = f(); this.mu = f(); this.float = f(); this.flood = f();
    this.mT = f(); this.cox = f(); this.coy = f(); this.coz = f();
    this.iB = new Float64Array(n * 6); this.iInv = new Float64Array(n * 6);
    this.radius = f();
    this.parent = new Int16Array(n);
    this.lpx = f(); this.lpy = f(); this.lpz = f();
    this.lqx = f(); this.lqy = f(); this.lqz = f(); this.lqw = f();
    this.detachAt = f(); this.breakImpulse = f(); this.impulse = f();
    this.state = new Uint8Array(n);
    this.sleepT = f(); this.wetT = f(); this.touchT = f(); this.motion = f();
    this.inWater = new Uint8Array(n);
    this.contact = new Uint8Array(n);
    this.slideSpeed = f();
    this.cx = f(); this.cy = f(); this.cz = f();
    this.waterY = f(); this.canopyY = f();
    this.clear();
  }

  clear(): void {
    this.count = 0;
    this.time = 0;
    this.pushWork = 0;
    this.events.count = 0;
    this.parent.fill(-1);
    this.state.fill(FREE);
  }

  /** Add a body; returns its index, or −1 when the pool is full. Inputs are sanitised. */
  add(b: BodyInit): number {
    if (this.count >= this.capacity) return -1;
    const i = this.count++;
    this.px[i] = clamp(fin(b.x, 0), -1e7, 1e7);
    this.py[i] = clamp(fin(b.y, 0), -1e5, 1e5);
    this.pz[i] = clamp(fin(b.z, 0), -1e7, 1e7);
    let qx = fin(b.qx, 0), qy = fin(b.qy, 0), qz = fin(b.qz, 0), qw = fin(b.qw, 1);
    const ql = Math.hypot(qx, qy, qz, qw);
    if (!(ql > 1e-9)) { qx = qy = qz = 0; qw = 1; } else { qx /= ql; qy /= ql; qz /= ql; qw /= ql; }
    this.qx[i] = qx; this.qy[i] = qy; this.qz[i] = qz; this.qw[i] = qw;
    const vmax = this.cfg.maxSpeed, wmax = this.cfg.maxSpin;
    this.vx[i] = clamp(fin(b.vx, 0), -vmax, vmax);
    this.vy[i] = clamp(fin(b.vy, 0), -vmax, vmax);
    this.vz[i] = clamp(fin(b.vz, 0), -vmax, vmax);
    this.mass[i] = clamp(fin(b.mass, 1), 0.1, 1e6);
    this.hx[i] = clamp(Math.abs(fin(b.hx, 0.1)), 0.02, 50);
    this.hy[i] = clamp(Math.abs(fin(b.hy, 0.1)), 0.02, 50);
    this.hz[i] = clamp(Math.abs(fin(b.hz, 0.1)), 0.02, 50);
    this.rest[i] = clamp(fin(b.restitution, 0.25), 0, 0.95);
    this.mu[i] = clamp(fin(b.friction, 0.6), 0, 2);
    this.float[i] = clamp(fin(b.float, 0.5), 0, 5);
    this.flood[i] = clamp(fin(b.floodTime, 10), 0.1, 1e4);
    this.parent[i] = -1;
    this.state[i] = FREE;
    this.sleepT[i] = 0; this.wetT[i] = 0; this.inWater[i] = 0; this.contact[i] = 0; this.slideSpeed[i] = 0; this.touchT[i] = -1e9; this.motion[i] = 10;
    this.detachAt[i] = Infinity; this.breakImpulse[i] = Infinity; this.impulse[i] = 0;
    this.cx[i] = this.px[i]; this.cy[i] = this.py[i]; this.cz[i] = this.pz[i];
    this.recompute(i);
    // L = I_world · w
    const wx = clamp(fin(b.wx, 0), -wmax, wmax), wy = clamp(fin(b.wy, 0), -wmax, wmax), wz = clamp(fin(b.wz, 0), -wmax, wmax);
    this.setSpin(i, wx, wy, wz);
    return i;
  }

  /** Rigidly attach `child` to `parent` where they are now (momentum is conserved: an inelastic merge). */
  attach(child: number, parent: number): void {
    if (!(child >= 0 && child < this.count && parent >= 0 && parent < this.count) || child === parent) return;
    if (this.parent[parent] >= 0 || this.state[child] === ATTACHED) return;
    for (let j = 0; j < this.count; j++) if (this.parent[j] === child) return; // one level only
    const p = parent, c = child;
    const pqx = this.qx[p], pqy = this.qy[p], pqz = this.qz[p], pqw = this.qw[p];
    // relative pose in the parent's frame
    qrot(-pqx, -pqy, -pqz, pqw, this.px[c] - this.px[p], this.py[c] - this.py[p], this.pz[c] - this.pz[p]);
    this.lpx[c] = V[0]; this.lpy[c] = V[1]; this.lpz[c] = V[2];
    // lq = conj(qp) ⊗ qc
    const ax = -pqx, ay = -pqy, az = -pqz, aw = pqw;
    const bx = this.qx[c], by = this.qy[c], bz = this.qz[c], bw = this.qw[c];
    this.lqw[c] = aw * bw - ax * bx - ay * by - az * bz;
    this.lqx[c] = aw * bx + ax * bw + ay * bz - az * by;
    this.lqy[c] = aw * by - ax * bz + ay * bw + az * bx;
    this.lqz[c] = aw * bz + ax * by - ay * bx + az * bw;
    // momenta before the merge
    const comOld = this.com(p);
    const cox0 = comOld[0], coy0 = comOld[1], coz0 = comOld[2];
    const mp = this.mT[p], mc = this.mT[c];
    const Px = mp * this.vx[p] + mc * this.vx[c];
    const Py = mp * this.vy[p] + mc * this.vy[c];
    const Pz = mp * this.vz[p] + mc * this.vz[c];
    let Lx = this.lx[p] + this.lx[c], Ly = this.ly[p] + this.ly[c], Lz = this.lz[p] + this.lz[c];
    this.parent[c] = p;
    this.state[c] = ATTACHED;
    this.recompute(p);
    const comN = this.com(p);
    const nx = comN[0], ny = comN[1], nz = comN[2];
    // orbital angular momentum of both about the new COM
    let rx = cox0 - nx, ry = coy0 - ny, rz = coz0 - nz;
    Lx += mp * (ry * this.vz[p] - rz * this.vy[p]); Ly += mp * (rz * this.vx[p] - rx * this.vz[p]); Lz += mp * (rx * this.vy[p] - ry * this.vx[p]);
    rx = this.px[c] - nx; ry = this.py[c] - ny; rz = this.pz[c] - nz;
    Lx += mc * (ry * this.vz[c] - rz * this.vy[c]); Ly += mc * (rz * this.vx[c] - rx * this.vz[c]); Lz += mc * (rx * this.vy[c] - ry * this.vx[c]);
    const M = this.mT[p];
    this.vx[p] = Px / M; this.vy[p] = Py / M; this.vz[p] = Pz / M;
    this.lx[p] = Lx; this.ly[p] = Ly; this.lz[p] = Lz;
    this.state[p] = FREE;
    this.sleepT[p] = 0;
    this.updateSpin(p);
    this.placeChildren(p);
  }

  /** An attached part breaks off at sim time `at` (s), or earlier when a ground strike on it exceeds `breakImpulse` (N·s). */
  scheduleDetach(child: number, at: number, breakImpulse: number): void {
    if (!(child >= 0 && child < this.count)) return;
    this.detachAt[child] = Number.isNaN(at) ? Infinity : at;
    this.breakImpulse[child] = Number.isNaN(breakImpulse) ? Infinity : Math.max(0, breakImpulse);
  }

  /** Break an attached part off: it keeps the velocity of its point on the parent and the parent's spin. */
  detach(child: number): void {
    if (!(child >= 0 && child < this.count) || this.state[child] !== ATTACHED) return;
    const p = this.parent[child];
    const c = child;
    const wx = this.wx[p], wy = this.wy[p], wz = this.wz[p];
    const com0 = this.com(p);
    const c0x = com0[0], c0y = com0[1], c0z = com0[2];
    let rx = this.px[c] - c0x, ry = this.py[c] - c0y, rz = this.pz[c] - c0z;
    this.vx[c] = this.vx[p] + (wy * rz - wz * ry);
    this.vy[c] = this.vy[p] + (wz * rx - wx * rz);
    this.vz[c] = this.vz[p] + (wx * ry - wy * rx);
    this.parent[c] = -1;
    this.state[c] = FREE;
    this.sleepT[c] = 0;
    this.impulse[c] = 0;
    this.contact[c] = 0;
    this.inWater[c] = this.inWater[p];
    this.wetT[c] = this.wetT[p];
    this.setSpin(c, wx, wy, wz);
    this.recompute(p);
    const com1 = this.com(p);
    rx = com1[0] - c0x; ry = com1[1] - c0y; rz = com1[2] - c0z;
    this.vx[p] += wy * rz - wz * ry;
    this.vy[p] += wz * rx - wx * rz;
    this.vz[p] += wx * ry - wy * rx;
    this.setSpin(p, wx, wy, wz);
    if (this.state[p] === ASLEEP) this.state[p] = FREE;
    this.events.push(EV_DETACH, c, this.px[c], this.py[c], this.pz[c], Math.hypot(this.vx[c], this.vy[c], this.vz[c]));
  }

  /** Advance by dt (s). Long frames are sub-stepped (≤ cfg.subStep); dt ≤ 0 or non-finite: no-op. Events are this step's only. */
  step(dtIn: number, env: DebrisEnv): void {
    this.events.count = 0;
    if (!(dtIn > 0) || !Number.isFinite(dtIn)) return;
    const dt = Math.min(dtIn, 0.25);
    // per-step environment lookups (water surface, canopy) at each moving body
    for (let i = 0; i < this.count; i++) {
      if (this.state[i] !== FREE) continue;
      const w = env.waterLevel ? env.waterLevel(this.px[i], this.pz[i]) : null;
      this.waterY[i] = w === null || w === undefined || !Number.isFinite(w) ? Number.NaN : w;
      const o = env.obstacleTop ? env.obstacleTop(this.px[i], this.pz[i]) : -Infinity;
      this.canopyY[i] = Number.isFinite(o) ? o : -Infinity;
    }
    const n = Math.max(1, Math.ceil(dt / Math.max(1e-4, this.cfg.subStep)));
    const h = dt / n;
    for (let k = 0; k < n; k++) this.subStep(h, env);
  }

  private subStep(h: number, env: DebrisEnv): void {
    const C = this.cfg;
    this.time += h;
    for (let j = 0; j < this.count; j++) {
      if (this.state[j] === ATTACHED && this.time >= this.detachAt[j]) this.detach(j);
    }
    const g = C.gravity;
    const air = Math.exp(-C.airDrag * h);
    const spinK = Math.exp(-C.spinDrag * h);
    for (let i = 0; i < this.count; i++) {
      if (this.state[i] !== FREE) continue;
      // ── forces ──
      this.vy[i] -= g * h;
      this.vx[i] *= air; this.vy[i] *= air; this.vz[i] *= air;
      this.lx[i] *= spinK; this.ly[i] *= spinK; this.lz[i] *= spinK;
      const wy0 = this.waterY[i];
      if (wy0 === wy0) {
        // vertical half-extent of the rotated box
        const ext = this.verticalExtent(i);
        const sub = clamp((wy0 - (this.py[i] - ext)) / (2 * ext), 0, 1);
        if (sub > 0) {
          if (!this.inWater[i]) {
            this.inWater[i] = 1;
            const sp = Math.hypot(this.vx[i], this.vy[i], this.vz[i]);
            if (sp > 6 || this.vy[i] < -3) {
              this.events.push(EV_WATER, i, this.px[i], wy0, this.pz[i], sp);
              const k = C.waterImpactKeep;
              this.vx[i] *= k; this.vy[i] *= k; this.vz[i] *= k;
              this.lx[i] *= k; this.ly[i] *= k; this.lz[i] *= k;
            }
          }
          this.wetT[i] += h;
          const f0 = this.float[i];
          const fl = f0 <= 0 ? 0 : f0 - (f0 - Math.min(f0, 0.4)) * Math.min(1, this.wetT[i] / this.flood[i]);
          this.vy[i] += g * fl * sub * h;
          const dk = Math.exp(-C.waterDrag * sub * h);
          this.vx[i] *= dk; this.vy[i] *= dk; this.vz[i] *= dk;
          const dl = Math.exp(-0.7 * C.waterDrag * sub * h);
          this.lx[i] *= dl; this.ly[i] *= dl; this.lz[i] *= dl;
          if (this.py[i] + ext < wy0 - C.sinkDepth && fl < 1) {
            this.sink(i);
            continue;
          }
        } else if (this.py[i] - ext > wy0 + 0.2) this.inWater[i] = 0;
      }
      if (this.py[i] < this.canopyY[i]) {
        const k = Math.exp(-C.canopyDrag * h);
        this.vx[i] *= k; this.vy[i] *= k; this.vz[i] *= k;
        const kl = Math.exp(-0.6 * C.canopyDrag * h);
        this.lx[i] *= kl; this.ly[i] *= kl; this.lz[i] *= kl;
      }
      this.clampMotion(i);
      this.updateSpin(i);
      // ── integrate: the COM moves with v, the body turns about the COM ──
      const com = this.com(i);
      const comX = com[0] + this.vx[i] * h, comY = com[1] + this.vy[i] * h, comZ = com[2] + this.vz[i] * h;
      // midpoint rule: turn half a step, take the spin there, then turn the full step from the start
      const q0x = this.qx[i], q0y = this.qy[i], q0z = this.qz[i], q0w = this.qw[i];
      this.turn(i, this.wx[i], this.wy[i], this.wz[i], h / 2);
      this.updateSpin(i);
      const wmx = this.wx[i], wmy = this.wy[i], wmz = this.wz[i];
      this.qx[i] = q0x; this.qy[i] = q0y; this.qz[i] = q0z; this.qw[i] = q0w;
      this.turn(i, wmx, wmy, wmz, h);
      qrot(this.qx[i], this.qy[i], this.qz[i], this.qw[i], this.cox[i], this.coy[i], this.coz[i]);
      this.px[i] = comX - V[0];
      this.py[i] = comY - V[1];
      this.pz[i] = comZ - V[2];
      this.updateSpin(i);
      this.placeChildren(i);
      // ── ground ──
      this.collide(i, h, env);
      // ── sleep ──
      if (this.contact[i]) this.touchT[i] = this.time;
      const touching = this.time - this.touchT[i] < 0.1;
      let sp = Math.hypot(this.vx[i], this.vy[i], this.vz[i]);
      let sw = Math.hypot(this.wx[i], this.wy[i], this.wz[i]);
      if (touching && sp < 1 && sw < 1.5) {
        // resting contact: bleed off the last jitter
        const k = Math.exp(-4 * h);
        this.vx[i] *= k; this.vy[i] *= k; this.vz[i] *= k;
        this.lx[i] *= k; this.ly[i] *= k; this.lz[i] *= k;
        this.updateSpin(i);
        sp *= k;
        sw *= k;
      }
      const m = Math.max(sp, sw * 0.5 * this.radius[i]);
      this.motion[i] += (m - this.motion[i]) * (1 - Math.exp(-h / 0.25));
      if (touching && this.motion[i] < C.sleepSpeed && sw < 4 * C.sleepSpin) {
        this.sleepT[i] += h;
        if (this.sleepT[i] >= C.sleepTime) this.sleep(i);
      } else this.sleepT[i] = 0;
      if (this.time > C.maxAge && this.state[i] === FREE && this.time - this.touchT[i] < 0.1) this.sleep(i);
      if (!this.finite(i)) this.sleep(i);
    }
    if (this.time > C.maxAge + 10) {
      for (let i = 0; i < this.count; i++) if (this.state[i] === FREE) this.sleep(i);
    }
  }

  /** Corner contacts of body i (and its attached parts) against the terrain; impulses, push-out, strikes. */
  private collide(i: number, h: number, env: DebrisEnv): void {
    const C = this.cfg;
    this.contact[i] = 0;
    const R = this.radius[i];
    const g0 = env.groundHeight(this.px[i], this.pz[i]);
    if (!Number.isFinite(g0) || this.py[i] - R > g0 + 1.5 * R) return;
    // gather penetrating corners
    let n = 0;
    let maxPen = 0;
    let deep = -1;
    for (let o = -1; o < this.count; o++) {
      const b = o < 0 ? i : o;
      if (o >= 0 && this.parent[o] !== i) continue;
      const qx = this.qx[b], qy = this.qy[b], qz = this.qz[b], qw = this.qw[b];
      const hx = this.hx[b], hy = this.hy[b], hz = this.hz[b];
      for (let k = 0; k < 8; k++) {
        qrot(qx, qy, qz, qw, k & 1 ? hx : -hx, k & 2 ? hy : -hy, k & 4 ? hz : -hz);
        const x = this.px[b] + V[0], y = this.py[b] + V[1], z = this.pz[b] + V[2];
        const gy = env.groundHeight(x, z);
        const pen = gy - y;
        if (pen > 0 && Number.isFinite(pen) && n < MAX_CONTACTS) {
          this.ctx[n] = x; this.cty[n] = y; this.ctz[n] = z; this.ctOwner[n] = b;
          if (pen > maxPen) { maxPen = pen; deep = n; }
          n++;
        }
      }
    }
    if (n === 0) return;
    // terrain normal at the body (finite differences)
    const x0 = this.px[i], z0 = this.pz[i];
    let nx = -(env.groundHeight(x0 + 1, z0) - env.groundHeight(x0 - 1, z0)) / 2;
    let nz = -(env.groundHeight(x0, z0 + 1) - env.groundHeight(x0, z0 - 1)) / 2;
    let ny = 1;
    const nl = Math.hypot(nx, ny, nz);
    if (!(nl > 0) || !Number.isFinite(nl)) { nx = 0; ny = 1; nz = 0; } else { nx /= nl; ny /= nl; nz /= nl; }
    const com = this.com(i);
    const comX = com[0], comY = com[1], comZ = com[2];
    const M = this.mT[i];
    const e0 = this.rest[i];
    const mu = this.mu[i];
    let maxVn = 0;
    // Normal impulses: projected Gauss-Seidel with accumulated (≥ 0) impulses toward each contact's
    // restitution target, so several corners landing together share the load (a flat box bounces flat).
    const target = this.ctTarget, acc = this.ctAcc, kn = this.ctK;
    for (let c = 0; c < n; c++) {
      const rx = this.ctx[c] - comX, ry = this.cty[c] - comY, rz = this.ctz[c] - comZ;
      const vn = this.normalVel(i, rx, ry, rz, nx, ny, nz);
      if (-vn > maxVn) maxVn = -vn;
      target[c] = vn < -C.bounceMinSpeed ? -e0 * vn : 0;
      acc[c] = 0;
      kn[c] = this.effMass(i, rx, ry, rz, nx, ny, nz, M);
    }
    for (let it = 0; it < 6; it++) {
      for (let c = 0; c < n; c++) {
        const rx = this.ctx[c] - comX, ry = this.cty[c] - comY, rz = this.ctz[c] - comZ;
        const vn = this.normalVel(i, rx, ry, rz, nx, ny, nz);
        let dj = (target[c] - vn) / kn[c];
        const next = Math.max(0, acc[c] + dj);
        dj = next - acc[c];
        acc[c] = next;
        if (dj !== 0) this.applyImpulse(i, rx, ry, rz, dj * nx, dj * ny, dj * nz, M);
      }
    }
    // Coulomb friction at each contact, limited by its normal impulse.
    for (let c = 0; c < n; c++) {
      const j = acc[c];
      const ow = this.ctOwner[c];
      if (ow !== i) this.impulse[ow] += j;
      if (!(j > 0)) continue;
      const rx = this.ctx[c] - comX, ry = this.cty[c] - comY, rz = this.ctz[c] - comZ;
      const wx = this.wx[i], wy = this.wy[i], wz = this.wz[i];
      const vcx = this.vx[i] + wy * rz - wz * ry;
      const vcy = this.vy[i] + wz * rx - wx * rz;
      const vcz = this.vz[i] + wx * ry - wy * rx;
      const vn2 = vcx * nx + vcy * ny + vcz * nz;
      const tx = vcx - vn2 * nx, ty = vcy - vn2 * ny, tz = vcz - vn2 * nz;
      const st = Math.hypot(tx, ty, tz);
      if (st > 1e-9) {
        const ux = tx / st, uy = ty / st, uz = tz / st;
        const kt = this.effMass(i, rx, ry, rz, ux, uy, uz, M);
        const jt = Math.min(st / kt, mu * j);
        this.applyImpulse(i, rx, ry, rz, -jt * ux, -jt * uy, -jt * uz, M);
      }
    }
    // push out of the ground (straight up: every corner ends at or above the ground at its own x,z)
    this.py[i] += maxPen;
    this.pushWork += M * C.gravity * maxPen;
    this.placeChildren(i);
    // sliding / rolling resistance while in contact
    const vn = this.vx[i] * nx + this.vy[i] * ny + this.vz[i] * nz;
    const tx = this.vx[i] - vn * nx, ty = this.vy[i] - vn * ny, tz = this.vz[i] - vn * nz;
    const kp = 1 - Math.exp(-C.ploughDrag * h);
    this.vx[i] -= tx * kp; this.vy[i] -= ty * kp; this.vz[i] -= tz * kp;
    const kr = Math.exp(-C.groundSpinDrag * h);
    this.lx[i] *= kr; this.ly[i] *= kr; this.lz[i] *= kr;
    this.updateSpin(i);
    this.contact[i] = 1;
    this.slideSpeed[i] = Math.hypot(tx, ty, tz);
    this.cx[i] = this.ctx[deep]; this.cy[i] = this.cty[deep] + maxPen; this.cz[i] = this.ctz[deep];
    if (maxVn > 4) this.events.push(EV_GROUND, i, this.cx[i], this.cy[i], this.cz[i], maxVn);
    // strikes shear attached parts off
    for (let o = 0; o < this.count; o++) {
      if (this.parent[o] !== i) continue;
      if (this.impulse[o] > this.breakImpulse[o]) this.detach(o);
      this.impulse[o] = 0;
    }
  }

  /** Rotate body i by angular velocity (wx,wy,wz) (world) for h seconds (exact axis-angle increment). */
  private turn(i: number, wx: number, wy: number, wz: number, h: number): void {
    const wl = Math.hypot(wx, wy, wz);
    if (!(wl > 1e-12)) return;
    const ang = wl * h;
    const s = Math.sin(ang / 2) / wl;
    const dx = wx * s, dy = wy * s, dz = wz * s, dw = Math.cos(ang / 2);
    const ax = this.qx[i], ay = this.qy[i], az = this.qz[i], aw = this.qw[i];
    let nx = dw * ax + dx * aw + dy * az - dz * ay;
    let ny = dw * ay - dx * az + dy * aw + dz * ax;
    let nz = dw * az + dx * ay - dy * ax + dz * aw;
    let nw = dw * aw - dx * ax - dy * ay - dz * az;
    const nl = Math.hypot(nx, ny, nz, nw) || 1;
    nx /= nl; ny /= nl; nz /= nl; nw /= nl;
    this.qx[i] = nx; this.qy[i] = ny; this.qz[i] = nz; this.qw[i] = nw;
  }

  private normalVel(i: number, rx: number, ry: number, rz: number, nx: number, ny: number, nz: number): number {
    const wx = this.wx[i], wy = this.wy[i], wz = this.wz[i];
    return (this.vx[i] + wy * rz - wz * ry) * nx + (this.vy[i] + wz * rx - wx * rz) * ny + (this.vz[i] + wx * ry - wy * rx) * nz;
  }

  /** 1/m + n·((I⁻¹(r×n))×r) — the inverse effective mass along unit n at lever arm r. */
  private effMass(i: number, rx: number, ry: number, rz: number, nx: number, ny: number, nz: number, M: number): number {
    const cx = ry * nz - rz * ny, cy = rz * nx - rx * nz, cz = rx * ny - ry * nx;
    this.invInertiaWorld(i, cx, cy, cz, W);
    const ax = W[1] * rz - W[2] * ry, ay = W[2] * rx - W[0] * rz, az = W[0] * ry - W[1] * rx;
    return 1 / M + nx * ax + ny * ay + nz * az;
  }

  private applyImpulse(i: number, rx: number, ry: number, rz: number, jx: number, jy: number, jz: number, M: number): void {
    this.vx[i] += jx / M; this.vy[i] += jy / M; this.vz[i] += jz / M;
    this.lx[i] += ry * jz - rz * jy;
    this.ly[i] += rz * jx - rx * jz;
    this.lz[i] += rx * jy - ry * jx;
    this.updateSpin(i);
  }

  /** out = I_world⁻¹ · (x,y,z) for body i's compound. */
  private invInertiaWorld(i: number, x: number, y: number, z: number, out: Float64Array): void {
    const qx = this.qx[i], qy = this.qy[i], qz = this.qz[i], qw = this.qw[i];
    qrot(-qx, -qy, -qz, qw, x, y, z, out);
    symMul(this.iInv, i * 6, out[0], out[1], out[2], M6);
    qrot(qx, qy, qz, qw, M6[0], M6[1], M6[2], out);
  }

  /** L = I_world · w for body i. */
  private setSpin(i: number, wx: number, wy: number, wz: number): void {
    const qx = this.qx[i], qy = this.qy[i], qz = this.qz[i], qw = this.qw[i];
    qrot(-qx, -qy, -qz, qw, wx, wy, wz, W);
    symMul(this.iB, i * 6, W[0], W[1], W[2], M6);
    qrot(qx, qy, qz, qw, M6[0], M6[1], M6[2], W);
    this.lx[i] = W[0]; this.ly[i] = W[1]; this.lz[i] = W[2];
    this.updateSpin(i);
  }

  private updateSpin(i: number): void {
    this.invInertiaWorld(i, this.lx[i], this.ly[i], this.lz[i], W);
    this.wx[i] = W[0]; this.wy[i] = W[1]; this.wz[i] = W[2];
  }

  private clampMotion(i: number): void {
    const C = this.cfg;
    const sp = Math.hypot(this.vx[i], this.vy[i], this.vz[i]);
    if (sp > C.maxSpeed) {
      const k = C.maxSpeed / sp;
      this.vx[i] *= k; this.vy[i] *= k; this.vz[i] *= k;
    }
    this.updateSpin(i);
    const sw = Math.hypot(this.wx[i], this.wy[i], this.wz[i]);
    if (sw > C.maxSpin) {
      const k = C.maxSpin / sw;
      this.lx[i] *= k; this.ly[i] *= k; this.lz[i] *= k;
    }
  }

  /** World position of body i's centre of mass (in V). */
  private com(i: number): Float64Array {
    qrot(this.qx[i], this.qy[i], this.qz[i], this.qw[i], this.cox[i], this.coy[i], this.coz[i]);
    V[0] += this.px[i]; V[1] += this.py[i]; V[2] += this.pz[i];
    return V;
  }

  private verticalExtent(i: number): number {
    // |R row y| · h : the half height of the rotated box
    const qx = this.qx[i], qy = this.qy[i], qz = this.qz[i], qw = this.qw[i];
    const r10 = 2 * (qx * qy + qz * qw);
    const r11 = 1 - 2 * (qx * qx + qz * qz);
    const r12 = 2 * (qy * qz - qx * qw);
    return Math.max(0.05, Math.abs(r10) * this.hx[i] + Math.abs(r11) * this.hy[i] + Math.abs(r12) * this.hz[i]);
  }

  /** Recompute the compound mass, COM, inertia (and its inverse) and bounding radius of root body i. */
  private recompute(i: number): void {
    let M = this.mass[i];
    let sx = 0, sy = 0, sz = 0;
    let rad = Math.hypot(this.hx[i], this.hy[i], this.hz[i]);
    for (let j = 0; j < this.count; j++) {
      if (this.parent[j] !== i) continue;
      const m = this.mass[j];
      M += m;
      sx += m * this.lpx[j]; sy += m * this.lpy[j]; sz += m * this.lpz[j];
      rad = Math.max(rad, Math.hypot(this.lpx[j], this.lpy[j], this.lpz[j]) + Math.hypot(this.hx[j], this.hy[j], this.hz[j]));
    }
    const cx = sx / M, cy = sy / M, cz = sz / M;
    this.mT[i] = M;
    this.cox[i] = cx; this.coy[i] = cy; this.coz[i] = cz;
    this.radius[i] = rad;
    const o = i * 6;
    const I = this.iB;
    I.fill(0, o, o + 6);
    const addBox = (m: number, bx: number, by: number, bz: number, qx: number, qy: number, qz: number, qw: number, dx: number, dy: number, dz: number) => {
      // own box inertia, rotated into the parent frame: R diag Rᵀ. Thickness is floored at 20 % of the
      // longest half extent for the inertia only (a needle's 1000:1 inertia ratio makes free tumbling stiff).
      const tmin = 0.2 * Math.max(bx, by, bz);
      const hx = Math.max(bx, tmin), hy = Math.max(by, tmin), hz = Math.max(bz, tmin);
      const ix = (m / 3) * (hy * hy + hz * hz), iy = (m / 3) * (hx * hx + hz * hz), iz = (m / 3) * (hx * hx + hy * hy);
      const xx = 1 - 2 * (qy * qy + qz * qz), xy = 2 * (qx * qy - qz * qw), xz = 2 * (qx * qz + qy * qw);
      const yx = 2 * (qx * qy + qz * qw), yy = 1 - 2 * (qx * qx + qz * qz), yz = 2 * (qy * qz - qx * qw);
      const zx = 2 * (qx * qz - qy * qw), zy = 2 * (qy * qz + qx * qw), zz = 1 - 2 * (qx * qx + qy * qy);
      I[o] += xx * xx * ix + xy * xy * iy + xz * xz * iz;
      I[o + 1] += yx * yx * ix + yy * yy * iy + yz * yz * iz;
      I[o + 2] += zx * zx * ix + zy * zy * iy + zz * zz * iz;
      I[o + 3] += xx * yx * ix + xy * yy * iy + xz * yz * iz;
      I[o + 4] += xx * zx * ix + xy * zy * iy + xz * zz * iz;
      I[o + 5] += yx * zx * ix + yy * zy * iy + yz * zz * iz;
      // parallel axis
      const d2 = dx * dx + dy * dy + dz * dz;
      I[o] += m * (d2 - dx * dx);
      I[o + 1] += m * (d2 - dy * dy);
      I[o + 2] += m * (d2 - dz * dz);
      I[o + 3] -= m * dx * dy;
      I[o + 4] -= m * dx * dz;
      I[o + 5] -= m * dy * dz;
    };
    addBox(this.mass[i], this.hx[i], this.hy[i], this.hz[i], 0, 0, 0, 1, -cx, -cy, -cz);
    for (let j = 0; j < this.count; j++) {
      if (this.parent[j] !== i) continue;
      addBox(this.mass[j], this.hx[j], this.hy[j], this.hz[j], this.lqx[j], this.lqy[j], this.lqz[j], this.lqw[j], this.lpx[j] - cx, this.lpy[j] - cy, this.lpz[j] - cz);
    }
    symInvert(I, o, this.iInv, o);
  }

  /** Update the world pose of the parts attached to root i. */
  private placeChildren(i: number): void {
    const qx = this.qx[i], qy = this.qy[i], qz = this.qz[i], qw = this.qw[i];
    for (let j = 0; j < this.count; j++) {
      if (this.parent[j] !== i) continue;
      qrot(qx, qy, qz, qw, this.lpx[j], this.lpy[j], this.lpz[j]);
      this.px[j] = this.px[i] + V[0]; this.py[j] = this.py[i] + V[1]; this.pz[j] = this.pz[i] + V[2];
      const bx = this.lqx[j], by = this.lqy[j], bz = this.lqz[j], bw = this.lqw[j];
      this.qw[j] = qw * bw - qx * bx - qy * by - qz * bz;
      this.qx[j] = qw * bx + qx * bw + qy * bz - qz * by;
      this.qy[j] = qw * by - qx * bz + qy * bw + qz * bx;
      this.qz[j] = qw * bz + qx * by - qy * bx + qz * bw;
      // an attached part moves with its point on the parent
      const wx = this.wx[i], wy = this.wy[i], wz = this.wz[i];
      const com = this.com(i);
      const rx = this.px[j] - com[0], ry = this.py[j] - com[1], rz = this.pz[j] - com[2];
      this.vx[j] = this.vx[i] + wy * rz - wz * ry;
      this.vy[j] = this.vy[i] + wz * rx - wx * rz;
      this.vz[j] = this.vz[i] + wx * ry - wy * rx;
      this.wx[j] = wx; this.wy[j] = wy; this.wz[j] = wz;
    }
  }

  private sleep(i: number): void {
    this.state[i] = ASLEEP;
    this.vx[i] = this.vy[i] = this.vz[i] = 0;
    this.lx[i] = this.ly[i] = this.lz[i] = 0;
    this.wx[i] = this.wy[i] = this.wz[i] = 0;
    this.slideSpeed[i] = 0;
    for (let j = 0; j < this.count; j++) {
      if (this.parent[j] !== i) continue;
      this.vx[j] = this.vy[j] = this.vz[j] = 0;
      this.wx[j] = this.wy[j] = this.wz[j] = 0;
    }
  }

  private sink(i: number): void {
    this.sleep(i);
    this.state[i] = SUNK;
    this.events.push(EV_SINK, i, this.px[i], this.py[i], this.pz[i], 0);
  }

  private finite(i: number): boolean {
    return Number.isFinite(this.px[i] + this.py[i] + this.pz[i] + this.vx[i] + this.vy[i] + this.vz[i] + this.qx[i] + this.qy[i] + this.qz[i] + this.qw[i] + this.lx[i] + this.ly[i] + this.lz[i]);
  }

  // ── Queries ──────────────────────────────────────────────────────────────

  /** Every body has settled (asleep, sunk, or attached to a settled body). */
  allAtRest(): boolean {
    for (let i = 0; i < this.count; i++) {
      const s = this.state[i];
      if (s === FREE) return false;
      if (s === ATTACHED && this.state[this.parent[i]] === FREE) return false;
    }
    return true;
  }

  /** Kinetic energy (translation + rotation) of every free/settled body, J. */
  kinetic(): number {
    let e = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.state[i] === ATTACHED) continue;
      e += 0.5 * this.mT[i] * (this.vx[i] ** 2 + this.vy[i] ** 2 + this.vz[i] ** 2);
      e += 0.5 * (this.lx[i] * this.wx[i] + this.ly[i] * this.wy[i] + this.lz[i] * this.wz[i]);
    }
    return e;
  }

  /** Mechanical energy (kinetic + rotational + potential) of every free/settled body, J. */
  energy(): number {
    const g = this.cfg.gravity;
    let e = 0;
    for (let i = 0; i < this.count; i++) {
      if (this.state[i] === ATTACHED) continue;
      const M = this.mT[i];
      const com = this.com(i);
      e += 0.5 * M * (this.vx[i] ** 2 + this.vy[i] ** 2 + this.vz[i] ** 2);
      e += 0.5 * (this.lx[i] * this.wx[i] + this.ly[i] * this.wy[i] + this.lz[i] * this.wz[i]);
      e += M * g * com[1];
    }
    return e;
  }

  /** World position of corner k (0..7) of body i. */
  corner(i: number, k: number, out: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
    qrot(this.qx[i], this.qy[i], this.qz[i], this.qw[i], k & 1 ? this.hx[i] : -this.hx[i], k & 2 ? this.hy[i] : -this.hy[i], k & 4 ? this.hz[i] : -this.hz[i]);
    out.x = this.px[i] + V[0];
    out.y = this.py[i] + V[1];
    out.z = this.pz[i] + V[2];
    return out;
  }

  /** Lowest clearance of body i's corners above the ground, m (negative = below). */
  minClearance(i: number, env: DebrisEnv): number {
    let m = Infinity;
    const p = { x: 0, y: 0, z: 0 };
    for (let k = 0; k < 8; k++) {
      this.corner(i, k, p);
      m = Math.min(m, p.y - env.groundHeight(p.x, p.z));
    }
    return m;
  }
}
