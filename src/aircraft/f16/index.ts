/**
 * Procedural USAF F-16C Block 50 "Fighting Falcon" (serial 90-0772): exterior, cockpit, animation,
 * afterburner plume, lights and crash break-up — built entirely in code.
 *
 *   const jet = createF16Model();
 *   scene.add(jet.root);            // the loop copies the physics pose onto jet.root
 *   jet.setVisualState(v, dt);      // every frame
 *
 * Body frame = three.js object frame (+X right, +Y up, −Z nose, origin = CG). Wheels, wingtips,
 * stabilator tips, fin top and the pilot's eye sit on F16_AIRCRAFT.geometry (tests hold them to
 * 3 cm). Moving parts: stabilators, flaperons, LEFs, rudder, speed brakes, gear (+ doors, steering,
 * compression, spin), nozzle petals, afterburner plume.
 */
import * as THREE from 'three';
import { tint, merge } from '../materials';
import type { AircraftVisualState } from '../types';
import type { AircraftModelHandle, BreakupPart } from '../../fleet/types';
import { createF16Anim, stepF16Anim } from './animate';
import { buildCockpit, combinerMatrix, drawScreens, SCREEN_ATLAS } from './cockpit';
import { buildFuselage } from './fuselage';
import { buildGear } from './gear';
import { box, ellipsoid, makeHinge, tube, V } from './geom';
import { paintLivery } from './livery';
import { createF16Materials, type F16Textures } from './materials';
import { buildNozzle, buildPlume } from './nozzle';
import { ANCHOR, GUN_MUZZLE } from './shape';
import { F16_AIRCRAFT, F16_WEAPONS } from '../../config';
import { buildMaverick } from '../a10/stores';
import { buildSurfaces, type HingedPart } from './surfaces';

export { createF16Anim, stepF16Anim, F16_LIMITS } from './animate';

/** Names of the parts (root.getObjectByName). */
export const F16_PART = {
  root: 'f16',
  fuselage: 'f16.fuselage',
  skin: 'f16.skin',
  noseCone: 'f16.noseCone',
  canopy: 'f16.canopy',
  canopyGlass: 'f16.canopy.glass',
  cockpit: 'f16.cockpit',
  pilotHead: 'f16.pilot.head',
  pilotBody: 'f16.pilot.body',
  leftWing: 'f16.leftWing',
  rightWing: 'f16.rightWing',
  lefLeft: 'f16.lef.left',
  lefRight: 'f16.lef.right',
  flaperonLeft: 'f16.flaperon.left',
  flaperonRight: 'f16.flaperon.right',
  tail: 'f16.tail',
  rudder: 'f16.rudder',
  leftStab: 'f16.leftStab',
  rightStab: 'f16.rightStab',
  speedBrakeUpperLeft: 'f16.speedBrake.upperLeft',
  speedBrakeLowerLeft: 'f16.speedBrake.lowerLeft',
  speedBrakeUpperRight: 'f16.speedBrake.upperRight',
  speedBrakeLowerRight: 'f16.speedBrake.lowerRight',
  engine: 'f16.engine',
  nozzle: 'f16.nozzle',
  plume: 'f16.plume',
  noseGear: 'f16.noseGear',
  leftMainGear: 'f16.leftMainGear',
  rightMainGear: 'f16.rightMainGear',
  axleNose: 'f16.axle.nose',
  axleLeft: 'f16.axle.left',
  axleRight: 'f16.axle.right',
  landingLight: 'f16.landingLight',
  gunMuzzle: 'gunMuzzle',
} as const;

const DEG = Math.PI / 180;

export { GUN_MUZZLE };

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
  m.receiveShadow = shadows;
  parent.add(m);
  return m;
}

/** Hinged part → pivot group (in `parent`) with a mesh on its rotating child. */
function hinge(h: HingedPart, name: string, mat: THREE.Material, parent: THREE.Object3D) {
  const r = makeHinge(name, h.position, h.quaternion);
  mesh(h.geometry, mat, `${name}.mesh`, r.rot);
  parent.add(r.pivot);
  return r;
}

