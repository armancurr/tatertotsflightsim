/**
 * Procedural MS Tater Star (Tater Line): a classic 1990s mid-size cruise ship in the Fantasy-class
 * manner, kept plain and white — the hull lofted from the very station table the physics floats
 * (CRUISE_AIRCRAFT.watercraft.hull.stations via src/vessels/hullLoft.ts) with its portholes and
 * boot top painted in the shader, a stack of window-textured tiers, a glazed bridge with wings, the
 * lido deck and pool, lifeboats in davits under the overhang, a raked funnel with a potato-gold
 * band, a foremast, two propellers and rudders, bow and stern thruster tunnels, nav lights, and
 * windows that light up after sunset.
 *
 *   const ship = createCruiseModel();
 *   scene.add(ship.root);          // the loop copies the physics pose onto ship.root
 *   ship.setVisualState(v, dt);    // every frame (v.vessel = VesselState, may be null)
 *
 * Budget: ~17 draw calls (merged geometry, 9 materials), no per-frame allocations. Seen from
 * kilometres away (an aircraft overhead) the small parts — lifeboats, props, rudders, loungers,
 * the bridge interior — drop out (THREE.LOD) and the hull, walls, decks and funnel carry the shape.
 * Body frame = three.js object frame (+X starboard, +Y up, −Z bow, origin = CG).
 */
import * as THREE from 'three';
import { CRUISE_AIRCRAFT } from '../../config';
import type { AircraftModelHandle, BreakupPart } from '../../fleet/types';
import type { AircraftVisualState } from '../../aircraft/types';
import { createBreakupRig } from '../../aircraft/breakup';
import { merge, tint } from '../../aircraft/materials';
import { V, ellipsoid } from '../../aircraft/f16/geom';
import { nightFactor, sunElevationDeg } from '../../world/traffic/daylight';
import { computeCruiseAnim, createCruiseAnim } from './animate';
import { buildCruiseHull } from './hull';
import { WINDOW_GLOW, createCruiseMaterials } from './materials';
import { buildScrews, shaftGeometry } from './running';
import { CRUISE_LIGHTS } from './shape';
import { buildCruiseSuperstructure } from './superstructure';
import { createCruiseTextures } from './textures';

export { computeCruiseAnim, createCruiseAnim, SHAFT_INDEX, THRUSTER_INDEX } from './animate';
export { CRUISE_SHAPE, CRUISE_LIGHTS, tierHalfAt } from './shape';
export { tunnelOpenings } from './hull';
export { rudderDims } from './running';

const TAU = Math.PI * 2;
/** Beyond this distance (m) the small parts are not drawn. */
export const DETAIL_DISTANCE = 2200;

/** Names of the parts (root.getObjectByName). */
export const CRUISE_PART = {
  root: 'cruise',
  hull: 'cruise.hull',
  shell: 'cruise.hull.shell',
  hullDetails: 'cruise.hull.details',
  name: 'cruise.hull.name',
  navLights: 'cruise.navLights',
  glows: 'cruise.lightGlows',
  superstructure: 'cruise.superstructure',
  walls: 'cruise.superstructure.walls',
  decks: 'cruise.superstructure.decks',
  bridgeInterior: 'cruise.bridge.interior',
  glass: 'cruise.bridge.glass',
  pool: 'cruise.pool',
  boats: 'cruise.lifeboats',
  detail: 'cruise.detail',
  funnel: 'cruise.funnel',
  funnelBody: 'cruise.funnel.body',
  screwPort: 'cruise.screw.port',
  screwStarboard: 'cruise.screw.starboard',
} as const;

function group(name: string, parent?: THREE.Object3D): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  parent?.add(g);
  return g;
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, name: string, parent: THREE.Object3D, shadows = true): THREE.Mesh {
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  m.castShadow = shadows;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}

/** A LOD holder: its child drawn only within `distance` of the camera. */
function detailLod(name: string, parent: THREE.Object3D, distance = DETAIL_DISTANCE): THREE.Group {
  const lod = new THREE.LOD();
  lod.name = `${name}.lod`;
  const near = group(name);
  lod.addLevel(near, 0);
  lod.addLevel(new THREE.Object3D(), distance);
  parent.add(lod);
  return near;
}

