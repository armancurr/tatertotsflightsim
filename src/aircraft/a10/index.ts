/**
 * Procedural Fairchild Republic A-10C Thunderbolt II "Warthog" (23rd FG "Flying Tigers", Moody AFB,
 * serial 80-0281): exterior, cockpit, animation, lights, stores and crash break-up — built in code.
 *
 *   const hog = createA10Model();
 *   scene.add(hog.root);            // the loop copies the physics pose onto hog.root
 *   hog.setVisualState(v, dt);      // every frame
 *
 * Body frame = three.js object frame (+X right, +Y up, −Z nose, origin = CG). Wheels, wingtips, fin
 * tops, engine pods, the pilot's eye, the GAU-8/A muzzle (`a10.gunMuzzle`) and the four Maverick
 * stations (`a10.store.<i>`, A10_WEAPONS.missiles.stations order) sit on the config geometry (tests
 * hold them to 3 cm). Moving parts: elevators, twin rudders, split decelerons (ailerons + speed
 * brakes), slotted flaps, slats, gear (+ nose doors, steering, compression, spin), fans, the
 * seven-barrel cluster.
 */
import * as THREE from 'three';
import { tint, merge } from '../materials';
import type { AircraftVisualState } from '../types';
import type { AircraftModelHandle, BreakupPart } from '../../fleet/types';
import { A10_AIRCRAFT, A10_WEAPONS } from '../../config';
import { createA10Anim, stepA10Anim, A10_LIMITS } from './animate';
import { buildCockpit, drawScreens, SCREEN_ATLAS } from './cockpit';
import { buildEngine } from './engines';
import { buildFuselage } from './fuselage';
import { buildGear } from './gear';
import { box, ellipsoid, makeHinge, tube, V } from '../f16/geom';
import { paintLivery } from './livery';
import { createA10Materials, type A10Textures } from './materials';
import { buildGun, buildStores } from './stores';
import { buildTail } from './tail';
import { buildCentreWing, buildOuterRight, buildPod, mirrorOuter, type HingedPart } from './wing';
import { GUN, MUZZLE, TAIL_CONE, bodyTopY } from './shape';

export { createA10Anim, stepA10Anim, A10_LIMITS } from './animate';

/** Names of the parts (root.getObjectByName). */
export const A10_PART = {
  root: 'a10',
  fuselage: 'a10.fuselage',
  skin: 'a10.skin',
  forward: 'a10.forwardFuselage',
  forwardSkin: 'a10.forwardSkin',
  centreWing: 'a10.centreWing',
  canopy: 'a10.canopy',
  canopyGlass: 'a10.canopy.glass',
  cockpit: 'a10.cockpit',
  pilotHead: 'a10.pilot.head',
  pilotBody: 'a10.pilot.body',
  leftWing: 'a10.leftWing',
  rightWing: 'a10.rightWing',
  slatLeft: 'a10.slat.left',
  slatRight: 'a10.slat.right',
  flapLeftInner: 'a10.flap.leftInner',
  flapRightInner: 'a10.flap.rightInner',
  flapLeftOuter: 'a10.flap.leftOuter',
  flapRightOuter: 'a10.flap.rightOuter',
  decelLeftUpper: 'a10.decel.leftUpper',
  decelLeftLower: 'a10.decel.leftLower',
  decelRightUpper: 'a10.decel.rightUpper',
  decelRightLower: 'a10.decel.rightLower',
  tail: 'a10.tail',
  elevators: 'a10.elevators',
  rudderLeft: 'a10.rudder.left',
  rudderRight: 'a10.rudder.right',
  engineLeft: 'a10.engine.left',
  engineRight: 'a10.engine.right',
  nacelleLeft: 'a10.engine.left.nacelle',
  nacelleRight: 'a10.engine.right.nacelle',
  fanLeft: 'a10.engine.left.fan',
  fanRight: 'a10.engine.right.fan',
  podLeft: 'a10.pod.left',
  podRight: 'a10.pod.right',
  noseGear: 'a10.noseGear',
  leftMainGear: 'a10.leftMainGear',
  rightMainGear: 'a10.rightMainGear',
  leftGearPod: 'a10.leftGearPod',
  rightGearPod: 'a10.rightGearPod',
  axleNose: 'a10.axle.nose',
  axleLeft: 'a10.axle.left',
  axleRight: 'a10.axle.right',
  gun: 'a10.gun',
  gunCluster: 'a10.gun.cluster',
  gunBlur: 'a10.gun.blur',
  gunMuzzle: 'a10.gunMuzzle',
  store: (i: number) => `a10.store.${i}`,
  landingLight: 'a10.landingLight',
} as const;

