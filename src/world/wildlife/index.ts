/**
 * Marine wildlife renderer: dolphins, humpback whales, herring gulls and harbour seals, plus
 * their splashes, breath and blows — in FIVE draw calls: one InstancedMesh per species (vertex
 * animation in the shader, material.ts) and one point list (the animals' water effects and the
 * far gulls as dots, drawn with the traffic's point material).
 *
 * The motion lives in the pure modules (dolphins.ts, whales.ts, gulls.ts, seals.ts, splash.ts);
 * this file places each visible animal on the drawn sea (surface.ts: exactly the waves the water
 * shader displaces near the camera), writes the instance matrices and animation attributes, and
 * only touches what is near the camera. Nothing here allocates per frame.
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';
import { getLayout, type WorldLayout } from '../layout';
import { getHeightfield } from '../heightfield';
import { getSeaSpectrum, type WaveSpectrum } from '../water/waves';
import { defineRoutes, vesselTrack, VESSEL_DIMS, type MarinaLayout, type SeaRoute, type WaterWorld } from '../traffic/sea';
import { createLightingUniforms, createPointMaterial, type LightingUniforms } from '../traffic/materials';
import { PointBuffer, poseMatrix } from '../traffic/points';
import { portMarina } from '../port';
import { WILDLIFE } from './tuning';
import { createSurfaceSampler, type SurfaceSampler } from './surface';
import { seaDepthAt, type ZoneContext } from './zones';
import { createDolphinPlan, DolphinSim, podFrame, type DolphinFrame, type HullBox, type ShipTrack, type VesselInfo } from './dolphins';
import { createWhalePlan, newWhalePose, whaleEvents, whalePose, type WhalePlan, type WhalePose } from './whales';
import { createGullPlan, GullSim, type BoatPose, type GullFrame } from './gulls';
import { createSeals, type SealSpot } from './seals';
import { emitFarWhaleSprite, emitSplash, SPLASH_LIFE, type SplashContext } from './splash';
import { buildDolphin, buildGull, buildSeal, buildWhale, DOLPHIN_LENGTH, SEAL_LENGTH, WHALE_LENGTH } from './models';
import { createAnimalMaterial, createUnderwaterMaterial } from './material';

export { WILDLIFE } from './tuning';

/** Particle budget of the point list (splashes, blows, far gulls). */
export const MAX_POINTS = 4000;
/** Water events are drawn out to (m): dolphins' small splashes, whales' blows and breaches. */
const DOLPHIN_FX_RANGE = 700;
const WHALE_FX_RANGE = 12000;
/** Submerged bodies are drawn through the water out to (m). */
const UNDERWATER_DOLPHIN = 260;
const UNDERWATER_WHALE = 4000;

export interface WildlifeOptions {
  layout?: WorldLayout;
  marina?: MarinaLayout | null;
  water?: WaterWorld;
  spectrum?: WaveSpectrum;
  /** The traffic's routes (fishing boats, ships); default: the sea plan's definitions. */
  routes?: readonly SeaRoute[];
  windFromDeg?: number;
  windKt?: number;
}

/** The player's craft this frame. */
export interface PlayerInfo {
  x: number;
  y: number;
  z: number;
  /** Heading of the bow / nose (deg) and speed (through the water for a vessel, m/s). */
  heading: number;
  speed: number;
  vx: number;
  vy: number;
  vz: number;
  vessel: boolean;
  /** Vessels: the hull's plan box (body frame). */
  hull: HullBox | null;
}

export interface WildlifeFrame {
  /** Sea clock (s): schedules of dolphins / whales and the drawn waves. */
  t: number;
  /** Wave clock for sampling the drawn surface (normally = t; differs only with a QA schedule offset). */
  waveTime?: number;
  /** Traffic clock (s): fishing boats and ships. */
  trafficT: number;
  /** Frame step (s, 0 while paused). */
  dt: number;
  camX: number;
  camY: number;
  camZ: number;
  player: PlayerInfo | null;
  /** Drawing-buffer height (px) for point sizes. */
  viewportHeight?: number;
}

