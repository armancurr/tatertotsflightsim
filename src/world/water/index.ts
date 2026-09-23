/**
 * Water surfaces: the open sea (a radial grid that follows the camera, with
 * Gerstner displacement close in), the lakes (flat fans over their shorelines)
 * and the Tater River (one continuous ribbon on its sloping surface, widened
 * to a minimum pixel width and depth-pulled toward the camera so the coarse
 * terrain LOD never hides or dashes it). Three draw calls in total.
 *
 * Look (shaders.ts): Gerstner + FFT-detail wave normals with LEAN-filtered
 * roughness (sparkle close up, a broad glitter path from altitude), wind
 * slicks, fresnel reflection of scene.environment, sun GGX specular, depth-
 * based bed/body colour from a bathymetry clipmap (turquoise over sand, dark
 * over deep water), surf lines and island foam from the shore distance field,
 * sparse whitecaps, calm lakes on still mornings, flowing river with rapids and
 * pier wakes. Heavy baking (bathymetry levels, the detail tile) runs in a Web
 * Worker; the main thread only updates uniforms (allocation-free).
 *
 * Also exports the pure wave API: waterSurfaceAt(x, z, time) → height + normal.
 */
import * as THREE from 'three';
import { CONFIG, type Config } from '../../config';
import { getLayout, type WorldLayout } from '../layout';
import { getHeightfield } from '../heightfield';
import { createWaveSpectrum, getSeaSpectrum, packWaveUniforms, waterSurfaceAt, type WaveSpectrum, type WaterSurfaceSample } from './waves';
import { bakeWaterLevel, makeWaterTexelFn, newBathyLevel, packBathymetryHalf, shoreDistanceTransform, type WaterTexel } from './bathymetry';
import { getLandcover } from '../landcover';
import { bakeDetailTile, toHalf } from './detail';
import { buildRiverRibbon, riverPiers, RIVER_STRIDE } from './river';
import { createWaterMaterial, RIVER_TILES, type SharedWaterUniforms, type WaterKind, type WaterMaterial, type WaterMaterialUniforms } from './material';

export { waterSurfaceAt, newWaterSurfaceSample, createWaveSpectrum, getSeaSpectrum, type WaterSurfaceSample, type WaveSpectrum } from './waves';
export { riverPiers } from './river';

export interface WaterOptions {
  layout?: WorldLayout;
  config?: Config;
  /** Radius of the sea disc around the camera, m (default: camera far plane). */
  seaRadius?: number;
  /** Bathymetry texels per side (default config). */
  bathymetryRes?: number;
  /** Detail tile texels per side (default config). */
  detailTileSize?: number;
  /** Bake in a Web Worker when available (default true). */
  useWorker?: boolean;
}

export interface WaterUpdateEnv {
  /** Time-of-day preset index (0 morning, 1 midday, 2 golden hour, 3 dawn): calm lakes at 0 and 3. */
  timeOfDay?: number;
  /** Drawing-buffer height in pixels (hairline river width). */
  viewportHeight?: number;
}

export interface WaterStats {
  drawCalls: number;
  bathyBakes: number;
  lastBakeMs: number;
  detailReady: boolean;
  worker: boolean;
  near: { cx: number; cz: number; extent: number; valid: boolean };
  far: { cx: number; cz: number; extent: number; valid: boolean };
  [k: string]: unknown;
}

export interface Water {
  update(camera: THREE.PerspectiveCamera, time: number, sunDirection: THREE.Vector3, env?: WaterUpdateEnv): void;
  /** Resolves once the detail tile and both bathymetry levels around the camera are in. */
  ready(camera?: THREE.PerspectiveCamera): Promise<void>;
  stats(): WaterStats;
  uniforms(kind: WaterKind): WaterMaterialUniforms;
  /** The sea surface (height above sea level, normal) at x, z, time — same waves as drawn. */
  surfaceAt(x: number, z: number, time: number, out?: WaterSurfaceSample): WaterSurfaceSample;
  /** Measure the water draws' GPU time (EXT_disjoint_timer_query_webgl2) into stats().gpuMs; null turns it off. */
  setGpuTimer(renderer: THREE.WebGLRenderer | null): boolean;
  dispose(): void;
  readonly group: THREE.Group;
}

