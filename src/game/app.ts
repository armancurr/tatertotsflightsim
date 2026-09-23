/**
 * The simulator application: wires the pure simulation (input → controls →
 * fixed-step physics) to the renderer (atmosphere, aircraft, cameras) and to
 * the auto-discovered systems in src/game/systems (terrain, water, airport,
 * roads, towns, vegetation, traffic, fx, audio, HUD).
 *
 * Frame:
 *   input.frame() → updateControls → actions
 *   FixedStepLoop.advance(dt): step(state, controls, 1/120, env)   (physics at 120 Hz)
 *   interpolatePose(prev, state, alpha) → aircraft root + camera target
 *   camera rig → three camera; atmosphere; systems.update; render
 *   window.sim ← snapshot
 *
 * Dev/QA URL parameters:
 *   ?spawn=x,z,aglFt,headingDeg[,speedKt]   start airborne, trimmed, at a world position
 *   ?cam=cockpit|chase|external|orbit        initial camera
 *   ?tod=0..3                                time-of-day preset
 *   ?pause=1                                 start paused (the world still streams and renders)
 *   ?no=terrain,water,…                      switch systems off (see src/game/systems)
 *   ?aircraft=c172rg|f16|a10                 which aircraft to fly (src/fleet)
 *   ?spawn=range                             start 4 km short of the target range, 1,500 ft, 250 kt
 */
import * as THREE from 'three';
import { CONFIG, FT_TO_M } from '../config';
import type { AircraftState, CameraMode, Controls } from '../types';
import { createInitialState, createApproachState, approachControls, createTrimmedState, step } from '../physics';
import { createEnvironment } from '../world/environment';
import { createRenderer } from '../render/renderer';
import { createAtmosphere } from '../render/atmosphere';
import type { AircraftVisualState } from '../aircraft/types';
import { FLEET, getAircraftDef, type AircraftDef, type AircraftModelHandle } from '../fleet';
import { loadAircraftChoice, safeLocalStorage } from '../ui/picker';
import { createInputManager } from '../input/inputManager';
import { createControlState, updateControls, resetControls, type SimAction } from '../input/controlSystem';
import { createCameraRig, setCameraMode, nextCameraMode, snapCamera, updateCameraRig, shakeTarget, type CameraRigState } from '../camera/cameraRig';
import { applyCameraPose } from '../camera/threeCamera';
import { FixedStepLoop } from './loop';
import { createFpsMeter, recordFrame, fpsStats } from './fps';
import { interpolatePose } from './interpolate';
import { buildSimSnapshot, installSimApi } from './simApi';
import { createSystems } from './systems';
import { combatWorld } from '../combat/world';

export interface App {
  dispose(): void;
}

export interface TeleportRequest {
  x: number;
  z: number;
  /** Height above the ground/water, ft (default 1500). */
  aglFt?: number;
  headingDeg?: number;
  speedKt?: number;
  gearDown?: boolean;
  flapsNotch?: number;
}

const CAMERA_MODES: CameraMode[] = ['cockpit', 'chase', 'external', 'orbit'];

