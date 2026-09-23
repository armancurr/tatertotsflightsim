/**
 * Quality presets: what a player gets without touching any setting (pure; see tests/render/quality.test.ts).
 *
 *   ?quality=auto (default) — start at a conservative resolution (≤ config.render.quality.startMegapixels
 *                    rendered pixels) and let dynamic resolution climb to the cap when the frame rate has
 *                    headroom — a fast first ramp, so a strong GPU is sharp within seconds — or drop to
 *                    the floor when it hasn't. Below ~85 % of the cap it steps MSAA down (4 → 2 → 0)
 *                    before lowering the resolution further (msaaLadder). A software rasteriser (SwiftShader, llvmpipe: GPU-less
 *                    machines and CI) or an older integrated GPU starts lower; software also drops MSAA
 *                    and the raymarched clouds.
 *   ?quality=low     — ≤ 1 pixel per CSS pixel, no MSAA, billboard clouds (weak laptops, big screens).
 *   ?quality=medium  — ≤ 1.25 pixels per CSS pixel, 2× MSAA (dropped under load, like auto).
 *   ?quality=high    — start at the cap (config.render.maxPixelRatio), 4× MSAA: the look the game is judged by.
 *
 * The renderer (renderer.ts) applies the pixel ratios and MSAA; main.ts applies `cloudMode` before the
 * atmosphere is built (unless ?clouds= says otherwise).
 */
import { CONFIG } from '../config';

export type QualityLevel = 'auto' | 'low' | 'medium' | 'high';
export const QUALITY_LEVELS: readonly QualityLevel[] = ['auto', 'low', 'medium', 'high'];
export type GpuTier = 'software' | 'low' | 'standard';
type CloudMode = 'volumetric' | 'billboard' | 'off';

export interface QualityProbe {
  devicePixelRatio: number;
  /** CSS size of the 3D view. */
  cssWidth: number;
  cssHeight: number;
  /** WebGL renderer string (UNMASKED_RENDERER_WEBGL where available). */
  renderer: string;
}

export interface QualityPlan {
  level: QualityLevel;
  tier: GpuTier;
  minPixelRatio: number;
  initialPixelRatio: number;
  maxPixelRatio: number;
  /** MSAA samples of the HDR scene target (0 = off) — the most dynamic resolution may use. */
  msaaSamples: number;
  /** Dynamic resolution may lower the MSAA under load (auto, medium); 'high' keeps it fixed. */
  msaaAdaptive: boolean;
  /** Cloud renderer to use instead of config.render.cloudMode, or null to keep it. */
  cloudMode: CloudMode | null;
  /** Dynamic-resolution options: fast first ramp (s) and start-up warm-up (s). */
  rampUpDelay: number;
  warmup: number;
}

type RenderConfig = typeof CONFIG.render;

/** ?quality=… from a URL query string (any case), else the configured default. */
export function qualityFromQuery(search: string | null | undefined, rc: RenderConfig = CONFIG.render): QualityLevel {
  let v = '';
  try {
    v = (new URLSearchParams(search ?? '').get('quality') ?? '').trim().toLowerCase();
  } catch {
    v = '';
  }
  return (QUALITY_LEVELS as readonly string[]).includes(v) ? (v as QualityLevel) : rc.quality.default;
}

/** A coarse guess from the WebGL renderer string. Masked or unknown strings count as standard. */
export function gpuTier(renderer: string | null | undefined): GpuTier {
  const s = String(renderer ?? '');
  if (/swiftshader|llvmpipe|softpipe|software|basic render/i.test(s)) return 'software';
  if (/\bIntel\b.*\bU?HD Graphics\b|\bMali\b|Mali-|\bAdreno\b|\bPowerVR\b|\bGMA\b/i.test(s)) return 'low';
  return 'standard';
}

const floor3 = (x: number) => Math.floor(x * 1000 + 1e-9) / 1000;

export function planQuality(level: QualityLevel, probe: QualityProbe, rc: RenderConfig = CONFIG.render): QualityPlan {
  const q = rc.quality;
  const dprIn = probe.devicePixelRatio;
  const dpr = Number.isFinite(dprIn) && dprIn > 0 ? Math.min(dprIn, 8) : 1;
  const tier = gpuTier(probe.renderer);
  const w = Number.isFinite(probe.cssWidth) ? Math.max(0, probe.cssWidth) : 0;
  const h = Number.isFinite(probe.cssHeight) ? Math.max(0, probe.cssHeight) : 0;
  const cssMp = (w * h) / 1e6;
  /** Largest ratio that renders at most `mp` megapixels at this CSS size. */
  const budgetRatio = (mp: number) => (cssMp > 0 ? Math.sqrt(mp / cssMp) : Infinity);

  let max: number;
  let min: number;
  let initial: number;
  let msaa = rc.msaaSamples;
  let cloudMode: CloudMode | null = null;

  const effective: QualityLevel = level === 'auto' && tier === 'software' ? 'low' : level;
  switch (effective) {
    case 'high':
      max = Math.min(dpr, rc.maxPixelRatio);
      min = Math.min(rc.minPixelRatio, max);
      initial = max;
      break;
    case 'medium':
      max = Math.min(dpr, 1.25, rc.maxPixelRatio);
      min = Math.min(q.floorPixelRatio, max);
      initial = Math.min(max, 1);
      msaa = Math.min(msaa, 2);
      break;
    case 'low':
      max = Math.min(dpr, 1, rc.maxPixelRatio);
      min = Math.min(q.floorPixelRatio, max);
      initial = Math.min(max, 0.75, budgetRatio(q.startMegapixels));
      msaa = 0;
      cloudMode = 'billboard';
      break;
    default: {
      // auto on a real GPU
      const weak = tier === 'low';
      max = Math.min(dpr, weak ? 1 : rc.maxPixelRatio, rc.maxPixelRatio);
      min = Math.min(q.floorPixelRatio, max);
      initial = Math.min(max, budgetRatio(q.startMegapixels * (weak ? q.weakGpuStartScale : 1)));
      break;
    }
  }
  max = floor3(max);
  min = Math.min(floor3(min), max);
  // Whole hundredths for the start (1440×900 → exactly 1.0, not a 1441-pixel-wide buffer).
  initial = Math.min(max, Math.max(min, Math.floor(initial * 100 + 1e-6) / 100));
  msaa = msaa >= 4 ? 4 : msaa >= 2 ? 2 : 0;
  const msaaAdaptive = msaa > 0 && (effective === 'auto' || effective === 'medium');
  return { level, tier, minPixelRatio: min, initialPixelRatio: initial, maxPixelRatio: max, msaaSamples: msaa, msaaAdaptive, cloudMode, rampUpDelay: q.rampUpDelay, warmup: q.warmup };
}

/** The MSAA sample counts dynamic resolution may step through, best first (undefined: MSAA stays fixed). */
export function msaaLadder(plan: Pick<QualityPlan, 'msaaSamples' | 'msaaAdaptive'>): number[] | undefined {
  if (!plan.msaaAdaptive || plan.msaaSamples <= 0) return undefined;
  return plan.msaaSamples >= 4 ? [4, 2, 0] : [2, 0];
}
