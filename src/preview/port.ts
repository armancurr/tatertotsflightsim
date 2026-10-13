/**
 * The big-ship port and the aids to navigation (src/world/harbour/render.ts) on a flat sea with a
 * patch of the real heightfield round the target, under the real sky. URL parameters:
 *   view     cruise | naval | lighthouse | buoys | port (default cruise): where the camera looks
 *   dist, az, el   orbit (m, deg, deg) around the view's target (or tx, ty, tz)
 *   tod      time-of-day preset;  night=0..1 (overrides the sun's);  t=<s> wave/light clock (frozen)
 * window.__ready, window.__renderer, window.__port (the renderer).
 */
import * as THREE from 'three';
import { createRenderer } from '../render/renderer';
import { createAtmosphere } from '../render/atmosphere';
import { getHeightfield } from '../world/heightfield';
import { portWorks, pierWorld } from '../world/harbour/layout';
import { navaids } from '../world/harbour/navaids';
import { createPortRenderer, type PortRenderer } from '../world/harbour/render';
import { nightFactor, sunElevationDeg, syncLighting } from '../world/traffic/daylight';
import { CONFIG } from '../config';

declare global {
  interface Window {
    __ready: boolean;
    __renderer: THREE.WebGLRenderer;
    __port: PortRenderer;
  }
}
const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
window.__ready = false;

function targetOf(view: string): { x: number; y: number; z: number; dist: number; az: number; el: number } {
  const w = portWorks();
  const n = navaids();
  switch (view) {
    case 'naval': {
      const p = pierWorld(w.naval.frame, w.naval.head.u0, -40);
      return { x: p.x, y: 8, z: p.z, dist: 260, az: 150, el: 16 };
    }
    case 'lighthouse':
      return { x: n.lighthouse.x, y: n.lighthouse.groundY + 12, z: n.lighthouse.z, dist: 70, az: 220, el: 10 };
    case 'buoys': {
      const b = n.buoys.find((x) => x.id === 'marina-1-port')!;
      return { x: b.x, y: 2, z: b.z, dist: 30, az: 200, el: 8 };
    }
    case 'port':
      return { x: -4600, y: 0, z: 8200, dist: 3200, az: 190, el: 28 };
    default: {
      const p = pierWorld(w.cruise.frame, w.cruise.building.u0 + 60, 0);
      return { x: p.x, y: 10, z: p.z, dist: 230, az: 240, el: 14 };
    }
  }
}

/** A patch of the heightfield (land only; the sea plane covers the rest). */
function terrainPatch(cx: number, cz: number, size: number, cell: number): THREE.Mesh {
  const hf = getHeightfield();
  const n = Math.round(size / cell);
  const g = new THREE.PlaneGeometry(size, size, n, n).rotateX(-Math.PI / 2);
  const p = g.attributes.position as THREE.BufferAttribute;
  const col = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + cx;
    const z = p.getZ(i) + cz;
    const h = hf.height(x, z);
    p.setXYZ(i, p.getX(i), Math.max(h, -30), p.getZ(i));
    const c = h < 2.5 ? [0.72, 0.66, 0.5] : [0.26, 0.34, 0.16];
    col.set(c, i * 3);
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95 }));
  m.position.set(cx, 0, cz);
  return m;
}

async function main() {
  const container = document.getElementById('app')!;
  const rend = createRenderer(container, {});
  const renderer = rend.renderer;
  window.__renderer = renderer;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.5, CONFIG.camera.far);
  scene.add(camera);
  const atmo = createAtmosphere(renderer, scene, { groundHeight: () => 0 });
  if (q.has('tod')) atmo.setTimeOfDay(num('tod', 0));
  const view = q.get('view') ?? 'cruise';
  const T = targetOf(view);
  const tx = num('tx', T.x);
  const ty = num('ty', T.y);
  const tz = num('tz', T.z);
  const sea = new THREE.Mesh(new THREE.PlaneGeometry(60000, 60000).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x0d2a36, roughness: 0.12, metalness: 0 }));
  sea.position.set(tx, 0, tz);
  scene.add(sea);
  scene.add(terrainPatch(tx, tz, view === 'port' ? 9000 : 3000, view === 'port' ? 30 : 8));
  const port = createPortRenderer();
  window.__port = port;
  while (!port.build(50));
  scene.add(port.group);
  const az = (num('az', T.az) * Math.PI) / 180;
  const el = (num('el', T.el) * Math.PI) / 180;
  const d = num('dist', T.dist);
  camera.position.set(tx + Math.sin(az) * Math.cos(el) * d, ty + Math.sin(el) * d, tz + Math.cos(az) * Math.cos(el) * d);
  camera.lookAt(tx, ty, tz);
  camera.updateMatrixWorld();
  const label = document.getElementById('label')!;
  const focus = new THREE.Vector3(tx, ty, tz);
  let last = performance.now();
  let t = 0;
  const frozen = q.has('t');
  renderer.setAnimationLoop(() => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    t += dt;
    atmo.update(camera, dt, focus);
    syncLighting(port.shared, atmo.sunDirection, atmo.state?.sunAtCamera, atmo.state?.skyIrradiance);
    const night = q.has('night') ? num('night', 0) : nightFactor(sunElevationDeg(atmo.sunDirection.y));
    port.update({ camX: camera.position.x, camY: camera.position.y, camZ: camera.position.z, waveTime: frozen ? num('t', 0) : t, night, viewportHeight: renderer.domElement.height });
    rend.render(scene, camera);
    label.textContent = `port preview: ${view} · ${JSON.stringify(port.stats())}`;
    if (t > 2) window.__ready = true;
  });
}
main().catch((e) => console.error(e));
