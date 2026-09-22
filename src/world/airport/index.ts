/**
 * The airport renderer: builds every airport mesh from the tested data layer
 * (plan, markings, lights, obstacles) and animates what moves (PAPI colours
 * from the camera's glide angle, the MALSR rabbit, the rotating beacon, the
 * windsock, lamp brightness with the sun).
 *
 *   createAirport(scene, env, { heightAt }) → { update, dispose, papiState, obstacleTop, stats }
 *
 * Draw calls (≈12): pavement, shoulders, markings, structures (tower, hangars,
 * terminal, fuel, fixtures, fence posts), fence fabric, windsock, signs,
 * parked aircraft ×2 types, cars ×2 types, lights (one Points).
 */
import * as THREE from 'three';
import { createAirportPlan, type AirportPlan } from './plan';
import { AIRPORT_HEIGHTS, buildMarkings, buildPavement, buildShoulders, type HeightFn } from './ground';
import { buildFenceFabric, buildStructures, FENCE } from './structures';
import {
  airportLights,
  beaconFlash,
  COLORS,
  lightLevel,
  PAPI_ANGLES,
  papiUnitWhiteness,
  rabbitIndex,
  viewAngleDeg,
  type LightDef,
  type RGB,
} from './lights';
import { airportObstacles, createObstacleSource, type ObstacleFn } from './obstacles';
import {
  createAirportUniforms,
  createBuildingMaterial,
  createFenceMaterial,
  createLightsMaterial,
  createMarkingMaterial,
  createParkedAircraftMaterial,
  createPavementMaterial,
  createShoulderMaterial,
  createVehicleMaterial,
  createWindsockMaterial,
  type ApronDetail,
} from './materials';
import { toRunwayCoords } from '../runway';
import { aircraftGlsl, buildAircraftGeometry, type AircraftType } from './aircraft';
import { buildCarGeometry, CAR_PAINTS, type CarKind } from './vehicles';
import { buildWindsockGeometry, windsockWind, WINDSOCK_MAST } from './windsock';
import { buildSigns } from './signs';

export { AIRPORT_HEIGHTS } from './ground';

export interface AirportEnv {
  registerObstacleSource(fn: (x: number, z: number) => number): void;
}
export interface AirportOptions {
  /** Terrain height (m MSL); default: flat at the field elevation. */
  heightAt?: HeightFn;
}
export interface PapiUnitState {
  x: number;
  y: number;
  z: number;
  /** Unit setting angle, deg. */
  angleDeg: number;
  /** Camera elevation angle seen from the unit, deg. */
  viewDeg: number;
  /** 0 = red … 1 = white. */
  whiteness: number;
  color: [number, number, number];
}
export interface PapiState {
  end: string;
  units: PapiUnitState[];
  /** Units showing white (whiteness ≥ ½). */
  white: number;
}
export interface Airport {
  readonly group: THREE.Group;
  readonly plan: AirportPlan;
  update(camera: THREE.Camera, time: number, sunElevationDeg: number): void;
  papiState(end: string): PapiState;
  obstacleTop(x: number, z: number): number;
  stats(): { drawCalls: number; triangles: number; lights: number; parked: number; cars: number; buildMs: number };
  dispose(): void;
}

/** Draw calls the scene graph under `root` issues in the main pass (visible renderables × material groups). */
export function countDrawCalls(root: THREE.Object3D): number {
  let n = 0;
  root.traverseVisible((o) => {
    const r = o as THREE.Mesh;
    if (!(r.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine)) return;
    if ((o as THREE.InstancedMesh).isInstancedMesh && (o as THREE.InstancedMesh).count === 0) return;
    const mat = r.material;
    n += Array.isArray(mat) ? Math.max(1, r.geometry.groups.length) : 1;
  });
  return n;
}

/** PAPI white: whiter than the edge lights so a white unit reads unmistakably white. */
const PAPI_WHITE: RGB = [1.0, 0.97, 0.9];

const LIVERY_ACCENTS = [0x1d3263, 0x9b1b1b, 0x5b1a22, 0xb58a2a, 0x1f5a3c, 0x2a5aa8, 0x202020, 0xc4561e];
const LIVERY_BASES = [0xf1f1ec, 0xf1f1ec, 0xefe6cf, 0xf1f1ec, 0xdfe2e4];

interface ParkedInstance {
  type: AircraftType;
  x: number;
  z: number;
  headingDeg: number;
  livery: number;
  shade: number;
}

