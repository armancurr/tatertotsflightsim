/**
 * Towns world preview: the full world systems (terrain, water, airport, roads,
 * cars, towns, vegetation — no aircraft, HUD, audio or fx) with a free camera,
 * for photographing the towns and timing them on the GPU.
 * URL parameters:
 *   x, z, y      camera position (m); y is above the terrain unless abs=1
 *   heading      degrees clockwise from north; pitch degrees (+ up)
 *   look=x,z     look at this ground point instead of heading/pitch
 *   fov          vertical field of view (default 60)
 *   tod          time-of-day preset (0 morning, 1 midday, 2 golden hour, 3 dawn)
 *   no=a,b       systems to switch off (default hud,audio,fx)
 *   t            seconds to run the systems before window.__ready
 *   dyn=0        fixed resolution (for GPU timings)
 *   orbit=deg/s  circle the look point at this rate (smoothness QA)
 * window.__ready, window.__stats(), window.__townsGpu() (scene pass GPU ms, smoothed).
 */
import { FLEET, getAircraftDef } from '../fleet';
import * as THREE from 'three';
import { createRenderer } from '../render/renderer';
import { createAtmosphere } from '../render/atmosphere';
import { createEnvironment } from '../world/environment';
import { terrainHeight } from '../world/heightfield';
import { createSystems, discoverSystemModules } from '../game/systems';
import { createInitialState } from '../physics/aircraft';
import { createControlState } from '../input/controlSystem';
import { CONFIG } from '../config';

declare global {
  interface Window {
    __ready: boolean;
    __stats: () => unknown;
    __townsGpu: () => Record<string, number>;
  }
}

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const label = document.getElementById('label')!;
if (q.get('hud') === '0') label.style.display = 'none';
window.__ready = false;

