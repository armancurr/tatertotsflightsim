/**
 * Airport materials. Every surface is a three.js built-in (MeshStandardMaterial,
 * so it takes scene.environment, shadows and the global fog/aerial-perspective
 * override) extended with procedural detail via onBeforeCompile; the lights
 * are a ShaderMaterial built on UniformsLib.fog with the fog chunks included.
 * No textures: everything is computed from world / runway coordinates.
 */
import * as THREE from 'three';
import type { RunwayFrame } from '../runway';

/** Uniforms shared by several airport materials, updated once per frame. */
export interface AirportUniforms {
  uTime: { value: number };
  /** 0 in daylight … 1 at night (window glow, lamp brightness). */
  uNight: { value: number };
  /** Wind toward (x, z) unit direction and strength 0..1 (windsock extension). */
  uWind: { value: THREE.Vector3 };
}

export function createAirportUniforms(): AirportUniforms {
  return { uTime: { value: 0 }, uNight: { value: 0 }, uWind: { value: new THREE.Vector3(0, 1, 0.5) } };
}

// ─── GLSL library ─────────────────────────────────────────────────────────────

export const NOISE_GLSL = /* glsl */ `
float apHash(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float apNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = apHash(i);
  float b = apHash(i + vec2(1.0, 0.0));
  float c = apHash(i + vec2(0.0, 1.0));
  float d = apHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float apFbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * apNoise(p);
    p = mat2(1.6, 1.2, -1.2, 1.6) * p + 7.13;
    a *= 0.5;
  }
  return s / 0.9375;
}
// Antialiased line mask: d = distance to the line centre, w = half width, aa = metres per pixel.
// Keeps roughly the right average coverage when the line is thinner than a pixel.
float apLine(float d, float w, float aa) {
  aa = max(aa, 1e-4);
  return (1.0 - smoothstep(w - aa, w + aa, d)) * min(1.0, 2.0 * w / aa);
}
vec3 apPerturb(vec3 surfPos, vec3 surfNorm, float h, float faceDir) {
  vec3 sx = dFdx(surfPos);
  vec3 sy = dFdy(surfPos);
  vec3 r1 = cross(sy, surfNorm);
  vec3 r2 = cross(surfNorm, sx);
  float det = dot(sx, r1) * faceDir;
  vec2 dh = vec2(dFdx(h), dFdy(h));
  vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
  return normalize(abs(det) * surfNorm - grad);
}
`;

const RUNWAY_GLSL = /* glsl */ `
uniform float uRwLen;
uniform float uRwHalfW;
// Rubber deposits: touchdown zones of both ends, concentrated on the centre and the main-gear tracks, streaky.
float apRubber(vec2 rw) {
  float dEnd = min(rw.x, uRwLen - rw.x);
  float zone = smoothstep(70.0, 200.0, dEnd) * (1.0 - smoothstep(430.0, 820.0, dEnd));
  float lat = exp(-rw.y * rw.y / (2.0 * 4.2 * 4.2)) + 0.55 * exp(-pow((abs(rw.y) - 3.2) / 1.1, 2.0));
  float streak = apNoise(vec2(rw.x * 0.03, rw.y * 1.7)) * 0.6 + apNoise(vec2(rw.x * 0.13, rw.y * 5.1) + 5.0) * 0.4;
  float blot = apFbm(rw * vec2(0.018, 0.22) + 3.0);
  return clamp(zone * min(lat, 1.0) * smoothstep(0.3, 0.8, streak * 0.75 + blot * 0.45), 0.0, 1.0);
}
`;

// Varyings/attributes common to the ground-level airport surfaces (pavement, paint, shoulders).
const GROUND_VERT_PARS = /* glsl */ `
attribute float aKind;
uniform vec2 uRwThr;
uniform vec2 uRwDir;
uniform vec2 uRwRight;
varying vec2 vRw;
varying vec2 vWp;
varying float vKind;
`;
const GROUND_VERT = /* glsl */ `
{
  vec4 apW = modelMatrix * vec4(transformed, 1.0);
  vWp = apW.xz;
  vec2 rel = apW.xz - uRwThr;
  vRw = vec2(dot(rel, uRwDir), dot(rel, uRwRight));
  vKind = aKind;
}
`;
const GROUND_FRAG_PARS = /* glsl */ `
varying vec2 vRw;
varying vec2 vWp;
varying float vKind;
float apRough;
float apBump;
`;

