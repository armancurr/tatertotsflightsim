import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { ParticlePool, particleAlpha, particleSize, particleHeat, newParticleInit, type ParticleInit } from '../../src/fx/pool';
import { sortBackToFront, createSortScratch } from '../../src/fx/sort';

function init(p: Partial<ParticleInit> = {}): ParticleInit {
  return Object.assign(newParticleInit(), { life: 5, size0: 1, size1: 2 }, p);
}

describe('ParticlePool', () => {
  it('spawns distinct slots up to capacity and counts them', () => {
    const pool = new ParticlePool(8);
    const seen = new Set<number>();
    for (let i = 0; i < 8; i++) seen.add(pool.emit(init()));
    expect(seen.size).toBe(8);
    expect(pool.count).toBe(8);
  });
  it('never exceeds capacity: when full it recycles the OLDEST particle', () => {
    const pool = new ParticlePool(4);
    const ids = [0, 1, 2, 3].map((k) => pool.emit(init({ x: k })));
    pool.step(0.1, 0, 0, 0);
    const again = pool.emit(init({ x: 99 }));
    expect(again).toBe(ids[0]);
    expect(pool.count).toBe(4);
    expect(pool.px[again]).toBe(99);
    expect(pool.age[again]).toBe(0);
    const next = pool.emit(init({ x: 100 }));
    expect(next).toBe(ids[1]);
  });
  it('reuses freed slots before recycling live ones', () => {
    const pool = new ParticlePool(3);
    const a = pool.emit(init());
    const b = pool.emit(init());
    pool.emit(init());
    pool.kill(b);
    expect(pool.count).toBe(2);
    expect(pool.emit(init())).toBe(b);
    expect(pool.alive[a]).toBe(1);
  });
  it('kills particles when their life runs out', () => {
    const pool = new ParticlePool(4);
    const i = pool.emit(init({ life: 0.5 }));
    pool.step(0.3, 0, 0, 0);
    expect(pool.alive[i]).toBe(1);
    pool.step(0.3, 0, 0, 0);
    expect(pool.alive[i]).toBe(0);
    expect(pool.count).toBe(0);
  });
  it('integrates: velocity relaxes to the wind, buoyancy lifts, gravity drops, gas stays above ground', () => {
    const pool = new ParticlePool(4);
    const smoke = pool.emit(init({ y: 10, drag: 1, buoyancy: 3, buoyTau: 100, groundY: 0, life: 50 }));
    const rock = pool.emit(init({ y: 10, vy: 0, gravity: 9.81, bounce: 0.3, groundY: 0, life: 50 }));
    const gas = pool.emit(init({ y: 0.5, vy: -5, groundY: 0, life: 50 }));
    for (let k = 0; k < 600; k++) pool.step(1 / 60, 5, 0, 0);
    expect(pool.vx[smoke]).toBeCloseTo(5, 1);
    expect(pool.py[smoke]).toBeGreaterThan(20);
    expect(pool.py[rock]).toBeLessThan(1);
    expect(pool.py[rock]).toBeGreaterThanOrEqual(0);
    expect(pool.py[gas]).toBeGreaterThanOrEqual(0);
  });
  it('solid debris bounces, then comes to rest on the ground', () => {
    const pool = new ParticlePool(1);
    const d = pool.emit(init({ y: 5, vx: 10, gravity: 9.81, bounce: 0.35, friction: 2, groundY: 1, life: 100, rotRate: 5 }));
    for (let k = 0; k < 60 * 10; k++) pool.step(1 / 60, 0, 0, 0);
    expect(pool.py[d]).toBeGreaterThanOrEqual(1);
    expect(pool.py[d]).toBeLessThan(1.2);
    expect(Math.hypot(pool.vx[d], pool.vy[d], pool.vz[d])).toBeLessThan(0.05);
    expect(pool.rotRate[d]).toBe(0);
  });
  it('dt 0 / NaN / negative change nothing', () => {
    const pool = new ParticlePool(2);
    const i = pool.emit(init({ vx: 3 }));
    for (const dt of [0, Number.NaN, -1]) pool.step(dt, 1, 1, 1);
    expect(pool.px[i]).toBe(0);
    expect(pool.age[i]).toBe(0);
  });
  it('sanitises garbage spawn parameters', () => {
    const pool = new ParticlePool(2);
    const i = pool.emit(init({ x: Number.NaN, vy: Infinity, life: Number.NaN, size1: -3 }));
    pool.step(0.1, 0, 0, 0);
    for (const arr of [pool.px, pool.py, pool.pz, pool.vx, pool.vy, pool.vz]) expect(Number.isFinite(arr[i])).toBe(true);
    expect(particleSize(pool, i)).toBeGreaterThanOrEqual(0);
  });
  it('shape: aspect (width/height) defaults to 1 and is clamped to 0.1..10 (garbage → 1)', () => {
    const pool = new ParticlePool(4);
    expect(pool.aspect[pool.emit(init())]).toBe(1);
    expect(pool.aspect[pool.emit(init({ aspect: 0.55 }))]).toBeCloseTo(0.55, 6);
    expect(pool.aspect[pool.emit(init({ aspect: 0 }))]).toBeCloseTo(0.1, 6);
    expect(pool.aspect[pool.emit(init({ aspect: Number.NaN }))]).toBe(1);
  });
  it('clear() empties the pool', () => {
    const pool = new ParticlePool(5);
    for (let k = 0; k < 5; k++) pool.emit(init());
    pool.clear();
    expect(pool.count).toBe(0);
    expect(Array.from(pool.alive).every((a) => a === 0)).toBe(true);
    for (let k = 0; k < 5; k++) pool.emit(init());
    expect(pool.count).toBe(5);
  });
});

