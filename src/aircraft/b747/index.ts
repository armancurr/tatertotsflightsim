/**
 * Procedural Boeing 747-400 "Tater Airways" (N747TT): exterior, animation, lights and crash
 * break-up — built in code. The flight-deck interior is its own module (flightDeck.ts), hosted in
 * the `b747.flightDeck` group on the nose section (so it breaks away with the nose in a crash).
 *
 *   const jumbo = createB747Model();
 *   scene.add(jumbo.root);            // the loop copies the physics pose onto jumbo.root
 *   jumbo.setVisualState(v, dt);      // every frame
 *
 * Body frame = three.js object frame (+X right, +Y up, −Z nose, origin = CG). The 18 wheels, the
 * wingtips, the stabiliser tips, the fin top, the four engine pods, the belly/tail-strike points and
 * the pilot's eye sit on B747_AIRCRAFT.geometry (tests hold them to 3 cm). Moving parts: elevators
 * (4), split rudder, inboard/outboard ailerons, spoilers, triple-slotted flaps (carriage + aft
 * flap), Krueger flaps, gear (legs, trucks, doors, steering, compression, spin), four fans.
 */
import * as THREE from 'three';
import { tint, merge } from '../materials';
import type { AircraftVisualState } from '../types';
import type { AircraftModelHandle, BreakupPart } from '../../fleet/types';
import { B747_AIRCRAFT } from '../../config';
import { ellipsoid, makeHinge, V } from '../f16/geom';
import { createB747Anim, stepB747Anim } from './animate';
import { buildFuselage } from './fuselage';
import { buildWingRight, mirrorWing, type HingedPart, type Side, type Span, type WingSideBuild } from './wing';
import { buildTail } from './tail';
import { buildEngines } from './engines';
import { buildGear } from './gear';
import { paintLivery } from './livery';
import { createB747Materials, type B747Textures } from './materials';
import { attachFlightDeck } from './flightDeck'; // b747deck: the flight deck interior
import { GEO, FUSE_END_Z as TAIL_Z, halfOutline } from './shape';

export { createB747Anim, stepB747Anim, B747_LIMITS } from './animate';
export type { Side, Span } from './wing';

const DOOR_KEYS = ['noseLeft', 'noseRight', 'wingLeft', 'wingRight', 'bodyLeft', 'bodyRight'] as const;
const doorName = (k: string) => `b747.door.${k}`;

/** Names of the parts (root.getObjectByName). */
export const B747_PART = {
  root: 'b747',
  fuselage: 'b747.fuselage',
  forward: 'b747.forwardFuselage',
  aft: 'b747.aftFuselage',
  skinForward: 'b747.skin.forward',
  skinCentre: 'b747.skin.centre',
  skinAft: 'b747.skin.aft',
  flightDeck: 'b747.flightDeck',
  cockpitGlass: 'b747.cockpit.glass',
  leftWing: 'b747.leftWing',
  rightWing: 'b747.rightWing',
  wingPanel: (s: Side) => `b747.${s}Wing.panel`,
  flapMain: (s: Side, sp: Span) => `b747.flap.${s}.${sp}`,
  flapAft: (s: Side, sp: Span) => `b747.flap.${s}.${sp}.aft`,
  aileron: (s: Side, sp: Span) => `b747.aileron.${s}.${sp}`,
  spoiler: (s: Side, sp: Span) => `b747.spoiler.${s}.${sp}`,
  krueger: (s: Side, sp: Span) => `b747.krueger.${s}.${sp}`,
  tail: 'b747.tail',
  rudderUpper: 'b747.rudder.upper',
  rudderLower: 'b747.rudder.lower',
  elevator: (s: Side, sp: Span) => `b747.elevator.${s}.${sp}`,
  engine: (n: number) => `b747.engine${n}`,
  nacelle: (n: number) => `b747.engine${n}.nacelle`,
  fan: (n: number) => `b747.engine${n}.fan`,
  noseGear: 'b747.gear.nose',
  wingGear: (s: Side) => `b747.gear.wing.${s}`,
  bodyGear: (s: Side) => `b747.gear.body.${s}`,
  truck: (gear: string) => `${gear}.truck`,
  noseAxle: 'b747.gear.nose.axle',
  noseSteer: 'b747.gear.nose.steer',
  doors: DOOR_KEYS.map(doorName),
  glows: 'b747.lightGlows',
  landingLight: 'b747.landingLight',
} as const;

