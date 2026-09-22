import { describe, it, expect } from 'vitest';
import { sunDirectionFromAngles, shadowLightBasis, snapShadowCenter } from '../../src/render/sun';
import type { Vec3 } from '../../src/types';

const v = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });
const dot = (a: Vec3, b: Vec3) => a.x * b.x + a.y * b.y + a.z * b.z;
const len = (a: Vec3) => Math.sqrt(dot(a, a));

describe('sunDirectionFromAngles (world: +X east, +Y up, +Z south, north = -Z)', () => {
  it('azimuth 0 on the horizon points north (-Z)', () => {
    const d = sunDirectionFromAngles(0, 0);
    expect(d.x).toBeCloseTo(0, 9);
    expect(d.y).toBeCloseTo(0, 9);
    expect(d.z).toBeCloseTo(-1, 9);
  });
  it('azimuth 90 points east (+X), 180 south (+Z), 270 west (-X)', () => {
    const e = sunDirectionFromAngles(0, 90);
    expect(e.x).toBeCloseTo(1, 9);
    expect(e.z).toBeCloseTo(0, 9);
    const s = sunDirectionFromAngles(0, 180);
    expect(s.z).toBeCloseTo(1, 9);
    const w = sunDirectionFromAngles(0, 270);
    expect(w.x).toBeCloseTo(-1, 9);
  });
  it('elevation 90 is straight up and the vector is unit length for any angle', () => {
    const up = sunDirectionFromAngles(90, 123);
    expect(up.y).toBeCloseTo(1, 9);
    for (const [el, az] of [[38, 125], [62, 175], [9, 255], [4, 95], [-5, 10]]) {
      const d = sunDirectionFromAngles(el, az);
      expect(len(d)).toBeCloseTo(1, 12);
      expect(d.y).toBeCloseTo(Math.sin((el * Math.PI) / 180), 12);
    }
  });
  it('the morning preset (az 125°) is in the south-east quadrant', () => {
    const d = sunDirectionFromAngles(38, 125);
    expect(d.x).toBeGreaterThan(0); // east
    expect(d.z).toBeGreaterThan(0); // south
  });
  it('writes into an out vector when given one', () => {
    const out = v(9, 9, 9);
    const r = sunDirectionFromAngles(30, 45, out);
    expect(r).toBe(out);
    expect(len(out)).toBeCloseTo(1, 12);
  });
});

describe('shadowLightBasis', () => {
  it('returns an orthonormal right/up pair perpendicular to the sun direction (three.js lookAt convention)', () => {
    const sun = sunDirectionFromAngles(38, 125);
    const r = v();
    const u = v();
    shadowLightBasis(sun, r, u);
    expect(len(r)).toBeCloseTo(1, 12);
    expect(len(u)).toBeCloseTo(1, 12);
    expect(dot(r, u)).toBeCloseTo(0, 12);
    expect(dot(r, sun)).toBeCloseTo(0, 12);
    expect(dot(u, sun)).toBeCloseTo(0, 12);
    // three's Matrix4.lookAt(eye, target, up=(0,1,0)) with z = sunDir gives x = normalize(up × z)
    const cx = { x: 1 * sun.z - 0 * sun.y, y: 0 * sun.x - 0 * sun.z, z: 0 * sun.y - 1 * sun.x };
    const cl = len(cx);
    expect(r.x).toBeCloseTo(cx.x / cl, 12);
    expect(r.y).toBeCloseTo(cx.y / cl, 12);
    expect(r.z).toBeCloseTo(cx.z / cl, 12);
    // up is roughly world-up-ish (positive y)
    expect(u.y).toBeGreaterThan(0);
  });
  it('does not degenerate when the sun is straight overhead', () => {
    const r = v();
    const u = v();
    shadowLightBasis(v(0, 1, 0), r, u);
    expect(len(r)).toBeCloseTo(1, 9);
    expect(len(u)).toBeCloseTo(1, 9);
    expect(Number.isFinite(r.x + r.y + r.z + u.x + u.y + u.z)).toBe(true);
  });
});

describe('snapShadowCenter (texel snapping stops shadow shimmering)', () => {
  const sun = sunDirectionFromAngles(38, 125);
  const extent = 160;
  const mapSize = 2048;
  const texel = (2 * extent) / mapSize;
  const r = v();
  const u = v();
  shadowLightBasis(sun, r, u);

  it('puts the centre on the light-space texel grid', () => {
    for (const f of [v(12.34, 55.5, -8.1), v(-1033.7, 1502.2, 4411.9), v(0.01, 0, 0.02)]) {
      const c = snapShadowCenter(f, sun, extent, mapSize, v());
      const lx = dot(c, r) / texel;
      const ly = dot(c, u) / texel;
      expect(Math.abs(lx - Math.round(lx))).toBeLessThan(1e-6);
      expect(Math.abs(ly - Math.round(ly))).toBeLessThan(1e-6);
    }
  });
  it('moves the centre by at most half a texel per axis and keeps the depth along the sun ray', () => {
    const f = v(101.7, 230.4, -77.3);
    const c = snapShadowCenter(f, sun, extent, mapSize, v());
    const d = { x: c.x - f.x, y: c.y - f.y, z: c.z - f.z };
    expect(Math.abs(dot(d, r))).toBeLessThanOrEqual(texel / 2 + 1e-9);
    expect(Math.abs(dot(d, u))).toBeLessThanOrEqual(texel / 2 + 1e-9);
    expect(Math.abs(dot(d, sun))).toBeLessThan(1e-9);
  });
  it('is stable: sub-texel motion that does not cross a texel boundary keeps the same light-space centre', () => {
    // start exactly on a texel centre, then nudge by a quarter texel along 'right'
    const base = { x: r.x * texel * 100 + u.x * texel * 40, y: r.y * texel * 100 + u.y * texel * 40, z: r.z * texel * 100 + u.z * texel * 40 };
    const a = snapShadowCenter(base, sun, extent, mapSize, v());
    const nudged = { x: base.x + r.x * texel * 0.25, y: base.y + r.y * texel * 0.25, z: base.z + r.z * texel * 0.25 };
    const b = snapShadowCenter(nudged, sun, extent, mapSize, v());
    expect(dot(a, r)).toBeCloseTo(dot(b, r), 9);
    expect(dot(a, u)).toBeCloseTo(dot(b, u), 9);
  });
});
