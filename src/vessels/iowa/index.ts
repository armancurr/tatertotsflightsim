/**
 * Procedural USS Iowa (BB-61) as she is today — the 1984 modernisation, museum ship at San Pedro:
 * a 270 m hull lofted from the very station table the physics floats (IOWA_AIRCRAFT.watercraft.hull
 * .stations, via src/vessels/hullLoft.ts) in haze gray with her black boot-top and red bottom, the
 * bulbous forefoot, twin skegs and bilge keels; the teak main deck; hull number 61 on both bows;
 * three triple 16-inch turrets on their barbettes, trained, elevated and recoiling from the naval
 * gunnery's TurretStatus exactly on IOWA_WEAPONS.naval.turrets (see ./turrets.ts, the maths the
 * gunnery shares); the superstructure (./superstructure.ts) with the conning tower, the glazed
 * pilot house around the helm, the tower foremast and directors, two funnels, the tripod masts, the
 * 5-inch/38 mounts, Tomahawk and Harpoon launchers and Phalanx CIWS; the fantail helicopter pad;
 * four propellers spinning on their shafts and twin rudders turning; nav lights, deck floodlights and
 * lit portholes at night; and the break-up parts the crash throws about (bow, stern, the three
 * turrets, the superstructure).
 *
 *   const ship = createIowaModel();
 *   scene.add(ship.root);          // the loop copies the physics pose onto ship.root
 *   ship.setVisualState(v, dt);    // every frame (v.vessel, v.turrets may be null)
 *
 * Body frame = three.js object frame (+X starboard, +Y up, −Z bow, origin = CG). Draw calls: ~40 up
 * close, fewer from afar (rails, lifelines and small fittings sit in LODs that drop out past
 * IOWA_DETAIL_DISTANCE). No allocation per frame.
 */
import * as THREE from 'three';
import { IOWA_AIRCRAFT } from '../../config';
import type { AircraftModelHandle, BreakupPart } from '../../fleet/types';
import type { AircraftVisualState } from '../../aircraft/types';
import { createBreakupRig } from '../../aircraft/breakup';
import { tint, merge } from '../../aircraft/materials';
import { ellipsoid, V } from '../../aircraft/f16/geom';
import { computeIowaAnim, createIowaAnim } from './animate';
import { buildHull } from './hull';
import { createIowaMaterials } from './materials';
import { buildProp, buildRudder, type PropRig, type RudderRig } from './props';
import { IOWA_LIGHTS, TURRETS, WC } from './shape';
import { buildSuperstructure } from './superstructure';
import { buildTurret, gunGeometry, type TurretRig } from './turretRig';

export { computeIowaAnim, createIowaAnim, RUDDER_MAX_DEG, type IowaAnim, type IowaTurretAnim } from './animate';
export { iowaMuzzleBody, iowaBoreBody, iowaTrunnionBody, barrelOffset, foldTrain, IOWA_RECOIL_M, type BodyPoint } from './turrets';
export { IOWA_SHAPE, IOWA_LIGHTS, LEVEL, bz, by, sOf, hOf, deckY } from './shape';
export { RUDDER } from './props';

/** Small fittings (rails, lifelines, bitts, whips) drop out past this camera distance, m. */
export const IOWA_DETAIL_DISTANCE = 1400;

const TAU = Math.PI * 2;