const DEG = Math.PI / 180;
/** Krueger flaps swing down and forward ~115° about their leading-edge hinges. */
const KRUEGER_DEG = 115;

function group(name: string, parent?: THREE.Object3D): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  parent?.add(g);
  return g;
}

export function createB747Model(): AircraftModelHandle {
  const hasDom = typeof document !== 'undefined';
  const fuse = buildFuselage();
  const wingR = buildWingRight();
  const wingL = mirrorWing(wingR);
  const tailB = buildTail();
  const engines = buildEngines();

  let textures: B747Textures | null = null;
  if (hasDom) textures = paintLivery();
  const mats = createB747Materials(textures);
  const root = group(B747_PART.root);
  const bodyFromWorld = mats.fx.bodyFromWorld.value;
  // Painted/parts shaders work in body coordinates: refresh the root's inverse before each draw.
  const syncBody = () => {
    bodyFromWorld.copy(root.matrixWorld).invert();
  };
  const fxMeshes: THREE.Mesh[] = [];

  function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, name: string, parent: THREE.Object3D, shadows = false): THREE.Mesh {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.castShadow = shadows;
    m.receiveShadow = true;
    parent.add(m);
    if (mat === mats.paint || mat === mats.parts || mat === mats.surfaces) {
      m.onBeforeRender = syncBody;
      fxMeshes.push(m);
    }
    return m;
  }
  function hinge(h: HingedPart, name: string, mat: THREE.Material, parent: THREE.Object3D, shadows = false) {
    const r = makeHinge(name, h.position, h.quaternion);
    mesh(h.geometry, mat, `${name}.mesh`, r.rot, shadows);
    parent.add(r.pivot);
    return r;
  }

  // ── Fuselage: nose section (flight deck), centre (wing box), aft body ──
  const forward = group(B747_PART.forward, root);
  mesh(fuse.forward, mats.paint, B747_PART.skinForward, forward, true);
  mesh(fuse.detailsForward, mats.parts, 'b747.details.forward', forward);
  const glass = mesh(fuse.glass, mats.glass, B747_PART.cockpitGlass, forward);
  glass.renderOrder = 3;
  const flightDeck = group(B747_PART.flightDeck, forward);
  flightDeck.position.set(0, GEO.pilotEye.y - 0.9, GEO.pilotEye.z + 0.3);
  const centre = group(B747_PART.fuselage, root);
  mesh(fuse.centre, mats.paint, B747_PART.skinCentre, centre, true);
  mesh(fuse.detailsCentre, mats.parts, 'b747.details.centre', centre);
  const aft = group(B747_PART.aft, root);
  mesh(fuse.aft, mats.paint, B747_PART.skinAft, aft, true);
  mesh(fuse.detailsAft, mats.parts, 'b747.details.aft', aft);

  // ── Wings ──
  type WingRig = {
    g: THREE.Group;
    flaps: Record<Span, { main: ReturnType<typeof makeHinge>; aft: ReturnType<typeof makeHinge>; home: THREE.Vector3; dir: THREE.Vector3; run: number }>;
    ailerons: Record<Span, ReturnType<typeof makeHinge>>;
    spoilers: Record<Span, ReturnType<typeof makeHinge>>;
    kruegers: Record<Span, ReturnType<typeof makeHinge>>;
  };
  const wingGroup = (side: Side, w: WingSideBuild): WingRig => {
    const g = group(side === 'left' ? B747_PART.leftWing : B747_PART.rightWing, root);
    mesh(w.panel, mats.paint, B747_PART.wingPanel(side), g, true);
    mesh(w.parts, mats.parts, `b747.${side}Wing.parts`, g, true);
    const spans: Span[] = ['inboard', 'outboard'];
    const rig = { g, flaps: {}, ailerons: {}, spoilers: {}, kruegers: {} } as WingRig;
    for (const sp of spans) {
      const f = w.flaps[sp];
      const main = hinge(f.main, B747_PART.flapMain(side, sp), mats.paint, g);
      const aftH = makeHinge(B747_PART.flapAft(side, sp), f.aft.position, f.aft.quaternion);
      mesh(f.aft.geometry, mats.paint, `${B747_PART.flapAft(side, sp)}.mesh`, aftH.rot);
      main.rot.add(aftH.pivot);
      rig.flaps[sp] = { main, aft: aftH, home: main.pivot.position.clone(), dir: f.runDir, run: f.run };
      rig.ailerons[sp] = hinge(w.ailerons[sp], B747_PART.aileron(side, sp), mats.paint, g);
      rig.spoilers[sp] = hinge(w.spoilers[sp], B747_PART.spoiler(side, sp), mats.surfaces, g);
      rig.kruegers[sp] = hinge(w.kruegers[sp], B747_PART.krueger(side, sp), mats.surfaces, g);
    }
    // Light lenses: nav (red left / green right), white tail light, strobe, landing lamp.
    const navHex = side === 'left' ? 0xff2a1a : 0x20ff60;
    mesh(
      merge([
        tint(ellipsoid(w.navLight, 0.07, 0.05, 0.1, 10, 6), navHex, 0.2, 0),
        tint(ellipsoid(w.tailLight, 0.05, 0.04, 0.07, 10, 6), 0xffffff, 0.2, 0),
        tint(ellipsoid(w.strobe, 0.06, 0.04, 0.08, 10, 6), 0xf4f6ff, 0.2, 0),
        tint(ellipsoid(w.landingLamp, 0.18, 0.1, 0.05, 12, 6), 0xf6f2e6, 0.2, 0),
      ]),
      mats.nav,
      `b747.${side}Wing.lenses`,
      g,
    );
    return rig;
  };
  const wl = wingGroup('left', wingL);
  const wr = wingGroup('right', wingR);

  // ── Tail ──
  const tail = group(B747_PART.tail, root);
  mesh(tailB.surfaces, mats.paint, 'b747.tail.surfaces', tail, true);
  const rudU = hinge(tailB.rudderUpper, B747_PART.rudderUpper, mats.paint, tail);
  const rudL = hinge(tailB.rudderLower, B747_PART.rudderLower, mats.paint, tail);
  const elev = {
    leftIn: hinge(tailB.elevators.leftIn, B747_PART.elevator('left', 'inboard'), mats.paint, tail),
    leftOut: hinge(tailB.elevators.leftOut, B747_PART.elevator('left', 'outboard'), mats.paint, tail),
    rightIn: hinge(tailB.elevators.rightIn, B747_PART.elevator('right', 'inboard'), mats.paint, tail),
    rightOut: hinge(tailB.elevators.rightOut, B747_PART.elevator('right', 'outboard'), mats.paint, tail),
  };

  // ── Engines ──
  const eng = engines.map((e) => {
    const g = group(B747_PART.engine(e.pod.n), root);
    mesh(e.nacelle, mats.parts, B747_PART.nacelle(e.pod.n), g, true);
    const fan = group(B747_PART.fan(e.pod.n), g);
    fan.position.copy(e.fanCentre);
    const slow = mesh(e.blades, mats.parts, `${B747_PART.fan(e.pod.n)}.blades`, fan);
    const fast = mesh(e.disc, mats.parts, `${B747_PART.fan(e.pod.n)}.disc`, fan);
    fast.visible = false;
    return { g, fan, slow, fast };
  });

  // ── Gear ──
  const gear = buildGear({ nose: B747_PART.noseGear, wing: B747_PART.wingGear, body: B747_PART.bodyGear, door: doorName });
  const partsOn = (o: THREE.Object3D) =>
    o.traverse((c) => {
      const m = c as THREE.Mesh;
      if (m.isMesh) {
        m.material = mats.parts;
        m.onBeforeRender = syncBody;
      }
    });
  for (const l of [gear.nose, gear.wingLeft, gear.wingRight, gear.bodyLeft, gear.bodyRight]) {
    partsOn(l.group);
    root.add(l.group);
  }
  for (const d of gear.noseDoors) {
    partsOn(d.object);
    forward.add(d.object);
  }
  for (const d of gear.mainDoors) {
    partsOn(d.object);
    centre.add(d.object);
  }
  // Beacon lenses (top and belly).
  mesh(
    merge([tint(ellipsoid(fuse.beaconTop, 0.14, 0.09, 0.2, 12, 6), 0xff2010, 0.2, 0), tint(ellipsoid(fuse.beaconBottom, 0.14, 0.09, 0.2, 12, 6), 0xff2010, 0.2, 0)]),
    mats.nav,
    'b747.beacons',
    centre,
  );

  // ── Light glows (one Points draw) ──
  const tailCone = (() => {
    const h = halfOutline(TAIL_Z, 8);
    return V(0, (h[1] + h[h.length - 2]) / 2 + 0.1, TAIL_Z + 0.02);
  })();
  const glowPts: [THREE.Vector3, [number, number, number], number, [number, number, number]][] = [
    [wingL.navLight, [1.8, 0.08, 0.04], 0.5, [-0.6, 0, -0.8]],
    [wingR.navLight, [0.1, 1.6, 0.35], 0.5, [0.6, 0, -0.8]],
    [wingL.tailLight, [1.2, 1.2, 1.15], 0.38, [0, 0, 1]],
    [wingR.tailLight, [1.2, 1.2, 1.15], 0.38, [0, 0, 1]],
    [wingL.strobe, [6, 6, 6.4], 1.1, [0, 0, 0]],
    [wingR.strobe, [6, 6, 6.4], 1.1, [0, 0, 0]],
    [tailCone, [6, 6, 6.4], 0.9, [0, 0, 0]],
    [fuse.beaconTop, [4.5, 0.25, 0.12], 0.9, [0, 0, 0]],
    [fuse.beaconBottom, [4.5, 0.25, 0.12], 0.9, [0, 0, 0]],
    [wingL.landingLamp, [6, 5.6, 5.1], 1.3, [0, -0.1, -1]],
    [wingR.landingLamp, [6, 5.6, 5.1], 1.3, [0, -0.1, -1]],
    [V(0, 0, 0), [4, 3.8, 3.4], 0.8, [0, -0.1, -1]],
    [tailB.logoLights[0], [1.4, 1.35, 1.2], 0.3, [0, 1, 0]],
    [tailB.logoLights[1], [1.4, 1.35, 1.2], 0.3, [0, 1, 0]],
  ];
  const TAXI = 11;
  const n = glowPts.length;
  const gpos = new Float32Array(n * 3);
  const gcol = new Float32Array(n * 3);
  const gsize = new Float32Array(n);
  const gdir = new Float32Array(n * 3);
  glowPts.forEach(([p, c, s, d], i) => {
    p.toArray(gpos, i * 3);
    gcol.set(c, i * 3);
    gsize[i] = s;
    gdir.set(d, i * 3);
  });
  const glowGeo = new THREE.BufferGeometry();
  const glowPos = new THREE.BufferAttribute(gpos, 3);
  glowPos.setUsage(THREE.DynamicDrawUsage);
  glowGeo.setAttribute('position', glowPos);
  glowGeo.setAttribute('glowColor', new THREE.BufferAttribute(gcol, 3));
  glowGeo.setAttribute('size', new THREE.BufferAttribute(gsize, 1));
  glowGeo.setAttribute('aDir', new THREE.BufferAttribute(gdir, 3));
  const glowIntensity = new THREE.BufferAttribute(new Float32Array(n), 1);
  glowIntensity.setUsage(THREE.DynamicDrawUsage);
  glowGeo.setAttribute('intensity', glowIntensity);
  glowGeo.boundingSphere = new THREE.Sphere(V(0, 0, 0), 45);
  const glows = new THREE.Points(glowGeo, mats.glow);
  glows.name = B747_PART.glows;
  glows.frustumCulled = false;
  glows.renderOrder = 5;
  glows.userData.noBounds = true;
  const _buf = new THREE.Vector2();
  glows.onBeforeRender = (renderer) => {
    renderer.getDrawingBufferSize(_buf);
    mats.glow.uniforms.uHalfHeight.value = _buf.y * 0.5;
  };
  root.add(glows);

  // Landing light (the only real light): under the nose, aimed ahead and down.
  const LL = B747_AIRCRAFT.model.landingLight;
  const landingLight = new THREE.SpotLight(0xfff4e6, 0, LL.range * 1.3, LL.angleDeg * 1.4 * DEG, LL.penumbra, LL.decay);
  landingLight.name = B747_PART.landingLight;
  landingLight.castShadow = false;
  landingLight.visible = false;
  landingLight.position.set(0, -2.6, -24.5);
  landingLight.target.position.set(0, -8, -80);
  root.add(landingLight, landingLight.target);

  // ── Break-up parts ──
  const breakup: BreakupPart[] = [
    { name: 'fuselage', object: centre, mass: 62000, burning: true },
    { name: 'forwardFuselage', object: forward, mass: 26000 },
    { name: 'aftFuselage', object: aft, mass: 17000 },
    { name: 'leftWing', object: wl.g, mass: 30000, burning: true },
    { name: 'rightWing', object: wr.g, mass: 30000, burning: true },
    { name: 'tail', object: tail, mass: 7500 },
    ...eng.map((e, i) => ({ name: `engine${i + 1}`, object: e.g, mass: 5800, burning: true })),
    { name: 'noseGear', object: gear.nose.group, mass: 1600 },
    { name: 'leftWingGear', object: gear.wingLeft.group, mass: 2600 },
    { name: 'rightWingGear', object: gear.wingRight.group, mass: 2600 },
    { name: 'leftBodyGear', object: gear.bodyLeft.group, mass: 2600 },
    { name: 'rightBodyGear', object: gear.bodyRight.group, mass: 2600 },
  ];
  const home = breakup.map((b) => ({ part: b, parent: b.object.parent!, p: b.object.position.clone(), q: b.object.quaternion.clone(), s: b.object.scale.clone() }));

  // ── Per-frame state ──
  const anim = createB747Anim();
  const gi = glowIntensity.array as Float32Array;
  const taxiPos = new THREE.Vector3();
  const rootInv = new THREE.Matrix4();
  let lastMode: string | null = null;
  let wrecked = false;
  const rigs = [wl, wr];

  function setVisualState(v: AircraftVisualState, dt: number) {
    stepB747Anim(v, anim, dt);
    const crashed = v.crashed === true;
    mats.fx.char.value = crashed ? Math.min(1, Math.max(0, Number(v.crashAge) || 0) / 8) : 0;
    mats.fx.logo.value = anim.logo;
    if (crashed !== wrecked) {
      wrecked = crashed;
      glass.visible = !crashed && v.cameraMode !== 'cockpit';
    }

    // Tail surfaces (+ = TE down / TE right about each hinge).
    for (const e of [elev.leftIn, elev.leftOut, elev.rightIn, elev.rightOut]) e.rot.rotation.x = anim.elevatorRad;
    rudU.rot.rotation.x = anim.rudderUpperRad;
    rudL.rot.rotation.x = anim.rudderLowerRad;

    // Wings.
    wl.ailerons.inboard.rot.rotation.x = anim.aileronLeftInRad;
    wl.ailerons.outboard.rot.rotation.x = anim.aileronLeftOutRad;
    wr.ailerons.inboard.rot.rotation.x = anim.aileronRightInRad;
    wr.ailerons.outboard.rot.rotation.x = anim.aileronRightOutRad;
    for (const sp of ['inboard', 'outboard'] as const) {
      wl.spoilers[sp].rot.rotation.x = -anim.spoilerLeftRad;
      wr.spoilers[sp].rot.rotation.x = -anim.spoilerRightRad;
    }
    for (const r of rigs) {
      for (const sp of ['inboard', 'outboard'] as const) {
        const f = r.flaps[sp];
        f.main.pivot.position.copy(f.home).addScaledVector(f.dir, f.run * anim.flapTravel);
        f.main.rot.rotation.x = anim.flapMainRad;
        f.aft.rot.rotation.x = anim.flapAftRad;
        r.kruegers[sp].rot.rotation.x = anim.krueger * KRUEGER_DEG * DEG;
      }
    }

    gear.update(anim);

    // Fans.
    const fast = anim.fanBlur > 0.5;
    for (const e of eng) {
      e.fan.rotation.z = anim.fanAngle;
      e.slow.visible = !fast;
      e.fast.visible = fast;
    }

    // Lights.
    gi[0] = gi[1] = gi[2] = gi[3] = anim.nav;
    gi[4] = gi[5] = gi[6] = anim.strobe;
    gi[7] = anim.beacon;
    gi[8] = anim.beacon2;
    gi[9] = gi[10] = anim.landing;
    gi[TAXI] = anim.taxi * (anim.legs > 0.98 ? 1 : 0);
    gi[12] = gi[13] = anim.logo;
    if (gi[TAXI] > 0) {
      root.updateMatrixWorld(true);
      rootInv.copy(root.matrixWorld).invert();
      gear.taxiLamp.getWorldPosition(taxiPos).applyMatrix4(rootInv);
      taxiPos.toArray(gpos, TAXI * 3);
      glowPos.needsUpdate = true;
    }
    glowIntensity.needsUpdate = true;
    const lamp = Math.max(anim.landing, anim.taxi * 0.6);
    landingLight.visible = lamp > 0;
    if (landingLight.visible) landingLight.intensity = LL.intensity * 1.3 * lamp;

    // Cockpit presentation: from the flight deck the panes are seen from inside at grazing angles.
    if (v.cameraMode !== lastMode) {
      lastMode = v.cameraMode;
      const inCockpit = v.cameraMode === 'cockpit';
      // The flight-deck module owns the view from inside: the outer panes would only glare.
      glass.visible = !inCockpit && !wrecked;
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
  void fxMeshes;

  return attachFlightDeck({
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
  });
}