const DEG = Math.PI / 180;

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

/** Hinged part → pivot group (in `parent`) with a mesh on its rotating child. */
function hinge(h: HingedPart, name: string, mat: THREE.Material, parent: THREE.Object3D, shadows = false) {
  const r = makeHinge(name, h.position, h.quaternion);
  mesh(h.geometry, mat, `${name}.mesh`, r.rot, shadows);
  parent.add(r.pivot);
  return r;
}

/** Small fuselage details: IFR receptacle, antennas, probes, formation-light strips, tail cone light housing. */
function fuselageDetails(): { forward: THREE.BufferGeometry; main: THREE.BufferGeometry } {
  const f: THREE.BufferGeometry[] = [];
  const m: THREE.BufferGeometry[] = [];
  const DARK = 0x33373a;
  const GREY = 0x6a7074;
  // IFR receptacle (slipway door, slightly proud) on the nose top.
  f.push(tint(box(0.2, 0.012, 0.56, V(0, bodyTopY(-5.9) + 0.004, -5.9), 0.28, 0, 0), 0x3e4245, 0.6, 0.1));
  // Pitot probes on the nose sides, AoA vane.
  for (const s of [-1, 1]) f.push(tint(tube(V(s * 0.36, 0.05, -6.3), V(s * 0.38, 0.05, -6.62), 0.012, 0.007, 6), 0x9a9da0, 0.4, 0.8));
  f.push(tint(box(0.005, 0.05, 0.08, V(0.5, -0.1, -5.9)), 0x9a9da0, 0.4, 0.8));
  // UHF/IFF blades: spine and belly.
  m.push(tint(box(0.012, 0.22, 0.26, V(0, bodyTopY(-1.6) + 0.1, -1.6), -0.45, 0, 0), GREY, 0.55, 0.1));
  m.push(tint(box(0.012, 0.16, 0.2, V(0, -1.12, 1.9), 0.45, 0, 0), GREY, 0.55, 0.1));
  // Tail-cone light housing, chaff/flare dispensers in the gear-pod tails.
  m.push(tint(ellipsoid(V(0, TAIL_CONE.y, TAIL_CONE.z - 0.02), 0.045, 0.045, 0.06, 10, 8), DARK, 0.5, 0.2));
  // Gun port: a gas-deflector lip above the muzzle.
  f.push(tint(box(0.36, 0.02, 0.22, V(GUN.axisX, GUN.axisY + 0.2, GUN.portZ - 0.03)), DARK, 0.6, 0.3));
  return { forward: merge(f), main: merge(m) };
}

