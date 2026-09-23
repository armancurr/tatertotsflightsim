/**
 * Everything the renderer needs to light the scene for one sun direction and
 * camera height, derived from the physical sky model (pure, no three.js):
 * sun light colour/intensity, sky irradiance, ground radiance (env map lower
 * hemisphere), aerial-perspective fog state, cloud and cirrus lighting, the
 * in-cloud whiteout colour and the flare's sun-disc luminance.
 * Cost ≈ 70 sky-radiance evaluations (~0.2 ms); the atmosphere recomputes it
 * on time-of-day changes and when the camera altitude changes noticeably.
 */
import type { Vec3 } from '../types';
import { CONFIG } from '../config';
import { luminance, skyRadiance, sunIlluminanceAt, type AtmosphereParams, type RGB } from './atmosphereModel';
import { fogStateFromAtmosphere, hazeColor, type FogState } from './fog';

export interface AtmosphereState {
  sunDir: Vec3;
  /** Camera world y the state was computed for. */
  cameraY: number;
  /** Direct sun illuminance at the camera (scene units). */
  sunAtCamera: RGB;
  /** Sun light colour, normalised so the largest channel is 1. */
  lightColor: RGB;
  lightIntensity: number;
  /** Irradiance on a horizontal surface from the sky dome alone (scene units). */
  skyIrradiance: RGB;
  zenith: RGB;
  /** Radiance of the sunlit ground (for the env-map lower hemisphere). */
  groundRadiance: RGB;
  fog: FogState;
  cloud: { sun: RGB; ambientTop: RGB; ambientBottom: RGB };
  immersionColor: RGB;
  /** HDR luminance of the unoccluded sun disc (lens-flare threshold). */
  sunDiscLuminance: number;
  cirrusSun: RGB;
  cirrusAmbient: RGB;
  /** Illuminance on flat ground from the sun and the sky (luminance, scene units): what the camera meters. */
  illuminance: number;
  /** Tone-mapping exposure the camera adapts to (config.atmosphere.exposure at the reference light). */
  exposure: number;
  /** Per-channel camera white-balance gains (luminance-preserving). */
  whiteBalance: RGB;
}

export interface AtmosphereStateOptions {
  groundAlbedo?: number;
  cloudAltitude?: number;
  cirrusAltitude?: number;
  /** Sun angular radius, radians. */
  sunAngularRadius?: number;
}

const rgb = (): RGB => ({ r: 0, g: 0, b: 0 });
const set = (o: RGB, r: number, g: number, b: number) => {
  o.r = r;
  o.g = g;
  o.b = b;
  return o;
};

function blank(): AtmosphereState {
  return {
    sunDir: { x: 0, y: 1, z: 0 },
    cameraY: 0,
    sunAtCamera: rgb(),
    lightColor: rgb(),
    lightIntensity: 0,
    skyIrradiance: rgb(),
    zenith: rgb(),
    groundRadiance: rgb(),
    fog: undefined as unknown as FogState,
    cloud: { sun: rgb(), ambientTop: rgb(), ambientBottom: rgb() },
    immersionColor: rgb(),
    sunDiscLuminance: 0,
    cirrusSun: rgb(),
    cirrusAmbient: rgb(),
    illuminance: 0,
    exposure: 1,
    whiteBalance: { r: 1, g: 1, b: 1 },
  };
}

type AutoExposureCfg = typeof CONFIG.atmosphere.autoExposure;

/**
 * Exposure for a scene lit with illuminance `E` on flat ground: `base` at the reference
 * light, × (reference / E)^strength (partial adaptation), clamped to [min, max] × base.
 * No light (E ≤ 0, NaN) = fully open. Pure, finite for any input.
 */
export function autoExposure(E: number, base: number, cfg: AutoExposureCfg = CONFIG.atmosphere.autoExposure): number {
  const lo = base * cfg.min;
  const hi = base * cfg.max;
  if (!(E > 0)) return hi;
  if (!Number.isFinite(E)) return lo;
  const k = base * Math.pow(cfg.reference / E, cfg.strength);
  return Number.isFinite(k) ? Math.min(hi, Math.max(lo, k)) : hi;
}

const sstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The look's colour tint for a sun elevation (degrees): warm (more red, less blue) while the sun is
 * low — strongest at golden hour (8–12°), fading out by 25° and toward the horizon — and cool
 * once it has set (blue hour).
 * Luminance-preserving gains; neutral for a high sun or junk input.
 */
