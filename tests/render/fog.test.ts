import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import {
  aerialPerspective,
  hazeColor,
  fogStateFromAtmosphere,
  packFogUniforms,
  atmoFogData,
  ATMO_FOG_VEC4S,
  installAtmosphericFog,
  ensureAtmosphericFogUniforms,
  type FogState,
} from '../../src/render/fog';
import { defaultAtmosphereParams, skyRadiance, luminance, type RGB } from '../../src/render/atmosphereModel';
import { sunDirectionFromAngles } from '../../src/render/sun';
import type { Vec3 } from '../../src/types';

const P = defaultAtmosphereParams();
const sun = sunDirectionFromAngles(38, 125);
const S: FogState = fogStateFromAtmosphere(P, sun, 2);
const rgb = (r = 0, g = 0, b = 0): RGB => ({ r, g, b });
const dir = (el: number, az: number) => sunDirectionFromAngles(el, az);
const scale = (d: Vec3, k: number): Vec3 => ({ x: d.x * k, y: d.y * k, z: d.z * k });

/** Per-channel transmittance recovered from two objects (white and black). */
function transmittance(rel: Vec3, camY: number, s = S) {
  const w = aerialPerspective(rgb(1, 1, 1), rel, camY, s, rgb());
  const k = aerialPerspective(rgb(0, 0, 0), rel, camY, s, rgb());
  return { r: w.r - k.r, g: w.g - k.g, b: w.b - k.b };
}

describe('aerial perspective (TS mirror of the GLSL fog chunk)', () => {
  it('leaves colours untouched at zero distance', () => {
    const c = aerialPerspective(rgb(0.3, 0.5, 0.7), { x: 0, y: 0, z: 0 }, 2, S, rgb());
    expect(c.r).toBeCloseTo(0.3, 6);
    expect(c.g).toBeCloseTo(0.5, 6);
    expect(c.b).toBeCloseTo(0.7, 6);
  });
  it('transmittance falls monotonically with distance, blue first (Rayleigh)', () => {
    let prev = 1.0001;
    for (const d of [100, 1000, 5000, 15000, 30000]) {
      const t = transmittance(scale(dir(0, 10), d), 2);
      expect(t.g).toBeLessThan(prev);
      expect(t.b).toBeLessThan(t.r);
      prev = t.g;
    }
  });
  it('is thinner at altitude than at sea level over the same distance', () => {
    const low = transmittance(scale(dir(0, 10), 10000), 2);
    const high = transmittance(scale(dir(0, 10), 10000), 3000);
    expect(high.g).toBeGreaterThan(low.g + 0.05);
  });
  it('looking down from altitude sees through less haze than looking along the ground', () => {
    const d = 12000;
    const down = transmittance(scale(dir(-10, 10), d), 2100);
    const along = transmittance(scale(dir(0, 10), d), 2);
    expect(down.g).toBeGreaterThan(along.g);
  });
  it('is fully hazed at the visibility distance (the terrain edge disappears)', () => {
    const t = transmittance(scale(dir(0, 10), S.visibility * 1.01), 2);
    expect(t.g).toBeLessThan(1e-6);
    // …and still has visible contrast at a third of it
    expect(transmittance(scale(dir(0, 10), S.visibility / 3), 2).g).toBeGreaterThan(0.05);
  });
  it('the haze glows warm and bright toward the sun and is bluish-grey away from it', () => {
    const toward = hazeColor({ x: sun.x, y: 0, z: sun.z }, 2, S, rgb());
    const away = hazeColor({ x: -sun.x, y: 0, z: -sun.z }, 2, S, rgb());
    expect(luminance(toward)).toBeGreaterThan(1.3 * luminance(away));
    expect(toward.r / toward.b).toBeGreaterThan(away.r / away.b);
    expect(away.b).toBeGreaterThan(away.r);
  });
  it('hazeColor is exactly what a far-away object turns into (terrain melts into the horizon)', () => {
    for (const d of [dir(0.5, 40), dir(3, 200), dir(-1, 300), dir(-10, 90)]) {
      const h = hazeColor(d, 500, S, rgb());
      const dist = d.y < 0 ? Math.min(500 / -d.y, S.visibility) : S.visibility;
      const obj = aerialPerspective(rgb(0.2, 0.3, 0.1), scale(d, dist * 1.0001), 500, S, rgb());
      if (d.y >= 0) {
        expect(obj.r).toBeCloseTo(h.r, 5);
        expect(obj.b).toBeCloseTo(h.b, 5);
      } else {
        // ground point: haze colour is the black-object limit; a real object only adds its attenuated colour
        expect(obj.g).toBeGreaterThanOrEqual(h.g - 1e-9);
      }
    }
  });
  it('matches the physical sky at the horizon (ambient term calibrated against skyRadiance)', () => {
    for (const az of [305, 35, 215]) {
      const d = dir(0.5, az);
      const sky = skyRadiance(P, d, sun, 2, rgb());
      const haze = hazeColor(d, 2, S, rgb());
      expect(Math.abs(luminance(haze) / luminance(sky) - 1)).toBeLessThan(0.25);
    }
  });
  it('mode -1 (fog off) returns the colour unchanged', () => {
    const off = { ...S, mode: -1 as const };
    const c = aerialPerspective(rgb(0.3, 0.5, 0.7), scale(dir(0, 0), 20000), 2, off, rgb());
    expect(c.g).toBeCloseTo(0.5, 9);
  });
});