export function createA10Model(): AircraftModelHandle {
  const hasDom = typeof document !== 'undefined';
  const fuse = buildFuselage();
  const centre = buildCentreWing();
  const outerR = buildOuterRight();
  const outerL = mirrorOuter(outerR);
  const tailB = buildTail();
  const engR = buildEngine(1);
  const engL = buildEngine(-1);
  const pit = buildCockpit();
  const gunB = buildGun();
  const stores = buildStores();

  // ── Textures (browser only): livery atlas, roughness, panel-line bump, cockpit screens ──
  let textures: A10Textures | null = null;
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
  const mats = createA10Materials(textures);

  const root = group(A10_PART.root);
  const details = fuselageDetails();

  // ── Main fuselage + centre wing section (slats, inboard flaps, GBU-12s) ──
  const fuselage = group(A10_PART.fuselage, root);
  mesh(fuse.main, mats.paint, A10_PART.skin, fuselage);
  mesh(centre.panel, mats.paint, A10_PART.centreWing, fuselage);
  mesh(details.main, mats.parts, 'a10.details', fuselage, false);
  mesh(stores.centre, mats.parts, 'a10.stores.centre', fuselage, true);
  const slatL = hinge(centre.slatLeft, A10_PART.slatLeft, mats.paint, fuselage);
  const slatR = hinge(centre.slatRight, A10_PART.slatRight, mats.paint, fuselage);
  const flapLI = hinge(centre.flapLeft, A10_PART.flapLeftInner, mats.paint, fuselage);
  const flapRI = hinge(centre.flapRight, A10_PART.flapRightInner, mats.paint, fuselage);
  const slatHome = [slatL.pivot.position.clone(), slatR.pivot.position.clone()];

  // ── Forward fuselage: nose, cockpit, GAU-8/A ──
  const forward = group(A10_PART.forward, root);
  mesh(fuse.forward, mats.paint, A10_PART.forwardSkin, forward);
  mesh(merge([details.forward, gunB.port]), mats.parts, 'a10.forward.details', forward, false);
  const gun = group(A10_PART.gun, forward);
  gun.position.copy(gunB.axis);
  const cluster = mesh(gunB.cluster, mats.parts, A10_PART.gunCluster, gun, true);
  const gunBlur = mesh(gunB.blur, mats.gunBlur, A10_PART.gunBlur, gun, false);
  gunBlur.visible = false;
  gunBlur.renderOrder = 1;
  // Gun muzzle marker (the firing barrel, fixed — the cluster turns behind it).
  const muzzle = new THREE.Object3D();
  muzzle.name = A10_PART.gunMuzzle;
  muzzle.position.set(MUZZLE.x, MUZZLE.y, MUZZLE.z);
  forward.add(muzzle);

  const cockpit = group(A10_PART.cockpit, forward);
  mesh(pit.interior, mats.interior, 'a10.cockpit.interior', cockpit, false);
  mesh(pit.pilotBody, mats.parts, A10_PART.pilotBody, cockpit, false);
  const head = mesh(pit.pilotHead, mats.parts, A10_PART.pilotHead, cockpit, false);
  mesh(pit.screens, mats.screens, 'a10.cockpit.screens', cockpit, false);
  mesh(pit.panelFace, mats.panel, 'a10.cockpit.panel', cockpit, false);
  const hudGlass = mesh(pit.hudGlass, mats.hud, 'a10.cockpit.hud', cockpit, false);
  hudGlass.renderOrder = 2;

  // ── Canopy ──
  const canopy = group(A10_PART.canopy, root);
  const glass = mesh(pit.canopyGlass, mats.canopy, A10_PART.canopyGlass, canopy, false);
  glass.renderOrder = 3;
  mesh(pit.canopyFrame, mats.parts, 'a10.canopy.frame', canopy, false);

  // ── Outer wing panels (with their flaps, decelerons, tips and stores) ──
  const wingGroup = (name: string, w: typeof outerR, side: 'left' | 'right') => {
    const g = group(name, root);
    mesh(w.panel, mats.paint, `${name}.panel`, g);
    const flap = hinge(w.flap, side === 'left' ? A10_PART.flapLeftOuter : A10_PART.flapRightOuter, mats.paint, g);
    const du = hinge(w.decelUpper, side === 'left' ? A10_PART.decelLeftUpper : A10_PART.decelRightUpper, mats.paint, g);
    const dl = hinge(w.decelLower, side === 'left' ? A10_PART.decelLeftLower : A10_PART.decelRightLower, mats.paint, g);
    mesh(side === 'left' ? stores.left : stores.right, mats.parts, `${name}.stores`, g, true);
    return { g, flap, du, dl };
  };
  const wl = wingGroup(A10_PART.leftWing, outerL, 'left');
  const wr = wingGroup(A10_PART.rightWing, outerR, 'right');

  // Mavericks: one geometry, four meshes at the stations (hidden as they are fired).
  const stations = A10_WEAPONS.missiles?.stations ?? [];
  const missiles = stations.map((st, i) => {
    const m = new THREE.Mesh(stores.maverick, mats.parts);
    m.name = A10_PART.store(i);
    m.position.set(st.x, st.y, st.z);
    m.castShadow = false;
    m.receiveShadow = true;
    (st.x < 0 ? wl.g : wr.g).add(m);
    return m;
  });

  // ── Tail: stabiliser + fins, elevators, rudders ──
  const tail = group(A10_PART.tail, root);
  mesh(merge([tailB.stab, tailB.finLeft, tailB.finRight]), mats.paint, 'a10.tail.surfaces', tail);
  const elev = makeHinge(A10_PART.elevators, tailB.elevators.position, tailB.elevators.quaternion);
  mesh(tailB.elevators.geometry, mats.paint, `${A10_PART.elevators}.mesh`, elev.rot, true);
  tail.add(elev.pivot);
  const rudL = hinge(tailB.rudderLeft, A10_PART.rudderLeft, mats.paint, tail, true);
  const rudR = hinge(tailB.rudderRight, A10_PART.rudderRight, mats.paint, tail, true);

  // ── Engines ──
  const engineGroup = (name: string, nacelle: string, fanName: string, e: typeof engR) => {
    const g = group(name, root);
    mesh(e.cowl, mats.paint, nacelle, g);
    mesh(e.pylon, mats.paint, `${name}.pylon`, g);
    mesh(e.hot, mats.parts, `${name}.exhaust`, g, true);
    const fan = group(fanName, g);
    fan.position.copy(e.fanCentre);
    const slow = mesh(merge([e.blades, e.spinner.clone()]), mats.parts, `${fanName}.blades`, fan, false);
    const fast = mesh(merge([e.disc, e.spinner]), mats.parts, `${fanName}.disc`, fan, false);
    fast.visible = false;
    return { g, fan, slow, fast };
  };
  const el = engineGroup(A10_PART.engineLeft, A10_PART.nacelleLeft, A10_PART.fanLeft, engL);
  const er = engineGroup(A10_PART.engineRight, A10_PART.nacelleRight, A10_PART.fanRight, engR);

  // ── Gear pods (+ main gear) and the nose gear ──
  const gear = buildGear({
    nose: A10_PART.noseGear,
    left: A10_PART.leftMainGear,
    right: A10_PART.rightMainGear,
    axleNose: A10_PART.axleNose,
    axleLeft: A10_PART.axleLeft,
    axleRight: A10_PART.axleRight,
  });
  const podL = group(A10_PART.leftGearPod, root);
  const podR = group(A10_PART.rightGearPod, root);
  mesh(buildPod(-1), mats.paint, A10_PART.podLeft, podL);
  mesh(buildPod(1), mats.paint, A10_PART.podRight, podR);
  const partsOn = (o: THREE.Object3D) =>
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.isMesh) m.material = mats.parts;
    });
  partsOn(gear.nose.group);
  partsOn(gear.left.group);
  partsOn(gear.right.group);
  partsOn(gear.doors);
  root.add(gear.nose.group);
  podL.add(gear.left.group);
  podR.add(gear.right.group);
  forward.add(gear.doors);
  podL.add(gear.lamps.landing);
  podR.add(gear.lamps.taxi);

  // ── Lights: wingtip nav (red left, green right), white tail light, wingtip strobes ──
  const lens = (p: THREE.Vector3, hex: number) => tint(ellipsoid(p, 0.03, 0.03, 0.05, 10, 8), hex, 0.2, 0);
  const tipL = outerL.tipLight;
  const tipR = outerR.tipLight;
  const tailLight = V(0, TAIL_CONE.y, TAIL_CONE.z - 0.04);
  const navMeshes = [
    mesh(lens(tipL, 0xff2a1a), mats.nav, 'a10.navLight.left', wl.g, false),
    mesh(lens(tipR, 0x20ff60), mats.nav, 'a10.navLight.right', wr.g, false),
    mesh(lens(tailLight, 0xffffff), mats.nav, 'a10.navLight.tail', tail, false),
  ];
  const strobeL = V(tipL.x, tipL.y, tipL.z + 0.55);
  const strobeR = V(tipR.x, tipR.y, tipR.z + 0.55);
  mesh(tint(ellipsoid(strobeL, 0.025, 0.025, 0.04, 10, 8), 0xffffff, 0.2, 0), mats.strobe, 'a10.strobe.left', wl.g, false);
  mesh(tint(ellipsoid(strobeR, 0.025, 0.025, 0.04, 10, 8), 0xffffff, 0.2, 0), mats.strobe, 'a10.strobe.right', wr.g, false);
  const lampGeo = (p: THREE.Object3D) => tint(new THREE.CircleGeometry(0.07, 16).rotateY(Math.PI).translate(p.position.x, p.position.y, p.position.z - 0.005), 0xffffff, 0.2);
  mesh(lampGeo(gear.lamps.landing), mats.lamp, 'a10.landingLamp', podL, false);
  mesh(lampGeo(gear.lamps.taxi), mats.lamp, 'a10.taxiLamp', podR, false);

  // Glow sprites (one Points draw): nav red, nav green, tail white, strobe L, strobe R, landing, taxi.
  const glowCount = 7;
  const gpos = new Float32Array(glowCount * 3);
  const glowGeo = new THREE.BufferGeometry();
  const glowPos = new THREE.BufferAttribute(gpos, 3);
  glowPos.setUsage(THREE.DynamicDrawUsage);
  glowGeo.setAttribute('position', glowPos);
  glowGeo.setAttribute('glowColor', new THREE.BufferAttribute(new Float32Array([1.6, 0.08, 0.04, 0.1, 1.5, 0.35, 1.1, 1.1, 1.05, 9, 9, 9.5, 9, 9, 9.5, 5, 4.7, 4.3, 3.5, 3.3, 3]), 3));
  glowGeo.setAttribute('size', new THREE.BufferAttribute(new Float32Array([0.22, 0.22, 0.16, 1.1, 1.1, 0.55, 0.45]), 1));
  glowGeo.setAttribute('aDir', new THREE.BufferAttribute(new Float32Array([-0.6, 0, -0.8, 0.6, 0, -0.8, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, -0.1, -1, 0, -0.1, -1]), 3));
  const glowIntensity = new THREE.BufferAttribute(new Float32Array(glowCount), 1);
  glowIntensity.setUsage(THREE.DynamicDrawUsage);
  glowGeo.setAttribute('intensity', glowIntensity);
  glowGeo.boundingSphere = new THREE.Sphere(V(0, 0, 0), 14);
  const glows = new THREE.Points(glowGeo, mats.glow);
  glows.name = 'a10.lightGlows';
  glows.frustumCulled = false;
  glows.renderOrder = 5;
  glows.userData.noBounds = true;
  const _buf = new THREE.Vector2();
  glows.onBeforeRender = (renderer) => {
    renderer.getDrawingBufferSize(_buf);
    mats.glow.uniforms.uHalfHeight.value = _buf.y * 0.5;
  };
  root.add(glows);
  tipL.toArray(gpos, 0);
  tipR.toArray(gpos, 3);
  tailLight.toArray(gpos, 6);
  strobeL.toArray(gpos, 9);
  strobeR.toArray(gpos, 12);
  gear.lamps.landing.position.toArray(gpos, 15);
  gear.lamps.taxi.position.toArray(gpos, 18);

  // Landing light (the only real light): left pod nose, aimed ahead and down.
  const LL = A10_AIRCRAFT.model.landingLight;
  const landingLight = new THREE.SpotLight(0xfff4e6, 0, LL.range, LL.angleDeg * DEG, LL.penumbra, LL.decay);
  landingLight.name = A10_PART.landingLight;
  landingLight.castShadow = false;
  landingLight.visible = false;
  landingLight.position.copy(gear.lamps.landing.position);
  landingLight.target.position.copy(gear.lamps.landing.position).add(V(0, -4, -50));
  root.add(landingLight, landingLight.target);

  // ── Break-up parts ──
  const breakup: BreakupPart[] = [
    { name: 'fuselage', object: fuselage, mass: 5200, burning: true },
    { name: 'noseSection', object: forward, mass: 2400 },
    { name: 'canopy', object: canopy, mass: 120 },
    { name: 'leftWing', object: wl.g, mass: 1300, burning: true },
    { name: 'rightWing', object: wr.g, mass: 1300, burning: true },
    { name: 'tail', object: tail, mass: 520 },
    { name: 'leftEngine', object: el.g, mass: 780, burning: true },
    { name: 'rightEngine', object: er.g, mass: 780, burning: true },
    { name: 'noseGear', object: gear.nose.group, mass: 130 },
    { name: 'leftMainGear', object: podL, mass: 380 },
    { name: 'rightMainGear', object: podR, mass: 380 },
  ];
  const home = breakup.map((b) => ({ part: b, parent: b.object.parent!, p: b.object.position.clone(), q: b.object.quaternion.clone(), s: b.object.scale.clone() }));

  // ── Per-frame state ──
  const anim = createA10Anim();
  let lastMode: string | null = null;
  const strobeOff = new THREE.Color(0xbfc4c8);
  const strobeOn = new THREE.Color(0xffffff).multiplyScalar(7);
  const lampOff = new THREE.Color(0x9aa0a4);
  const lampOn = new THREE.Color(0xfff6e8).multiplyScalar(5);
  const gi = glowIntensity.array as Float32Array;
  let wrecked = false;
  const SLAT_OUT = V(0, -0.05, -0.16);

  function setVisualState(v: AircraftVisualState, dt: number) {
    stepA10Anim(v, anim, dt);
    const crashed = v.crashed === true;
    mats.char.value = crashed ? Math.min(1, Math.max(0, Number(v.crashAge ?? 0)) / 6) : 0;
    if (crashed !== wrecked) {
      wrecked = crashed;
      glass.visible = !crashed;
      hudGlass.visible = !crashed;
    }

    // Control surfaces (trailing edge down = +rotation about each hinge's +X).
    elev.rot.rotation.x = anim.elevatorRad;
    rudL.rot.rotation.y = anim.rudderRad;
    rudR.rot.rotation.y = anim.rudderRad;
    wl.du.rot.rotation.x = anim.decelLeftUpperRad;
    wl.dl.rot.rotation.x = anim.decelLeftLowerRad;
    wr.du.rot.rotation.x = anim.decelRightUpperRad;
    wr.dl.rot.rotation.x = anim.decelRightLowerRad;
    flapLI.rot.rotation.x = anim.flapRad;
    flapRI.rot.rotation.x = anim.flapRad;
    wl.flap.rot.rotation.x = anim.flapRad;
    wr.flap.rot.rotation.x = anim.flapRad;
    // Slats run forward/down on tracks and droop.
    slatL.pivot.position.copy(slatHome[0]).addScaledVector(SLAT_OUT, anim.slat);
    slatR.pivot.position.copy(slatHome[1]).addScaledVector(SLAT_OUT, anim.slat);
    slatL.rot.rotation.x = -anim.slat * 18 * DEG;
    slatR.rot.rotation.x = -anim.slat * 18 * DEG;

    gear.update(anim);

    // Fans and the gun.
    el.fan.rotation.z = anim.fanAngle;
    er.fan.rotation.z = -anim.fanAngle;
    const fast = anim.fanBlur > 0.5;
    el.slow.visible = er.slow.visible = !fast;
    el.fast.visible = er.fast.visible = fast;
    gun.rotation.z = anim.gunAngle;
    gunBlur.visible = anim.gunBlur > 0.01;
    mats.gunBlur.opacity = 0.85 * anim.gunBlur;

    // Stores: a missile hangs on each station until it is fired.
    for (let i = 0; i < missiles.length; i++) missiles[i].visible = v.stores?.[i] !== false;

    // Lights.
    for (const n of navMeshes) n.visible = anim.nav > 0;
    mats.strobe.color.copy(strobeOff).lerp(strobeOn, anim.strobe);
    const lampLevel = Math.max(anim.landing, anim.taxi * 0.7);
    mats.lamp.color.copy(lampOff).lerp(lampOn, lampLevel);
    gi[0] = gi[1] = gi[2] = anim.nav;
    gi[3] = gi[4] = anim.strobe;
    gi[5] = anim.landing;
    gi[6] = anim.taxi;
    glowIntensity.needsUpdate = true;
    landingLight.visible = lampLevel > 0;
    if (landingLight.visible) landingLight.intensity = LL.intensity * (anim.landing > 0 ? 1 : 0.45);

    // Cockpit presentation.
    if (v.cameraMode !== lastMode) {
      lastMode = v.cameraMode;
      const inCockpit = v.cameraMode === 'cockpit';
      head.visible = !inCockpit;
      mats.canopy.opacity = inCockpit ? 0.1 : 0.26;
      mats.canopy.envMapIntensity = inCockpit ? 0.35 : 1.2;
      mats.interior.color.setScalar(inCockpit ? 1.25 : 0.75);
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
  void cluster;

  return {
    root,
    setVisualState,
    landingLight,
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
      landingLight.dispose();
      for (const h of home) h.part.object.removeFromParent();
      root.removeFromParent();
    },
  };
}
