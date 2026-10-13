/**
 * The big-ship port and the aids to navigation, drawn in THREE draw calls:
 *
 *  1. One BatchedMesh (the traffic batch material: per-vertex PBR, lit windows at dusk) holding the
 *     cruise terminal, the naval pier, the Gull Island lighthouse (two LODs each) and every buoy (one
 *     geometry per IALA kind, instanced). Buoys near the camera ride the drawn sea — heave, pitch and
 *     roll from the same Gerstner trains as the water shader (traffic/buoyancy.ts) — far ones sit
 *     still on a lighter LOD, very far ones are hidden (their lights still show).
 *  2. One point list (the traffic point material: HDR lamps with a glare that grows with brightness)
 *     for every light: the buoys and the harbour lights flashing their characters, the lighthouse's
 *     lantern (its brightness toward the camera from the rotating optic: a flash when a beam sweeps
 *     past, seen from 20+ km), pier lamps and floodlights.
 *  3. One additive mesh: the lighthouse's two beams, soft cones sweeping round at night.
 *
 * Built as a time-sliced job (`build(budgetMs)`), nothing allocated per frame.
 */
import * as THREE from 'three';
import { CONFIG, type Config } from '../../config';
import { getLayout, type WorldLayout } from '../layout';
import { getSeaSpectrum, type WaveSpectrum } from '../water/waves';
import { getHeightfield } from '../heightfield';
import { createBatchMaterial, createLightingUniforms, createPointMaterial, type LightingUniforms } from '../traffic/materials';
import { hullWaveMotion, newWaveMotion, shoalFactor, waveWeights } from '../traffic/buoyancy';
import { PointBuffer, poseMatrix } from '../traffic/points';
import { slicedJob, type Job, type SlicedJob } from '../traffic/jobs';
import { portWorks, pierWorld, pierYaw, type PortWorks } from './layout';
import { buildCruiseTerminal, buildNavalPier } from './models';
import { buildBuoy, buildLighthouse, BUOY_KINDS } from './navaidModels';
import { navaids, lightOn, lighthouseIntensity, lighthouseBeamAzimuth, BUOY_DIMS, type Navaids, type LightColor, type BuoyKind } from './navaids';

/** The water shader's Gerstner displacement range (the same as traffic/ships.ts). */
const DISP_RANGE = 1500;
/** Buoys: ride the waves within, lighter LOD beyond, hidden beyond (m). */
export const BUOY_RANGES = { waves: 1400, lod: 900, view: 9000 } as const;
/** The beams: length (m) and half-angle (deg) of each cone. */
export const BEAM = { length: 2600, halfAngleDeg: 1.8 } as const;
/** Lamp brightness (HDR radiance × night): buoys, harbour lights, the lighthouse lantern, pier lamps. */
export const LAMP = { buoy: 2600, harbour: 2200, lighthouse: 1.6e5, pier: 420, flood: 700 } as const;

export interface PortRendererOptions {
  config?: Config;
  layout?: WorldLayout;
  works?: PortWorks;
  navaids?: Navaids;
  spectrum?: WaveSpectrum;
  shared?: LightingUniforms;
}

export interface PortFrame {
  camX: number;
  camY: number;
  camZ: number;
  /** The sea's wave clock (s): buoys bob and lights flash with it. */
  waveTime: number;
  /** 0 day … 1 night. */
  night: number;
  viewportHeight: number;
}

export interface PortRendererStats {
  ready: boolean;
  buildSteps: number;
  maxBuildStepMs: number;
  instances: number;
  buoysShown: number;
  buoysBobbing: number;
  lights: number;
  beam: boolean;
  drawCalls: number;
}

export interface PortRenderer {
  readonly group: THREE.Group;
  readonly shared: LightingUniforms;
  readonly ready: boolean;
  build(budgetMs: number): boolean;
  update(f: PortFrame): void;
  stats(): PortRendererStats;
  /** The lighthouse beams' mesh (tests / QA). */
  readonly beam: THREE.Mesh;
  dispose(): void;
}

const COLOR: Record<LightColor, [number, number, number]> = { R: [1, 0.06, 0.03], G: [0.1, 1, 0.35], W: [1, 0.92, 0.78], Y: [1, 0.75, 0.1] };
const WARM: [number, number, number] = [1, 0.72, 0.42];
const DEG = Math.PI / 180;

