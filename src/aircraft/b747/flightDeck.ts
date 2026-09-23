/**
 * Boeing 747-400 flight deck (camera 1: the captain's seat on the upper deck):
 *
 *   const deck = createB747FlightDeck();
 *   flightDeckGroup.add(deck.group);          // the model's `b747.flightDeck` group (body frame)
 *   deck.setVisualState(v, dt);               // every frame (cheap unless in the cockpit view)
 *
 * The six 8 × 8 in displays (PFD, ND | upper EICAS | ND, PFD + lower EICAS) and the standby
 * instruments are live canvases, redrawn round-robin (PFDs ~15 Hz, the rest ~7.5 Hz, at most two per
 * frame) and only in the cockpit view; the rest of the deck is a handful of meshes: the lining and
 * all furniture (one vertex-coloured mesh), the painted panel faces (one atlas + a glow atlas for
 * the panel backlighting at dusk), the window glass, and the moving parts — four thrust levers, the
 * speed brake and flap levers, the gear lever, both columns and yokes, the rudder pedals. Sunlight
 * reaches the deck only through the windows (flightDeckLight.ts). The whole interior is hidden
 * outside the cockpit view.
 */
import * as THREE from 'three';
import type { AircraftVisualState } from '../types';
import type { AircraftModelHandle } from '../../fleet/types';
import { createPartsMaterial } from '../materials';
import { createDeckLight } from './flightDeckLight';
import { buildColumn, buildFlapLever, buildFlightDeck, buildGearLever, buildPedal, buildSpeedBrakeLever, buildThrustLever, buildYoke } from './flightDeckGeom';
import { ATLAS_SIZE, paintDeckAtlas } from './flightDeckPaint';
import { createDeckPose, stepDeckPose, type DeckPose } from './flightDeckAnim';
import { createDeckReadings, updateDeckReadings, type DeckReadings } from './flightDeckReadings';
import { DISPLAY_PAINTERS, drawStandby } from './flightDeckDisplays';
import { COLUMN, DECK_ORIGIN, DISPLAY_IDS, EYE_CAPTAIN, EYE_FO, FLAP_LEVER, GEAR_LEVER, PEDALS, SPEEDBRAKE, THRUST, type DisplayId } from './flightDeckLayout';

/** Names (getObjectByName). */
export const DECK_PART = {
  group: 'b747.flightDeck.interior',
  lining: 'b747.deck.lining',
  faces: 'b747.deck.faces',
  glass: 'b747.deck.glass',
  screen: (id: DisplayId) => `b747.deck.screen.${id}`,
  standby: 'b747.deck.standby',
  thrust: 'b747.deck.thrustLevers',
  speedBrake: 'b747.deck.speedBrakeLever',
  flap: 'b747.deck.flapLever',
  gear: 'b747.deck.gearLever',
  column: (s: 'L' | 'R') => `b747.deck.column.${s}`,
  yoke: (s: 'L' | 'R') => `b747.deck.yoke.${s}`,
  pedals: 'b747.deck.pedals',
} as const;

/** Live display redraw schedule. */
export const DECK_DISPLAY_CFG = { size: 384, standbyW: 128, pfdHz: 15, otherHz: 7.5, maxPerFrame: 2, gain: 0.62 } as const;

export interface B747FlightDeck {
  group: THREE.Group;
  setVisualState(v: AircraftVisualState, dt: number): void;
  /** What the displays show (read-only; for tests and tools). */
  readonly readings: DeckReadings;
  readonly pose: DeckPose;
  /** Redraw counters (QA: the rate stays within the budget). */
  readonly stats: { redraws: number; lastMs: number; maxMs: number };
  dispose(): void;
}

const DEG = Math.PI / 180;
/** Share of the sun's irradiance bouncing round the deck (the big windows, the light lining). */
const DECK_BOUNCE = 0.1;
const DISPLAY_KEYS: readonly (DisplayId | 'standby')[] = [...DISPLAY_IDS, 'standby'];