export function createCruiseModel(): AircraftModelHandle {
  const textures = createCruiseTextures(CRUISE_AIRCRAFT.registration ?? 'TATER STAR');
  const mats = createCruiseMaterials(textures);
  const root = group(CRUISE_PART.root);

  // ── Hull (break-up part): skin, deck, fittings, tunnels, shafts, name, nav lights ──
  const hullGroup = group(CRUISE_PART.hull, root);
  const hg = buildCruiseHull();
  mesh(hg.shell, mats.hull, CRUISE_PART.shell, hullGroup);
  mesh(merge([hg.details, shaftGeometry()]), mats.parts, CRUISE_PART.hullDetails, hullGroup);
  const nameMesh = textures ? mesh(hg.name, mats.name, CRUISE_PART.name, hullGroup, false) : null;
  if (!nameMesh) hg.name.dispose();

  const L = CRUISE_LIGHTS;
  const lightPts = [L.port, L.starboard, L.masthead, L.aftMasthead, L.stern];
  const lens = (p: { x: number; y: number; z: number }, hex: number) => tint(ellipsoid(V(p.x, p.y, p.z), 0.22, 0.3, 0.22, 10, 6), hex, 0.2);
  const navMesh = mesh(
    merge([lens(L.port, 0xff2a1a), lens(L.starboard, 0x20ff60), lens(L.masthead, 0xffffff), lens(L.aftMasthead, 0xffffff), lens(L.stern, 0xffffff)]),
    mats.nav,
    CRUISE_PART.navLights,
    hullGroup,
    false,
  );
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.Float32BufferAttribute(lightPts.flatMap((p) => [p.x, p.y, p.z]), 3));
  glowGeo.setAttribute('glowColor', new THREE.BufferAttribute(new Float32Array([1.6, 0.08, 0.04, 0.1, 1.5, 0.35, 1.2, 1.2, 1.15, 1.2, 1.2, 1.15, 1.2, 1.2, 1.15]), 3));
  glowGeo.setAttribute('size', new THREE.BufferAttribute(new Float32Array([2.2, 2.2, 2.6, 2.6, 2]), 1));
  glowGeo.setAttribute('aDir', new THREE.BufferAttribute(new Float32Array([-0.7, 0, -0.7, 0.7, 0, -0.7, 0, 0, -1, 0, 0, -1, 0, 0, 1]), 3));
  const glowIntensity = new THREE.BufferAttribute(new Float32Array(lightPts.length), 1);
  glowIntensity.setUsage(THREE.DynamicDrawUsage);
  glowGeo.setAttribute('intensity', glowIntensity);
  glowGeo.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 15, 0), 150);
  const glows = new THREE.Points(glowGeo, mats.glow);
  glows.name = CRUISE_PART.glows;
  glows.frustumCulled = false;
  glows.renderOrder = 5;
  glows.userData.noBounds = true;
  const _buf = new THREE.Vector2();
  glows.onBeforeRender = (renderer) => {
    renderer.getDrawingBufferSize(_buf);
    mats.glow.uniforms.uHalfHeight.value = _buf.y * 0.5;
  };
  hullGroup.add(glows);

  // ── Superstructure (break-up part): tiers, decks, bridge, pool; lifeboats and the bridge interior as near detail ──
  const superGroup = group(CRUISE_PART.superstructure, root);
  const sg = buildCruiseSuperstructure();
  const walls = mesh(sg.walls, mats.walls, CRUISE_PART.walls, superGroup);
  mesh(sg.decks, mats.parts, CRUISE_PART.decks, superGroup);
  const glass = mesh(sg.glass, mats.glass, CRUISE_PART.glass, superGroup, false);
  glass.renderOrder = 3;
  mesh(sg.pool, mats.water, CRUISE_PART.pool, superGroup, false);
  const detail = detailLod(CRUISE_PART.detail, superGroup);
  mesh(sg.boats, mats.parts, CRUISE_PART.boats, detail);
  mesh(sg.bridgeInterior, mats.interior, CRUISE_PART.bridgeInterior, detail, false);

  // ── Funnel (break-up part) ──
  const funnelGroup = group(CRUISE_PART.funnel, root);
  mesh(sg.funnel, mats.parts, CRUISE_PART.funnelBody, funnelGroup);

  // ── Screws: propeller + rudder (one break-up part each), near detail ──
  const screws = buildScrews(mats.parts);
  for (const r of screws) {
    root.add(r.container);
    const lod = new THREE.LOD();
    lod.name = `${r.container.name}.lod`;
    const near = new THREE.Group();
    near.add(r.prop, r.rudder);
    lod.addLevel(near, 0);
    lod.addLevel(new THREE.Object3D(), DETAIL_DISTANCE * 0.6);
    r.container.add(lod);
  }

  // ── Night: find the scene's sun once, fade the lit windows / portholes / pool in after sunset ──
  let sunScene: THREE.Object3D | null = null;
  let sun: THREE.DirectionalLight | null = null;
  let manualNight: number | null = null;
  const _a = new THREE.Vector3();
  const _b = new THREE.Vector3();
  walls.onBeforeRender = (_r, scene) => {
    if (scene !== sunScene) {
      sunScene = scene;
      sun = null;
      scene.traverse((o) => {
        if (!sun && (o as THREE.DirectionalLight).isDirectionalLight) sun = o as THREE.DirectionalLight;
      });
    }
    let n = manualNight ?? 0;
    const s = sun as THREE.DirectionalLight | null;
    if (manualNight === null && s) {
      s.getWorldPosition(_a).sub(s.target.getWorldPosition(_b));
      n = _a.lengthSq() > 1e-12 ? nightFactor(sunElevationDeg(_a.normalize().y)) : 0;
    }
    mats.night.value = n;
    mats.walls.emissiveIntensity = WINDOW_GLOW * n;
    mats.water.emissiveIntensity = 0.05 + 0.9 * n;
  };
  root.userData.setNight = (n: number | null) => {
    manualNight = n === null ? null : Math.max(0, Math.min(1, n));
  };

  // ── Break-up: masses sum to the displacement ──
  const screwMass = 60000;
  const superMass = 9_000_000;
  const funnelMass = 450_000;
  const parts: BreakupPart[] = [
    { name: 'hull', object: hullGroup, mass: CRUISE_AIRCRAFT.mass - superMass - funnelMass - screwMass * screws.length, burning: true },
    { name: 'superstructure', object: superGroup, mass: superMass, burning: true },
    { name: 'funnel', object: funnelGroup, mass: funnelMass },
    ...screws.map((r) => ({ name: r.hand < 0 ? 'portScrew' : 'starboardScrew', object: r.container, mass: screwMass })),
  ];
  const breakup = createBreakupRig(parts);

  // ── Per-frame state ──
  const anim = createCruiseAnim();
  const angles = screws.map(() => 0);
  const gi = glowIntensity.array as Float32Array;
  let lastMode: string | null = null;

  function setVisualState(v: AircraftVisualState, dt: number) {
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.25)) : 0;
    computeCruiseAnim(v, anim);
    mats.char.value = anim.crashed ? Math.min(1, Math.max(0, Number(v.crashAge ?? 0)) / 12) : 0;
    glass.visible = !anim.crashed;
    for (let k = 0; k < screws.length; k++) {
      const r = screws[k];
      r.rudder.rotation.y = anim.rudder[k];
      angles[k] = (angles[k] + r.hand * anim.n[k] * TAU * step) % TAU;
      r.blades.rotation.z = -angles[k];
    }
    navMesh.visible = anim.nav > 0;
    for (let k = 0; k < gi.length; k++) gi[k] = anim.nav;
    glowIntensity.needsUpdate = true;
    if (v.cameraMode !== lastMode) {
      lastMode = v.cameraMode;
      mats.glass.opacity = v.cameraMode === 'cockpit' ? 0.22 : 0.78;
    }
  }

  setVisualState(
    {
      elevator: 0, aileron: 0, rudder: 0, trim: 0, flapsDeg: 0, gearPos: 1,
      wheelCompression: [0, 0, 0], wheelRollSpeed: [0, 0, 0], nosewheelSteer: 0,
      propRpm: 0, engineRunning: false,
      lights: { nav: false, strobe: false, beacon: false, landing: false, taxi: false },
      time: 0, cameraMode: 'chase', instruments: null, vessel: null,
    },
    0,
  );

  return {
    root,
    setVisualState,
    getBreakupParts: () => breakup.parts,
    restoreBreakupParts() {
      breakup.restore();
      root.updateMatrixWorld(true);
    },
    dispose() {
      const geos = new Set<THREE.BufferGeometry>();
      const collect = (o: THREE.Object3D) =>
        o.traverse((c) => {
          const m = c as THREE.Mesh;
          if (m.geometry) geos.add(m.geometry);
        });
      collect(root);
      for (const p of breakup.parts) {
        collect(p.object);
        p.object.removeFromParent();
      }
      for (const g of geos) g.dispose();
      for (const m of mats.all) m.dispose();
      if (textures) for (const t of Object.values(textures)) t.dispose();
      root.removeFromParent();
    },
  };
}