/** Fuselage details: pitot is on the nose cone; here antennas, probes, IFF "bird slicers", gun port. */
function fuselageDetails(): THREE.BufferGeometry {
  const g: THREE.BufferGeometry[] = [];
  const DARK = 0x3d4145;
  const GREY = 0x6f7478;
  // AOA probes and total-temperature probe on the nose sides.
  for (const s of [-1, 1]) {
    g.push(tint(tube(V(s * 0.46, -0.1, -6.28), V(s * 0.53, -0.1, -6.38), 0.012, 0.006, 6), 0x9a9da0, 0.4, 0.8));
    g.push(tint(box(0.004, 0.05, 0.07, V(s * 0.53, -0.1, -6.4)), 0x9a9da0, 0.4, 0.8));
  }
  // Block 50 IFF interrogator "bird slicer" blades ahead of the windscreen.
  for (const x of [-0.15, -0.05, 0.05, 0.15]) g.push(tint(box(0.005, 0.05, 0.07, V(x, 0.44 - Math.abs(x) * 0.25, -6.42), -0.45, 0, 0), DARK, 0.6, 0.1));
  // UHF blade on the spine, UHF/IFF blade under the intake.
  g.push(tint(box(0.012, 0.2, 0.22, V(0, 0.84, -1.55), -0.5, 0, 0), GREY, 0.55, 0.1));
  g.push(tint(box(0.012, 0.13, 0.17, V(0, -0.93, -1.9), 0.5, 0, 0), GREY, 0.55, 0.1));
  // TACAN / ECM blades under the aft fuselage.
  g.push(tint(box(0.01, 0.12, 0.16, V(0, -0.84, 1.6), 0.45, 0, 0), GREY, 0.55, 0.1));
  // M61A1 gun port (left strake root, above the intake shoulder) with its gas-vent louvres behind.
  const m = GUN_MUZZLE;
  g.push(tint(ellipsoid(V(m.x + 0.005, m.y, m.z + 0.13), 0.034, 0.036, 0.14, 10, 8), 0x0b0b0b, 0.7, 0.2));
  for (let k = 0; k < 4; k++) g.push(tint(box(0.02, 0.006, 0.05, V(m.x - 0.02 - k * 0.025, m.y - 0.035 - k * 0.006, m.z + 0.42)), 0x121212, 0.7, 0.2));
  // Intake-side position-light housings.
  for (const s of [-1, 1]) g.push(tint(box(0.012, 0.05, 0.1, V(s * 0.565, -0.46, -3.72)), 0x2a2a2a, 0.4, 0.2));
  // Chaff/flare dispensers (ALE-47) under the aft fuselage.
  for (const s of [-1, 1]) g.push(tint(box(0.16, 0.012, 0.32, V(s * 0.36, -0.7, 3.25)), 0x2a2c2e, 0.7, 0.1));
  // Air-refuelling receptacle door outline (slightly proud).
  g.push(tint(box(0.22, 0.008, 0.46, V(0, 0.739, -1.02), 0.06, 0, 0), 0x55595c, 0.55, 0.1));
  return merge(g);
}