function runwayUniforms(rw: RunwayFrame): Record<string, THREE.IUniform> {
  return {
    uRwThr: { value: new THREE.Vector2(rw.threshold.x, rw.threshold.z) },
    uRwDir: { value: new THREE.Vector2(rw.dir.x, rw.dir.z) },
    uRwRight: { value: new THREE.Vector2(rw.right.x, rw.right.z) },
    uRwLen: { value: rw.length },
    uRwHalfW: { value: rw.halfWidth },
  };
}

function patch(shader: THREE.WebGLProgramParametersWithUniforms, stage: 'vertexShader' | 'fragmentShader', anchor: string, code: string, where: 'before' | 'after' | 'replace' = 'after') {
  const src = shader[stage];
  if (!src.includes(anchor)) throw new Error(`airport shader: anchor ${anchor} not found`);
  shader[stage] = src.replace(anchor, where === 'after' ? `${anchor}\n${code}` : where === 'before' ? `${code}\n${anchor}` : code);
}

// ─── pavement ────────────────────────────────────────────────────────────────

const PAVEMENT_FRAG = /* glsl */ `
{
  float mpp = max(length(fwidth(vWp)), 1e-4);
  float kind = vKind;
  vec2 rw = vRw;
  vec2 wp = vWp;
  float fineW = 1.0 - smoothstep(0.03, 0.22, mpp);
  float grainW = 1.0 - smoothstep(0.006, 0.035, mpp);
  float macro = apFbm(wp * 0.013);
  float mid = apFbm(wp * 0.11 + 17.0);
  float fine = mix(0.5, apNoise(wp * 4.7) * 0.6 + apNoise(wp * 11.0 + 3.0) * 0.4, fineW);
  float grain = mix(0.5, apNoise(wp * 43.0), grainW);
  float speck = step(0.92, apHash(floor(wp * 57.0))) * grainW;
  // crack network isolines (derivatives taken in uniform control flow)
  float nn = apNoise(wp * 0.21 + 40.0) - 0.5;
  float gn = max(length(fwidth(nn)), 1e-6);
  float dNet = abs(nn) / gn * mpp;
  vec3 col;
  apRough = 0.9;
  apBump = 0.0;
  if (kind < 1.5) {
    bool isRw = kind < 0.5;
    vec3 base = isRw ? vec3(0.112, 0.110, 0.106) : vec3(0.083, 0.083, 0.082);
    col = base * (0.78 + 0.4 * macro) * (0.9 + 0.2 * mid);
    if (isRw) {
      float lane = floor(rw.y / 7.5 + 0.5);
      col *= 0.93 + 0.14 * apHash(vec2(lane, 4.0));
      float edge = smoothstep(uRwHalfW - 3.0, uRwHalfW, abs(rw.y));
      col = mix(col, vec3(0.17, 0.155, 0.13), edge * 0.3 * (0.5 + mid));
    }
    col *= 0.84 + 0.32 * fine;
    col *= 0.9 + 0.2 * grain;
    col += speck * vec3(0.06);
    apBump = (grain - 0.5) * 0.004 * grainW + (fine - 0.5) * 0.004 * fineW;
    // repaired patches (newer, darker asphalt with a sealed outline)
    vec2 cellSz = vec2(26.0, 7.5);
    vec2 pc = rw / cellSz;
    vec2 pci = floor(pc);
    float ph = apHash(pci + 31.0 + kind * 7.0);
    if (ph > 0.83) {
      vec2 f = fract(pc) * cellSz;
      vec2 lo = vec2(2.0 + 9.0 * apHash(pci + 1.7), 0.4 + 2.4 * apHash(pci + 2.3));
      vec2 sz = vec2(4.0 + 10.0 * apHash(pci + 3.1), 1.8 + 3.0 * apHash(pci + 4.9));
      vec2 dm = min(f - lo, lo + sz - f);
      float e = min(dm.x, dm.y);
      float inside = smoothstep(-mpp, mpp, e);
      col = mix(col, col * vec3(0.68, 0.68, 0.7), inside);
      col = mix(col, vec3(0.014), apLine(abs(e), 0.025, mpp) * 0.8);
    }
    // sealed transverse cracks every ~13 m
    float cell = floor(rw.x / 13.0);
    float h1 = apHash(vec2(cell, 7.0 + kind));
    float ca = (cell + 0.2 + 0.6 * h1) * 13.0 + 0.25 * sin(rw.y * 0.9 + h1 * 30.0) + 0.6 * (apNoise(vec2(rw.y * 0.45, cell * 3.1)) - 0.5);
    float span = step(abs(rw.y - (h1 - 0.5) * 12.0), 4.0 + 12.0 * apHash(vec2(cell, 9.0)));
    float crack = step(0.42, h1) * span * apLine(abs(rw.x - ca), 0.03, mpp);
    if (isRw) {
      float wig = 0.05 * sin(rw.x * 0.37) + 0.03 * sin(rw.x * 1.3);
      float dj = min(abs(abs(rw.y) - 3.75 + wig), abs(abs(rw.y) - 11.25 + wig));
      crack = max(crack, apLine(dj, 0.028, mpp) * 0.8);
    }
    crack = max(crack, apLine(dNet, 0.022, mpp) * smoothstep(0.5, 0.72, apNoise(wp * 0.03 + 3.0)) * (isRw ? 0.6 : 1.0));
    col = mix(col, vec3(0.012), crack * 0.88);
    apRough = mix(0.9, 0.5, crack);
    if (isRw) {
      float r = apRubber(rw);
      col = mix(col, vec3(0.017, 0.016, 0.015), r * 0.88);
      apRough = mix(apRough, 0.68, r);
      apBump *= 1.0 - 0.7 * r;
    }
  } else if (kind < 2.5) {
    // concrete apron: 5 m slabs, sealed joints, per-slab tone, stains
    vec2 sp = wp / 5.0;
    vec2 si = floor(sp);
    vec2 sf = fract(sp);
    float tone = apHash(si + 11.0);
    col = vec3(0.30, 0.295, 0.278) * (0.88 + 0.16 * tone) * (0.84 + 0.28 * macro) * (0.9 + 0.16 * fine) * (0.93 + 0.14 * grain);
    vec2 dj = min(sf, 1.0 - sf) * 5.0;
    float joint = max(apLine(dj.x, 0.012, mpp), apLine(dj.y, 0.012, mpp));
    col = mix(col, vec3(0.045), joint * 0.85);
    float stain = smoothstep(0.55, 0.85, apFbm(wp * 0.33 + 9.0)) * 0.45 + smoothstep(0.7, 0.9, apNoise(wp * 1.7)) * 0.25 * fineW;
    col *= 1.0 - stain;
    col = mix(col, vec3(0.02), apLine(dNet, 0.015, mpp) * smoothstep(0.6, 0.8, apNoise(wp * 0.05)) * 0.7);
    apRough = 0.85;
    apBump = (grain - 0.5) * 0.002 * grainW;
  } else {
    // car park: older, lighter asphalt
    col = vec3(0.105, 0.102, 0.097) * (0.78 + 0.42 * macro) * (0.86 + 0.28 * fine) * (0.9 + 0.2 * grain);
    col = mix(col, vec3(0.012), apLine(dNet, 0.02, mpp) * 0.8);
    apRough = 0.92;
    apBump = (grain - 0.5) * 0.004 * grainW;
  }
  diffuseColor.rgb = col;
}
`;