/** Fog uniforms shared with the global aerial perspective (as traffic/materials.ts does). */
function fogUniforms(): Record<string, THREE.IUniform> {
  const u: Record<string, THREE.IUniform> = THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
  const lib = THREE.UniformsLib.fog as Record<string, THREE.IUniform>;
  if (lib.atmoFog) u.atmoFog = { value: lib.atmoFog.value };
  if (lib.atmoCloudShadow) u.atmoCloudShadow = { value: lib.atmoCloudShadow.value };
  return u;
}

/** Two open cones from the lantern, the second trailing the first by `trailDeg`; `aAlong` = 0 at the apex … 1 at the end. */
export function beamGeometry(trailDeg: number, length = BEAM.length, halfAngleDeg = BEAM.halfAngleDeg): THREE.BufferGeometry {
  const P: number[] = [];
  const N: number[] = [];
  const A: number[] = [];
  const I: number[] = [];
  const along = [0, 0.005, 0.015, 0.04, 0.08, 0.15, 0.25, 0.4, 0.6, 0.8, 1];
  const seg = 16;
  const t = Math.tan(halfAngleDeg * DEG);
  for (const az of [0, -trailDeg]) {
    const base = P.length / 3;
    const ca = Math.cos(az * DEG);
    const sa = Math.sin(az * DEG);
    for (const a of along) {
      const s = a * length;
      const r = Math.max(0.4, s * t);
      for (let j = 0; j <= seg; j++) {
        const th = (j / seg) * Math.PI * 2;
        // cone along −z (north) in the beam frame: (x, y) round it
        const lx = r * Math.cos(th);
        const ly = r * Math.sin(th);
        const lz = -s;
        // rotate by the azimuth (clockwise from north seen from above): (x, z) → (x cos − z sin … )
        const x = lx * ca - lz * sa;
        const z = lx * sa + lz * ca;
        P.push(x, ly, z);
        const nx = Math.cos(th);
        const ny = Math.sin(th);
        const nz = t;
        const nl = Math.hypot(nx, ny, nz);
        N.push((nx * ca - nz * sa) / nl, ny / nl, (nx * sa + nz * ca) / nl);
        A.push(a);
      }
    }
    for (let i = 0; i < along.length - 1; i++)
      for (let j = 0; j < seg; j++) {
        const k0 = base + i * (seg + 1) + j;
        const k1 = k0 + seg + 1;
        I.push(k0, k1, k0 + 1, k0 + 1, k1, k1 + 1);
      }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
  g.setAttribute('aAlong', new THREE.Float32BufferAttribute(A, 1));
  g.setIndex(I);
  g.computeBoundingSphere();
  return g;
}

/** The beams' material: additive, brightest where you look through the most of a cone, fading along it. */
export function createBeamMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    name: 'port.beam',
    uniforms: { uIntensity: { value: 0 }, uColor: { value: new THREE.Color(1, 0.93, 0.8) }, uLength: { value: BEAM.length }, ...fogUniforms() },
    vertexShader: /* glsl */ `
      attribute float aAlong;
      varying float vAlong;
      varying vec3 vN;
      varying vec3 vV;
      varying float vDist;
      #include <fog_pars_vertex>
      void main() {
        vAlong = aAlong;
        vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
        vN = normalize( normalMatrix * normal );
        vV = normalize( -mvPosition.xyz );
        vDist = length( mvPosition.xyz );
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform float uIntensity;
      uniform vec3 uColor;
      uniform float uLength;
      varying float vAlong;
      varying vec3 vN;
      varying vec3 vV;
      varying float vDist;
      #include <fog_pars_fragment>
      void main() {
        float s = vAlong * uLength;
        float fall = exp( -s / 650.0 ) * smoothstep( 0.0, 30.0, s ) * ( 1.0 - smoothstep( 0.7, 1.0, vAlong ) );
        // a shaft of lit haze: it only builds up with some air between it and the eye
        fall *= smoothstep( 60.0, 900.0, vDist );
        // path length through a soft cone ~ how squarely we look through its wall
        float face = pow( abs( dot( normalize( vN ), normalize( vV ) ) ), 1.6 );
        vec3 T = vec3( 1.0 );
        #ifdef USE_FOG
          if ( atmoFog[ 0 ].w > 0.5 ) atmoFogScatter( vFogWorldRel, cameraPosition.y, T );
        #endif
        gl_FragColor = vec4( uColor * ( uIntensity * fall * face ) * T, 0.0 );
      }`,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    blending: THREE.CustomBlending,
    blendEquation: THREE.AddEquation,
    blendSrc: THREE.OneFactor,
    blendDst: THREE.OneFactor,
    fog: true,
  });
}