export async function startApp(container: HTMLElement, hudRoot: HTMLElement): Promise<App> {
  const cfg = CONFIG;
  const params = new URLSearchParams(location.search);

  // ── Renderer, scene, camera ───────────────────────────────────────────────
  const rend = createRenderer(container);
  const renderer = rend.renderer;
  renderer.info.autoReset = false;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(cfg.camera.chase.fov, innerWidth / innerHeight, cfg.camera.near, cfg.camera.far);
  scene.add(camera);
  // Targets, hits and the weapons status, shared by the weapons/targets/fx/audio/HUD systems.
  const combat = combatWorld(scene);

  // ── World, sky, aircraft ──────────────────────────────────────────────────
  const env = createEnvironment();
  const atmosphere = createAtmosphere(renderer, scene, { groundHeight: (x: number, z: number) => env.groundHeight(x, z) });
  // The aircraft being flown: its def carries the physics/camera config (`ac`) and the model factory.
  // URL first, then the player's last choice (saved by the aircraft picker), then the default.
  let def: AircraftDef = getAircraftDef(params.get('aircraft') ?? loadAircraftChoice(safeLocalStorage(), cfg.menu.storageKey));
  let ac = def.config;
  let aircraft: AircraftModelHandle = def.createModel();
  scene.add(aircraft.root);

  const surfaceHeight = (x: number, z: number) => {
    const g = env.groundHeight(x, z);
    const w = env.waterLevel(x, z);
    return w === null ? g : Math.max(g, w);
  };

  // ── Simulation state ──────────────────────────────────────────────────────
  let state: AircraftState = createInitialState(env, ac);
  let prev: AircraftState = state;
  let controlState = createControlState();
  const camParam = params.get('cam') as CameraMode | null;
  let camRig: CameraRigState = createCameraRig(camParam && CAMERA_MODES.includes(camParam) ? camParam : 'chase', ac);
  let paused = params.get('pause') === '1';
  let timeOfDay = 0;
  const loop = new FixedStepLoop(cfg.sim.fixedDt, cfg.sim.maxSubSteps, cfg.sim.maxFrameDt);
  const fpsMeter = createFpsMeter();
  const input = createInputManager(renderer.domElement, window);

  const setTimeOfDay = (i: number) => {
    const n = cfg.atmosphere.timeOfDay.length;
    timeOfDay = ((Math.round(i) % n) + n) % n;
    atmosphere.setTimeOfDay(timeOfDay);
  };
  if (params.has('tod')) setTimeOfDay(Number(params.get('tod')));

  // Declared before the systems are created: the menu (a system) calls these via ctx.actions.
  let resetTo: (which: 'runway' | 'approach') => void = () => {};
  let selectAircraft: (id: string) => void = () => {};
  const setCamera = (mode: CameraMode) => {
    camRig = setCameraMode(camRig, mode);
  };

  // Systems: terrain, water, airport, roads, towns, vegetation, traffic, fx, audio, HUD (auto-discovered).
  const systems = await createSystems({
    renderer, scene, camera, env, hudRoot, aircraft, atmosphere,
    actions: {
      reset: (which = 'runway') => resetTo(which),
      selectAircraft: (id) => selectAircraft(id),
      setPaused: (p) => {
        paused = p;
      },
      isPaused: () => paused,
      setCamera: (m) => setCamera(m),
      setTimeOfDay: (i) => setTimeOfDay(i),
      getTimeOfDay: () => timeOfDay,
      fleet: () => FLEET,
      currentAircraft: () => def,
    },
  });

  resetTo = (which: 'runway' | 'approach') => {
    state = which === 'runway' ? createInitialState(env, ac) : createApproachState(env, ac);
    prev = state;
    controlState = resetControls(controlState, which === 'approach' ? approachControls(ac) : undefined);
    camRig = snapCamera(camRig);
    loop.reset();
    aircraft.restoreBreakupParts?.();
    systems.onReset(which);
  };
  selectAircraft = (id: string) => {
    const next = getAircraftDef(id);
    if (next.id === def.id) return;
    scene.remove(aircraft.root);
    aircraft.dispose();
    def = next;
    ac = def.config;
    aircraft = def.createModel();
    scene.add(aircraft.root);
    camRig = createCameraRig(camRig.mode, ac);
    systems.onAircraftChange(def, aircraft);
    resetTo('runway');
    try {
      const u = new URL(location.href);
      u.searchParams.set('aircraft', def.id);
      history.replaceState(null, '', u);
    } catch {
      /* non-browser (tests) */
    }
  };
  const teleport = (t: TeleportRequest) => {
    const ground = surfaceHeight(t.x, t.z);
    const agl = (t.aglFt ?? 1500) * FT_TO_M;
    const trimmed = createTrimmedState(
      { altitudeM: ground + agl, iasKt: t.speedKt ?? 95, headingDeg: t.headingDeg ?? 0, x: t.x, z: t.z, gearDown: t.gearDown ?? false, flapsNotch: t.flapsNotch ?? 0 },
      env,
      ac,
    );
    state = trimmed.state;
    prev = state;
    controlState = resetControls(controlState, trimmed.controls);
    camRig = snapCamera(camRig);
    loop.reset();
    aircraft.restoreBreakupParts?.();
    systems.onReset('teleport');
  };

  const simApi = installSimApi(window, {
    reset: () => resetTo('runway'),
    resetApproach: () => resetTo('approach'),
    setCamera,
    setPaused: (p) => {
      paused = p;
    },
  });
  Object.assign(simApi.object, {
    teleport,
    setTimeOfDay,
    selectAircraft: (id: string) => selectAircraft(id),
    fleet: () => FLEET.map((d) => ({ id: d.id, name: d.name, shortName: d.shortName })),
    systems: () => systems.names(),
    debug: () => ({ systems: systems.stats(), timings: systems.timings() }),
  });

  const spawn = params.get('spawn');
  if (spawn === 'range') {
    // 4 km short of the target range, pointing at it (set by the targets system; falls back to north).
    const r = combat.range ?? { x: 0, z: -7000, headingDeg: 0 };
    const h = (r.headingDeg * Math.PI) / 180;
    teleport({ x: r.x - Math.sin(h) * 4000, z: r.z + Math.cos(h) * 4000, aglFt: 1500, headingDeg: r.headingDeg, speedKt: def.id === 'c172rg' ? 110 : 250 });
  } else if (spawn) {
    const [x, z, agl, hdg, kt] = spawn.split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(z)) teleport({ x, z, aglFt: Number.isFinite(agl) ? agl : 1500, headingDeg: Number.isFinite(hdg) ? hdg : 0, speedKt: Number.isFinite(kt) ? kt : 95 });
  }

  /** window.sim.combat: weapons status, stats and the targets (for QA scripts and tests). */
  const combatSnapshot = () => ({
    ...combat.status,
    stats: { ...combat.stats },
    range: combat.range,
    targets: combat.targets.length,
    alive: combat.targets.filter((t) => t.alive).length,
    list: () => combat.targets.map((t) => ({ id: t.id, kind: t.kind, alive: t.alive, health: t.health, x: t.position.x, y: t.position.y, z: t.position.z, headingDeg: t.headingDeg, group: t.group })),
  });

  Object.defineProperty(simApi.object, 'combat', { get: combatSnapshot, enumerable: true, configurable: true });

  const handleAction = (a: SimAction) => {
    switch (a) {
      case 'reset': resetTo('runway'); break;
      case 'resetApproach': resetTo('approach'); break;
      case 'pause': paused = !paused; break;
      case 'cameraNext': camRig = nextCameraMode(camRig); break;
      case 'camera:cockpit': setCamera('cockpit'); break;
      case 'camera:chase': setCamera('chase'); break;
      case 'camera:external': setCamera('external'); break;
      case 'camera:orbit': setCamera('orbit'); break;
      case 'timeOfDay': setTimeOfDay(timeOfDay + 1); break;
      default: break;
    }
    systems.onAction(a);
  };

  // ── Resize ────────────────────────────────────────────────────────────────
  const onResize = () => {
    rend.resize();
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    systems.onResize();
  };
  addEventListener('resize', onResize);

  // Build what's around the aircraft before the first frame so it never sits in the void.
  camera.position.set(state.position.x, state.position.y + 5, state.position.z + 20);
  camera.updateMatrixWorld();
  await systems.ready(camera, 8000);

  // ── Frame loop ────────────────────────────────────────────────────────────
  const clock = { last: performance.now() / 1000, time: 0 };
  const focus = new THREE.Vector3();
  const visual: AircraftVisualState = {
    elevator: 0, aileron: 0, rudder: 0, trim: 0, flapsDeg: 0, gearPos: 1,
    wheelCompression: [0, 0, 0], wheelRollSpeed: [0, 0, 0], nosewheelSteer: 0,
    propRpm: 0, engineRunning: true,
    lights: { nav: true, strobe: true, beacon: true, landing: true, taxi: true },
    time: 0, cameraMode: 'chase', instruments: null,
  };
  const renderStats = { calls: 0, triangles: 0, points: 0, lines: 0, geometries: 0, textures: 0 };

  const frame = () => {
    const now = performance.now() / 1000;
    const frameDt = Math.min(now - clock.last, cfg.sim.maxFrameDt);
    clock.last = now;
    clock.time += frameDt;
    renderer.info.reset();

    // Input → smoothed controls + discrete actions.
    const inFrame = input.frame();
    // While paused, only discrete actions (unpause, cameras, help…) are honoured; control toggles are discarded.
    const cu = updateControls(controlState, inFrame, paused ? 0 : frameDt);
    if (!paused) controlState = cu.state;
    for (const a of cu.actions) handleAction(a);
    // Systems may add to the pilot's controls (the weapons system sets gunFiring → gun recoil).
    const controls: Controls = paused ? controlState.controls : systems.adjustControls(controlState.controls, state, frameDt);

    // Physics at a fixed 120 Hz.
    let alpha = 1;
    if (!paused) {
      const r = loop.advance(frameDt, (h) => {
        prev = state;
        state = step(state, controls, h, env, ac);
      });
      alpha = r.alpha;
    }
    const pose = interpolatePose(prev, state, alpha);
    aircraft.root.position.set(pose.position.x, pose.position.y, pose.position.z);
    aircraft.root.quaternion.set(pose.orientation.x, pose.orientation.y, pose.orientation.z, pose.orientation.w);

    // Instruments + aircraft animation.
    const readings = systems.readings(state, controls, paused ? 0 : frameDt);
    visual.elevator = controls.elevator;
    visual.aileron = controls.aileron;
    visual.rudder = controls.rudder;
    visual.trim = controls.elevatorTrim;
    visual.flapsDeg = state.flapsDeg;
    visual.gearPos = state.gearPos;
    visual.wheelCompression = state.wheelCompression;
    const gs = state.onGround ? state.derived.groundSpeed : visual.wheelRollSpeed[1] * Math.exp(-frameDt * 0.4);
    visual.wheelRollSpeed = [gs, gs, gs];
    visual.nosewheelSteer = controls.rudder;
    visual.propRpm = state.engine.rpm;
    visual.engineRunning = state.engine.running;
    visual.lights.landing = controlState.landingLight;
    visual.lights.taxi = controlState.landingLight;
    visual.time = clock.time;
    visual.cameraMode = camRig.mode;
    visual.instruments = readings;
    visual.afterburner = state.engine.afterburner ?? 0;
    visual.speedBrake = controls.speedBrake ? 1 : 0;
    visual.crashed = state.phase === 'crashed';
    visual.crashAge = state.crash ? Math.max(0, state.time - state.crash.time) : 0;
    visual.gunSpin = combat.status.gunSpin;
    visual.gunFiring = combat.status.gunFiring;
    visual.stores = combat.status.stores;
    visual.airStores = combat.status.airStores;
    aircraft.setVisualState(visual, frameDt);

    // Camera.
    const shake =
      systems.cameraShake(state) ??
      shakeTarget({
        onGround: state.onGround,
        groundSpeed: state.derived.groundSpeed,
        stalled: state.stalled,
        crashAge: state.crash ? state.time - state.crash.time : null,
      });
    const cam = updateCameraRig(
      camRig,
      { position: pose.position, orientation: pose.orientation, velocity: state.velocity, onGround: state.onGround },
      { dx: inFrame.mouse.dx, dy: inFrame.mouse.dy, wheel: inFrame.mouse.wheel, dragging: inFrame.mouse.dragging, shake },
      frameDt,
      surfaceHeight,
      ac,
    );
    camRig = cam.state;
    applyCameraPose(camera, cam.pose);
    camera.updateMatrixWorld();

    // Sky, world systems, render.
    focus.copy(aircraft.root.position);
    atmosphere.update(camera, frameDt, focus);
    const fps = fpsStats(fpsMeter);
    const sysFrame = { state, controls, controlState, camera, dt: frameDt, time: clock.time, paused, cameraMode: camRig.mode, fps, readings, def, aircraft };
    systems.update(sysFrame);

    renderer.render(scene, camera);
    systems.postRender(sysFrame);

    const info = renderer.info;
    renderStats.calls = info.render.calls;
    renderStats.triangles = info.render.triangles;
    renderStats.points = info.render.points;
    renderStats.lines = info.render.lines;
    renderStats.geometries = info.memory.geometries;
    renderStats.textures = info.memory.textures;
    recordFrame(fpsMeter, frameDt, now);
    simApi.update(buildSimSnapshot({ state, controls, fps: fpsStats(fpsMeter), cameraMode: camRig.mode, paused }));
    simApi.object.render = renderStats;
    simApi.object.timeOfDay = atmosphere.timeOfDayName;
    simApi.object.aircraft = def.id;
    (simApi.object.perf as Record<string, unknown>).systems = systems.timings();
  };
  renderer.setAnimationLoop(frame);

  return {
    dispose() {
      renderer.setAnimationLoop(null);
      removeEventListener('resize', onResize);
      input.dispose();
      systems.dispose();
      atmosphere.dispose();
      aircraft.dispose();
      rend.dispose();
    },
  };
}