describe('fog uniform packing', () => {
  it('packs the state into the shared vec4 array', () => {
    const out = new Float32Array(ATMO_FOG_VEC4S * 4);
    packFogUniforms(S, out);
    expect(out[0]).toBeCloseTo(sun.x, 6);
    expect(out[1]).toBeCloseTo(sun.y, 6);
    expect(out[2]).toBeCloseTo(sun.z, 6);
    expect(out[3]).toBe(1); // mode: aerial perspective
    const rel = (a: number, b: number) => Math.abs(a / b - 1);
    expect(rel(out[4], S.rayleigh.r)).toBeLessThan(1e-6);
    expect(rel(out[7], S.rayleighFalloff)).toBeLessThan(1e-6);
    expect(rel(out[8], S.mieExtinction)).toBeLessThan(1e-6);
    expect(out[11]).toBeCloseTo(S.visibility, 3);
    expect(out[12]).toBeCloseTo(S.sunRadiance.r, 5);
  });
});

describe('global fog chunk installation', () => {
  installAtmosphericFog();
  installAtmosphericFog(); // idempotent

  it('replaces the four fog chunks', () => {
    expect(THREE.ShaderChunk.fog_pars_vertex).toContain('vFogWorldRel');
    expect(THREE.ShaderChunk.fog_vertex).toContain('vFogWorldRel');
    expect(THREE.ShaderChunk.fog_vertex).toContain('vFogDepth');
    expect(THREE.ShaderChunk.fog_pars_fragment).toMatch(/uniform vec4 atmoFog\[/);
    expect(THREE.ShaderChunk.fog_fragment).toContain('atmoFogScatter');
    expect(THREE.ShaderChunk.fog_pars_fragment).toContain('atmoFogApply');
  });

  it('gives every built-in fog-capable material the SAME uniform array (by reference, survives cloning)', () => {
    for (const id of ['basic', 'lambert', 'phong', 'standard', 'physical', 'toon', 'points', 'sprite', 'dashed', 'matcap']) {
      const lib = (THREE.ShaderLib as Record<string, { uniforms: Record<string, THREE.IUniform> }>)[id];
      expect(lib.uniforms.atmoFog, id).toBeDefined();
      expect(lib.uniforms.atmoFog.value).toBe(atmoFogData);
      expect(THREE.UniformsUtils.clone(lib.uniforms).atmoFog.value).toBe(atmoFogData);
    }
    expect(THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { foo: { value: 1 } }]).atmoFog.value).toBe(atmoFogData);
  });

  it('ensureAtmosphericFogUniforms patches ShaderMaterials built without UniformsLib.fog', () => {
    const m = new THREE.ShaderMaterial({ fog: true, uniforms: { fogColor: { value: new THREE.Color() }, fogDensity: { value: 0 } } });
    expect(ensureAtmosphericFogUniforms(m)).toBe(true);
    expect(m.uniforms.atmoFog.value).toBe(atmoFogData);
    expect(ensureAtmosphericFogUniforms(m)).toBe(false);
    const noFog = new THREE.ShaderMaterial({ uniforms: {} });
    expect(ensureAtmosphericFogUniforms(noFog)).toBe(false);
    expect(noFog.uniforms.atmoFog).toBeUndefined();
  });
});
