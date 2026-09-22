/**
 * Terrain + water preview. URL parameters:
 *   x, y, z            camera position (m; default 0, 32, 750 — on the runway)
 *   heading, pitch     degrees (heading clockwise from north, pitch + up)
 *   fov                vertical field of view (default 60)
 *   agl=1              treat y as height above the terrain
 *   sunEl, sunAz       sun elevation / azimuth, degrees (basic mode; default 38 / 125)
 *   env=0              no PMREM sky environment (tests the water's sky fallback)
 *   atmo=1             use the real renderer + atmosphere (HDR, aerial perspective, clouds)
 *   tod                time-of-day preset in atmo mode
 *   fly=<m/s>          fly forward along the heading (streaming / hitch test)
 *   hud=0              hide the label
 *   gpu=1              measure GPU time per frame (EXT_disjoint_timer_query_webgl2) → window.__gpu()
 *   water=0, terrain=0 hide the water / the terrain (GPU cost baselines)
 * window.__fps (smoothed), window.__ready (terrain.ready() resolved),
 * window.__stats() (terrain stats + frame-time percentiles), window.__terrain.
 */
import * as THREE from 'three';
import { createTerrain } from '../world/terrain';
import { createWater } from '../world/water';
import { terrainHeight } from '../world/heightfield';
import { CONFIG } from '../config';

declare global {
  interface Window {
    __fps: number;
    __ready: boolean;
    __stats: () => unknown;
    __terrain: unknown;
    __gpu: () => { median: number; p90: number; n: number } | null;
  }
}

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const flag = (k: string, d = false) => (q.has(k) ? q.get(k) !== '0' : d);
const container = document.getElementById('app')!;
const label = document.getElementById('label')!;
if (!flag('hud', true)) label.style.display = 'none';

window.__fps = 0;
window.__ready = false;