export function createPavementMaterial(rw: RunwayFrame): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -2 });
  m.name = 'airport-pavement';
  const u = runwayUniforms(rw);
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, u);
    patch(s, 'vertexShader', '#include <common>', GROUND_VERT_PARS);
    patch(s, 'vertexShader', '#include <begin_vertex>', GROUND_VERT);
    patch(s, 'fragmentShader', '#include <common>', GROUND_FRAG_PARS + NOISE_GLSL + RUNWAY_GLSL);
    patch(s, 'fragmentShader', '#include <color_fragment>', PAVEMENT_FRAG);
    patch(s, 'fragmentShader', '#include <roughnessmap_fragment>', 'roughnessFactor = apRough;');
    patch(s, 'fragmentShader', '#include <normal_fragment_maps>', 'normal = apPerturb(-vViewPosition, normal, apBump, faceDirection);');
  };
  m.customProgramCacheKey = () => 'airport-pavement-v1';
  return m;
}

// ─── paint ───────────────────────────────────────────────────────────────────

const MARKING_FRAG = /* glsl */ `
{
  float mpp = max(length(fwidth(vWp)), 1e-4);
  vec2 wp = vWp;
  float fineW = 1.0 - smoothstep(0.03, 0.22, mpp);
  float grainW = 1.0 - smoothstep(0.006, 0.035, mpp);
  float grain = mix(0.5, apNoise(wp * 43.0), grainW);
  float wear = smoothstep(0.52, 0.86, apFbm(wp * 1.1 + 2.0)) * 0.42 + smoothstep(0.62, 0.92, apNoise(wp * 6.3)) * 0.28 * fineW + smoothstep(0.75, 0.98, apNoise(wp * 19.0)) * 0.25 * grainW;
  vec3 under = vec3(0.1, 0.098, 0.094);
  vec3 col = mix(diffuseColor.rgb, under, wear);
  if (vKind < 0.5) col = mix(col, vec3(0.02, 0.019, 0.018), apRubber(vRw) * 0.82);
  col *= 0.93 + 0.14 * grain;
  diffuseColor.rgb = col;
  apRough = mix(0.62, 0.85, wear);
  apBump = (grain - 0.5) * 0.002 * grainW;
}
`;

