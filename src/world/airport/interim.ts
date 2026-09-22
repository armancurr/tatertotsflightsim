/**
 * INTERIM airport renderer (orchestrator, stop-point build): draws the tested
 * airport data layer — FAA runway/taxiway paint from markings.ts, simple
 * massing for the hangars/terminal/tower from the layout, and the airport
 * lights from lights.ts as screen-sized glow points — until the full
 * `createAirport()` renderer described in RESUME.md replaces it.
 */
import * as THREE from 'three';
import { getLayout } from '../layout';
import { createAirportPlan, toWorld } from './plan';
import { runwayMarkings, taxiMarkings } from './markings';
import { airportLights, lightLevel } from './lights';

export interface InterimAirport {
  update(camera: THREE.PerspectiveCamera, time: number, sunElevationDeg: number): void;
  dispose(): void;
}

export function createInterimAirport(scene: THREE.Scene): InterimAirport {
  const layout = getLayout();
  const ap = layout.airport;
  const plan = createAirportPlan(ap);
  const group = new THREE.Group();
  group.name = 'airport-interim';

  // ── Paint: one merged mesh, vertex-coloured white/yellow ───────────────────
  const quads = [...runwayMarkings(plan.rw), ...taxiMarkings(plan)];
  const pos = new Float32Array(quads.length * 4 * 3);
  const col = new Float32Array(quads.length * 4 * 3);
  const idx: number[] = [];
  const white = new THREE.Color(0.86, 0.86, 0.84);
  const yellow = new THREE.Color(0.9, 0.68, 0.12);
  const y = ap.elevation + 0.05;
  quads.forEach((q, i) => {
    const c = q.color === 'yellow' ? yellow : white;
    q.p.forEach((p, k) => {
      const w = toWorld(plan, p.a, p.c);
      pos.set([w.x, y, w.z], (i * 4 + k) * 3);
      col.set([c.r, c.g, c.b], (i * 4 + k) * 3);
    });
    const b = i * 4;
    // Corners are counter-clockwise in (a, c); in world space that faces down, so flip the winding.
    idx.push(b, b + 2, b + 1, b, b + 3, b + 2);
  });
  const paintGeo = new THREE.BufferGeometry();
  paintGeo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  paintGeo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  paintGeo.setIndex(idx);
  paintGeo.computeVertexNormals();
  const paintMat = new THREE.MeshStandardMaterial({
    vertexColors: true, roughness: 0.75, side: THREE.DoubleSide,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
  });
  const paint = new THREE.Mesh(paintGeo, paintMat);
  paint.name = 'markings';
  paint.receiveShadow = true;
  group.add(paint);

  // ── Buildings: simple massing from the layout spots ────────────────────────
  const boxGeo = new THREE.BoxGeometry(1, 1, 1);
  boxGeo.translate(0, 0.5, 0);
  const bldMat = new THREE.MeshStandardMaterial({ color: 0xd9d6cf, roughness: 0.8 });
  const roofMat = new THREE.MeshStandardMaterial({ color: 0x8a9096, roughness: 0.6, metalness: 0.3 });
  const glassMat = new THREE.MeshStandardMaterial({ color: 0x2c3d4a, roughness: 0.1, metalness: 0.6 });
  const addBox = (cx: number, cz: number, w: number, d: number, h: number, headingDeg: number, mat: THREE.Material, y0 = ap.elevation) => {
    const m = new THREE.Mesh(boxGeo, mat);
    m.position.set(cx, y0, cz);
    m.scale.set(w, h, d);
    m.rotation.y = (-headingDeg * Math.PI) / 180;
    m.castShadow = true;
    m.receiveShadow = true;
    group.add(m);
    return m;
  };
  for (const hgr of ap.hangars) {
    addBox(hgr.center.x, hgr.center.z, hgr.width, hgr.depth, hgr.height * 0.8, hgr.headingDeg, bldMat);
    addBox(hgr.center.x, hgr.center.z, hgr.width * 1.02, hgr.depth * 1.02, hgr.height * 0.2, hgr.headingDeg, roofMat, ap.elevation + hgr.height * 0.8);
  }
  const t = ap.terminal;
  addBox(t.center.x, t.center.z, t.width, t.depth, t.height, t.headingDeg, bldMat);
  const tw = ap.tower;
  addBox(tw.center.x, tw.center.z, tw.width * 0.6, tw.depth * 0.6, tw.height - 4, tw.headingDeg, bldMat);
  addBox(tw.center.x, tw.center.z, tw.width, tw.depth, 3.2, tw.headingDeg, glassMat, ap.elevation + tw.height - 4);
  addBox(tw.center.x, tw.center.z, tw.width * 1.1, tw.depth * 1.1, 0.6, tw.headingDeg, roofMat, ap.elevation + tw.height - 0.8);

  // ── Lights: screen-sized glow points ───────────────────────────────────────
  const defs = airportLights(plan);
  const lpos = new Float32Array(defs.length * 3);
  const lcol = new Float32Array(defs.length * 3);
  defs.forEach((d, i) => {
    lpos.set([d.x, d.y + 0.3, d.z], i * 3);
    lcol.set([d.front[0], d.front[1], d.front[2]], i * 3);
  });
  const lightGeo = new THREE.BufferGeometry();
  lightGeo.setAttribute('position', new THREE.BufferAttribute(lpos, 3));
  lightGeo.setAttribute('color', new THREE.BufferAttribute(lcol, 3));
  const sprite = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.25, 'rgba(255,255,255,0.8)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(c);
  })();
  const lightMat = new THREE.PointsMaterial({
    size: 6, sizeAttenuation: false, map: sprite, vertexColors: true, transparent: true,
    depthWrite: false, blending: THREE.AdditiveBlending, opacity: 0.6,
  });
  const lights = new THREE.Points(lightGeo, lightMat);
  lights.name = 'airport-lights';
  lights.frustumCulled = false;
  group.add(lights);

  scene.add(group);
  return {
    update(_camera, _time, sunElevationDeg) {
      const level = lightLevel(sunElevationDeg);
      lightMat.opacity = 0.35 + 0.65 * Math.min(1, level);
    },
    dispose() {
      scene.remove(group);
      paintGeo.dispose();
      paintMat.dispose();
      boxGeo.dispose();
      bldMat.dispose();
      roofMat.dispose();
      glassMat.dispose();
      lightGeo.dispose();
      lightMat.dispose();
      sprite.dispose();
    },
  };
}