export function createF16Model(): AircraftModelHandle {
  const hasDom = typeof document !== 'undefined';
  const fuse = buildFuselage();
  const surf = buildSurfaces();
  const pit = buildCockpit();

  // ── Textures (browser only): livery atlas, roughness, panel-line bump, cockpit screens ──
  let textures: F16Textures | null = null;
  if (hasDom) {
    const liv = paintLivery(fuse.stations);
    const sc = document.createElement('canvas');
    sc.width = SCREEN_ATLAS.width;
    sc.height = SCREEN_ATLAS.height;
    const sctx = sc.getContext('2d');
    if (liv && sctx) {
      drawScreens(sctx, sc.width, sc.height);
      const screens = new THREE.CanvasTexture(sc);
      screens.colorSpace = THREE.SRGBColorSpace;
      textures = { ...liv, screens };
    }
  }
  const mats = createF16Materials(textures);

  const root = group(F16_PART.root);
  // ── Fuselage (+ intake, ventrals, cockpit, speed brakes, lights) ──
  const fuselage = group(F16_PART.fuselage, root);
  const skinGeo = merge([fuse.skin, surf.ventrals]);
  const skin = mesh(skinGeo, mats.paint, F16_PART.skin, fuselage);
  mesh(fuse.duct, mats.parts, 'f16.intakeDuct', fuselage, false);
  // Small parts don't cast shadows (fewer shadow-pass draws); they still receive them.
  mesh(fuselageDetails(), mats.parts, 'f16.details', fuselage, false).receiveShadow = true;

  // Gun muzzle marker for the weapons system (rides with the fuselage).
  const muzzle = new THREE.Object3D();
  muzzle.name = F16_PART.gunMuzzle;
  muzzle.position.set(GUN_MUZZLE.x, GUN_MUZZLE.y, GUN_MUZZLE.z);
  fuselage.add(muzzle);

  const cockpit = group(F16_PART.cockpit, fuselage);
  mesh(pit.interior, mats.interior, 'f16.cockpit.interior', cockpit, false).receiveShadow = true;
  mesh(pit.pilotBody, mats.parts, F16_PART.pilotBody, cockpit, false).receiveShadow = true;
  const head = mesh(pit.pilotHead, mats.parts, F16_PART.pilotHead, cockpit, false);
  head.receiveShadow = true;
  mesh(pit.screens, mats.screens, 'f16.cockpit.screens', cockpit, false);
  mesh(pit.panelFace, mats.panel, 'f16.cockpit.panel', cockpit, false).receiveShadow = true;
  const hudGlass = mesh(pit.hudGlass, mats.hud, 'f16.cockpit.hud', cockpit, false);
  combinerMatrix().decompose(hudGlass.position, hudGlass.quaternion, hudGlass.scale);
  hudGlass.renderOrder = 2;

  const sb = surf.speedBrakes;
  const brakes = {
    ul: hinge(sb.upperLeft, F16_PART.speedBrakeUpperLeft, mats.paint, fuselage),
    ll: hinge(sb.lowerLeft, F16_PART.speedBrakeLowerLeft, mats.paint, fuselage),
    ur: hinge(sb.upperRight, F16_PART.speedBrakeUpperRight, mats.paint, fuselage),
    lr: hinge(sb.lowerRight, F16_PART.speedBrakeLowerRight, mats.paint, fuselage),
  };

  // ── Nose cone: radome + pitot boom ──
  const noseCone = group(F16_PART.noseCone, root);
  mesh(fuse.radome, mats.radome, 'f16.radome', noseCone);
  const tip = ANCHOR.noseTip;
  const pitot = ANCHOR.pitotTip;
  mesh(
    merge([
      tint(tube(V(0, tip.y, tip.z + 0.05), V(0, pitot.y, pitot.z + 0.12), 0.03, 0.014, 10), 0x8e9194, 0.35, 0.8),
      tint(tube(V(0, pitot.y, pitot.z + 0.12), V(0, pitot.y, pitot.z + 0.005), 0.011, 0.011, 8), 0x9ea1a4, 0.3, 0.9),
      tint(ellipsoid(V(0, pitot.y, pitot.z + 0.012), 0.011, 0.011, 0.012, 8, 6), 0x9ea1a4, 0.3, 0.9),
      tint(tube(V(0, tip.y, tip.z + 0.2), V(0, tip.y, tip.z + 0.06), 0.045, 0.03, 12), 0x55595c, 0.5, 0.3),
    ]),
    mats.parts,
    'f16.pitot',
    noseCone,
  );

  // ── Canopy ──
  const canopy = group(F16_PART.canopy, root);
  const glass = mesh(pit.canopyGlass, mats.canopy, F16_PART.canopyGlass, canopy, false);
  glass.renderOrder = 3;
  mesh(pit.canopyFrame, mats.parts, 'f16.canopy.frame', canopy, false).receiveShadow = true;

  // ── Wings ──
  const wingGroup = (name: string, w: typeof surf.wingLeft, side: 'left' | 'right') => {
    const g = group(name, root);
    mesh(w.panel, mats.paint, `${name}.panel`, g);
    const lef = hinge(w.lef, side === 'left' ? F16_PART.lefLeft : F16_PART.lefRight, mats.paint, g);
    const flap = hinge(w.flaperon, side === 'left' ? F16_PART.flaperonLeft : F16_PART.flaperonRight, mats.paint, g);
    mesh(w.tip, mats.parts, `${name}.tipStore`, g);
    return { g, lef, flap };
  };
  const wl = wingGroup(F16_PART.leftWing, surf.wingLeft, 'left');
  const wr = wingGroup(F16_PART.rightWing, surf.wingRight, 'right');

  // ── Stores: a pylon + LAU-117 rail under stations 3 and 7, each with an AGM-65 (hidden once fired) ──
  const mavGeo = buildMaverick();
  const storeMeshes: THREE.Mesh[] = [];
  (F16_WEAPONS.missiles?.stations ?? []).forEach((st, i) => {
    const wing = st.x < 0 ? wl.g : wr.g;
    const top = -0.33; // wing lower surface at this station
    const railY = st.y + 0.2;
    const pylonGeo = merge([
      tint(box(0.1, top - railY - 0.04, 1.5, V(st.x, (top + railY) / 2, st.z + 0.15)), 0x8e969c, 0.55, 0.15),
      tint(box(0.16, 0.1, 2.0, V(st.x, railY, st.z)), 0x6b7176, 0.6, 0.15),
    ]);
    mesh(pylonGeo, mats.parts, `f16.pylon.${i}`, wing, false);
    const mav = mesh(mavGeo, mats.parts, `f16.store.${i}`, wing);
    mav.position.set(st.x, st.y, st.z);
    storeMeshes.push(mav);
  });

  // ── Tail: fin, rudder, fin details and lights ──
  const tail = group(F16_PART.tail, root);
  mesh(surf.fin, mats.paint, 'f16.fin', tail);
  const rudder = hinge(surf.rudder, F16_PART.rudder, mats.paint, tail);
  mesh(surf.finDetails, mats.parts, 'f16.fin.details', tail, false).receiveShadow = true;

  // ── Stabilators (each pivot group is a break-up part) ──
  const stabL = makeHinge(F16_PART.leftStab + '.rot', surf.stabLeft.position, surf.stabLeft.quaternion);
  stabL.pivot.name = F16_PART.leftStab;
  mesh(surf.stabLeft.geometry, mats.paint, 'f16.leftStab.mesh', stabL.rot);
  root.add(stabL.pivot);
  const stabR = makeHinge(F16_PART.rightStab + '.rot', surf.stabRight.position, surf.stabRight.quaternion);
  stabR.pivot.name = F16_PART.rightStab;
  mesh(surf.stabRight.geometry, mats.paint, 'f16.rightStab.mesh', stabR.rot);
  root.add(stabR.pivot);

  // ── Engine: nozzle + plume ──
  const engine = group(F16_PART.engine, root);
  const nozzle = buildNozzle(F16_PART.nozzle);
  engine.add(nozzle.group);
  const plume = buildPlume(F16_PART.plume);
  // The plume hangs off the root, not the engine break-up part (it goes out in a crash and must not
  // inflate the engine's collision box).
  root.add(plume.mesh);
  mats.all.push(nozzle.material, plume.mesh.material as THREE.Material);

  // ── Gear ──
  const gear = buildGear({
    nose: F16_PART.noseGear,
    left: F16_PART.leftMainGear,
    right: F16_PART.rightMainGear,
    axleNose: F16_PART.axleNose,
    axleLeft: F16_PART.axleLeft,
    axleRight: F16_PART.axleRight,
  });
  for (const L of [gear.nose, gear.left, gear.right]) {
    L.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.material = mats.parts;
    });
    root.add(L.group);
  }
  gear.doors.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh) m.material = mats.parts;
  });
  fuselage.add(gear.doors);

  // ── Lights ──
  const navL = V(-0.572, -0.46, -3.72);
  const navR = V(0.572, -0.46, -3.72);
  const lens = (p: THREE.Vector3, hex: number) => tint(ellipsoid(p, 0.012, 0.022, 0.04, 10, 8), hex, 0.2, 0);
  const navMesh = mesh(merge([lens(navL, 0xff2a1a), lens(navR, 0x20ff60)]), mats.nav, 'f16.navLights', fuselage, false);
  const fl = surf.finLights;
  const tailLens = mesh(tint(ellipsoid(fl.tail, 0.014, 0.018, 0.016, 10, 8), 0xffffff, 0.2, 0), mats.nav, 'f16.tailLight', tail, false);
  const strobeMesh = mesh(ellipsoid(fl.strobe, 0.02, 0.022, 0.035, 10, 8), mats.strobe, 'f16.strobe', tail, false);
  // Formation strip lights: nose sides under the canopy, aft fuselage sides, fin sides.
  const strip = (c: THREE.Vector3, w: number, h: number, rotY: number) => {
    const g = new THREE.PlaneGeometry(w, h);
    g.rotateY(rotY);
    g.translate(c.x, c.y, c.z);
    return g;
  };
  const fuseStrips = mesh(
    merge([
      tint(strip(V(0.593, 0.0, -5.0), 0.28, 0.035, Math.PI / 2 - 0.08), 0xffffff, 0.5),
      tint(strip(V(-0.593, 0.0, -5.0), 0.28, 0.035, -Math.PI / 2 + 0.08), 0xffffff, 0.5),
      tint(strip(V(0.83, 0.03, 3.1), 0.3, 0.035, Math.PI / 2 - 0.35), 0xffffff, 0.5),
      tint(strip(V(-0.83, 0.03, 3.1), 0.3, 0.035, -Math.PI / 2 + 0.35), 0xffffff, 0.5),
    ]),
    mats.formation,
    'f16.formationLights',
    fuselage,
    false,
  );
  const finStrips = mesh(
    merge([
      tint(strip(V(0.022, 2.62, 4.72), 0.035, 0.25, Math.PI / 2), 0xffffff, 0.5),
      tint(strip(V(-0.022, 2.62, 4.72), 0.035, 0.25, -Math.PI / 2), 0xffffff, 0.5),
    ]),
    mats.formation,
    'f16.finFormationLights',
    tail,
    false,
  );
  const lampMesh = new THREE.Mesh(merge([tint(new THREE.CircleGeometry(0.045, 16).rotateY(Math.PI), 0xffffff, 0.2)]), mats.lamp);
  lampMesh.name = 'f16.landingLamp';
  gear.lamps.landing.add(lampMesh);

  // Glow sprites (one Points draw): nav red, nav green, tail white, strobe, landing, taxi.
  const glowCount = 6;
  const gpos = new Float32Array(glowCount * 3);
  const glowGeo = new THREE.BufferGeometry();
  const glowPos = new THREE.BufferAttribute(gpos, 3);
  glowPos.setUsage(THREE.DynamicDrawUsage);
  glowGeo.setAttribute('position', glowPos);
  glowGeo.setAttribute('glowColor', new THREE.BufferAttribute(new Float32Array([1.6, 0.08, 0.04, 0.1, 1.5, 0.35, 1.1, 1.1, 1.05, 9, 9, 9.5, 5, 4.7, 4.3, 3.5, 3.3, 3]), 3));
  glowGeo.setAttribute('size', new THREE.BufferAttribute(new Float32Array([0.2, 0.2, 0.16, 1.2, 0.5, 0.35]), 1));
  glowGeo.setAttribute('aDir', new THREE.BufferAttribute(new Float32Array([-0.8, 0, -0.6, 0.8, 0, -0.6, 0, 0, 1, 0, 0, 0, 0, -0.1, -1, 0, -0.1, -1]), 3));
  const glowIntensity = new THREE.BufferAttribute(new Float32Array(glowCount), 1);
  glowIntensity.setUsage(THREE.DynamicDrawUsage);
  glowGeo.setAttribute('intensity', glowIntensity);
  glowGeo.boundingSphere = new THREE.Sphere(V(0, 0, 0), 12);
  const glows = new THREE.Points(glowGeo, mats.glow);
  glows.name = 'f16.lightGlows';
  glows.frustumCulled = false;
  glows.renderOrder = 5;
  glows.userData.noBounds = true;
  const _buf = new THREE.Vector2();
  glows.onBeforeRender = (renderer) => {
    renderer.getDrawingBufferSize(_buf);
    mats.glow.uniforms.uHalfHeight.value = _buf.y * 0.5;
  };
  root.add(glows);
  navL.toArray(gpos, 0);
  navR.toArray(gpos, 3);
  V(fl.tail.x, fl.tail.y, fl.tail.z + 0.02).toArray(gpos, 6);
  V(fl.strobe.x, fl.strobe.y + 0.02, fl.strobe.z).toArray(gpos, 9);

  // Landing light (the only real light): left main door, aimed ahead and down.
  const LL = F16_AIRCRAFT.model.landingLight;
  const landingLight = new THREE.SpotLight(0xfff4e6, 0, LL.range, LL.angleDeg * DEG, LL.penumbra, LL.decay);
  landingLight.name = F16_PART.landingLight;
  landingLight.castShadow = false;
  landingLight.visible = false;
  root.add(landingLight, landingLight.target);

  // ── Break-up parts ──
  const breakup: BreakupPart[] = [
    { name: 'fuselage', object: fuselage, mass: 5600, burning: true },
    { name: 'noseCone', object: noseCone, mass: 60 },
    { name: 'canopy', object: canopy, mass: 90 },
    { name: 'leftWing', object: wl.g, mass: 950, burning: true },
    { name: 'rightWing', object: wr.g, mass: 950, burning: true },
    { name: 'tail', object: tail, mass: 260 },
    { name: 'leftStab', object: stabL.pivot, mass: 180 },
    { name: 'rightStab', object: stabR.pivot, mass: 180 },
    { name: 'engine', object: engine, mass: 1800, burning: true },
    { name: 'noseGear', object: gear.nose.group, mass: 70 },
    { name: 'leftMainGear', object: gear.left.group, mass: 190 },
    { name: 'rightMainGear', object: gear.right.group, mass: 190 },
  ];
  const home = breakup.map((b) => ({
    part: b,
    parent: b.object.parent!,
    p: b.object.position.clone(),
    q: b.object.quaternion.clone(),
    s: b.object.scale.clone(),
  }));

  // ── Per-frame state ──
  const anim = createF16Anim();
  let lastMode: string | null = null;
  const strobeOff = new THREE.Color(0xbfc4c8);
  const strobeOn = new THREE.Color(0xffffff).multiplyScalar(7);
  const formOff = new THREE.Color(0x2a3326);
  const formOn = new THREE.Color(0.35, 0.85, 0.42).multiplyScalar(0.55);
  const lampOff = new THREE.Color(0x9aa0a4);
  const lampOn = new THREE.Color(0xfff6e8).multiplyScalar(5);
  const gi = glowIntensity.array as Float32Array;
  const _v = new THREE.Vector3();
  const _inv = new THREE.Matrix4();
  let wrecked = false;

  function setVisualState(v: AircraftVisualState, dt: number) {
    stepF16Anim(v, anim, dt);
    for (let i = 0; i < storeMeshes.length; i++) storeMeshes[i].visible = v.stores?.[i] ?? true;
    const crashed = v.crashed === true;
    mats.char.value = crashed ? Math.min(1, Math.max(0, Number(v.crashAge ?? 0)) / 6) : 0;
    if (crashed !== wrecked) {
      wrecked = crashed;
      glass.visible = !crashed;
      hudGlass.visible = !crashed;
    }

    // Surfaces (trailing edge down = +rotation about each hinge's +X).
    stabL.rot.rotation.x = anim.stabLeftRad;
    stabR.rot.rotation.x = anim.stabRightRad;
    wl.flap.rot.rotation.x = anim.flaperonLeftRad;
    wr.flap.rot.rotation.x = anim.flaperonRightRad;
    wl.lef.rot.rotation.x = -anim.lefRad;
    wr.lef.rot.rotation.x = -anim.lefRad;
    rudder.rot.rotation.y = anim.rudderRad;
    brakes.ul.rot.rotation.x = anim.speedBrakeRad;
    brakes.ur.rot.rotation.x = anim.speedBrakeRad;
    brakes.ll.rot.rotation.x = -anim.speedBrakeRad;
    brakes.lr.rot.rotation.x = -anim.speedBrakeRad;

    gear.update(anim);

    // Engine.
    nozzle.setOpen(anim.nozzleOpen);
    nozzle.heat.value = anim.heat;
    plume.mesh.visible = anim.ab > 0.01;
    plume.uniforms.uAB.value = anim.ab;
    plume.uniforms.uTime.value = Number.isFinite(v.time) ? v.time % 1000 : 0;
    plume.uniforms.uLen.value = 0.55 + 0.45 * anim.ab;

    // Lights.
    navMesh.visible = anim.nav > 0;
    tailLens.visible = anim.nav > 0;
    mats.strobe.color.copy(strobeOff).lerp(strobeOn, anim.strobe);
    mats.formation.color.copy(formOff).lerp(formOn, anim.formation);
    const lampLevel = Math.max(anim.landing, anim.taxi * 0.7);
    mats.lamp.color.copy(lampOff).lerp(lampOn, lampLevel);
    root.updateMatrixWorld();
    _inv.copy(root.matrixWorld).invert();
    _v.setFromMatrixPosition(gear.lamps.landing.matrixWorld).applyMatrix4(_inv).toArray(gpos, 12);
    _v.setFromMatrixPosition(gear.lamps.taxi.matrixWorld).applyMatrix4(_inv).toArray(gpos, 15);
    glowPos.needsUpdate = true;
    gi[0] = gi[1] = gi[2] = anim.nav;
    gi[3] = anim.strobe;
    gi[4] = anim.landing;
    gi[5] = anim.taxi;
    glowIntensity.needsUpdate = true;
    landingLight.visible = lampLevel > 0;
    if (landingLight.visible) {
      landingLight.intensity = LL.intensity * (anim.landing > 0 ? 1 : 0.45);
      landingLight.position.set(gpos[12], gpos[13], gpos[14]);
      landingLight.target.position.set(gpos[12], gpos[13] - 4, gpos[14] - 50);
    }

    // Cockpit presentation.
    if (v.cameraMode !== lastMode) {
      lastMode = v.cameraMode;
      const inCockpit = v.cameraMode === 'cockpit';
      head.visible = !inCockpit;
      mats.canopy.opacity = inCockpit ? 0.12 : 0.34;
      mats.canopy.envMapIntensity = inCockpit ? 0.35 : 1.3;
      mats.interior.color.setScalar(inCockpit ? 1 : 0.7);
    }
  }

  setVisualState(
    {
      elevator: 0, aileron: 0, rudder: 0, trim: 0, flapsDeg: 0, gearPos: 1,
      wheelCompression: [0, 0, 0], wheelRollSpeed: [0, 0, 0], nosewheelSteer: 0,
      propRpm: 0, engineRunning: false,
      lights: { nav: false, strobe: false, beacon: false, landing: false, taxi: false },
      time: 0, cameraMode: 'chase', instruments: null,
    },
    0,
  );

  return {
    root,
    setVisualState,
    landingLight,
    hudCombiner: hudGlass,
    getBreakupParts: () => breakup,
    restoreBreakupParts() {
      for (const h of home) {
        const o = h.part.object;
        if (o.parent !== h.parent) h.parent.add(o);
        o.position.copy(h.p);
        o.quaternion.copy(h.q);
        o.scale.copy(h.s);
        o.visible = true;
      }
      root.updateMatrixWorld(true);
    },
    dispose() {
      // Parts may be detached into the scene by the crash system: dispose through the records.
      const seen = new Set<THREE.BufferGeometry>();
      const visit = (o: THREE.Object3D) =>
        o.traverse((c) => {
          const m = c as THREE.Mesh;
          if (m.geometry && !seen.has(m.geometry)) {
            seen.add(m.geometry);
            m.geometry.dispose();
          }
        });
      visit(root);
      for (const h of home) visit(h.part.object);
      for (const m of mats.all) m.dispose();
      if (textures) for (const t of Object.values(textures)) t.dispose();
      nozzle.petals.dispose();
      landingLight.dispose();
      for (const h of home) h.part.object.removeFromParent();
      root.removeFromParent();
    },
  };
}