export function createMarkingMaterial(rw: RunwayFrame): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.65, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 });
  m.name = 'airport-markings';
  const u = runwayUniforms(rw);
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, u);
    patch(s, 'vertexShader', '#include <common>', GROUND_VERT_PARS);
    patch(s, 'vertexShader', '#include <begin_vertex>', GROUND_VERT);
    patch(s, 'fragmentShader', '#include <common>', GROUND_FRAG_PARS + NOISE_GLSL + RUNWAY_GLSL);
    patch(s, 'fragmentShader', '#include <color_fragment>', MARKING_FRAG);
    patch(s, 'fragmentShader', '#include <roughnessmap_fragment>', 'roughnessFactor = apRough;');
    patch(s, 'fragmentShader', '#include <normal_fragment_maps>', 'normal = apPerturb(-vViewPosition, normal, apBump, faceDirection);');
  };
  m.customProgramCacheKey = () => 'airport-markings-v1';
  return m;
}

// ─── soft shoulders ──────────────────────────────────────────────────────────

const SHOULDER_FRAG = /* glsl */ `
{
  // vKind carries the edge coordinate: 0 at the pavement edge → 1 at the outer edge
  float t = vKind;
  float n = apFbm(vWp * 0.45);
  float n2 = apNoise(vWp * 2.3);
  float fade = 1.0 - smoothstep(0.05, 1.0, t + (n - 0.5) * 0.7 + (n2 - 0.5) * 0.15);
  vec3 dust = vec3(0.155, 0.14, 0.11) * (0.8 + 0.4 * n2);
  vec3 dry = vec3(0.105, 0.105, 0.06) * (0.8 + 0.4 * n);
  diffuseColor.rgb = mix(dust, dry, smoothstep(0.15, 0.8, t + (n - 0.5) * 0.5));
  diffuseColor.a = clamp(fade * 0.9, 0.0, 1.0);
}
`;

export function createShoulderMaterial(rw: RunwayFrame): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 1,
    metalness: 0,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  });
  m.name = 'airport-shoulders';
  const u = runwayUniforms(rw);
  m.onBeforeCompile = (s) => {
    Object.assign(s.uniforms, u);
    patch(s, 'vertexShader', '#include <common>', GROUND_VERT_PARS);
    patch(s, 'vertexShader', '#include <begin_vertex>', GROUND_VERT);
    patch(s, 'fragmentShader', '#include <common>', GROUND_FRAG_PARS + NOISE_GLSL);
    patch(s, 'fragmentShader', '#include <color_fragment>', SHOULDER_FRAG);
  };
  m.customProgramCacheKey = () => 'airport-shoulders-v1';
  return m;
}

// ─── buildings (one merged mesh, per-vertex material id) ──────────────────────

/** Material ids for the merged structures mesh (attribute `aMat`). */
export const MAT = {
  paint: 0,
  corrugated: 1,
  roofMetal: 2,
  glass: 3,
  concrete: 4,
  door: 5,
  window: 6,
  membrane: 7,
  dark: 8,
  metal: 9,
  rubber: 10,
  lamp: 11,
} as const;