export interface WildlifeStats {
  dolphins: number;
  dolphinsDrawn: number;
  riding: string | null;
  pods: Record<string, string>;
  whales: number;
  whalesDrawn: number;
  gulls: number;
  gullsDrawn: number;
  gullDots: number;
  perched: number;
  seals: number;
  particles: number;
  drawCalls: number;
  updateMs: number;
}

export interface WhaleInfo {
  id: string;
  x: number;
  z: number;
  phase: string;
  heading: number;
  /** Seconds (sea clock) to the next blow and the next breach. */
  nextBlow: number;
  nextBreach: number;
}

export interface Wildlife {
  readonly group: THREE.Group;
  readonly shared: LightingUniforms;
  readonly dolphins: DolphinSim;
  readonly gulls: GullSim;
  readonly whales: WhalePlan;
  readonly seals: readonly SealSpot[];
  update(f: WildlifeFrame): void;
  reset(): void;
  stats(): WildlifeStats & { ride?: number[][] | null };
  /** Whales and when they next blow / breach (QA photos). */
  whaleInfo(t: number): WhaleInfo[];
  /** Coastal pods' centres at sea-clock time t (QA photos). */
  podInfo(t: number): { id: string; x: number; z: number; heading: number; mode: string }[];
  /** Hooks for the sound: called for events that start this frame. */
  onEvent: ((kind: 'blow' | 'dolphinBlow' | 'breach' | 'flush', x: number, y: number, z: number, size: number) => void) | null;
  dispose(): void;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

function instanced(geo: THREE.BufferGeometry, mat: THREE.Material, max: number, name: string): { mesh: THREE.InstancedMesh; anim: THREE.InstancedBufferAttribute } {
  const anim = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, max) * 4), 4);
  anim.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('aAnim', anim);
  const mesh = new THREE.InstancedMesh(geo, mat, Math.max(1, max));
  mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  mesh.count = 0;
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.name = name;
  return { mesh, anim };
}

