/**
 * Temporal reprojection for the cloud buffer (temporal.ts): projection of a
 * world point with the previous frame's view-projection matrix, history
 * acceptance/rejection, and the per-frame jitter sequence.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import {
  projectToUv,
  historyWeight,
  frameJitter,
  checkerOffset,
  marchBufferSize,
  isFreshPixel,
  marchCoord,
  resolveNewWeight,
  clampToRange,
  clipSimilarity,
  HISTORY_BOX_PAD,
  type UvResult,
  type PixelOffset,
} from '../../src/render/temporal';

function camera(x: number, y: number, z: number, yawDeg: number, pitchDeg: number) {
  const c = new THREE.PerspectiveCamera(60, 1.6, 0.1, 90000);
  c.position.set(x, y, z);
  c.rotation.set((pitchDeg * Math.PI) / 180, (-yawDeg * Math.PI) / 180, 0, 'YXZ');
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
}
const viewProj = (c: THREE.PerspectiveCamera) => new THREE.Matrix4().multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse).elements;

describe('reprojection', () => {
  it('matches three.js Vector3.project for any camera pose and point in front', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -5000, max: 5000, noNaN: true }),
        fc.double({ min: 0, max: 4000, noNaN: true }),
        fc.double({ min: -360, max: 360, noNaN: true }),
        fc.double({ min: -60, max: 60, noNaN: true }),
        fc.double({ min: -0.5, max: 0.5, noNaN: true }),
        fc.double({ min: -0.3, max: 0.3, noNaN: true }),
        fc.double({ min: 5, max: 40000, noNaN: true }),
        (x, y, yaw, pitch, sx, sy, dist) => {
          const c = camera(x, y, 100, yaw, pitch);
          const dir = new THREE.Vector3(sx, sy, -1).normalize().transformDirection(c.matrixWorld);
          const p = c.position.clone().addScaledVector(dir, dist);
          const r: UvResult = { u: 0, v: 0, valid: false };
          projectToUv(viewProj(c), p.x, p.y, p.z, r);
          const q = p.clone().project(c);
          expect(r.valid).toBe(true);
          expect(r.u).toBeCloseTo(q.x * 0.5 + 0.5, 5);
          expect(r.v).toBeCloseTo(q.y * 0.5 + 0.5, 5);
        },
      ),
    );
  });
  it('a static camera reprojects a pixel onto itself; a camera moving right shifts distant-ish points left', () => {
    const a = camera(0, 1000, 0, 0, 0);
    const b = camera(50, 1000, 0, 0, 0);
    const p = new THREE.Vector3(0, 1000, -2000);
    const r: UvResult = { u: 0, v: 0, valid: false };
    projectToUv(viewProj(a), p.x, p.y, p.z, r);
    expect(r.u).toBeCloseTo(0.5, 9);
    expect(r.v).toBeCloseTo(0.5, 9);
    // current camera b sees the point left of centre; in the previous frame (a) it was centred
    const now: UvResult = { u: 0, v: 0, valid: false };
    projectToUv(viewProj(b), p.x, p.y, p.z, now);
    expect(now.u).toBeLessThan(0.5);
  });
  it('points behind the camera or at infinity are invalid; output is always finite', () => {
    const c = camera(0, 0, 0, 0, 0);
    const r: UvResult = { u: 0, v: 0, valid: true };
    projectToUv(viewProj(c), 0, 0, 100, r);
    expect(r.valid).toBe(false);
    fc.assert(
      fc.property(fc.double({ noNaN: true }), fc.double({ noNaN: true }), fc.double({ noNaN: true }), (x, y, z) => {
        projectToUv(viewProj(c), x, y, z, r);
        expect(Number.isFinite(r.u) && Number.isFinite(r.v)).toBe(true);
      }),
    );
  });
});

describe('history weight', () => {
  it('keeps (1 − alpha) of the history when it is on screen and saw the same occluder depth', () => {
    expect(historyWeight(0.5, 0.5, true, 1200, 1210, 0.1)).toBeCloseTo(0.9, 9);
  });
  it('rejects history that is off screen, invalid, or from a different occluder (disocclusion)', () => {
    expect(historyWeight(-0.01, 0.5, true, 1200, 1200, 0.1)).toBe(0);
    expect(historyWeight(0.5, 1.2, true, 1200, 1200, 0.1)).toBe(0);
    expect(historyWeight(0.5, 0.5, false, 1200, 1200, 0.1)).toBe(0);
    // the aircraft (15 m) moved over sky pixels (infinite clip depth)
    expect(historyWeight(0.5, 0.5, true, 15, 65000, 0.1)).toBe(0);
    expect(historyWeight(0.5, 0.5, true, 65000, 15, 0.1)).toBe(0);
  });
  it('property: always in [0, 1 − alpha]', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -2, max: 3, noNaN: true }),
        fc.double({ min: -2, max: 3, noNaN: true }),
        fc.boolean(),
        fc.double({ min: 0.01, max: 1e5, noNaN: true }),
        fc.double({ min: 0.01, max: 1e5, noNaN: true }),
        fc.double({ min: 0.02, max: 1, noNaN: true }),
        (u, v, ok, a, b, alpha) => {
          const w = historyWeight(u, v, ok, a, b, alpha);
          expect(w).toBeGreaterThanOrEqual(0);
          expect(w).toBeLessThanOrEqual(1 - alpha + 1e-12);
        },
      ),
    );
  });
});

describe('frame jitter', () => {
  it('is in [0, 1), low-discrepancy over consecutive frames', () => {
    const vals = Array.from({ length: 16 }, (_, i) => frameJitter(i));
    for (const v of vals) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    // any 8 consecutive frames cover every eighth of [0,1) at most twice
    for (let s = 0; s < 8; s++) {
      const bins = new Array(8).fill(0);
      for (let i = s; i < s + 8; i++) bins[Math.floor(vals[i] * 8)]++;
      expect(Math.max(...bins)).toBeLessThanOrEqual(2);
    }
  });
});

// ─── Checkerboard (quarter-pixel) updates + resolve ─────────────────────────
// The march renders ONE pixel of every 2×2 block per frame (Bayer order); a
// resolve pass rebuilds the full cloud buffer from those fresh samples and the
// reprojected history (clamped to the fresh neighbourhood → no ghosting).

describe('checkerboard schedule', () => {
  it('cycles the 2×2 Bayer order (0,0) (1,1) (1,0) (0,1)', () => {
    const o: PixelOffset = { x: -1, y: -1 };
    const seq = [0, 1, 2, 3, 4, 5].map((f) => {
      checkerOffset(f, o);
      return `${o.x}${o.y}`;
    });
    expect(seq).toEqual(['00', '11', '10', '01', '00', '11']);
  });
  it('march buffer is ceil(w/2) × ceil(h/2)', () => {
    expect(marchBufferSize(720, 450)).toEqual({ width: 360, height: 225 });
    expect(marchBufferSize(721, 451)).toEqual({ width: 361, height: 226 });
    expect(marchBufferSize(1, 1)).toEqual({ width: 1, height: 1 });
  });
  it('property: over any 4 consecutive frames every pixel is marched exactly once, by the march texel marchCoord names', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5000 }), fc.integer({ min: 0, max: 1e6 }), fc.integer({ min: 0, max: 1e6 }), (f0, x, y) => {
        const o: PixelOffset = { x: 0, y: 0 };
        const c = { x: 0, y: 0 };
        let hits = 0;
        for (let f = f0; f < f0 + 4; f++) {
          checkerOffset(f, o);
          if (isFreshPixel(x, y, o)) {
            hits++;
            marchCoord(x, y, o, c);
            // a fresh pixel sits exactly on a march texel centre (integer coordinate) that maps back to it
            expect(Number.isInteger(c.x) && Number.isInteger(c.y)).toBe(true);
            expect(2 * c.x + o.x).toBe(x);
            expect(2 * c.y + o.y).toBe(y);
          }
        }
        expect(hits).toBe(1);
      }),
    );
  });
  it('fuzz: offsets and coordinates are finite for any frame number', () => {
    fc.assert(
      fc.property(fc.double({ noNaN: false }), (f) => {
        const o: PixelOffset = { x: 0, y: 0 };
        checkerOffset(f, o);
        expect([0, 1]).toContain(o.x);
        expect([0, 1]).toContain(o.y);
      }),
    );
  });
});

describe('resolve weights', () => {
  it('no usable history → the fresh estimate alone; fresh pixel → alpha; carried pixel → history only', () => {
    expect(resolveNewWeight(false, false, 0.4)).toBe(1);
    expect(resolveNewWeight(true, false, 0.4)).toBe(1);
    expect(resolveNewWeight(true, true, 0.4)).toBeCloseTo(0.4, 12);
    expect(resolveNewWeight(false, true, 0.4)).toBe(0);
  });
  it('history that had to be clamped far (it disagrees with the fresh neighbourhood) gives way to the fresh estimate', () => {
    expect(resolveNewWeight(false, true, 0.3, 0)).toBe(0);
    expect(resolveNewWeight(false, true, 0.3, 0.05)).toBeGreaterThan(0);
    expect(resolveNewWeight(false, true, 0.3, 1)).toBe(1);
    expect(resolveNewWeight(true, true, 0.3, 0.02)).toBeGreaterThanOrEqual(0.3);
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), fc.double({ min: 0, max: 1, noNaN: true }), fc.double({ noNaN: false }), (fresh, ok, a, c) => {
        const w = resolveNewWeight(fresh, ok, a, c);
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(1);
        expect(w).toBeGreaterThanOrEqual(resolveNewWeight(fresh, ok, a) - 1e-12);
      }),
    );
  });
  it('clamp and clip similarity', () => {
    expect(clampToRange(5, 0, 1)).toBe(1);
    expect(clampToRange(-5, 0, 1)).toBe(0);
    expect(clampToRange(0.3, 0, 1)).toBe(0.3);
    expect(clipSimilarity(1000, 1000)).toBe(1);
    expect(clipSimilarity(15, 60000)).toBeLessThan(1e-6);
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1e6, noNaN: true }), fc.double({ min: 0, max: 1e6, noNaN: true }), (a, b) => {
        const s = clipSimilarity(a, b);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
        expect(s).toBeCloseTo(clipSimilarity(b, a), 12);
      }),
    );
  });
});

/**
 * CPU model of the march + resolve on a W×H buffer (one scalar channel, e.g.
 * transmittance). The camera yaws `pan` pixels per frame (clouds far away →
 * pure image shift); an optional occluder (the aircraft: near clip distance,
 * no cloud in front of it) covers pixel columns [x0, x1).
 */