const BUILDING_VERT_PARS = /* glsl */ `
attribute float aMat;
attribute vec2 aUvM;
varying float vMat;
varying vec2 vUvM;
varying vec3 vWpos;
`;
const BUILDING_VERT = /* glsl */ `
vMat = aMat;
vUvM = aUvM;
vWpos = (modelMatrix * vec4(transformed, 1.0)).xyz;
`;
const BUILDING_FRAG_PARS = /* glsl */ `
uniform float uNight;
varying float vMat;
varying vec2 vUvM;
varying vec3 vWpos;
float apRough;
float apMetal;
float apBump;
vec3 apEmit;
`;
const BUILDING_FRAG = /* glsl */ `
{
  int mid = int(vMat + 0.5);
  vec2 uv = vUvM;
  float mpp = max(length(fwidth(vWpos)), 1e-4);
  float ribW = 1.0 - smoothstep(0.04, 0.12, mpp);
  float n = apNoise(vWpos.xz * 0.35 + vWpos.y * 0.2);
  float n2 = apNoise(vec2(uv.x * 0.9, uv.y * 0.12) + 3.0);
  vec3 col = diffuseColor.rgb;
  apRough = 0.75;
  apMetal = 0.0;
  apBump = 0.0;
  apEmit = vec3(0.0);
  // grime: darker near the ground, streaks below roof edges
  float grime = (1.0 - smoothstep(0.0, 1.5, uv.y)) * 0.18 + n2 * 0.08;
  if (mid == 0) {
    col *= 0.94 + 0.1 * n;
  } else if (mid == 1) {
    // vertical corrugated cladding, 0.2 m pitch
    float ph = uv.x / 0.2;
    apBump = (0.5 + 0.5 * sin(ph * 6.2832)) * 0.018 * ribW;
    col *= (0.93 + 0.1 * n) * (1.0 - grime);
    apRough = 0.5;
    apMetal = 0.3;
  } else if (mid == 2) {
    // standing-seam roof, 0.6 m pitch
    float d = abs(fract(uv.x / 0.6) - 0.5) * 0.6;
    apBump = (1.0 - smoothstep(0.0, 0.03, d)) * 0.02 * ribW;
    col *= 0.88 + 0.2 * apFbm(vWpos.xz * 0.08);
    apRough = 0.42;
    apMetal = 0.55;
  } else if (mid == 3) {
    col = vec3(0.018, 0.024, 0.028);
    apRough = 0.05;
    apEmit = vec3(0.25, 0.3, 0.26) * uNight * 0.35;
  } else if (mid == 4) {
    col *= (0.86 + 0.2 * apFbm(vWpos.xz * 0.5 + vWpos.y * 0.3)) * (1.0 - grime * 0.7);
    float lift = abs(fract(uv.y / 1.2) - 0.5) * 1.2;
    col *= 1.0 - apLine(lift, 0.01, mpp) * 0.25;
    apRough = 0.92;
  } else if (mid == 5) {
    // hangar door: vertical ribs + horizontal panel seams every 1.25 m + door leaf joints every 6 m
    float ph = uv.x / 0.15;
    apBump = (0.5 + 0.5 * sin(ph * 6.2832)) * 0.012 * ribW;
    float seam = apLine(abs(fract(uv.y / 1.25) - 0.5) * 1.25, 0.012, mpp);
    float leaf = apLine(abs(fract(uv.x / 6.0) - 0.5) * 6.0, 0.03, mpp);
    col *= (0.92 + 0.1 * n) * (1.0 - 0.35 * max(seam, leaf)) * (1.0 - grime * 0.8);
    apRough = 0.45;
    apMetal = 0.35;
  } else if (mid == 6) {
    // curtain wall: 1.5 m mullions, transom at 2.4 m
    float dx = abs(fract(uv.x / 1.5) - 0.5) * 1.5;
    float frame = max(1.0 - smoothstep(0.66, 0.7, dx), 0.0);
    float isFrame = max(1.0 - smoothstep(0.035, 0.045, 0.75 - dx), 0.0);
    float tr = 1.0 - smoothstep(0.03, 0.045, abs(uv.y - 2.4));
    float fr = max(isFrame, tr);
    float lit = step(0.35, apHash(floor(vec2(uv.x / 1.5, uv.y / 2.4)) + floor(vWpos.xz)));
    col = mix(vec3(0.02, 0.026, 0.03), vec3(0.05, 0.052, 0.055), fr);
    apRough = mix(0.05, 0.5, fr);
    apMetal = mix(0.0, 0.6, fr);
    apEmit = (1.0 - fr) * vec3(1.0, 0.78, 0.5) * uNight * 0.9 * lit;
    frame = 0.0;
  } else if (mid == 7) {
    col *= 0.85 + 0.3 * apFbm(vWpos.xz * 0.6);
    apRough = 0.95;
  } else if (mid == 8) {
    col = vec3(0.012);
    apRough = 1.0;
  } else if (mid == 9) {
    col *= 0.9 + 0.15 * n;
    apRough = 0.35;
    apMetal = 0.85;
  } else if (mid == 10) {
    col = vec3(0.02);
    apRough = 0.9;
  } else if (mid == 11) {
    apRough = 0.2;
    apEmit = col * uNight * 0.5;
  }
  diffuseColor.rgb = col;
}
`;

