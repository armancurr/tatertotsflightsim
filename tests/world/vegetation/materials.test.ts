/**
 * Tree material rules (JS mirrors of the GLSL, which is generated from the same constants):
 * per-tree tint variety (brightness, warm/cool hue, saturation, a few turning and dead trees),
 * per-tree clump variation (shrunk and dropped foliage masses), energy-bounded leaf translucency,
 * and the shader patches (every three.js chunk we hook still exists and the programs carry our code).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import {
  tintColor, clumpScale, crownDensity, isDeadTree, translucency, CLUMP_VARIATION, DEAD_FRACTION,
  createVegUniforms, createNearMaterial, createNearDepthMaterial, createImpostorMaterial,
} from '../../../src/world/vegetation/materials';
import { lodParams } from '../../../src/world/vegetation/lod';
import { getFoliageTextures } from '../../../src/world/vegetation/textures';
import { SPECIES_COUNT, SPRUCE, PINE, BROADLEAF, BIRCH, POPLAR, BUSH } from '../../../src/world/vegetation/placement';
import { fcParams } from '../../support/fc';

const lum = (c: THREE.Color) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
const N = 20000;
const ts = Array.from({ length: N }, (_, i) => (i + 0.5) / N);

describe('per-tree tint', () => {
  it('is finite, positive and bounded for every species and tint value (fuzz)', () => {
    const c = new THREE.Color();
    fc.assert(
      fc.property(fc.double({ min: 0, max: 0.9999999, noNaN: true }), fc.integer({ min: 0, max: SPECIES_COUNT - 1 }), (t, s) => {
        tintColor(t, s, c);
        return [c.r, c.g, c.b].every((v) => Number.isFinite(v) && v > 0.05 && v < 3);
      }),
      fcParams(2000),
    );
  });

  it('broadleaf crowns vary clearly from tree to tree: brightness ±25 %, warm yellow-green to cool blue-green', () => {
    const c = new THREE.Color();
    const L: number[] = [];
    const rb: number[] = [];
    for (const t of ts) {
      if (t > 0.97 || isDeadTree(t, BROADLEAF)) continue;
      tintColor(t, BROADLEAF, c);
      L.push(lum(c));
      rb.push(c.r / c.b);
    }
    const mean = L.reduce((a, b) => a + b, 0) / L.length;
    const sd = Math.sqrt(L.reduce((a, b) => a + (b - mean) ** 2, 0) / L.length);
    expect(sd / mean).toBeGreaterThan(0.13);
    expect(Math.min(...L)).toBeGreaterThan(0.55 * mean);
    rb.sort((a, b) => a - b);
    expect(rb[Math.floor(rb.length * 0.95)] / rb[Math.floor(rb.length * 0.05)]).toBeGreaterThan(1.45);
  });

  it('a few deciduous trees are turning (yellow to orange), conifers never; orchard tints (0.3–0.5) stay green', () => {
    const c = new THREE.Color();
    const turning = (s: number) => ts.filter((t) => !isDeadTree(t, s) && tintColor(t, s, c).r > c.b * 2.5).length / N;
    for (const s of [BROADLEAF, BIRCH, POPLAR]) {
      expect(turning(s)).toBeGreaterThan(0.012);
      expect(turning(s)).toBeLessThan(0.045);
    }
    for (const s of [SPRUCE, PINE]) expect(turning(s)).toBe(0);
    for (let t = 0.3; t <= 0.5; t += 0.001) {
      expect(isDeadTree(t, BROADLEAF)).toBe(false);
      tintColor(t, BROADLEAF, c);
      expect(c.r).toBeLessThan(1.4 * c.b); // no autumn in the orchards
    }
  });

  it('dead trees: about 0.5 % of trees (never shrubs), grey-brown, with a sparse crown', () => {
    const c = new THREE.Color();
    for (const s of [SPRUCE, BROADLEAF, BIRCH]) {
      const dead = ts.filter((t) => isDeadTree(t, s));
      expect(dead.length / N).toBeGreaterThan(DEAD_FRACTION * 0.8);
      expect(dead.length / N).toBeLessThan(DEAD_FRACTION * 1.2);
      for (const t of dead) {
        tintColor(t, s, c);
        // relative to the green foliage colour: red lifted, green pushed down → brown/grey
        expect(c.r).toBeGreaterThan(c.g * 1.1);
        expect(crownDensity(t, s)).toBeLessThan(0.7);
      }
    }
    expect(ts.filter((t) => isDeadTree(t, BUSH)).length).toBe(0);
    expect(crownDensity(0.5, BROADLEAF)).toBe(1);
  });
});

describe('per-tree clump variation', () => {
  it('scales lie in [0, 1]; the spruce core (clump 0) is never dropped (fuzz)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 0.9999999, noNaN: true }), fc.integer({ min: 0, max: SPECIES_COUNT - 1 }), fc.integer({ min: 0, max: 255 }), (t, s, id) => {
        const k = clumpScale(t, s, id);
        if (!(k >= 0 && k <= 1)) return false;
        if (s === SPRUCE && id === 0 && k !== 1) return false;
        return k === 0 || k >= CLUMP_VARIATION[s].minScale - 1e-9;
      }),
      fcParams(3000),
    );
  });

  it('drops about the configured share of clumps per species, and most of a dead tree’s', () => {
    for (let s = 0; s < SPECIES_COUNT; s++) {
      let drop = 0;
      let n = 0;
      for (let i = 0; i < 3000; i++) {
        const t = 0.01 + (i / 3000) * 0.95;
        if (isDeadTree(t, s)) continue;
        for (let id = 1; id < 12; id++) {
          n++;
          if (clumpScale(t, s, id) === 0) drop++;
        }
      }
      expect(Math.abs(drop / n - CLUMP_VARIATION[s].drop)).toBeLessThan(0.02);
    }
    const dead = ts.find((t) => isDeadTree(t, BROADLEAF))!;
    let d = 0;
    for (let id = 0; id < 12; id++) if (clumpScale(dead, BROADLEAF, id) === 0) d++;
    expect(d).toBeGreaterThanOrEqual(5);
  });

  it('two neighbouring trees get different crowns (the pattern depends on the tree)', () => {
    let differ = 0;
    for (let i = 0; i < 200; i++) {
      const a = 0.1 + i * 0.004;
      const b = a + 0.0005;
      for (let id = 0; id < 12; id++) if (clumpScale(a, BROADLEAF, id) !== clumpScale(b, BROADLEAF, id)) differ++;
    }
    expect(differ).toBeGreaterThan(200 * 12 * 0.8);
  });
});

describe('leaf translucency', () => {
  const unit = fc.tuple(fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true }), fc.double({ min: -1, max: 1, noNaN: true })).filter(([x, y, z]) => Math.hypot(x, y, z) > 0.1).map(([x, y, z]) => {
    const l = Math.hypot(x, y, z);
    return new THREE.Vector3(x / l, y / l, z / l);
  });

  it('never makes a back-lit leaf brighter than ~1.3× a fully sun-lit one (energy bound, fuzz)', () => {
    fc.assert(
      fc.property(unit, unit, unit, (L, V, Nn) => translucency(L, V, Nn) <= 1.3 / Math.PI + 1e-9 && translucency(L, V, Nn) >= 0),
      fcParams(3000),
    );
  });

  it('is zero when front-lit, glows most at the crown rim when back-lit', () => {
    const L = new THREE.Vector3(0, 0.2, -1).normalize(); // sun ahead
    const V = new THREE.Vector3(0, 0.1, 1).normalize(); // camera behind the tree, looking at the sun
    const centre = new THREE.Vector3(0, 0.1, 1).normalize(); // crown centre faces the camera
    const rim = new THREE.Vector3(1, 0.1, 0.05).normalize(); // crown edge
    expect(translucency(L, L.clone(), L.clone())).toBe(0);
    expect(translucency(L, V, rim)).toBeGreaterThan(2 * translucency(L, V, centre));
  });
});

describe('shader patches', () => {
  const lod = lodParams();
  const u = createVegUniforms(lod);
  const tex = getFoliageTextures(256);
  const patch = (m: THREE.Material, lib: { vertexShader: string; fragmentShader: string; uniforms: Record<string, THREE.IUniform> }) => {
    const shader = { vertexShader: lib.vertexShader, fragmentShader: lib.fragmentShader, uniforms: THREE.UniformsUtils.clone(lib.uniforms) } as unknown as THREE.WebGLProgramParametersWithUniforms;
    m.onBeforeCompile(shader, undefined as unknown as THREE.WebGLRenderer);
    return shader;
  };

  it('near material: clump variation, tint from (tint, species), translucency, tamed leaf specular', () => {
    const s = patch(createNearMaterial(u, tex), THREE.ShaderLib.standard);
    expect(s.vertexShader).toContain('attribute vec4 clump;');
    expect(s.vertexShader).toContain('vegClumpScale(');
    expect(s.vertexShader).toContain('vegTint(');
    expect(s.vertexShader).not.toContain('#include <color_vertex>');
    expect(s.fragmentShader).toContain('vegTranslucency(');
    expect(s.fragmentShader).toContain('material.specularF90');
    expect(s.fragmentShader).not.toContain('#include <lights_fragment_begin>');
  });

  it('shadow depth material: the same clump variation and crown density as the colour pass', () => {
    const s = patch(createNearDepthMaterial(u, tex), THREE.ShaderLib.depth);
    expect(s.vertexShader).toContain('vegClumpScale(');
    expect(s.fragmentShader).toContain('vVegDensity');
  });

  it('impostor material: crown density for dead trees, translucency, tamed leaf specular', () => {
    const atlas = { albedo: new THREE.Texture(), normal: new THREE.Texture(), cols: 6, rows: SPECIES_COUNT, size: new THREE.Vector2(1152, 1344) };
    const s = patch(createImpostorMaterial(u, atlas), THREE.ShaderLib.standard);
    expect(s.vertexShader).toContain('vegCrownDensity(');
    expect(s.fragmentShader).toContain('vegTranslucency(');
    expect(s.fragmentShader).toContain('material.specularF90');
  });
});