export function lookTint(sunElevationDeg: number, out: RGB, cfg: { warmth: number; blueHour: number } = CONFIG.atmosphere.grade): RGB {
  const el = Number.isFinite(sunElevationDeg) ? sunElevationDeg : 90;
  // peaks at golden hour (8–12°); a sunrise sun (≲ 4°) is orange enough already
  const warm = Math.min(0.2, Math.max(0, cfg.warmth)) * (1 - sstep(12, 25, el)) * sstep(0, 8, el);
  const cool = Math.min(0.2, Math.max(0, cfg.blueHour)) * (1 - sstep(-6, 0, el));
  const r = 1 + warm - 0.6 * cool;
  const g = 1 + 0.25 * warm - 0.1 * cool;
  const b = 1 - warm + cool;
  const n = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  out.r = r / n;
  out.g = g / n;
  out.b = b / n;
  return out;
}

/**
 * Von Kries white-balance gains that move the colour `illuminant` part of the way (strength 0..1)
 * toward neutral, normalised so a white surface keeps its luminance; bounded to [0.6, 1.6].
 */
export function whiteBalanceGains(illuminant: RGB, strength: number, out: RGB): RGB {
  const k = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 0;
  const c = (v: number) => (Number.isFinite(v) && v > 1e-6 ? v : 1e-6);
  let r = c(illuminant.r);
  let g = c(illuminant.g);
  let b = c(illuminant.b);
  const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const gain = (v: number) => Math.min(1.6, Math.max(0.6, Math.pow(l / v, k)));
  r = gain(r);
  g = gain(g);
  b = gain(b);
  const n = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  out.r = Math.min(1.6, Math.max(0.6, r / n));
  out.g = Math.min(1.6, Math.max(0.6, g / n));
  out.b = Math.min(1.6, Math.max(0.6, b / n));
  return out;
}

// Hemisphere quadrature for the sky irradiance: elevation bands × 8 azimuths.
const BANDS = [0, 8, 18, 32, 48, 64, 78, 90].map((d) => (d * Math.PI) / 180);
const AZ = 8;
const _l = rgb();
const _d: Vec3 = { x: 0, y: 0, z: 0 };
const _hz = rgb();
const _wb = rgb();

/** Cosine-weighted sky irradiance on a horizontal surface at height h (m above sea level). */
export function skyIrradianceAt(p: AtmosphereParams, sunDir: Vec3, h: number, out: RGB): RGB {
  set(out, 0, 0, 0);
  for (let b = 0; b < BANDS.length - 1; b++) {
    const a0 = BANDS[b];
    const a1 = BANDS[b + 1];
    const el = 0.5 * (a0 + a1);
    // ∫ cosθ dω over the band = π (sin²a1 − sin²a0) ; split over AZ azimuths
    const w = (Math.PI * (Math.sin(a1) ** 2 - Math.sin(a0) ** 2)) / AZ;
    for (let i = 0; i < AZ; i++) {
      const az = ((i + 0.5) / AZ) * Math.PI * 2;
      _d.x = Math.sin(az) * Math.cos(el);
      _d.y = Math.sin(el);
      _d.z = -Math.cos(az) * Math.cos(el);
      skyRadiance(p, _d, sunDir, h, _l, 12);
      out.r += _l.r * w;
      out.g += _l.g * w;
      out.b += _l.b * w;
    }
  }
  return out;
}