describe('visual curves', () => {
  it('alpha fades in after visibleAt and out at the end of life', () => {
    const pool = new ParticlePool(1);
    const i = pool.emit(init({ life: 10, alpha: 0.8, fadeIn: 1, fadeOut: 0.3, visibleAt: 0.5 }));
    expect(particleAlpha(pool, i)).toBe(0); // not visible yet
    pool.step(1, 0, 0, 0);
    expect(particleAlpha(pool, i)).toBeCloseTo(0.4, 2);
    pool.step(3, 0, 0, 0);
    expect(particleAlpha(pool, i)).toBeCloseTo(0.8, 6);
    pool.step(5.9, 0, 0, 0);
    expect(particleAlpha(pool, i)).toBeLessThan(0.05);
  });
  it('size grows from size0 toward size1; heat cools', () => {
    const pool = new ParticlePool(1);
    const i = pool.emit(init({ life: 10, size0: 2, size1: 20, growTau: 2, heat: 1, heatTau: 0.5 }));
    expect(particleSize(pool, i)).toBeCloseTo(2, 6);
    pool.step(2, 0, 0, 0);
    const mid = particleSize(pool, i);
    expect(mid).toBeGreaterThan(10);
    expect(mid).toBeLessThan(20);
    expect(particleHeat(pool, i)).toBeLessThan(0.05);
  });
});

describe('fuzz: pool invariants under random operation sequences', () => {
  const wild = fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity, 0, 1e30));
  const op = fc.oneof(
    fc.record({ k: fc.constant('emit' as const), x: wild, v: wild, life: wild, size: wild, g: wild, b: wild }),
    fc.record({ k: fc.constant('kill' as const), i: fc.nat(40) }),
    fc.record({ k: fc.constant('step' as const), dt: wild, w: wild }),
    fc.record({ k: fc.constant('clear' as const) }),
  );
  it('count ≤ capacity, count = alive flags, alive particles finite and within life', () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 24 }), fc.array(op, { maxLength: 120 }), (cap, ops) => {
      const pool = new ParticlePool(cap);
      for (const o of ops) {
        if (o.k === 'emit') pool.emit(init({ x: o.x, vx: o.v, vy: o.v, life: o.life, size0: o.size, size1: o.size, gravity: o.g, bounce: o.b, buoyancy: o.v, drag: o.g, turbulence: o.x }));
        else if (o.k === 'kill') pool.kill(o.i);
        else if (o.k === 'step') pool.step(o.dt, o.w, o.w, o.w);
        else pool.clear();
        expect(pool.count).toBeLessThanOrEqual(cap);
        let alive = 0;
        for (let i = 0; i < cap; i++) {
          if (!pool.alive[i]) continue;
          alive++;
          for (const arr of [pool.px, pool.py, pool.pz, pool.vx, pool.vy, pool.vz, pool.age, pool.rot]) expect(Number.isFinite(arr[i])).toBe(true);
          expect(pool.age[i]).toBeLessThan(pool.life[i]);
          const a = particleAlpha(pool, i);
          const s = particleSize(pool, i);
          const h = particleHeat(pool, i);
          expect(Number.isFinite(a) && a >= 0 && a <= 1).toBe(true);
          expect(Number.isFinite(s) && s >= 0).toBe(true);
          expect(Number.isFinite(h) && h >= 0).toBe(true);
        }
        expect(alive).toBe(pool.count);
      }
    }));
  });
});

describe('sortBackToFront', () => {
  it('orders far to near', () => {
    const depth = Float32Array.from([5, 50, 1, 20, 7]);
    const order = new Int32Array(5);
    sortBackToFront(depth, 5, order, createSortScratch(5));
    expect(Array.from(order)).toEqual([1, 3, 4, 0, 2]);
  });
  it('handles 0 and 1 elements and equal depths', () => {
    const s = createSortScratch(4);
    const o = new Int32Array(4);
    sortBackToFront(new Float32Array(4), 0, o, s);
    sortBackToFront(Float32Array.from([3]), 1, o, s);
    expect(o[0]).toBe(0);
    sortBackToFront(Float32Array.from([2, 2, 2, 2]), 4, o, s);
    expect(new Set(o).size).toBe(4);
  });
  it('fuzz: output is a permutation in non-increasing depth (to bucket precision)', () => {
    fc.assert(fc.property(fc.array(fc.float({ min: -1e4, max: 1e4, noNaN: true }), { minLength: 1, maxLength: 300 }), (arr) => {
      const n = arr.length;
      const depth = Float32Array.from(arr);
      const order = new Int32Array(n);
      const scratch = createSortScratch(n);
      sortBackToFront(depth, n, order, scratch);
      expect(new Set(order).size).toBe(n);
      for (const i of order) expect(i >= 0 && i < n).toBe(true);
      const min = Math.min(...arr);
      const max = Math.max(...arr);
      const tol = (max - min) / scratch.buckets + 1e-6;
      for (let k = 0; k + 1 < n; k++) expect(depth[order[k]]).toBeGreaterThanOrEqual(depth[order[k + 1]] - tol);
    }));
  });
});
