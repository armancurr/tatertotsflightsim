/**
 * Procedural Bell 206B-3 JetRanger III (N206TT): lofted cabin pod with the big curved windscreen,
 * chin windows and overhead windows, the two-piece doors, the raised transmission/engine fairing
 * with its intake screens and exhaust stack, the tapered tail boom with the stabiliser (endplates),
 * upper and lower fins and the tail skid; skid gear; the two-blade teetering main rotor and the
 * two-blade tail rotor with their blur discs; livery painted in code; nav lights, beacons and the
 * nose landing light; the right-seat cockpit with live instruments and moving controls; a wreck and
 * the crash break-up — all built in code.
 *
 *   const heli = createB206Model();
 *   scene.add(heli.root);          // the loop copies the physics pose onto heli.root
 *   heli.setVisualState(v, dt);    // every frame (v.propRpm = main-rotor rpm, v.rotor = RotorState)
 *
 * Body frame = three.js object frame (+X right, +Y up, −Z nose, origin = CG). The skids, rotor hub
 * and radius, tail rotor, stabiliser, fin top and the pilot's eye sit on B206_AIRCRAFT.geometry /
 * .rotorcraft (tests/aircraft/b206 hold them to 2–3 cm).
 */
import * as THREE from 'three';
import { B206_AIRCRAFT } from '../../config';
import type { AircraftModelHandle, BreakupPart } from '../../fleet/types';
import { createRestReadings, type AircraftVisualState } from '../types';
import type { InstrumentReadings } from '../../types';
import { createBreakupRig } from '../breakup';
import { merge, tint } from '../materials';
import { ellipsoid, V } from '../f16/geom';
import { beaconIntensity, bladePitch, computeB206Anim, createB206Anim } from './animate';
import { buildControls, buildCockpit } from './cockpit';
import { buildFuselage } from './fuselage';
import { buildSkidGear } from './gear';
import { CABIN_TEX, SKIN_TEX, createTextSampler, paintB206Livery, pixelsToCanvas } from './livery';
import { createB206Materials, type B206Materials, type B206Textures } from './materials';
import { PANEL_TEX, drawB206Panel } from './panel';
import { ROTOR_PART, bendBlades, buildMainRotor, buildTailRotor } from './rotor';
import { ROTOR, TAIL_ROTOR, fuselageSection } from './shape';
import { buildTail } from './tail';
import { B206_WRECK, boomBendTransform, crumpleFuselagePoint, deformGeometry, wreckBladePoint } from './wreck';

export { B206_WRECK } from './wreck';
export { computeB206Anim, createB206Anim } from './animate';

/** Names of the parts (root.getObjectByName). */
export const B206_PART = {
  root: 'b206',
  fuselage: 'b206.fuselage',
  skin: 'b206.skin',
  lining: 'b206.lining',
  glass: 'b206.glass',
  fairing: 'b206.fairing',
  details: 'b206.details',
  cockpit: 'b206.cockpit',
  furniture: 'b206.cockpit.furniture',
  panel: 'b206.cockpit.panel',
  cyclic: 'b206.cyclic',
  collective: 'b206.collective',
  pedalLeft: 'b206.pedal.left',
  pedalRight: 'b206.pedal.right',
  tailBoom: 'b206.tailBoom',
  boomBend: 'b206.tailBoom.bend',
  boom: 'b206.boom',
  stab: 'b206.stab',
  fins: 'b206.fins',
  tailParts: 'b206.tailParts',
  skids: 'b206.skids',
  skidGear: 'b206.skids.gear',
  navLights: 'b206.navLights',
  beaconTop: 'b206.beacon.top',
  beaconBottom: 'b206.beacon.bottom',
  landingLight: 'b206.landingLight',
  glows: 'b206.lightGlows',
  ...ROTOR_PART,
} as const;

const DEG = Math.PI / 180;
const TAU = Math.PI * 2;
const AC = B206_AIRCRAFT;

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

