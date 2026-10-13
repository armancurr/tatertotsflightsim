/**
 * Berthed ships: when the player isn't driving the cruise ship ('cruise') or the battleship ('iowa'),
 * that ship lies moored at its berth (src/world/harbour/berthedShips.ts says where and how high).
 *
 *  - Its real model (the fleet entry's `createModel()`) is created lazily the first time the camera
 *    comes within MODEL_RANGE, shown there, riding the drawn sea (a 260 m hull barely moves), lit at
 *    night (deck floodlights, the model's own lamps); beyond it a cheap impostor (the hull lofted from
 *    its station table and a superstructure block, one draw call) out to IMPOSTOR_RANGE.
 *  - It is a physics obstacle over its deck outline from the first frame (so a yacht can't sail through
 *    it), refined with the model's drawn superstructure once the model exists (rasterised from its
 *    triangles, time-sliced), and its clear deck is landable — the helicopter can set down on the
 *    battleship's fantail helipad. At the naval pier a brow joins it to the T-head.
 *  - When the player picks that ship it disappears (and stops being an obstacle): the player's vessel
 *    is then the ship, starting at the same berth.
 *
 * Fleet ids that aren't in the fleet are skipped; a model that fails to build falls back to the impostor.
 */
import * as THREE from 'three';
import { FLEET, type AircraftDef, type AircraftModelHandle } from '../../fleet';
import { createDefaultVisualState } from '../../aircraft/types';
import { createVesselState } from '../../physics';
import { buildHullShell } from '../../vessels/hullLoft';
import { berthedObstacles, berthedShipSpecs, deckLightPoints, shipToWorld, type BerthedShipSpec, type HeightGrid } from '../../world/harbour/berthedShips';
import { getSeaSpectrum } from '../../world/water/waves';
import { hullWaveMotion, newWaveMotion, waveWeights } from '../../world/traffic/buoyancy';
import { createLightingUniforms, createPointMaterial } from '../../world/traffic/materials';
import { PointBuffer } from '../../world/traffic/points';
import { nightFactor, sunElevationDeg, syncLighting } from '../../world/traffic/daylight';
import { slicedJob, type Job, type SlicedJob } from '../../world/traffic/jobs';
import type { SimSystem, SystemContext, SystemModule } from './types';

/** Real model within (m), impostor within (m). */
export const MODEL_RANGE = 7000;
export const IMPOSTOR_RANGE = 35000;
/** Raster cell of the drawn superstructure (m). */
const RASTER_CELL = 1;

const DEG = Math.PI / 180;

interface ShipView {
  spec: BerthedShipSpec;
  model: AircraftModelHandle | null;
  failed: boolean;
  impostor: THREE.Mesh;
  brow: THREE.Mesh | null;
  raster: SlicedJob<HeightGrid> | null;
  lights: { x: number; y: number; z: number; masthead: boolean }[];
  visual: ReturnType<typeof createDefaultVisualState>;
}

