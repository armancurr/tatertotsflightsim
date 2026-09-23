/**
 * The crash director: the moment the physics reports a crash it takes the airframe apart and runs
 * the whole sequence —
 *
 *   parts      getBreakupParts() (or a fallback split of the model) are detached into the scene with
 *              their world transforms and simulated as rigid bodies (src/crash/rigid.ts) launched by
 *              the plan (src/crash/plan.ts): the aircraft's momentum, an explosion push, tumbling;
 *              on a skid the wings and tail ride the ploughing fuselage and shear off later.
 *   effects    on the scene's FxSim: white-hot flash, fireball → black mushroom, shockwave dust ring,
 *              sparks, burning fragments, secondary fuel explosions along the debris, fires that
 *              follow every burning part for 20–30 s (quenched to steam in water), ploughing dust,
 *              splashes, the lingering smoke column over the fuselage; scorch/furrow decals.
 *   time       slow motion (×0.3) for the first second, then real time (timeScale()).
 *   camera     a heavy shake, then the view drifts to frame the wreckage (a slow orbit around the
 *              debris; in orbit mode the player's own orbit, re-centred and pulled back).
 *   reset      every part goes back exactly where it was; nothing is left in the scene.
 *
 * Everything is preallocated; update() and applyCamera() allocate nothing.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import type { CameraMode, Vec3 } from '../types';
import type { AircraftModelHandle, BreakupPart } from '../fleet/types';
import type { FxSim } from '../fx/sim';
import { ASLEEP, ATTACHED, DebrisWorld, EV_DETACH, EV_GROUND, EV_SINK, EV_WATER, SUNK, type DebrisEnv } from './rigid';
import {
  classifyImpact, crashCameraBlend, crashShake, crashTimeScale, frameDistance, impactSeverity, partRole, planBreakup,
  type ImpactKind, type PartRole, type PartSpec,
} from './plan';
import { ScorchMarks } from './scorch';

const CR = CONFIG.crash;
const DEG = Math.PI / 180;

export interface DirectorEnv extends DebrisEnv {
  surfaceAt?(x: number, z: number): string;
}

/**
 * Sound cues for the audio system: 'sim:explosion' (size 0..1, 1 = the full fuel fireball) for the
 * fireball and every secondary explosion, 'sim:impact' (speed m/s) for hard hits. The default sink
 * dispatches them as window CustomEvents (the first explosion of a crash cancels the audio's own
 * random secondaries).
 */
export type CrashCue =
  | { type: 'sim:explosion'; detail: { position: Vec3; size: number } }
  | { type: 'sim:impact'; detail: { position: Vec3; speed: number } };
export type CrashCueSink = (cue: CrashCue) => void;

/** Dispatch a cue as a window CustomEvent (no-op without a DOM). */
export function windowCueSink(cue: CrashCue): void {
  const w = (globalThis as { window?: { dispatchEvent?: (e: Event) => boolean } }).window;
  if (!w || typeof w.dispatchEvent !== 'function' || typeof CustomEvent !== 'function') return;
  w.dispatchEvent(new CustomEvent(cue.type, { detail: cue.detail }));
}

export interface CrashStart {
  /** The physics' crash reason. */
  reason: string;
  speedKt: number;
  /** Aircraft CG, velocity and angular velocity (world) just before the impact. */
  position: Vec3;
  velocity: Vec3;
  angularVelocity: Vec3;
  /** Aircraft mass, kg (spread over the parts when the model gives none). */
  massKg: number;
}

interface Saved {
  object: THREE.Object3D;
  parent: THREE.Object3D | null;
  index: number;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
  visible: boolean;
}

interface Bound {
  name: string;
  role: PartRole;
  object: THREE.Object3D;
  body: number;
  mass: number;
  /** Collision-box centre in the object's frame, scaled to world units. */
  offset: THREE.Vector3;
  burning: boolean;
  fire: number;
  hidden: boolean;
}

interface Secondary {
  at: number;
  scale: number;
  body: number;
  done: boolean;
}

/** Names of model pieces that belong with the fuselage when the model does not list its parts. */
const WITH_CORE = /glass|cockpit|interior|cabin|detail|well|light|lamp|strobe|glow|beacon|nav|panel|seat|instrument/i;
/** Mass fractions per role for a fallback split. */
const MASS_SHARE: Record<PartRole, number> = { core: 0.5, wing: 0.2, tail: 0.04, engine: 0.14, prop: 0.03, gear: 0.03, canopy: 0.02, surface: 0.01, misc: 0.02 };

function nameOf(o: THREE.Object3D): string {
  if (o.name) return o.name;
  let found = '';
  o.traverse((c) => {
    if (!found && c.name) found = c.name;
  });
  return found;
}

function hasMesh(o: THREE.Object3D): boolean {
  let m = false;
  o.traverse((c) => {
    if ((c as THREE.Mesh).isMesh) m = true;
  });
  return m;
}

const significant = (o: THREE.Object3D) => !(o as THREE.Light).isLight && hasMesh(o);