export function createB747FlightDeck(): B747FlightDeck {
  const hasDom = typeof document !== 'undefined';
  const build = buildFlightDeck();
  const group = new THREE.Group();
  group.name = DECK_PART.group;
  group.position.set(DECK_ORIGIN.x, DECK_ORIGIN.y, DECK_ORIGIN.z);
  group.visible = false;

  // ── Textures (browser only) ──
  let atlas: THREE.CanvasTexture | null = null;
  let glowAtlas: THREE.CanvasTexture | null = null;
  const canvases = new Map<string, { ctx: CanvasRenderingContext2D; tex: THREE.CanvasTexture }>();
  if (hasDom) {
    const mk = (w: number, h: number) => {
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      return c;
    };
    const a = mk(ATLAS_SIZE, ATLAS_SIZE);
    const g = mk(ATLAS_SIZE, ATLAS_SIZE);
    const actx = a.getContext('2d');
    const gctx = g.getContext('2d');
    if (actx && gctx) {
      paintDeckAtlas(actx, 'albedo');
      paintDeckAtlas(gctx, 'glow');
      atlas = new THREE.CanvasTexture(a);
      atlas.colorSpace = THREE.SRGBColorSpace;
      atlas.anisotropy = 8;
      glowAtlas = new THREE.CanvasTexture(g);
      glowAtlas.colorSpace = THREE.SRGBColorSpace;
    }
    for (const k of DISPLAY_KEYS) {
      const S = DECK_DISPLAY_CFG.size;
      const c = k === 'standby' ? mk(DECK_DISPLAY_CFG.standbyW, DECK_DISPLAY_CFG.standbyW * 3) : mk(S, S);
      const ctx = c.getContext('2d');
      if (!ctx) continue;
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, c.width, c.height);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      canvases.set(k, { ctx, tex });
    }
  }

  // QA hook (DevTools / scripts): the live displays' redraw count and timings.
  const stats = { redraws: 0, lastMs: 0, maxMs: 0 };
  if (hasDom) (globalThis as { __b747Deck?: object }).__b747Deck = { cfg: DECK_DISPLAY_CFG, stats };

  // ── Materials ──
  const light = createDeckLight();
  const lining = light.apply(createPartsMaterial('b747-deck'), 'lining');
  lining.name = 'b747.deck.lining';
  const faces = light.apply(
    new THREE.MeshStandardMaterial({ name: 'b747.deck.faces', color: atlas ? 0xffffff : 0x5b6166, map: atlas, emissive: glowAtlas ? 0xffffff : 0x000000, emissiveMap: glowAtlas, emissiveIntensity: 0.05, roughness: 0.72, metalness: 0 }),
    'faces',
  );
  const glassMat = new THREE.MeshPhysicalMaterial({ name: 'b747.deck.glass', color: 0x9aa8ae, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 0.5 });
  const screenMats = new Map<string, THREE.MeshBasicMaterial>();
  for (const k of DISPLAY_KEYS) {
    const cv = canvases.get(k);
    const m = new THREE.MeshBasicMaterial({ name: `b747.deck.screen.${k}`, map: cv?.tex ?? null, color: new THREE.Color(DECK_DISPLAY_CFG.gain, DECK_DISPLAY_CFG.gain, DECK_DISPLAY_CFG.gain) });
    if (!cv) m.color.set(0x050606);
    screenMats.set(k, m);
  }

  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string, parent: THREE.Object3D) => {
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.castShadow = false;
    m.receiveShadow = false;
    parent.add(m);
    return m;
  };
  const liningMesh = mesh(build.lining, lining, DECK_PART.lining, group);
  mesh(build.faces, faces, DECK_PART.faces, group);
  const glass = mesh(build.glass, glassMat, DECK_PART.glass, group);
  glass.renderOrder = 3;
  glass.userData.noBounds = true;
  for (const id of DISPLAY_IDS) mesh(build.screens[id], screenMats.get(id)!, DECK_PART.screen(id), group);
  mesh(build.standby, screenMats.get('standby')!, DECK_PART.standby, group);

  // ── Moving parts ──
  const thrustGeo = buildThrustLever();
  const thrust = new THREE.InstancedMesh(thrustGeo, lining, 4);
  thrust.name = DECK_PART.thrust;
  thrust.frustumCulled = false;
  group.add(thrust);
  const leverX = (i: number) => (i - 1.5) * THRUST.spacing;
  const pivotGroup = (name: string, x: number, y: number, z: number, geo: THREE.BufferGeometry) => {
    const pivot = new THREE.Group();
    pivot.name = `${name}.pivot`;
    pivot.position.set(x, y, z);
    group.add(pivot);
    const m = mesh(geo, lining, name, pivot);
    return { pivot, m };
  };
  const sb = pivotGroup(DECK_PART.speedBrake, SPEEDBRAKE.x, SPEEDBRAKE.pivotY, SPEEDBRAKE.pivotZ, buildSpeedBrakeLever());
  const flap = pivotGroup(DECK_PART.flap, FLAP_LEVER.x, FLAP_LEVER.pivotY, FLAP_LEVER.pivotZ, buildFlapLever());
  // Gear lever: in the panel's frame; it swings about the panel's x axis (up = UP, down = DN).
  const gearPivot = new THREE.Group();
  gearPivot.name = `${DECK_PART.gear}.pivot`;
  gearPivot.position.copy(build.gearLeverPos);
  gearPivot.quaternion.copy(build.panelQuat);
  group.add(gearPivot);
  const gearLever = mesh(buildGearLever(), lining, DECK_PART.gear, gearPivot);
  const colGeo = buildColumn();
  const yokeGeo = buildYoke();
  const columns = (['L', 'R'] as const).map((s) => {
    const x = s === 'L' ? EYE_CAPTAIN.x : EYE_FO.x;
    const { pivot, m } = pivotGroup(DECK_PART.column(s), x, COLUMN.pivotY, COLUMN.pivotZ, colGeo);
    const hub = new THREE.Group();
    hub.name = `${DECK_PART.yoke(s)}.hub`;
    hub.position.set(0, COLUMN.hubY - COLUMN.pivotY, COLUMN.hubZ - COLUMN.pivotZ);
    // The yoke faces the pilot: its roll axis (+Z) leans back with the column top.
    hub.rotation.x = -Math.atan2(COLUMN.hubZ - COLUMN.pivotZ, COLUMN.hubY - COLUMN.pivotY) * 0.35;
    m.add(hub);
    const yoke = mesh(yokeGeo, lining, DECK_PART.yoke(s), hub);
    return { pivot, column: m, yoke };
  });
  const pedalGeo = buildPedal();
  const pedals = new THREE.InstancedMesh(pedalGeo, lining, 4);
  pedals.name = DECK_PART.pedals;
  pedals.frustumCulled = false;
  group.add(pedals);

  // ── Light, backlighting: from the scene's sun (found once per scene) ──
  let scene: THREE.Object3D | null = null;
  let sun: THREE.DirectionalLight | null = null;
  const _sunTarget = new THREE.Vector3();
  const _sunDir = new THREE.Vector3();
  const flood = new THREE.Color(0xffd9a8);
  liningMesh.onBeforeRender = (_r, sc) => {
    light.update(group);
    if (sc !== scene) {
      scene = sc;
      sun = null;
      sc.traverse((o) => {
        if (!sun && (o as THREE.DirectionalLight).isDirectionalLight) sun = o as THREE.DirectionalLight;
      });
    }
    const s = sun as THREE.DirectionalLight | null;
    let elev = 30;
    if (s) {
      s.getWorldPosition(_sunDir).sub(s.target.getWorldPosition(_sunTarget));
      if (_sunDir.lengthSq() > 1e-12) elev = Math.asin(Math.max(-1, Math.min(1, _sunDir.normalize().y))) / DEG;
      light.fill.value.copy(s.color).multiplyScalar(s.intensity * DECK_BOUNCE);
    } else light.fill.value.setRGB(0, 0, 0);
    // Panel backlights and flood lights come up as the sun goes down.
    const dusk = Math.max(0, Math.min(1, (14 - elev) / 12));
    light.fill.value.add(_floodTmp.copy(flood).multiplyScalar(0.035 * dusk));
    faces.emissiveIntensity = 0.06 + 0.5 * dusk;
  };
  const _floodTmp = new THREE.Color();

  // ── Per-frame ──
  const pose = createDeckPose();
  const readings = createDeckReadings();
  const due = new Map<string, number>(DISPLAY_KEYS.map((k, i) => [k, i * 0.02]));
  const _m = new THREE.Matrix4();
  const _q = new THREE.Quaternion();
  const _e = new THREE.Euler();
  const _p = new THREE.Vector3();
  const _s = new THREE.Vector3(1, 1, 1);
  const _pos = { x: 0, z: 0 };
  let clock = 0;
  let wasIn = false;

  function redraw(k: string) {
    const cv = canvases.get(k);
    if (!cv) return;
    const t0 = performance.now();
    if (k === 'standby') drawStandby(cv.ctx, DECK_DISPLAY_CFG.standbyW, readings);
    else DISPLAY_PAINTERS[k as DisplayId](cv.ctx, DECK_DISPLAY_CFG.size, readings);
    cv.tex.needsUpdate = true;
    const ms = performance.now() - t0;
    stats.redraws++;
    stats.lastMs = ms;
    stats.maxMs = Math.max(stats.maxMs, ms);
  }

  function setVisualState(v: AircraftVisualState, dt: number) {
    const inCockpit = v.cameraMode === 'cockpit' && v.crashed !== true;
    if (inCockpit !== group.visible) group.visible = inCockpit;
    if (!inCockpit) {
      wasIn = false;
      return;
    }
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(dt, 0.5) : 0;
    stepDeckPose(pose, v, wasIn ? step : 0);
    // Aircraft position for the map: the deck group's world position.
    group.updateWorldMatrix(true, false);
    _pos.x = group.matrixWorld.elements[12];
    _pos.z = group.matrixWorld.elements[14];
    updateDeckReadings(readings, v, _pos, step);

    // Levers, columns, pedals.
    for (let i = 0; i < 4; i++) {
      _p.set(leverX(i), THRUST.pivotY, THRUST.pivotZ);
      _q.setFromEuler(_e.set(-pose.thrustDeg[i] * DEG, 0, 0));
      thrust.setMatrixAt(i, _m.compose(_p, _q, _s));
    }
    thrust.instanceMatrix.needsUpdate = true;
    sb.pivot.rotation.x = pose.speedBrakeDeg * DEG;
    flap.pivot.rotation.x = -pose.flapDeg * DEG;
    gearLever.rotation.x = (pose.gearLever - 0.5) * 2 * 32 * DEG;
    gearLever.position.y = (0.5 - pose.gearLever) * GEAR_LEVER.travel * 0.2;
    for (const c of columns) {
      c.pivot.rotation.x = pose.columnDeg * DEG;
      c.yoke.rotation.z = -pose.yokeDeg * DEG;
    }
    for (let i = 0; i < 4; i++) {
      const pilot = i < 2 ? EYE_CAPTAIN.x : EYE_FO.x;
      const side = i % 2 === 0 ? -1 : 1;
      // Left pedals move aft with right rudder, right pedals forward.
      _p.set(pilot + side * PEDALS.halfSpacing, PEDALS.y, PEDALS.z + (side < 0 ? pose.pedal : -pose.pedal));
      _q.identity();
      pedals.setMatrixAt(i, _m.compose(_p, _q, _s));
    }
    pedals.instanceMatrix.needsUpdate = true;

    // Displays: round-robin, the most overdue first, at most maxPerFrame per frame.
    clock += step;
    if (!wasIn) {
      // Entering the cockpit: everything is due now (spread over the next frames).
      let i = 0;
      for (const k of DISPLAY_KEYS) due.set(k, clock + i++ * 1e-3);
    }
    wasIn = true;
    for (let n = 0; n < DECK_DISPLAY_CFG.maxPerFrame; n++) {
      let best: string | null = null;
      let bestT = Infinity;
      for (const k of DISPLAY_KEYS) {
        const t = due.get(k) ?? 0;
        if (t <= clock && t < bestT) {
          bestT = t;
          best = k;
        }
      }
      if (!best) break;
      redraw(best);
      const hz = best === 'pfdL' || best === 'pfdR' ? DECK_DISPLAY_CFG.pfdHz : DECK_DISPLAY_CFG.otherHz;
      due.set(best, Math.max(clock, bestT + 1 / hz));
    }
  }

  return {
    group,
    setVisualState,
    readings,
    pose,
    stats,
    dispose() {
      const geos = new Set<THREE.BufferGeometry>();
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.geometry) geos.add(m.geometry);
      });
      geos.forEach((g) => g.dispose());
      thrust.dispose();
      pedals.dispose();
      lining.dispose();
      faces.dispose();
      glassMat.dispose();
      screenMats.forEach((m) => m.dispose());
      canvases.forEach((c) => c.tex.dispose());
      atlas?.dispose();
      glowAtlas?.dispose();
      group.removeFromParent();
    },
  };
}

