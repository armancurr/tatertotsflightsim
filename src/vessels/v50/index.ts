/**
 * Procedural Princess V50 (TATER TOT): a 15.5 m hardtop sports yacht on a deep-V planing hull
 * lofted from the very station table the physics floats (V50_AIRCRAFT.watercraft.hull.stations,
 * via src/vessels/hullLoft.ts), with spray rails and chine flats, the dark hull-window strips, the
 * boot-top stripe and antifouling painted by height, the long white foredeck and coachroof with
 * its sunpad, teak side decks, cockpit and swim platform, the raked wrap-around windscreen and
 * tinted side glazing under a crowned hardtop with a big sunroof and a swept radar pylon, a
 * starboard helm with two glass displays, twin steerable Volvo IPS drives with counter-rotating
 * propellers (blur discs at speed), trim tabs, nav lights, and the name on the transom.
 *
 *   const boat = createV50Model();
 *   scene.add(boat.root);          // the loop copies the physics pose onto boat.root
 *   boat.setVisualState(v, dt);    // every frame (v.vessel = VesselState, may be null)
 *
 * Body frame = three.js object frame (+X starboard, +Y up, −Z bow, origin = CG). tests/vessels/v50
 * hold the hull to the station table, the props to the propulsor positions / diameters, the pods'
 * steering sense, the tabs, the helm eye and the overall dimensions.
 */
import * as THREE from 'three';
import { V50_AIRCRAFT } from '../../config';
import type { AircraftModelHandle, BreakupPart } from '../../fleet/types';
import type { AircraftVisualState } from '../../aircraft/types';
import { createBreakupRig } from '../../aircraft/breakup';
import { tint, merge } from '../../aircraft/materials';
import { V, ellipsoid } from '../../aircraft/f16/geom';
import { gridGeometry, type P3 } from '../geom';
import { computeV50Anim, createV50Anim } from './animate';
import { V50_LIGHTS, buildHull, buildPlatform } from './hull';
import { buildInterior } from './interior';
import { createV50Materials } from './materials';
import { buildPod, buildTab, type PodRig, type TabRig } from './pods';
import { W50, coachTopY, houseHalf } from './shape';
import { buildHardtop, mastheadLight } from './superstructure';
import { SCREENS_TEX, createV50Textures, paintScreens } from './textures';
import { createScreenUpdater } from './screens';

/** Helm display repaint rate limit, Hz. */
export const SCREEN_HZ = 5;

export { computeV50Anim, createV50Anim, propBlur, TAB_MAX_DEG, PROP_BLUR } from './animate';
export { V50_SHAPE } from './shape';
export { createScreenUpdater, screenData, screenKey, type ScreenData } from './screens';

const TAU = Math.PI * 2;