export function createBuildingMaterial(u: AirportUniforms): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.75, metalness: 0 });
  m.name = 'airport-structures';
  m.onBeforeCompile = (s) => {
    s.uniforms.uNight = u.uNight;
    patch(s, 'vertexShader', '#include <common>', BUILDING_VERT_PARS);
    patch(s, 'vertexShader', '#include <begin_vertex>', BUILDING_VERT);
    patch(s, 'fragmentShader', '#include <common>', BUILDING_FRAG_PARS + NOISE_GLSL);
    patch(s, 'fragmentShader', '#include <color_fragment>', BUILDING_FRAG);
    patch(s, 'fragmentShader', '#include <roughnessmap_fragment>', 'roughnessFactor = apRough;');
    patch(s, 'fragmentShader', '#include <metalnessmap_fragment>', 'metalnessFactor = apMetal;');
    patch(s, 'fragmentShader', '#include <normal_fragment_maps>', 'normal = apPerturb(-vViewPosition, normal, apBump, faceDirection);');
    patch(s, 'fragmentShader', '#include <emissivemap_fragment>', 'totalEmissiveRadiance += apEmit;');
  };
  m.customProgramCacheKey = () => 'airport-structures-v1';
  return m;
}

// ─── instanced vehicles (aircraft, cars): accent colour from instanceColor ────

export function createVehicleMaterial(name: string): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.4, metalness: 0 });
  m.name = name;
  m.onBeforeCompile = (s) => {
    patch(s, 'vertexShader', '#include <common>', 'attribute float aAccent;\nattribute vec2 aRM;\nvarying vec2 vRM;');
    patch(
      s,
      'vertexShader',
      '#include <color_vertex>',
      `
#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )
  vColor = vec4( 1.0 );
#endif
#ifdef USE_COLOR
  vColor.rgb = color.rgb;
#endif
#ifdef USE_INSTANCING_COLOR
  vColor.rgb = mix( vColor.rgb, instanceColor.rgb, aAccent );
#endif
vRM = aRM;
`,
      'replace',
    );
    patch(s, 'fragmentShader', '#include <common>', 'varying vec2 vRM;');
    patch(s, 'fragmentShader', '#include <roughnessmap_fragment>', 'roughnessFactor = vRM.x;');
    patch(s, 'fragmentShader', '#include <metalnessmap_fragment>', 'metalnessFactor = vRM.y;');
  };
  m.customProgramCacheKey = () => `airport-vehicle-v1-${name}`;
  return m;
}

// ─── chain-link fence ────────────────────────────────────────────────────────

export function createFenceMaterial(): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0x9aa0a3, roughness: 0.5, metalness: 0.7, transparent: true, depthWrite: false, side: THREE.DoubleSide });
  m.name = 'airport-fence';
  m.onBeforeCompile = (s) => {
    patch(s, 'vertexShader', '#include <common>', 'attribute vec2 aUvM;\nvarying vec2 vUvM;\nvarying vec3 vWpos;');
    patch(s, 'vertexShader', '#include <begin_vertex>', 'vUvM = aUvM;\nvWpos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    patch(s, 'fragmentShader', '#include <common>', 'varying vec2 vUvM;\nvarying vec3 vWpos;');
    patch(
      s,
      'fragmentShader',
      '#include <color_fragment>',
      `
{
  // 5 cm diamond mesh; average coverage when the wires are sub-pixel
  vec2 q = vec2(vUvM.x + vUvM.y, vUvM.x - vUvM.y) / 0.07;
  vec2 g = abs(fract(q) - 0.5);
  float aa = max(length(fwidth(q)), 1e-4);
  float wire = 0.06;
  float m1 = 1.0 - smoothstep(wire - aa, wire + aa, min(g.x, g.y));
  float coverage = 0.2;
  float mask = mix(m1, coverage, smoothstep(0.15, 0.6, aa));
  diffuseColor.a = mask * 0.9;
}
`,
    );
  };
  m.customProgramCacheKey = () => 'airport-fence-v1';
  return m;
}

// ─── windsock fabric ─────────────────────────────────────────────────────────

/** Windsock size (FAA L-807 size 2: 12 ft long, 36 in throat). */
export const WINDSOCK = { length: 3.66, throat: 0.46, tail: 0.23, bands: 5 };

