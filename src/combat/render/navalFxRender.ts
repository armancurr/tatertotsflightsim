/**
 * Draws the naval guns' effects (src/combat/navalFx.ts) — two draw calls:
 *
 *   particles   camera-facing sprites (one instanced mesh, sorted back to front): white water spray
 *               and mist lit by the sun and the sky (brighter on the sunward side, a touch of
 *               translucency against the light), brown-grey propellant smoke and black burst smoke,
 *               and the HDR flash / fireball emission (it drives the bloom). The sprite shapes are a
 *               procedural atlas (clumpy spray, billowing puff) built once in a DataTexture.
 *   sea rings   flat discs lying ON the drawn sea (displaced by the same Gerstner trains as the water
 *               shader near the camera): the white foam ring a splash leaves, and the dark,
 *               rippled ring of the muzzle blast's pressure wave flattening the water.
 *
 * Both are fogged by the atmospheric aerial perspective (the shared fog chunks). Buffers are
 * preallocated; per-frame work is filling typed arrays and one sort of ≤ capacity keys.
 */
import * as THREE from 'three';
import type { NavalFxSim } from '../navalFx';
import { PK } from '../navalFx';
import { createSeaWaveUniforms, packSeaWaves, MAX_TRAINS, type SeaWaveUniforms } from '../../world/traffic/materials';
import { getSeaSpectrum, type WaveSpectrum } from '../../world/water/waves';
import { WATER_DISP_RANGE } from '../../world/traffic/ships';

export interface NavalFxRenderer {
  readonly group: THREE.Group;
  /** Fill the GPU buffers from the sim for this camera (sun radiance / ambient per unit albedo, sun direction). */
  update(sim: NavalFxSim, camera: THREE.Camera, sun: THREE.Color, ambient: THREE.Color, sunDir: THREE.Vector3, waveTime: number): void;
  readonly drawn: { particles: number; rings: number };
  dispose(): void;
}

// ─── Procedural sprite atlas ─────────────────────────────────────────────────

function hash(x: number, y: number, s: number): number {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x: number, y: number, s: number): number {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x: number, y: number, s: number): number {
  let v = 0, a = 0.5, f = 1;
  for (let o = 0; o < 5; o++) {
    v += a * vnoise(x * f, y * f, s + o * 17);
    f *= 2.03;
    a *= 0.5;
  }
  return v;
}