/** The impostor: the hull lofted from the stations and a block of superstructure. */
function impostorGeometry(s: BerthedShipSpec): THREE.BufferGeometry {
  const st = s.config.aircraft.watercraft!.hull.stations;
  const hull = buildHullShell(st, { maxStep: Math.max(1, s.size.lengthM / 60), bottomSegments: 2, sideSegments: 2, capStern: true, capBow: true, deck: { camber: 0.2, segments: 2 } });
  const L = s.size.lengthM;
  const cruise = s.berth === 'cruise';
  const h = cruise ? Math.max(12, s.size.freeboardM * 2.2) : Math.max(6, s.size.freeboardM * 1.4);
  const deckY = st.reduce((a, x) => Math.max(a, x.deckY), -Infinity);
  const box = new THREE.BoxGeometry(s.size.beamM * (cruise ? 0.92 : 0.45), h, L * (cruise ? 0.72 : 0.3));
  box.translate(0, deckY + h / 2 - 0.3, s.size.bowZ + L * (cruise ? 0.52 : 0.45));
  // keep only position + normal on both so they merge
  for (const g of [hull, box]) for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal') g.deleteAttribute(k);
  const merged = new THREE.BufferGeometry();
  const parts = [hull.toNonIndexed(), box.toNonIndexed()];
  const n = parts.reduce((a, g) => a + g.attributes.position.count, 0);
  const P = new Float32Array(n * 3);
  const N = new Float32Array(n * 3);
  let o = 0;
  for (const g of parts) {
    P.set(g.attributes.position.array as Float32Array, o * 3);
    N.set(g.attributes.normal.array as Float32Array, o * 3);
    o += g.attributes.position.count;
    g.dispose();
  }
  hull.dispose();
  box.dispose();
  merged.setAttribute('position', new THREE.BufferAttribute(P, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(N, 3));
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Rasterises a model's triangles (in its body frame) into a grid of tops (m MSL at the berth), a slice
 * at a time. Effects (points, lines, sprites, faint transparent discs) are skipped.
 */
export function* rasterizeModel(root: THREE.Object3D, s: BerthedShipSpec, cell = RASTER_CELL): Job<HeightGrid> {
  const pad = 12;
  const x0 = -s.size.halfBeam - pad;
  const z0 = s.size.bowZ - pad;
  const nx = Math.ceil((2 * (s.size.halfBeam + pad)) / cell);
  const nz = Math.ceil((s.size.lengthM + 2 * pad) / cell);
  const data = new Float32Array(nx * nz).fill(-Infinity);
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const meshes: { m: THREE.Mesh; rel: THREE.Matrix4 }[] = [];
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine || (o as THREE.Sprite).isSprite) return;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    if (mats.every((m) => m && m.transparent && m.opacity < 0.5)) return;
    let v: THREE.Object3D | null = o;
    while (v && v !== root) {
      if (!v.visible) return;
      v = v.parent;
    }
    meshes.push({ m: mesh, rel: new THREE.Matrix4().multiplyMatrices(inv, mesh.matrixWorld) });
  });
  const cp = Math.cos(s.pitchDeg * DEG);
  const sp = Math.sin(s.pitchDeg * DEG);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const inst = new THREE.Matrix4();
  const full = new THREE.Matrix4();
  let work = 0;
  for (const { m, rel } of meshes) {
    const g = m.geometry as THREE.BufferGeometry;
    const pos = g.getAttribute('position') as THREE.BufferAttribute | undefined;
    if (!pos) continue;
    const idx = g.index;
    const tris = idx ? idx.count / 3 : pos.count / 3;
    const im = (m as THREE.InstancedMesh).isInstancedMesh ? (m as THREE.InstancedMesh) : null;
    const copies = im ? im.count : 1;
    for (let ci = 0; ci < copies; ci++) {
      if (im) {
        im.getMatrixAt(ci, inst);
        full.multiplyMatrices(rel, inst);
      } else full.copy(rel);
      for (let t = 0; t < tris; t++) {
        const i0 = idx ? idx.getX(t * 3) : t * 3;
        const i1 = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
        const i2 = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
        a.fromBufferAttribute(pos, i0).applyMatrix4(full);
        b.fromBufferAttribute(pos, i1).applyMatrix4(full);
        c.fromBufferAttribute(pos, i2).applyMatrix4(full);
        // (below the waterline nothing counts: the hull column is the deck's)
        if (a.y < 0 && b.y < 0 && c.y < 0) continue;
        const iMin = Math.max(0, Math.floor((Math.min(a.x, b.x, c.x) - x0) / cell));
        const iMax = Math.min(nx - 1, Math.floor((Math.max(a.x, b.x, c.x) - x0) / cell));
        const jMin = Math.max(0, Math.floor((Math.min(a.z, b.z, c.z) - z0) / cell));
        const jMax = Math.min(nz - 1, Math.floor((Math.max(a.z, b.z, c.z) - z0) / cell));
        const d = (b.z - c.z) * (a.x - c.x) + (c.x - b.x) * (a.z - c.z);
        const flat = Math.abs(d) < 1e-9;
        for (let j = jMin; j <= jMax; j++)
          for (let i = iMin; i <= iMax; i++) {
            const px = x0 + (i + 0.5) * cell;
            const pz = z0 + (j + 0.5) * cell;
            let y: number;
            if (flat) {
              // a vertical triangle (a wall): its top edge over the cell it crosses
              y = Math.max(a.y, b.y, c.y);
            } else {
              const l1 = ((b.z - c.z) * (px - c.x) + (c.x - b.x) * (pz - c.z)) / d;
              const l2 = ((c.z - a.z) * (px - c.x) + (a.x - c.x) * (pz - c.z)) / d;
              const l3 = 1 - l1 - l2;
              // (half a cell of slack: thin parts — masts, rails — still mark their cell)
              const e = -0.5 * cell * 0.7 / Math.max(1e-3, Math.sqrt(Math.abs(d)));
              if (l1 < e || l2 < e || l3 < e) continue;
              y = l1 * a.y + l2 * b.y + l3 * c.y;
            }
            const top = s.y + y * cp - pz * sp;
            const k = j * nx + i;
            if (top > data[k]) data[k] = top;
          }
        if (++work % 20000 === 0) yield;
      }
    }
  }
  return { x0, z0, cell, nx, nz, data };
}

