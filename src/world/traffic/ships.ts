/**
 * Sea traffic renderer: everything on the water in THREE draw calls.
 *
 *  1. One BatchedMesh (MeshStandardMaterial + traffic batch shader) holding
 *     every hull, sail, superstructure, the Port Chateau marina and both ferry
 *     terminals, two LODs each. Per frame each vessel gets its pose (sea.ts
 *     schedule at the traffic time) plus the drawn waves it floats on
 *     (buoyancy.ts at the water's time), sails swing about the mast with the
 *     boom (smoothed, so gybes swing across), and far/near LOD geometry is
 *     swapped per instance. Small craft vanish beyond `viewDistance`, ships
 *     beyond `shipViewDistance`.
 *  2. One dynamic wake mesh: foam trail + Kelvin arms for every moving vessel
 *     within `wakeDistance`, displaced on the GPU by the same Gerstner trains
 *     as the sea.
 *  3. One point list: bow spray of planing boats (pooled particles),
 *     navigation lights at dusk/dawn (sidelights, masthead, stern, trawler
 *     lights, anchor lights), quay lamps, pier lamps and the flashing
 *     harbour-entrance beacons.
 *
 * Built as a time-sliced job (`build(budgetMs)`: the sea plan's route
 * validation, then one model per step) so no frame stalls. Nothing here
 * allocates per frame.
 */
import * as THREE from 'three';
import { CONFIG, type Config } from '../../config';
import { getLayout, type WorldLayout } from '../layout';
import { getHeightfield } from '../heightfield';
import { getSeaSpectrum, type WaveSpectrum } from '../water/waves';
import { mooredPose, newVesselPose, seaPlanJob, toWorld, vesselPose, vesselTrack, VESSEL_DIMS, WAKE_KIND, type Berth, type SeaPlan, type SeaRoute, type VesselKind, type VesselPose, type WaterWorld } from './sea';
import { buildVesselPart, HULL_TINTS, SAIL_RIG, type VesselPart } from './models/vessels';
import { buildFerryTerminal, buildMarina } from './models/marina';
import { wakeAges, wakeIndices, writeWake, WAKE_VERTS_PER_SAMPLE, type WakeSample } from './wake';
import { hullWaveMotion, newWaveMotion, shoalFactor, waveWeights } from './buoyancy';
import { createBatchMaterial, createLightingUniforms, createPointMaterial, createSeaWaveUniforms, createWakeMaterial, packSeaWaves, type LightingUniforms, type SeaWaveUniforms } from './materials';
import { slicedJob, type Job, type SlicedJob } from './jobs';
import { PointBuffer, poseMatrix } from './points';
import { mulberry32 } from './rng';

/** The water shader's Gerstner displacement range (src/world/water/material.ts `uDispRange`). */
export const WATER_DISP_RANGE = 1500;
/** Spray particle pool. */
export const MAX_SPRAY = 240;
/** Extra (non-vessel) point budget: quay/pier lamps, beacons. */
const STATIC_LIGHTS = 64;

export interface ShipsOptions {
  config?: Config;
  layout?: WorldLayout;
  /** Land/water for route validation and shoaling (default: the heightfield). */
  water?: WaterWorld;
  /** The sea's wave trains (default: the water module's). */
  spectrum?: WaveSpectrum;
  shared?: LightingUniforms;
}

export interface ShipsFrame {
  /** Camera world position. */
  camX: number;
  camY: number;
  camZ: number;
  /** Traffic time (schedules), s. */
  t: number;
  /** Water time (waves, flutter), s — keeps running while paused, like the sea. */
  waveTime: number;
  /** Traffic step this frame (0 while paused), s. */
  dt: number;
  /** 0 day … 1 night: navigation lights, lamps, lit windows. */
  night: number;
  /** Drawing-buffer height, px (point sizes). */
  viewportHeight: number;
}

export interface ShipsStats {
  ready: boolean;
  buildSteps: number;
  maxBuildStepMs: number;
  routes: number;
  moored: number;
  instances: number;
  visibleVessels: number;
  wakes: number;
  spray: number;
  lights: number;
  drawCalls: number;
  rejected: string[];
  /** Where things are (QA): the marina origin and each moving vessel [x, z, heading, visible]. */
  marina: [number, number] | null;
  vessels: Record<string, [number, number, number, boolean]>;
}

export interface Ships {
  readonly group: THREE.Group;
  readonly shared: LightingUniforms;
  readonly ready: boolean;
  /** Runs the time-sliced build for up to `budgetMs`; true when everything is built. */
  build(budgetMs: number): boolean;
  update(f: ShipsFrame): void;
  /** Teleport / reset: snap smoothed state (booms), clear the spray. */
  reset(): void;
  stats(): ShipsStats;
  /** Instance matrix + visibility of a vessel (tests / QA): route id or `moored:<i>`. */
  vesselInfo(id: string): { visible: boolean; lod: number; x: number; y: number; z: number; boom: number; sail: 'port' | 'starboard' | null } | null;
  readonly plan: SeaPlan | null;
  dispose(): void;
}

