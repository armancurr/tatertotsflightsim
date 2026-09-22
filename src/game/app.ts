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
 */
import * as THREE from 'three';
import { CONFIG, FT_TO_M } from '../config';
import type { AircraftState, CameraMode, Controls } from '../types';
import { createInitialState, createApproachState, approachControls, createTrimmedState, step } from '../physics';
import { createEnvironment } from '../world/environment';
import { createRenderer } from '../render/renderer';
import { createAtmosphere } from '../render/atmosphere';
import { createAircraft } from '../aircraft';
import type { AircraftVisualState } from '../aircraft/types';
import { createInputManager } from '../input/inputManager';
import { createControlState, updateControls, resetControls, type SimAction } from '../input/controlSystem';
import { createCameraRig, setCameraMode, nextCameraMode, snapCamera, updateCameraRig, shakeTarget, type CameraRigState } from '../camera/cameraRig';
import { applyCameraPose } from '../camera/threeCamera';
import { FixedStepLoop } from './loop';
import { createFpsMeter, recordFrame, fpsStats } from './fps';
import { interpolatePose } from './interpolate';
import { buildSimSnapshot, installSimApi } from './simApi';
import { createSystems } from './systems';

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

  // ── World, sky, aircraft ──────────────────────────────────────────────────
  const env = createEnvironment();
  const atmosphere = createAtmosphere(renderer, scene, { groundHeight: (x: number, z: number) => env.groundHeight(x, z) });
  const aircraft = createAircraft({ quality: 'high' });
  scene.add(aircraft.root);

  const surfaceHeight = (x: number, z: number) => {
    const g = env.groundHeight(x, z);
    const w = env.waterLevel(x, z);
    return w === null ? g : Math.max(g, w);
  };

  // ── Simulation state ──────────────────────────────────────────────────────
  let state: AircraftState = createInitialState(env);
  let prev: AircraftState = state;
  let controlState = createControlState();
  const camParam = params.get('cam') as CameraMode | null;
  let camRig: CameraRigState = createCameraRig(camParam && CAMERA_MODES.includes(camParam) ? camParam : 'chase');
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

  // Systems: terrain, water, airport, roads, towns, vegetation, traffic, fx, audio, HUD (auto-discovered).
  const systems = await createSystems({ renderer, scene, camera, env, hudRoot, aircraft, atmosphere });

  const resetTo = (which: 'runway' | 'approach') => {
    state = which === 'runway' ? createInitialState(env) : createApproachState(env);
    prev = state;
    controlState = resetControls(controlState, which === 'approach' ? approachControls() : undefined);
    camRig = snapCamera(camRig);
    loop.reset();
    systems.onReset(which);
  };
  const teleport = (t: TeleportRequest) => {
    const ground = surfaceHeight(t.x, t.z);
    const agl = (t.aglFt ?? 1500) * FT_TO_M;
    const trimmed = createTrimmedState(
      { altitudeM: ground + agl, iasKt: t.speedKt ?? 95, headingDeg: t.headingDeg ?? 0, x: t.x, z: t.z, gearDown: t.gearDown ?? false, flapsNotch: t.flapsNotch ?? 0 },
      env,
    );
    state = trimmed.state;
    prev = state;
    controlState = resetControls(controlState, trimmed.controls);
    camRig = snapCamera(camRig);
    loop.reset();
    systems.onReset('teleport');
  };
  const setCamera = (mode: CameraMode) => {
    camRig = setCameraMode(camRig, mode);
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
    systems: () => systems.names(),
    debug: () => ({ systems: systems.stats(), timings: systems.timings() }),
  });

  const spawn = params.get('spawn');
  if (spawn) {
    const [x, z, agl, hdg, kt] = spawn.split(',').map(Number);
    if (Number.isFinite(x) && Number.isFinite(z)) teleport({ x, z, aglFt: Number.isFinite(agl) ? agl : 1500, headingDeg: Number.isFinite(hdg) ? hdg : 0, speedKt: Number.isFinite(kt) ? kt : 95 });
  }

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
    const controls: Controls = controlState.controls;

    // Physics at a fixed 120 Hz.
    let alpha = 1;
    if (!paused) {
      const r = loop.advance(frameDt, (h) => {
        prev = state;
        state = step(state, controls, h, env);
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
    visual.crashed = state.phase === 'crashed';
    visual.crashAge = state.crash ? Math.max(0, state.time - state.crash.time) : 0;
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
    );
    camRig = cam.state;
    applyCameraPose(camera, cam.pose);
    camera.updateMatrixWorld();

    // Sky, world systems, render.
    focus.copy(aircraft.root.position);
    atmosphere.update(camera, frameDt, focus);
    const fps = fpsStats(fpsMeter);
    systems.update({ state, controls, controlState, camera, dt: frameDt, time: clock.time, paused, cameraMode: camRig.mode, fps, readings });

    renderer.render(scene, camera);

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