/** Names of the parts (root.getObjectByName). */
export const IOWA_PART = {
  root: 'iowa',
  bow: 'iowa.bow',
  stern: 'iowa.stern',
  shellBow: 'iowa.bow.shell',
  shellStern: 'iowa.stern.shell',
  deckBow: 'iowa.bow.deck',
  deckStern: 'iowa.stern.deck',
  underBow: 'iowa.bow.under',
  underStern: 'iowa.stern.under',
  grayBow: 'iowa.bow.gray',
  grayStern: 'iowa.stern.gray',
  fittingsBow: 'iowa.bow.fittings',
  fittingsStern: 'iowa.stern.fittings',
  superstructure: 'iowa.superstructure',
  superMain: 'iowa.superstructure.main',
  superDetails: 'iowa.superstructure.details',
  glass: 'iowa.superstructure.glass',
  lit: 'iowa.superstructure.lit',
  navLights: 'iowa.navLights',
  glows: 'iowa.lightGlows',
  turret: (i: number) => `iowa.turret.${TURRETS[i].name}`,
  prop: (i: number) => `iowa.prop${i}`,
  rudder: (i: number) => `iowa.rudder${i}`,
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

/** A detail mesh that is drawn only within IOWA_DETAIL_DISTANCE of the camera. */
function detailLod(geo: THREE.BufferGeometry, mat: THREE.Material, name: string, parent: THREE.Object3D): THREE.Mesh {
  const lod = new THREE.LOD();
  lod.name = `${name}.lod`;
  const m = new THREE.Mesh(geo, mat);
  m.name = name;
  m.castShadow = false;
  m.receiveShadow = true;
  lod.addLevel(m, 0, 0.05);
  const far = new THREE.Object3D();
  far.name = `${name}.far`;
  lod.addLevel(far, IOWA_DETAIL_DISTANCE, 0.05);
  parent.add(lod);
  return m;
}

export function createIowaModel(): AircraftModelHandle {
  const mats = createIowaMaterials(TURRETS.length);
  const root = group(IOWA_PART.root);

  // ── Hull halves (break-up parts: bow, stern) ──
  const hg = buildHull();
  const bow = group(IOWA_PART.bow, root);
  const stern = group(IOWA_PART.stern, root);
  const halves: [THREE.Group, ReturnType<typeof buildHull>['bow'], 'Bow' | 'Stern'][] = [[bow, hg.bow, 'Bow'], [stern, hg.stern, 'Stern']];
  let shellForSun: THREE.Mesh | null = null;
  for (const [g, h, k] of halves) {
    const shell = mesh(h.shell, mats.hull, IOWA_PART[`shell${k}`], g);
    shellForSun ??= shell;
    mesh(h.deck, mats.deck, IOWA_PART[`deck${k}`], g);
    if (h.under) mesh(h.under, mats.hull, IOWA_PART[`under${k}`], g, false);
    if (h.gray) mesh(h.gray, mats.gray, IOWA_PART[`gray${k}`], g);
    if (h.fittings) detailLod(h.fittings, mats.gray, IOWA_PART[`fittings${k}`], g);
  }

  // ── Propellers and rudders (on the stern) ──
  const props: PropRig[] = WC.propulsors.map((p, i) => {
    const r = buildProp(p, IOWA_PART.prop(i), mats.gray);
    stern.add(r.spinner);
    return r;
  });
  const rudders: (RudderRig | null)[] = WC.propulsors.map((p, i) => {
    if (p.foilArea < 5) return null;
    const r = buildRudder(p, IOWA_PART.rudder(i), mats.gray);
    stern.add(r.pivot);
    return r;
  });

  // ── Superstructure (break-up part) ──
  const superGroup = group(IOWA_PART.superstructure, root);
  const sg = buildSuperstructure();
  mesh(sg.main, mats.gray, IOWA_PART.superMain, superGroup);
  detailLod(sg.details, mats.gray, IOWA_PART.superDetails, superGroup);
  const glass = mesh(sg.glass, mats.glass, IOWA_PART.glass, superGroup, false);
  glass.renderOrder = 3;
  const litMesh = mesh(sg.lit, mats.lit, IOWA_PART.lit, superGroup, false);
  litMesh.visible = false;

  // ── Nav lights (lenses) and every light's glow (nav + deck lamps, one Points draw) ──
  const L = IOWA_LIGHTS;
  const lens = (p: { x: number; y: number; z: number }, hex: number, r: number) => tint(ellipsoid(V(p.x, p.y, p.z), r, r * 1.3, r, 10, 6), hex, 0.2);
  const navMesh = mesh(
    merge([lens(L.masthead, 0xffffff, 0.22), lens(L.range, 0xffffff, 0.22), lens(L.port, 0xff2a1a, 0.2), lens(L.starboard, 0x20ff60, 0.2), lens(L.stern, 0xffffff, 0.2)]),
    mats.nav,
    IOWA_PART.navLights,
    superGroup,
    false,
  );
  const navPts: [{ x: number; y: number; z: number }, [number, number, number], number, [number, number, number]][] = [
    [L.masthead, [1.3, 1.3, 1.25], 1.4, [0, 0, -1]],
    [L.range, [1.3, 1.3, 1.25], 1.4, [0, 0, -1]],
    [L.port, [1.7, 0.08, 0.04], 1.2, [-0.7, 0, -0.7]],
    [L.starboard, [0.1, 1.6, 0.35], 1.2, [0.7, 0, -0.7]],
    [L.stern, [1.3, 1.3, 1.25], 1.2, [0, 0, 1]],
  ];
  const nGlow = navPts.length + sg.lamps.length;
  const gPos = new Float32Array(nGlow * 3);
  const gCol = new Float32Array(nGlow * 3);
  const gSize = new Float32Array(nGlow);
  const gDir = new Float32Array(nGlow * 3);
  const gKind = new Float32Array(nGlow);
  navPts.forEach(([p, c, s, d], i) => {
    gPos.set([p.x, p.y, p.z], i * 3);
    gCol.set(c, i * 3);
    gSize[i] = s;
    gDir.set(d, i * 3);
    gKind[i] = 0;
  });
  sg.lamps.forEach((p, j) => {
    const i = navPts.length + j;
    gPos.set([p.x, p.y, p.z], i * 3);
    gCol.set([1.25, 1.05, 0.75], i * 3);
    gSize[i] = 1.1;
    gKind[i] = 1;
  });
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.BufferAttribute(gPos, 3));
  glowGeo.setAttribute('glowColor', new THREE.BufferAttribute(gCol, 3));
  glowGeo.setAttribute('size', new THREE.BufferAttribute(gSize, 1));
  glowGeo.setAttribute('aDir', new THREE.BufferAttribute(gDir, 3));
  glowGeo.setAttribute('kind', new THREE.BufferAttribute(gKind, 1));
  glowGeo.boundingSphere = new THREE.Sphere(V(0, 15, 0), 150);
  const glows = new THREE.Points(glowGeo, mats.glow);
  glows.name = IOWA_PART.glows;
  glows.frustumCulled = false;
  glows.renderOrder = 5;
  glows.userData.noBounds = true;
  const _buf = new THREE.Vector2();
  glows.onBeforeRender = (renderer) => {
    renderer.getDrawingBufferSize(_buf);
    mats.glow.uniforms.uHalfHeight.value = _buf.y * 0.5;
  };
  superGroup.add(glows);

  // ── Turrets (one break-up part each) ──
  const gun = gunGeometry(TURRETS[0].barrelLength);
  const turrets: TurretRig[] = TURRETS.map((t, i) => {
    const rig = buildTurret(t, IOWA_PART.turret(i), gun, { gray: mats.gray, flash: mats.flash[i] }, i > 0);
    root.add(rig.container);
    return rig;
  });

  // ── Night: from the scene's sun (the renderer's DirectionalLight named 'sun'), read before each frame ──
  let sun: THREE.DirectionalLight | null = null;
  let sunScene: THREE.Object3D | null = null;
  const _d = new THREE.Vector3();
  if (shellForSun) {
    shellForSun.onBeforeRender = (_r, scene) => {
      if (sunScene !== scene || !sun || !sun.parent) {
        sunScene = scene;
        const o = scene.getObjectByName('sun');
        sun = o && (o as THREE.DirectionalLight).isDirectionalLight ? (o as THREE.DirectionalLight) : null;
      }
      let night = 0;
      if (sun) {
        if (!sun.visible || sun.intensity <= 0) night = 1;
        else {
          _d.subVectors(sun.position, sun.target.position).normalize();
          const el = (Math.asin(Math.max(-1, Math.min(1, _d.y))) * 180) / Math.PI;
          const t = Math.min(1, Math.max(0, (el + 2) / 16));
          night = 1 - t * t * (3 - 2 * t);
        }
      }
      mats.night.value = wrecked ? 0 : night;
      litMesh.visible = mats.night.value > 0.02;
      mats.lit.color.setRGB(1, 0.72, 0.38).multiplyScalar(0.3 + 0.8 * mats.night.value);
    };
  }

  // ── Break-up: masses sum to the displacement (a turret's rotating structure is ~1,700 long tons) ──
  const turretMass = 1.73e6;
  const superMass = 6.1e6;
  const bowMass = 17.5e6;
  const parts: BreakupPart[] = [
    { name: 'bow', object: bow, mass: bowMass, burning: true },
    { name: 'stern', object: stern, mass: IOWA_AIRCRAFT.mass - bowMass - superMass - turretMass * turrets.length, burning: true },
    { name: 'superstructure', object: superGroup, mass: superMass, burning: true },
    ...turrets.map((r, i) => ({ name: `turret${TURRETS[i].name}`, object: r.container, mass: turretMass })),
  ];
  const breakup = createBreakupRig(parts);

  // ── Per-frame state ──
  const anim = createIowaAnim();
  const angles = props.map(() => 0);
  let lastMode: string | null = null;
  let wrecked = false;
  const grayBase = mats.gray.color.clone();

  function setWrecked(on: boolean) {
    if (on === wrecked) return;
    wrecked = on;
    glass.visible = !on;
    if (!on) {
      mats.char.value = 0;
      mats.gray.color.copy(grayBase);
    }
  }

  function setVisualState(v: AircraftVisualState, dt: number) {
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.25)) : 0;
    computeIowaAnim(v, anim);
    setWrecked(anim.crashed);
    if (anim.crashed) {
      const c = Math.min(1, Math.max(0, Number(v.crashAge ?? 0)) / 10);
      mats.char.value = c;
      mats.gray.color.copy(grayBase).multiplyScalar(1 - 0.75 * c);
    }
    for (let i = 0; i < props.length; i++) {
      angles[i] = (angles[i] + anim.n[i] * TAU * step * props[i].hand) % TAU;
      props[i].spinner.rotation.z = angles[i];
      const r = rudders[i];
      if (r) r.pivot.rotation.y = anim.rudder[i];
    }
    for (let t = 0; t < turrets.length; t++) {
      const rig = turrets[t];
      const a = anim.turrets[t];
      rig.train.rotation.y = a.rotY;
      rig.elev.rotation.x = a.rotX;
      let any = 0;
      for (let k = 0; k < rig.barrels.length; k++) {
        rig.barrels[k].position.z = a.recoilM[k];
        any = Math.max(any, a.flash[k]);
      }
      const u = (mats.flash[t].uniforms.uFlash.value as THREE.Vector3).set(a.flash[0] ?? 0, a.flash[1] ?? 0, a.flash[2] ?? 0);
      rig.flash.visible = any > 0.001 && u.lengthSq() > 0;
    }
    navMesh.visible = anim.nav > 0;
    mats.glow.uniforms.uNav.value = anim.nav;
    if (v.cameraMode !== lastMode) {
      lastMode = v.cameraMode;
      mats.glass.opacity = v.cameraMode === 'cockpit' ? 0.22 : 0.6;
    }
  }

  setVisualState(
    {
      elevator: 0, aileron: 0, rudder: 0, trim: 0, flapsDeg: 0, gearPos: 1,
      wheelCompression: [0, 0, 0], wheelRollSpeed: [0, 0, 0], nosewheelSteer: 0,
      propRpm: 0, engineRunning: false,
      lights: { nav: false, strobe: false, beacon: false, landing: false, taxi: false },
      time: 0, cameraMode: 'chase', instruments: null, vessel: null, turrets: null,
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
      root.removeFromParent();
    },
  };
}