type GeoPair = [number, number];

interface Vessel {
  id: string;
  kind: VesselKind;
  route: SeaRoute | null;
  berth: Berth | null;
  index: number;
  scale: number;
  L: number;
  B: number;
  level: number;
  sea: boolean;
  hullGeo: GeoPair;
  hull: number;
  sails: { mainP: GeoPair; mainS: GeoPair; jibP: GeoPair; jibS: GeoPair; main: number; jib: number } | null;
  pose: VesselPose;
  lod: number;
  shown: boolean;
  boom: number;
  /** Smoothed state initialised (the boom of a yacht; a moored boat's first pose). */
  primed: boolean;
  sailPort: boolean;
  shoal: number;
  shoalAge: number;
  viewDist: number;
  lodDist: number;
  /** Moored boats: shows an anchor/cabin light at night. */
  anchorLight: boolean;
  /** Last camera distance. */
  dist: number;
}

const HULL_KEY = (kind: VesselKind, moored: boolean, deployed: boolean): string => (kind === 'sail' ? (moored ? 'sail:moored' : 'sail:hull') : kind === 'fish' ? (deployed ? 'fish:deployed' : 'fish') : kind);

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _m3 = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _c = new THREE.Color();
const _c4 = new THREE.Vector4();
const DEG = Math.PI / 180;

/** Local-frame light layouts (scale-1 hull coordinates; +x starboard, −z bow). */
interface LampDef {
  p: [number, number, number];
  c: [number, number, number];
  /** Facing (local) and beam exponent; [0,0,0] + 0 = all-round. */
  d: [number, number, number];
  e: number;
  size: number;
}
const RED: [number, number, number] = [1, 0.06, 0.03];
const GREEN: [number, number, number] = [0.1, 1, 0.35];
const WHITE: [number, number, number] = [1, 0.92, 0.78];
const WARM: [number, number, number] = [1, 0.7, 0.38];
const side = (x: number, y: number, z: number, size = 0.5): LampDef[] => [
  { p: [-x, y, z], c: RED, d: [-1, 0, -0.35], e: 1.2, size },
  { p: [x, y, z], c: GREEN, d: [1, 0, -0.35], e: 1.2, size },
];
const stern = (y: number, z: number, size = 0.5): LampDef => ({ p: [0, y, z], c: WHITE, d: [0, 0, 1], e: 1.5, size });
const mast = (y: number, z: number, size = 0.6): LampDef => ({ p: [0, y, z], c: WHITE, d: [0, 0, -1], e: 0.8, size });
const allRound = (y: number, z: number, c = WHITE, size = 0.5): LampDef => ({ p: [0, y, z], c, d: [0, 0, 0], e: 0, size });
const LAMPS: Record<string, LampDef[]> = {
  sail: [...side(1.55, 1.45, -4.3), stern(1.3, 5.9)],
  motor: [mast(6.7, 3.2), ...side(2.45, 2.2, -5.2), stern(1.9, 9.3)],
  fish: [mast(9.7, -3.2), ...side(3.1, 2.5, -4.2), stern(2.2, 9.9)],
  'fish:deployed': [allRound(9.3, -3.2, GREEN), allRound(8.4, -3.2, WHITE), ...side(3.1, 2.5, -4.2), stern(2.2, 9.9)],
  launch: [allRound(1.95, 0.3), ...side(0.95, 1.2, -2.6, 0.35)],
  // (+ the stern light at whichever end is trailing, added in writeLamps)
  ferry: [allRound(22.3, 0, WHITE, 0.9), ...side(9.9, 12.2, 0, 0.8), ...deckLamps(8.9, 9.4, [-30, -15, 0, 15, 30])],
  container: [mast(46, 95, 1.2), mast(26, -118, 1.2), ...side(16.6, 32.5, 95, 1.1), stern(13, 146, 1.1), ...deckLamps(13, 16, [-100, -60, -20, 20, 60])],
  tanker: [mast(36, 95, 1.2), mast(22, -100, 1.2), ...side(22.4, 25, 95, 1.1), stern(10, 124.5, 1.1), ...deckLamps(10, 21, [-90, -50, -10, 30])],
};
function deckLamps(y: number, x: number, zs: number[]): LampDef[] {
  const out: LampDef[] = [];
  for (const z of zs) for (const s of [-1, 1]) out.push({ p: [s * x, y, z], c: WARM, d: [0, 0, 0], e: 0, size: 0.7 });
  return out;
}

