import { describe, it, expect } from 'vitest';
import {
  defaultAtmosphereParams,
  chapmanLength,
  transmittanceToSpace,
  sunIlluminanceAt,
  skyRadiance,
  phaseRayleigh,
  phaseMie,
  luminance,
  type RGB,
} from '../../src/render/atmosphereModel';
import { sunDirectionFromAngles } from '../../src/render/sun';

const P = defaultAtmosphereParams();
const rgb = (): RGB => ({ r: 0, g: 0, b: 0 });
const dirFrom = (elDeg: number, azDeg: number) => sunDirectionFromAngles(elDeg, azDeg);
const finite = (c: RGB) => Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b);

describe('Chapman optical-length approximation', () => {
  const H = 8000;
  const R = P.planetRadius;
  it('straight up from sea level is one scale height (flat-earth limit)', () => {
    expect(chapmanLength(H, 0, 1, R) / H).toBeCloseTo(1, 1);
  });
  it('along the horizon it is ≈ sqrt(pi·R·H/2) (spherical earth), not infinite', () => {
    const exact = Math.sqrt((Math.PI * R * H) / 2);
    expect(Math.abs(chapmanLength(H, 0, 0, R) / exact - 1)).toBeLessThan(0.06);
  });
  it('grows as the ray tilts toward the horizon and shrinks with altitude', () => {
    let prev = 0;
    for (const c of [1, 0.8, 0.5, 0.2, 0.05, 0]) {
      const l = chapmanLength(H, 0, c, R);
      expect(l).toBeGreaterThan(prev);
      prev = l;
    }
    expect(chapmanLength(H, 3000, 1, R)).toBeLessThan(chapmanLength(H, 0, 1, R));
    expect(chapmanLength(H, 3000, 1, R) / chapmanLength(H, 0, 1, R)).toBeCloseTo(Math.exp(-3000 / H), 2);
  });
});

describe('phase functions', () => {
  it('integrate to ~1 over the sphere', () => {
    const n = 4000;
    let sr = 0;
    let sm = 0;
    for (let i = 0; i < n; i++) {
      const mu = -1 + (2 * (i + 0.5)) / n;
      sr += phaseRayleigh(mu) * 2 * Math.PI * (2 / n);
      sm += phaseMie(mu, 0.76) * 2 * Math.PI * (2 / n);
    }
    expect(sr).toBeCloseTo(1, 2);
    expect(sm).toBeGreaterThan(0.95);
    expect(sm).toBeLessThan(1.05);
  });
  it('Mie is strongly forward-peaked', () => {
    expect(phaseMie(0.99, 0.76)).toBeGreaterThan(20 * phaseMie(-0.5, 0.76));
  });
});

describe('transmittance to space (sunlight colour)', () => {
  it('is in (0,1) and reddest-passes-most at the zenith', () => {
    const t = transmittanceToSpace(P, 0, 1, rgb());
    for (const c of [t.r, t.g, t.b]) {
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThan(1);
    }
    expect(t.r).toBeGreaterThan(t.g);
    expect(t.g).toBeGreaterThan(t.b);
  });
  it('drops and reddens as the sun gets lower', () => {
    const hi = transmittanceToSpace(P, 0, Math.sin((62 * Math.PI) / 180), rgb());
    const lo = transmittanceToSpace(P, 0, Math.sin((9 * Math.PI) / 180), rgb());
    const dawn = transmittanceToSpace(P, 0, Math.sin((4 * Math.PI) / 180), rgb());
    expect(lo.g).toBeLessThan(hi.g);
    expect(dawn.g).toBeLessThan(lo.g);
    expect(lo.r / lo.b).toBeGreaterThan(hi.r / hi.b);
    expect(dawn.r / dawn.b).toBeGreaterThan(lo.r / lo.b);
  });
  it('increases with altitude', () => {
    const c = Math.sin((9 * Math.PI) / 180);
    expect(transmittanceToSpace(P, 3000, c, rgb()).b).toBeGreaterThan(transmittanceToSpace(P, 0, c, rgb()).b);
  });
  it('is zero when the planet blocks the sun', () => {
    const t = transmittanceToSpace(P, 100, -0.5, rgb());
    expect(t.r + t.g + t.b).toBe(0);
  });
});

describe('sun illuminance', () => {
  it('is near-white at midday and golden near the horizon', () => {
    const mid = sunIlluminanceAt(P, 0, dirFrom(62, 175), rgb());
    const gold = sunIlluminanceAt(P, 0, dirFrom(9, 255), rgb());
    expect(mid.r / mid.b).toBeLessThan(1.45);
    expect(gold.r / gold.b).toBeGreaterThan(1.8);
    expect(luminance(gold)).toBeLessThan(luminance(mid));
  });
});

describe('sky radiance (single scattering + multiple-scattering approximation)', () => {
  const sun = dirFrom(38, 125);
  const zen = skyRadiance(P, { x: 0, y: 1, z: 0 }, sun, 2, rgb());
  const horizonAway = skyRadiance(P, dirFrom(1, 305), sun, 2, rgb());
  const horizonSide = skyRadiance(P, dirFrom(1, 35), sun, 2, rgb());
  it('is finite and positive', () => {
    for (const c of [zen, horizonAway, horizonSide]) {
      expect(finite(c)).toBe(true);
      expect(c.r).toBeGreaterThan(0);
    }
    expect(finite(skyRadiance(P, dirFrom(-10, 0), sun, 2, rgb()))).toBe(true);
  });
  it('is deep blue overhead', () => {
    expect(zen.b).toBeGreaterThan(zen.g);
    expect(zen.g).toBeGreaterThan(zen.r);
    expect(zen.b / zen.r).toBeGreaterThan(2);
  });
  it('has a brighter, whiter band at the horizon', () => {
    expect(luminance(horizonSide)).toBeGreaterThan(luminance(zen));
    expect(horizonSide.b / horizonSide.r).toBeLessThan(zen.b / zen.r);
  });
  it('glows around the sun (Mie aureole)', () => {
    const nearSun = skyRadiance(P, dirFrom(43, 125), sun, 2, rgb());
    const opposite = skyRadiance(P, dirFrom(43, 305), sun, 2, rgb());
    expect(luminance(nearSun)).toBeGreaterThan(2 * luminance(opposite));
  });
  it('at dawn the horizon under the sun is warmer than the horizon opposite it', () => {
    const dawnSun = dirFrom(4, 95);
    const toward = skyRadiance(P, dirFrom(1, 95), dawnSun, 2, rgb());
    const away = skyRadiance(P, dirFrom(1, 275), dawnSun, 2, rgb());
    expect(toward.r / toward.b).toBeGreaterThan(away.r / away.b);
    expect(toward.r / toward.b).toBeGreaterThan(1);
  });
  it('the zenith gets darker and bluer from altitude', () => {
    const high = skyRadiance(P, { x: 0, y: 1, z: 0 }, sun, 4000, rgb());
    expect(luminance(high)).toBeLessThan(luminance(zen));
  });
});
