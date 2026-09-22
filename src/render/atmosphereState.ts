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
import { fogStateFromAtmosphere, type FogState } from './fog';

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
  };
}

// Hemisphere quadrature for the sky irradiance: elevation bands × 8 azimuths.
const BANDS = [0, 8, 18, 32, 48, 64, 78, 90].map((d) => (d * Math.PI) / 180);
const AZ = 8;
const _l = rgb();
const _d: Vec3 = { x: 0, y: 0, z: 0 };

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
  return s;
}