function simulate(o: {
  W: number;
  H: number;
  frames: number;
  pan: number;
  noise?: number;
  alpha?: number;
  truth: (u: number, v: number) => number;
  occluder?: (f: number) => [number, number] | null;
  invalidateAt?: number;
  onFrame?: (f: number, out: Float64Array, truth: Float64Array) => void;
}) {
  const { W, H } = o;
  const alpha = o.alpha ?? 0.5;
  const { width: mw, height: mh } = marchBufferSize(W, H);
  let hist = new Float64Array(W * H);
  let histClip = new Float64Array(W * H);
  let out = new Float64Array(W * H);
  let outClip = new Float64Array(W * H);
  const march = new Float64Array(mw * mh);
  const marchClip = new Float64Array(mw * mh);
  const truthNow = new Float64Array(W * H);
  let histValid = false;
  let seed = 12345;
  const rnd = () => {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    return seed / 4294967296 - 0.5;
  };
  const off: PixelOffset = { x: 0, y: 0 };
  const mc = { x: 0, y: 0 };
  for (let f = 0; f < o.frames; f++) {
    if (f === o.invalidateAt) histValid = false;
    const cam = f * o.pan;
    const occ = o.occluder?.(f) ?? null;
    const clipAt = (x: number) => (occ && x >= occ[0] && x < occ[1] ? 15 : 60000);
    const valAt = (x: number, y: number) => (clipAt(x) < 100 ? 1 : o.truth(x + cam, y));
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) truthNow[y * W + x] = valAt(x, y);
    checkerOffset(f, off);
    for (let j = 0; j < mh; j++)
      for (let i = 0; i < mw; i++) {
        const px = Math.min(W - 1, 2 * i + off.x);
        const py = Math.min(H - 1, 2 * j + off.y);
        march[j * mw + i] = valAt(px, py) + (o.noise ?? 0) * rnd();
        marchClip[j * mw + i] = clipAt(px);
      }
    const tex = (i: number, j: number) => (Math.min(mh - 1, Math.max(0, j)) * mw + Math.min(mw - 1, Math.max(0, i)));
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const clip = clipAt(x);
        marchCoord(x, y, off, mc);
        const fresh = isFreshPixel(x, y, off);
        // fresh estimate: own sample, else depth-aware bilinear of the 4 surrounding march texels
        let F: number;
        if (fresh) F = march[tex(mc.x, mc.y)];
        else {
          const i0 = Math.floor(mc.x);
          const j0 = Math.floor(mc.y);
          const fx = mc.x - i0;
          const fy = mc.y - j0;
          let acc = 0;
          let ws = 0;
          for (let k = 0; k < 4; k++) {
            const di = k & 1;
            const dj = k >> 1;
            const t = tex(i0 + di, j0 + dj);
            const w = (di ? fx : 1 - fx) * (dj ? fy : 1 - fy) * clipSimilarity(marchClip[t], clip) + 1e-9;
            acc += march[t] * w;
            ws += w;
          }
          F = acc / ws;
        }
        // neighbourhood box of the 3×3 march texels around
        let lo = Infinity;
        let hi = -Infinity;
        const ci = Math.round(mc.x);
        const cj = Math.round(mc.y);
        for (let dj = -1; dj <= 1; dj++)
          for (let di = -1; di <= 1; di++) {
            const v = march[tex(ci + di, cj + dj)];
            lo = Math.min(lo, v);
            hi = Math.max(hi, v);
          }
        // history: reprojected position (pure yaw → shift by pan), bilinear in x
        const xp = x + o.pan;
        let ok = histValid && xp >= 0 && xp <= W - 1;
        let Hv = 0;
        if (ok) {
          const x0 = Math.floor(xp);
          const x1 = Math.min(W - 1, x0 + 1);
          const t = xp - x0;
          Hv = hist[y * W + x0] * (1 - t) + hist[y * W + x1] * t;
          const hc = histClip[y * W + Math.round(xp)];
          ok = Math.abs(hc - clip) / Math.max(1e-3, Math.min(hc, clip)) < 0.1;
        }
        const pad = HISTORY_BOX_PAD * (hi - lo);
        const Hc = clampToRange(Hv, lo - pad, hi + pad);
        const w = resolveNewWeight(fresh, ok, alpha, Math.abs(Hc - Hv));
        Hv = Hc;
        out[y * W + x] = Hv + (F - Hv) * w;
        outClip[y * W + x] = clip;
      }
    o.onFrame?.(f, out, truthNow);
    [hist, out] = [out, hist];
    [histClip, outClip] = [outClip, histClip];
    histValid = true;
  }
  return hist;
}