const TAU = Math.PI * 2;
const wrap = (v: number, m: number) => ((v % m) + m) % m;

/** A disc of radius R: rings whose spacing grows geometrically with distance (dense near the camera). */
function radialGrid(R: number, rings: number, segs: number, r0 = 1): THREE.BufferGeometry {
  const pos = new Float32Array((1 + rings * segs) * 3);
  const growth = Math.pow(R / r0, 1 / (rings - 1));
  let o = 3;
  for (let k = 0; k < rings; k++) {
    const r = r0 * Math.pow(growth, k);
    for (let s = 0; s < segs; s++) {
      const a = (s / segs) * TAU;
      pos[o++] = Math.cos(a) * r;
      pos[o++] = 0;
      pos[o++] = Math.sin(a) * r;
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < segs; s++) idx.push(0, 1 + ((s + 1) % segs), 1 + s);
  for (let k = 0; k < rings - 1; k++)
    for (let s = 0; s < segs; s++) {
      const a = 1 + k * segs + s;
      const b = 1 + k * segs + ((s + 1) % segs);
      idx.push(a, b, a + segs, b, b + segs, a + segs);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const nrm = new Float32Array(pos.length);
  for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setIndex(idx);
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), R);
  return g;
}

function makeBathyTexture(res: number): THREE.DataTexture {
  const t = new THREE.DataTexture(new Uint16Array(res * res * 4), res, res, THREE.RGBAFormat, THREE.HalfFloatType);
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = false;
  t.needsUpdate = true;
  return t;
}