async function main() {
  const container = document.getElementById('app')!;
  const rend = createRenderer(container, q.get('dyn') === '0' ? { dynamicResolution: false } : {});
  const renderer = rend.renderer;
  window.__townsGpu = () => rend.gpuTimings();
  // gpuTowns=1: after each frame the towns alone (lights kept, everything else hidden) are drawn again
  // into an offscreen target inside a timer query (raw samples; min/median by __townsMs()).
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const tq = q.get('gpuTowns') === '1' ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null) : null;
  const rt = new THREE.WebGLRenderTarget(innerWidth * devicePixelRatio, innerHeight * devicePixelRatio, { type: THREE.HalfFloatType, depthBuffer: true, samples: 4 });
  const queries: WebGLQuery[] = [];
  const townsMs: number[] = [];
  const hidden: THREE.Object3D[] = [];
  const reps = num('reps', 2);
  const measureTowns = () => {
    if (!tq) return;
    while (queries.length && gl.getQueryParameter(queries[0], gl.QUERY_RESULT_AVAILABLE)) {
      const qq = queries.shift()!;
      if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) townsMs.push((gl.getQueryParameter(qq, gl.QUERY_RESULT) as number) / 1e6 / reps);
      if (townsMs.length > 200) townsMs.shift();
      gl.deleteQuery(qq);
    }
    if (queries.length > 6) return;
    hidden.length = 0;
    for (const c of scene.children) {
      if (c.name === 'towns' || (c as THREE.Light).isLight || c === camera || !c.visible) continue;
      c.visible = false;
      hidden.push(c);
    }
    const bg = scene.background;
    scene.background = null;
    renderer.setRenderTarget(rt);
    renderer.clear();
    const qq = gl.createQuery()!;
    gl.beginQuery(tq.TIME_ELAPSED_EXT, qq);
    for (let k = 0; k < reps; k++) renderer.render(scene, camera);
    gl.endQuery(tq.TIME_ELAPSED_EXT);
    queries.push(qq);
    renderer.setRenderTarget(null);
    scene.background = bg;
    for (const c of hidden) c.visible = true;
  };
  (window as unknown as { __townsMs: () => unknown }).__townsMs = () => {
    const s = [...townsMs].sort((a, b) => a - b);
    return { n: s.length, min: s[0] ?? NaN, p25: s[Math.floor(s.length * 0.25)] ?? NaN, median: s[Math.floor(s.length / 2)] ?? NaN };
  };
  renderer.info.autoReset = false;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(num('fov', 60), innerWidth / innerHeight, CONFIG.camera.near, CONFIG.camera.far);
  scene.add(camera);
  const cx = num('x', 2100);
  const cz = num('z', 2300);
  const cy = q.get('abs') === '1' ? num('y', 200) : terrainHeight(cx, cz) + num('y', 200);
  camera.position.set(cx, cy, cz);
  const look = q.has('look') ? q.get('look')!.split(',').map(Number) : null;
  if (look) camera.lookAt(look[0], terrainHeight(look[0], look[1]), look[1]);
  else camera.rotation.set((num('pitch', -20) * Math.PI) / 180, (-num('heading', 0) * Math.PI) / 180, 0, 'YXZ');
  camera.updateMatrixWorld();
  const env = createEnvironment();
  const atmosphere = createAtmosphere(renderer, scene, { groundHeight: terrainHeight });
  if (q.has('tod')) atmosphere.setTimeOfDay(num('tod', 0));
  const hudRoot = document.createElement('div');
  const no = new Set((q.get('no') ?? 'hud,audio,fx').split(',').filter(Boolean));
  const stubAircraft = { root: new THREE.Group(), setVisualState: () => {}, dispose: () => {} };
  const def = getAircraftDef(null);
  const noop = () => {};
  const systems = await createSystems({
    renderer, scene, camera, env, hudRoot, aircraft: stubAircraft, atmosphere,
    actions: { reset: noop, selectAircraft: noop, setPaused: noop, isPaused: () => false, setCamera: noop, setTimeOfDay: (i) => atmosphere.setTimeOfDay(i), getTimeOfDay: () => 0, fleet: () => FLEET, currentAircraft: () => def },
  }, discoverSystemModules(), no);
  await systems.ready(camera, 15000);
  const state = createInitialState(env);
  const controlState = createControlState();
  const focus = new THREE.Vector3();
  let last = performance.now();
  let time = 0;
  let frames = 0;
  const fps = { fps: 60, avg: 60, min: 60, onePercentLow: 60, longFrames: 0, frames: 0 };
  const frameMs: number[] = [];
  const settle = num('t', 3);
  const orbit = num('orbit', 0);
  const r0 = look ? Math.hypot(cx - look[0], cz - look[1]) : 0;
  const a0 = look ? Math.atan2(cz - look[1], cx - look[0]) : 0;
  window.__stats = () => {
    const s = [...frameMs].sort((a, b) => a - b);
    const p = (f: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * f))] : 0);
    return { calls: renderer.info.render.calls, tris: renderer.info.render.triangles, p50: p(0.5), p99: p(0.99), max: s[s.length - 1], gpu: rend.gpuTimings(), towns: systems.stats().towns, timings: systems.timings() };
  };
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    frameMs.push(now - last);
    if (frameMs.length > 300) frameMs.shift();
    last = now;
    time += dt;
    frames++;
    if (orbit && look) {
      const a = a0 + (orbit * Math.PI / 180) * time;
      camera.position.set(look[0] + Math.cos(a) * r0, cy, look[1] + Math.sin(a) * r0);
      camera.lookAt(look[0], terrainHeight(look[0], look[1]), look[1]);
    }
    renderer.info.reset();
    focus.copy(camera.position);
    atmosphere.update(camera, dt, focus);
    systems.update({ state, controls: controlState.controls, controlState, camera, dt, time, paused: false, cameraMode: 'orbit', fps, readings: null, def, aircraft: stubAircraft });
    rend.render(scene, camera);
    measureTowns();
    if (!window.__ready && time > settle) window.__ready = true;
    if (frames % 30 === 0) label.textContent = `calls ${renderer.info.render.calls}  tris ${(renderer.info.render.triangles / 1e6).toFixed(2)}M  cam ${camera.position.x.toFixed(0)},${camera.position.y.toFixed(0)},${camera.position.z.toFixed(0)}  gpu ${JSON.stringify(rend.gpuTimings())}`;
  });
}
main().catch((e) => {
  console.error(e);
  label.textContent = String(e);
});