const smoothSky = (u: number, v: number) => 0.55 + 0.35 * Math.sin(u / 9) * Math.cos(v / 7);
/** Max |a − b| over the interior (the outermost pixel ring extrapolates from one side, on the GPU too). */
function maxErr(a: Float64Array, b: Float64Array, W = 0) {
  let m = 0;
  const H = W ? a.length / W : 0;
  for (let i = 0; i < a.length; i++) {
    if (W) {
      const x = i % W;
      const y = Math.floor(i / W);
      if (x === 0 || y === 0 || x === W - 1 || y === H - 1) continue;
    }
    m = Math.max(m, Math.abs(a[i] - b[i]));
  }
  return m;
}

describe('checkerboard resolve (functional, CPU model of the GPU passes)', () => {
  it('static camera, noise-free: every 4-frame cycle halves the error; converged after 6 cycles', () => {
    const errs: number[] = [];
    simulate({ W: 48, H: 32, frames: 24, pan: 0, truth: smoothSky, onFrame: (f, out, tr) => f % 4 === 3 && errs.push(maxErr(out, tr, 48)) });
    for (let i = 1; i < errs.length; i++) expect(errs[i]).toBeLessThanOrEqual(errs[i - 1] * 0.55 + 1e-12);
    expect(errs[errs.length - 1]).toBeLessThan(5e-4);
  });
  it('first frame without history (teleport / reset): the upsampled fresh samples are already close', () => {
    let first = Infinity;
    simulate({ W: 48, H: 32, frames: 1, pan: 0, truth: smoothSky, onFrame: (f, out, tr) => (first = maxErr(out, tr, 48)) });
    expect(first).toBeLessThan(0.03);
    // a history reset mid-run (teleport) is the same
    let after = Infinity;
    simulate({ W: 48, H: 32, frames: 21, pan: 2.5, truth: smoothSky, invalidateAt: 20, onFrame: (f, out, tr) => f === 20 && (after = maxErr(out, tr, 48)) });
    expect(after).toBeLessThan(0.03);
  });
  it('fast yaw (7.3 px/frame): stays within a small error of the truth, including newly revealed pixels', () => {
    let worst = 0;
    simulate({ W: 64, H: 24, frames: 40, pan: 7.3, truth: smoothSky, onFrame: (f, out, tr) => f >= 4 && (worst = Math.max(worst, maxErr(out, tr, 64))) });
    expect(worst).toBeLessThan(0.05);
  });
  it('no ghost trail: an occluder crossing the screen leaves nothing behind after one cycle', () => {
    // the aircraft sweeps left→right at 3 px/frame across a sky with clouds; no cloud is in front of it
    const occ = (f: number): [number, number] | null => (f < 20 ? [10 + 3 * f, 18 + 3 * f] : null);
    let trail = 0;
    simulate({
      W: 96,
      H: 16,
      frames: 30,
      pan: 0,
      truth: smoothSky,
      occluder: occ,
      onFrame: (f, out, tr) => {
        if (f < 6) return;
        // pixels the occluder left more than 4 frames ago must be back to the sky value
        const o = occ(f);
        for (let x = 0; x < 96; x++) {
          const left4 = occ(f - 4);
          const coveredRecently = [0, 1, 2, 3, 4].some((k) => {
            const r = occ(f - k);
            return r && x >= r[0] && x < r[1];
          });
          if (coveredRecently || (o && x >= o[0] && x < o[1]) || !left4) continue;
          for (let y = 0; y < 16; y++) trail = Math.max(trail, Math.abs(out[y * 96 + x] - tr[y * 96 + x]));
        }
      },
    });
    expect(trail).toBeLessThan(0.05);
  });
  it('noise is averaged over time: steady-state error well below the per-sample noise', () => {
    const sigma = 0.1; // uniform noise in ±0.05 → std 0.029
    let sum = 0;
    let n = 0;
    simulate({
      W: 48,
      H: 32,
      frames: 64,
      pan: 0,
      noise: sigma,
      truth: () => 0.5,
      onFrame: (f, out, tr) => {
        if (f < 32) return;
        for (let i = 0; i < out.length; i++) {
          sum += (out[i] - tr[i]) ** 2;
          n++;
        }
      },
    });
    const rms = Math.sqrt(sum / n);
    expect(rms).toBeLessThan(0.7 * (sigma / Math.sqrt(12)));
  });
  it('property: output stays within the range of the values ever marched (no overshoot), for any pan and noise', () => {
    fc.assert(
      fc.property(fc.double({ min: -9, max: 9, noNaN: true }), fc.double({ min: 0, max: 0.2, noNaN: true }), (pan, noise) => {
        let lo = Infinity;
        let hi = -Infinity;
        simulate({
          W: 24,
          H: 12,
          frames: 12,
          pan,
          noise,
          truth: smoothSky,
          onFrame: (f, out) => {
            for (const v of out) {
              lo = Math.min(lo, v);
              hi = Math.max(hi, v);
            }
          },
        });
        expect(lo).toBeGreaterThanOrEqual(0.2 - noise);
        expect(hi).toBeLessThanOrEqual(0.9 + noise);
      }),
      { numRuns: 40 },
    );
  });
});