export class CrashDirector {
  readonly world: DebrisWorld;
  readonly scorch: ScorchMarks | null;
  /** The framed point (smoothed debris centroid) and the debris field's RMS radius. */
  readonly focus = new THREE.Vector3();
  spread = 0;
  fx: FxSim | null = null;
  kind: ImpactKind = 'bump';
  severity = 0;
  tReal = 0;
  tSim = 0;
  private activeFlag = false;
  private readonly scene: THREE.Scene;
  private readonly env: DirectorEnv;
  private bound: Bound[] = [];
  private saved: Saved[] = [];
  private temp: THREE.Object3D[] = [];
  private model: AircraftModelHandle | null = null;
  private usedModelParts = false;
  private column = -1;
  private secondaries: Secondary[] = [];
  private shakeBump = 0;
  private rndState: number;
  private readonly impact = new THREE.Vector3();
  private coreBody = -1;
  private furrowSlot = -1;
  private furrowStart = new THREE.Vector3();
  private furrowStarted = false;
  private furrowT = 0;
  private restScorched = false;
  // camera
  private camInit = false;
  private camAz = 0;
  private camEl = 0;
  private camDist = 30;
  private lastResetOk = true;
  private readonly cue: CrashCueSink;
  private lastImpactCue = -1e9;
  // scratch
  private readonly _p = new THREE.Vector3();
  private readonly _q = new THREE.Quaternion();
  private readonly _v = new THREE.Vector3();
  private readonly _t = new THREE.Vector3();
  private readonly _m = new THREE.Matrix4();
  private readonly _e = new THREE.Euler();
  private readonly _qs = new THREE.Quaternion();
  private readonly _up = new THREE.Vector3(0, 1, 0);

  constructor(scene: THREE.Scene, env: DirectorEnv, opts: { seed?: number; scorch?: boolean; cues?: CrashCueSink } = {}) {
    this.scene = scene;
    this.env = env;
    this.cue = opts.cues ?? windowCueSink;
    this.world = new DebrisWorld(CR.debris.capacity, CR.debris);
    this.scorch = opts.scorch === false ? null : new ScorchMarks(scene, CR.scorch.count);
    this.rndState = (opts.seed ?? CONFIG.fx.seed + 17) >>> 0;
  }

  get active(): boolean {
    return this.activeFlag;
  }

