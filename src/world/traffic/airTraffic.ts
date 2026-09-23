/**
 * Air traffic renderer: every other aircraft in FOUR draw calls.
 *
 *  1. One BatchedMesh with the C172, PA-28, AS350-style helicopter and A320
 *     (two LODs each, liveries via the instance colour); each entity of the
 *     air simulation (airSim.ts) is one instance whose geometry follows its
 *     kind and distance.
 *  2. One InstancedMesh of propeller / rotor blur discs (near aircraft only).
 *  3. One point list: navigation lights (red left / green right / white tail,
 *     directional), anti-collision strobes (single flash GA, double flash
 *     airliner), red beacons, landing lights (a narrow forward beam — the
 *     first thing you see of an aircraft on final), and far-away aircraft as
 *     sun-lit dots with the aerial perspective.
 *  4. One contrail ribbon mesh: each airliner's persistent trail, camera-facing,
 *     spreading and breaking up with age, kept ≥ 1.5 px wide.
 *
 * Built as a time-sliced job; no allocation per frame.
 */
import * as THREE from 'three';
import { CONFIG, type Config } from '../../config';
import { getLayout, type WorldLayout } from '../layout';
import { terrainHeight } from '../heightfield';
import { airSimJob, type AirSim } from './airSim';
import { contrailPoint, type AirKind, type PlayerRef } from './air';
import { buildAircraft, DISCS, LIGHTS, LIVERIES } from './models/aircraft';
import { createBatchMaterial, createContrailMaterial, createDiscMaterial, createLightingUniforms, createPointMaterial, type LightingUniforms } from './materials';
import { slicedJob, type Job, type SlicedJob } from './jobs';
import { PointBuffer, poseMatrix } from './points';

/** Samples per contrail ribbon. */
export const CONTRAIL_SAMPLES = 72;
const KINDS: AirKind[] = ['c172', 'pa28', 'heli', 'a320'];
/** Length (m) of each type — far dots are this big. */
const LENGTH: Record<AirKind, number> = { c172: 8.3, pa28: 7.3, heli: 10.9, a320: 37.6 };

export interface AirTrafficOptions {
  config?: Config;
  layout?: WorldLayout;
  heightAt?: (x: number, z: number) => number;
  shared?: LightingUniforms;
  /** Traffic time at start (`?tt=`). */
  t0: number;
  /** Where the player is when the build finishes (schedule anchor). */
  player: () => PlayerRef | null;
}

export interface AirTrafficFrame {
  camX: number;
  camY: number;
  camZ: number;
  /** Traffic time and step (0 while paused), s. */
  t: number;
  dt: number;
  /** 0 day … 1 night. */
  night: number;
  viewportHeight: number;
  /** Vertical field of view, deg. */
  fovDeg: number;
  player: PlayerRef | null;
}

export interface AirTrafficStats {
  ready: boolean;
  buildSteps: number;
  maxBuildStepMs: number;
  entities: number;
  meshes: number;
  dots: number;
  discs: number;
  lights: number;
  contrails: number;
  drawCalls: number;
  /** Where they are (QA): role/kind, [x, y, z], render mode. */
  aircraft: string[];
}

export interface AirTraffic {
  readonly group: THREE.Group;
  readonly shared: LightingUniforms;
  readonly ready: boolean;
  readonly sim: AirSim | null;
  build(budgetMs: number): boolean;
  update(f: AirTrafficFrame): void;
  /** Reset / teleport / aircraft change. */
  reanchor(t: number, player: PlayerRef | null): void;
  stats(): AirTrafficStats;
  /** Render state of entity i (tests / QA). */
  entityInfo(i: number): { kind: AirKind; mode: 'mesh' | 'dot' | 'hidden'; lod: number; x: number; y: number; z: number; dist: number } | null;
  dispose(): void;
}

interface Slot {
  inst: number;
  mode: 'mesh' | 'dot' | 'hidden';
  lod: number;
  geoKey: string;
  livery: string;
  dist: number;
}

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const RED: [number, number, number] = [1, 0.05, 0.02];
const GREEN: [number, number, number] = [0.1, 1, 0.4];
const WHITE: [number, number, number] = [1, 0.95, 0.85];
const STROBE: [number, number, number] = [0.9, 0.95, 1.0];
const LANDING: [number, number, number] = [1, 0.93, 0.8];