export function createWildlife(opts: WildlifeOptions = {}): Wildlife {
  const layout = opts.layout ?? getLayout();
  const marina = opts.marina === undefined ? portMarina(layout) : opts.marina;
  const water: WaterWorld =
    opts.water ??
    (() => {
      const hf = getHeightfield();
      return { groundHeight: (x: number, z: number) => hf.height(x, z), waterLevel: (x: number, z: number) => hf.waterLevel(x, z) };
    })();
  const spectrum = opts.spectrum ?? getSeaSpectrum();
  const routes = opts.routes ?? (marina ? defineRoutes(layout, marina) : []);
  const windFrom = opts.windFromDeg ?? CONFIG.world.water.windFromDeg;
  const windKt = opts.windKt ?? CONFIG.world.water.windKt;
  const toH = ((windFrom + 180) * Math.PI) / 180;
  const splashCtx: SplashContext = { windX: Math.sin(toH), windZ: -Math.cos(toH), drift: windKt * 0.514444 * 0.45 };
  const zone: ZoneContext = { layout, marina };

  // ── plans and simulations ──
  const shipIds = WILDLIFE.dolphin.shipPods.map((s) => s.route).filter((id) => routes.some((r) => r.id === id));
  const dolphinPlan = createDolphinPlan(zone, water, shipIds);
  const dolphins = new DolphinSim(dolphinPlan, water);
  const whales = createWhalePlan(zone, water);
  const fishRoutes = routes.filter((r) => r.kind === 'fish');
  const threatRoutes = routes.filter((r) => (r.kind === 'sail' || r.kind === 'motor' || r.kind === 'launch') && Math.abs(r.level) < 0.5);
  const shipRoutes = dolphinPlan.pods.filter((p) => p.kind === 'ship').map((p) => routes.find((r) => r.id === p.ship) ?? null);
  const gullPlan = createGullPlan(marina, { windFromDeg: windFrom, fishingBoats: fishRoutes.length });
  const gulls = new GullSim(gullPlan);
  const seals = createSeals((x, z) => water.groundHeight(x, z));
  const sampler: SurfaceSampler = createSurfaceSampler(spectrum);

  // ── meshes: one per species + the point list ──
  const group = new THREE.Group();
  group.name = 'wildlife';
  const shared = createLightingUniforms();
  const dMat = createAnimalMaterial({ kind: 'cetacean', length: DOLPHIN_LENGTH, roughness: 0.5, name: 'wildlife.dolphin' });
  const wMat = createAnimalMaterial({ kind: 'cetacean', length: WHALE_LENGTH, roughness: 0.62, name: 'wildlife.whale' });
  const gMat = createAnimalMaterial({ kind: 'gull', length: 0.6, roughness: 0.85, name: 'wildlife.gull' });
  const sMat = createAnimalMaterial({ kind: 'seal', length: SEAL_LENGTH, roughness: 0.45, name: 'wildlife.seal' });
  const D = instanced(buildDolphin(), dMat, dolphinPlan.members.length, 'wildlife.dolphins');
  const Wm = instanced(buildWhale(), wMat, whales.whales.length, 'wildlife.whales');
  const Gm = instanced(buildGull(), gMat, gullPlan.gulls.length, 'wildlife.gulls');
  const Sm = instanced(buildSeal(), sMat, seals.length, 'wildlife.seals');
  // submerged bodies seen through the water (dolphins near the camera, whales within a few km)
  const underwater = (main: { mesh: THREE.InstancedMesh }, name: string, L: number) => {
    const geo = main.mesh.geometry;
    const surf = new THREE.InstancedBufferAttribute(new Float32Array(main.mesh.instanceMatrix.count * 4), 4);
    surf.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('aSurf', surf);
    const mat = createUnderwaterMaterial({ length: L, name });
    const mesh = new THREE.InstancedMesh(geo, mat, main.mesh.instanceMatrix.count);
    mesh.instanceMatrix = main.mesh.instanceMatrix;
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.renderOrder = -5;
    mesh.name = name;
    return { mesh, surf, mat };
  };
  const Du = underwater(D, 'wildlife.dolphins.underwater', DOLPHIN_LENGTH);
  const Wu = underwater(Wm, 'wildlife.whales.underwater', WHALE_LENGTH);
  const points = new PointBuffer(MAX_POINTS);
  const pointMat = createPointMaterial(shared);
  const pointsObj = new THREE.Points(points.geometry, pointMat);
  pointsObj.name = 'wildlife.points';
  pointsObj.frustumCulled = false;
  for (const o of [D.mesh, Wm.mesh, Gm.mesh, Sm.mesh, pointsObj, Du.mesh, Wu.mesh]) group.add(o);

  // seals: static instances
  const m4 = new THREE.Matrix4();
  seals.forEach((s, i) => {
    poseMatrix(m4, s.x, s.y + 0.05, s.z, s.heading, 0, 0, s.length / SEAL_LENGTH);
    Sm.mesh.setMatrixAt(i, m4);
  });
  Sm.mesh.count = seals.length;
  Sm.mesh.instanceMatrix.needsUpdate = true;

  // ── per-frame scratch (no allocation in update) ──
  const beat = new Float64Array(dolphinPlan.members.length);
  const wBeat = new Float64Array(whales.whales.length);
  const wPose: WhalePose = newWhalePose();
  const vessel: VesselInfo = { x: 0, z: 0, heading: 0, speed: 0, vx: 0, vz: 0, hull: { stemZ: -8, transomZ: 8, beam: 4 } };
  const tracks: ShipTrack[] = shipRoutes.map((r) => {
    const d = r ? VESSEL_DIMS[r.kind] : VESSEL_DIMS.container;
    const L = d.length * (r?.scale ?? 1);
    return { x: 0, z: 0, course: 0, speed: 0, hull: { stemZ: -L / 2, transomZ: L / 2, beam: d.beam * (r?.scale ?? 1) }, valid: false };
  });
  const df: DolphinFrame = { t: 0, dt: 0, trafficT: 0, camX: 0, camZ: 0, vessel: null, ships: tracks };
  const fishing: BoatPose[] = fishRoutes.map((r) => ({ x: 0, z: 0, heading: 0, speed: 0, length: VESSEL_DIMS.fish.length * r.scale, valid: false }));
  const playerBoat: BoatPose = { x: 0, z: 0, heading: 0, speed: 0, length: 15, valid: false };
  const threats = new Float64Array(4 * 32);
  const gf: GullFrame = { t: 0, dt: 0, camX: 0, camY: 0, camZ: 0, fishing, player: null, threats, threatCount: 0, playerThreat: -1 };
  const trk = { x: 0, z: 0, course: 0, speed: 0, travelled: 0 };
  const lastStats: WildlifeStats = {
    dolphins: dolphinPlan.members.length, dolphinsDrawn: 0, riding: null, pods: {}, whales: whales.whales.length, whalesDrawn: 0,
    gulls: gullPlan.gulls.length, gullsDrawn: 0, gullDots: 0, perched: 0, seals: seals.length, particles: 0, drawCalls: 5, updateMs: 0,
  };
  let ms = 0;
  let waveT = 0;
  let evMember = 0;
  let evWhale = 0;
  let evDt = 0;
  let emitted = 0;
  let evClock = 0;
  let camX = 0;
  let camY = 0;
  let camZ = 0;
  let nt = 0;
  const firstFrameOf = (age: number) => age < evDt + 1e-6;
  const pushThreat = (x: number, y: number, z: number, r: number) => {
    if (nt >= 32) return;
    threats[nt * 4] = x;
    threats[nt * 4 + 1] = y;
    threats[nt * 4 + 2] = z;
    threats[nt * 4 + 3] = r;
    nt++;
  };

  /** Draw calls this frame: every visible, non-empty mesh / point list. */
  const drawCalls = (): number => {
    let n = 0;
    const kids = group.children;
    for (let i = 0; i < kids.length; i++) {
      const o = kids[i];
      if (!o.visible) continue;
      if (o instanceof THREE.InstancedMesh && o.count === 0) continue;
      n++;
    }
    return n;
  };

  const self: Wildlife = {
    group,
    shared,
    dolphins,
    gulls,
    whales,
    seals,
    onEvent: null,
    update(f) {
      const t0 = typeof performance !== 'undefined' ? performance.now() : 0;
      const dt = f.dt;
      evDt = dt;
      camX = f.camX;
      camY = f.camY;
      camZ = f.camZ;
      waveT = f.waveTime ?? f.t;
      sampler.setCamera(f.camX, f.camZ);
      pointMat.uniforms.uHalfHeight.value = (f.viewportHeight ?? 900) / 2;
      points.reset();
      emitted = 0;

      // ── the player's craft ──
      const p = f.player;
      let playerVessel: VesselInfo | null = null;
      gf.player = null;
      if (p && p.vessel && p.hull) {
        vessel.x = p.x;
        vessel.z = p.z;
        vessel.heading = p.heading;
        vessel.speed = p.speed;
        vessel.vx = p.vx;
        vessel.vz = p.vz;
        vessel.hull = p.hull;
        playerVessel = vessel;
        playerBoat.x = p.x;
        playerBoat.z = p.z;
        playerBoat.heading = p.heading;
        playerBoat.speed = p.speed;
        playerBoat.length = p.hull.transomZ - p.hull.stemZ;
        playerBoat.valid = true;
        gf.player = playerBoat;
      }

      // ── dolphins ──
      for (let k = 0; k < tracks.length; k++) {
        const r = shipRoutes[k];
        if (!r) continue;
        vesselTrack(r, f.trafficT, trk);
        tracks[k].x = trk.x;
        tracks[k].z = trk.z;
        tracks[k].course = trk.course;
        tracks[k].speed = trk.speed;
        tracks[k].valid = true;
      }
      df.t = f.t;
      df.dt = dt;
      df.trafficT = f.trafficT;
      df.camX = f.camX;
      df.camZ = f.camZ;
      df.vessel = playerVessel;
      dolphins.update(df);
      let nd = 0;
      let nearDolphins = 0;
      const members = dolphinPlan.members;
      const drawD = WILDLIFE.dolphin.drawDistance;
      for (let i = 0; i < members.length; i++) {
        const pose = dolphins.poses[i];
        if (!pose.visible) continue;
        const dist = Math.hypot(pose.x - f.camX, pose.z - f.camZ);
        if (dist > drawD) continue;
        const len = members[i].length;
        const depth = seaDepthAt(water, pose.x, pose.z);
        const s = sampler.sample(pose.x, pose.z, waveT, pose.heading, len, len * 0.22, depth);
        // tail beat: faster and stronger with speed
        if (dt > 0) beat[i] = (beat[i] + Math.PI * 2 * Math.min(2.6, 0.7 + 0.22 * pose.speed) * dt) % (Math.PI * 2);
        if (pose.dy < -3.4) continue;
        const w = smooth(-2.5, -0.2, pose.dy);
        poseMatrix(m4, pose.x, s.heave + pose.dy, pose.z, pose.heading, pose.pitch + s.pitch * w, pose.roll + s.roll * w, len / DOLPHIN_LENGTH);
        D.mesh.setMatrixAt(nd, m4);
        D.anim.setXYZW(nd, beat[i], Math.min(1, 0.3 + 0.09 * pose.speed), 0, 0);
        Du.surf.setXYZW(nd, s.heave, 0.12, 1.3, 0);
        if (dist < UNDERWATER_DOLPHIN) nearDolphins++;
        nd++;
        // breath and splashes
        if (dist < DOLPHIN_FX_RANGE) {
          evMember = i;
          evClock = dolphins.clockOf(i, f);
          dolphins.events(i, evClock, SPLASH_LIFE[2], onDolphinEvent);
        }
      }
      D.mesh.count = nd;
      D.mesh.visible = nd > 0;
      D.mesh.instanceMatrix.needsUpdate = true;
      D.anim.needsUpdate = true;
      Du.mesh.count = nearDolphins > 0 ? nd : 0;
      Du.mesh.visible = nearDolphins > 0;
      Du.surf.needsUpdate = true;

      // ── whales ──
      let nw = 0;
      let nearWhales = 0;
      for (let i = 0; i < whales.whales.length; i++) {
        whalePose(whales, i, f.t, wPose);
        const dist = Math.hypot(wPose.x - f.camX, wPose.z - f.camZ);
        if (dist > WILDLIFE.whale.drawDistance) continue;
        const L = wPose.length;
        if (dt > 0) wBeat[i] = (wBeat[i] + Math.PI * 2 * (wPose.phase === 'breach' ? 0.5 : 0.22) * dt) % (Math.PI * 2);
        if (dist < WHALE_FX_RANGE) {
          evWhale = i;
          whaleEvents(whales, i, f.t, SPLASH_LIFE[11], onWhaleEvent);
        }
        if (wPose.dy < -0.9 * L) continue;
        const depth = seaDepthAt(water, wPose.x, wPose.z);
        const s = sampler.sample(wPose.x, wPose.z, waveT, wPose.heading, L, L * 0.25, depth);
        const w = smooth(-6, -0.5, wPose.dy) * (wPose.phase === 'breach' ? 0.2 : 1);
        poseMatrix(m4, wPose.x, s.heave + wPose.dy, wPose.z, wPose.heading, wPose.pitch + s.pitch * w, wPose.roll + s.roll * w, L / WHALE_LENGTH);
        Wm.mesh.setMatrixAt(nw, m4);
        const lift = wPose.phase === 'sounding' ? Math.min(1, Math.max(0, (-wPose.pitch - 18) / 45)) : 0;
        Wm.anim.setXYZW(nw, wBeat[i], wPose.phase === 'breach' ? 0.5 : 0.22, wPose.flex, lift);
        Wu.surf.setXYZW(nw, s.heave, 0.25, 3.2, 0);
        if (dist < UNDERWATER_WHALE && wPose.dy > -10) nearWhales++;
        nw++;
      }
      Wm.mesh.count = nw;
      Wm.mesh.visible = nw > 0;
      Wm.mesh.instanceMatrix.needsUpdate = true;
      Wm.anim.needsUpdate = true;
      Wu.mesh.count = nearWhales > 0 ? nw : 0;
      Wu.mesh.visible = nearWhales > 0;
      Wu.surf.needsUpdate = true;

      // ── gulls ──
      nt = 0;
      gf.playerThreat = p ? 0 : -1;
      if (p) {
        // a boat lying still (moored) or an aircraft parked doesn't bother them; moving, it does
        const v = Math.hypot(p.vx, p.vy, p.vz);
        if (p.vessel) pushThreat(p.x, p.y + 1.5, p.z, WILDLIFE.gull.scatter.boat * smooth(0.4, 2.5, v));
        else pushThreat(p.x, p.y, p.z, WILDLIFE.gull.scatter.aircraft * smooth(1, 15, v));
      }
      for (let k = 0; k < threatRoutes.length; k++) {
        const r = threatRoutes[k];
        vesselTrack(r, f.trafficT, trk);
        if (Math.abs(trk.x - f.camX) + Math.abs(trk.z - f.camZ) > 3000) continue;
        pushThreat(trk.x, 1.5, trk.z, WILDLIFE.gull.scatter.boat * (r.kind === 'sail' ? 0.6 : 1));
      }
      for (let k = 0; k < fishRoutes.length; k++) {
        vesselTrack(fishRoutes[k], f.trafficT, trk);
        fishing[k].x = trk.x;
        fishing[k].z = trk.z;
        fishing[k].heading = trk.course;
        fishing[k].speed = trk.speed;
        fishing[k].valid = true;
      }
      gf.t = f.t;
      gf.dt = dt;
      gf.camX = f.camX;
      gf.camY = f.camY;
      gf.camZ = f.camZ;
      gf.threatCount = nt;
      gulls.update(gf);
      if (gulls.flushedThisFrame > 0 && self.onEvent) {
        self.onEvent('flush', gullPlan.perchCentre.x, 3, gullPlan.perchCentre.z, gulls.flushedThisFrame);
      }
      let ng = 0;
      let dots = 0;
      const P = gulls.poses;
      const meshD = WILDLIFE.gull.meshDistance;
      const dotD = WILDLIFE.gull.dotDistance;
      for (let i = 0; i < gullPlan.gulls.length; i++) {
        if (!P.visible[i]) continue;
        const d = Math.hypot(P.x[i] - f.camX, P.y[i] - f.camY, P.z[i] - f.camZ);
        if (d < meshD) {
          poseMatrix(m4, P.x[i], P.y[i] + 0.155 * P.fold[i], P.z[i], P.heading[i], P.pitch[i], P.bank[i], 1);
          Gm.mesh.setMatrixAt(ng, m4);
          Gm.anim.setXYZW(ng, P.phase[i], P.flap[i], P.fold[i], 0);
          ng++;
        } else if (d < dotD) {
          // a far gull: a pale dot the size of the bird (dimmed by coverage below a pixel)
          if (points.push(P.x[i], P.y[i], P.z[i], 0.92, 0.93, 0.95, 0.95, 0.7, 1.3, 1)) dots++;
        }
      }
      Gm.mesh.count = ng;
      Gm.mesh.visible = ng > 0;
      Gm.mesh.instanceMatrix.needsUpdate = true;
      Gm.anim.needsUpdate = true;

      // ── seals ──
      const rock = WILDLIFE.seal.rock;
      const sealsNear = Math.hypot(rock.x - f.camX, rock.z - f.camZ) < WILDLIFE.seal.drawDistance + rock.r;
      Sm.mesh.visible = sealsNear && seals.length > 0;
      if (sealsNear) {
        for (let i = 0; i < seals.length; i++) {
          const ph = seals[i].phase;
          const head = smooth(0.5, 0.85, Math.sin(0.13 * f.t + ph));
          const tail = smooth(0.7, 0.95, Math.sin(0.071 * f.t + ph * 1.3));
          Sm.anim.setXYZW(i, 0, tail, head, head * Math.sin(0.45 * f.t + ph));
        }
        Sm.anim.needsUpdate = true;
      }

      points.commit();
      pointsObj.visible = points.count > 0;
      const t1 = typeof performance !== 'undefined' ? performance.now() : 0;
      ms = ms === 0 ? t1 - t0 : ms + (t1 - t0 - ms) * 0.05;
      // (mutated in place: no allocation per frame)
      const L = lastStats;
      L.dolphinsDrawn = nd;
      L.riding = dolphins.riding >= 0 ? dolphinPlan.pods[dolphins.riding].id : null;
      L.whalesDrawn = nw;
      L.gullsDrawn = ng;
      L.gullDots = dots;
      L.particles = points.count;
      L.drawCalls = drawCalls();
      L.updateMs = Math.round(ms * 1000) / 1000;
    },
    reset() {
      dolphins.reset();
      gulls.reset();
    },
    stats() {
      const s = dolphins.stats();
      // the riding pod's members in the vessel's body frame (bx, bz, dy): QA
      let ride: number[][] | null = null;
      if (dolphins.riding >= 0) {
        const pod = dolphinPlan.pods[dolphins.riding];
        const h = (vessel.heading * Math.PI) / 180;
        const fx = Math.sin(h);
        const fz = -Math.cos(h);
        ride = [];
        for (let k = 0; k < pod.n; k++) {
          const q = dolphins.poses[pod.first + k];
          const dx = q.x - vessel.x;
          const dz = q.z - vessel.z;
          ride.push([Math.round((dx * -fz + dz * fx) * 10) / 10, Math.round(-(dx * fx + dz * fz) * 10) / 10, Math.round(q.dy * 100) / 100]);
        }
      }
      return { ...lastStats, pods: s.modes, perched: gulls.stats().perched, ride };
    },
    whaleInfo(t) {
      return whales.whales.map((w, i) => {
        whalePose(whales, i, t, wPose);
        let nextBlow = -1;
        let nextBreach = -1;
        for (let dt2 = 0; dt2 < 3600 && (nextBlow < 0 || nextBreach < 0); dt2 += 0.5) {
          whaleEvents(whales, i, t + dt2, 0.5, (kind) => {
            if (kind === 0 && nextBlow < 0) nextBlow = dt2;
            if (kind === 1 && nextBreach < 0) nextBreach = dt2;
          });
        }
        return { id: w.id, x: Math.round(wPose.x), z: Math.round(wPose.z), phase: wPose.phase, heading: Math.round(wPose.heading), nextBlow, nextBreach };
      });
    },
    podInfo(t) {
      const pf = { x: 0, z: 0, heading: 0, speed: 0 };
      return dolphinPlan.pods
        .map((p, i) => ({ p, i }))
        .filter(({ p }) => p.kind === 'coastal')
        .map(({ p, i }) => {
          podFrame(p, t, pf);
          return { id: p.id, x: Math.round(pf.x), z: Math.round(pf.z), heading: Math.round(pf.heading), mode: dolphins.pods[i].mode };
        });
    },
    dispose() {
      for (const o of [D, Wm, Gm, Sm]) {
        o.mesh.geometry.dispose();
        o.mesh.dispose();
      }
      for (const m of [dMat, wMat, gMat, sMat, pointMat, Du.mat, Wu.mat]) m.dispose();
      points.dispose();
      group.removeFromParent();
    },
  };

  function onDolphinEvent(kind: number, age: number, x: number, z: number, size: number): void {
    if (emitted > MAX_POINTS - 300) return;
    const s = sampler.sample(x, z, waveT, 0, 2, 2, 20);
    const key = evMember * 7919 + kind * 104729 + Math.floor((evClock - age) * 10);
    emitted += emitSplash(points, kind, age, x, s.heave, z, size, key, splashCtx);
    if (kind === 0 && firstFrameOf(age) && self.onEvent) self.onEvent('dolphinBlow', x, s.heave, z, size);
  }

  function onWhaleEvent(kind: number, age: number, x: number, z: number, size: number): void {
    if (emitted > MAX_POINTS - 300) return;
    const s = sampler.sample(x, z, waveT, 0, 10, 10, 40);
    const key = evWhale * 15485863 + kind * 32452843 + Math.floor((df.t - age) * 10);
    emitted += emitSplash(points, kind + 10, age, x, s.heave, z, size, key, splashCtx);
    if (emitFarWhaleSprite(points, kind + 10, age, x, s.heave, z, size, Math.hypot(x - camX, z - camZ, camY), splashCtx)) emitted++;
    if (firstFrameOf(age) && self.onEvent) {
      if (kind === 0) self.onEvent('blow', x, s.heave + 2, z, size);
      else if (kind === 1) self.onEvent('breach', x, s.heave, z, size);
    }
  }

  return self;
}
