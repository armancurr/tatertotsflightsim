/**
 * The simulator application: wires the pure simulation (input → controls →
 * fixed-step physics) to the renderer (world, atmosphere, aircraft, cameras,
 * HUD, audio). This is the only module that knows about all the others.
 *
 * Frame:
 *   input.frame() → updateControls → actions
 *   FixedStepLoop.advance(dt): step(state, controls, 1/120, env)   (physics at 120 Hz)
 *   interpolatePose(prev, state, alpha) → aircraft root + camera target
 *   camera rig → three camera; world/atmosphere/water update; HUD; audio; render
 *   window.sim ← snapshot
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import type { AircraftState, CameraMode, Controls, Environment } from '../types';
import { createInitialState, createApproachState, approachControls, step } from '../physics';
import { createEnvironment } from '../world/environment';
import { createTerrain, createWater } from '../world/terrainIndex';
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
import { createExtras, type Extras } from './extras';

export interface App {
  dispose(): void;
}

export async function startApp(container: HTMLElement, hudRoot: HTMLElement): Promise<App> {
  const cfg = CONFIG;

  // ── Renderer, scene, camera ───────────────────────────────────────────────
  const rend = createRenderer(container);
  const renderer = rend.renderer;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(cfg.camera.chase.fov, innerWidth / innerHeight, cfg.camera.near, cfg.camera.far);
  scene.add(camera);

  // ── World ─────────────────────────────────────────────────────────────────
  const env = createEnvironment();
  const atmosphere = createAtmosphere(renderer, scene);
  const terrain = createTerrain(renderer, scene);
  const water = createWater(scene);

  // ── Aircraft ──────────────────────────────────────────────────────────────
  const aircraft = createAircraft({ quality: 'high' });
  scene.add(aircraft.root);

  // ── Simulation state ──────────────────────────────────────────────────────
  let state: AircraftState = createInitialState(env);
  let prev: AircraftState = state;
  let controlState = createControlState();
  let camRig: CameraRigState = createCameraRig('chase');
  let paused = false;
  let timeOfDay = 0;
  const loop = new FixedStepLoop(cfg.sim.fixedDt, cfg.sim.maxSubSteps, cfg.sim.maxFrameDt);
  const fpsMeter = createFpsMeter();
  const input = createInputManager(renderer.domElement, window);

  // Wave-2 systems (HUD, audio, airport, vegetation, towns, fx) plug in here.
  const extras: Extras = await createExtras({ renderer, scene, camera, env, hudRoot, aircraft, atmosphere });

  const resetTo = (which: 'runway' | 'approach') => {
    state = which === 'runway' ? createInitialState(env) : createApproachState(env);
    prev = state;
    controlState = resetControls(controlState, which === 'approach' ? approachControls() : undefined);
    camRig = snapCamera(camRig);
    loop.reset();
    extras.onReset?.(which);
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
      case 'timeOfDay':
        timeOfDay = (timeOfDay + 1) % cfg.atmosphere.timeOfDay.length;
        atmosphere.setTimeOfDay(timeOfDay);
        break;
      default: break;
    }
    extras.onAction?.(a);
  };

  // ── Resize ────────────────────────────────────────────────────────────────
  const onResize = () => {
    rend.resize();
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    extras.onResize?.();
  };
  addEventListener('resize', onResize);

  // Build the tiles around the runway before the first frame so the aircraft never sits in the void.
  camera.position.set(state.position.x, state.position.y + 5, state.position.z + 20);
  camera.updateMatrixWorld();
  terrain.update(camera);
  await Promise.race([terrain.ready(), new Promise((r) => setTimeout(r, 8000))]);

  // ── Frame loop ────────────────────────────────────────────────────────────
  const clock = { last: performance.now() / 1000, time: 0 };
  const groundHeight = (x: number, z: number) => {
    const g = env.groundHeight(x, z);
    const w = env.waterLevel(x, z);
    return w === null ? g : Math.max(g, w);
  };
  const focus = new THREE.Vector3();
  const visual: AircraftVisualState = {
    elevator: 0, aileron: 0, rudder: 0, trim: 0, flapsDeg: 0, gearPos: 1,
    wheelCompression: [0, 0, 0], wheelRollSpeed: [0, 0, 0], nosewheelSteer: 0,
    propRpm: 0, engineRunning: true,
    lights: { nav: true, strobe: true, beacon: true, landing: true, taxi: true },
    time: 0, cameraMode: 'chase', instruments: null,
  };

  const frame = () => {
    const now = performance.now() / 1000;
    const frameDt = Math.min(now - clock.last, cfg.sim.maxFrameDt);
    clock.last = now;
    clock.time += frameDt;

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
        state = step(state, controls, h, env as Environment);
      });
      alpha = r.alpha;
    }
    const pose = interpolatePose(prev, state, alpha);
    aircraft.root.position.set(pose.position.x, pose.position.y, pose.position.z);
    aircraft.root.quaternion.set(pose.orientation.x, pose.orientation.y, pose.orientation.z, pose.orientation.w);

    // Aircraft animation.
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
    visual.instruments = extras.readings?.(state, controls, frameDt) ?? null;
    aircraft.setVisualState(visual, frameDt);

    // Camera.
    const shake = extras.cameraShake?.(state) ??
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
      groundHeight,
    );
    camRig = cam.state;
    applyCameraPose(camera, cam.pose);
    camera.updateMatrixWorld();

    // World.
    focus.copy(aircraft.root.position);
    atmosphere.update(camera, frameDt, focus);
    terrain.update(camera);
    water.update(camera, clock.time, atmosphere.sunDirection);
    extras.update?.({ state, controls, controlState, camera, dt: frameDt, time: clock.time, paused, cameraMode: camRig.mode, fps: fpsStats(fpsMeter) });

    renderer.render(scene, camera);

    recordFrame(fpsMeter, frameDt, now);
    simApi.update(buildSimSnapshot({ state, controls, fps: fpsStats(fpsMeter), cameraMode: camRig.mode, paused }));
  };
  renderer.setAnimationLoop(frame);

  return {
    dispose() {
      renderer.setAnimationLoop(null);
      removeEventListener('resize', onResize);
      input.dispose();
      extras.dispose?.();
      terrain.dispose();
      water.dispose();
      atmosphere.dispose();
      aircraft.dispose();
      rend.dispose();
    },
  };
}
