/**
 * Road traffic renderer: moving vehicles (sim.ts on the lane graph of the
 * active roads), parked cars (parking.ts: kerbs and car parks), contact
 * shadows and dusk lamp glows — four draw calls at most:
 *
 *  1. near vehicles (≤ nearDistance): one BatchedMesh of the detailed models
 *     (per-instance paint, odometer → spinning wheels, steering, lamps in a
 *     data texture; material.ts). Only the few near cars are in it, so its
 *     multi-draw stays short;
 *  2. far vehicles: ONE instanced draw of a parametric box car (farcar.ts);
 *  3. contact shadows (instanced quads, multiplied);
 *  4. lamp glows (points, only while the lamps are on).
 *
 * The lane graph is built time-sliced (~4 ms per frame) once the roads' lane
 * data arrives from their worker. Vehicles sit on the exact rendered road
 * surface (`RoadSurface.height`, or the terrain + road lift where a chunk is
 * not built yet), pitched between their axles and rolled with the road's
 * camber; both materials apply the road's LOD lift + depth pull. Parked cars
 * are static: placed once, their far instances and shadows rebuilt only when
 * the set, their level of detail or the sun changes. Vehicles beyond 800 m
 * move every other frame. No allocation per frame.
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';
import { activeRoads, type Roads } from '../roads';
import { getLayout, type Town } from '../layout';
import { getLandcover, newLandcover } from '../landcover';
import { pavedLift } from '../roads/ribbon';
import { lodLiftArray } from '../roads/depth';
import { LaneGraph, KIND } from './lanes';
import { TrafficSim, type PathPoint, type SimCamera, type VehiclePose } from './sim';
import { ParkingField, type ParkedCar } from './parking';
import { SPECS, SEMI, VT, MODEL_COUNT, MODEL_TRAILER, TRAILER_WHEELBASE } from './specs';
import { buildVehicleGeometry, lampAnchors } from './vehicles';
import { createCarMaterial, createCarUniforms, createShadowMaterial, createGlowMaterial, FLAG_HEAD, FLAG_BRAKE, FLAG_IND_L, FLAG_IND_R } from './material';
import { createFarMaterial, farTemplate } from './farcar';
import { paintFinish, paintRGB } from './paint';

export { LaneGraph } from './lanes';
export { TrafficSim } from './sim';
export { ParkingField, parkedSlots, carParkSlots } from './parking';
export { buildVehicleGeometry } from './vehicles';
export { SPECS, VT } from './specs';

export interface CarsOptions {
  /** Ground height for vehicles off the built road chunks and in car parks. */
  heightAt: (x: number, z: number) => number;
  /** Tops of buildings and trees (−∞ where none): car park bays under them stay empty. */
  obstacleTop?: (x: number, z: number) => number;
  /** Towns whose car parks get cars (default: the layout's); urban landcover weight. */
  towns?: readonly Town[];
  urban?: (x: number, z: number) => number;
  /** Where the lane graph comes from (default: the active roads). */
  roads?: () => Roads | null;
  cfg?: typeof CONFIG.world.cars;
}

export interface CarsStats {
  ready: boolean;
  moving: number;
  parked: number;
  drawn: number;
  near: number;
  far: number;
  shadows: number;
  glows: number;
  drawCalls: number;
  [k: string]: number | boolean;
}

export interface Cars {
  update(camera: THREE.PerspectiveCamera, dt: number, paused: boolean, sunDir: THREE.Vector3): void;
  /** Teleport / reset: traffic restarts around the next camera position. */
  reset(): void;
  readonly sim: TrafficSim | null;
  readonly graph: LaneGraph | null;
  readonly group: THREE.Group;
  stats(): CarsStats;
  dispose(): void;
}

const TEX_W = 256;
/** Lamp glows are drawn within this distance (m²); beyond HALF_RATE vehicles update every other frame. */
const GLOW_D2 = 2200 * 2200;
const HALF_RATE_D2 = 800 * 800;
/** Parked cars switch to the detailed model closer than moving ones (they are many and static). */
const PARKED_NEAR = 0.6;
const LIFT_BY_KIND = lodLiftArray();
const KIND_NAMES = ['highway', 'road', 'access', 'lane', 'street', 'drive'] as const;
const TRAILER_HALF = (SEMI.trailerRear - SEMI.trailerFront) / 2;
/** Trailer box centre, back from the trailer model origin (midway kingpin–axle). */
const TRAILER_BACK = TRAILER_HALF - (SEMI.kingpin - SEMI.trailerFront) - TRAILER_WHEELBASE / 2;

