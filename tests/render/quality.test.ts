/**
 * Quality presets (src/render/quality.ts): what a first-time player gets without touching settings.
 *
 * Unit: the presets and the GPU tier guess. Fuzz: every plan is sane for any device pixel ratio,
 * window size and renderer string. Functional: the dynamic-resolution controller, started from the
 * 'auto' plan and driven by a simple GPU cost model (frame time grows with the pixels drawn),
 * keeps a weak laptop GPU at ≥ 30 fps and lets a strong GPU ramp to full resolution quickly.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CONFIG } from '../../src/config';
import { gpuTier, planQuality, qualityFromQuery, QUALITY_LEVELS, type QualityPlan } from '../../src/render/quality';
import { createDynamicResolution } from '../../src/render/dynamicResolution';
import { fcParams } from '../support/fc';

const M2 = 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2 Max, Unspecified Version)';
const INTEL = 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';
const SWIFT = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
const Q = CONFIG.render.quality;
const probe = (dpr: number, w = 1440, h = 900, renderer = M2) => ({ devicePixelRatio: dpr, cssWidth: w, cssHeight: h, renderer });
const mp = (p: QualityPlan, w: number, h: number, pr = p.initialPixelRatio) => (w * pr * h * pr) / 1e6;

describe('quality level from the URL', () => {
  it('reads ?quality=low|medium|high|auto (any case), else the configured default', () => {
    expect(qualityFromQuery('?quality=low')).toBe('low');
    expect(qualityFromQuery('?veil=0&quality=HIGH')).toBe('high');
    expect(qualityFromQuery('?quality=medium')).toBe('medium');
    expect(qualityFromQuery('?quality=auto')).toBe('auto');
    expect(qualityFromQuery('')).toBe(Q.default);
    expect(qualityFromQuery(undefined)).toBe(Q.default);
    expect(qualityFromQuery('?quality=ultra')).toBe(Q.default);
    expect(QUALITY_LEVELS).toEqual(['auto', 'low', 'medium', 'high']);
  });
});

describe('GPU tier guess from the WebGL renderer string', () => {
  it('software rasterisers', () => {
    for (const s of [SWIFT, 'llvmpipe (LLVM 15.0.7, 256 bits)', 'Microsoft Basic Render Driver', 'Google SwiftShader']) expect(gpuTier(s), s).toBe('software');
  });
  it('older integrated / mobile GPUs', () => {
    for (const s of [INTEL, 'Mesa Intel(R) HD Graphics 520 (SKL GT2)', 'Mali-G78', 'Adreno (TM) 640', 'PowerVR Rogue GE8320']) expect(gpuTier(s), s).toBe('low');
  });
  it('everything else — including masked strings (Safari "Apple GPU", Firefox) and empty — is standard', () => {
    for (const s of [M2, 'Apple GPU', 'NVIDIA GeForce RTX 3070/PCIe/SSE2', 'AMD Radeon Pro 5500M', 'Intel(R) Arc(TM) A770 Graphics', 'Intel Iris Xe', '', 'WebKit WebGL']) expect(gpuTier(s), s).toBe('standard');
  });
});

describe('presets', () => {
  it("'high' is the full-quality look: cap the device pixel ratio at config.render.maxPixelRatio, start there, 4× MSAA", () => {
    const p = planQuality('high', probe(2));
    expect(p.maxPixelRatio).toBe(CONFIG.render.maxPixelRatio);
    expect(p.initialPixelRatio).toBe(p.maxPixelRatio);
    expect(p.msaaSamples).toBe(CONFIG.render.msaaSamples);
    expect(p.cloudMode).toBeNull();
  });

  it("'auto' (the default) starts conservatively — at most config megapixels — and may climb to the same cap", () => {
    const p = planQuality('auto', probe(2));
    expect(p.maxPixelRatio).toBe(CONFIG.render.maxPixelRatio);
    expect(p.initialPixelRatio).toBeLessThan(p.maxPixelRatio);
    expect(mp(p, 1440, 900)).toBeLessThanOrEqual(Q.startMegapixels + 1e-6);
    expect(p.minPixelRatio).toBe(Q.floorPixelRatio);
    expect(p.rampUpDelay).toBeGreaterThan(0);
    // A big external monitor starts lower still.
    const big = planQuality('auto', probe(2, 2560, 1440));
    expect(mp(big, 2560, 1440)).toBeLessThanOrEqual(Q.startMegapixels + 1e-6);
    expect(big.initialPixelRatio).toBeLessThan(p.initialPixelRatio);
    // A small window can start at the cap.
    expect(planQuality('auto', probe(2, 800, 600)).initialPixelRatio).toBe(CONFIG.render.maxPixelRatio);
  });

  it("'low' and a software renderer drop MSAA, use billboard clouds and never exceed 1 pixel per CSS pixel", () => {
    for (const p of [planQuality('low', probe(2)), planQuality('auto', probe(2, 1440, 900, SWIFT))]) {
      expect(p.msaaSamples).toBe(0);
      expect(p.cloudMode).toBe('billboard');
      expect(p.maxPixelRatio).toBeLessThanOrEqual(1);
      expect(p.initialPixelRatio).toBeLessThanOrEqual(0.75);
    }
    expect(planQuality('auto', probe(1, 1440, 900, SWIFT)).tier).toBe('software');
  });

  it("'auto' on an older integrated GPU starts lower than on a standard one and caps the ratio at 1", () => {
    const weak = planQuality('auto', probe(2, 1440, 900, INTEL));
    const std = planQuality('auto', probe(2));
    expect(weak.initialPixelRatio).toBeLessThan(std.initialPixelRatio);
    expect(weak.maxPixelRatio).toBeLessThanOrEqual(1);
  });

  it('devicePixelRatio 1 never renders above 1; devicePixelRatio 3 is capped', () => {
    for (const l of QUALITY_LEVELS) {
      expect(planQuality(l, probe(1)).maxPixelRatio).toBeLessThanOrEqual(1);
      expect(planQuality(l, probe(3)).maxPixelRatio).toBeLessThanOrEqual(CONFIG.render.maxPixelRatio);
    }
  });
});

describe('property: every plan is sane', () => {
  it('min ≤ initial ≤ max, all finite and positive, MSAA ∈ {0, 2, 4}, auto starts within the pixel budget unless at the floor', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...QUALITY_LEVELS),
        fc.oneof(fc.double({ min: 0.25, max: 5, noNaN: true }), fc.constantFrom(NaN, 0, -1, Infinity)),
        fc.integer({ min: 0, max: 8000 }),
        fc.integer({ min: 0, max: 5000 }),
        fc.oneof(fc.string(), fc.constantFrom(M2, INTEL, SWIFT, 'Apple GPU')),
        (level, dpr, w, h, renderer) => {
          const p = planQuality(level, { devicePixelRatio: dpr, cssWidth: w, cssHeight: h, renderer });
          for (const v of [p.minPixelRatio, p.initialPixelRatio, p.maxPixelRatio]) {
            expect(Number.isFinite(v)).toBe(true);
            expect(v).toBeGreaterThan(0);
          }
          expect(p.minPixelRatio).toBeLessThanOrEqual(p.initialPixelRatio);
          expect(p.initialPixelRatio).toBeLessThanOrEqual(p.maxPixelRatio);
          expect(p.maxPixelRatio).toBeLessThanOrEqual(CONFIG.render.maxPixelRatio);
          expect([0, 2, 4]).toContain(p.msaaSamples);
          if (level === 'auto' && w > 0 && h > 0 && p.initialPixelRatio > p.minPixelRatio + 1e-9) {
            expect(mp(p, w, h)).toBeLessThanOrEqual(Q.startMegapixels + 1e-6);
          }
        },
      ),
      fcParams(400),
    );
  });
});

/**
 * Functional: run the controller from the plan against a GPU whose frame costs `base + k·megapixels`
 * (vsync-limited to 60 fps). Returns the fps over the last `tail` seconds and the final ratio.
 */