/** 256×128 RGBA: tile 0 (left) = clumpy spray, tile 1 (right) = billowing puff. R = density, G = "thickness" for shading. */
export function buildNavalSpriteAtlas(): THREE.DataTexture {
  const W = 256, H = 128, T = 128;
  const data = new Uint8Array(W * H * 4);
  for (let tile = 0; tile < 2; tile++) {
    for (let y = 0; y < T; y++) {
      for (let x = 0; x < T; x++) {
        const u = (x + 0.5) / T * 2 - 1;
        const v = (y + 0.5) / T * 2 - 1;
        const r = Math.hypot(u, v);
        let d: number;
        if (tile === 0) {
          // spray: lumps of droplets, a ragged edge, holes
          const n = fbm(u * 3.2 + 7, v * 3.2 + 3, 5);
          const n2 = fbm(u * 9 + 1, v * 9 + 9, 9);
          const edge = 1 - smooth(0.35, 1.0, r + (n - 0.5) * 0.7);
          d = Math.min(1, 1.35 * edge * (0.6 + 0.6 * n2) * smooth(0.2, 0.5, n + 0.2 * n2));
        } else {
          // puff: round, billowing edge, soft core
          const n = fbm(u * 2.4 + 11, v * 2.4 + 5, 3);
          const edge = 1 - smooth(0.45, 1.0, r + (n - 0.5) * 0.55);
          d = edge * (0.7 + 0.45 * fbm(u * 6 + 2, v * 6 + 4, 7));
        }
        // a window that reaches zero before the tile's border (no straight edges, no bleeding between tiles)
        d *= 1 - smooth(0.78, 0.97, r);
        d = Math.max(0, Math.min(1, d));
        const o = (y * W + x + tile * T) * 4;
        data[o] = Math.round(d * 255);
        data[o + 1] = Math.round(Math.max(0, Math.min(1, (1 - r) * 0.8 + d * 0.2)) * 255);
        data[o + 2] = 0;
        data[o + 3] = 255;
      }
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.generateMipmaps = true;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

function smooth(a: number, b: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ─── Particle material ───────────────────────────────────────────────────────

const P_VERT = /* glsl */ `
attribute vec4 iPos;   // xyz, diameter
attribute vec4 iCol;   // albedo rgb, alpha
attribute vec4 iPar;   // emission, rotation, seed, kind
attribute vec4 iVel;   // velocity (world), streak factor (s: stretch per m/s of screen-plane speed; 0 = round)
uniform vec3 uSunDir;
uniform float uSeaY;
varying vec2 vUv;
varying vec2 vLocal;
varying vec4 vCol;
varying vec4 vPar;
varying vec2 vSun2;
varying float vSunFacing;
varying float vNear;
varying float vAboveSea;
#include <fog_pars_vertex>
void main() {
  vec4 mvPosition = viewMatrix * vec4(iPos.xyz, 1.0);
  // a sprite the camera is inside (or nearly) fades out instead of filling the screen with a flat wall
  float rad = 0.5 * iPos.w;
  vNear = smoothstep(0.35 * rad, 1.6 * rad, -mvPosition.z);
  vec2 q;
  vec3 vv = (viewMatrix * vec4(iVel.xyz, 0.0)).xyz;
  float sp = length(vv.xy);
  if (iVel.w > 0.0 && sp > 0.5) {
    // water jets: the sprite stretched along its motion across the view (streaks, not puffs)
    vec2 u = vv.xy / sp;
    vec2 pp = vec2(u.y, -u.x); // (pp, u) keeps the quad's winding (det +1): not back-face culled
    float st = clamp(1.0 + iVel.w * sp, 1.0, 3.2);
    q = pp * position.x / sqrt(st) + u * position.y * st;
  } else {
    float c = cos(iPar.y), s = sin(iPar.y);
    q = vec2(position.x * c - position.y * s, position.x * s + position.y * c);
  }
  mvPosition.xy += q * iPos.w * 0.5;
  gl_Position = projectionMatrix * mvPosition;
  // world height of this corner (camera up = the view matrix's second row): the sprite fades out where it
  // dips into the sea instead of ending on a hard waterline
  vec3 camUp = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);
  vec3 camRight = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
  float wy = iPos.y + (camRight.y * q.x + camUp.y * q.y) * iPos.w * 0.5;
  vAboveSea = (wy - uSeaY) / max(0.5, 0.35 * iPos.w);
  float tile = iPar.w < 0.5 ? 0.0 : 1.0; // spray tile for water, puff for gas
  vUv = vec2((position.x * 0.5 + 0.5) * 0.5 + tile * 0.5, position.y * 0.5 + 0.5);
  vLocal = position.xy;
  vCol = iCol;
  vPar = iPar;
  vec3 sv = (viewMatrix * vec4(uSunDir, 0.0)).xyz;
  vSun2 = length(sv.xy) > 1e-4 ? normalize(sv.xy) : vec2(0.0, 1.0);
  // toward the sun (camera looking into it) → translucent glow; away → fully lit faces
  vec3 toCam = normalize(-mvPosition.xyz);
  vSunFacing = dot(-toCam, normalize(sv));
  #include <fog_vertex>
}
`;

const P_FRAG = /* glsl */ `
uniform sampler2D uAtlas;
uniform vec3 uSun;
uniform vec3 uAmb;
varying vec2 vUv;
varying vec2 vLocal;
varying vec4 vCol;
varying vec4 vPar;
varying vec2 vSun2;
varying float vSunFacing;
varying float vNear;
varying float vAboveSea;
#include <fog_pars_fragment>
void main() {
  vec4 t = texture2D(uAtlas, vUv);
  float dens = t.r;
  float a = dens * vCol.a * vNear * smoothstep(0.0, 1.0, vAboveSea);
  if (a < 0.004) discard;
  // sunward half of the sprite is brighter; thick centres a little darker (self-shadowing)
  float side = dot(vLocal, vSun2);
  float shade = 0.62 + 0.38 * clamp(0.5 + 0.6 * side, 0.0, 1.0);
  shade *= mix(1.0, 0.82, t.g * step(0.5, vPar.w));
  float trans = smoothstep(0.2, 1.0, vSunFacing) * (1.0 - dens) * 0.9;
  vec3 col = vCol.rgb * (uSun * (shade + trans) + uAmb);
  // emission (flash / fireball): white-hot → orange as it cools
  float e = vPar.x;
  if (e > 0.0) {
    vec3 hot = mix(vec3(1.0, 0.36, 0.08), vec3(1.0, 0.86, 0.62), clamp(e, 0.0, 1.0));
    col += hot * e * 60.0 * dens;
    a = max(a, clamp(e * dens * 1.2, 0.0, 1.0) * vCol.a * vNear);
  }
  gl_FragColor = vec4(col, a);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

// ─── Sea ring material ───────────────────────────────────────────────────────

const SEA_DISPLACE_GLSL = /* glsl */ `
uniform vec4 uWaveA[ ${MAX_TRAINS} ];
uniform vec4 uWaveB[ ${MAX_TRAINS} ];
uniform vec3 uWaveO;
vec3 seaDisplace( vec3 wp ) {
  float r = length( wp.xz - cameraPosition.xz );
  float spacing = max( 0.6, r * 0.045 );
  float near = 1.0 - smoothstep( uWaveO.z * 0.6, uWaveO.z, r );
  vec3 d = vec3( 0.0 );
  if ( near <= 0.0 ) return d;
  vec2 P = wp.xz - uWaveO.xy;
  for ( int i = 0; i < ${MAX_TRAINS}; i++ ) {
    vec4 a = uWaveA[ i ];
    vec4 b = uWaveB[ i ];
    if ( b.x <= 0.0 ) continue;
    float w = smoothstep( 2.5 * spacing, 5.0 * spacing, b.w ) * near;
    float th = dot( a.xy, P ) + a.w;
    float c = cos( th );
    vec2 dir = a.xy / max( length( a.xy ), 1e-6 );
    d.xz += dir * ( b.y * c * w );
    d.y += b.x * sin( th ) * w;
  }
  return d;
}
`;

const R_VERT = /* glsl */ `
attribute vec4 iRing;  // x, z, radius, fade
attribute vec4 iRPar;  // kind, age, seed, sea level
varying vec2 vP;
varying vec4 vRing;
varying vec4 vRPar;
${SEA_DISPLACE_GLSL}
#include <fog_pars_vertex>
void main() {
  vP = position.xy;
  vRing = iRing;
  vRPar = iRPar;
  vec3 wp = vec3(iRing.x + position.x * iRing.z, iRPar.w, iRing.y + position.y * iRing.z);
  wp += seaDisplace(wp);
  wp.y += 0.12;
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

const R_FRAG = /* glsl */ `
uniform vec3 uSun;
uniform vec3 uAmb;
uniform float uTime;
varying vec2 vP;
varying vec4 vRing;
varying vec4 vRPar;
#include <fog_pars_fragment>
float rh(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float rn(vec2 p) {
  vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(rh(i), rh(i + vec2(1.0, 0.0)), u.x), mix(rh(i + vec2(0.0, 1.0)), rh(i + vec2(1.0, 1.0)), u.x), u.y);
}
void main() {
  float r = length(vP);
  if (r > 1.0) discard;
  float fade = vRing.w;
  float R = vRing.z;
  vec2 wpos = vP * R + vRPar.z * 97.0;
  float a;
  vec3 col;
  if (vRPar.x < 0.5) {
    // foam: a broken white ring at the rim, patchy foam inside that thins out with age
    float n = rn(wpos * 0.07) * 0.5 + rn(wpos * 0.21) * 0.3 + rn(wpos * 0.63) * 0.2;
    float ang = atan(vP.y, vP.x);
    float wob = 0.06 * sin(ang * 7.0 + vRPar.z * 20.0) + 0.04 * sin(ang * 13.0 - vRPar.z * 9.0);
    float rr = r + wob;
    float rim = smoothstep(0.6, 0.84, rr) * (1.0 - smoothstep(0.86, 0.98, rr));
    float inner = (1.0 - smoothstep(0.1, 0.75, rr)) * 0.4;
    float streak = smoothstep(0.5, 0.78, n);
    float lace = smoothstep(0.45, 0.6, rn(wpos * 0.45 + 3.0));
    a = fade * (rim * (0.15 + 0.6 * streak) + inner * streak * lace) * 0.7;
    float lit = 0.9;
    col = vec3(0.88, 0.92, 0.94) * (uSun * lit + uAmb);
  } else {
    // pressure ring: the blast flattens and roughens the water — a dark band racing out, ripples behind it
    float band = smoothstep(0.7, 0.93, r) * (1.0 - smoothstep(0.95, 1.0, r));
    float rip = 0.5 + 0.5 * sin(r * 48.0 - vRPar.y * 30.0 + rn(wpos * 0.1) * 3.0);
    float inside = (1.0 - smoothstep(0.2, 0.9, r)) * 0.45;
    a = fade * (band * 0.7 + inside * rip * 0.5);
    col = vec3(0.012, 0.03, 0.045) * (uSun + uAmb) + vec3(0.05, 0.06, 0.07) * rip * inside * (uSun + uAmb) * 0.3;
  }
  a = clamp(a, 0.0, 0.9);
  if (a < 0.003) discard;
  gl_FragColor = vec4(col, a);
  #include <fog_fragment>
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

function fogUniforms(): Record<string, THREE.IUniform> {
  const u: Record<string, THREE.IUniform> = { ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog) };
  const fogLib = THREE.UniformsLib.fog as Record<string, THREE.IUniform>;
  if (fogLib.atmoFog) u.atmoFog = { value: fogLib.atmoFog.value };
  return u;
}

function discGeometry(segments = 48, rings = 10): THREE.InstancedBufferGeometry {
  const g = new THREE.InstancedBufferGeometry();
  const pos: number[] = [0, 0, 0];
  for (let r = 1; r <= rings; r++) {
    const rr = r / rings;
    for (let s = 0; s < segments; s++) {
      const a = (s / segments) * Math.PI * 2;
      pos.push(Math.cos(a) * rr, Math.sin(a) * rr, 0);
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < segments; s++) idx.push(0, 1 + ((s + 1) % segments), 1 + s);
  for (let r = 1; r < rings; r++) {
    const a0 = 1 + (r - 1) * segments;
    const b0 = 1 + r * segments;
    for (let s = 0; s < segments; s++) {
      const s1 = (s + 1) % segments;
      idx.push(a0 + s, a0 + s1, b0 + s, a0 + s1, b0 + s1, b0 + s);
    }
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx);
  return g;
}

export function createNavalFxRenderer(scene: THREE.Scene | null, capacity = 3200, ringCapacity = 96, spectrum: WaveSpectrum = getSeaSpectrum()): NavalFxRenderer {
  const group = new THREE.Group();
  group.name = 'naval-fx';
  const atlas = buildNavalSpriteAtlas();
  const sun = new THREE.Color(1, 1, 1);
  const amb = new THREE.Color(0.3, 0.35, 0.4);
  const sunDirU = new THREE.Vector3(0.3, 0.8, -0.4);

  // particles
  const cap = Math.max(16, capacity);
  const pg = new THREE.InstancedBufferGeometry();
  pg.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3));
  pg.setIndex([0, 1, 2, 0, 2, 3]);
  const mk = (n: number) => {
    const a = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
    a.setUsage(THREE.DynamicDrawUsage);
    return a;
  };
  const iPos = mk(cap), iCol = mk(cap), iPar = mk(cap), iVel = mk(cap);
  pg.setAttribute('iPos', iPos);
  pg.setAttribute('iCol', iCol);
  pg.setAttribute('iPar', iPar);
  pg.setAttribute('iVel', iVel);
  pg.instanceCount = 0;
  const pmat = new THREE.ShaderMaterial({
    name: 'naval.particles',
    uniforms: { ...fogUniforms(), uAtlas: { value: atlas }, uSun: { value: sun }, uAmb: { value: amb }, uSunDir: { value: sunDirU }, uSeaY: { value: 0 } },
    vertexShader: P_VERT,
    fragmentShader: P_FRAG,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  });
  const pmesh = new THREE.Mesh(pg, pmat);
  pmesh.name = 'naval-particles';
  pmesh.frustumCulled = false;
  pmesh.renderOrder = 8;
  group.add(pmesh);

  // rings
  const rcap = Math.max(4, ringCapacity);
  const rg = discGeometry();
  const iRing = mk(rcap), iRPar = mk(rcap);
  rg.setAttribute('iRing', iRing);
  rg.setAttribute('iRPar', iRPar);
  rg.instanceCount = 0;
  const waves: SeaWaveUniforms = createSeaWaveUniforms(spectrum, WATER_DISP_RANGE);
  const rmat = new THREE.ShaderMaterial({
    name: 'naval.rings',
    uniforms: { ...fogUniforms(), ...waves, uSun: { value: sun }, uAmb: { value: amb }, uTime: { value: 0 } },
    vertexShader: R_VERT,
    fragmentShader: R_FRAG,
    transparent: true,
    depthWrite: false,
    fog: true,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  const rmesh = new THREE.Mesh(rg, rmat);
  rmesh.name = 'naval-rings';
  rmesh.frustumCulled = false;
  rmesh.renderOrder = 7;
  group.add(rmesh);
  scene?.add(group);

  // sort scratch
  let keyOf = new Float64Array(cap);
  const order = new Uint32Array(cap);
  const camPos = new THREE.Vector3();
  const view = new THREE.Matrix4();
  const drawn = { particles: 0, rings: 0 };
  const P = iPos.array as Float32Array, C = iCol.array as Float32Array, Q = iPar.array as Float32Array, V = iVel.array as Float32Array;
  const RA = iRing.array as Float32Array, RB = iRPar.array as Float32Array;

  return {
    group,
    drawn,
    update(sim, camera, sunC, ambC, sunDir, waveTime) {
      sun.copy(sunC);
      amb.copy(ambC);
      sunDirU.copy(sunDir).normalize();
      view.copy(camera.matrixWorldInverse);
      const e = view.elements;
      // back-to-front order by view depth (no allocation: indices sorted by a per-particle key)
      if (keyOf.length < sim.cap) keyOf = new Float64Array(sim.cap);
      let n = 0;
      for (let i = 0; i < sim.cap && n < cap; i++) {
        if (!sim.alive[i]) continue;
        const z = e[2] * sim.px[i] + e[6] * sim.py[i] + e[10] * sim.pz[i] + e[14];
        if (z > -0.18 * sim.sizeOf(i)) continue; // behind the camera, or so close it would be faded out anyway
        keyOf[i] = z;
        order[n++] = i;
      }
      const kk = keyOf;
      const idx = order.subarray(0, n).sort((a, b) => kk[a] - kk[b]);
      for (let k = 0; k < n; k++) {
        const i = idx[k];
        const o = k * 4;
        P[o] = sim.px[i]; P[o + 1] = sim.py[i]; P[o + 2] = sim.pz[i]; P[o + 3] = sim.sizeOf(i);
        C[o] = sim.r[i]; C[o + 1] = sim.g[i]; C[o + 2] = sim.b[i]; C[o + 3] = sim.alphaOf(i);
        Q[o] = sim.emitOf(i); Q[o + 1] = sim.rot[i]; Q[o + 2] = sim.seed[i]; Q[o + 3] = sim.kind[i] === PK.spray ? 0 : 1;
        V[o] = sim.vx[i]; V[o + 1] = sim.vy[i]; V[o + 2] = sim.vz[i]; V[o + 3] = sim.kind[i] === PK.spray ? 0.05 : sim.kind[i] === PK.flash ? 0.012 : 0;
      }
      pg.instanceCount = n;
      drawn.particles = n;
      if (n > 0) {
        for (const a of [iPos, iCol, iPar, iVel]) {
          a.clearUpdateRanges();
          a.addUpdateRange(0, n * 4);
          a.needsUpdate = true;
        }
      }
      // rings
      let m = 0;
      for (let i = 0; i < sim.ringCap && m < rcap; i++) {
        if (!sim.ringAlive[i]) continue;
        const o = m * 4;
        RA[o] = sim.ringX[i]; RA[o + 1] = sim.ringZ[i]; RA[o + 2] = sim.ringRadius(i); RA[o + 3] = sim.ringFade(i);
        RB[o] = sim.ringKind[i]; RB[o + 1] = sim.ringAge[i]; RB[o + 2] = sim.ringSeed[i]; RB[o + 3] = 0;
        m++;
      }
      rg.instanceCount = m;
      drawn.rings = m;
      if (m > 0) {
        for (const a of [iRing, iRPar]) {
          a.clearUpdateRanges();
          a.addUpdateRange(0, m * 4);
          a.needsUpdate = true;
        }
      }
      camPos.setFromMatrixPosition(camera.matrixWorld);
      packSeaWaves(spectrum, waves, camPos.x, camPos.z, waveTime);
      (rmat.uniforms.uTime as THREE.IUniform).value = waveTime;
    },
    dispose() {
      group.removeFromParent();
      pg.dispose();
      rg.dispose();
      pmat.dispose();
      rmat.dispose();
      atlas.dispose();
    },
  };
}