/** Canvas textures (browser only): the painted skin, the cabin lining, the glass mask, the live panel. */
function createTextures(): { tex: B206Textures; panelCtx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null;
  const px = paintB206Livery(createTextSampler(document));
  const skinC = pixelsToCanvas(document, px.skin, SKIN_TEX.width, SKIN_TEX.height);
  const cabinC = pixelsToCanvas(document, px.cabin, CABIN_TEX.width, CABIN_TEX.height);
  const maskC = pixelsToCanvas(document, px.mask, CABIN_TEX.width, CABIN_TEX.height);
  const panelC = document.createElement('canvas');
  panelC.width = PANEL_TEX.width;
  panelC.height = PANEL_TEX.height;
  const panelCtx = panelC.getContext('2d');
  if (!skinC || !cabinC || !maskC || !panelCtx) return null;
  const tex = (c: HTMLCanvasElement, srgb: boolean, aniso: number) => {
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = aniso;
    return t;
  };
  return {
    tex: { skin: tex(skinC, true, 8), cabin: tex(cabinC, true, 4), mask: tex(maskC, false, 4), panel: tex(panelC, true, 4) },
    panelCtx,
  };
}

/** The belly beacon sweeps half a period after the top one. */
function beaconHalf(time: number): number {
  const p = AC.model.beaconPeriodS;
  return beaconIntensity((Number.isFinite(time) ? time : 0) + p / 2);
}

