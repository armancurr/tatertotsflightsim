import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { patchStandardShader, patchDepthShader, createBuildingUniforms, createBuildingMaterial, createBuildingDepthMaterial, VERTEX_ANCHORS, FRAGMENT_ANCHORS, DEPTH_ANCHORS } from '../../../src/world/towns/material';
import { BLD_VERT_PARS, BLD_FRAG_PARS, BLD_FRAG_SHADE } from '../../../src/world/towns/shaders';

const std = () => ({ vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader, uniforms: {} as Record<string, THREE.IUniform> });

const balanced = (src: string) => {
  let d = 0;
  for (const ch of src) {
    if (ch === '{' || ch === '(') d++;
    if (ch === '}' || ch === ')') d--;
    if (d < 0) return false;
  }
  return d === 0;
};

describe('building materials', () => {
  it("three's standard and depth shaders still have every anchor the patch edits", () => {
    for (const a of VERTEX_ANCHORS) expect(THREE.ShaderLib.standard.vertexShader).toContain(a);
    for (const a of FRAGMENT_ANCHORS) expect(THREE.ShaderLib.standard.fragmentShader).toContain(a);
    for (const a of DEPTH_ANCHORS) expect(THREE.ShaderLib.depth.vertexShader).toContain(a);
  });
  it('patches the colour shader: parametric transform, facade shading, uniforms; mid adds the dithered fade', () => {
    const u = createBuildingUniforms(10);
    for (const mid of [false, true]) {
      const s = std();
      patchStandardShader(s, u, mid);
      expect(s.vertexShader).toContain('bldTransform(bldP, objectNormal)');
      expect(s.vertexShader).not.toContain('#include <begin_vertex>');
      expect(s.vertexShader).not.toContain('#include <beginnormal_vertex>');
      expect(s.fragmentShader).toContain('BFac bld = bldShade();');
      expect(s.fragmentShader).toContain('float roughnessFactor = bldRough;');
      expect(s.fragmentShader).toContain('totalEmissiveRadiance = bldEmit;');
      expect(s.fragmentShader.includes('bIGN(gl_FragCoord.xy) >= vBldF.y')).toBe(mid);
      expect(s.uniforms.uBldNight).toBe(u.uBldNight);
      expect(s.uniforms.uBldChunkNear).toBe(u.uBldChunkNear);
      // fog and shadows untouched
      expect(s.fragmentShader).toContain('#include <fog_fragment>');
      expect(s.fragmentShader).toContain('#include <lights_fragment_begin>');
      expect(s.vertexShader).toContain('#include <shadowmap_vertex>');
    }
  });
  it('trees cross-fade between the near crown and the mid blob with complementary dithers, from the real camera', () => {
    const u = createBuildingUniforms(4);
    const near = std();
    patchStandardShader(near, u, false);
    const mid = std();
    patchStandardShader(mid, u, true);
    // near keeps the pixels with ign >= fade, mid those with ign < fade: together exactly one layer
    expect(near.fragmentShader).toContain('bIGN(gl_FragCoord.xy) < 1.0 - vBldF.y) discard;');
    expect(mid.fragmentShader).toContain('bIGN(gl_FragCoord.xy) >= vBldF.y) discard;');
    for (const s of [near, mid]) {
      expect(s.vertexShader).toContain('smoothstep(uBldTree.x, uBldTree.y, distance(uBldCam, iA.xyz))');
      expect(s.uniforms.uBldCam).toBe(u.uBldCam);
      expect(s.uniforms.uBldTree).toBe(u.uBldTree);
    }
    expect(mid.vertexShader).toContain('min(vis, treeFar)');
    // the shadow pass uses the view camera too (not the light's)
    const d = { vertexShader: THREE.ShaderLib.depth.vertexShader, uniforms: {} as Record<string, THREE.IUniform> };
    patchDepthShader(d, u);
    expect(d.vertexShader).toContain('uBldCam');
    expect(d.uniforms.uBldCam).toBe(u.uBldCam);
  });
  it('patches the depth shader with the same transform', () => {
    const u = createBuildingUniforms(3);
    const s = { vertexShader: THREE.ShaderLib.depth.vertexShader, uniforms: {} as Record<string, THREE.IUniform> };
    patchDepthShader(s, u);
    expect(s.vertexShader).toContain('bldTransform(transformed, bldN)');
  });
  it('injected GLSL is balanced and declares the flat varyings on both sides', () => {
    for (const src of [BLD_VERT_PARS, BLD_FRAG_PARS, BLD_FRAG_SHADE]) expect(balanced(src)).toBe(true);
    for (const v of ['vBldB', 'vBldC', 'vBldD', 'vBldF']) {
      expect(BLD_VERT_PARS).toContain(`flat varying vec4 ${v}`.replace('vec4 vBldF', 'vec2 vBldF'));
      expect(BLD_FRAG_PARS).toContain(`flat varying vec4 ${v}`.replace('vec4 vBldF', 'vec2 vBldF'));
    }
  });
  it('materials: fog on, program cache keys distinct, the chunk texture is 256 wide', () => {
    const u = createBuildingUniforms(700);
    const a = createBuildingMaterial(u, false);
    const b = createBuildingMaterial(u, true);
    const d = createBuildingDepthMaterial(u);
    expect(a.fog).toBe(true);
    expect(b.fog).toBe(true);
    expect(new Set([a.customProgramCacheKey(), b.customProgramCacheKey(), d.customProgramCacheKey()]).size).toBe(3);
    const img = u.uBldChunkNear.value.image as { width: number; height: number };
    expect(img.width).toBe(256);
    expect(img.width * img.height).toBeGreaterThanOrEqual(700);
  });
});
