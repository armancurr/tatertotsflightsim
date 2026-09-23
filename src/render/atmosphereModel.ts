/**
 * Physically based clear-sky model — pure TypeScript, no three.js.
 *
 * A spherical planet with an exponential Rayleigh atmosphere, an exponential
 * aerosol (Mie) haze layer and an ozone layer. Single scattering is integrated
 * along the view ray with an energy-conserving step (Hillaire 2020); sunlight
 * reaching each sample is attenuated with Schüler's analytic approximation of
 * the Chapman grazing-incidence function (GPU Pro 3), so no LUTs are needed.
 * An isotropic term approximates multiple scattering.
 *
 * The GLSL sky shader (sky.ts) is a line-by-line mirror of `skyRadiance`, and
 * the aerosol numbers are exactly the aerial-perspective fog numbers (fog.ts),
 * so the sky at the horizon and the haze over distant terrain are the same
 * atmosphere. This file is what the tests exercise and what the CPU uses to
 * derive light colours (sun, sky ambient, haze, cloud lighting).
 *
 * Units: metres, radiance in "scene units" = sunIlluminance × (radiance for a
 * unit top-of-atmosphere solar irradiance).
 */
import { CONFIG } from '../config';
import type { Vec3 } from '../types';

export interface RGB {
  r: number;
  g: number;
  b: number;
}

export interface AtmosphereParams {
  planetRadius: number;
  atmosphereHeight: number;
  /** Rayleigh scattering (= extinction) coefficients at sea level, 1/m. */
  rayleigh: RGB;
  rayleighScaleHeight: number;
  /** Aerosol extinction at sea level, 1/m (grey). Same number as the aerial-perspective fog density. */
  mieExtinction: number;
  /** Aerosol single-scattering albedo (scattering / extinction). */
  mieAlbedo: number;
  mieScaleHeight: number;
  /** Aerosol phase asymmetry (Cornette-Shanks g). */
  mieG: number;
  /** Ozone absorption at the layer peak, 1/m. Tent profile centred at ozoneCenter, half-width ozoneWidth. */
  ozone: RGB;
  ozoneCenter: number;
  ozoneWidth: number;
  /** Strength of the isotropic multiple-scattering approximation (0 = single scattering only). */
  multiScatter: number;
  /** Top-of-atmosphere solar irradiance in scene units (three.js light intensity units). */
  sunIlluminance: number;
  /** Colour of sunlight above the atmosphere (acts as the camera white balance). */
  sunColor: RGB;
}

type AtmoCfg = typeof CONFIG.atmosphere;

export function defaultAtmosphereParams(cfg: AtmoCfg = CONFIG.atmosphere): AtmosphereParams {
  const rs = cfg.rayleighScale;
  return {
    planetRadius: 6360e3,
    atmosphereHeight: 100e3,
    rayleigh: { r: 5.802e-6 * rs, g: 13.558e-6 * rs, b: 33.1e-6 * rs },
    rayleighScaleHeight: 8000,
    mieExtinction: cfg.fogDensity,
    mieAlbedo: cfg.mieAlbedo,
    mieScaleHeight: 1 / cfg.fogHeightFalloff,
    mieG: cfg.mieDirectionalG,
    ozone: { r: 0.65e-6, g: 1.881e-6, b: 0.085e-6 },
    ozoneCenter: 25e3,
    ozoneWidth: 15e3,
    multiScatter: cfg.multiScatter,
    sunIlluminance: cfg.sunIntensity,
    sunColor: { r: cfg.sunColor[0], g: cfg.sunColor[1], b: cfg.sunColor[2] },
  };
}

export const luminance = (c: RGB): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

export function phaseRayleigh(mu: number): number {
  return (3 / (16 * Math.PI)) * (1 + mu * mu);
}

/** Cornette-Shanks phase function (normalised Henyey-Greenstein variant with a Rayleigh-like back lobe). */
export function phaseMie(mu: number, g: number): number {
  const g2 = g * g;
  const denom = Math.pow(Math.max(1e-6, 1 + g2 - 2 * g * mu), 1.5);
  return ((3 / (8 * Math.PI)) * ((1 - g2) * (1 + mu * mu))) / ((2 + g2) * denom);
}