export function createCars(scene: THREE.Scene, opts: CarsOptions): Cars {
  const cfg = opts.cfg ?? CONFIG.world.cars;
  const getRoads = opts.roads ?? activeRoads;
  const cap = cfg.maxMoving;
  const maxInst = cap * 2 + cfg.maxParked;
  const TRAILER0 = cap;
  const PARK0 = cap * 2;

  // ── near: the detailed models in one BatchedMesh ──
  const geos = Array.from({ length: MODEL_COUNT }, (_, m) => buildVehicleGeometry(m, 0));
  let verts = 0;
  let idx = 0;
  for (const g of geos) {
    verts += g.getAttribute('position').count;
    idx += g.index!.count;
  }
  const texH = Math.ceil((maxInst * 2) / TEX_W);
  const data = new Float32Array(TEX_W * texH * 4);
  const dataTex = new THREE.DataTexture(data, TEX_W, texH, THREE.RGBAFormat, THREE.FloatType);
  dataTex.needsUpdate = true;
  const U = createCarUniforms(dataTex);
  const material = createCarMaterial(U);
  const batch = new THREE.BatchedMesh(maxInst, verts, idx, material);
  batch.name = 'cars-near';
  batch.sortObjects = false;
  batch.perObjectFrustumCulled = true;
  batch.frustumCulled = false;
  batch.castShadow = false;
  batch.receiveShadow = true;
  const geoId = geos.map((g) => batch.addGeometry(g));
  for (let k = 0; k < maxInst; k++) {
    batch.addInstance(geoId[0]);
    batch.setVisibleAt(k, false);
  }
  const instGeo = new Int32Array(maxInst).fill(geoId[0]);
  const instVis = new Uint8Array(maxInst);
  const instSerial = new Float64Array(maxInst).fill(-1);

  // ── far: one instanced parametric car ──
  const farGeo = farTemplate();
  const aInst = new THREE.InstancedBufferAttribute(new Float32Array(maxInst * 4), 4);
  aInst.setUsage(THREE.DynamicDrawUsage);
  farGeo.setAttribute('aInst', aInst);
  const farMat = createFarMaterial(U);
  const far = new THREE.InstancedMesh(farGeo, farMat, maxInst);
  far.name = 'cars-far';
  far.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(maxInst * 3), 3);
  far.instanceColor.setUsage(THREE.DynamicDrawUsage);
  far.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  far.frustumCulled = false;
  far.count = 0;
  far.receiveShadow = true;

  // ── contact shadows ──
  const quad = new THREE.PlaneGeometry(1, 1);
  quad.rotateX(-Math.PI / 2);
  const shadowCap = maxInst;
  const aDims = new THREE.InstancedBufferAttribute(new Float32Array(shadowCap * 4), 4);
  const aMisc = new THREE.InstancedBufferAttribute(new Float32Array(shadowCap * 4), 4);
  aDims.setUsage(THREE.DynamicDrawUsage);
  aMisc.setUsage(THREE.DynamicDrawUsage);
  quad.setAttribute('aDims', aDims);
  quad.setAttribute('aMisc', aMisc);
  const shadowMat = createShadowMaterial(U);
  const shadows = new THREE.InstancedMesh(quad, shadowMat, shadowCap);
  shadows.name = 'car-shadows';
  shadows.frustumCulled = false;
  shadows.count = 0;
  shadows.renderOrder = 1;
  shadows.instanceMatrix.setUsage(THREE.DynamicDrawUsage);

  // ── lamp glows ──
  const glowCap = cap * 4 + 8;
  const glowPos = new Float32Array(glowCap * 3);
  const glowAttr = new Float32Array(glowCap * 4);
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.BufferAttribute(glowPos, 3).setUsage(THREE.DynamicDrawUsage));
  glowGeo.setAttribute('aGlow', new THREE.BufferAttribute(glowAttr, 4).setUsage(THREE.DynamicDrawUsage));
  glowGeo.setDrawRange(0, 0);
  glowGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e9);
  const glowMat = createGlowMaterial(U);
  const glows = new THREE.Points(glowGeo, glowMat);
  glows.name = 'car-glows';
  glows.frustumCulled = false;
  glows.visible = false;

  const group = new THREE.Group();
  group.name = 'cars';
  group.add(batch, far, shadows, glows);
  scene.add(group);

  // ── state ──
  let graph: LaneGraph | null = null;
  let graphSrc: object | null = null;
  let sim: TrafficSim | null = null;
  let parking: ParkingField | null = null;
  let surfaceOf: Roads['surface'] | null = null;
  let connH: Float32Array | null = null;
  let tau = 0;
  let time = 0;
  let lights = 0;
  let frameNo = 0;
  const cam: SimCamera = { x: 0, z: 0, fx: 0, fz: -1 };
  const camPos = new THREE.Vector3();
  const pose: VehiclePose = TrafficSim.newPose();
  const tmpP: PathPoint = { x: 0, z: 0, hx: 0, hz: 1, piece: -1, s: 0, across: 0, conn: -1, frac: 0 };
  const m4 = new THREE.Matrix4();
  const sm4 = new THREE.Matrix4();
  const vX = new THREE.Vector3();
  const vY = new THREE.Vector3();
  const vZ = new THREE.Vector3();
  const tmpColor = new THREE.Color();
  const frustum = new THREE.Frustum();
  const projView = new THREE.Matrix4();
  const cullSphere = new THREE.Sphere();
  // per slot (moving body / trailer / parked): last matrix (half-rate frames), linear paint + finish, flags + road kind
  const mcache = new Float32Array(maxInst * 16);
  const pcol = new Float32Array(maxInst * 4);
  const fcache = new Float32Array(maxInst * 2);
  // parked
  let parkX = Infinity;
  let parkZ = Infinity;
  let parkCursor = 0;
  let lodPass = false;
  let lodX = Infinity;
  let lodZ = Infinity;
  let lodY = Infinity;
  let parkDirty = true;
  const parkInst = new Map<number, number>();
  const parkFree: number[] = [];
  for (let k = cfg.maxParked - 1; k >= 0; k--) parkFree.push(PARK0 + k);
  const parkCar: (ParkedCar | null)[] = new Array(cfg.maxParked).fill(null);
  const parkPending: number[] = [];
  /** Per parked slot: y, pitch slope, state (0 placed, 1 waiting, 2 provisional height), near (1). */
  const parkY = new Float32Array(cfg.maxParked * 4);
  const lastSun = new THREE.Vector3();
  // counts
  let nShadow = 0;
  let nParkShadow = 0;
  let nFar = 0;
  let nParkFar = 0;
  let nGlowW = 0;
  let nDrawn = 0;
  let nNear = 0;
  let parkedShown = 0;
  let parkedNear = 0;
  // this frame's sun (shadows)
  let shadowD2 = 0;
  let sunX = 0;
  let sunZ = 1;
  let castLen = 1;

  // ── heights ──
  const pieceHeight = (piece: number, s: number, across: number, x: number, z: number): number => {
    const g = graph!;
    const h = surfaceOf ? surfaceOf.height(piece, s, across, g.pWidth[piece] / 2) : NaN;
    if (h === h) return h;
    return opts.heightAt(x, z) + pavedLift(KIND_NAMES[g.pKind[piece]]);
  };
  const connEnd = (c: number, end: number): number => {
    const k = c * 2 + end;
    const v = connH![k];
    if (v === v) return v;
    const g = graph!;
    const cc = g.connectors[c];
    const lane = end === 0 ? cc.inLane : cc.outLane;
    const u = end === 0 ? cc.inU : cc.outU;
    g.lanePoint(lane, u, tmpP);
    const piece = lane >> 1;
    const h = surfaceOf ? surfaceOf.height(piece, g.laneS(lane, u), g.laneAcross[lane], g.pWidth[piece] / 2) : NaN;
    if (h === h) {
      connH![k] = h;
      return h;
    }
    return opts.heightAt(tmpP.x, tmpP.z) + pavedLift(KIND_NAMES[g.pKind[piece]]);
  };
  /** Road surface height at a path point (as rendered, without the shader's LOD lift). */
  const heightOf = (p: PathPoint): number => {
    if (p.piece >= 0) return pieceHeight(p.piece, p.s, p.across, p.x, p.z);
    const h0 = connEnd(p.conn, 0);
    const h1 = connEnd(p.conn, 1);
    return h0 + (h1 - h0) * p.frac;
  };
  const liftKindOf = (p: PathPoint): number => {
    if (p.piece >= 0) return graph!.pKind[p.piece];
    const c = graph!.connectors[p.conn];
    return LIFT_BY_KIND[c.kindIn] >= LIFT_BY_KIND[c.kindOut] ? c.kindIn : c.kindOut;
  };
  /** +1 on a lane that travels with increasing s (across is right of travel), −1 otherwise. */
  const laneSign = (p: PathPoint): number => {
    const g = graph!;
    const k = g.segmentAt(p.piece, p.s);
    return g.pnz[k] * p.hx - g.pnx[k] * p.hz >= 0 ? 1 : -1;
  };
  /** −1 left, +1 right, 0 none: the indicator for the turn the vehicle is about to make (or making). */
  const turnSignal = (i: number): number => {
    const s = sim!;
    const g = graph!;
    let c = s.conn[i];
    if (c < 0) {
      const k = s.next[i];
      if (k < 0 || g.connectors[k].inU - s.u[i] > 45) return 0;
      c = k;
    }
    const t = g.connectors[c].turn;
    return t === 2 ? -1 : t;
  };

  // ── instance writers ──
  const setPaint = (slot: number, paint: number) => {
    tmpColor.setHex(paintRGB(paint));
    pcol[slot * 4] = tmpColor.r;
    pcol[slot * 4 + 1] = tmpColor.g;
    pcol[slot * 4 + 2] = tmpColor.b;
    pcol[slot * 4 + 3] = paintFinish(paint);
  };
  /** Near instance data (paint from pcol, odometer, steering, flags, road kind). */
  const writeData = (slot: number, odo: number, steer: number, flags: number, kind: number) => {
    const o = slot * 8;
    data[o] = pcol[slot * 4];
    data[o + 1] = pcol[slot * 4 + 1];
    data[o + 2] = pcol[slot * 4 + 2];
    data[o + 3] = pcol[slot * 4 + 3];
    data[o + 4] = odo;
    data[o + 5] = steer;
    data[o + 6] = flags;
    data[o + 7] = kind;
  };
  const show = (slot: number, geo: number) => {
    if (instGeo[slot] !== geo) {
      batch.setGeometryIdAt(slot, geo);
      instGeo[slot] = geo;
    }
    if (!instVis[slot]) {
      batch.setVisibleAt(slot, true);
      instVis[slot] = 1;
    }
  };
  const hide = (slot: number) => {
    if (instVis[slot]) {
      batch.setVisibleAt(slot, false);
      instVis[slot] = 0;
    }
  };
  /** Appends a far instance of model m, placed by m4, with slot's paint. */
  const addFar = (slot: number, m: number, kind: number) => {
    if (nFar >= maxInst) return;
    far.setMatrixAt(nFar, m4);
    const c = far.instanceColor!.array as Float32Array;
    c[nFar * 3] = pcol[slot * 4];
    c[nFar * 3 + 1] = pcol[slot * 4 + 1];
    c[nFar * 3 + 2] = pcol[slot * 4 + 2];
    const a = aInst.array as Float32Array;
    a[nFar * 4] = m;
    a[nFar * 4 + 1] = kind;
    a[nFar * 4 + 2] = pcol[slot * 4 + 3];
    a[nFar * 4 + 3] = 0;
    nFar++;
  };
  /** m4 = the model basis from a forward vector (with slope) and the road's cross slope to the right. */
  const compose = (x: number, y: number, z: number, fx: number, fy: number, fz: number, bank: number) => {
    vZ.set(-fx, -fy, -fz).normalize();
    vX.set(-fz, 0, fx).normalize();
    vX.y = bank;
    vX.normalize();
    vY.crossVectors(vZ, vX).normalize();
    vX.crossVectors(vY, vZ).normalize();
    m4.makeBasis(vX, vY, vZ);
    m4.elements[12] = x;
    m4.elements[13] = y;
    m4.elements[14] = z;
  };
  const addShadow = (x: number, y: number, z: number, hx: number, hz: number, hl: number, hw: number, kind: number, len: number) => {
    if (nShadow >= shadowCap) return;
    // the sun's offset in the car frame (x right, z back)
    const ox = (sunX * -hz + sunZ * hx) * len;
    const oz = -(sunX * hx + sunZ * hz) * len;
    const e = sm4.elements;
    e[0] = -hz;
    e[1] = 0;
    e[2] = hx;
    e[4] = 0;
    e[5] = 1;
    e[6] = 0;
    e[8] = -hx;
    e[9] = 0;
    e[10] = -hz;
    e[12] = x;
    e[13] = y;
    e[14] = z;
    shadows.setMatrixAt(nShadow, sm4);
    const o = nShadow * 4;
    const D = aDims.array as Float32Array;
    const M = aMisc.array as Float32Array;
    D[o] = hl;
    D[o + 1] = hw;
    D[o + 2] = ox;
    D[o + 3] = oz;
    M[o] = 0.9;
    M[o + 1] = kind;
    M[o + 2] = 2 * hw + Math.abs(ox) + 1.4;
    M[o + 3] = 2 * hl + Math.abs(oz) + 1.4;
    nShadow++;
  };
  const addGlow = (x: number, y: number, z: number, dx: number, dz: number, tail: boolean, intensity: number) => {
    if (nGlowW >= glowCap) return;
    glowPos[nGlowW * 3] = x;
    glowPos[nGlowW * 3 + 1] = y;
    glowPos[nGlowW * 3 + 2] = z;
    glowAttr[nGlowW * 4] = dx;
    glowAttr[nGlowW * 4 + 1] = dz;
    glowAttr[nGlowW * 4 + 2] = tail ? 1 : 0;
    glowAttr[nGlowW * 4 + 3] = intensity;
    nGlowW++;
  };
  const anchors = Array.from({ length: MODEL_COUNT }, (_, m) => lampAnchors(m));
  const lampP = [0, 0, 0];
  /** Model → world with the current m4 (x mirrored by side), into lampP. */
  const lampWorld = (a: readonly number[], side: number) => {
    const e = m4.elements;
    const lx = a[0] * side;
    lampP[0] = e[0] * lx + e[4] * a[1] + e[8] * a[2] + e[12];
    lampP[1] = e[1] * lx + e[5] * a[1] + e[9] * a[2] + e[13];
    lampP[2] = e[2] * lx + e[6] * a[1] + e[10] * a[2] + e[14];
  };
  /** Shadow and lamp glows of model m placed by m4 (origin on the ground midway between the axles; −Z column = back). */
  const extras = (m: number, flags: number, kind: number, d2: number, glowsToo: boolean) => {
    const e = m4.elements;
    let hx = -e[8];
    let hz = -e[10];
    const hl0 = Math.hypot(hx, hz) || 1;
    hx /= hl0;
    hz /= hl0;
    if (d2 < shadowD2) {
      if (m === MODEL_TRAILER) addShadow(e[12] - hx * TRAILER_BACK, e[13], e[14] - hz * TRAILER_BACK, hx, hz, TRAILER_HALF, SEMI.trailerWidth / 2, kind, castLen * 2.4);
      else {
        const sp = SPECS[m];
        const hl = m === VT.semi ? 3.15 : sp.length / 2;
        const off = sp.frontOverhang + sp.wheelbase / 2 - hl;
        addShadow(e[12] + hx * off, e[13], e[14] + hz * off, hx, hz, hl, sp.width / 2, kind, castLen * sp.height * 0.6);
      }
    }
    if (glowsToo && lights > 0.01 && d2 < GLOW_D2) {
      const an = anchors[m];
      const brake = flags & FLAG_BRAKE ? 2 : 1;
      if (an.head) {
        lampWorld(an.head, -1);
        addGlow(lampP[0], lampP[1], lampP[2], hx, hz, false, lights);
        lampWorld(an.head, 1);
        addGlow(lampP[0], lampP[1], lampP[2], hx, hz, false, lights);
      }
      if (m !== VT.semi) {
        lampWorld(an.tail, -1);
        addGlow(lampP[0], lampP[1], lampP[2], -hx, -hz, true, lights * brake);
        lampWorld(an.tail, 1);
        addGlow(lampP[0], lampP[1], lampP[2], -hx, -hz, true, lights * brake);
      }
    }
  };
  /** Draws slot (body or trailer of a moving vehicle) with the matrix in m4: near → the batch, far → the far mesh. */
  const place = (slot: number, m: number, near: boolean, kind: number, odo: number, steer: number, flags: number) => {
    if (near) {
      batch.setMatrixAt(slot, m4);
      show(slot, geoId[m]);
      writeData(slot, odo, steer, flags, kind);
      nNear++;
    } else {
      hide(slot);
      addFar(slot, m, kind);
    }
    nDrawn++;
  };

  // ── parked cars ──
  const refreshParking = () => {
    if (!parking) return;
    parking.refresh(cam.x, cam.z, true);
    const keep = new Set<number>();
    for (let k = 0; k < parking.count; k++) keep.add(parking.cars[k].id);
    for (const [id, inst] of parkInst) {
      if (keep.has(id)) continue;
      hide(inst);
      parkCar[inst - PARK0] = null;
      parkInst.delete(id);
      parkFree.push(inst);
      parkDirty = true;
    }
    parkPending.length = 0;
    for (let k = 0; k < parking.count; k++) {
      const c = parking.cars[k];
      if (parkInst.has(c.id) || parkFree.length === 0) continue;
      const inst = parkFree.pop()!;
      parkInst.set(c.id, inst);
      parkCar[inst - PARK0] = c;
      parkY[(inst - PARK0) * 4 + 2] = 1;
      parkPending.push(inst);
    }
  };
  /** Places a parked car (heights at its axles), caches its matrix and paint. */
  const placeParked = (inst: number, nearD: number) => {
    const j = inst - PARK0;
    const c = parkCar[j];
    if (!c) return;
    const g = graph!;
    const sp = SPECS[c.type];
    const sgn = c.across > 0 ? 1 : -1; // +s is forward for the right-hand kerb
    const fx = c.x + (c.hx * sp.wheelbase) / 2;
    const fz = c.z + (c.hz * sp.wheelbase) / 2;
    const rx = c.x - (c.hx * sp.wheelbase) / 2;
    const rz = c.z - (c.hz * sp.wheelbase) / 2;
    // car parks stand on the terrain; kerbside cars on the road surface
    const park = c.piece < 0;
    const hF = park ? opts.heightAt(fx, fz) + 0.03 : pieceHeight(c.piece, c.s + sgn * (sp.wheelbase / 2), c.across, fx, fz);
    const hR = park ? opts.heightAt(rx, rz) + 0.03 : pieceHeight(c.piece, c.s - sgn * (sp.wheelbase / 2), c.across, rx, rz);
    const surf = park ? 0 : surfaceOf ? surfaceOf.height(c.piece, c.s, c.across, g.pWidth[c.piece] / 2) : NaN;
    const o = j * 4;
    parkY[o] = (hF + hR) / 2;
    parkY[o + 1] = (hF - hR) / sp.wheelbase;
    parkY[o + 2] = surf === surf ? 0 : 2;
    setPaint(inst, c.paint);
    compose(c.x, parkY[o], c.z, c.hx, parkY[o + 1], c.hz, 0);
    mcache.set(m4.elements, inst * 16);
    writeData(inst, 0, 0, 0, KIND.street);
    const d = Math.hypot(c.x - cam.x, c.z - cam.z, camPos.y - parkY[o]);
    parkY[o + 3] = d < nearD * PARKED_NEAR ? 1 : 0;
    if (parkY[o + 3]) {
      batch.setMatrixAt(inst, m4);
      show(inst, geoId[c.type]);
    } else hide(inst);
    parkDirty = true;
  };
  /** Rebuilds the static parked sections of the far mesh and of the shadows. */
  const rebuildParked = () => {
    nFar = 0;
    nShadow = 0;
    parkedShown = 0;
    parkedNear = 0;
    for (let j = 0; j < cfg.maxParked; j++) {
      const c = parkCar[j];
      if (!c || parkY[j * 4 + 2] === 1) continue;
      const inst = PARK0 + j;
      parkedShown++;
      m4.fromArray(mcache, inst * 16);
      if (parkY[j * 4 + 3]) parkedNear++;
      else addFar(inst, c.type, KIND.street);
      extras(c.type, 0, KIND.street, 0, false);
    }
    nParkFar = nFar;
    nParkShadow = nShadow;
  };

  const uploadRange = (attrs: THREE.BufferAttribute[], full: boolean, from: number, to: number) => {
    for (const at of attrs) {
      at.clearUpdateRanges();
      const w = at.itemSize;
      if (full) at.addUpdateRange(0, Math.max(1, to) * w);
      else if (to > from) at.addUpdateRange(from * w, (to - from) * w);
      else continue;
      at.needsUpdate = true;
    }
  };
  const farAttrs = [far.instanceMatrix, far.instanceColor!, aInst] as THREE.BufferAttribute[];
  const shadowAttrs = [shadows.instanceMatrix, aDims, aMisc] as THREE.BufferAttribute[];

  const cars: Cars = {
    get sim() {
      return sim;
    },
    get graph() {
      return graph;
    },
    group,
    update(camera, dt, paused, sunDir) {
      const roads = getRoads();
      surfaceOf = roads?.surface ?? null;
      // build the lane graph (time-sliced) once the roads' lane data is known
      const lanes = roads?.lanes ?? null;
      if (lanes && graphSrc !== lanes) {
        graphSrc = lanes;
        graph = new LaneGraph(lanes, cfg, true);
        sim = null;
        parking = null;
      }
      if (graph && !graph.complete && !graph.buildStep(4)) return;
      if (!graph) return;
      if (!sim) {
        sim = new TrafficSim(graph, { cfg });
        const lcw = newLandcover();
        parking = new ParkingField(graph, cfg, cfg.seed, {
          heightAt: opts.heightAt,
          obstacleTop: opts.obstacleTop,
          towns: opts.towns ?? getLayout().towns,
          urban: opts.urban ?? ((x, z) => getLandcover().at(x, z, lcw).urban),
        });
        connH = new Float32Array(graph.connectors.length * 2).fill(NaN);
        parkX = Infinity;
      }
      camera.updateMatrixWorld();
      camPos.setFromMatrixPosition(camera.matrixWorld);
      const e = camera.matrixWorld.elements;
      const fl = Math.hypot(e[8], e[10]);
      cam.x = camPos.x;
      cam.z = camPos.z;
      cam.fx = fl > 1e-6 ? -e[8] / fl : 0;
      cam.fz = fl > 1e-6 ? -e[10] / fl : 0;
      if (!paused) {
        tau = sim.advance(dt, cam);
        time += dt;
      }
      // lamps on as the sun gets low; indicators blink at 1.5 Hz
      const elev = (Math.asin(Math.max(-1, Math.min(1, sunDir.y))) * 180) / Math.PI;
      const tl = Math.max(0, Math.min(1, (cfg.lightsOnDeg - elev) / (cfg.lightsOnDeg - cfg.lightsFullDeg)));
      lights = tl * tl * (3 - 2 * tl);
      U.uLights.value = lights;
      U.uBlink.value = Math.floor(time * 3) % 2;
      U.uSunDir.value.copy(sunDir);
      const vh = typeof innerHeight === 'number' && innerHeight > 0 ? innerHeight * Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) : 900;
      U.uPx.value = vh / (2 * Math.tan((camera.fov * Math.PI) / 360));
      // shadows sweep away from the sun, longer as it gets low (capped)
      const sh = Math.hypot(sunDir.x, sunDir.z) || 1;
      sunX = -sunDir.x / sh;
      sunZ = -sunDir.z / sh;
      castLen = Math.min(2.6, 1 / Math.tan(Math.asin(Math.min(1, Math.max(0.12, sunDir.y)))));
      shadowD2 = cfg.shadowDistance * cfg.shadowDistance;
      const nearD = cfg.nearDistance;
      const farD2 = cfg.farDistance * cfg.farDistance;
      const g = graph;
      nGlowW = 0;

      // ── parked (static) ──
      if (parking && (Math.hypot(cam.x - parkX, cam.z - parkZ) > 80 || parking.work(1.5))) {
        parkX = cam.x;
        parkZ = cam.z;
        refreshParking();
      }
      for (let k = 0; k < 250 && parkPending.length > 0; k++) placeParked(parkPending.pop()!, nearD);
      if (lodPass || Math.hypot(cam.x - lodX, cam.z - lodZ, camPos.y - lodY) > 12) {
        if (!lodPass) {
          lodPass = true;
          lodX = cam.x;
          lodZ = cam.z;
          lodY = camPos.y;
          parkCursor = 0;
        }
        for (let k = 0; k < 350 && parkCursor < cfg.maxParked; k++, parkCursor++) {
          const j = parkCursor;
          const inst = PARK0 + j;
          const c = parkCar[j];
          if (!c || parkY[j * 4 + 2] === 1) continue;
          if (parkY[j * 4 + 2] === 2 && surfaceOf && c.piece >= 0) {
            const h = surfaceOf.height(c.piece, c.s, c.across, g.pWidth[c.piece] / 2);
            if (h === h) {
              placeParked(inst, nearD);
              continue;
            }
          }
          const d = Math.hypot(c.x - cam.x, c.z - cam.z, camPos.y - parkY[j * 4]);
          const wasNear = parkY[j * 4 + 3] === 1;
          const near = d < nearD * PARKED_NEAR * (wasNear ? 1.05 : 0.95);
          if (near === wasNear) continue;
          parkY[j * 4 + 3] = near ? 1 : 0;
          if (near) {
            m4.fromArray(mcache, inst * 16);
            batch.setMatrixAt(inst, m4);
            show(inst, geoId[c.type]);
          } else hide(inst);
          parkDirty = true;
        }
        if (parkCursor >= cfg.maxParked) lodPass = false;
      }
      let fullUpload = false;
      if (parkDirty || sunDir.dot(lastSun) < 0.99999) {
        lastSun.copy(sunDir);
        parkDirty = false;
        fullUpload = true;
        rebuildParked();
      }
      nFar = nParkFar;
      nShadow = nParkShadow;
      nNear = parkedNear;
      nDrawn = parkedShown;

      // ── moving vehicles ──
      frameNo++;
      projView.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      frustum.setFromProjectionMatrix(projView, camera.coordinateSystem, camera.reversedDepth);
      for (let i = 0; i < cap; i++) {
        const ti = TRAILER0 + i;
        if (!sim.alive[i]) {
          hide(i);
          hide(ti);
          continue;
        }
        const dx0 = sim.cx[i] - cam.x;
        const dz0 = sim.cz[i] - cam.z;
        const d2 = dx0 * dx0 + dz0 * dz0;
        const type = sim.type[i];
        if (d2 > farD2) {
          hide(i);
          hide(ti);
          continue;
        }
        const semi = type === VT.semi;
        const serial = sim.serial[i];
        const fresh = instSerial[i] !== serial;
        // out of view: nothing to draw (its last matrix gives the height; a generous sphere keeps shadows at the edges)
        if (!fresh) {
          cullSphere.center.set(sim.cx[i], mcache[i * 16 + 13], sim.cz[i]);
          cullSphere.radius = semi ? 24 : 12;
          if (!frustum.intersectsSphere(cullSphere)) {
            hide(i);
            hide(ti);
            continue;
          }
        }
        if (fresh) {
          setPaint(i, sim.paint[i]);
          if (semi) setPaint(ti, sim.paint2[i]);
        }
        // far vehicles move on alternate frames (a fraction of a pixel at that range)
        if (!fresh && d2 > HALF_RATE_D2 && ((frameNo + i) & 1) === 1) {
          const flags = fcache[i * 2];
          const kind = fcache[i * 2 + 1];
          m4.fromArray(mcache, i * 16);
          place(i, type, false, kind, 0, 0, flags);
          extras(type, flags, kind, d2, true);
          if (semi) {
            m4.fromArray(mcache, ti * 16);
            place(ti, MODEL_TRAILER, false, kind, 0, 0, flags);
            extras(MODEL_TRAILER, flags, kind, d2, true);
          } else hide(ti);
          continue;
        }
        instSerial[i] = serial;
        const v = sim.v[i];
        sim.pose(i, v * tau, pose);
        const hF = heightOf(pose.front);
        const hR = heightOf(pose.rear);
        const y = (hF + hR) / 2;
        const dist = Math.sqrt(d2 + (camPos.y - y) ** 2);
        const near = dist < nearD * (instVis[i] ? 1.05 : 0.95);
        // roll with the road's cross slope (+ across is right of increasing s: flip on backward lanes)
        let bank = 0;
        if (near && pose.front.piece >= 0 && surfaceOf) {
          const p = pose.front;
          const hw = g.pWidth[p.piece] / 2;
          const a = surfaceOf.height(p.piece, p.s, p.across + 0.8, hw);
          const b = surfaceOf.height(p.piece, p.s, p.across - 0.8, hw);
          if (a === a && b === b) bank = ((a - b) / 1.6) * laneSign(p);
        }
        let flags = 0;
        if (lights > 0.01) flags |= FLAG_HEAD;
        if (sim.acc[i] < -0.9 || v < 0.3) flags |= FLAG_BRAKE;
        const turn = turnSignal(i);
        if (turn < 0) flags |= FLAG_IND_L;
        else if (turn > 0) flags |= FLAG_IND_R;
        const kind = liftKindOf(pose.front);
        fcache[i * 2] = flags;
        fcache[i * 2 + 1] = kind;
        const odo = (sim.odo[i] + v * tau) % 2000;
        compose(pose.x, y, pose.z, pose.fx - pose.rx, hF - hR, pose.fz - pose.rz, bank);
        mcache.set(m4.elements, i * 16);
        place(i, type, near, kind, odo, pose.steer, flags);
        extras(type, flags, kind, d2, true);
        // a semi's trailer pivots at the kingpin; its axle follows the path
        if (semi) {
          const hA = heightOf(pose.axle);
          const hK = hR + 0.02;
          compose((pose.kx + pose.ax) / 2, (hK + hA) / 2, (pose.kz + pose.az) / 2, pose.kx - pose.ax, hK - hA, pose.kz - pose.az, 0);
          mcache.set(m4.elements, ti * 16);
          place(ti, MODEL_TRAILER, near, kind, odo, 0, flags);
          extras(MODEL_TRAILER, flags, kind, d2, true);
        } else hide(ti);
      }
      far.count = nFar;
      shadows.count = nShadow;
      uploadRange(farAttrs, fullUpload, nParkFar, nFar);
      uploadRange(shadowAttrs, fullUpload, nParkShadow, nShadow);
      glowGeo.setDrawRange(0, nGlowW);
      (glowGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (glowGeo.getAttribute('aGlow') as THREE.BufferAttribute).needsUpdate = true;
      glows.visible = nGlowW > 0 && lights > 0.01;
      dataTex.needsUpdate = true;
    },
    reset() {
      sim?.reset();
      parkX = Infinity;
    },
    stats() {
      const drawCalls = (nNear > 0 ? 1 : 0) + (nFar > 0 ? 1 : 0) + (nShadow > 0 ? 1 : 0) + (glows.visible ? 1 : 0);
      // where the nearest tractor is (QA photos)
      let tractorX = NaN;
      let tractorZ = NaN;
      if (sim) {
        let best = Infinity;
        for (let i = 0; i < sim.cap; i++) {
          if (!sim.alive[i] || sim.type[i] !== VT.tractor) continue;
          const d = Math.hypot(sim.cx[i] - cam.x, sim.cz[i] - cam.z);
          if (d < best) {
            best = d;
            tractorX = Math.round(sim.cx[i]);
            tractorZ = Math.round(sim.cz[i]);
          }
        }
      }
      return {
        tractorX,
        tractorZ,
        ready: !!sim,
        moving: sim?.count ?? 0,
        parked: parking?.count ?? 0,
        drawn: nDrawn,
        near: nNear,
        far: nFar,
        shadows: nShadow,
        glows: glows.visible ? nGlowW : 0,
        drawCalls,
        ...(sim ? sim.stats() : {}),
      };
    },
    dispose() {
      scene.remove(group);
      batch.dispose();
      for (const g of geos) g.dispose();
      material.dispose();
      dataTex.dispose();
      farGeo.dispose();
      farMat.dispose();
      far.dispose();
      quad.dispose();
      shadowMat.dispose();
      shadows.dispose();
      glowGeo.dispose();
      glowMat.dispose();
    },
  };
  return cars;
}