/** Where the apron shader puts oil drips, tyre streaks and fuel stains. */
function apronDetail(plan: AirportPlan): ApronDetail {
  const rc = plan.layout.parkingSpots.map((p) => toRunwayCoords(p.x, p.z, plan.rw));
  const rows = [...new Set(rc.map((p) => Math.round(p.across * 10) / 10))].sort((a, b) => a - b);
  const alongs = [...new Set(rc.map((p) => Math.round(p.along * 10) / 10))].sort((a, b) => a - b);
  const step = alongs.length > 1 ? alongs[1] - alongs[0] : 24;
  const f = toRunwayCoords(plan.fuelPump.x, plan.fuelPump.z, plan.rw);
  return {
    park: [alongs[0] ?? 0, step, rows[0] ?? -1e4, rows[1] ?? rows[0] ?? -1e4],
    parkCount: alongs.length,
    lanes: plan.taxilanes.map((l) => l.c),
    fuel: [f.along, f.across],
  };
}

function instanceMatrix(m: THREE.Matrix4, x: number, y: number, z: number, headingDeg: number) {
  const r = (-headingDeg * Math.PI) / 180;
  m.makeRotationY(r).setPosition(x, y, z);
  return m;
}

export function createAirport(scene: THREE.Scene, env: AirportEnv | null, opts: AirportOptions = {}): Airport {
  const t0 = performance.now();
  const plan = createAirportPlan();
  const heightAt: HeightFn = opts.heightAt ?? (() => plan.elevation);
  const group = new THREE.Group();
  group.name = 'airport';
  const uniforms = createAirportUniforms();
  const disposables: { dispose(): void }[] = [];
  const own = <T extends { dispose(): void }>(x: T): T => {
    disposables.push(x);
    return x;
  };

  // ── ground ────────────────────────────────────────────────────────────────
  const pavement = new THREE.Mesh(own(buildPavement(plan, heightAt)), own(createPavementMaterial(plan.rw, apronDetail(plan))));
  pavement.name = 'pavement';
  pavement.receiveShadow = true;
  const shoulders = new THREE.Mesh(own(buildShoulders(plan, heightAt)), own(createShoulderMaterial(plan.rw)));
  shoulders.name = 'shoulders';
  shoulders.receiveShadow = true;
  shoulders.renderOrder = -2;
  const markings = new THREE.Mesh(own(buildMarkings(plan, heightAt)), own(createMarkingMaterial(plan.rw)));
  markings.name = 'markings';
  markings.receiveShadow = true;
  group.add(shoulders, pavement, markings);

  // ── structures + fence + windsock + signs ───────────────────────────────
  const lights = airportLights(plan, heightAt);
  const structures = new THREE.Mesh(own(buildStructures(plan, lights, heightAt)), own(createBuildingMaterial(uniforms)));
  structures.name = 'structures';
  structures.castShadow = true;
  structures.receiveShadow = true;
  const fence = new THREE.Mesh(own(buildFenceFabric(plan, heightAt)), own(createFenceMaterial(FENCE.height)));
  fence.name = 'fence';
  fence.renderOrder = -1;
  const sockMat = own(createWindsockMaterial(uniforms));
  const windsock = new THREE.Mesh(own(buildWindsockGeometry()), sockMat);
  windsock.name = 'windsock';
  windsock.position.set(plan.windsock.x, heightAt(plan.windsock.x, plan.windsock.z) + WINDSOCK_MAST.height - 0.12, plan.windsock.z);
  windsock.castShadow = true;
  const wind = windsockWind();
  uniforms.uWind.value.set(wind.x, wind.z, wind.strength);
  const signs = buildSigns(plan, heightAt);
  own(signs.geometry);
  own(signs.material);
  if (signs.texture) own(signs.texture);
  const signMesh = new THREE.Mesh(signs.geometry, signs.material);
  signMesh.name = 'signs';
  signMesh.castShadow = true;
  signMesh.receiveShadow = true;
  group.add(structures, fence, windsock, signMesh);

  // ── parked aircraft (incl. one inside each open hangar, dimmed) ─────────
  const parked: ParkedInstance[] = plan.parked.map((p, k) => ({
    type: k % 3 === 2 ? 'pa28' : 'c172',
    x: p.x,
    z: p.z,
    headingDeg: p.headingDeg,
    livery: p.livery,
    shade: 1,
  }));
  plan.hangars.forEach((h, i) => {
    if (h.doorOpen <= 0) return;
    const s = h.spot;
    const hr = (s.headingDeg * Math.PI) / 180;
    const back = s.depth / 2 - 4.2; // nose ~1.8 m inside the door line
    parked.push({ type: i % 2 ? 'pa28' : 'c172', x: s.center.x + Math.sin(hr) * back, z: s.center.z - Math.cos(hr) * back, headingDeg: s.headingDeg, livery: i + 1, shade: 0.3 });
  });
  const m4 = new THREE.Matrix4();
  const col = new THREE.Color();
  const aircraftMeshes: THREE.InstancedMesh[] = [];
  for (const type of ['c172', 'pa28'] as const) {
    const list = parked.filter((p) => p.type === type);
    if (!list.length) continue;
    const geo = own(buildAircraftGeometry(type));
    const livery = new Float32Array(list.length);
    const base = new Float32Array(list.length * 3);
    const shade = new Float32Array(list.length);
    const mesh = new THREE.InstancedMesh(geo, own(createParkedAircraftMaterial(`airport-parked-${type}`, aircraftGlsl(type))), list.length);
    list.forEach((p, i) => {
      const x = p.x, z = p.z;
      mesh.setMatrixAt(i, instanceMatrix(m4, x, heightAt(x, z) + AIRPORT_HEIGHTS.pavement, z, p.headingDeg));
      mesh.setColorAt(i, col.setHex(LIVERY_ACCENTS[(p.livery * 3 + i + (type === 'pa28' ? 1 : 0)) % LIVERY_ACCENTS.length]));
      livery[i] = (p.livery + i) % 5;
      col.setHex(LIVERY_BASES[(i + p.livery) % LIVERY_BASES.length]);
      base.set([col.r, col.g, col.b], i * 3);
      shade[i] = p.shade;
    });
    geo.setAttribute('aLivery', new THREE.InstancedBufferAttribute(livery, 1));
    geo.setAttribute('aBase', new THREE.InstancedBufferAttribute(base, 3));
    geo.setAttribute('aShade', new THREE.InstancedBufferAttribute(shade, 1));
    mesh.name = type === 'c172' ? 'parked-aircraft' : 'parked-aircraft-pa28';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    aircraftMeshes.push(mesh);
    group.add(mesh);
  }

  // ── cars ─────────────────────────────────────────────────────────────────
  const carMeshes: THREE.InstancedMesh[] = [];
  for (const kind of ['sedan', 'suv'] as CarKind[]) {
    const list = plan.cars.filter((_, i) => (i % 3 === 1 ? 'suv' : 'sedan') === kind);
    if (!list.length) continue;
    const mesh = new THREE.InstancedMesh(own(buildCarGeometry(kind)), own(createVehicleMaterial(`airport-cars-${kind}`)), list.length);
    list.forEach((c, i) => {
      mesh.setMatrixAt(i, instanceMatrix(m4, c.x, heightAt(c.x, c.z) + AIRPORT_HEIGHTS.pavement, c.z, c.headingDeg));
      mesh.setColorAt(i, col.setHex(CAR_PAINTS[c.color % CAR_PAINTS.length]));
    });
    mesh.name = kind === 'sedan' ? 'cars' : 'cars-suv';
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    carMeshes.push(mesh);
    group.add(mesh);
  }

  // ── lights: one Points draw call ─────────────────────────────────────────
  const n = lights.length;
  const lpos = new Float32Array(n * 3);
  const front = new Float32Array(n * 3);
  const backC = new Float32Array(n * 3);
  const facing = new Float32Array(n * 2);
  const params = new Float32Array(n * 4);
  lights.forEach((l, i) => {
    lpos.set([l.x, l.y, l.z], i * 3);
    front.set(l.front, i * 3);
    backC.set(l.back, i * 3);
    if (l.facingDeg !== null) {
      const h = (l.facingDeg * Math.PI) / 180;
      facing.set([Math.sin(h), -Math.cos(h)], i * 2);
    }
    params.set([l.size, l.intensity, l.day, l.seq], i * 4);
  });
  const lightGeo = own(new THREE.BufferGeometry());
  lightGeo.setAttribute('position', new THREE.BufferAttribute(lpos, 3));
  const frontAttr = new THREE.BufferAttribute(front, 3);
  frontAttr.setUsage(THREE.DynamicDrawUsage);
  lightGeo.setAttribute('aFront', frontAttr);
  lightGeo.setAttribute('aBack', new THREE.BufferAttribute(backC, 3));
  lightGeo.setAttribute('aFacing', new THREE.BufferAttribute(facing, 2));
  lightGeo.setAttribute('aParams', new THREE.BufferAttribute(params, 4));
  lightGeo.computeBoundingSphere();
  const lightMat = own(createLightsMaterial());
  const points = new THREE.Points(lightGeo, lightMat);
  points.name = 'airport-lights';
  points.frustumCulled = false;
  points.renderOrder = 10;
  const _size = new THREE.Vector2();
  points.onBeforeRender = (renderer, _scene, camera) => {
    const rt = renderer.getRenderTarget();
    renderer.getDrawingBufferSize(_size);
    const h = rt ? rt.height : _size.y;
    const cssH = renderer.domElement.clientHeight || h / renderer.getPixelRatio();
    const fov = (camera as THREE.PerspectiveCamera).fov ?? 60;
    lightMat.uniforms.uFocal.value = (0.5 * h) / Math.tan((fov * Math.PI) / 360);
    lightMat.uniforms.uPixelRatio.value = h / Math.max(1, cssH);
  };
  group.add(points);

  // PAPI and beacon bookkeeping (preallocated; update() never allocates)
  const papi = new Map<string, PapiState & { idx: number[] }>();
  lights.forEach((l, i) => {
    if (l.kind !== 'papi' || l.end === undefined || l.unit === undefined) return;
    let st = papi.get(l.end);
    if (!st) {
      st = { end: l.end, units: [], white: 0, idx: [] };
      papi.set(l.end, st);
    }
    st.units[l.unit] = { x: l.x, y: l.y, z: l.z, angleDeg: PAPI_ANGLES[l.unit], viewDeg: 0, whiteness: 0, color: [COLORS.red[0], COLORS.red[1], COLORS.red[2]] };
    st.idx[l.unit] = i;
  });
  const beaconIdx = lights.findIndex((l: LightDef) => l.kind === 'beacon');

  scene.add(group);

  // ── obstacles ────────────────────────────────────────────────────────────
  const obstacle: ObstacleFn = createObstacleSource(airportObstacles(plan, heightAt));
  env?.registerObstacleSource(obstacle);

  const _cam = new THREE.Vector3();
  const buildMs = performance.now() - t0;
  let triCount = -1;

  return {
    group,
    plan,
    update(camera, time, sunElevationDeg) {
      camera.getWorldPosition(_cam);
      const level = lightLevel(sunElevationDeg);
      const night = Math.max(0, Math.min(1, (level - 0.2) / 0.8));
      uniforms.uTime.value = time;
      uniforms.uNight.value = night;
      lightMat.uniforms.uNight.value = night;
      lightMat.uniforms.uRabbit.value = rabbitIndex(time);
      for (const st of papi.values()) {
        let white = 0;
        for (let u = 0; u < st.units.length; u++) {
          const unit = st.units[u];
          unit.viewDeg = viewAngleDeg(_cam.x, _cam.y, _cam.z, unit.x, unit.y, unit.z);
          const w = papiUnitWhiteness(unit.viewDeg, unit.angleDeg);
          unit.whiteness = w;
          for (let k = 0; k < 3; k++) {
            unit.color[k] = COLORS.red[k] + (PAPI_WHITE[k] - COLORS.red[k]) * w;
            front[st.idx[u] * 3 + k] = unit.color[k];
          }
          if (w >= 0.5) white++;
        }
        st.white = white;
      }
      if (beaconIdx >= 0) {
        const bl = lights[beaconIdx];
        const az = ((Math.atan2(_cam.x - bl.x, -(_cam.z - bl.z)) * 180) / Math.PI + 360) % 360;
        const f = beaconFlash(time, az);
        front[beaconIdx * 3] = f.white * 1.0 + f.green * 0.1;
        front[beaconIdx * 3 + 1] = f.white * 0.95 + f.green * 1.0;
        front[beaconIdx * 3 + 2] = f.white * 0.85 + f.green * 0.35;
      }
      frontAttr.needsUpdate = true;
    },
    papiState(end) {
      const st = papi.get(end);
      if (!st) throw new Error(`no PAPI for runway ${end}`);
      return st;
    },
    obstacleTop: (x, z) => obstacle(x, z),
    stats() {
      if (triCount < 0) {
        triCount = 0;
        group.traverse((o) => {
          const g = (o as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
          if (!g || (o as THREE.Points).isPoints) return;
          const tris = (g.index ? g.index.count : g.attributes.position.count) / 3;
          triCount += tris * ((o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1);
        });
      }
      return {
        drawCalls: countDrawCalls(group),
        triangles: triCount,
        lights: n,
        parked: parked.length,
        cars: plan.cars.length,
        buildMs,
      };
    },
    dispose() {
      scene.remove(group);
      obstacle.disable?.();
      for (const d of disposables) d.dispose();
      for (const m of [...aircraftMeshes, ...carMeshes]) m.dispose();
    },
  };
}