export function computeAtmosphereState(
  p: AtmosphereParams,
  sunDir: Vec3,
  cameraY: number,
  opts: AtmosphereStateOptions = {},
  out?: AtmosphereState,
): AtmosphereState {
  const s = out ?? blank();
  const sea = CONFIG.world.seaLevel;
  const h = Math.max(0, cameraY - sea);
  const albedo = opts.groundAlbedo ?? 0.13;
  const cc = CONFIG.atmosphere.clouds;
  const cloudAlt = opts.cloudAltitude ?? cc.baseAltitude + cc.thickness * 0.5;
  const cirrusAlt = opts.cirrusAltitude ?? CONFIG.atmosphere.cirrus.altitude;
  const alpha = opts.sunAngularRadius ?? (CONFIG.atmosphere.sunAngularRadiusDeg * Math.PI) / 180;
  const sinEl = Math.max(0, sunDir.y);

  s.sunDir.x = sunDir.x;
  s.sunDir.y = sunDir.y;
  s.sunDir.z = sunDir.z;
  s.cameraY = cameraY;

  sunIlluminanceAt(p, h, sunDir, s.sunAtCamera);
  const m = Math.max(s.sunAtCamera.r, s.sunAtCamera.g, s.sunAtCamera.b, 1e-6);
  s.lightIntensity = m;
  set(s.lightColor, s.sunAtCamera.r / m, s.sunAtCamera.g / m, s.sunAtCamera.b / m);

  skyIrradianceAt(p, sunDir, h, s.skyIrradiance);
  _d.x = 0;
  _d.y = 1;
  _d.z = 0;
  skyRadiance(p, _d, sunDir, h, s.zenith);

  // Ground (lower env hemisphere): sunlit + skylit Lambertian terrain.
  const sunG = sunIlluminanceAt(p, 0, sunDir, rgb());
  const k = albedo / Math.PI;
  set(
    s.groundRadiance,
    k * (sunG.r * sinEl + s.skyIrradiance.r),
    k * (sunG.g * sinEl + s.skyIrradiance.g),
    k * (sunG.b * sinEl + s.skyIrradiance.b),
  );

  s.fog = fogStateFromAtmosphere(p, sunDir, cameraY, s.fog);

  // Clouds: albedo ~0.9 Lambertian-ish; bases get ground bounce, light diffusing
  // through the cloud and horizon skylight.
  sunIlluminanceAt(p, Math.max(0, cloudAlt - sea), sunDir, s.cloud.sun);
  const ca = 0.9 / Math.PI;
  const sky = s.skyIrradiance;
  const cs = s.cloud.sun;
  set(s.cloud.ambientTop, ca * sky.r * 1.05, ca * sky.g * 1.05, ca * sky.b * 1.05);
  const gUp = (c: 'r' | 'g' | 'b') => albedo * (sunG[c] * sinEl + sky[c]);
  set(
    s.cloud.ambientBottom,
    ca * (gUp('r') + 0.1 * cs.r * sinEl + 0.4 * sky.r),
    ca * (gUp('g') + 0.1 * cs.g * sinEl + 0.4 * sky.g),
    ca * (gUp('b') + 0.1 * cs.b * sinEl + 0.4 * sky.b),
  );
  const ct = s.cloud.ambientTop;
  const cb = s.cloud.ambientBottom;
  // Inside a sunlit cumulus: bright, diffuse, slightly blue-grey light from all around.
  set(
    s.immersionColor,
    ca * 0.55 * cs.r * sinEl + 0.6 * ct.r + 0.4 * cb.r,
    ca * 0.55 * cs.g * sinEl + 0.6 * ct.g + 0.4 * cb.g,
    ca * 0.55 * cs.b * sinEl + 0.6 * ct.b + 0.4 * cb.b,
  );

  s.sunDiscLuminance = Math.min(60000, (luminance(s.sunAtCamera) / (Math.PI * alpha * alpha)) * 0.8);

  sunIlluminanceAt(p, Math.max(0, cirrusAlt - sea), sunDir, s.cirrusSun);
  set(s.cirrusAmbient, ca * 0.45 * sky.r, ca * 0.45 * sky.g, ca * 0.45 * sky.b);

  // Camera: meter the light on flat ground (sun + sky) → exposure; white balance from what fills
  // the frame — the sunlit ground and the horizon haze — each normalised to unit luminance.
  const ac = CONFIG.atmosphere;
  s.illuminance = luminance(sunG) * sinEl + luminance(s.skyIrradiance);
  s.exposure = autoExposure(s.illuminance, ac.exposure, ac.autoExposure);
  set(_wb, 0, 0, 0);
  for (let i = 0; i < 8; i++) {
    const az = (i / 8) * Math.PI * 2;
    _d.x = Math.sin(az) * 0.9998;
    _d.y = 0.02;
    _d.z = -Math.cos(az) * 0.9998;
    hazeColor(_d, cameraY, s.fog, _hz);
    const lh = Math.max(luminance(_hz), 1e-9);
    _wb.r += _hz.r / lh / 16;
    _wb.g += _hz.g / lh / 16;
    _wb.b += _hz.b / lh / 16;
  }
  const lg = Math.max(luminance(s.groundRadiance), 1e-9);
  _wb.r += (0.5 * s.groundRadiance.r) / lg;
  _wb.g += (0.5 * s.groundRadiance.g) / lg;
  _wb.b += (0.5 * s.groundRadiance.b) / lg;
  whiteBalanceGains(_wb, ac.whiteBalance, s.whiteBalance);
  // …and the look: golden-hour warmth / blue-hour cool on top
  lookTint((Math.asin(Math.max(-1, Math.min(1, sunDir.y))) * 180) / Math.PI, _hz);
  const wb = s.whiteBalance;
  const n = 0.2126 * wb.r * _hz.r + 0.7152 * wb.g * _hz.g + 0.0722 * wb.b * _hz.b;
  set(wb, (wb.r * _hz.r) / n, (wb.g * _hz.g) / n, (wb.b * _hz.b) / n);
  return s;
}