interface BuoyInst {
  id: number;
  kind: BuoyKind;
  x: number;
  z: number;
  shoal: number;
  lod: number;
  shown: boolean;
  /** Lamp position (world), refreshed with the pose. */
  lx: number;
  ly: number;
  lz: number;
  /** Frames since the pose was last written (far buoys don't need every frame). */
  still: boolean;
}

export function createPortRenderer(opts: PortRendererOptions = {}): PortRenderer {
  const cfg = opts.config ?? CONFIG;
  const layout = opts.layout ?? getLayout();
  const works = opts.works ?? portWorks(layout, cfg);
  const nav = opts.navaids ?? navaids(layout, cfg);
  const spectrum = opts.spectrum ?? getSeaSpectrum(cfg);
  const shared = opts.shared ?? createLightingUniforms();
  const hf = getHeightfield();

  const group = new THREE.Group();
  group.name = 'port';
  const batchMat = createBatchMaterial(shared, { underwater: true, name: 'port.structures' });
  const pointMat = createPointMaterial(shared);
  const points = new PointBuffer(64 + nav.buoys.length + nav.harbourLights.length + works.cruise.lamps.length + works.naval.lamps.length + 16);
  const pointsObj = new THREE.Points(points.geometry, pointMat);
  pointsObj.name = 'port.lights';
  pointsObj.frustumCulled = false;
  pointsObj.renderOrder = -1;
  const beamMat = createBeamMaterial();
  const beam = new THREE.Mesh(beamGeometry(nav.lighthouse.beams[1] - nav.lighthouse.beams[0]), beamMat);
  beam.name = 'port.beam';
  beam.position.set(nav.lighthouse.x, nav.lighthouse.focalY, nav.lighthouse.z);
  beam.frustumCulled = false;
  beam.renderOrder = 1;
  beam.visible = false;

  let batch: THREE.BatchedMesh | null = null;
  const statics: { id: number; pair: [number, number]; x: number; z: number; lodDist: number; viewDist: number; lod: number; shown: boolean }[] = [];
  const buoys: BuoyInst[] = [];
  const buoyGeo = new Map<BuoyKind, [number, number]>();
  const lamps: { x: number; y: number; z: number; k: number }[] = [];
  const weights = new Float64Array(16);
  const wm = newWaveMotion();
  const m4 = new THREE.Matrix4();
  const v3 = new THREE.Vector3();
  let buoysShown = 0;
  let buoysBobbing = 0;

  function* buildJob(): Job<void> {
    const parts: [string, (lod: number) => THREE.BufferGeometry][] = [
      ['cruise', (lod) => buildCruiseTerminal(works.cruise, lod).build()],
      ['naval', (lod) => buildNavalPier(works.naval, lod).build()],
      ['lighthouse', (lod) => buildLighthouse(nav.lighthouse, lod).build()],
      ...BUOY_KINDS.map((k) => [`buoy:${k}`, (lod: number) => buildBuoy(k, lod).build()] as [string, (lod: number) => THREE.BufferGeometry]),
    ];
    const built: [string, THREE.BufferGeometry, THREE.BufferGeometry][] = [];
    for (const [key, fn] of parts) {
      const g0 = fn(0);
      yield;
      const g1 = fn(1);
      built.push([key, g0, g1]);
      yield;
    }
    let nv = 0;
    let ni = 0;
    for (const [, g0, g1] of built) {
      nv += g0.getAttribute('position').count + g1.getAttribute('position').count;
      ni += g0.index!.count + g1.index!.count;
    }
    batch = new THREE.BatchedMesh(3 + nav.buoys.length, nv, ni, batchMat);
    batch.name = 'port.structures';
    batch.frustumCulled = false;
    batch.perObjectFrustumCulled = true;
    batch.sortObjects = false;
    batch.castShadow = false;
    batch.receiveShadow = false;
    const geo = new Map<string, [number, number]>();
    for (const [key, g0, g1] of built) {
      geo.set(key, [batch.addGeometry(g0), batch.addGeometry(g1)]);
      g0.dispose();
      g1.dispose();
    }
    yield;
    const c4 = new THREE.Vector4();
    const addStatic = (key: string, x: number, y: number, z: number, yaw: number, lodDist: number, viewDist: number, lit: number) => {
      const pair = geo.get(key)!;
      const id = batch!.addInstance(pair[0]);
      batch!.setMatrixAt(id, m4.makeRotationY(yaw).setPosition(x, y, z));
      // instance colour alpha = the share of lit windows at night
      batch!.setColorAt(id, c4.set(1, 1, 1, lit));
      statics.push({ id, pair, x, z, lodDist, viewDist, lod: 0, shown: true });
    };
    const cMid = pierWorld(works.cruise.frame, works.cruise.pier.u0, 0);
    const nMid = pierWorld(works.naval.frame, works.naval.head.u0, 0);
    addStatic('cruise', works.cruise.frame.ox, 0, works.cruise.frame.oz, pierYaw(works.cruise.frame), 1500, 30000, 0.85);
    statics[statics.length - 1].x = cMid.x;
    statics[statics.length - 1].z = cMid.z;
    addStatic('naval', works.naval.frame.ox, 0, works.naval.frame.oz, pierYaw(works.naval.frame), 1500, 30000, 0.6);
    statics[statics.length - 1].x = nMid.x;
    statics[statics.length - 1].z = nMid.z;
    const lh = nav.lighthouse;
    addStatic('lighthouse', lh.x, lh.groundY, lh.z, 0, 1200, 40000, 0.5);
    for (const k of BUOY_KINDS) buoyGeo.set(k, geo.get(`buoy:${k}`)!);
    for (const b of nav.buoys) {
      const pair = buoyGeo.get(b.kind)!;
      const id = batch.addInstance(pair[1]);
      batch.setMatrixAt(id, m4.makeTranslation(b.x, 0, b.z));
      batch.setColorAt(id, c4.set(1, 1, 1, 0));
      const wl = hf.waterLevel(b.x, b.z) ?? 0;
      buoys.push({ id, kind: b.kind, x: b.x, z: b.z, shoal: shoalFactor(wl - hf.height(b.x, b.z)), lod: 1, shown: true, lx: b.x, ly: BUOY_DIMS.lampY, lz: b.z, still: true });
    }
    // static lamps: pier lamps, floodlights along the berths
    for (const [w, k] of [[works.cruise, LAMP.pier], [works.naval, LAMP.pier]] as const) {
      for (const l of w.lamps) {
        const p = pierWorld(w.frame, l.u, l.w);
        lamps.push({ x: p.x, y: l.y + 0.1, z: p.z, k: l.y > w.deckY + 10 ? LAMP.flood : k });
      }
    }
    group.add(batch, pointsObj, beam);
  }

  const job: SlicedJob<void> = slicedJob(buildJob());

  const r: PortRenderer = {
    group,
    shared,
    beam,
    get ready() {
      return job.done;
    },
    build(budgetMs) {
      return job.step(budgetMs);
    },
    update(f) {
      if (!job.done || !batch) return;
      const cx = f.camX;
      const cz = f.camZ;
      shared.uTime.value = f.waveTime;
      shared.uNight.value = f.night;
      pointMat.uniforms.uHalfHeight.value = f.viewportHeight / 2;
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
          batch.setGeometryIdAt(s.id, s.pair[lod]);
        }
      }
      // buoys: bob on the drawn waves near the camera, sit still (lighter LOD) further out
      buoysShown = 0;
      buoysBobbing = 0;
      for (const b of buoys) {
        const d = Math.hypot(b.x - cx, b.z - cz);
        const on = d < BUOY_RANGES.view;
        if (on !== b.shown) {
          b.shown = on;
          batch.setVisibleAt(b.id, on);
        }
        if (!on) continue;
        buoysShown++;
        const lod = d > BUOY_RANGES.lod ? 1 : 0;
        if (lod !== b.lod) {
          b.lod = lod;
          batch.setGeometryIdAt(b.id, buoyGeo.get(b.kind)![lod]);
        }
        if (d < BUOY_RANGES.waves && waveWeights(spectrum, d, DISP_RANGE, weights) > 0) {
          buoysBobbing++;
          hullWaveMotion(spectrum, weights, b.shoal, b.x, b.z, f.waveTime, 0, 2.2, 2.2, wm, 3);
          // a buoy on its mooring leans with the wave slope, a little more than the slope itself
          poseMatrix(m4, b.x, wm.heave, b.z, 0, wm.pitch * 1.3, wm.roll * 1.3);
          batch.setMatrixAt(b.id, m4);
          v3.set(0, BUOY_DIMS.lampY, 0).applyMatrix4(m4);
          b.lx = v3.x;
          b.ly = v3.y;
          b.lz = v3.z;
          b.still = false;
        } else if (!b.still) {
          batch.setMatrixAt(b.id, m4.makeTranslation(b.x, 0, b.z));
          b.lx = b.x;
          b.ly = BUOY_DIMS.lampY;
          b.lz = b.z;
          b.still = true;
        }
      }
      // lights
      points.reset();
      const night = f.night;
      const t = f.waveTime;
      if (night > 0.02) {
        for (let i = 0; i < nav.buoys.length; i++) {
          const nb = nav.buoys[i];
          const b = buoys[i];
          if (Math.abs(b.x - cx) > 14000 || Math.abs(b.z - cz) > 14000) continue;
          if (!lightOn(nb.character, t, nb.phase)) continue;
          const c = COLOR[nb.character.color];
          const k = LAMP.buoy * night;
          points.push(b.lx, b.ly, b.lz, c[0] * k, c[1] * k, c[2] * k, 0, 0.35, 2.2, 0);
        }
        for (const h of nav.harbourLights) {
          if (!lightOn(h.character, t, h.phase)) continue;
          const c = COLOR[h.character.color];
          const k = LAMP.harbour * night;
          points.push(h.x, h.y, h.z, c[0] * k, c[1] * k, c[2] * k, 0, 1.1, 2.4, 0);
        }
        for (const l of lamps) {
          if (Math.abs(l.x - cx) > 12000 || Math.abs(l.z - cz) > 12000) continue;
          const k = l.k * night;
          points.push(l.x, l.y, l.z, WARM[0] * k, WARM[1] * k, WARM[2] * k, 0, 0.5, 2.2, 0);
        }
        // the lighthouse: its brightness toward the camera from the rotating optic
        const lh = nav.lighthouse;
        const brg = ((Math.atan2(cx - lh.x, -(cz - lh.z)) / DEG) % 360 + 360) % 360;
        const k = LAMP.lighthouse * night * lighthouseIntensity(lh, t, brg);
        const c = COLOR[lh.character.color];
        points.push(lh.x, lh.focalY, lh.z, c[0] * k, c[1] * k, c[2] * k, 0, 1.6, 3, 0);
      }
      points.commit();
      pointsObj.visible = points.count > 0;
      // the beams: swept round with the optic, only in the dark
      const bi = Math.max(0, (night - 0.15) / 0.85);
      beam.visible = bi > 0.01;
      if (beam.visible) {
        beam.rotation.y = -lighthouseBeamAzimuth(nav.lighthouse, t) * DEG;
        beamMat.uniforms.uIntensity.value = 0.4 * bi;
      }
    },
    stats() {
      return {
        ready: job.done,
        buildSteps: job.steps,
        maxBuildStepMs: Math.round(job.maxStepMs * 100) / 100,
        instances: batch ? batch.instanceCount : 0,
        buoysShown,
        buoysBobbing,
        lights: points.count,
        beam: beam.visible,
        drawCalls: (batch ? 1 : 0) + (pointsObj.visible && points.count > 0 ? 1 : 0) + (beam.visible ? 1 : 0),
      };
    },
    dispose() {
      batch?.dispose();
      points.dispose();
      beam.geometry.dispose();
      batchMat.dispose();
      pointMat.dispose();
      beamMat.dispose();
      group.removeFromParent();
      group.clear();
    },
  };
  return r;
}