/** A fleet entry as far as this system needs it (an `AircraftDef`). */
type ShipDef = Pick<AircraftDef, 'id' | 'config' | 'createModel'>;

/** The system (the fleet is injectable for tests; the module uses FLEET). */
export function createBerthedShipsSystem(ctx: SystemContext, fleet: readonly ShipDef[] = FLEET): SimSystem {
  const specs = berthedShipSpecs(fleet);
  let playerId = ctx.actions.currentAircraft().id;
  const active = (id: string) => id !== playerId;
  const obstacles = berthedObstacles(specs, active);
  if (specs.length) {
    ctx.env.registerObstacleSource((x, z) => obstacles.top(x, z));
    ctx.env.registerDeckSource((x, z) => obstacles.deckTop(x, z));
  }
  const group = new THREE.Group();
  group.name = 'berthedShips';
  ctx.scene.add(group);
  const spectrum = getSeaSpectrum();
  const shared = createLightingUniforms();
  const pointMat = createPointMaterial(shared);
  const points = new PointBuffer(Math.max(8, specs.length * 40));
  const pointsObj = new THREE.Points(points.geometry, pointMat);
  pointsObj.frustumCulled = false;
  pointsObj.renderOrder = -1;
  pointsObj.name = 'berthedShips.lights';
  group.add(pointsObj);
  const impostorMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0.1 });
  const browMat = new THREE.MeshStandardMaterial({ color: 0x8a8f95, roughness: 0.5, metalness: 0.6 });
  const views: ShipView[] = specs.map((spec) => {
    const mat = impostorMat.clone();
    mat.color.setHex(spec.berth === 'naval' ? 0x7d858c : 0xf4f4f0);
    const impostor = new THREE.Mesh(impostorGeometry(spec), mat);
    impostor.name = `berthedShips.${spec.id}.impostor`;
    impostor.visible = false;
    group.add(impostor);
    let brow: THREE.Mesh | null = null;
    if (spec.brow) {
      const b = spec.brow;
      const len = Math.hypot(b.bx - b.ax, b.by - b.ay, b.bz - b.az);
      const g = new THREE.BoxGeometry(2 * b.half, 0.25, len);
      brow = new THREE.Mesh(g, browMat);
      brow.position.set((b.ax + b.bx) / 2, (b.ay + b.by) / 2, (b.az + b.bz) / 2);
      brow.lookAt(b.bx, b.by, b.bz);
      brow.name = `berthedShips.${spec.id}.brow`;
      brow.visible = false;
      group.add(brow);
    }
    const visual = createDefaultVisualState();
    visual.engineRunning = false;
    visual.lights = { nav: false, strobe: false, beacon: false, landing: false, taxi: false };
    try {
      visual.vessel = createVesselState(ctx.env, spec.config, { x: spec.pose.x, z: spec.pose.z, headingDeg: spec.pose.headingDeg, moored: true }).state.vessel ?? null;
    } catch {
      visual.vessel = null;
    }
    return { spec, model: null, failed: false, impostor, brow, raster: null, lights: deckLightPoints(spec), visual };
  });
  const wm = newWaveMotion();
  const weights = new Float64Array(16);
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const cam = new THREE.Vector3();
  const place = (v: ShipView, obj: THREE.Object3D, heave: number, pitch: number, roll: number) => {
    const s = v.spec;
    const p = shipToWorld(s, 0, 0, 0);
    obj.position.set(p.x, p.y + heave, p.z);
    euler.set((s.pitchDeg + pitch) * DEG, -s.pose.headingDeg * DEG, -roll * DEG, 'YXZ');
    obj.quaternion.setFromEuler(euler);
  };
  const ensureModel = (v: ShipView) => {
    if (v.model || v.failed) return;
    const def = fleet.find((d) => d.id === v.spec.id);
    try {
      v.model = def ? def.createModel() : null;
    } catch (e) {
      console.warn(`[berthedShips] ${v.spec.id}: the model failed to build`, e);
      v.model = null;
    }
    if (!v.model) {
      v.failed = true;
      return;
    }
    v.model.root.name = `berthedShips.${v.spec.id}`;
    group.add(v.model.root);
    place(v, v.model.root, 0, 0, 0);
    v.raster = slicedJob(rasterizeModel(v.model.root, v.spec));
  };
  let shown = 0;
  return {
    update(f) {
      f.camera.getWorldPosition(cam);
      const atmo = ctx.atmosphere;
      syncLighting(shared, atmo.sunDirection, atmo.state?.sunAtCamera, atmo.state?.skyIrradiance);
      const night = nightFactor(sunElevationDeg(atmo.sunDirection.y));
      pointMat.uniforms.uHalfHeight.value = (ctx.renderer.domElement.height || 900) / 2;
      points.reset();
      shown = 0;
      for (const v of views) {
        const s = v.spec;
        const on = active(s.id);
        const d = Math.hypot(s.pose.x - cam.x, s.pose.z - cam.z);
        const near = on && d < MODEL_RANGE;
        if (near) ensureModel(v);
        const useModel = near && !!v.model;
        if (v.model) v.model.root.visible = useModel;
        v.impostor.visible = on && !useModel && d < IMPOSTOR_RANGE;
        if (v.brow) v.brow.visible = on && d < MODEL_RANGE * 1.5;
        if (!on || d > IMPOSTOR_RANGE) continue;
        shown++;
        // ride the drawn sea (a big hull averages the short waves away)
        let heave = 0, pitch = 0, roll = 0;
        if (d < 1500 && waveWeights(spectrum, d, 1500, weights) > 0) {
          hullWaveMotion(spectrum, weights, 1, s.pose.x, s.pose.z, f.waveTime, s.pose.headingDeg, s.size.lengthM, s.size.beamM, wm, 3);
          heave = wm.heave;
          pitch = wm.pitch;
          roll = wm.roll;
        }
        if (useModel && v.model) {
          place(v, v.model.root, heave, pitch, roll);
          const vs = v.visual;
          vs.time = f.time;
          vs.lights.landing = night > 0.3;
          vs.lights.taxi = night > 0.3;
          try {
            v.model.setVisualState(vs, f.dt);
          } catch {
            /* a model that can't animate still draws */
          }
          if (v.raster && !v.raster.done && v.raster.step(2)) {
            obstacles.setRaster(s.id, v.raster.value ?? null);
          }
        } else if (v.impostor.visible) place(v, v.impostor, heave, pitch, roll);
        // deck floodlights and the masthead lamps at night
        if (night > 0.02 && d < 15000) {
          const k = 520 * night;
          for (const l of v.lights) {
            const p = shipToWorld(s, l.x, l.y, l.z);
            const kk = l.masthead ? k * 1.6 : k;
            points.push(p.x, p.y + heave, p.z, kk, kk * 0.8, kk * 0.55, 0, l.masthead ? 0.6 : 0.5, 2.2, 0);
          }
        }
      }
      points.commit();
      pointsObj.visible = points.count > 0;
    },
    onAircraftChange(def) {
      playerId = def.id;
    },
    stats: () => ({
      ships: views.map((v) => ({ id: v.spec.id, berth: v.spec.berth, active: active(v.spec.id), model: !!v.model, modelShown: !!v.model?.root.visible, impostor: v.impostor.visible, raster: v.raster?.done ?? false, x: Math.round(v.spec.pose.x), z: Math.round(v.spec.pose.z) })),
      shown,
    }),
    dispose() {
      for (const v of views) {
        v.model?.dispose();
        v.impostor.geometry.dispose();
        (v.impostor.material as THREE.Material).dispose();
        v.brow?.geometry.dispose();
      }
      impostorMat.dispose();
      browMat.dispose();
      points.dispose();
      pointMat.dispose();
      group.removeFromParent();
      group.clear();
    },
  };
}

const mod: SystemModule = {
  name: 'berthedShips',
  order: 46,
  create: (ctx) => createBerthedShipsSystem(ctx),
};
export default mod;