export function createB206Model(): AircraftModelHandle {
  const made = createTextures();
  const textures = made?.tex ?? null;
  const mats: B206Materials = createB206Materials(textures);
  const root = group(B206_PART.root);

  // ── Fuselage: skin, lining, glass, fairing, details, cockpit ──
  const fuse = buildFuselage();
  const fuselage = group(B206_PART.fuselage, root);
  const skin = mesh(fuse.skin, mats.skin, B206_PART.skin, fuselage);
  const lining = mesh(fuse.lining, mats.cabin, B206_PART.lining, fuselage, false);
  const glass = mesh(fuse.glass, mats.glass, B206_PART.glass, fuselage, false);
  glass.renderOrder = 3;
  const fairing = mesh(fuse.fairing, mats.paint, B206_PART.fairing, fuselage);
  const details = mesh(fuse.details, mats.parts, B206_PART.details, fuselage, false);

  const cockpit = group(B206_PART.cockpit, fuselage);
  const pit = buildCockpit();
  const furniture = mesh(pit.furniture, mats.interior, B206_PART.furniture, cockpit, false);
  const panelFace = mesh(pit.panelFace, mats.panel, B206_PART.panel, cockpit, false);
  const controls = buildControls(mats.interior);
  cockpit.add(controls.cyclic, controls.collective, controls.pedalLeft, controls.pedalRight);

  // Landing light lens under the nose, the belly beacon.
  const LL = AC.model.landingLight;
  const lensY = fuselageSection(LL.z).bottom - 0.012;
  mesh(tint(ellipsoid(V(LL.x, lensY, LL.z), 0.055, 0.008, 0.07, 16, 6), 0xffffff, 0.2), mats.lamp, 'b206.landingLamp', fuselage, false);
  const bellyBeaconPos = V(0, fuselageSection(0.1).bottom - 0.02, 0.1);
  const beaconGeo = (p: THREE.Vector3, up: boolean) => {
    const g = new THREE.SphereGeometry(1, 16, 8, 0, TAU, up ? 0 : Math.PI / 2, Math.PI / 2);
    g.scale(0.035, 0.05, 0.035);
    g.translate(p.x, p.y, p.z);
    return g;
  };
  mesh(beaconGeo(bellyBeaconPos, false), mats.beacon, B206_PART.beaconBottom, fuselage, false);

  // ── Tail boom (a bend group inside the break-up container, for the wreck) ──
  const tailGeo = buildTail();
  const tailBoom = group(B206_PART.tailBoom, root);
  const boomBend = group(B206_PART.boomBend, tailBoom);
  mesh(fuse.boom, mats.skin, B206_PART.boom, boomBend);
  mesh(tailGeo.stab, mats.paint, B206_PART.stab, boomBend);
  mesh(tailGeo.paint, mats.paint, B206_PART.fins, boomBend);
  mesh(tailGeo.parts, mats.parts, B206_PART.tailParts, boomBend, false);
  const TL = tailGeo.lights;
  const lens = (p: THREE.Vector3, hex: number, r = 0.012) => tint(ellipsoid(p, r, r, r * 1.3, 10, 8), hex, 0.2);
  const navMesh = mesh(merge([lens(TL.navLeft, 0xff2a1a), lens(TL.navRight, 0x20ff60), lens(TL.tail, 0xffffff, 0.014)]), mats.nav, B206_PART.navLights, boomBend, false);
  mesh(beaconGeo(TL.beaconTop, true), mats.beacon, B206_PART.beaconTop, boomBend, false);

  // ── Rotors ──
  const main = buildMainRotor({ parts: mats.parts, blades: mats.blades, disc: mats.disc });
  root.add(main.group);
  const tail = buildTailRotor({ parts: mats.parts, blades: mats.tailBlades, disc: mats.tailDisc });
  root.add(tail.group);
  // A clockwise rotor (direction −1) is the mirror image: flip the blades' chord.
  for (const b of main.blades) b.holder.scale.z = ROTOR.direction;

  // ── Skid gear ──
  const skidsGroup = group(B206_PART.skids, root);
  const skids = buildSkidGear(mats.parts, B206_PART.skidGear);
  skidsGroup.add(skids.mesh);

  // ── Light glows (one Points draw): nav red, nav green, tail white, beacon top, beacon bottom, landing ──
  const glowPts = [TL.navLeft, TL.navRight, TL.tail, TL.beaconTop.clone().add(V(0, 0.03, 0)), bellyBeaconPos.clone().add(V(0, -0.03, 0)), V(LL.x, lensY - 0.01, LL.z)];
  const glowGeo = new THREE.BufferGeometry();
  glowGeo.setAttribute('position', new THREE.Float32BufferAttribute(glowPts.flatMap((p) => [p.x, p.y, p.z]), 3));
  glowGeo.setAttribute('glowColor', new THREE.BufferAttribute(new Float32Array([1.6, 0.08, 0.04, 0.1, 1.5, 0.35, 1.1, 1.1, 1.05, 3.2, 0.2, 0.12, 3.2, 0.2, 0.12, 5, 4.7, 4.3]), 3));
  glowGeo.setAttribute('size', new THREE.BufferAttribute(new Float32Array([0.22, 0.22, 0.18, 0.6, 0.6, 0.5]), 1));
  glowGeo.setAttribute('aDir', new THREE.BufferAttribute(new Float32Array([-0.8, 0, -0.6, 0.8, 0, -0.6, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, -0.2, -1]), 3));
  const glowIntensity = new THREE.BufferAttribute(new Float32Array(glowPts.length), 1);
  glowIntensity.setUsage(THREE.DynamicDrawUsage);
  glowGeo.setAttribute('intensity', glowIntensity);
  glowGeo.boundingSphere = new THREE.Sphere(V(0, 0, 2), 6);
  const glows = new THREE.Points(glowGeo, mats.glow);
  glows.name = B206_PART.glows;
  glows.frustumCulled = false;
  glows.renderOrder = 5;
  glows.userData.noBounds = true;
  const _buf = new THREE.Vector2();
  glows.onBeforeRender = (renderer) => {
    renderer.getDrawingBufferSize(_buf);
    mats.glow.uniforms.uHalfHeight.value = _buf.y * 0.5;
  };
  root.add(glows);

  // Landing light (the only real light) in the nose, aimed ahead and down.
  const landingLight = new THREE.SpotLight(0xfff4e6, 0, LL.range, LL.angleDeg * DEG, LL.penumbra, LL.decay);
  landingLight.name = B206_PART.landingLight;
  landingLight.castShadow = false;
  landingLight.visible = false;
  landingLight.position.set(LL.x, LL.y, LL.z);
  landingLight.target.position.set(LL.x, LL.y - Math.tan(LL.aimDownDeg * DEG) * 50, LL.z - 50);
  root.add(landingLight, landingLight.target);

  // ── Break-up parts (containers at the identity; the model animates only their children) ──
  const breakup = createBreakupRig([
    { name: 'fuselage', object: fuselage, mass: 915, burning: true },
    { name: 'tailBoom', object: tailBoom, mass: 95 },
    { name: 'mainRotor', object: main.group, mass: 205 },
    { name: 'tailRotor', object: tail.group, mass: 22 },
    { name: 'skids', object: skidsGroup, mass: 58 },
  ] satisfies BreakupPart[]);

  // ── Wreck: deformed clones (made on the first crash, cached) and rigid transforms ──
  const swaps = [skin, lining, fairing, details, furniture, panelFace].map((m) => ({ mesh: m, intact: m.geometry, wreck: null as THREE.BufferGeometry | null }));
  const bladeSwaps = main.blades.map((b, k) => ({ mesh: b.mesh, intact: b.mesh.geometry, wreck: null as THREE.BufferGeometry | null, k: k as 0 | 1 }));
  const bendM = boomBendTransform();
  const _s = new THREE.Vector3();
  let wrecked = false;
  function setWrecked(on: boolean) {
    if (on === wrecked) return;
    wrecked = on;
    for (const sw of swaps) {
      if (on && !sw.wreck) sw.wreck = deformGeometry(sw.intact.clone(), crumpleFuselagePoint);
      sw.mesh.geometry = on && sw.wreck ? sw.wreck : sw.intact;
    }
    for (const sw of bladeSwaps) {
      if (on && !sw.wreck) {
        // Bend from the blade's unbent shape, not whatever the flight left in the shared geometry.
        const g = sw.intact.clone();
        (g.getAttribute('position').array as Float32Array).set(main.bladeBase);
        sw.wreck = deformGeometry(g, (p, o) => wreckBladePoint(sw.k, p, o));
      }
      sw.mesh.geometry = on && sw.wreck ? sw.wreck : sw.intact;
    }
    for (const g of [boomBend, tail.bend]) {
      if (on) bendM.decompose(g.position, g.quaternion, _s);
      else {
        g.position.set(0, 0, 0);
        g.quaternion.identity();
      }
    }
    glass.visible = !on;
    glows.visible = !on;
  }

  // ── Per-frame state ──
  const anim = createB206Anim();
  let azimuth = 0;
  let tailAzimuth = 0;
  let lastBend = [Infinity, Infinity];
  let lastMode: string | null = null;
  let panelClock = Infinity;
  const rest = createRestReadings();
  const beaconOff = new THREE.Color(0x5a0808);
  const beaconOn = new THREE.Color(0xff2a18).multiplyScalar(4);
  const lampOff = new THREE.Color(0x9aa0a4);
  const lampOn = new THREE.Color(0xfff6e8).multiplyScalar(5);
  const gi = glowIntensity.array as Float32Array;
  const mainBladeMeshes = main.blades.map((b) => b.mesh);
  const tailBladeMeshes = tail.blades.map((b) => b.mesh);
  const setBladesBlend = (m: THREE.MeshStandardMaterial, blend: number, meshes: THREE.Mesh[]) => {
    const transparent = blend > 0.001;
    if (m.transparent !== transparent) {
      m.transparent = transparent;
      m.depthWrite = !transparent;
      m.needsUpdate = true;
    }
    m.opacity = 1 - 0.9 * blend;
    for (const b of meshes) b.castShadow = blend < 0.5;
  };
  const redrawPanel = (r: InstrumentReadings) => {
    if (!made || !textures) return;
    drawB206Panel(made.panelCtx, PANEL_TEX.width, PANEL_TEX.height, r);
    textures.panel.needsUpdate = true;
  };

  function setVisualState(v: AircraftVisualState, dt: number) {
    const step = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.25)) : 0;
    const crashed = v.crashed === true;
    computeB206Anim(v, anim);
    setWrecked(crashed);
    mats.char.value = crashed ? Math.min(1, Math.max(0, Number(v.crashAge ?? 0)) / 7) : 0;
    const inCockpit = v.cameraMode === 'cockpit' && !crashed;

    // Skids: the loads lift them (front contact, left rear, right rear).
    const wc = v.wheelCompression ?? [0, 0, 0];
    const cc = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(0.4, x)) : 0);
    skids.update(cc(wc[0]), cc(wc[1]), cc(wc[2]), crashed);

    // Main rotor: azimuth (counter-clockwise from above for direction +1), tip-path plane, bend, pitch.
    azimuth = (azimuth + (anim.rpm / 60) * TAU * step * ROTOR.direction) % TAU;
    main.spin.rotation.y = azimuth;
    if (crashed) main.tiltFrame.rotation.set(B206_WRECK.headTilt.x, 0, B206_WRECK.headTilt.z);
    else main.tiltFrame.rotation.set(anim.tiltLong, 0, -anim.tiltLat);
    if (!crashed && (Math.abs(anim.coneSlope - lastBend[0]) > 1e-5 || Math.abs(anim.droop - lastBend[1]) > 1e-4)) {
      lastBend = [anim.coneSlope, anim.droop];
      bendBlades(main.bladeGeo, main.bladeBase, anim.coneSlope, anim.droop);
    }
    for (let k = 0; k < 2; k++) {
      // ψ from the tail, counter-clockwise from above: blade 0 lies along +x at azimuth 0 (ψ = 90°).
      const psi = ROTOR.direction * (azimuth + k * Math.PI) + Math.PI / 2;
      main.blades[k].feather.rotation.x = crashed ? 0 : bladePitch(anim, psi);
    }
    setBladesBlend(mats.blades, anim.mainBlend, mainBladeMeshes);
    main.disc.visible = anim.mainBlend > 0.001;
    const du = mats.disc.uniforms;
    du.uRadius.value = ROTOR.radius;
    du.uInner.value = ROTOR.bladeRoot / ROTOR.radius;
    du.uTip.value = 1 - 0.12 / ROTOR.radius;
    du.uAlpha.value = anim.mainBlend * (inCockpit ? 0.045 : 0.11);
    du.uGhost.value = anim.mainBlend * (inCockpit ? 0.12 : 0.3);
    // The ghost drifts slowly (a stroboscopic alias of the true azimuth).
    du.uAngle.value = (-azimuth * 0.37) % TAU;

    // Tail rotor (its thrust axis is local +y; + spin = top blade moving aft).
    tailAzimuth = (tailAzimuth + (anim.tailRpm / 60) * TAU * step) % TAU;
    tail.spin.rotation.y = tailAzimuth;
    for (const b of tail.blades) b.feather.rotation.x = crashed ? 0 : anim.tailPitch;
    setBladesBlend(mats.tailBlades, anim.tailBlend, tailBladeMeshes);
    tail.disc.visible = anim.tailBlend > 0.001;
    const tu = mats.tailDisc.uniforms;
    tu.uRadius.value = TAIL_ROTOR.radius;
    tu.uInner.value = TAIL_ROTOR.bladeRoot / TAIL_ROTOR.radius;
    tu.uTip.value = 0.9;
    tu.uAlpha.value = anim.tailBlend * 0.16;
    tu.uGhost.value = anim.tailBlend * 0.25;
    tu.uAngle.value = (-tailAzimuth * 0.13) % TAU;

    // Lights (a wreck's electrics are dead).
    navMesh.visible = anim.nav > 0;
    const bottomBeacon = crashed || !v.lights?.beacon ? 0 : beaconHalf(v.time);
    mats.beacon.color.copy(beaconOff).lerp(beaconOn, Math.max(anim.beacon, bottomBeacon));
    mats.lamp.color.copy(lampOff).lerp(lampOn, anim.landing);
    gi[0] = gi[1] = gi[2] = anim.nav;
    gi[3] = anim.beacon;
    gi[4] = bottomBeacon;
    gi[5] = anim.landing;
    glowIntensity.needsUpdate = true;
    landingLight.visible = anim.landing > 0;
    landingLight.intensity = LL.intensity * anim.landing;

    // Cockpit: the controls move with the rotor controls; the live panel redraws at its rate.
    controls.update(anim.stickLong, anim.stickLat, anim.lever, anim.pedal);
    if (v.cameraMode !== lastMode) {
      lastMode = v.cameraMode;
      const cp = v.cameraMode === 'cockpit';
      mats.glass.opacity = cp ? 0.45 : 1;
      mats.glass.envMapIntensity = cp ? 0.5 : 1.2;
      mats.interior.color.setScalar(cp ? 1 : 0.75);
      mats.panel.emissiveIntensity = cp ? 0.25 : 0.06;
      panelClock = Infinity;
    }
    const hz = inCockpit ? AC.model.panelRedrawHz : AC.model.panelRedrawHzExterior;
    panelClock += step;
    if (panelClock >= 1 / Math.max(0.5, hz)) {
      panelClock = 0;
      redrawPanel(v.instruments ?? rest);
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
      for (const sw of [...swaps, ...bladeSwaps]) {
        geos.add(sw.intact);
        if (sw.wreck) geos.add(sw.wreck);
      }
      for (const g of geos) g.dispose();
      for (const m of mats.all) m.dispose();
      if (textures) for (const t of Object.values(textures)) t.dispose();
      landingLight.dispose();
      root.removeFromParent();
    },
  };
}