/**
 * Optical length ∫ exp(-h(s)/H) ds (metres) from height `h` along a ray with
 * cosine-of-zenith `cosZ` out to space, over a spherical planet of radius R.
 * Schüler's approximation of the Chapman function; valid when the ray does not
 * hit the planet (callers check that).
 */
export function chapmanLength(H: number, h: number, cosZ: number, R: number): number {
  const u = H * Math.LN2; // work in units of the 50%-height
  const X = R / u;
  const hh = h / u;
  const c = Math.sqrt(X + hh);
  if (cosZ >= 0) return (H * c * Math.pow(2, -hh)) / (c * cosZ + 1);
  const x0 = Math.sqrt(Math.max(0, 1 - cosZ * cosZ)) * (X + hh);
  const c0 = Math.sqrt(x0);
  return H * (2 * c0 * Math.pow(2, X - x0) - (c * Math.pow(2, -hh)) / (1 - c * cosZ));
}

/** Remaining ozone column (m at peak density) above height h, times the slant factor through the layer. */
function ozoneLength(p: AtmosphereParams, h: number, cosZ: number): number {
  const lo = p.ozoneCenter - p.ozoneWidth;
  const hi = p.ozoneCenter + p.ozoneWidth;
  let column: number;
  if (h <= lo) column = p.ozoneWidth;
  else if (h <= p.ozoneCenter) column = p.ozoneWidth - ((h - lo) * (h - lo)) / (2 * p.ozoneWidth);
  else if (h < hi) column = ((hi - h) * (hi - h)) / (2 * p.ozoneWidth);
  else return 0;
  const ro = p.planetRadius + Math.max(h, p.ozoneCenter);
  const r = p.planetRadius + h;
  const s = (r / ro) * (r / ro) * (1 - cosZ * cosZ);
  const cosO = Math.sqrt(Math.max(0.0025, 1 - s));
  return column / cosO;
}

/** True when a ray from height h with cos(zenith) cosZ hits the ground. */
export function rayHitsPlanet(R: number, h: number, cosZ: number): boolean {
  if (cosZ >= 0) return false;
  // r²(1 − cos²) < R²  ⇔  h(2R + h) < r²cos²  (cancellation-free form, same as the GLSL)
  const r = R + h;
  return h * (2 * R + h) < r * r * cosZ * cosZ;
}

/** Transmittance from height h toward direction with cos(zenith) cosZ, out to space. */
export function transmittanceToSpace(p: AtmosphereParams, h: number, cosZ: number, out: RGB): RGB {
  if (rayHitsPlanet(p.planetRadius, h, cosZ)) {
    out.r = out.g = out.b = 0;
    return out;
  }
  const lR = chapmanLength(p.rayleighScaleHeight, h, cosZ, p.planetRadius);
  const lM = chapmanLength(p.mieScaleHeight, h, cosZ, p.planetRadius);
  const lO = ozoneLength(p, h, cosZ);
  const m = p.mieExtinction * lM;
  out.r = Math.exp(-(p.rayleigh.r * lR + m + p.ozone.r * lO));
  out.g = Math.exp(-(p.rayleigh.g * lR + m + p.ozone.g * lO));
  out.b = Math.exp(-(p.rayleigh.b * lR + m + p.ozone.b * lO));
  return out;
}

/** Direct sun illuminance (scene units, per channel) arriving at height h. */
export function sunIlluminanceAt(p: AtmosphereParams, h: number, sunDir: Vec3, out: RGB): RGB {
  transmittanceToSpace(p, h, sunDir.y, out);
  out.r *= p.sunIlluminance * p.sunColor.r;
  out.g *= p.sunIlluminance * p.sunColor.g;
  out.b *= p.sunIlluminance * p.sunColor.b;
  return out;
}

const _ts: RGB = { r: 0, g: 0, b: 0 };