function fly(plan: QualityPlan, gpuMs: (megapixels: number) => number, seconds: number, tail = 10, w = 1440, h = 900) {
  const dr = createDynamicResolution({
    targetFps: CONFIG.render.targetFps,
    minPixelRatio: plan.minPixelRatio,
    maxPixelRatio: plan.maxPixelRatio,
    initialPixelRatio: plan.initialPixelRatio,
    rampUpDelay: plan.rampUpDelay,
    warmup: plan.warmup,
  });
  let t = 0;
  let frames = 0;
  let tailT = 0;
  let reachedMaxAt = Infinity;
  while (t < seconds) {
    const dt = Math.max(1 / 60, gpuMs(mp(plan, w, h, dr.pixelRatio)) / 1000);
    t += dt;
    dr.update(dt);
    if (dr.pixelRatio >= plan.maxPixelRatio - 1e-9 && reachedMaxAt === Infinity) reachedMaxAt = t;
    if (t > seconds - tail) {
      frames++;
      tailT += dt;
    }
  }
  return { fps: frames / tailT, ratio: dr.pixelRatio, reachedMaxAt };
}

describe('functional: the auto plan keeps a laptop playable and a strong GPU sharp', () => {
  it('a weak laptop GPU (~17 fps at 1440×900 @1×) settles at ≥ 30 fps by itself', () => {
    const weakGpu = (m: number) => 4 + 56 * (m / 1.296); // 60 ms at 1.3 MP
    const plan = planQuality('auto', probe(2, 1440, 900, INTEL));
    const r = fly(plan, weakGpu, 60);
    expect(r.fps).toBeGreaterThanOrEqual(30);
    // …while the old default (start at the cap, floor 0.75) sat well under 30 fps.
    const old = fly({ ...planQuality('high', probe(2)), minPixelRatio: CONFIG.render.minPixelRatio }, weakGpu, 60);
    expect(old.fps).toBeLessThan(30);
  });

  it('the same weak GPU behind an unhelpful renderer string (masked by the browser) still reaches ≥ 30 fps', () => {
    const weakGpu = (m: number) => 4 + 56 * (m / 1.296);
    const r = fly(planQuality('auto', probe(2, 1440, 900, 'WebKit WebGL')), weakGpu, 90);
    expect(r.fps).toBeGreaterThanOrEqual(30);
  });

  it('a strong GPU (M2 Max class) climbs from the conservative start to the full cap within ~10 s', () => {
    const strong = (m: number) => 3 + 4 * m; // ~12 ms even at 2.9 MP
    const plan = planQuality('auto', probe(2));
    const r = fly(plan, strong, 30);
    expect(r.ratio).toBe(plan.maxPixelRatio);
    expect(r.reachedMaxAt).toBeLessThan(10 + (plan.warmup ?? 0));
    expect(r.fps).toBeGreaterThan(58);
  });
});
