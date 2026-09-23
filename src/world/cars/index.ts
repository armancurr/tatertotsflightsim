/**
 * Road traffic renderer: moving vehicles (sim.ts on the lane graph of the
 * active roads), parked cars (parking.ts), contact shadows and dusk lamp
 * glows — three draw calls in all:
 *
 *  1. one BatchedMesh for every vehicle body, trailer and parked car (10
 *     models × 2 levels of detail, per-instance paint/odometer/steering/lights
 *     in a data texture; material.ts),
 *  2. one InstancedMesh of contact shadows,
 *  3. one Points layer of lamp glows (only while the lamps are on).
 *
 * The lane graph is built time-sliced (~4 ms per frame) once the roads' lane
 * data arrives from their worker. Vehicles sit on the exact rendered road
 * surface (`RoadSurface.height`, the terrain + road lift where a chunk is not
 * built yet), pitched between their axles and rolled with the road's camber;
 * the shader applies the same LOD lift + depth pull as the road.
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
import { SPECS, SEMI, VT, MODEL_COUNT, MODEL_TRAILER, TRAILER_WHEELBASE as TRAILER_WB } from './specs';
import { buildVehicleGeometry, lampAnchors } from './vehicles';
import { createCarMaterial, createCarUniforms, createShadowMaterial, createGlowMaterial, FLAG_HEAD, FLAG_BRAKE, FLAG_IND_L, FLAG_IND_R } from './material';
import { paintFinish, paintRGB } from './paint';

export { LaneGraph } from './lanes';
export { TrafficSim } from './sim';
export { ParkingField, parkedSlots } from './parking';
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
const LIFT_BY_KIND = lodLiftArray();

export function createCars(scene: THREE.Scene, opts: CarsOptions): Cars {
  const cfg = opts.cfg ?? CONFIG.world.cars;
  const getRoads = opts.roads ?? activeRoads;
  const cap = cfg.maxMoving;
  const maxInst = cap * 2 + cfg.maxParked;
  const TRAILER0 = cap;
  const PARK0 = cap * 2;

  // ── geometry ──
  const geos: THREE.BufferGeometry[][] = [];
  let verts = 0;
  let idx = 0;
  for (let m = 0; m < MODEL_COUNT; m++) {
    const pair = [buildVehicleGeometry(m, 0), buildVehicleGeometry(m, 1)];
    for (const g of pair) {
      verts += g.getAttribute('position').count;
      idx += g.index!.count;
    }
    geos.push(pair);
  }
  const texH = Math.ceil((maxInst * 2) / TEX_W);
  const data = new Float32Array(TEX_W * texH * 4);
  const dataTex = new THREE.DataTexture(data, TEX_W, texH, THREE.RGBAFormat, THREE.FloatType);
  dataTex.needsUpdate = true;
  const U = createCarUniforms(dataTex);
  const material = createCarMaterial(U);
  const batch = new THREE.BatchedMesh(maxInst, verts, idx, material);
  batch.name = 'cars';
  batch.sortObjects = false;
  batch.perObjectFrustumCulled = true;
  batch.frustumCulled = false;
  batch.castShadow = false;
  batch.receiveShadow = true;
  const geoId: number[][] = geos.map((pair) => pair.map((g) => batch.addGeometry(g)));
  for (let k = 0; k < maxInst; k++) {
    batch.addInstance(geoId[0][1]);
    batch.setVisibleAt(k, false);
  }
  const instGeo = new Int32Array(maxInst).fill(geoId[0][1]);
  const instVis = new Uint8Array(maxInst);
  const instSerial = new Float64Array(maxInst).fill(-1);

  // contact shadows
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

  // lamp glows
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
  group.add(batch, shadows, glows);
  scene.add(group);

  // ── state ──
  let graph: LaneGraph | null = null;
  let graphSrc: object | null = null;
  let sim: TrafficSim | null = null;
  let parking: ParkingField | null = null;
  let surfaceOf: Roads['surface'] | null = null;
  let tau = 0;
  let time = 0;
  let lights = 0;
  let parkX = Infinity;
  let parkZ = Infinity;
  let parkCursor = 0;
  let lodPass = false;
  let lodX = Infinity;
  let lodZ = Infinity;
  let lodY = Infinity;
  let parkShadowDirty = true;
  let nParkShadow = 0;
  let parkedShown = 0;
  const lastSun = new THREE.Vector3();
  const parkInst = new Map<number, number>();
  const parkFree: number[] = [];
  for (let k = cfg.maxParked - 1; k >= 0; k--) parkFree.push(PARK0 + k);
  const parkCar: (ParkedCar | null)[] = new Array(cfg.maxParked).fill(null);
  const parkPending: number[] = [];
  const parkY = new Float32Array(cfg.maxParked * 3); // y, pitch, provisional
  let connH: Float32Array | null = null;
  const cam: SimCamera = { x: 0, z: 0, fx: 0, fz: -1 };
  const pose: VehiclePose = TrafficSim.newPose();
  const tmpP: PathPoint = { x: 0, z: 0, hx: 0, hz: 1, piece: -1, s: 0, across: 0, conn: -1, frac: 0 };
  const m4 = new THREE.Matrix4();
  const sm4 = new THREE.Matrix4();
  const vX = new THREE.Vector3();
  const vY = new THREE.Vector3();
  const vZ = new THREE.Vector3();
  const camPos = new THREE.Vector3();
  let nDrawn = 0;
  let nNear = 0;
  let nGlow = 0;

  /** Road surface height at a path point (as rendered, without the shader's LOD lift). */
  const heightOf = (p: PathPoint): number => {
    const g = graph!;
    if (p.piece >= 0) return pieceHeight(p.piece, p.s, p.across, p.x, p.z);
    const c = g.connectors[p.conn];
    const h0 = connEnd(c.id, 0);
    const h1 = connEnd(c.id, 1);
    return h0 + (h1 - h0) * p.frac;
  };
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
    const s = g.laneS(lane, u);
    const h = surfaceOf ? surfaceOf.height(piece, s, g.laneAcross[lane], g.pWidth[piece] / 2) : NaN;
    if (h === h) {
      connH![k] = h;
      return h;
    }
    return opts.heightAt(tmpP.x, tmpP.z) + pavedLift(KIND_NAMES[g.pKind[piece]]);
  };
  const liftKindOf = (p: PathPoint): number => {
    const g = graph!;
    if (p.piece >= 0) return g.pKind[p.piece];
    const c = g.connectors[p.conn];
    return LIFT_BY_KIND[c.kindIn] >= LIFT_BY_KIND[c.kindOut] ? c.kindIn : c.kindOut;
  };

  const writeData = (inst: number, paint: number, odo: number, steer: number, flags: number, kind: number) => {
    const o = inst * 8;
    data[o + 4] = odo;
    data[o + 5] = steer;
    data[o + 6] = flags;
    data[o + 7] = kind;
    if (paint >= 0) {
      tmpColor.setHex(paintRGB(paint));
      data[o] = tmpColor.r;
      data[o + 1] = tmpColor.g;
      data[o + 2] = tmpColor.b;
      data[o + 3] = paintFinish(paint);
    }
  };
  const tmpColor = new THREE.Color();

  const show = (inst: number, geo: number) => {
    if (instGeo[inst] !== geo) {
      batch.setGeometryIdAt(inst, geo);
      instGeo[inst] = geo;
    }
    if (!instVis[inst]) {
      batch.setVisibleAt(inst, true);
      instVis[inst] = 1;
    }
  };
  const hide = (inst: number) => {
    if (instVis[inst]) {
      batch.setVisibleAt(inst, false);
      instVis[inst] = 0;
    }
  };

  /** Basis from a forward vector (with slope) and a right-side cross slope; writes m4. */
  const compose = (x: number, y: number, z: number, fx: number, fy: number, fz: number, bank: number) => {
    vZ.set(-fx, -fy, -fz).normalize();
    // right = heading rotated, tilted by the road's cross slope
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

  let nShadow = 0;
  const addShadow = (x: number, y: number, z: number, hx: number, hz: number, hl: number, hw: number, strength: number, kind: number, sunX: number, sunZ: number, len: number) => {
    if (nShadow >= shadowCap) return;
    // sun offset in the car frame (x right, z back)
    const rx = -hz;
    const rz = hx;
    const ox = (sunX * rx + sunZ * rz) * len;
    const oz = -(sunX * hx + sunZ * hz) * len;
    // rotation about Y taking the model −Z to (hx, hz): columns X = (−hz, 0, hx), Z = (−hx, 0, −hz)
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
    M[o] = strength;
    M[o + 1] = kind;
    M[o + 2] = 2 * hw + Math.abs(ox) + 1.4;
    M[o + 3] = 2 * hl + Math.abs(oz) + 1.4;
    nShadow++;
  };

  /** Shadow and lamp glows of a model placed by m4 (matrix of the model origin; −Z column = back). */
  const lampP = [0, 0, 0];
  const extras = (m: number, flags: number, kind: number, d2: number, _fresh: boolean) => {
    const e = m4.elements;
    let hx = -e[8];
    let hz = -e[10];
    const hl0 = Math.hypot(hx, hz) || 1;
    hx /= hl0;
    hz /= hl0;
    if (d2 < shadowD2Cur) {
      if (m === MODEL_TRAILER) {
        const tHalf = (SEMI.trailerRear - SEMI.trailerFront) / 2;
        // model origin = midway kingpin–axle; the box centre lies back from it
        const back = tHalf - (SEMI.kingpin - SEMI.trailerFront) - TRAILER_WB / 2;
        addShadow(e[12] - hx * back, e[13], e[14] - hz * back, hx, hz, tHalf, SEMI.trailerWidth / 2, 0.9, kind, sunXCur, sunZCur, castLenCur * 2.4);
      } else {
        const sp = SPECS[m];
        if (m === VT.semi) {
          const off = sp.frontOverhang + sp.wheelbase / 2 - 3.15;
          addShadow(e[12] + hx * off, e[13], e[14] + hz * off, hx, hz, 3.15, sp.width / 2, 0.9, kind, sunXCur, sunZCur, castLenCur * sp.height * 0.6);
        } else {
          const off = sp.frontOverhang - sp.length / 2 + sp.wheelbase / 2;
          addShadow(e[12] + hx * off, e[13], e[14] + hz * off, hx, hz, sp.length / 2, sp.width / 2, 0.9, kind, sunXCur, sunZCur, castLenCur * sp.height * 0.6);
        }
      }
    }
    if (lights > 0.01 && d2 < GLOW_D2) {
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
  let shadowD2Cur = 0;
  let sunXCur = 0;
  let sunZCur = 1;
  let castLenCur = 1;
  let frameNo = 0;

  let nGlowW = 0;
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
  /** Model → world with the current m4 (x mirrored by side), into lampP. */
  const lampWorld = (a: readonly number[], side: number) => {
    const e = m4.elements;
    const lx = a[0] * side;
    lampP[0] = e[0] * lx + e[4] * a[1] + e[8] * a[2] + e[12];
    lampP[1] = e[1] * lx + e[5] * a[1] + e[9] * a[2] + e[13];
    lampP[2] = e[2] * lx + e[6] * a[1] + e[10] * a[2] + e[14];
  };

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
      parkShadowDirty = true;
    }
    parkPending.length = 0;
    for (let k = 0; k < parking.count; k++) {
      const c = parking.cars[k];
      if (parkInst.has(c.id) || parkFree.length === 0) continue;
      const inst = parkFree.pop()!;
      parkInst.set(c.id, inst);
      parkCar[inst - PARK0] = c;
      parkY[(inst - PARK0) * 3 + 2] = 1; // needs placing
      parkPending.push(inst);
    }
  };

  /** Places a parked car on the road (heights at its axles) and shows it. */
  const placeParked = (inst: number, nearD: number) => {
    const c = parkCar[inst - PARK0];
    if (!c) return;
    const g = graph!;
    const sp = SPECS[c.type];
    const sgn = c.across > 0 ? 1 : -1; // +s is forward for the right-hand kerb
    const sF = c.s + sgn * (sp.wheelbase / 2);
    const sR = c.s - sgn * (sp.wheelbase / 2);
    const fx = c.x + (c.hx * sp.wheelbase) / 2;
    const fz = c.z + (c.hz * sp.wheelbase) / 2;
    const rx = c.x - (c.hx * sp.wheelbase) / 2;
    const rz = c.z - (c.hz * sp.wheelbase) / 2;
    // car parks stand on the terrain; kerbside cars on the road surface
    const park = c.piece < 0;
    const hF = park ? opts.heightAt(fx, fz) + 0.03 : pieceHeight(c.piece, sF, c.across, fx, fz);
    const hR = park ? opts.heightAt(rx, rz) + 0.03 : pieceHeight(c.piece, sR, c.across, rx, rz);
    const surf = park ? 0 : surfaceOf ? surfaceOf.height(c.piece, c.s, c.across, g.pWidth[c.piece] / 2) : NaN;
    const o = (inst - PARK0) * 3;
    parkY[o] = (hF + hR) / 2;
    parkY[o + 1] = (hF - hR) / sp.wheelbase;
    parkY[o + 2] = surf === surf ? 0 : 2; // 2 = provisional (terrain), re-placed later
    writeData(inst, c.paint, 0, 0, 0, KIND.street);
    compose(c.x, parkY[o], c.z, c.hx, parkY[o + 1], c.hz, 0);
    batch.setMatrixAt(inst, m4);
    const d = Math.hypot(c.x - cam.x, c.z - cam.z, camPos.y - parkY[o]);
    show(inst, geoId[c.type][d < nearD ? 0 : 1]);
    parkShadowDirty = true;
  };

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
      if (graph && !graph.complete) {
        if (!graph.buildStep(4)) return;
      }
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
      // lamps: on as the sun gets low
      const elev = (Math.asin(Math.max(-1, Math.min(1, sunDir.y))) * 180) / Math.PI;
      const t = Math.max(0, Math.min(1, (cfg.lightsOnDeg - elev) / (cfg.lightsOnDeg - cfg.lightsFullDeg)));
      lights = t * t * (3 - 2 * t);
      U.uLights.value = lights;
      U.uBlink.value = Math.floor(time * 1.5 * 2) % 2;
      U.uSunDir.value.copy(sunDir);
      const vh = typeof innerHeight === 'number' && innerHeight > 0 ? innerHeight * Math.min(2, typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) : 900;
      U.uPx.value = vh / (2 * Math.tan((camera.fov * Math.PI) / 360));
      // shadow sweep: away from the sun, longer as it gets low (capped)
      const sElev = Math.max(0.12, sunDir.y);
      const sh = Math.hypot(sunDir.x, sunDir.z) || 1;
      const sunX = -sunDir.x / sh;
      const sunZ = -sunDir.z / sh;
      const castLen = Math.min(2.6, 1 / Math.tan(Math.asin(Math.min(1, sElev))));
      sunXCur = sunX;
      sunZCur = sunZ;
      castLenCur = castLen;

      nGlowW = 0;
      nDrawn = 0;
      nNear = 0;
      const nearD = cfg.nearDistance;
      // ── parked cars (static: placed once, LOD re-checked as the camera moves, shadows rebuilt on change) ──
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
        const parkN = cfg.maxParked;
        for (let k = 0; k < 350 && parkCursor < parkN; k++, parkCursor++) {
          const j = parkCursor;
          const inst = PARK0 + j;
          const c = parkCar[j];
          if (!c || parkY[j * 3 + 2] === 1) continue;
          if (parkY[j * 3 + 2] === 2 && surfaceOf && c.piece >= 0) {
            const h = surfaceOf.height(c.piece, c.s, c.across, graph.pWidth[c.piece] / 2);
            if (h === h) {
              placeParked(inst, nearD);
              continue;
            }
          }
          const d = Math.hypot(c.x - cam.x, c.z - cam.z, camPos.y - parkY[j * 3]);
          show(inst, geoId[c.type][d < nearD * (instGeo[inst] === geoId[c.type][0] ? 1.05 : 0.95) ? 0 : 1]);
        }
        if (parkCursor >= parkN) lodPass = false;
      }
      const sunMoved = sunDir.dot(lastSun) < 0.99999;
      let fullShadowUpload = false;
      if (parkShadowDirty || sunMoved) {
        lastSun.copy(sunDir);
        parkShadowDirty = false;
        fullShadowUpload = true;
        nShadow = 0;
        parkedShown = 0;
        for (let j = 0; j < cfg.maxParked; j++) {
          const c = parkCar[j];
          if (!c || parkY[j * 3 + 2] === 1) continue;
          parkedShown++;
          const sp = SPECS[c.type];
          const off = sp.frontOverhang - sp.length / 2 + sp.wheelbase / 2;
          addShadow(c.x + c.hx * off, parkY[j * 3], c.z + c.hz * off, c.hx, c.hz, sp.length / 2, sp.width / 2, 0.9, KIND.street, sunX, sunZ, castLen * sp.height * 0.6);
        }
        nParkShadow = nShadow;
      }
      nShadow = nParkShadow;
      const farD2 = cfg.farDistance * cfg.farDistance;
      shadowD2Cur = cfg.shadowDistance * cfg.shadowDistance;
      const g = graph;
      // ── moving vehicles ──
      frameNo++;
      for (let i = 0; i < cap; i++) {
        if (!sim.alive[i]) {
          hide(i);
          hide(TRAILER0 + i);
          continue;
        }
        const dx0 = sim.cx[i] - cam.x;
        const dz0 = sim.cz[i] - cam.z;
        const d2 = dx0 * dx0 + dz0 * dz0;
        const type = sim.type[i];
        if (d2 > farD2) {
          hide(i);
          hide(TRAILER0 + i);
          continue;
        }
        const semi = type === VT.semi;
        // far vehicles move on alternate frames (a fraction of a pixel at that range)
        if (d2 > HALF_RATE_D2 && instVis[i] && instSerial[i] === sim.serial[i] && ((frameNo + i) & 1) === 1) {
          const flags = data[i * 8 + 6];
          const kind = data[i * 8 + 7];
          batch.getMatrixAt(i, m4);
          extras(type, flags, kind, d2, false);
          nDrawn++;
          if (semi) {
            batch.getMatrixAt(TRAILER0 + i, m4);
            extras(MODEL_TRAILER, flags, kind, d2, false);
            nDrawn++;
          }
          continue;
        }
        const v = sim.v[i];
        sim.pose(i, v * tau, pose);
        const hF = heightOf(pose.front);
        const hR = heightOf(pose.rear);
        const y = (hF + hR) / 2;
        const dist = Math.sqrt(d2 + (camPos.y - y) ** 2);
        const near = dist < nearD * (instGeo[i] === geoId[type][0] ? 1.05 : 0.95);
        // roll with the road's cross slope (+ across is right of increasing s: flip on backward lanes)
        let bank = 0;
        if (near && pose.front.piece >= 0 && surfaceOf) {
          const p = pose.front;
          const hw = g.pWidth[p.piece] / 2;
          const a = surfaceOf.height(p.piece, p.s, p.across + 0.8, hw);
          const b = surfaceOf.height(p.piece, p.s, p.across - 0.8, hw);
          if (a === a && b === b) bank = ((a - b) / 1.6) * laneSign(p);
        }
        compose(pose.x, y, pose.z, pose.fx - pose.rx, hF - hR, pose.fz - pose.rz, bank);
        batch.setMatrixAt(i, m4);
        show(i, geoId[type][near ? 0 : 1]);
        nDrawn++;
        if (near) nNear++;
        // instance data
        let flags = 0;
        if (lights > 0.01) flags |= FLAG_HEAD;
        if (sim.acc[i] < -0.9 || v < 0.3) flags |= FLAG_BRAKE;
        const turn = turnSignal(i);
        if (turn < 0) flags |= FLAG_IND_L;
        else if (turn > 0) flags |= FLAG_IND_R;
        const kind = liftKindOf(pose.front);
        const serial = sim.serial[i];
        const odo = (sim.odo[i] + v * tau) % 2000;
        writeData(i, instSerial[i] !== serial ? sim.paint[i] : -1, odo, pose.steer, flags, kind);
        instSerial[i] = serial;
        extras(type, flags, kind, d2, true);
        // semi trailer: pivots at the kingpin, its axle follows the path
        if (semi) {
          const ti = TRAILER0 + i;
          const hA = heightOf(pose.axle);
          const hK = hR + 0.02;
          compose((pose.kx + pose.ax) / 2, (hK + hA) / 2, (pose.kz + pose.az) / 2, pose.kx - pose.ax, hK - hA, pose.kz - pose.az, 0);
          batch.setMatrixAt(ti, m4);
          show(ti, geoId[MODEL_TRAILER][near ? 0 : 1]);
          writeData(ti, instSerial[ti] !== serial ? sim.paint2[i] : -1, odo, 0, flags, kind);
          instSerial[ti] = serial;
          nDrawn++;
          extras(MODEL_TRAILER, flags, kind, d2, true);
        } else hide(TRAILER0 + i);
      }
      nDrawn += parkedShown;
      shadows.count = nShadow;
      for (const at of [shadows.instanceMatrix, aDims, aMisc] as THREE.BufferAttribute[]) {
        at.clearUpdateRanges();
        const w = at.itemSize;
        if (fullShadowUpload) at.addUpdateRange(0, nShadow * w);
        else if (nShadow > nParkShadow) at.addUpdateRange(nParkShadow * w, (nShadow - nParkShadow) * w);
        at.needsUpdate = true;
      }
      glowGeo.setDrawRange(0, nGlowW);
      (glowGeo.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      (glowGeo.getAttribute('aGlow') as THREE.BufferAttribute).needsUpdate = true;
      glows.visible = nGlowW > 0 && lights > 0.01;
      nGlow = nGlowW;
      dataTex.needsUpdate = true;
    },
    reset() {
      sim?.reset();
      parkX = Infinity;
    },
    stats() {
      const drawCalls = (nDrawn > 0 ? 1 : 0) + (nShadow > 0 ? 1 : 0) + (glows.visible ? 1 : 0);
      return {
        ready: !!sim,
        moving: sim?.count ?? 0,
        parked: parking?.count ?? 0,
        drawn: nDrawn,
        near: nNear,
        shadows: nShadow,
        glows: nGlow,
        drawCalls,
        ...(sim ? sim.stats() : {}),
      };
    },
    dispose() {
      scene.remove(group);
      batch.dispose();
      for (const pair of geos) for (const g of pair) g.dispose();
      material.dispose();
      dataTex.dispose();
      quad.dispose();
      shadowMat.dispose();
      shadows.dispose();
      glowGeo.dispose();
      glowMat.dispose();
    },
  };

  /** +1 if the path point is on a forward lane (across measured right of travel), −1 on a backward one. */
  const laneSign = (p: PathPoint): number => {
    // forward lanes carry positive across except for shifted street lanes; compare the travel direction with the piece normal
    const g = graph!;
    const k = g.segmentAt(p.piece, p.s);
    // tangent of increasing s = (nz, −nx)
    const tx = g.pnz[k];
    const tz = -g.pnx[k];
    return tx * p.hx + tz * p.hz >= 0 ? 1 : -1;
  };

  /** −1 left, +1 right, 0 none: the indicator for the turn the vehicle is about to make (or making). */
  const turnSignal = (i: number): number => {
    const s = sim!;
    const g = graph!;
    let c = s.conn[i];
    if (c < 0) {
      const k = s.next[i];
      if (k < 0) return 0;
      if (g.connectors[k].inU - s.u[i] > 45) return 0;
      c = k;
    }
    const t = g.connectors[c].turn;
    return t === 2 ? -1 : t;
  };

  return cars;
}

const KIND_NAMES = ['highway', 'road', 'access', 'lane', 'street', 'drive'] as const;