/**
 * Put the flight deck into a 747 model handle: into its `b747.flightDeck` group when it has one
 * (else the root), chaining setVisualState and dispose. The deck keeps its place in the body frame
 * whatever the group's own transform. Returns the same handle.
 */
export function attachFlightDeck(h: AircraftModelHandle): AircraftModelHandle {
  const deck = createB747FlightDeck();
  const host = h.root.getObjectByName('b747.flightDeck');
  const parent = host ?? h.root;
  parent.add(deck.group);
  if (parent !== h.root) {
    // Body-frame placement → the host group's frame.
    h.root.updateWorldMatrix(true, true);
    const rel = new THREE.Matrix4().copy(h.root.matrixWorld).invert().multiply(parent.matrixWorld).invert();
    deck.group.applyMatrix4(rel);
  }
  // Placeholder hull (no flight-deck group yet): its boxes would cut through the deck in the cockpit view.
  const blockers = host ? [] : ['b747.fuselage', 'b747.upperDeck'].map((n) => h.root.getObjectByName(n)).filter((o): o is THREE.Object3D => !!o);
  const set = h.setVisualState.bind(h);
  const dispose = h.dispose.bind(h);
  h.setVisualState = (v, dt) => {
    set(v, dt);
    deck.setVisualState(v, dt);
    for (const b of blockers) b.visible = v.cameraMode !== 'cockpit';
  };
  h.dispose = () => {
    deck.dispose();
    dispose();
  };
  (h as { flightDeck?: B747FlightDeck }).flightDeck = deck;
  return h;
}