/**
 * Sky radiance seen from `cameraHeight` (m above sea level) looking along the
 * unit vector `dir`, with the sun toward `sunDir`. Scene units. Mirrors the
 * GLSL in sky.ts (SKY_GLSL) exactly — keep them in sync.
 */
export function skyRadiance(p: AtmosphereParams, dir: Vec3, sunDir: Vec3, cameraHeight: number, out: RGB, steps = 16): RGB {
  const R = p.planetRadius;
  const Rt = R + p.atmosphereHeight;
  const h0 = Math.max(cameraHeight, 1);
  const r0 = R + h0;
  const mu = dir.y;
  const nu = dir.x * sunDir.x + dir.y * sunDir.y + dir.z * sunDir.z;
  const discTop = (Rt - r0) * (Rt + r0) + r0 * r0 * mu * mu;
  let tMax = -r0 * mu + Math.sqrt(Math.max(0, discTop));
  const discG = r0 * r0 * mu * mu - h0 * (2 * R + h0);
  if (mu < 0 && discG > 0) tMax = -r0 * mu - Math.sqrt(discG);

  const phR = phaseRayleigh(nu);
  const phM = phaseMie(nu, p.mieG);
  const iso = 1 / (4 * Math.PI);
  const ms = p.multiScatter;
  const bMs = p.mieExtinction * p.mieAlbedo;

  let tvR = 1;
  let tvG = 1;
  let tvB = 1;
  let lr = 0;
  let lg = 0;
  let lb = 0;
  for (let i = 0; i < steps; i++) {
    const s0 = i / steps;
    const s1 = (i + 1) / steps;
    const t0 = tMax * s0 * s0;
    const t1 = tMax * s1 * s1;
    const dt = t1 - t0;
    const tm = 0.5 * (t0 + t1);
    // r² − R² without cancellation, then h = (r² − R²)/(r + R)
    const q = h0 * (2 * R + h0) + tm * tm + 2 * r0 * tm * mu;
    const r = Math.sqrt(R * R + q);
    const h = q / (r + R);
    const dR = Math.exp(-h / p.rayleighScaleHeight);
    const dM = Math.exp(-h / p.mieScaleHeight);
    const dO = Math.max(0, 1 - Math.abs(h - p.ozoneCenter) / p.ozoneWidth);
    const sRr = p.rayleigh.r * dR;
    const sRg = p.rayleigh.g * dR;
    const sRb = p.rayleigh.b * dR;
    const sMs = bMs * dM;
    const sMe = p.mieExtinction * dM;
    const er = sRr + sMe + p.ozone.r * dO;
    const eg = sRg + sMe + p.ozone.g * dO;
    const eb = sRb + sMe + p.ozone.b * dO;
    const muS = (r0 * sunDir.y + tm * nu) / r;
    transmittanceToSpace(p, h, muS, _ts);
    // Multiple scattering: isotropic source proportional to the local sunlight (plus a skylight floor).
    const msr = ms * iso * (_ts.r + 0.02);
    const msg = ms * iso * (_ts.g + 0.02);
    const msb = ms * iso * (_ts.b + 0.02);
    const Sr = _ts.r * (sRr * phR + sMs * phM) + (sRr + sMs) * msr;
    const Sg = _ts.g * (sRg * phR + sMs * phM) + (sRg + sMs) * msg;
    const Sb = _ts.b * (sRb * phR + sMs * phM) + (sRb + sMs) * msb;
    const Tr = Math.exp(-er * dt);
    const Tg = Math.exp(-eg * dt);
    const Tb = Math.exp(-eb * dt);
    lr += (tvR * Sr * (1 - Tr)) / Math.max(er, 1e-12);
    lg += (tvG * Sg * (1 - Tg)) / Math.max(eg, 1e-12);
    lb += (tvB * Sb * (1 - Tb)) / Math.max(eb, 1e-12);
    tvR *= Tr;
    tvG *= Tg;
    tvB *= Tb;
  }
  const k = p.sunIlluminance;
  out.r = lr * k * p.sunColor.r;
  out.g = lg * k * p.sunColor.g;
  out.b = lb * k * p.sunColor.b;
  return out;
}
