import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import '../../../src/render/fog'; // installs the atmospheric fog override (carries the sun direction)
import { createTerrainMaterial } from '../../../src/world/terrain/material';
import { MAX_RUNWAYS } from '../../../src/world/terrain/terrainShader';
import { getHeightfield } from '../../../src/world/heightfield';
import { runwayFrames } from '../../../src/world/runway';

interface FakeShader {
  uniforms: Record<string, THREE.IUniform>;
  vertexShader: string;
  fragmentShader: string;
}

function compile(): { shader: FakeShader; dispose: () => void } {
  const tm = createTerrainMaterial(getHeightfield().layout, undefined, { detailSize: 16 });
  const shader: FakeShader = { uniforms: {}, vertexShader: THREE.ShaderLib.standard.vertexShader, fragmentShader: THREE.ShaderLib.standard.fragmentShader };
  (tm.material.onBeforeCompile as unknown as (s: FakeShader) => void)(shader);
  return { shader, dispose: () => tm.dispose() };
}

describe('terrain material (functional)', () => {
  it('knows every runway (36/18 and the crossing runway): approach corridors stay clear of woodlots', () => {
    const { shader, dispose } = compile();
    const frames = runwayFrames();
    expect(frames.length).toBeGreaterThanOrEqual(2);
    expect(shader.uniforms.uRunwayCount.value).toBe(Math.min(frames.length, MAX_RUNWAYS));
    const rw = shader.uniforms.uRunways.value as THREE.Vector4[];
    expect(rw).toHaveLength(MAX_RUNWAYS);
    frames.slice(0, MAX_RUNWAYS).forEach((f, i) => {
      expect(rw[i].x).toBeCloseTo(f.threshold.x, 6);
      expect(rw[i].y).toBeCloseTo(f.threshold.z, 6);
      expect(rw[i].z).toBeCloseTo(f.length, 6);
      expect(rw[i].w).toBeCloseTo((f.headingDeg * Math.PI) / 180, 9);
    });
    expect(shader.fragmentShader).toContain('uniform vec4 uRunways[');
    dispose();
  });
  it('patches every chunk once, takes the sun from the atmosphere, and keeps the GLSL balanced', () => {
    const { shader, dispose } = compile();
    for (const src of [shader.vertexShader, shader.fragmentShader]) {
      expect((src.match(/{/g) ?? []).length).toBe((src.match(/}/g) ?? []).length);
      expect((src.match(/\(/g) ?? []).length).toBe((src.match(/\)/g) ?? []).length);
      expect(src).not.toMatch(/NaN|undefined/);
    }
    expect(shader.fragmentShader).toContain('#define TERRAIN_ATMO_SUN');
    expect(shader.fragmentShader).toContain('terrainAlbedo( tRough )');
    expect(shader.vertexShader).toContain('vRelief =');
    expect(shader.fragmentShader).not.toContain('#include <map_fragment>');
    dispose();
  });
});
