/**
 * INTERIM flyable build, shown while the wave-1 renderer modules (terrain,
 * atmosphere, aircraft model, HUD) are still being built. It uses the real
 * physics, controls, cameras, fixed-step loop and window.sim, with stand-in
 * visuals. Replaced by src/game/app.ts once those modules land.
 */
import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';
import { CONFIG, MS_TO_KT, M_TO_FT, MS_TO_FPM } from '../config';
import type { AircraftState, CameraMode } from '../types';
import { createInitialState, createApproachState, approachControls, step, FLAT_ENV } from '../physics';
import { createInputManager } from '../input/inputManager';
import { createControlState, updateControls, resetControls, type SimAction } from '../input/controlSystem';
import { createCameraRig, setCameraMode, nextCameraMode, snapCamera, updateCameraRig, shakeTarget } from '../camera/cameraRig';
import { applyCameraPose } from '../camera/threeCamera';
import { FixedStepLoop } from './loop';
import { createFpsMeter, recordFrame, fpsStats } from './fps';
import { interpolatePose } from './interpolate';
import { buildSimSnapshot, installSimApi } from './simApi';
import { runwayFrame } from '../world/runway';

export function startPrototype(container: HTMLElement, hudRoot: HTMLElement): void {
  const cfg = CONFIG;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.5;
  renderer.shadowMap.enabled = true;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(60, innerWidth / innerHeight, 0.1, 60000);
  scene.fog = new THREE.FogExp2(0xa9c3dd, 0.00005);

  const sky = new Sky();
  sky.scale.setScalar(50000);
  const sun = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - 38), THREE.MathUtils.degToRad(125));
  sky.material.uniforms.sunPosition.value.copy(sun);
  sky.material.uniforms.turbidity.value = 3;
  sky.material.uniforms.rayleigh.value = 1.4;
  scene.add(sky);

  const light = new THREE.DirectionalLight(0xfff1dd, 3);
  light.position.copy(sun).multiplyScalar(500);
  light.castShadow = true;
  light.shadow.mapSize.set(2048, 2048);
  Object.assign(light.shadow.camera, { left: -60, right: 60, top: 60, bottom: -60, near: 1, far: 2000 });
  scene.add(light, light.target);
  scene.add(new THREE.HemisphereLight(0xbcd6ff, 0x4a5a2a, 1.1));

  // Stand-in ground: a big grass plane with a canvas-noise texture, and the runway.
  const cv = document.createElement('canvas');
  cv.width = cv.height = 256;
  const g2 = cv.getContext('2d')!;
  for (let i = 0; i < 256 * 256; i += 1) {
    const v = 90 + Math.random() * 40;
    g2.fillStyle = `rgb(${v * 0.55},${v},${v * 0.35})`;
    g2.fillRect(i % 256, (i / 256) | 0, 1, 1);
  }
  const grassTex = new THREE.CanvasTexture(cv);
  grassTex.wrapS = grassTex.wrapT = THREE.RepeatWrapping;
  grassTex.repeat.set(4000, 4000);
  grassTex.colorSpace = THREE.SRGBColorSpace;
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(200000, 200000), new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.15;
  ground.receiveShadow = true;
  scene.add(ground);

  const rw = runwayFrame();
  const runway = new THREE.Mesh(new THREE.PlaneGeometry(rw.width, rw.length), new THREE.MeshStandardMaterial({ color: 0x3a3c40, roughness: 0.9 }));
  runway.rotation.x = -Math.PI / 2;
  runway.position.set(rw.center.x, 0, rw.center.z);
  runway.receiveShadow = true;
  scene.add(runway);
  const white = new THREE.MeshBasicMaterial({ color: 0xf2f2f2, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  for (let a = 60; a < rw.length - 60; a += 60) {
    const d = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 36), white);
    d.rotation.x = -Math.PI / 2;
    d.position.set(rw.center.x, 0.03, rw.threshold.z - a);
    scene.add(d);
  }
  for (const end of [rw.threshold.z - 25, rw.farEnd.z + 25]) {
    for (let k = -6; k <= 6; k++) {
      if (k === 0) continue;
      const p = new THREE.Mesh(new THREE.PlaneGeometry(1.8, 30), white);
      p.rotation.x = -Math.PI / 2;
      p.position.set(k * 2.2, 0.03, end);
      scene.add(p);
    }
  }
  // Scatter some hills and trees in the distance so motion is readable.
  const hillMat = new THREE.MeshStandardMaterial({ color: 0x55703c, flatShading: true });
  for (let i = 0; i < 60; i++) {
    const r = 3000 + Math.random() * 25000;
    const a = Math.random() * Math.PI * 2;
    const h = 200 + Math.random() * 1500;
    const m = new THREE.Mesh(new THREE.ConeGeometry(h * 1.8, h, 7), hillMat);
    m.position.set(Math.cos(a) * r, h / 2 - 5, Math.sin(a) * r);
    scene.add(m);
  }

  // Stand-in aircraft: a simple high-wing silhouette at the correct scale.
  const plane = new THREE.Group();
  const paint = new THREE.MeshStandardMaterial({ color: 0xf5f5f2, roughness: 0.35, metalness: 0.1 });
  const stripe = new THREE.MeshStandardMaterial({ color: 0x1c3f7a, roughness: 0.4 });
  const fus = new THREE.Mesh(new THREE.CapsuleGeometry(0.55, 5.2, 6, 12), paint);
  fus.rotation.x = Math.PI / 2;
  fus.position.set(0, 0.1, 1.0);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(10.92, 0.16, 1.5), paint);
  wing.position.set(0, 1.0, 0.2);
  const stab = new THREE.Mesh(new THREE.BoxGeometry(3.45, 0.1, 1.0), paint);
  stab.position.set(0, 0.0, 5.3);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.5, 1.2), stripe);
  fin.position.set(0, 0.8, 5.5);
  const wheelGeo = new THREE.CylinderGeometry(0.19, 0.19, 0.14, 16);
  wheelGeo.rotateZ(Math.PI / 2);
  const tyre = new THREE.MeshStandardMaterial({ color: 0x111111 });
  const g = cfg.aircraft.geometry;
  for (const w of [g.noseWheel, g.leftMainWheel, g.rightMainWheel]) {
    const m = new THREE.Mesh(wheelGeo, tyre);
    m.position.set(w.x, w.y + 0.19, w.z);
    plane.add(m);
  }
  const prop = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.12, 0.04), new THREE.MeshStandardMaterial({ color: 0x222222 }));
  prop.position.set(g.propHub.x, g.propHub.y, g.propHub.z);
  plane.add(fus, wing, stab, fin, prop);
  plane.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.castShadow = true; });
  scene.add(plane);

  // HUD (interim text readout).
  const hud = document.createElement('div');
  hud.style.cssText = 'position:fixed;left:16px;bottom:16px;padding:10px 14px;background:rgba(8,14,24,.62);color:#e8f0ff;font:13px/1.5 ui-monospace,Menlo,monospace;border-radius:10px;pointer-events:none;white-space:pre';
  hudRoot.appendChild(hud);
  const banner = document.createElement('div');
  banner.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);padding:6px 14px;background:rgba(8,14,24,.55);color:#ffd27a;font:12px system-ui;border-radius:8px;pointer-events:none';
  banner.textContent = 'INTERIM BUILD — real physics & controls, stand-in visuals · W/S throttle · ↑↓←→ yoke · A/D rudder · F/V flaps · G gear · C camera · R reset · Shift+R approach';
  hudRoot.appendChild(banner);

  let state: AircraftState = createInitialState(FLAT_ENV);
  let prev = state;
  let controlState = createControlState();
  let rig = createCameraRig('chase');
  let paused = false;
  const loop = new FixedStepLoop(cfg.sim.fixedDt, cfg.sim.maxSubSteps, cfg.sim.maxFrameDt);
  const meter = createFpsMeter();
  const input = createInputManager(renderer.domElement, window);
  const resetTo = (w: 'runway' | 'approach') => {
    state = w === 'runway' ? createInitialState(FLAT_ENV) : createApproachState(FLAT_ENV);
    prev = state;
    controlState = resetControls(controlState, w === 'approach' ? approachControls() : undefined);
    rig = snapCamera(rig);
    loop.reset();
  };
  const api = installSimApi(window, {
    reset: () => resetTo('runway'),
    resetApproach: () => resetTo('approach'),
    setCamera: (m: CameraMode) => { rig = setCameraMode(rig, m); },
    setPaused: (p) => { paused = p; },
  });
  const act = (a: SimAction) => {
    if (a === 'reset') resetTo('runway');
    else if (a === 'resetApproach') resetTo('approach');
    else if (a === 'pause') paused = !paused;
    else if (a === 'cameraNext') rig = nextCameraMode(rig);
    else if (a.startsWith('camera:')) rig = setCameraMode(rig, a.slice(7) as CameraMode);
  };
  addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });

  let last = performance.now() / 1000;
  let propAngle = 0;
  renderer.setAnimationLoop(() => {
    const now = performance.now() / 1000;
    const dt = Math.min(now - last, 0.25);
    last = now;
    const f = input.frame();
    const cu = updateControls(controlState, f, paused ? 0 : dt);
    if (!paused) controlState = cu.state;
    cu.actions.forEach(act);
    const c = controlState.controls;
    let alpha = 1;
    if (!paused) alpha = loop.advance(dt, (h) => { prev = state; state = step(state, c, h, FLAT_ENV); }).alpha;
    const p = interpolatePose(prev, state, alpha);
    plane.position.set(p.position.x, p.position.y, p.position.z);
    plane.quaternion.set(p.orientation.x, p.orientation.y, p.orientation.z, p.orientation.w);
    propAngle += (state.engine.rpm / 60) * Math.PI * 2 * dt;
    prop.rotation.z = propAngle;
    plane.visible = rig.mode !== 'cockpit';
    const cam = updateCameraRig(rig, { position: p.position, orientation: p.orientation, velocity: state.velocity, onGround: state.onGround },
      { dx: f.mouse.dx, dy: f.mouse.dy, wheel: f.mouse.wheel, dragging: f.mouse.dragging,
        shake: shakeTarget({ onGround: state.onGround, groundSpeed: state.derived.groundSpeed, stalled: state.stalled, crashAge: state.crash ? state.time - state.crash.time : null }) },
      dt, () => 0);
    rig = cam.state;
    applyCameraPose(camera, cam.pose);
    light.position.set(plane.position.x + sun.x * 500, plane.position.y + sun.y * 500, plane.position.z + sun.z * 500);
    light.target.position.copy(plane.position);
    renderer.render(scene, camera);
    recordFrame(meter, dt, now);
    const st = fpsStats(meter);
    const snap = buildSimSnapshot({ state, controls: c, fps: st, cameraMode: rig.mode, paused });
    api.update(snap);
    const d = state.derived;
    hud.textContent =
      `IAS ${(d.ias * MS_TO_KT).toFixed(0).padStart(4)} kt   ALT ${(state.position.y * M_TO_FT).toFixed(0).padStart(5)} ft   VS ${(d.verticalSpeed * MS_TO_FPM).toFixed(0).padStart(5)} fpm\n` +
      `HDG ${d.headingDeg.toFixed(0).padStart(4)}°    PITCH ${d.pitchDeg.toFixed(1).padStart(5)}°  ROLL ${d.rollDeg.toFixed(1).padStart(6)}°\n` +
      `THR ${(c.throttle * 100).toFixed(0).padStart(4)} %   RPM ${state.engine.rpm.toFixed(0).padStart(5)}   FLAPS ${state.flapsDeg.toFixed(0)}°  GEAR ${snap.gear.toUpperCase()}\n` +
      `STATE ${snap.state.toUpperCase()}${state.crash ? ' — ' + state.crash.reason + ' (R to reset)' : ''}${state.touchdown ? '   LAST LANDING ' + state.touchdown.rating.toUpperCase() + ' ' + state.touchdown.verticalSpeedFpm.toFixed(0) + ' fpm' : ''}\n` +
      `CAM ${rig.mode}   ${st.fps.toFixed(0)} fps${paused ? '   PAUSED' : ''}`;
  });
}
