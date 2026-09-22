/**
 * Airport preview (real renderer + atmosphere + terrain + airport). URL parameters:
 *   x, y, z            camera position (m; y is height above the terrain unless abs=1)
 *   heading, pitch     degrees (heading clockwise from north, pitch + up)
 *   look=x,y,z         aim the camera at a world point instead (y above the terrain)
 *   fov                vertical field of view (default 60)
 *   tod                time-of-day preset (0 morning, 1 midday, 2 golden hour, 3 dawn)
 *   t                  animation time offset, s (rabbit / beacon / windsock phase)
 *   hud=0              hide the label
 * window.__fps, window.__ready, window.__stats().
 */
import * as THREE from 'three';
import { createTerrain } from '../world/terrain';
import { createWater } from '../world/water';
import { terrainHeight } from '../world/heightfield';
import { createAirport } from '../world/airport';
import { CONFIG } from '../config';

declare global {
  interface Window {
    __fps: number;
    __ready: boolean;
    __stats: () => unknown;
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
  const { createRenderer } = await import('../render/renderer');
  const { createAtmosphere } = await import('../render/atmosphere');
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(num('fov', 60), innerWidth / innerHeight, CONFIG.camera.near, CONFIG.camera.far);
  const cx = num('x', 60);
  const cz = num('z', 820);
  const cy = num('y', 1.8) + (flag('abs') ? 0 : terrainHeight(cx, cz));
  camera.position.set(cx, cy, cz);
  if (q.has('look')) {
    const [lx, ly, lz] = q.get('look')!.split(',').map(Number);
    camera.lookAt(lx, ly + terrainHeight(lx, lz), lz);
  } else {
    camera.rotation.set((num('pitch', 0) * Math.PI) / 180, (-num('heading', 0) * Math.PI) / 180, 0, 'YXZ');
  }
  scene.add(camera);
  const rend = createRenderer(container, {});
  const renderer = rend.renderer;
  const atmo = createAtmosphere(renderer, scene, { groundHeight: terrainHeight });
  if (q.has('tod')) atmo.setTimeOfDay(num('tod', 0));
  const terrain = createTerrain(renderer, scene);
  const water = createWater(scene);
  const airport = createAirport(scene, null, { heightAt: terrainHeight });
  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  });
  terrain.update(camera);
  terrain.ready().then(() => {
    window.__ready = true;
  });
  const frameMs: number[] = [];
  window.__stats = () => {
    const s = [...frameMs].sort((a, b) => a - b);
    const p = (f: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * f))] : 0);
    return { fps: window.__fps, p50: p(0.5), p99: p(0.99), max: s[s.length - 1] ?? 0, calls: renderer.info.render.calls, tris: renderer.info.render.triangles, airport: airport.stats() };
  };
  const focus = new THREE.Vector3();
  let last = performance.now();
  let acc = 0;
  let frames = 0;
  const t0 = performance.now() - num('t', 0) * 1000;
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    frameMs.push(now - last);
    if (frameMs.length > 600) frameMs.shift();
    last = now;
    acc += dt;
    frames++;
    if (acc > 0.5) {
      window.__fps = Math.round((frames / acc) * 10) / 10;
      acc = 0;
      frames = 0;
    }
    camera.updateMatrixWorld();
    focus.copy(camera.position);
    atmo.update(camera, dt, focus);
    const time = (now - t0) / 1000;
    const sunEl = (Math.asin(Math.max(-1, Math.min(1, atmo.sunDirection.y))) * 180) / Math.PI;
    airport.update(camera, time, sunEl);
    terrain.update(camera);
    water.update(camera, time, atmo.sunDirection);
    renderer.info.reset();
    rend.render(scene, camera);
    if (flag('hud', true) && frames === 0) label.textContent = `fps ${window.__fps}  calls ${renderer.info.render.calls}  cam ${camera.position.x.toFixed(0)}, ${camera.position.y.toFixed(1)}, ${camera.position.z.toFixed(0)}`;
  });
}

main().catch((e) => {
  console.error(e);
  label.textContent = String(e);
});