export function createWindsockMaterial(u: AirportUniforms): THREE.MeshStandardMaterial {
  const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
  m.name = 'airport-windsock';
  m.onBeforeCompile = (s) => {
    s.uniforms.uTime = u.uTime;
    s.uniforms.uWind = u.uWind;
    patch(
      s,
      'vertexShader',
      '#include <common>',
      `
attribute vec2 aSock; // (s 0..1 along, theta around)
uniform float uTime;
uniform vec3 uWind; // (dir.x, dir.z, strength 0..1)
varying float vS;
const float SOCK_L = ${WINDSOCK.length.toFixed(3)};
const float SOCK_R0 = ${WINDSOCK.throat.toFixed(3)};
const float SOCK_R1 = ${WINDSOCK.tail.toFixed(3)};
vec3 sockCentre(float s, out vec3 tangent) {
  vec2 d = normalize(uWind.xy + vec2(1e-5, 0.0));
  float ext = clamp(uWind.z, 0.05, 1.0);
  float gust = 0.08 * sin(uTime * 1.7) + 0.05 * sin(uTime * 3.1 + 1.0);
  ext = clamp(ext + gust * (1.0 - ext * 0.5), 0.05, 1.0);
  // droop angle below horizontal grows along the sock, less with more wind
  float droop = (1.0 - ext) * 1.35 * pow(s, 0.8) + 0.04 * s;
  float sway = (0.10 * sin(uTime * 5.3 - s * 5.0) + 0.05 * sin(uTime * 9.1 - s * 8.0)) * s * (0.4 + ext);
  vec2 side = vec2(-d.y, d.x);
  // integrate the centreline in a few steps
  vec3 p = vec3(0.0);
  float n = 6.0;
  vec3 dirv = vec3(d.x, 0.0, d.y);
  for (int i = 0; i < 6; i++) {
    float si = (float(i) + 0.5) / n * s;
    float a = (1.0 - ext) * 1.35 * pow(si, 0.8) + 0.04 * si;
    float sw = (0.10 * sin(uTime * 5.3 - si * 5.0) + 0.05 * sin(uTime * 9.1 - si * 8.0)) * si * (0.4 + ext);
    vec3 t = normalize(vec3(d.x * cos(a), -sin(a), d.y * cos(a)) + vec3(side.x, 0.0, side.y) * sw);
    p += t * (s * SOCK_L / n);
    dirv = t;
  }
  tangent = dirv;
  return p;
}
`,
    );
    patch(
      s,
      'vertexShader',
      '#include <beginnormal_vertex>',
      `
vec3 sockT;
vec3 sockC = sockCentre(aSock.x, sockT);
vec3 sockU = normalize(cross(sockT, vec3(0.0, 1.0, 0.0)) + vec3(0.0, 0.0, 1e-4));
vec3 sockV = normalize(cross(sockU, sockT));
vec3 sockN = cos(aSock.y) * sockU + sin(aSock.y) * sockV;
float sockR = mix(SOCK_R0, SOCK_R1, aSock.x) * (1.0 + 0.05 * sin(uTime * 13.0 - aSock.x * 12.0 + aSock.y * 2.0) * aSock.x);
vec3 objectNormal = sockN;
vS = aSock.x;
`,
      'replace',
    );
    patch(s, 'vertexShader', '#include <begin_vertex>', 'vec3 transformed = sockC + sockN * sockR;', 'replace');
    patch(s, 'fragmentShader', '#include <common>', 'varying float vS;');
    patch(
      s,
      'fragmentShader',
      '#include <color_fragment>',
      `
{
  float band = floor(vS * ${WINDSOCK.bands.toFixed(1)});
  vec3 orange = vec3(0.95, 0.22, 0.02);
  vec3 white = vec3(0.8, 0.8, 0.78);
  diffuseColor.rgb = mod(band, 2.0) < 0.5 ? orange : white;
}
`,
    );
  };
  m.customProgramCacheKey = () => 'airport-windsock-v1';
  return m;
}

// ─── lights ──────────────────────────────────────────────────────────────────