  private rnd(): number {
    this.rndState = (this.rndState + 0x6d2b79f5) >>> 0;
    let t = this.rndState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private surfaceY(x: number, z: number): number {
    const g = this.env.groundHeight(x, z);
    const w = this.env.waterLevel?.(x, z);
    return w === null || w === undefined || !(w > g) ? g : w;
  }

  private surfaceKind(x: number, z: number): string {
    const w = this.env.waterLevel?.(x, z);
    if (w !== null && w !== undefined && w > this.env.groundHeight(x, z)) return 'water';
    return this.env.surfaceAt?.(x, z) ?? 'dirt';
  }

  // ── Start ────────────────────────────────────────────────────────────────

  /** Take the airframe apart and start the sequence. */
  begin(model: AircraftModelHandle, info: CrashStart): void {
    if (this.activeFlag) this.reset();
    this.model = model;
    const root = model.root;
    root.updateWorldMatrix(true, true);
    const fin = (v: number, d = 0) => (Number.isFinite(v) ? v : d);
    const P = { x: fin(info.position.x, root.position.x), y: fin(info.position.y, root.position.y), z: fin(info.position.z, root.position.z) };
    const v = { x: fin(info.velocity.x), y: fin(info.velocity.y), z: fin(info.velocity.z) };
    const w = { x: fin(info.angularVelocity.x), y: fin(info.angularVelocity.y), z: fin(info.angularVelocity.z) };
    const wl = this.env.waterLevel?.(P.x, P.z);
    const g0 = this.env.groundHeight(P.x, P.z);
    const water = wl !== null && wl !== undefined && wl > g0 && P.y < wl + 4;
    const speedKt = Number.isFinite(info.speedKt) && info.speedKt > 0 ? info.speedKt : Math.hypot(v.x, v.y, v.z) * 1.943844;
    this.kind = classifyImpact({ vx: v.x, vy: v.y, vz: v.z, reason: info.reason, water });
    this.severity = this.kind === 'bump' ? 0 : impactSeverity(speedKt);
    const sev = this.severity;

    // Parts.
    let parts: BreakupPart[] = [];
    this.saved = [];
    this.usedModelParts = false;
    try {
      const got = model.getBreakupParts?.();
      if (got && got.length > 0) {
        parts = got.filter((p) => p && p.object);
        this.usedModelParts = parts.length > 0;
      }
    } catch (e) {
      console.warn('[crash] getBreakupParts failed; splitting the model', e);
    }
    if (!this.usedModelParts) parts = this.fallbackParts(root, info.massKg);
    parts = parts.slice(0, this.world.capacity);

    // Remember where everything was (for reset and verification).
    for (const p of parts) this.save(p.object);

    // Collision boxes.
    const specs: PartSpec[] = [];
    const offsets: THREE.Vector3[] = [];
    const quats: THREE.Quaternion[] = [];
    for (const p of parts) {
      const box = this.partBox(p.object);
      const s = new THREE.Vector3();
      const q = new THREE.Quaternion();
      const pos = new THREE.Vector3();
      p.object.matrixWorld.decompose(pos, q, s);
      const c = box.getCenter(new THREE.Vector3());
      const h = box.getSize(new THREE.Vector3()).multiplyScalar(0.5);
      const off = c.clone().multiply(s);
      const centre = off.clone().applyQuaternion(q).add(pos);
      specs.push({
        name: p.name, mass: p.mass, x: centre.x, y: centre.y, z: centre.z,
        hx: Math.max(0.05, h.x * Math.abs(s.x)), hy: Math.max(0.05, h.y * Math.abs(s.y)), hz: Math.max(0.05, h.z * Math.abs(s.z)),
        burning: p.burning,
      });
      offsets.push(off);
      quats.push(q);
    }

    // Impact point: under the nose for a dive, under the belly for a skid, ahead in the trees.
    const hl = Math.hypot(v.x, v.y, v.z) || 1;
    if (this.kind === 'noseIn') {
      this._v.set(0, 0, -2.2).applyQuaternion(root.quaternion);
      const x = P.x + this._v.x, z = P.z + this._v.z;
      this.impact.set(x, this.surfaceY(x, z), z);
    } else if (this.kind === 'obstacle') {
      this.impact.set(P.x + (v.x / hl) * 2, P.y, P.z + (v.z / hl) * 2);
    } else {
      this.impact.set(P.x, this.surfaceY(P.x, P.z), P.z);
    }
    const gI = this.surfaceY(this.impact.x, this.impact.z);

    const { core, plans } = planBreakup(specs, {
      kind: this.kind, severity: sev, vx: v.x, vy: v.y, vz: v.z, wx: w.x, wy: w.y, wz: w.z,
      cgx: P.x, cgy: P.y, cgz: P.z, ix: this.impact.x, iy: this.impact.y, iz: this.impact.z,
    }, () => this.rnd());

    // Bodies.
    this.world.clear();
    this.bound = [];
    for (let i = 0; i < parts.length; i++) {
      const s = specs[i], pl = plans[i], q = quats[i];
      const body = this.world.add({
        x: s.x, y: s.y, z: s.z, qx: q.x, qy: q.y, qz: q.z, qw: q.w,
        vx: pl.vx, vy: pl.vy, vz: pl.vz, wx: pl.wx, wy: pl.wy, wz: pl.wz,
        mass: Math.max(0.5, Number.isFinite(s.mass) ? s.mass : 1), hx: s.hx, hy: s.hy, hz: s.hz,
        restitution: pl.restitution, friction: pl.friction, float: pl.float, floodTime: pl.floodTime,
      });
      this.bound.push({ name: parts[i].name, role: pl.role, object: parts[i].object, body, mass: s.mass, offset: offsets[i], burning: pl.burning, fire: -1, hidden: false });
    }
    this.coreBody = this.bound[core]?.body ?? -1;
    for (let i = 0; i < parts.length; i++) {
      if (!plans[i].attach || i === core) continue;
      this.world.attach(this.bound[i].body, this.coreBody);
      this.world.scheduleDetach(this.bound[i].body, plans[i].detachAt, plans[i].breakImpulse);
    }
    // Into the scene, keeping the world transforms.
    for (const b of this.bound) this.scene.attach(b.object);

    // Effects at the impact.
    const fx = this.fx;
    const fire = this.kind !== 'ditch' && this.kind !== 'bump' && sev >= 0.25;
    const surf = this.surfaceKind(this.impact.x, this.impact.z);
    const I = this.impact;
    if (fx) {
      if (this.kind === 'ditch') {
        fx.splash(I.x, gI, I.z, 0.7 + 0.6 * sev);
        fx.splash(I.x + v.x * 0.25, gI, I.z + v.z * 0.25, 0.5 + 0.5 * sev);
        fx.fragments(I.x, gI + 0.5, I.z, gI, v.x, v.y, v.z, sev * 0.5, false);
      } else if (this.kind === 'bump') {
        fx.shockRing(I.x, gI, I.z, 0.25, surf);
        fx.sparks(I.x, gI + 0.3, I.z, v.x, 1, v.z, 12);
      } else {
        if (fire) fx.flash(I.x, I.y + 2.5, I.z, 0.75 + 0.5 * sev);
        fx.shockRing(I.x, gI, I.z, sev, surf);
        fx.sparks(I.x, I.y + 0.6, I.z, v.x, 3, v.z, Math.round(40 + 90 * sev));
        fx.fragments(I.x, I.y + 0.5, I.z, gI, v.x, v.y, v.z, sev, fire);
        if (fire) {
          fx.fireball(I.x, I.y + 1, I.z, gI, v.x * 0.7, v.y, v.z * 0.7, sev);
          fx.addFire(I.x, gI + 0.3, I.z, gI, 0.7 + 0.3 * sev, 18 + 8 * this.rnd(), 3 + 3 * sev, false);
        }
      }
      // Fires that follow the burning parts.
      for (const b of this.bound) {
        if (!b.burning) continue;
        const i = b.body;
        const r = Math.min(3, Math.max(0.8, 0.7 * Math.max(this.world.hx[i], this.world.hz[i])));
        const [d0, d1] = CR.fire.partDuration;
        b.fire = fx.addFire(this.world.px[i], this.world.py[i], this.world.pz[i], this.surfaceY(this.world.px[i], this.world.pz[i]), 0.8 + 0.2 * this.rnd(), d0 + (d1 - d0) * this.rnd(), r, true);
      }
      // The smoke column rises over the fuselage (thin oily smoke when nothing burns).
      if (this.kind !== 'ditch' && this.coreBody >= 0) {
        const c = this.coreBody;
        this.column = fx.addColumn(this.world.px[c], gI, this.world.pz[c], gI, fire ? 0.55 + 0.45 * sev : 0.3, fire ? CR.fire.columnDuration : 10);
      }
    }
    // Sound cues: the impact, and the fireball.
    this.lastImpactCue = -1e9;
    this.impactCue(I.x, I.y, I.z, Math.hypot(v.x, v.y, v.z), true);
    if (fire) this.explosionCue(I.x, I.y + 2, I.z, sev);
    // Secondary fuel explosions along the debris (the wing tanks).
    this.secondaries = [];
    if (fire && sev > 0.35) {
      const tanks = this.bound.filter((b) => b.burning && b.role === 'wing');
      const pool = tanks.length ? tanks : this.bound.filter((b) => b.burning);
      const [s0, s1] = CR.fire.secondary;
      if (pool.length) {
        this.secondaries.push({ at: s0 + 0.12 * this.rnd(), scale: 0.6 + 0.4 * sev, body: pool[0].body, done: false });
        this.secondaries.push({ at: s1 + 0.25 * this.rnd(), scale: 0.45 + 0.3 * sev, body: pool[pool.length > 1 ? 1 : 0].body, done: false });
      }
    }
    // Crater scorch.
    if (this.scorch && this.kind !== 'ditch' && sev > 0.1) {
      const [r0, r1] = CR.scorch.craterRadius;
      const R = r0 + (r1 - r0) * sev;
      this.scorch.place(I.x, I.z, 2 * R, 2 * R * (0.75 + 0.2 * this.rnd()), this.rnd() * Math.PI, this.env, 'crater');
    }
    this.furrowSlot = -1;
    this.furrowStarted = false;
    this.furrowT = 0;
    this.restScorched = false;
    this.focus.copy(this.impact);
    this.spread = 6;
    this.camInit = false;
    this.shakeBump = 0;
    this.tReal = 0;
    this.tSim = 0;
    this.activeFlag = true;
    this.syncObjects();
  }

  /** The model's major pieces when it does not list its breakup parts: everything cabin-like rides with the fuselage. */
  private fallbackParts(root: THREE.Object3D, massKg: number): BreakupPart[] {
    let cands = root.children.filter(significant);
    let guard = 0;
    while (cands.length === 1 && cands[0].children.filter(significant).length > 1 && guard++ < 8) cands = cands[0].children.filter(significant);
    if (cands.length === 0) return [];
    const vol = (o: THREE.Object3D) => {
      const b = new THREE.Box3().setFromObject(o);
      if (b.isEmpty()) return 0;
      const s = b.getSize(new THREE.Vector3());
      return s.x * s.y * s.z + 1e-6;
    };
    let coreIdx = cands.findIndex((o) => partRole(nameOf(o)) === 'core');
    if (coreIdx < 0) {
      let best = -1;
      cands.forEach((o, i) => {
        const vv = vol(o);
        if (vv > best) { best = vv; coreIdx = i; }
      });
    }
    const coreObj = cands[coreIdx];
    const members = cands.filter((o, i) => i === coreIdx || WITH_CORE.test(nameOf(o)));
    let others = cands.filter((o) => !members.includes(o));
    // save every piece we move, then gather the fuselage group
    for (const o of cands) this.save(o);
    // one mesh for both wings: cut it at the centreline so each wing can go its own way
    others = others.flatMap((o) => (partRole(nameOf(o)) === 'wing' ? this.splitWing(o, root) ?? [o] : [o]));
    const group = new THREE.Group();
    group.name = 'fuselage';
    coreObj.updateWorldMatrix(true, false);
    coreObj.matrixWorld.decompose(group.position, group.quaternion, group.scale);
    this.scene.add(group);
    group.updateMatrixWorld(true);
    for (const o of members) group.attach(o);
    this.temp.push(group);
    const total = Number.isFinite(massKg) && massKg > 0 ? massKg : 1000;
    const roles = others.map((o) => partRole(nameOf(o)));
    let share = MASS_SHARE.core;
    for (const r of roles) share += MASS_SHARE[r === 'core' ? 'misc' : r];
    const parts: BreakupPart[] = [{ name: 'fuselage', object: group, mass: (total * MASS_SHARE.core) / share, burning: true }];
    others.forEach((o, i) => {
      const r = roles[i] === 'core' ? 'misc' : roles[i];
      parts.push({ name: nameOf(o) || r, object: o, mass: (total * MASS_SHARE[r]) / share, burning: r === 'wing' });
    });
    return parts;
  }

  /** Split a mesh that spans both sides of the aircraft into left and right halves (temporary meshes; the original is hidden). */
  private splitWing(o: THREE.Object3D, root: THREE.Object3D): THREE.Object3D[] | null {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || !mesh.parent) return null;
    const g = mesh.geometry as THREE.BufferGeometry;
    const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) return null;
    root.updateWorldMatrix(true, true);
    const m = new THREE.Matrix4().copy(root.matrixWorld).invert().multiply(mesh.matrixWorld);
    const idx = g.getIndex();
    const tris = idx ? idx.count / 3 : pos.count / 3;
    const left: number[] = [];
    const right: number[] = [];
    const v = new THREE.Vector3();
    for (let t = 0; t < tris; t++) {
      let cx = 0;
      for (let k = 0; k < 3; k++) {
        const vi = idx ? idx.getX(t * 3 + k) : t * 3 + k;
        cx += v.fromBufferAttribute(pos, vi).applyMatrix4(m).x;
      }
      const dst = cx < 0 ? left : right;
      for (let k = 0; k < 3; k++) dst.push(idx ? idx.getX(t * 3 + k) : t * 3 + k);
    }
    if (left.length < 9 || right.length < 9) return null;
    const halves = [left, right].map((ix, i) => {
      // only the half's own vertices (so its bounds are the half's)
      const full = g.clone();
      full.setIndex(ix);
      const hg = full.toNonIndexed();
      full.dispose();
      hg.computeBoundingBox();
      hg.computeBoundingSphere();
      const h = new THREE.Mesh(hg, mesh.material);
      h.name = i === 0 ? 'leftWing' : 'rightWing';
      h.position.copy(mesh.position);
      h.quaternion.copy(mesh.quaternion);
      h.scale.copy(mesh.scale);
      h.castShadow = mesh.castShadow;
      h.receiveShadow = mesh.receiveShadow;
      h.userData.crashSplit = true;
      mesh.parent!.add(h);
      this.temp.push(h);
      return h;
    });
    mesh.visible = false;
    return halves;
  }

  private save(o: THREE.Object3D): void {
    // temporary objects (the fallback fuselage group, cut wing halves) are removed, not restored
    if (this.temp.includes(o) || this.saved.some((s) => s.object === o)) return;
    this.saved.push({
      object: o,
      parent: o.parent,
      index: o.parent ? o.parent.children.indexOf(o) : -1,
      position: o.position.clone(),
      quaternion: o.quaternion.clone(),
      scale: o.scale.clone(),
      visible: o.visible,
    });
  }

  /** Bounding box of an object's visible meshes in its own frame. */
  private partBox(obj: THREE.Object3D): THREE.Box3 {
    obj.updateWorldMatrix(true, true);
    const inv = obj.matrixWorld.clone().invert();
    const box = new THREE.Box3();
    const tmp = new THREE.Box3();
    const m = new THREE.Matrix4();
    obj.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      const g = mesh.geometry as THREE.BufferGeometry;
      if (!g.getAttribute('position')) return;
      if (!g.boundingBox) g.computeBoundingBox();
      if (!g.boundingBox || g.boundingBox.isEmpty()) return;
      m.multiplyMatrices(inv, mesh.matrixWorld);
      tmp.copy(g.boundingBox).applyMatrix4(m);
      box.union(tmp);
    });
    if (box.isEmpty()) box.setFromCenterAndSize(new THREE.Vector3(), new THREE.Vector3(0.5, 0.5, 0.5));
    return box;
  }

  // ── Per frame ────────────────────────────────────────────────────────────

  /** Debris/effects time scale right now (slow motion at first). */
  timeScale(): number {
    return this.activeFlag ? crashTimeScale(this.tReal) : 1;
  }

  /** Camera shake intensity 0..1 (heavy at the impact and at each secondary explosion). */
  shake(): number {
    if (!this.activeFlag) return 0;
    return Math.min(1, Math.max(crashShake(this.tReal), this.shakeBump));
  }

  /** Advance by dtReal s of real time (0 while paused). */
  update(dtRealIn: number): void {
    if (!this.activeFlag) return;
    const dtReal = Number.isFinite(dtRealIn) ? Math.min(0.1, Math.max(0, dtRealIn)) : 0;
    if (dtReal <= 0) return;
    this.tReal += dtReal;
    const dt = dtReal * crashTimeScale(this.tReal);
    this.tSim += dt;
    this.shakeBump *= Math.exp(-dtReal / 0.3);
    const W = this.world;
    const allRest = W.allAtRest();
    if (!allRest) W.step(dt, this.env);
    else W.events.count = 0;
    const fx = this.fx;

    // Events → effects.
    const ev = W.events;
    for (let k = 0; k < ev.count; k++) {
      const type = ev.type[k], i = ev.body[k], s = ev.strength[k];
      const x = ev.x[k], y = ev.y[k], z = ev.z[k];
      const b = this.boundOf(i);
      if (type === EV_GROUND) {
        if (s > 6) this.impactCue(x, y, z, s);
        if (fx && s > 7) {
          fx.sparks(x, y + 0.2, z, W.vx[i], 2, W.vz[i], Math.min(40, Math.round(s * 1.5)));
          fx.dust(x, y, z, y, W.vx[i], W.vz[i], s * 2, 0.2, this.surfaceKind(x, z));
        }
        if (s > 12 && b && b.mass > 100) this.shakeBump = Math.max(this.shakeBump, Math.min(0.6, s / 40));
      } else if (type === EV_WATER) {
        if (s > 6) this.impactCue(x, y, z, s);
        if (fx) fx.splash(x, y, z, Math.min(1.2, Math.max(0.2, s / 25)));
        if (b && b.fire >= 0 && fx) {
          fx.quench(b.fire);
          b.fire = -1;
        }
      } else if (type === EV_DETACH) {
        if (fx && !W.inWater[i] && this.kind !== 'ditch') {
          fx.sparks(x, y, z, W.vx[i], 2, W.vz[i], 20);
          if (this.severity > 0.3) fx.fragments(x, y, z, this.surfaceY(x, z), W.vx[i], W.vy[i], W.vz[i], 0.25, !!b?.burning);
        }
      } else if (type === EV_SINK) {
        if (b) {
          b.object.visible = false;
          b.hidden = true;
          if (b.fire >= 0 && fx) fx.quench(b.fire);
          b.fire = -1;
        }
      }
    }
    // Secondary explosions.
    for (const s of this.secondaries) {
      if (s.done || this.tSim < s.at) continue;
      s.done = true;
      const i = s.body;
      if (W.state[i] === SUNK || W.inWater[i]) continue;
      const x = W.px[i], y = W.py[i], z = W.pz[i];
      fx?.explosion(x, y + 0.5, z, this.surfaceY(x, z), s.scale);
      this.explosionCue(x, y + 0.5, z, 0.6 * s.scale);
      this.shakeBump = Math.max(this.shakeBump, 0.55 * s.scale);
    }
    // Parts, their fires, ploughing dust.
    this.syncObjects();
    if (fx) {
      for (const b of this.bound) {
        const i = b.body;
        if (b.fire >= 0) {
          if (W.inWater[i]) {
            fx.quench(b.fire);
            b.fire = -1;
          } else fx.moveFire(b.fire, W.px[i], W.py[i], W.pz[i], this.env.groundHeight(W.px[i], W.pz[i]));
        }
        if (W.contact[i] && W.slideSpeed[i] > 1.5 && b.mass >= 40 && W.state[i] !== ATTACHED) {
          fx.dust(W.cx[i], W.cy[i], W.cz[i], W.cy[i], W.vx[i], W.vz[i], W.slideSpeed[i], dt, this.surfaceKind(W.cx[i], W.cz[i]));
        }
      }
      const c = this.coreBody;
      if (this.column >= 0 && c >= 0) {
        const g = this.env.groundHeight(W.px[c], W.pz[c]);
        fx.moveFire(this.column, W.px[c], g, W.pz[c], g);
      }
    }
    this.updateFurrow(dt);
    this.updateFocus(dtReal);
  }

  private explosionCue(x: number, y: number, z: number, size: number): void {
    try {
      this.cue({ type: 'sim:explosion', detail: { position: { x, y, z }, size: Math.min(1, Math.max(0, size)) } });
    } catch {
      /* a listener threw: the crash goes on */
    }
  }

  /** A hard hit (rate-limited to one per 60 ms of real time). */
  private impactCue(x: number, y: number, z: number, speed: number, force = false): void {
    if (!force && this.tReal - this.lastImpactCue < 0.06) return;
    this.lastImpactCue = this.tReal;
    try {
      this.cue({ type: 'sim:impact', detail: { position: { x, y, z }, speed: Math.max(0, speed) } });
    } catch {
      /* a listener threw: the crash goes on */
    }
  }

  private boundOf(body: number): Bound | undefined {
    for (const b of this.bound) if (b.body === body) return b;
    return undefined;
  }

  /** Copy the bodies onto the part objects. */
  private syncObjects(): void {
    const W = this.world;
    for (const b of this.bound) {
      const i = b.body;
      if (i < 0) continue;
      const o = b.object;
      o.quaternion.set(W.qx[i], W.qy[i], W.qz[i], W.qw[i]);
      this._v.copy(b.offset).applyQuaternion(o.quaternion);
      o.position.set(W.px[i] - this._v.x, W.py[i] - this._v.y, W.pz[i] - this._v.z);
    }
  }

  /** The fuselage's ploughed furrow grows behind it while it slides; a scorch mark under it where it rests burning. */
  private updateFurrow(dt: number): void {
    const c = this.coreBody;
    const W = this.world;
    if (!this.scorch || c < 0 || this.kind === 'ditch' || this.kind === 'bump') return;
    if (!this.furrowStarted) {
      if (W.contact[c] && W.slideSpeed[c] > 3) {
        this.furrowStarted = true;
        this.furrowStart.set(W.px[c], 0, W.pz[c]);
      }
      return;
    }
    this.furrowT += dt;
    const moving = W.state[c] !== ASLEEP;
    if (this.furrowT >= 0.25 || !moving) {
      this.furrowT = 0;
      const dx = W.px[c] - this.furrowStart.x, dz = W.pz[c] - this.furrowStart.z;
      const L = Math.hypot(dx, dz);
      if (L > 4 && (moving || this.furrowSlot < 0 || !this.restScorched)) {
        this.furrowSlot = this.scorch.place(this.furrowStart.x + dx / 2, this.furrowStart.z + dz / 2, L + 3, CR.scorch.furrowWidth, Math.atan2(dz, dx), this.env, 'furrow', this.furrowSlot);
      }
    }
    if (!moving && !this.restScorched) {
      this.restScorched = true;
      const b = this.boundOf(c);
      if (b?.burning) this.scorch.place(W.px[c], W.pz[c], 7, 5.5, this.rnd() * Math.PI, this.env, 'crater');
    }
  }

  private updateFocus(dtReal: number): void {
    const W = this.world;
    let sw = 0, sx = 0, sy = 0, sz = 0;
    for (const b of this.bound) {
      const i = b.body;
      if (i < 0 || W.state[i] === SUNK) continue;
      const wgt = Math.max(1, b.mass) * (i === this.coreBody ? 2 : 1);
      sw += wgt; sx += wgt * W.px[i]; sy += wgt * W.py[i]; sz += wgt * W.pz[i];
    }
    // the fireball site matters early on
    const fw = sw * 0.35 * Math.exp(-this.tSim / 4);
    sw += fw; sx += fw * this.impact.x; sy += fw * this.impact.y; sz += fw * this.impact.z;
    if (!(sw > 0)) return;
    const cx = sx / sw, cy = sy / sw, cz = sz / sw;
    let ss = 0;
    for (const b of this.bound) {
      const i = b.body;
      if (i < 0 || W.state[i] === SUNK) continue;
      const wgt = Math.max(1, b.mass) * (i === this.coreBody ? 2 : 1);
      ss += wgt * ((W.px[i] - cx) ** 2 + (W.py[i] - cy) ** 2 + (W.pz[i] - cz) ** 2);
    }
    const spread = Math.sqrt(ss / sw);
    const k = 1 - Math.exp(-dtReal / CR.camera.focusTau);
    this.focus.x += (cx - this.focus.x) * k;
    this.focus.y += (cy - this.focus.y) * k;
    this.focus.z += (cz - this.focus.z) * k;
    if (Number.isFinite(spread)) this.spread += (spread - this.spread) * k;
  }

  // ── Camera ───────────────────────────────────────────────────────────────

  /**
   * Adjust the camera (already posed by the rig this frame) for the crash: shake, then drift to frame
   * the wreckage. `root` = the aircraft root's position (where the rig is looking). dtReal = 0 while paused.
   */
  applyCamera(camera: THREE.PerspectiveCamera, mode: CameraMode, dtRealIn: number, root: THREE.Vector3): void {
    if (!this.activeFlag) return;
    const dtReal = Number.isFinite(dtRealIn) ? Math.min(0.1, Math.max(0, dtRealIn)) : 0;
    const K = CR.camera;
    const w = crashCameraBlend(this.tReal, mode);
    const f = this.focus;
    if (mode === 'orbit') {
      // the player's own orbit, re-centred on the wreckage and pulled back to take it all in
      const off = this._t.copy(camera.position).sub(root);
      const d = off.length();
      const fit = frameDistance(this.spread);
      if (d > 1e-3 && fit > d) off.multiplyScalar(1 + (fit / d - 1) * w);
      camera.position.set(root.x + (f.x - root.x) * w + off.x, root.y + (f.y - root.y) * w + off.y, root.z + (f.z - root.z) * w + off.z);
    } else if (w > 0) {
      if (!this.camInit) {
        this.camInit = true;
        const dx = camera.position.x - f.x, dy = camera.position.y - f.y, dz = camera.position.z - f.z;
        const d = Math.max(1e-3, Math.hypot(dx, dy, dz));
        this.camAz = Math.atan2(dx, dz);
        this.camEl = Math.min(60 * DEG, Math.max(6 * DEG, Math.asin(Math.max(-1, Math.min(1, dy / d)))));
        this.camDist = Math.max(K.minDistance * 0.6, d);
      }
      this.camAz += K.orbitDegPerSec * DEG * dtReal;
      const ke = 1 - Math.exp(-dtReal / 2);
      this.camEl += (Math.max(K.elevationDeg * DEG, this.clearElevation(this.camAz, this.camDist)) - this.camEl) * ke;
      const kd = 1 - Math.exp(-dtReal / 1.5);
      this.camDist += (frameDistance(this.spread) - this.camDist) * kd;
      const ce = Math.cos(this.camEl);
      const px = f.x + Math.sin(this.camAz) * ce * this.camDist;
      const pz = f.z + Math.cos(this.camAz) * ce * this.camDist;
      const ly = this.lookHeight();
      let py = ly - 1.5 + Math.sin(this.camEl) * this.camDist;
      this._p.set(px, py, pz);
      // never park the camera in the fire at the impact point: keep a stand-off
      const ix = this._p.x - this.impact.x, iz = this._p.z - this.impact.z;
      const id = Math.hypot(ix, iz);
      const stand = K.minDistance * 0.9;
      if (id < stand) {
        const k = id > 1e-3 ? stand / id : 0;
        this._p.x = this.impact.x + (id > 1e-3 ? ix * k : stand);
        this._p.z = this.impact.z + (id > 1e-3 ? iz * k : 0);
      }
      py = Math.max(py, this.surfaceY(this._p.x, this._p.z) + 2.5);
      this._p.y = py;
      this._t.set(f.x, ly, f.z);
      this._m.lookAt(this._p, this._t, this._up);
      this._q.setFromRotationMatrix(this._m);
      camera.position.lerp(this._p, w);
      camera.quaternion.slerp(this._q, w);
    }
    // hand-held shake at the impact and the secondary explosions
    const sh = this.shake();
    if (sh > 1e-3) {
      const t = this.tReal;
      const n1 = Math.sin(t * 37.1) * 0.6 + Math.sin(t * 61.7 + 1.3) * 0.4;
      const n2 = Math.sin(t * 41.3 + 2.1) * 0.6 + Math.sin(t * 53.9 + 0.4) * 0.4;
      const n3 = Math.sin(t * 29.9 + 4.2) * 0.6 + Math.sin(t * 71.1 + 2.7) * 0.4;
      const a = sh * sh;
      camera.position.x += n1 * K.shakeM * a;
      camera.position.y += n2 * K.shakeM * a;
      camera.position.z += n3 * K.shakeM * a;
      this._e.set(n2 * K.shakeDeg * DEG * a, n3 * K.shakeDeg * DEG * a, n1 * K.shakeDeg * DEG * a);
      this._qs.setFromEuler(this._e);
      camera.quaternion.multiply(this._qs);
    }
    let floor = this.surfaceY(camera.position.x, camera.position.z) + 1.2;
    if (w > 0.5 && this.env.obstacleTop) {
      const t = this.env.obstacleTop(camera.position.x, camera.position.z);
      if (Number.isFinite(t)) floor = Math.max(floor, t + 2);
    }
    if (camera.position.y < floor) camera.position.y = floor;
    camera.updateMatrixWorld();
  }

  /**
   * The lowest elevation (rad) from which a camera at `dist` m on azimuth `az` sees the framed point
   * over the trees/buildings in between (and is not inside one).
   */
  private clearElevation(az: number, dist: number): number {
    const top = this.env.obstacleTop;
    if (!top) return 0;
    const f = this.focus;
    const fy = this.lookHeight();
    const sx = Math.sin(az), sz = Math.cos(az);
    let need = 0;
    for (let k = 1; k <= 6; k++) {
      const r = (dist * k) / 6;
      const h = top(f.x + sx * r, f.z + sz * r);
      if (!Number.isFinite(h)) continue;
      const a = Math.atan2(h + (k === 6 ? 4 : 2) - fy, r);
      if (a > need) need = a;
    }
    return Math.min(45 * DEG, need);
  }

  /** Height the crash camera looks at: above the wreck, or where the smoke leaves a tree canopy over it. */
  private lookHeight(): number {
    const f = this.focus;
    const t = this.env.obstacleTop?.(f.x, f.z);
    return Math.max(f.y + 1.5, Number.isFinite(t) ? (t as number) - 3 : -Infinity);
  }

  // ── Reset ────────────────────────────────────────────────────────────────

  /** Put every part back exactly where it was, stop every effect, clear the scorch marks. */
  reset(): void {
    const fx = this.fx;
    if (fx) {
      for (const b of this.bound) if (b.fire >= 0) fx.quench(b.fire);
    }
    if (this.saved.length) {
      if (this.usedModelParts && this.model?.restoreBreakupParts) {
        const out = this.saved.some((s) => s.object.parent !== s.parent);
        if (out) {
          try {
            this.model.restoreBreakupParts();
          } catch (e) {
            console.warn('[crash] restoreBreakupParts failed; restoring the parts myself', e);
          }
        }
      }
      // Restore what is still out (the fallback split, or a model that did not restore everything),
      // lowest child index first so every piece lands back in its original slot.
      const order = [...this.saved].sort((a, b) => a.index - b.index);
      for (const s of order) {
        const o = s.object;
        if (s.parent && o.parent !== s.parent) {
          o.removeFromParent();
          s.parent.add(o);
          const arr = s.parent.children;
          const at = arr.indexOf(o);
          if (s.index >= 0 && s.index < arr.length && at !== s.index) {
            arr.splice(at, 1);
            arr.splice(s.index, 0, o);
          }
          o.position.copy(s.position);
          o.quaternion.copy(s.quaternion);
          o.scale.copy(s.scale);
        }
        o.visible = s.visible;
      }
    }
    for (const t of this.temp) {
      t.removeFromParent();
      if (t.userData.crashSplit) (t as THREE.Mesh).geometry.dispose();
    }
    this.temp = [];
    // verify: the aircraft is whole and visible again
    let ok = true;
    for (const s of this.saved) if (s.parent && s.object.parent !== s.parent) ok = false;
    if (this.model && !this.model.root.visible) this.model.root.visible = true;
    this.lastResetOk = ok;
    if (!ok) console.warn('[crash] some parts could not be restored');
    this.saved = [];
    this.bound = [];
    this.secondaries = [];
    this.column = -1;
    this.coreBody = -1;
    this.world.clear();
    this.scorch?.clear();
    this.activeFlag = false;
    this.tReal = 0;
    this.tSim = 0;
    this.shakeBump = 0;
    this.camInit = false;
  }

  /** The aircraft was swapped (the old model is gone): remove its detached parts from the scene. */
  dropModel(): void {
    for (const b of this.bound) {
      b.object.removeFromParent();
      b.object.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
    }
    for (const t of this.temp) t.removeFromParent();
    this.temp = [];
    this.saved = [];
    this.bound = [];
    this.secondaries = [];
    this.column = -1;
    this.coreBody = -1;
    this.model = null;
    this.world.clear();
    this.scorch?.clear();
    this.activeFlag = false;
    this.tReal = 0;
    this.tSim = 0;
    this.shakeBump = 0;
    this.camInit = false;
  }

  /** The bound parts (name, role, object, body index) — for tests and debugging. */
  parts(): readonly { name: string; role: PartRole; object: THREE.Object3D; body: number }[] {
    return this.bound;
  }

  stats(): Record<string, unknown> {
    const W = this.world;
    let awake = 0;
    for (let i = 0; i < W.count; i++) if (W.state[i] === 0) awake++;
    return {
      active: this.activeFlag, kind: this.kind, severity: Math.round(this.severity * 100) / 100,
      parts: this.bound.length, awake, modelParts: this.usedModelParts,
      tReal: Math.round(this.tReal * 100) / 100, timeScale: Math.round(this.timeScale() * 100) / 100,
      spread: Math.round(this.spread * 10) / 10, scorch: this.scorch?.count() ?? 0, lastResetOk: this.lastResetOk,
    };
  }

  dispose(): void {
    this.reset();
    this.scorch?.dispose();
  }
}