export function createAirTraffic(opts: AirTrafficOptions): AirTraffic {
  const cfg = opts.config ?? CONFIG;
  const ac = cfg.world.traffic.air;
  const layout = opts.layout ?? getLayout();
  const heightAt = opts.heightAt ?? terrainHeight;
  const shared = opts.shared ?? createLightingUniforms();
  const group = new THREE.Group();
  group.name = 'traffic.air';
  const batchMat = createBatchMaterial(shared, { underwater: false, name: 'traffic.aircraft' });
  const discMat = createDiscMaterial(shared);
  const pointMat = createPointMaterial(shared);
  const trailMat = createContrailMaterial(shared);

  let sim: AirSim | null = null;
  let batch: THREE.BatchedMesh | null = null;
  let discs: THREE.InstancedMesh | null = null;
  let discAttr: THREE.InstancedBufferAttribute | null = null;
  let points: PointBuffer | null = null;
  let pointsObj: THREE.Points | null = null;
  let trailGeo: THREE.BufferGeometry | null = null;
  let trailMesh: THREE.Mesh | null = null;
  let trailPos: Float32Array | null = null;
  let trailData: Float32Array | null = null;
  const geo = new Map<string, number>();
  const slots: Slot[] = [];
  let nAirliners = 0;
  const counts = { meshes: 0, dots: 0, discs: 0, lights: 0, contrails: 0 };
  const trailP = Array.from({ length: CONTRAIL_SAMPLES }, () => ({ x: 0, y: 0, z: 0 }));
  const trailAge = new Float32Array(CONTRAIL_SAMPLES);

  function* buildJob(): Job<void> {
    sim = yield* airSimJob({ layout, heightAt, config: cfg, t0: opts.t0, player: opts.player() });
    const built: [string, THREE.BufferGeometry][] = [];
    for (const k of KINDS)
      for (const lod of [0, 1]) {
        built.push([`${k}:${lod}`, buildAircraft(k, lod).build()]);
        yield;
      }
    let nv = 0;
    let ni = 0;
    for (const [, g] of built) {
      nv += g.getAttribute('position').count;
      ni += g.index!.count;
    }
    const n = sim.entities.length;
    batch = new THREE.BatchedMesh(Math.max(1, n), nv, ni, batchMat);
    batch.name = 'traffic.aircraft';
    batch.frustumCulled = false;
    batch.perObjectFrustumCulled = true;
    batch.sortObjects = false;
    for (const [key, g] of built) {
      geo.set(key, batch.addGeometry(g));
      g.dispose();
    }
    for (const e of sim.entities) {
      const inst = batch.addInstance(geo.get(`${e.kind}:0`)!);
      batch.setVisibleAt(inst, false);
      slots.push({ inst, mode: 'hidden', lod: 0, geoKey: `${e.kind}:0`, livery: '', dist: Infinity });
      if (e.role === 'airliner') nAirliners++;
    }
    yield;
    // discs
    const maxDiscs = Math.max(1, n * 2);
    discs = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 40), discMat, maxDiscs);
    discAttr = new THREE.InstancedBufferAttribute(new Float32Array(maxDiscs * 4), 4).setUsage(THREE.DynamicDrawUsage);
    discs.geometry.setAttribute('aDisc', discAttr);
    discs.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    discs.count = 0;
    discs.frustumCulled = false;
    discs.name = 'traffic.discs';
    discs.renderOrder = 4;
    // lights + dots
    points = new PointBuffer(n * 10);
    pointsObj = new THREE.Points(points.geometry, pointMat);
    pointsObj.frustumCulled = false;
    pointsObj.name = 'traffic.air.points';
    pointsObj.renderOrder = 6;
    // contrails
    const na = Math.max(1, nAirliners);
    trailPos = new Float32Array(na * CONTRAIL_SAMPLES * 2 * 3);
    trailData = new Float32Array(na * CONTRAIL_SAMPLES * 2 * 4);
    trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPos, 3).setUsage(THREE.DynamicDrawUsage));
    trailGeo.setAttribute('aTrail', new THREE.BufferAttribute(trailData, 4).setUsage(THREE.DynamicDrawUsage));
    const idx = new Uint32Array(na * (CONTRAIL_SAMPLES - 1) * 6);
    let o = 0;
    for (let a = 0; a < na; a++)
      for (let j = 0; j < CONTRAIL_SAMPLES - 1; j++) {
        const b = (a * CONTRAIL_SAMPLES + j) * 2;
        idx.set([b, b + 2, b + 1, b + 1, b + 2, b + 3], o);
        o += 6;
      }
    trailGeo.setIndex(new THREE.BufferAttribute(idx, 1));
    trailGeo.setDrawRange(0, 0);
    trailGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    trailMesh = new THREE.Mesh(trailGeo, trailMat);
    trailMesh.frustumCulled = false;
    trailMesh.name = 'traffic.contrails';
    // contrails (cruise levels, far above the cumulus tops) draw before the clouds so nearer clouds cover them
    trailMesh.renderOrder = -1;
    group.add(batch, discs, pointsObj, trailMesh);
  }

  const job: SlicedJob<void> = slicedJob(buildJob());

  const meshDist = (k: AirKind) => (k === 'a320' ? ac.meshDistance * 3 : ac.meshDistance);
  const lod0Dist = (k: AirKind) => (k === 'a320' ? 2000 : 550);

  function lamp(x: number, y: number, z: number, c: [number, number, number], k: number, size: number, dx = 0, dy = 0, dz = 0, e = 0): void {
    if (k <= 0) return;
    if (points!.push(x, y, z, c[0] * k, c[1] * k, c[2] * k, 0, size, 2.0, 0, dx, dy, dz, e)) counts.lights++;
  }

  function writeLights(kind: AirKind, id: number, t: number, night: number, strobeOn: boolean, landing: boolean): void {
    const L = LIGHTS[kind];
    const nav = 1400 * (0.06 + 0.94 * night);
    const at = (p: number[]) => _v.set(p[0], p[1], p[2]).applyMatrix4(_m);
    const dir = (x: number, y: number, z: number) => _d.set(x, y, z).transformDirection(_m);
    at(L.navL);
    dir(-1, 0, -0.25);
    lamp(_v.x, _v.y, _v.z, RED, nav, 0.3, _d.x, _d.y, _d.z, 1.2);
    at(L.navR);
    dir(1, 0, -0.25);
    lamp(_v.x, _v.y, _v.z, GREEN, nav, 0.3, _d.x, _d.y, _d.z, 1.2);
    at(L.tail);
    dir(0, 0, 1);
    lamp(_v.x, _v.y, _v.z, WHITE, nav * 0.8, 0.3, _d.x, _d.y, _d.z, 1.5);
    // red beacon (all aircraft) ~ 1 flash per second
    const ph = t + id * 0.37;
    const bf = ph - Math.floor(ph);
    if (bf < 0.12) {
      at(L.beacon);
      lamp(_v.x, _v.y, _v.z, RED, 5000 * (0.25 + 0.75 * night), 0.35);
    }
    // wingtip strobes: single flash (GA, heli) every 1.2 s, double flash (airliner)
    if (strobeOn) {
      const period = kind === 'a320' ? 1.0 : 1.2;
      const sp = (t + id * 0.53) / period;
      const sf = (sp - Math.floor(sp)) * period;
      const on = sf < 0.05 || (kind === 'a320' && sf > 0.14 && sf < 0.19);
      if (on) {
        const k = 40000;
        at(L.navL);
        lamp(_v.x, _v.y, _v.z, STROBE, k, 0.4);
        at(L.navR);
        lamp(_v.x, _v.y, _v.z, STROBE, k, 0.4);
        if (kind === 'a320') {
          at(L.tail);
          lamp(_v.x, _v.y, _v.z, STROBE, k * 0.7, 0.4);
        }
      }
    }
    if (landing) {
      at(L.landing);
      dir(0, -0.08, -1);
      lamp(_v.x, _v.y, _v.z, LANDING, 60000 * (0.35 + 0.65 * night), 0.45, _d.x, _d.y, _d.z, 14);
    }
  }

  function writeDiscs(kind: AirKind, id: number, rpm: number, near: number): void {
    const list = DISCS[kind];
    for (let k = 0; k < list.length; k++) {
      const d = list[k];
      const i = discs!.count;
      if (i >= discAttr!.count) return;
      // disc: unit circle in XY; props face along z, the main rotor lies in XZ, the tail rotor in YZ
      if (d.axis === 'y') _q.setFromAxisAngle(_d.set(1, 0, 0), -Math.PI / 2);
      else if (d.axis === 'x') _q.setFromAxisAngle(_d.set(0, 1, 0), Math.PI / 2);
      else _q.identity();
      _m2.compose(_v.set(d.c[0], d.c[1], d.c[2]), _q, _s.set(d.r, d.r, d.r));
      discs!.setMatrixAt(i, _m2.premultiply(_m));
      const alpha = (kind === 'heli' ? 0.85 : 1) * near * Math.min(1, 0.35 + rpm);
      discAttr!.setXYZW(i, d.blades, id * 1.7 + k * 0.9, alpha, kind === 'heli' ? 0.25 : 0.3);
      discs!.count = i + 1;
    }
  }

  function writeContrail(a: number, e: NonNullable<AirSim['entities'][number]['airliner']>, f: AirTrafficFrame, pxAngle: number): boolean {
    const life = e.contrail;
    const since = f.t - e.start;
    const a0 = 0.35;
    const maxAge = Math.min(life, since);
    if (life <= 0 || maxAge <= a0 + 1) return false;
    const n = CONTRAIL_SAMPLES;
    for (let j = 0; j < n; j++) {
      const age = a0 + (maxAge - a0) * Math.pow(j / (n - 1), 1.7);
      trailAge[j] = age;
      contrailPoint(e, f.t, age, trailP[j]);
    }
    // skip trails entirely out of range
    const mid = trailP[n >> 1];
    if (Math.hypot(mid.x - f.camX, mid.y - f.camY, mid.z - f.camZ) > 110000) return false;
    const P = trailPos!;
    const D = trailData!;
    let o = a * n * 2;
    for (let j = 0; j < n; j++) {
      const p = trailP[j];
      const pa = trailP[Math.max(0, j - 1)];
      const pb = trailP[Math.min(n - 1, j + 1)];
      // camera-facing side vector: tangent × view
      const tx = pa.x - pb.x;
      const ty = pa.y - pb.y;
      const tz = pa.z - pb.z;
      const vx = p.x - f.camX;
      const vy = p.y - f.camY;
      const vz = p.z - f.camZ;
      let sx = ty * vz - tz * vy;
      let sy = tz * vx - tx * vz;
      let sz = tx * vy - ty * vx;
      const sl = Math.hypot(sx, sy, sz) || 1;
      sx /= sl;
      sy /= sl;
      sz /= sl;
      const age = trailAge[j];
      const age01 = age / life;
      const width = 16 + 420 * (1 - Math.exp(-age / 110));
      const dist = Math.hypot(vx, vy, vz);
      const minW = dist * pxAngle * 1.6;
      const drawn = Math.max(width, minW);
      const opacity = smooth(0.2, 2.5, age) * (0.92 - 0.45 * age01) * (1 - smooth(0.55, 1, age01)) * (width / drawn);
      const hw = drawn / 2;
      for (let s = -1; s <= 1; s += 2) {
        P[o * 3] = p.x + sx * hw * s;
        P[o * 3 + 1] = p.y + sy * hw * s;
        P[o * 3 + 2] = p.z + sz * hw * s;
        D[o * 4] = age01;
        D[o * 4 + 1] = s;
        D[o * 4 + 2] = opacity;
        D[o * 4 + 3] = age * e.speed;
        o++;
      }
    }
    return true;
  }

  const air: AirTraffic = {
    group,
    shared,
    get ready() {
      return job.done;
    },
    get sim() {
      return sim;
    },
    build(budgetMs) {
      return job.step(budgetMs);
    },
    update(f) {
      if (!job.done || !sim || !batch) return;
      sim.update(f.t, f.dt, f.player);
      shared.uTime.value = f.t;
      shared.uNight.value = f.night;
      pointMat.uniforms.uHalfHeight.value = f.viewportHeight / 2;
      counts.meshes = counts.dots = counts.discs = counts.lights = counts.contrails = 0;
      points!.reset();
      discs!.count = 0;
      let na = 0;
      const pxAngle = (2 * Math.tan((f.fovDeg * Math.PI) / 360)) / Math.max(1, f.viewportHeight);
      for (let i = 0; i < sim.entities.length; i++) {
        const e = sim.entities[i];
        const s = slots[i];
        const p = e.pose;
        const d = Math.hypot(p.x - f.camX, p.y - f.camY, p.z - f.camZ);
        s.dist = d;
        const md = meshDist(e.kind);
        const mode: Slot['mode'] = !p.visible || d > ac.dotDistance * (e.kind === 'a320' ? 2 : 1) ? 'hidden' : d < md ? 'mesh' : 'dot';
        if (mode !== s.mode) batch.setVisibleAt(s.inst, mode === 'mesh');
        s.mode = mode;
        if (e.airliner && writeContrail(na, e.airliner, f, pxAngle)) na++;
        if (mode === 'hidden') continue;
        poseMatrix(_m, p.x, p.y, p.z, p.heading, p.pitch, p.roll);
        if (mode === 'mesh') {
          counts.meshes++;
          const lod = d > lod0Dist(e.kind) ? 1 : 0;
          const key = `${e.kind}:${lod}`;
          if (key !== s.geoKey) {
            batch.setGeometryIdAt(s.inst, geo.get(key)!);
            s.geoKey = key;
          }
          s.lod = lod;
          const liv = `${e.kind}:${e.livery}`;
          if (liv !== s.livery) {
            const list = LIVERIES[e.kind];
            batch.setColorAt(s.inst, _c.setHex(list[e.livery % list.length]));
            s.livery = liv;
          }
          batch.setMatrixAt(s.inst, _m);
          const discRange = e.kind === 'heli' ? 3000 : 1500;
          if (d < discRange) writeDiscs(e.kind, e.id, p.rpm, 1 - smooth(discRange * 0.7, discRange, d));
        } else {
          // far: a sun-lit dot the size of the aircraft (dims out below ~1.6 px)
          counts.dots++;
          points!.push(p.x, p.y, p.z, 0.75, 0.76, 0.78, 1, LENGTH[e.kind] * 0.6, 1.6, 2);
        }
        writeLights(e.kind, e.id, f.t, f.night, p.strobe, p.landingLight);
      }
      counts.discs = discs!.count;
      counts.contrails = na;
      if (discs!.count > 0) {
        discs!.instanceMatrix.clearUpdateRanges();
        discs!.instanceMatrix.addUpdateRange(0, discs!.count * 16);
        discs!.instanceMatrix.needsUpdate = true;
        discAttr!.clearUpdateRanges();
        discAttr!.addUpdateRange(0, discs!.count * 4);
        discAttr!.needsUpdate = true;
      }
      discs!.visible = discs!.count > 0;
      points!.commit();
      pointsObj!.visible = points!.count > 0;
      trailGeo!.setDrawRange(0, na * (CONTRAIL_SAMPLES - 1) * 6);
      if (na > 0) {
        for (const [name, k] of [['position', 3], ['aTrail', 4]] as const) {
          const a = trailGeo!.getAttribute(name) as THREE.BufferAttribute;
          a.clearUpdateRanges();
          a.addUpdateRange(0, na * CONTRAIL_SAMPLES * 2 * k);
          a.needsUpdate = true;
        }
      }
      trailMesh!.visible = na > 0;
      batch.visible = counts.meshes > 0;
    },
    reanchor(t, player) {
      sim?.reanchor(t, player);
    },
    stats() {
      const vis = (o: THREE.Object3D | null) => (o && o.visible ? 1 : 0);
      return {
        ready: job.done,
        buildSteps: job.steps,
        maxBuildStepMs: Math.round(job.maxStepMs * 100) / 100,
        entities: sim ? sim.entities.length : 0,
        ...counts,
        drawCalls: vis(batch) + vis(discs) + vis(pointsObj) + vis(trailMesh),
        aircraft: sim ? sim.entities.map((e, i) => `${e.role}/${e.kind} ${Math.round(e.pose.x)},${Math.round(e.pose.y)},${Math.round(e.pose.z)} ${slots[i]?.mode ?? ''}${e.role === 'circuit' && sim!.circuit ? ' ' + sim!.circuit.aircraft[i].leg : ''}`) : [],
      };
    },
    entityInfo(i) {
      if (!sim || !sim.entities[i]) return null;
      const e = sim.entities[i];
      const s = slots[i];
      return { kind: e.kind, mode: s.mode, lod: s.lod, x: e.pose.x, y: e.pose.y, z: e.pose.z, dist: s.dist };
    },
    dispose() {
      batch?.dispose();
      discs?.geometry.dispose();
      discs?.dispose();
      points?.dispose();
      trailGeo?.dispose();
      batchMat.dispose();
      discMat.dispose();
      pointMat.dispose();
      trailMat.dispose();
      group.removeFromParent();
      group.clear();
    },
  };
  return air;
}

function smooth(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