function makeDetailTexture(size: number, levels: Uint16Array[]): THREE.DataTexture {
  const t = new THREE.DataTexture(levels[0], size, size, THREE.RGBAFormat, THREE.HalfFloatType);
  if (levels.length > 1) {
    t.mipmaps = levels.map((data, i) => ({ data, width: Math.max(1, size >> i), height: Math.max(1, size >> i) })) as unknown as typeof t.mipmaps;
    t.minFilter = THREE.LinearMipmapLinearFilter;
  } else t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.generateMipmaps = false;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

interface DetailLayer {
  /** Rotation of the tile (wind along tile +x), 1/tile, amplitude, scroll speed (m/s). */
  c: number;
  s: number;
  inv: number;
  amp: number;
  speed: number;
}

function detailLayers(windDirX: number, windDirZ: number, tiles: [number, number], offsDeg: [number, number], amps: [number, number]): DetailLayer[] {
  const base = Math.atan2(windDirZ, windDirX);
  return [0, 1].map((i) => {
    const a = base + (offsDeg[i] * Math.PI) / 180;
    const lambda = tiles[i] / 5;
    return { c: Math.cos(a), s: Math.sin(a), inv: 1 / tiles[i], amp: amps[i], speed: Math.sqrt((9.81 * lambda) / TAU) };
  });
}

export function createWater(scene: THREE.Scene, opts: WaterOptions = {}): Water {
  const cfg = opts.config ?? CONFIG;
  const wc = cfg.world.water;
  const L = opts.layout ?? getLayout();
  const bathyRes = opts.bathymetryRes ?? wc.bathymetryRes;
  const tileSize = opts.detailTileSize ?? wc.detailTileSize;
  const group = new THREE.Group();
  group.name = 'water';
  scene.add(group);

  // ── shared uniforms and textures ─────────────────────────────────────────
  const placeholder = makeDetailTexture(1, [new Uint16Array(4)]);
  const bathyTex = [makeBathyTexture(bathyRes), makeBathyTexture(bathyRes)];
  const shared: SharedWaterUniforms = {
    uTime: { value: 0 },
    uOrigin: { value: new THREE.Vector2() },
    uSunDir: { value: new THREE.Vector3(0.3, 0.8, -0.5).normalize() },
    uSkyZenith: { value: new THREE.Color().setRGB(0.12, 0.28, 0.62, THREE.LinearSRGBColorSpace) },
    uSkyHorizon: { value: new THREE.Color().setRGB(0.55, 0.66, 0.8, THREE.LinearSRGBColorSpace) },
    uDetail: { value: placeholder },
    uBathyN: { value: bathyTex[0] },
    uBathyNXf: { value: new THREE.Vector4(0, 0, 1, 0) },
    uBathyF: { value: bathyTex[1] },
    uBathyFXf: { value: new THREE.Vector4(0, 0, 1, 0) },
  };

  // ── spectra ─────────────────────────────────────────────────────────────
  const seaSpec: WaveSpectrum = opts.config ? getSeaSpectrum(cfg) : getSeaSpectrum();
  const lakeSpec = createWaveSpectrum({ windKt: wc.windKt * 0.7, windFromDeg: wc.windFromDeg, count: 8, seed: wc.waveSeed + 11, choppiness: 0.3, wavelengthScale: 0.2, heightScale: 0.7 });
  const mats: Record<WaterKind, WaterMaterial> = {
    sea: createWaterMaterial('sea', shared, seaSpec.trains.length),
    lake: createWaterMaterial('lake', shared, lakeSpec.trains.length),
    river: createWaterMaterial('river', shared, 1),
  };
  packWaveUniforms(seaSpec, mats.sea.uniforms.uWaveA.value, mats.sea.uniforms.uWaveB.value);
  packWaveUniforms(lakeSpec, mats.lake.uniforms.uWaveA.value, mats.lake.uniforms.uWaveB.value);
  mats.sea.uniforms.uSurf.value.set(wc.surfWidth, wc.surfPeriod);
  // whitecaps: Monahan coverage grows ~U^3.4 — lower the crest threshold with wind
  const U = seaSpec.windMs;
  const wcLo = 0.52 - 0.2 * Math.min(1, Math.max(0, (U - 4) / 12));
  mats.sea.uniforms.uWhitecap.value.set(wcLo, wcLo + 0.14, wc.whitecaps * Math.min(1, U / 5), 1);
  // Cox–Munk mean-square slope, shared between the analytic trains, the detail layers and the unresolved rest
  const mss = 0.003 + 0.00512 * U;
  const rest = Math.max(0.004, mss - seaSpec.slopeVariance);
  const seaLayers = detailLayers(seaSpec.windDirX, seaSpec.windDirZ, [9.3, 2.9], [12, -23], [Math.sqrt((rest * 0.4) / 2), Math.sqrt((rest * 0.33) / 2)]);
  mats.sea.uniforms.uBaseVar.value = rest * 0.27;
  const lakeLayers = detailLayers(lakeSpec.windDirX, lakeSpec.windDirZ, [4.1, 1.3], [18, -15], [0.05, 0.045]);
  const riverTiles = RIVER_TILES;
  const riverRot = [
    [1, 0],
    [0.94, 0.34],
  ];
  const setLayerUniforms = (m: WaterMaterial, ls: DetailLayer[]) => {
    m.uniforms.uDetailL1.value.set(ls[0].c, ls[0].s, ls[0].inv, ls[0].amp);
    m.uniforms.uDetailL2.value.set(ls[1].c, ls[1].s, ls[1].inv, ls[1].amp);
  };
  setLayerUniforms(mats.sea, seaLayers);
  setLayerUniforms(mats.lake, lakeLayers);
  const rv = mats.river.uniforms;
  // the river's sediment plume off its mouth
  if (L.rivers.length) {
    const pts = L.rivers[0].points;
    const k = Math.max(0, pts.findIndex((q) => q.z > L.coast.zAt(q.x)));
    const m = pts[Math.min(pts.length - 1, k + 4)]; // ~160 m out into the bay
    mats.sea.uniforms.uMouth.value.set(m.x, m.z, 480, 0.85);
  }
  rv.uMargin.value = 3;
  rv.uMinPx.value = wc.riverMinPixels;
  rv.uLiftPerM.value = wc.riverLiftPerKm / 1000;
  rv.uPull.value = wc.riverDepthPull;

  // ── sea ──────────────────────────────────────────────────────────────────
  const seaRadius = opts.seaRadius ?? cfg.camera.far * 0.98;
  const seaMesh = new THREE.Mesh(radialGrid(seaRadius, 110, 160), mats.sea.material);
  seaMesh.name = 'sea';
  seaMesh.renderOrder = -10;
  seaMesh.receiveShadow = true;
  seaMesh.frustumCulled = false;
  seaMesh.position.y = L.seaLevel;
  group.add(seaMesh);

  // ── lakes: one merged mesh, fans over the shorelines pushed 40 m outward ──
  {
    const pos: number[] = [];
    const kind: number[] = [];
    const idx: number[] = [];
    for (const lk of L.lakes) {
      const base = pos.length / 3;
      const tarn = lk.level > 500 ? 1 : 0;
      pos.push(lk.center.x, lk.level, lk.center.z);
      kind.push(tarn);
      for (const p of lk.shoreline) {
        const dx = p.x - lk.center.x;
        const dz = p.z - lk.center.z;
        const d = Math.hypot(dx, dz) || 1;
        pos.push(p.x + (dx / d) * 40, lk.level, p.z + (dz / d) * 40);
        kind.push(tarn);
      }
      const n = lk.shoreline.length;
      for (let i = 0; i < n; i++) idx.push(base, base + 1 + ((i + 1) % n), base + 1 + i);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(pos.map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
    g.setAttribute('aLake', new THREE.Float32BufferAttribute(kind, 1));
    g.setIndex(idx);
    // wind the fans to face up
    const ia = g.index!.array as Uint16Array | Uint32Array;
    for (let t = 0; t < ia.length; t += 3) {
      const [a, b, c] = [ia[t], ia[t + 1], ia[t + 2]];
      const ux = pos[b * 3] - pos[a * 3];
      const uz = pos[b * 3 + 2] - pos[a * 3 + 2];
      const vx = pos[c * 3] - pos[a * 3];
      const vz = pos[c * 3 + 2] - pos[a * 3 + 2];
      if (uz * vx - ux * vz < 0) {
        ia[t + 1] = c;
        ia[t + 2] = b;
      }
    }
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mats.lake.material);
    m.name = 'lakes';
    m.renderOrder = -10;
    m.receiveShadow = true;
    group.add(m);
  }

  // ── river ────────────────────────────────────────────────────────────────
  for (const r of L.rivers) {
    const rib = buildRiverRibbon(r, { seaLevel: L.seaLevel, coastZAt: L.coast.zAt, speed: wc.riverSpeed, speedSteep: wc.riverSpeedSteep, rapidsSlope: wc.rapidsSlope, margin: rv.uMargin.value });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(rib.position, 3));
    const nrm = new Float32Array(rib.position.length);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('aAcross', new THREE.BufferAttribute(rib.across, 2));
    const ib = new THREE.InterleavedBuffer(rib.attrs, RIVER_STRIDE);
    g.setAttribute('aRiver', new THREE.InterleavedBufferAttribute(ib, 4, 0));
    g.setAttribute('aRiver2', new THREE.InterleavedBufferAttribute(ib, 4, 4));
    g.setAttribute('aRiver3', new THREE.InterleavedBufferAttribute(ib, 4, 8));
    g.setIndex(new THREE.BufferAttribute(rib.index, 1));
    g.computeBoundingSphere();
    const m = new THREE.Mesh(g, mats.river.material);
    m.name = `river:${r.name}`;
    m.renderOrder = -9; // after the sea: blends into it at the mouth
    m.receiveShadow = true;
    m.frustumCulled = false; // lifted/widened in the vertex shader; spans the map anyway
    group.add(m);
    // bridge piers (foam): nearest section's half-width
    let k = 0;
    const piers = rv.uPiers.value;
    for (const b of L.bridges) {
      let best = 0;
      let bd = Infinity;
      for (let i = 0; i < r.points.length; i++) {
        const d = Math.hypot(r.points[i].x - b.x, r.points[i].z - b.z);
        if (d < bd) {
          bd = d;
          best = i;
        }
      }
      if (bd > 200) continue;
      for (const p of riverPiers(b, r.halfWidths[best])) {
        if (k >= 4) break;
        piers[k * 4] = p.x;
        piers[k * 4 + 1] = p.z;
        piers[k * 4 + 2] = 2.2;
        k++;
      }
    }
  }

  // ── baking: worker (browser) or main-thread fallback (node) ──────────────
  const levelsCfg = [wc.bathymetryNear, wc.bathymetryFar];
  const levelState = [0, 1].map(() => ({ ...newBathyLevel(1), pending: false, requested: false, requestedX: 0, requestedZ: 0 }));
  const xfs = [shared.uBathyNXf.value, shared.uBathyFXf.value];
  let bathyBakes = 0;
  let lastBakeMs = 0;
  let detailReady = false;
  let reqId = 0;
  let readyResolve: (() => void) | null = null;
  const readyPromise = new Promise<void>((r) => (readyResolve = r));
  const checkReady = () => {
    if (readyResolve && detailReady && levelState[0].valid && levelState[1].valid) {
      readyResolve();
      readyResolve = null;
    }
  };
  const applyBathy = (level: number, cx: number, cz: number, extent: number, res: number, data: Uint16Array) => {
    const tex = bathyTex[level];
    tex.image = { data, width: res, height: res } as unknown as typeof tex.image;
    tex.needsUpdate = true;
    const st = levelState[level];
    st.cx = cx;
    st.cz = cz;
    st.extent = extent;
    st.valid = true;
    st.pending = false;
    xfs[level].set(cx - extent / 2, cz - extent / 2, 1 / extent, 1);
    bathyBakes++;
    checkReady();
  };
  const applyDetail = (size: number, levels: Uint16Array[]) => {
    const old = shared.uDetail.value;
    shared.uDetail.value = makeDetailTexture(size, levels);
    if (old !== placeholder) old.dispose();
    detailReady = true;
    checkReady();
  };

  let worker: Worker | null = null;
  if ((opts.useWorker ?? true) && typeof Worker !== 'undefined') {
    try {
      worker = new Worker(new URL('./bathymetry.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent) => {
        const m = e.data;
        if (m?.type === 'bathy') {
          lastBakeMs = m.ms;
          applyBathy(m.level, m.cx, m.cz, m.extent, m.res, m.data);
        } else if (m?.type === 'detail') applyDetail(m.size, m.levels);
      };
      worker.onerror = (err) => console.error('water worker error', err.message);
      worker.postMessage({ type: 'detail', size: tileSize, seed: wc.waveSeed });
    } catch (err) {
      console.warn('water: worker unavailable, baking on the main thread', err);
      worker = null;
    }
  }
  let texelAt: ((x: number, z: number, gx: number, gz: number, out: WaterTexel) => WaterTexel) | null = null;
  if (!worker) {
    const tile = bakeDetailTile(tileSize, wc.waveSeed);
    applyDetail(
      tileSize,
      tile.levels.map((l) => {
        const u = new Uint16Array(l.length);
        for (let i = 0; i < l.length; i++) u[i] = toHalf(l[i]);
        return u;
      }),
    );
  }
  const requestBathy = (level: number, x: number, z: number) => {
    const extent = levelsCfg[level];
    const cell = extent / bathyRes;
    const cx = Math.round(x / cell) * cell;
    const cz = Math.round(z / cell) * cell;
    const st = levelState[level];
    st.requested = true;
    st.requestedX = cx;
    st.requestedZ = cz;
    if (worker) {
      st.pending = true;
      worker.postMessage({ type: 'bathy', id: ++reqId, level, cx, cz, extent, res: bathyRes });
      return;
    }
    const t0 = performance.now();
    if (!texelAt) texelAt = makeWaterTexelFn(getHeightfield(), getLandcover());
    const lv = bakeWaterLevel(texelAt, cx, cz, extent, bathyRes);
    shoreDistanceTransform(lv);
    lastBakeMs = performance.now() - t0;
    applyBathy(level, cx, cz, extent, bathyRes, packBathymetryHalf(lv, new Uint16Array(bathyRes * bathyRes * 4)));
  };
  const pollBathy = (x: number, z: number) => {
    for (let level = 0; level < 2; level++) {
      const st = levelState[level];
      if (st.pending) continue;
      const lim = wc.bathymetryRecenter * levelsCfg[level];
      if (!st.requested || Math.abs(x - st.requestedX) > lim || Math.abs(z - st.requestedZ) > lim) requestBathy(level, x, z);
    }
  };

  // ── optional GPU timing of the water draws (debug) ───────────────────────
  let gpuMs = -1;
  const drawOrder: THREE.Mesh[] = [];
  group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) drawOrder.push(o as THREE.Mesh);
  });
  drawOrder.sort((a, b) => a.renderOrder - b.renderOrder);
  const noop = () => {};
  const setGpuTimer = (renderer: THREE.WebGLRenderer | null): boolean => {
    const first = drawOrder[0];
    const last = drawOrder[drawOrder.length - 1];
    first.onBeforeRender = noop;
    last.onAfterRender = noop;
    if (!renderer) return false;
    const gl = renderer.getContext() as WebGL2RenderingContext;
    const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    if (!ext) return false;
    const pool: WebGLQuery[] = [];
    const inFlight: WebGLQuery[] = [];
    let active: WebGLQuery | null = null;
    let lastFrame = -1;
    first.onBeforeRender = (r) => {
      const frame = r.info.render.frame;
      if (frame === lastFrame || active) return; // once per frame (main pass)
      lastFrame = frame;
      // collect finished queries
      while (inFlight.length && gl.getQueryParameter(inFlight[0], gl.QUERY_RESULT_AVAILABLE)) {
        const q = inFlight.shift()!;
        if (!gl.getParameter(ext.GPU_DISJOINT_EXT)) {
          const ms = (gl.getQueryParameter(q, gl.QUERY_RESULT) as number) / 1e6;
          gpuMs = gpuMs < 0 ? ms : gpuMs + (ms - gpuMs) * 0.1;
        }
        pool.push(q);
      }
      if (inFlight.length > 4) return;
      active = pool.pop() ?? gl.createQuery();
      if (active) gl.beginQuery(ext.TIME_ELAPSED_EXT, active);
    };
    last.onAfterRender = () => {
      if (!active) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      inFlight.push(active);
      active = null;
    };
    return true;
  };

  // ── per-frame state (preallocated) ───────────────────────────────────────
  const camPos = new THREE.Vector3();
  let calm = 0;
  let lastTime = 0;

  const packPhases = (spec: WaveSpectrum, A: Float32Array, ox: number, oz: number, t: number) => {
    const n = Math.min(16, spec.trains.length);
    for (let i = 0; i < n; i++) {
      const w = spec.trains[i];
      A[i * 4 + 3] = wrap(w.k * (w.dirX * ox + w.dirZ * oz) + w.phase - w.omega * t, TAU);
    }
  };
  const packOffsets = (ls: DetailLayer[], out: THREE.Vector4, ox: number, oz: number, t: number) => {
    // uv(p) = R·(p − O)/T + off, off = frac(R·O/T − (c·t/T, 0))
    const a = ls[0];
    const b = ls[1];
    out.set(
      wrap((a.c * ox + a.s * oz) * a.inv - a.speed * t * a.inv, 1),
      wrap((-a.s * ox + a.c * oz) * a.inv, 1),
      wrap((b.c * ox + b.s * oz) * b.inv - b.speed * t * b.inv, 1),
      wrap((-b.s * ox + b.c * oz) * b.inv, 1),
    );
  };

  const water: Water = {
    group,
    update(camera, time, sunDirection, env) {
      camera.getWorldPosition(camPos);
      seaMesh.position.set(camPos.x, L.seaLevel, camPos.z);
      const t = Number.isFinite(time) ? time : 0;
      const dt = Math.min(1, Math.max(0, t - lastTime));
      lastTime = t;
      shared.uTime.value = wrap(t, 3600);
      shared.uSunDir.value.copy(sunDirection).normalize();
      if (scene.fog && 'color' in scene.fog) shared.uSkyHorizon.value.copy((scene.fog as THREE.FogExp2).color);
      // origin snapped to 2 km: keeps the shader's phase arithmetic small (float precision)
      const ox = Math.round(camPos.x / 2048) * 2048;
      const oz = Math.round(camPos.z / 2048) * 2048;
      shared.uOrigin.value.set(ox, oz);
      packPhases(seaSpec, mats.sea.uniforms.uWaveA.value, ox, oz, t);
      packPhases(lakeSpec, mats.lake.uniforms.uWaveA.value, ox, oz, t);
      packOffsets(seaLayers, mats.sea.uniforms.uDetailOff.value, ox, oz, t);
      packOffsets(lakeLayers, mats.lake.uniforms.uDetailOff.value, ox, oz, t);
      // river: advect along the flow coordinate at the reference speed
      const vt = wc.riverSpeed * t;
      rv.uRiverFlow.value = wc.riverSpeed * shared.uTime.value;
      rv.uDetailOff.value.set(
        wrap(-vt / riverTiles[0], 1),
        0,
        wrap((-riverRot[1][0] * vt) / riverTiles[1], 1),
        wrap((riverRot[1][1] * vt) / riverTiles[1], 1),
      );
      // lakes: mirror calm on still mornings, a breeze later in the day
      const tod = env?.timeOfDay ?? 0;
      const target = tod === 0 || tod === 3 ? wc.lakeMorningCalm : wc.lakeDayCalm;
      calm += (target - calm) * (dt > 0 ? Math.min(1, dt * 0.7) : 1);
      mats.lake.uniforms.uWaveGain.value = Math.min(1, Math.max(0, 1 - calm));
      // hairline rivers: radians per pixel
      const h = env?.viewportHeight ?? 900;
      rv.uPxAngle.value = (2 * Math.tan(((camera.fov * Math.PI) / 180) / 2)) / Math.max(1, h);
      pollBathy(camPos.x, camPos.z);
    },
    ready(camera) {
      if (camera) {
        camera.getWorldPosition(camPos);
        pollBathy(camPos.x, camPos.z);
      }
      if (!worker) return Promise.resolve();
      return readyPromise;
    },
    stats() {
      const s = (i: number) => ({ cx: levelState[i].cx, cz: levelState[i].cz, extent: levelState[i].extent, valid: levelState[i].valid });
      return { drawCalls: group.children.length, bathyBakes, lastBakeMs: Math.round(lastBakeMs * 10) / 10, detailReady, worker: !!worker, gpuMs: Math.round(gpuMs * 1000) / 1000, near: s(0), far: s(1) };
    },
    uniforms: (kind) => mats[kind].uniforms,
    surfaceAt: (x, z, time, out) => waterSurfaceAt(x, z, time, seaSpec, out),
    setGpuTimer,
    dispose() {
      worker?.terminate();
      worker = null;
      group.traverse((o) => {
        if (o instanceof THREE.Mesh) o.geometry.dispose();
      });
      for (const k of Object.keys(mats) as WaterKind[]) mats[k].material.dispose();
      placeholder.dispose();
      if (shared.uDetail.value !== placeholder) shared.uDetail.value.dispose();
      bathyTex.forEach((t) => t.dispose());
      group.removeFromParent();
    },
  };
  return water;
}