export function createShips(opts: ShipsOptions = {}): Ships {
  const cfg = opts.config ?? CONFIG;
  const tc = cfg.world.traffic;
  const sc = tc.sea;
  const layout = opts.layout ?? getLayout();
  const hf = getHeightfield();
  const water: WaterWorld = opts.water ?? { groundHeight: (x, z) => hf.height(x, z), waterLevel: (x, z) => hf.waterLevel(x, z) };
  const spectrum = opts.spectrum ?? getSeaSpectrum(cfg);
  const shared = opts.shared ?? createLightingUniforms();
  const waves: SeaWaveUniforms = createSeaWaveUniforms(spectrum, WATER_DISP_RANGE);

  const group = new THREE.Group();
  group.name = 'traffic.ships';
  const batchMat = createBatchMaterial(shared, { underwater: true, name: 'traffic.vessels' });
  const wakeMat = createWakeMaterial(shared, waves);
  const pointMat = createPointMaterial(shared);

  let plan: SeaPlan | null = null;
  let batch: THREE.BatchedMesh | null = null;
  let wakeMesh: THREE.Mesh | null = null;
  let wakeGeo: THREE.BufferGeometry | null = null;
  let wakeBuf: { position: Float32Array; data: Float32Array; type: Float32Array } | null = null;
  const points = new PointBuffer(MAX_SPRAY + STATIC_LIGHTS + 400);
  const pointsObj = new THREE.Points(points.geometry, pointMat);
  pointsObj.name = 'traffic.ships.points';
  pointsObj.frustumCulled = false;
  // transparent traffic on the sea draws after the water (−10/−9) and before the clouds (0), which are always above it
  pointsObj.renderOrder = -1;

  const vessels: Vessel[] = [];
  const moving: Vessel[] = [];
  const moored: Vessel[] = [];
  const statics: { id: number; pair: GeoPair; x: number; z: number; lodDist: number; viewDist: number; lod: number; shown: boolean }[] = [];
  const staticLamps: { x: number; y: number; z: number; c: [number, number, number]; size: number; flash: number; phase: number }[] = [];
  const geo = new Map<string, GeoPair>();
  const wakeSamples = Math.max(4, sc.wakeSamples);
  const wakeAgeTable: Float32Array[] = [];
  const wakeTmp: WakeSample[] = Array.from({ length: wakeSamples }, () => ({ x: 0, z: 0, course: 0, speed: 0, travelled: 0, age: 0 }));
  const track = { x: 0, z: 0, course: 0, speed: 0, travelled: 0 };
  const weights = new Float64Array(16);
  const wakeSpec = { length: 1, beam: 1, maxAge: 1, fullSpeed: 1, kelvin: 1, foam: 1, level: 0 };
  /** Per moving vessel: the wake block it was last written to, and whether that block is current. */
  let wakeBlock = new Int32Array(0);
  let wakeFresh: boolean[] = [];
  const wm = newWaveMotion();
  let frame = 0;
  let visibleCount = 0;
  let wakeCount = 0;

  // ── spray particles (ring buffer) ──
  const spray = {
    x: new Float32Array(MAX_SPRAY), y: new Float32Array(MAX_SPRAY), z: new Float32Array(MAX_SPRAY),
    vx: new Float32Array(MAX_SPRAY), vy: new Float32Array(MAX_SPRAY), vz: new Float32Array(MAX_SPRAY),
    age: new Float32Array(MAX_SPRAY).fill(1e9), life: new Float32Array(MAX_SPRAY).fill(1), size: new Float32Array(MAX_SPRAY),
    next: 0, live: 0,
  };
  const rand = mulberry32(tc.seed ^ 0x5eed);
  const emitAcc = new Map<Vessel, number>();

  function* buildJob(): Job<void> {
    plan = yield* seaPlanJob(layout, water, cfg);
    // ── models (one per step) ──
    const parts: [string, (lod: number) => THREE.BufferGeometry][] = [];
    const vp = (kind: VesselKind, part: VesselPart, o: { moored?: boolean; deployed?: boolean; variant?: number } = {}) => (lod: number) => buildVesselPart(kind, part, lod, o).build();
    const needed = new Set<string>();
    for (const r of plan.routes) needed.add(HULL_KEY(r.kind, false, r.kind === 'fish' && r.path.duration > 0 && isTrawling(r)));
    for (const b of plan.marina.berths) needed.add(HULL_KEY(b.kind, true, false));
    for (const key of needed) {
      if (key === 'sail:moored') parts.push([key, vp('sail', 'hull', { moored: true })]);
      else if (key === 'sail:hull') {
        parts.push([key, vp('sail', 'hull')]);
        for (const p of ['mainP', 'mainS', 'jibP', 'jibS'] as const) parts.push([`sail:${p}`, vp('sail', p)]);
      } else if (key === 'fish:deployed') parts.push([key, vp('fish', 'hull', { deployed: true })]);
      else {
        const kind = key as VesselKind;
        const r = plan.routes.find((x) => x.kind === kind);
        parts.push([key, vp(kind, 'hull', { variant: r?.variant ?? 0 })]);
      }
    }
    const marina = plan.marina;
    parts.push(['marina', (lod) => buildMarina(marina, lod).build()]);
    if (plan.terminals.length) parts.push(['terminal', (lod) => buildFerryTerminal(plan!.terminals[0].pierLen, lod).build()]);
    const built: [string, THREE.BufferGeometry, THREE.BufferGeometry][] = [];
    for (const [key, fn] of parts) {
      const g0 = fn(0);
      yield;
      const g1 = fn(1);
      built.push([key, g0, g1]);
      yield;
    }
    // ── the batched mesh ──
    let nv = 0;
    let ni = 0;
    for (const [, g0, g1] of built) {
      nv += g0.getAttribute('position').count + g1.getAttribute('position').count;
      ni += g0.index!.count + g1.index!.count;
    }
    const sailRoutes = plan.routes.filter((r) => r.kind === 'sail').length;
    const maxInstances = plan.routes.length + sailRoutes * 2 + plan.marina.berths.length + 1 + plan.terminals.length;
    batch = new THREE.BatchedMesh(maxInstances, nv, ni, batchMat);
    batch.name = 'traffic.vessels';
    batch.frustumCulled = false;
    batch.perObjectFrustumCulled = true;
    batch.sortObjects = false;
    batch.castShadow = false;
    batch.receiveShadow = false;
    for (const [key, g0, g1] of built) {
      geo.set(key, [batch.addGeometry(g0), batch.addGeometry(g1)]);
      g0.dispose();
      g1.dispose();
    }
    yield;
    // ── instances: marina + terminals ──
    const f = marina.frame;
    const mid = batch.addInstance(geo.get('marina')![0]);
    batch.setMatrixAt(mid, _m.makeRotationY(Math.atan2(-f.uz, f.ux)).setPosition(f.ox, 0, f.oz));
    statics.push({ id: mid, pair: geo.get('marina')!, x: f.ox, z: f.oz, lodDist: 1600, viewDist: sc.shipViewDistance, lod: 0, shown: true });
    for (const tm of plan.terminals) {
      const pair = geo.get('terminal')!;
      const id = batch.addInstance(pair[0]);
      batch.setMatrixAt(id, _m.makeRotationY(Math.PI / 2 - tm.heading * DEG).setPosition(tm.x, 0, tm.z));
      statics.push({ id, pair, x: tm.x, z: tm.z, lodDist: 900, viewDist: sc.shipViewDistance, lod: 0, shown: true });
      // pier lamps every 30 m (x = 10, 40, …) on the +z side, 7.1 m above the deck
      const hr = tm.heading * DEG;
      const ax = Math.sin(hr);
      const az = -Math.cos(hr);
      for (let x = 10; x < tm.pierLen; x += 30) {
        // local +z (terminal frame) = right of the pier direction
        staticLamps.push({ x: tm.x + ax * x - az * 4.4, y: 11.5, z: tm.z + az * x + ax * 4.4, c: WARM, size: 0.5, flash: 0, phase: 0 });
      }
    }
    // marina lamps: quay lamps and the entrance beacons (Fl.R / Fl.G 4 s)
    const q = marina.quay;
    for (let u = q.u0 + 30; u < q.u1; u += 60) {
      const p = toWorld(f, u, q.w0 + 4.3);
      staticLamps.push({ x: p.x, y: q.top + 6.0, z: p.z, c: WARM, size: 0.5, flash: 0, phase: 0 });
    }
    for (const b of marina.beacons) {
      const p = toWorld(f, b.u, b.w);
      staticLamps.push({ x: p.x, y: 9.0, z: p.z, c: b.color === 'red' ? RED : GREEN, size: 1.1, flash: 4, phase: b.color === 'red' ? 0 : 2 });
    }
    // ── moving vessels ──
    for (const r of plan.routes) {
      const deployed = r.kind === 'fish' && isTrawling(r);
      const hullGeo = geo.get(HULL_KEY(r.kind, false, deployed))!;
      const dims = VESSEL_DIMS[r.kind];
      const v: Vessel = {
        id: r.id, kind: r.kind, route: r, berth: null, index: 0, scale: r.scale, L: dims.length * r.scale, B: dims.beam * r.scale, level: r.level, sea: Math.abs(r.level) < 0.5,
        hullGeo, hull: batch.addInstance(hullGeo[0]), sails: null, pose: newVesselPose(), lod: 0, shown: true, boom: 0, primed: false, sailPort: true, shoal: 1, shoalAge: 1e9,
        viewDist: isShip(r.kind) ? sc.shipViewDistance : sc.viewDistance, lodDist: sc.lodDistance * Math.max(1, (dims.length * r.scale) / 15), anchorLight: false, dist: 0,
      };
      if (r.kind === 'sail') {
        const g = (p: string) => geo.get(`sail:${p}`)!;
        v.sails = { mainP: g('mainP'), mainS: g('mainS'), jibP: g('jibP'), jibS: g('jibS'), main: batch.addInstance(g('mainP')[0]), jib: batch.addInstance(g('jibP')[0]) };
      }
      const tints = HULL_TINTS[r.kind];
      batch.setColorAt(v.hull, _c4.set(...colorOf(tints[r.variant % tints.length]), isShip(r.kind) || r.kind === 'ferry' ? 1 : 0.5));
      vessels.push(v);
      moving.push(v);
    }
    yield;
    // ── moored boats ──
    marina.berths.forEach((b, i) => {
      const hullGeo = geo.get(HULL_KEY(b.kind, true, false))!;
      const dims = VESSEL_DIMS[b.kind];
      const x = b.x;
      const z = b.z;
      const wl = water.waterLevel(x, z) ?? 0;
      const v: Vessel = {
        id: `moored:${i}`, kind: b.kind, route: null, berth: b, index: i, scale: b.scale, L: dims.length * b.scale, B: dims.beam * b.scale, level: 0, sea: true,
        hullGeo, hull: batch!.addInstance(hullGeo[0]), sails: null, pose: newVesselPose(), lod: 0, shown: true, boom: 0, primed: false, sailPort: true,
        shoal: shoalFactor(wl - water.groundHeight(x, z)), shoalAge: 0, viewDist: sc.viewDistance, lodDist: sc.lodDistance, anchorLight: false, dist: 0,
      };
      // a few boats have someone aboard: cabin windows and an anchor light at night
      const aboard = hashU(i, 31) < 0.14;
      v.anchorLight = aboard;
      const tints = HULL_TINTS[b.kind];
      batch!.setColorAt(v.hull, _c4.set(...colorOf(tints[b.variant % tints.length]), aboard ? 0.8 : 0));
      vessels.push(v);
      moored.push(v);
    });
    yield;
    // ── wakes ──
    const nWake = moving.length;
    const verts = nWake * wakeSamples * WAKE_VERTS_PER_SAMPLE;
    wakeBuf = { position: new Float32Array(verts * 3), data: new Float32Array(verts * 4), type: new Float32Array(verts) };
    wakeGeo = new THREE.BufferGeometry();
    wakeGeo.setAttribute('position', new THREE.BufferAttribute(wakeBuf.position, 3).setUsage(THREE.DynamicDrawUsage));
    wakeGeo.setAttribute('aWake', new THREE.BufferAttribute(wakeBuf.data, 4).setUsage(THREE.DynamicDrawUsage));
    wakeGeo.setAttribute('aType', new THREE.BufferAttribute(wakeBuf.type, 1).setUsage(THREE.DynamicDrawUsage));
    wakeGeo.setIndex(new THREE.BufferAttribute(wakeIndices(nWake, wakeSamples), 1));
    wakeGeo.setDrawRange(0, 0);
    wakeGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    wakeBlock = new Int32Array(moving.length).fill(-1);
    wakeFresh = moving.map(() => false);
    for (const v of moving) {
      const a = new Float32Array(wakeSamples);
      wakeAges(wakeSamples, WAKE_KIND[v.kind].maxAge, a);
      wakeAgeTable.push(a);
    }
    wakeMesh = new THREE.Mesh(wakeGeo, wakeMat);
    wakeMesh.name = 'traffic.wakes';
    wakeMesh.frustumCulled = false;
    wakeMesh.renderOrder = -2;
    group.add(batch, wakeMesh, pointsObj);
  }

  const job: SlicedJob<void> = slicedJob(buildJob());

  // ── per-frame helpers ──
  const setGeo = (id: number, g: GeoPair, lod: number) => batch!.setGeometryIdAt(id, g[lod]);
  const show = (v: Vessel, on: boolean) => {
    if (v.shown === on) return;
    v.shown = on;
    batch!.setVisibleAt(v.hull, on);
    if (v.sails) {
      batch!.setVisibleAt(v.sails.main, on);
      batch!.setVisibleAt(v.sails.jib, on);
    }
  };

  function placeVessel(v: Vessel, f: ShipsFrame, dx: number, dz: number): void {
    const p = v.pose;
    const r = Math.hypot(dx, dz);
    // ride the drawn waves near the camera (sea only; lakes are flat)
    if (v.sea && r < WATER_DISP_RANGE && waveWeights(spectrum, r, WATER_DISP_RANGE, weights) > 0) {
      if (v.route && ++v.shoalAge > 30) {
        v.shoalAge = 0;
        const wl = water.waterLevel(p.x, p.z);
        v.shoal = wl === null ? 1 : shoalFactor(wl - water.groundHeight(p.x, p.z));
      }
      hullWaveMotion(spectrum, weights, v.shoal, p.x, p.z, f.waveTime, p.heading, v.L, v.B, wm, v.route ? 5 : 3);
      p.y += wm.heave;
      p.pitch += wm.pitch;
      p.roll += wm.roll;
    }
    poseMatrix(_m, p.x, p.y, p.z, p.heading, p.pitch, p.roll, v.scale);
    batch!.setMatrixAt(v.hull, _m);
    const lod = v.dist > v.lodDist ? 1 : 0;
    if (lod !== v.lod) {
      v.lod = lod;
      setGeo(v.hull, v.hullGeo, lod);
    }
    if (v.sails) {
      // boom swings smoothly (a gybe takes ~2 s); the sail variant follows the boom's side
      if (!v.primed) {
        v.boom = p.boom;
        v.primed = true;
      } else {
        const maxStep = 60 * Math.max(f.dt, 0);
        v.boom += Math.max(-maxStep, Math.min(maxStep, p.boom - v.boom));
      }
      const port = v.boom < 0 || (v.boom === 0 && p.tack > 0);
      v.sailPort = port;
      setGeo(v.sails.main, port ? v.sails.mainP : v.sails.mainS, lod);
      setGeo(v.sails.jib, port ? v.sails.jibP : v.sails.jibS, lod);
      // mainsail: rotate about the mast by the boom angle
      _m2.makeTranslation(0, 0, SAIL_RIG.mastZ).multiply(_m3.makeRotationY(v.boom * DEG));
      batch!.setMatrixAt(v.sails.main, _m3.multiplyMatrices(_m, _m2));
      // jib (built in the sail frame, mast at z = 0): swung about its tack on the forestay, eased with the main
      const zt = SAIL_RIG.forestayZ + 0.1;
      const jibDeg = Math.sign(v.boom) * Math.max(0, Math.abs(v.boom) - 9) * 0.55;
      _m2.makeTranslation(0, 0, zt);
      _m2.multiply(_m3.makeRotationY(jibDeg * DEG));
      _m2.multiply(_m3.makeTranslation(0, 0, SAIL_RIG.mastZ - zt));
      batch!.setMatrixAt(v.sails.jib, _m3.multiplyMatrices(_m, _m2));
    }
  }

  function writeLamps(v: Vessel, key: string, night: number): void {
    const defs = LAMPS[key];
    if (!defs) return;
    poseMatrix(_m, v.pose.x, v.pose.y, v.pose.z, v.pose.heading, v.pose.pitch, v.pose.roll, v.scale);
    // the double-ended ferry travelling toward its model's +z end: port/starboard swap
    const flip = v.route?.mode === 'ferry' && Math.abs(((v.pose.course - v.pose.heading + 540) % 360) - 180) < 90;
    const k = 900 * night;
    for (const d of defs) {
      _v.set(d.p[0], d.p[1], d.p[2]).applyMatrix4(_m);
      let c = d.c;
      if (flip && (c === RED || c === GREEN)) c = c === RED ? GREEN : RED;
      _v2.set(d.d[0], d.d[1], d.d[2] * (flip ? -1 : 1)).transformDirection(_m);
      points.push(_v.x, _v.y, _v.z, c[0] * k, c[1] * k, c[2] * k, 0, d.size * v.scale, 2.2, 0, _v2.x, _v2.y, _v2.z, d.e);
    }
    if (v.route?.mode === 'ferry' && v.pose.speed > 0.2) {
      const s = flip ? -1 : 1;
      _v.set(0, 8.6, 45.5 * s).applyMatrix4(_m);
      _v2.set(0, 0, s).transformDirection(_m);
      points.push(_v.x, _v.y, _v.z, WHITE[0] * k, WHITE[1] * k, WHITE[2] * k, 0, 0.8, 2.2, 0, _v2.x, _v2.y, _v2.z, 1.5);
    }
  }

  function emitSpray(v: Vessel, f: ShipsFrame): void {
    if (!WAKE_KIND[v.kind].spray || f.dt <= 0) return;
    const p = v.pose;
    if (p.speed < 4 || v.dist > 1500) return;
    const rate = 90 * Math.min(1, (p.speed - 4) / 6); // particles / s
    let acc = (emitAcc.get(v) ?? 0) + rate * f.dt;
    const h = p.course * DEG;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    while (acc >= 1) {
      acc -= 1;
      const i = spray.next;
      spray.next = (spray.next + 1) % MAX_SPRAY;
      const s = rand() < 0.5 ? -1 : 1;
      const along = v.L * (0.18 + 0.12 * rand());
      const half = v.B * 0.42;
      spray.x[i] = p.x + fx * along - fz * half * s;
      spray.z[i] = p.z + fz * along + fx * half * s;
      spray.y[i] = p.y + 0.15;
      const out = 1.5 + 2.5 * rand();
      spray.vx[i] = fx * p.speed * 0.25 - fz * out * s;
      spray.vz[i] = fz * p.speed * 0.25 + fx * out * s;
      spray.vy[i] = 1.2 + 2.2 * rand() * Math.min(1, p.speed / 12);
      spray.age[i] = 0;
      spray.life[i] = 0.7 + 0.8 * rand();
      spray.size[i] = 0.4 + 0.6 * rand() * Math.min(1, v.L / 12);
    }
    emitAcc.set(v, acc);
  }

  function stepSpray(dt: number): void {
    let live = 0;
    for (let i = 0; i < MAX_SPRAY; i++) {
      if (spray.age[i] >= spray.life[i]) continue;
      if (dt > 0) {
        spray.age[i] += dt;
        spray.vy[i] -= 9.81 * dt;
        spray.x[i] += spray.vx[i] * dt;
        spray.y[i] += spray.vy[i] * dt;
        spray.z[i] += spray.vz[i] * dt;
      }
      const a = spray.age[i] / spray.life[i];
      if (a >= 1) continue;
      live++;
      const alpha = 0.55 * (1 - a) * Math.min(1, a * 8);
      points.push(spray.x[i], spray.y[i], spray.z[i], 0.95, 0.97, 1, alpha, spray.size[i] * (1 + 2.2 * a), 1.2, 1);
    }
    spray.live = live;
  }

  const ships: Ships = {
    group,
    shared,
    get ready() {
      return job.done;
    },
    get plan() {
      return plan;
    },
    build(budgetMs) {
      return job.step(budgetMs);
    },
    update(f) {
      if (!job.done || !batch || !plan) return;
      frame++;
      shared.uTime.value = f.waveTime;
      shared.uNight.value = f.night;
      pointMat.uniforms.uHalfHeight.value = f.viewportHeight / 2;
      packSeaWaves(spectrum, waves, f.camX, f.camZ, f.waveTime);
      const cx = f.camX;
      const cz = f.camZ;
      // statics (marina, terminals): LOD + visibility
      for (const s of statics) {
        const d = Math.hypot(s.x - cx, s.z - cz);
        const on = d < s.viewDist;
        if (on !== s.shown) {
          s.shown = on;
          batch.setVisibleAt(s.id, on);
        }
        const lod = d > s.lodDist ? 1 : 0;
        if (lod !== s.lod) {
          s.lod = lod;
          setGeo(s.id, s.pair, lod);
        }
      }
      visibleCount = 0;
      // moving vessels
      for (const v of moving) {
        vesselPose(v.route!, f.t, plan.windFromDeg, plan.windKt, v.pose);
        const dx = v.pose.x - cx;
        const dz = v.pose.z - cz;
        v.dist = Math.hypot(dx, v.pose.y - f.camY, dz);
        const on = v.dist < v.viewDist;
        show(v, on);
        if (!on) continue;
        visibleCount++;
        placeVessel(v, f, dx, dz);
      }
      // moored boats: far ones (beyond the drawn waves) are refreshed a quarter at a time
      const marinaD = Math.hypot(plan.marina.frame.ox - cx, plan.marina.frame.oz - cz);
      const anyMoored = marinaD < sc.viewDistance + 800;
      for (let i = 0; i < moored.length; i++) {
        const v = moored[i];
        if (!anyMoored) {
          show(v, false);
          continue;
        }
        const b = v.berth!;
        const dx = b.x - cx;
        const dz = b.z - cz;
        const dh = Math.hypot(dx, dz);
        v.dist = Math.hypot(dh, f.camY);
        const on = v.dist < v.viewDist;
        const wasShown = v.shown;
        show(v, on);
        if (!on) continue;
        visibleCount++;
        const lod = v.dist > v.lodDist ? 1 : 0;
        if (lod !== v.lod) {
          v.lod = lod;
          setGeo(v.hull, v.hullGeo, lod);
        }
        // moored boats only bob: the farther, the less often they need refreshing
        if (wasShown && v.primed && (i + frame) % refreshPeriod(v.dist) !== 0) continue;
        v.primed = true;
        mooredPose(b, i, f.waveTime, 0, v.pose);
        placeVessel(v, f, dx, dz);
      }
      // wakes
      wakeCount = 0;
      const buf = wakeBuf!;
      for (let k = 0; k < moving.length; k++) {
        const v = moving[k];
        if (!v.shown || v.dist > sc.wakeDistance) {
          wakeFresh[k] = false;
          continue;
        }
        const r = v.route!;
        // far wakes (sub-pixel lag) are rewritten every third frame; their block stays in place
        const block = wakeBlock[k];
        if (v.dist > 2000 && block === wakeCount && (k + frame) % 3 !== 0 && wakeFresh[k]) {
          wakeCount++;
          continue;
        }
        const ages = wakeAgeTable[k];
        const wk = WAKE_KIND[v.kind];
        let any = false;
        for (let j = 0; j < wakeSamples; j++) {
          const s = wakeTmp[j];
          vesselTrack(r, f.t - ages[j], track);
          s.x = track.x;
          s.z = track.z;
          s.course = track.course;
          s.speed = track.speed;
          s.travelled = track.travelled;
          s.age = ages[j];
          if (track.speed > 0.3) any = true;
        }
        if (!any) {
          wakeFresh[k] = false;
          continue;
        }
        wakeSpec.length = v.L;
        wakeSpec.beam = v.B;
        wakeSpec.maxAge = wk.maxAge;
        wakeSpec.fullSpeed = wk.fullSpeed;
        wakeSpec.kelvin = wk.kelvin;
        wakeSpec.foam = wk.foam;
        wakeSpec.level = r.level;
        writeWake(buf, wakeCount * wakeSamples * WAKE_VERTS_PER_SAMPLE, wakeTmp, wakeSamples, wakeSpec);
        wakeBlock[k] = wakeCount;
        wakeFresh[k] = true;
        wakeCount++;
      }
      if (wakeGeo) {
        const verts = wakeCount * wakeSamples * WAKE_VERTS_PER_SAMPLE;
        wakeGeo.setDrawRange(0, wakeCount * 3 * (wakeSamples - 1) * 6);
        if (verts > 0) {
          for (const [name, n] of [['position', 3], ['aWake', 4], ['aType', 1]] as const) {
            const a = wakeGeo.getAttribute(name) as THREE.BufferAttribute;
            a.clearUpdateRanges();
            a.addUpdateRange(0, verts * n);
            a.needsUpdate = true;
          }
        }
        wakeMesh!.visible = wakeCount > 0;
      }
      // points: spray, then lights
      points.reset();
      for (const v of moving) if (v.shown) emitSpray(v, f);
      stepSpray(f.dt);
      const night = f.night;
      if (night > 0.02) {
        for (const v of moving) {
          if (!v.shown || v.dist > 12000) continue;
          const key = v.kind === 'fish' && isTrawling(v.route!) ? 'fish:deployed' : v.kind;
          writeLamps(v, key, night);
        }
        if (anyMoored) {
          for (const v of moored) {
            if (!v.shown || !v.anchorLight) continue;
            const top = v.kind === 'sail' ? 16.2 : v.kind === 'motor' ? 6.6 : 3.2;
            poseMatrix(_m, v.pose.x, v.pose.y, v.pose.z, v.pose.heading, v.pose.pitch, v.pose.roll, v.scale);
            _v.set(0, top, v.kind === 'sail' ? SAIL_RIG.mastZ : 3.2).applyMatrix4(_m);
            const k = 500 * night;
            points.push(_v.x, _v.y, _v.z, WHITE[0] * k, WHITE[1] * k, WHITE[2] * k, 0, 0.45, 2.0, 0);
          }
        }
        for (const s of staticLamps) {
          if (Math.abs(s.x - cx) > 15000 || Math.abs(s.z - cz) > 15000) continue;
          let k = (s.flash > 0 ? 1100 : 380) * night;
          if (s.flash > 0) {
            const ph = (((f.waveTime + s.phase) % s.flash) + s.flash) % s.flash;
            k *= ph < 0.5 ? 1.6 : 0;
          }
          if (k > 0) points.push(s.x, s.y, s.z, s.c[0] * k, s.c[1] * k, s.c[2] * k, 0, s.size, 2.4, 0);
        }
      }
      points.commit();
      pointsObj.visible = points.count > 0;
    },
    reset() {
      for (const v of moving) v.primed = false;
      spray.age.fill(1e9);
      spray.live = 0;
      emitAcc.clear();
    },
    stats() {
      return {
        ready: job.done,
        buildSteps: job.steps,
        maxBuildStepMs: Math.round(job.maxStepMs * 100) / 100,
        routes: moving.length,
        moored: moored.length,
        instances: batch ? batch.instanceCount : 0,
        visibleVessels: visibleCount,
        wakes: wakeCount,
        spray: spray.live,
        lights: points.count - spray.live,
        drawCalls: (batch && batch.visible ? 1 : 0) + (wakeMesh && wakeMesh.visible ? 1 : 0) + (pointsObj.visible && points.count > 0 ? 1 : 0),
        rejected: plan ? plan.rejected : [],
        marina: plan ? [Math.round(plan.marina.frame.ox), Math.round(plan.marina.frame.oz)] : null,
        vessels: Object.fromEntries(moving.map((v) => [v.id, [Math.round(v.pose.x), Math.round(v.pose.z), Math.round(v.pose.heading), v.shown]])),
      };
    },
    vesselInfo(id) {
      const v = vessels.find((x) => x.id === id);
      if (!v || !batch) return null;
      return { visible: v.shown, lod: v.lod, x: v.pose.x, y: v.pose.y, z: v.pose.z, boom: v.boom, sail: v.sails ? (v.sailPort ? 'port' : 'starboard') : null };
    },
    dispose() {
      batch?.dispose();
      wakeGeo?.dispose();
      points.dispose();
      batchMat.dispose();
      wakeMat.dispose();
      pointMat.dispose();
      group.removeFromParent();
      group.clear();
    },
  };
  return ships;
}

/** Frames between pose refreshes of a moored boat at camera distance d (m). */
export const refreshPeriod = (d: number): number => (d < 200 ? 1 : d < 700 ? 2 : d < 1500 ? 3 : 6);
const isShip = (k: VesselKind): boolean => k === 'container' || k === 'tanker' || k === 'ferry';
/** Trawlers circling slowly with their outriggers down (the fishing loops at ≤ 4 kt). */
const isTrawling = (r: SeaRoute): boolean => r.kind === 'fish' && r.path.length / r.path.duration < 2.5;
const colorOf = (hex: number): [number, number, number] => {
  _c.setHex(hex);
  return [_c.r, _c.g, _c.b];
};
const hashU = (i: number, k: number): number => {
  const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453;
  return x - Math.floor(x);
};