async function main() {
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(num('fov', 60), innerWidth / innerHeight, 0.5, CONFIG.camera.far);
  const cx = num('x', 0);
  const cz = num('z', 750);
  let cy = num('y', 32);
  if (flag('agl')) cy += terrainHeight(cx, cz);
  camera.position.set(cx, cy, cz);
  const heading = num('heading', 0);
  camera.rotation.set((num('pitch', 0) * Math.PI) / 180, (-heading * Math.PI) / 180, 0, 'YXZ');
  scene.add(camera);

  const sunDir = new THREE.Vector3();
  let renderFn: () => void;
  let renderer: THREE.WebGLRenderer;
  let atmoUpdate: ((dt: number) => void) | null = null;

  if (flag('atmo')) {
    const { createRenderer } = await import('../render/renderer');
    const { createAtmosphere } = await import('../render/atmosphere');
    const rend = createRenderer(container, {});
    renderer = rend.renderer;
    const atmo = createAtmosphere(renderer, scene, { groundHeight: terrainHeight });
    if (q.has('tod')) atmo.setTimeOfDay(num('tod', 0));
    const focus = new THREE.Vector3();
    atmoUpdate = (dt) => {
      focus.copy(camera.position);
      atmo.update(camera, dt, focus);
      sunDir.copy(atmo.sunDirection);
    };
    renderFn = () => rend.render(scene, camera);
  } else {
    let clip = false;
    try {
      const gl = document.createElement('canvas').getContext('webgl2');
      clip = !!gl?.getExtension('EXT_clip_control');
    } catch {
      clip = false;
    }
    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance', reversedDepthBuffer: clip, logarithmicDepthBuffer: !clip });
    renderer.setPixelRatio(Math.min(devicePixelRatio, CONFIG.render.maxPixelRatio));
    renderer.setSize(innerWidth, innerHeight);
    renderer.toneMapping = THREE.AgXToneMapping;
    renderer.toneMappingExposure = 1.9;
    renderer.shadowMap.enabled = false;
    container.appendChild(renderer.domElement);
    const skyTop = new THREE.Color().setRGB(0.16, 0.34, 0.72, THREE.LinearSRGBColorSpace);
    const haze = new THREE.Color().setRGB(0.52, 0.62, 0.76, THREE.LinearSRGBColorSpace);
    scene.background = haze.clone();
    scene.fog = new THREE.FogExp2(haze.getHex(), 0.00006);
    const el = (num('sunEl', 38) * Math.PI) / 180;
    const az = (num('sunAz', 125) * Math.PI) / 180;
    sunDir.set(Math.cos(el) * Math.sin(az), Math.sin(el), -Math.cos(el) * Math.cos(az)).normalize();
    const sun = new THREE.DirectionalLight(new THREE.Color(1.0, 0.96, 0.9), CONFIG.atmosphere.sunIntensity);
    sun.position.copy(sunDir).multiplyScalar(1000);
    scene.add(sun, sun.target);
    const hemi = new THREE.HemisphereLight(skyTop, new THREE.Color(0.18, 0.17, 0.12), 0.9);
    scene.add(hemi);
    if (flag('env', true)) {
      // a simple gradient sky baked to a PMREM environment (reflections on the water)
      const skyScene = new THREE.Scene();
      const skyMat = new THREE.ShaderMaterial({
        side: THREE.BackSide,
        uniforms: { top: { value: skyTop }, hor: { value: haze }, sun: { value: sunDir } },
        vertexShader: 'varying vec3 vd; void main(){ vd = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
        fragmentShader:
          'uniform vec3 top; uniform vec3 hor; uniform vec3 sun; varying vec3 vd; void main(){ float t = pow(clamp(vd.y,0.0,1.0),0.45); vec3 c = mix(hor, top, t); c = mix(c, hor*0.5, step(vd.y,0.0)); c += vec3(1.0,0.9,0.7)*pow(max(dot(normalize(vd),sun),0.0),900.0)*60.0; gl_FragColor = vec4(c,1.0); }',
      });
      skyScene.add(new THREE.Mesh(new THREE.SphereGeometry(10, 32, 16), skyMat));
      const pmrem = new THREE.PMREMGenerator(renderer);
      scene.environment = pmrem.fromScene(skyScene, 0.02).texture;
      scene.environmentIntensity = 0.6;
      hemi.intensity = 0.35;
    }
    addEventListener('resize', () => renderer.setSize(innerWidth, innerHeight));
    renderFn = () => renderer.render(scene, camera);
  }
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });

  const terrain = createTerrain(renderer, scene);
  const water = createWater(scene);
  if (!flag('terrain', true)) terrain.group.visible = false;
  if (!flag('water', true)) scene.traverse((o) => {
    if (o !== terrain.group && o.parent === scene && o.name.toLowerCase().includes('water')) o.visible = false;
  });
  // GPU timer around each frame's render (median of recent frames).
  const gl = renderer.getContext() as WebGL2RenderingContext;
  const tq = flag('gpu') ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null) : null;
  const gpuMs: number[] = [];
  const inflight: WebGLQuery[] = [];
  window.__gpu = () => {
    if (!gpuMs.length) return null;
    const s = [...gpuMs].sort((a, b) => a - b);
    return { median: s[Math.floor(s.length / 2)], p90: s[Math.floor(s.length * 0.9)], n: s.length };
  };
  window.__terrain = terrain;
  terrain.update(camera);
  terrain.ready().then(() => {
    window.__ready = true;
  });

  const fly = num('fly', 0);
  const frameMs: number[] = [];
  let last = performance.now();
  let fpsAcc = 0;
  let fpsFrames = 0;
  window.__stats = () => {
    const s = [...frameMs].sort((a, b) => a - b);
    const p = (f: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * f))] : 0);
    return { ...terrain.stats(), fps: window.__fps, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: s[s.length - 1] ?? 0, calls: renderer.info.render.calls, tris: renderer.info.render.triangles };
  };
  const t0 = performance.now();
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    frameMs.push(now - last);
    if (frameMs.length > 600) frameMs.shift();
    last = now;
    fpsAcc += dt;
    fpsFrames++;
    if (fpsAcc > 0.5) {
      window.__fps = Math.round((fpsFrames / fpsAcc) * 10) / 10;
      fpsAcc = 0;
      fpsFrames = 0;
    }
    if (fly > 0) {
      const h = (heading * Math.PI) / 180;
      camera.position.x += Math.sin(h) * fly * dt;
      camera.position.z -= Math.cos(h) * fly * dt;
      if (flag('agl')) camera.position.y = terrainHeight(camera.position.x, camera.position.z) + num('y', 32);
    }
    camera.updateMatrixWorld();
    atmoUpdate?.(dt);
    terrain.update(camera);
    water.update(camera, (now - t0) / 1000, sunDir);
    let qy: WebGLQuery | null = null;
    if (tq) {
      qy = gl.createQuery();
      if (qy) gl.beginQuery(tq.TIME_ELAPSED_EXT, qy);
    }
    renderFn();
    if (tq && qy) {
      gl.endQuery(tq.TIME_ELAPSED_EXT);
      inflight.push(qy);
      while (inflight.length && gl.getQueryParameter(inflight[0], gl.QUERY_RESULT_AVAILABLE)) {
        const q0 = inflight.shift()!;
        if (!gl.getParameter(tq.GPU_DISJOINT_EXT)) gpuMs.push(gl.getQueryParameter(q0, gl.QUERY_RESULT) / 1e6);
        gl.deleteQuery(q0);
        if (gpuMs.length > 240) gpuMs.shift();
      }
    }
    if (flag('hud', true) && fpsFrames === 0) {
      const st = terrain.stats();
      label.textContent = `fps ${window.__fps}  tiles ${st.tiles}  pending ${st.pending}  tris ${(st.triangles / 1e6).toFixed(2)}M  calls ${renderer.info.render.calls}  ${window.__ready ? 'ready' : 'loading'}\ncam ${camera.position.x.toFixed(0)}, ${camera.position.y.toFixed(0)}, ${camera.position.z.toFixed(0)}  ground ${terrainHeight(camera.position.x, camera.position.z).toFixed(1)} m`;
    }
  });
}

main().catch((e) => {
  console.error(e);
  label.textContent = String(e);
});