/** Names of the parts (root.getObjectByName). */
export const V50_PART = {
  root: 'v50',
  hull: 'v50.hull',
  shell: 'v50.hull.shell',
  hullDetails: 'v50.hull.details',
  hullWindows: 'v50.hull.windows',
  deck: 'v50.hull.deck',
  teak: 'v50.hull.teak',
  steel: 'v50.hull.steel',
  sunpad: 'v50.hull.sunpad',
  interior: 'v50.interior',
  screens: 'v50.interior.screens',
  name: 'v50.hull.name',
  navLights: 'v50.navLights',
  glows: 'v50.lightGlows',
  superstructure: 'v50.superstructure',
  hardtop: 'v50.hardtop',
  hardtopFrame: 'v50.hardtop.frame',
  glass: 'v50.hardtop.glass',
  platform: 'v50.platform',
  platformBody: 'v50.platform.body',
  platformTeak: 'v50.platform.teak',
  podPort: 'v50.pod.port',
  podStarboard: 'v50.pod.starboard',
  tabPort: 'v50.tab.port',
  tabStarboard: 'v50.tab.starboard',
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

/** The sunpad cushions on the coachroof (a soft pillow shape over the coachroof top). */
function sunpadGeometry(): THREE.BufferGeometry {
  const z0 = -5.75;
  const z1 = -3.95;
  const grid: P3[][] = [];
  for (let i = 0; i <= 18; i++) {
    const t = i / 18;
    const z = z0 + (z1 - z0) * t;
    const row: P3[] = [];
    const hw = Math.min(1.0, houseHalf(z) - 0.12);
    for (let j = 0; j <= 16; j++) {
      const u = -1 + (2 * j) / 16;
      const x = u * hw;
      const puff = 0.075 * Math.pow(1 - Math.pow(Math.abs(u), 8), 0.5) * Math.pow(1 - Math.pow(Math.abs(2 * t - 1), 8), 0.5);
      row.push([x, coachTopY(x, z) + 0.004 + puff, z]);
    }
    grid.push(row);
  }
  return tint(gridGeometry(grid, [0, 1, 0]), 0xcfcac0, 0.9);
}

export function createV50Model(): AircraftModelHandle {
  const made = createV50Textures(V50_AIRCRAFT.registration ?? 'TATER TOT');
  const textures = made?.tex ?? null;
  const mats = createV50Materials(textures);
  const root = group(V50_PART.root);

  // ── Hull (break-up part: hull, decks, house sides, interior, rails, lights, tabs) ──
  const hullGroup = group(V50_PART.hull, root);
  const hg = buildHull();
  mesh(hg.shell, mats.hull, V50_PART.shell, hullGroup);
  mesh(hg.details, mats.hull, V50_PART.hullDetails, hullGroup);
  mesh(hg.windows, mats.darkGlass, V50_PART.hullWindows, hullGroup, false);
  mesh(merge([hg.grp, sunpadGeometry()]), mats.grp, V50_PART.deck, hullGroup);
  mesh(hg.teak, mats.teak, V50_PART.teak, hullGroup);
  mesh(hg.steel, mats.parts, V50_PART.steel, hullGroup);
  const nameMesh = textures ? mesh(hg.nameBoard, mats.name, V50_PART.name, hullGroup, false) : null;
  if (!nameMesh) hg.nameBoard.dispose();
  const interior = buildInterior();
  mesh(interior.furniture, mats.interior, V50_PART.interior, hullGroup);
  const screensMesh = mesh(interior.screens, mats.screens, V50_PART.screens, hullGroup, false);
  // Live displays: repainted from the helm readings, at most 5 Hz and only when a shown value changes.
  const screens = createScreenUpdater((d) => {
    screensMesh.userData.redraws = (screensMesh.userData.redraws ?? 0) + 1;
    if (!made || !textures) return;
    paintScreens(made.screensCtx, SCREENS_TEX.width, SCREENS_TEX.height, d);
    textures.screens.needsUpdate = true;
  }, SCREEN_HZ);

  // Trim tabs (moving; inside the hull part).
  const tabs: TabRig[] = (W50.trimTabs?.positions ?? []).map((p) => {
    const t = buildTab(p, p.x < 0 ? V50_PART.tabPort : V50_PART.tabStarboard, mats.parts);
    hullGroup.add(t.hinge);
    return t;
  });

  // ── Nav lights: lenses (one mesh) + glows (one Points draw): port red, starboard green, masthead, stern ──
  const masthead = mastheadLight();
  const L = V50_LIGHTS;
  const lens = (p: THREE.Vector3, hex: number, rx: number, ry: number, rz: number) => tint(ellipsoid(p, rx, ry, rz, 10, 6), hex, 0.2);
  const navMesh = mesh(
    merge([
      lens(L.port, 0xff2a1a, 0.02, 0.03, 0.06),
      lens(L.starboard, 0x20ff60, 0.02, 0.03, 0.06),
      lens(masthead, 0xffffff, 0.03, 0.035, 0.03),
      lens(L.stern, 0xffffff, 0.03, 0.03, 0.02),
    ]),
    mats.nav,
    V50_PART.navLights,
    hullGroup,
    false,
  );
  const glowPts = [L.port, L.starboard, masthead, L.stern];
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.Float32BufferAttribute(glowPts.flatMap((p) => [p.x, p.y, p.z]), 3));
  glowGeo.setAttribute('glowColor', new THREE.BufferAttribute(new Float32Array([1.6, 0.08, 0.04, 0.1, 1.5, 0.35, 1.2, 1.2, 1.15, 1.2, 1.2, 1.15]), 3));
  glowGeo.setAttribute('size', new THREE.BufferAttribute(new Float32Array([0.3, 0.3, 0.32, 0.26]), 1));
  glowGeo.setAttribute('aDir', new THREE.BufferAttribute(new Float32Array([-0.7, 0, -0.7, 0.7, 0, -0.7, 0, 0, -1, 0, 0, 1]), 3));
  const glowIntensity = new THREE.BufferAttribute(new Float32Array(glowPts.length), 1);
  glowIntensity.setUsage(THREE.DynamicDrawUsage);
  glowGeo.setAttribute('intensity', glowIntensity);
  glowGeo.boundingSphere = new THREE.Sphere(V(0, 1, -1), 9);
  const glows = new THREE.Points(glowGeo, mats.glow);
  glows.name = V50_PART.glows;
  glows.frustumCulled = false;
  glows.renderOrder = 5;
  glows.userData.noBounds = true;
  const _buf = new THREE.Vector2();
  glows.onBeforeRender = (renderer) => {
    renderer.getDrawingBufferSize(_buf);
    mats.glow.uniforms.uHalfHeight.value = _buf.y * 0.5;
  };
  hullGroup.add(glows);

  // ── Superstructure (break-up part): hardtop, glazing, pylon; a tilt group for the wreck ──
  const superGroup = group(V50_PART.superstructure, root);
  const hardtop = group(V50_PART.hardtop, superGroup);
  const ht = buildHardtop();
  mesh(ht.grp, mats.grp, V50_PART.hardtopFrame, hardtop);
  const glass = mesh(ht.glass, mats.glass, V50_PART.glass, hardtop, false);
  glass.renderOrder = 3;

  // ── Swim platform (break-up part) ──
  const platformGroup = group(V50_PART.platform, root);
  const pf = buildPlatform();
  mesh(pf.grp, mats.grp, V50_PART.platformBody, platformGroup);
  mesh(pf.teak, mats.teak, V50_PART.platformTeak, platformGroup);

  // ── IPS drives (one break-up part each) ──
  const pods: PodRig[] = W50.propulsors.map((p) => {
    const rig = buildPod(p, p.position.x < 0 ? V50_PART.podPort : V50_PART.podStarboard, mats);
    root.add(rig.container);
    return rig;
  });

  // ── Break-up: masses sum to the half-load displacement ──
  const podMass = 260;
  const parts: BreakupPart[] = [
    { name: 'hull', object: hullGroup, mass: V50_AIRCRAFT.mass - 1900 - 380 - podMass * pods.length, burning: true },
    { name: 'superstructure', object: superGroup, mass: 1900 },
    { name: 'swimPlatform', object: platformGroup, mass: 380 },
    ...pods.map((r, i) => ({ name: W50.propulsors[i].position.x < 0 ? 'portPod' : 'starboardPod', object: r.container, mass: podMass })),
  ];
  const breakup = createBreakupRig(parts);

  // ── Per-frame state ──
  const anim = createV50Anim();
  const angles = pods.map(() => 0);
  const gi = glowIntensity.array as Float32Array;
  let lastMode: string | null = null;
  let wrecked = false;

  function setWrecked(on: boolean) {
    if (on === wrecked) return;
    wrecked = on;
    glass.visible = !on;
    if (on) {
      // The hardtop is knocked askew on its mountings.
      hardtop.position.set(0.12, -0.14, 0.1);
      hardtop.rotation.set(-0.05, 0.03, 0.09);
    } else {
      hardtop.position.set(0, 0, 0);
      hardtop.rotation.set(0, 0, 0);
    }
  }

  function setVisualState(v: AircraftVisualState, dt: number) {
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.25)) : 0;
    computeV50Anim(v, anim);
    setWrecked(anim.crashed);
    mats.char.value = anim.crashed ? Math.min(1, Math.max(0, Number(v.crashAge ?? 0)) / 7) : 0;

    pods.forEach((rig, i) => {
      rig.pivot.rotation.y = anim.steer[i];
      angles[i] = (angles[i] + anim.n[i] * TAU * step) % TAU;
      rig.spinners[0].rotation.z = angles[i];
      rig.spinners[1].rotation.z = -angles[i];
      const blur = anim.blur[i];
      for (const b of rig.blades) b.visible = blur < 0.6;
      rig.disc.visible = blur > 0.001;
      rig.disc.castShadow = false;
    });
    const blurMax = Math.max(0, ...anim.blur);
    mats.disc.opacity = 0.55 * blurMax;

    for (const t of tabs) t.flap.rotation.x = anim.tab;
    screens.update(v, step);

    navMesh.visible = anim.nav > 0;
    for (let k = 0; k < gi.length; k++) gi[k] = anim.nav;
    glowIntensity.needsUpdate = true;

    if (v.cameraMode !== lastMode) {
      lastMode = v.cameraMode;
      const cp = v.cameraMode === 'cockpit';
      mats.glass.opacity = cp ? 0.28 : 0.72;
      mats.screens.emissiveIntensity = cp ? 0.9 : 0.5;
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
