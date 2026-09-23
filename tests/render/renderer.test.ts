import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { chooseDepthMode, toneMappingFromName, renderTargetSize, passTimingReliable } from '../../src/render/renderer';
import fc from 'fast-check';

describe('renderer helpers', () => {
  it('uses a reversed depth buffer when EXT_clip_control exists, else falls back to a logarithmic one', () => {
    expect(chooseDepthMode(true)).toBe('reversed');
    expect(chooseDepthMode(false)).toBe('logarithmic');
    expect(chooseDepthMode(true, 'standard')).toBe('standard');
    expect(chooseDepthMode(false, 'reversed')).toBe('logarithmic');
  });
  it('maps tone-mapping names to three constants', () => {
    expect(toneMappingFromName('agx')).toBe(THREE.AgXToneMapping);
    expect(toneMappingFromName('aces')).toBe(THREE.ACESFilmicToneMapping);
    expect(toneMappingFromName('neutral')).toBe(THREE.NeutralToneMapping);
    expect(toneMappingFromName('filmic')).toBe(THREE.CustomToneMapping);
    expect(toneMappingFromName('bogus')).toBe(THREE.AgXToneMapping);
  });
  it('computes the drawing-buffer size for a CSS size and pixel ratio', () => {
    expect(renderTargetSize(1440, 900, 1.5)).toEqual({ width: 2160, height: 1350 });
    expect(renderTargetSize(1440, 900, 0.75)).toEqual({ width: 1080, height: 675 });
    expect(renderTargetSize(0, 0, 1)).toEqual({ width: 1, height: 1 });
  });
});

describe('per-pass GPU timing reliability', () => {
  it('ANGLE on Metal (Chrome on macOS) times whole command buffers: not per-pass reliable', () => {
    expect(passTimingReliable('ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, Unspecified Version)')).toBe(false);
    expect(passTimingReliable('Apple M1')).toBe(false);
  });
  it('other GPUs and unknown strings are trusted (the budget still checks the timings add up)', () => {
    expect(passTimingReliable('ANGLE (NVIDIA, NVIDIA GeForce RTX 3070 Direct3D11 vs_5_0 ps_5_0, D3D11)')).toBe(true);
    expect(passTimingReliable('Mesa Intel(R) UHD Graphics 620 (KBL GT2)')).toBe(true);
    expect(passTimingReliable('')).toBe(true);
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(typeof passTimingReliable(s)).toBe('boolean');
      }),
    );
  });
});