const LIGHTS_VERT = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
#include <logdepthbuf_pars_vertex>
attribute vec3 aFront;
attribute vec3 aBack;
attribute vec2 aFacing;
attribute vec4 aParams; // size (m), intensity, day fraction, flasher index
uniform float uNight;
uniform float uRabbit;
uniform float uFocal;
uniform float uPixelRatio;
varying vec3 vColor;
varying float vSharp;
void main() {
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
  vec3 toCam = cameraPosition - wp;
  float dist = max(length(toCam), 0.1);
  vec3 col = aFront;
  if (dot(aFacing, aFacing) > 0.5) {
    vec2 h = toCam.xz;
    float f = dot(h / max(length(h), 1e-3), aFacing);
    col = mix(aBack, aFront, smoothstep(-0.06, 0.06, f));
    // lights are aimed along the runway: dim toward 90° off-axis
    col *= mix(0.25, 1.0, smoothstep(0.0, 0.35, abs(f)));
  }
  float seq = aParams.w;
  float on = seq < -0.5 ? 1.0 : (abs(seq - uRabbit) < 0.5 ? 1.0 : 0.0);
  float bright = aParams.y * mix(aParams.z, 1.0, uNight) * on;
  // elevation beam: from high above, less light reaches the viewer
  float elev = toCam.y / dist;
  bright *= mix(1.0, 0.4, smoothstep(0.3, 0.9, elev));
  float physPx = aParams.x * uFocal / dist;
  float minPx = mix(2.4, 3.2, uNight) * uPixelRatio;
  float glow = mix(2.2, 4.0, uNight);
  float px = clamp(physPx * glow, minPx, 220.0 * uPixelRatio);
  // sub-pixel lights keep most of their brightness so they stay visible from km away
  bright *= mix(0.45, 1.0, clamp(physPx * glow / minPx, 0.0, 1.0));
  vSharp = clamp(physPx * glow / minPx, 0.0, 1.0);
  gl_PointSize = px;
  vec4 mvPosition = viewMatrix * vec4(wp, 1.0);
  // Pull the sprite toward the camera by the fraction that keeps the ground in front of a
  // low light from clipping its lower half (sprite radius angle vs view depression angle).
  float dep = max(asin(clamp(elev, -1.0, 1.0)), 0.0);
  float rad = 0.5 * px / uPixelRatio / max(uFocal / uPixelRatio, 1.0);
  float pull = rad / (dep + rad + 1e-5);
  vec4 pulled = vec4(mvPosition.xyz * (1.0 - 0.92 * pull), 1.0);
  gl_Position = projectionMatrix * pulled;
  #include <logdepthbuf_vertex>
  #include <fog_vertex>
  vColor = col * bright;
}
`;

const LIGHTS_FRAG = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
#include <logdepthbuf_pars_fragment>
varying vec3 vColor;
varying float vSharp;
void main() {
  #include <logdepthbuf_fragment>
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(p, p);
  if (r2 > 1.0) discard;
  float coreK = mix(5.0, 16.0, vSharp);
  float core = exp(-r2 * coreK);
  float halo = exp(-sqrt(r2) * 4.5) * 0.25 * (1.0 - r2) * vSharp;
  vec3 col = vColor * (core * 3.0 + halo);
  // Fog as transmittance only: the haze in front of an additive light is already in the pixel.
  gl_FragColor = vec4(0.0, 0.0, 0.0, 1.0);
  {
  #include <fog_fragment>
  }
  vec3 apHaze = gl_FragColor.rgb;
  gl_FragColor = vec4(col, 1.0);
  {
  #include <fog_fragment>
  }
  gl_FragColor.rgb = max(gl_FragColor.rgb - apHaze, vec3(0.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;

export interface LightsUniforms {
  uNight: { value: number };
  uRabbit: { value: number };
  uFocal: { value: number };
  uPixelRatio: { value: number };
}

export function createLightsMaterial(): THREE.ShaderMaterial & { uniforms: LightsUniforms & Record<string, THREE.IUniform> } {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    { uNight: { value: 0 }, uRabbit: { value: -1 }, uFocal: { value: 800 }, uPixelRatio: { value: 1 } },
  ]) as LightsUniforms & Record<string, THREE.IUniform>;
  // keep typed arrays shared (the atmosphere's fog uniform is a shared Float32Array)
  for (const k of Object.keys(THREE.UniformsLib.fog)) {
    const src = (THREE.UniformsLib.fog as Record<string, THREE.IUniform>)[k];
    if (ArrayBuffer.isView(src.value)) uniforms[k] = { value: src.value };
  }
  const m = new THREE.ShaderMaterial({
    name: 'airport-lights',
    uniforms,
    vertexShader: LIGHTS_VERT,
    fragmentShader: LIGHTS_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    fog: true,
  }) as THREE.ShaderMaterial & { uniforms: LightsUniforms & Record<string, THREE.IUniform> };
  return m;
}
