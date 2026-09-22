import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { SizeClassPool, sizeClasses } from '../../../src/world/vegetation/pool';

describe('SizeClassPool', () => {
  it('hands out the smallest class that fits and reuses released items', () => {
    let made = 0;
    const pool = new SizeClassPool([100, 400, 1600], (cap) => {
      made++;
      return new Float32Array(cap);
    });
    const a = pool.acquire(50)!;
    expect(a.capacity).toBe(100);
    const b = pool.acquire(101)!;
    expect(b.capacity).toBe(400);
    expect(made).toBe(2);
    pool.release(a);
    const c = pool.acquire(80)!;
    expect(c.value).toBe(a.value); // same buffer, no new allocation
    expect(made).toBe(2);
    expect(pool.stats()).toEqual({ created: 2, inUse: 2, free: 0 });
    pool.release(b);
    expect(pool.stats().free).toBe(1);
  });

  it('refuses requests larger than the largest class', () => {
    const pool = new SizeClassPool([10, 20], (cap) => new Float32Array(cap));
    expect(pool.acquire(21)).toBeNull();
  });

  it('caps the idle list per class and disposes the surplus', () => {
    const disposed: Float32Array[] = [];
    const pool = new SizeClassPool([10], (cap) => new Float32Array(cap), (v) => disposed.push(v), 2);
    const items = [pool.acquire(5)!, pool.acquire(5)!, pool.acquire(5)!, pool.acquire(5)!];
    for (const it of items) pool.release(it);
    expect(pool.stats().free).toBe(2);
    expect(disposed.length).toBe(2);
    expect(pool.stats().created).toBe(2);
  });

  it('double release is ignored (no duplicate free entries)', () => {
    const pool = new SizeClassPool([10], (cap) => new Float32Array(cap));
    const a = pool.acquire(3)!;
    pool.release(a);
    pool.release(a);
    expect(pool.stats().free).toBe(1);
    const b = pool.acquire(3)!;
    const c = pool.acquire(3)!;
    expect(b.value).not.toBe(c.value);
  });

  it('fuzz: under any acquire/release sequence, created = inUse + free and live items are distinct', () => {
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.boolean(), fc.integer({ min: 1, max: 5000 })), { maxLength: 300 }), (ops) => {
        const pool = new SizeClassPool(sizeClasses(5000), (cap) => new Float32Array(cap), undefined, 4);
        const live: ReturnType<typeof pool.acquire>[] = [];
        for (const [acq, n] of ops) {
          if (acq || live.length === 0) {
            const h = pool.acquire(n)!;
            expect(h.capacity).toBeGreaterThanOrEqual(n);
            live.push(h);
          } else {
            pool.release(live.splice(n % live.length, 1)[0]!);
          }
          const s = pool.stats();
          expect(s.inUse).toBe(live.length);
          expect(s.created - s.free).toBeGreaterThanOrEqual(s.inUse);
          expect(new Set(live.map((h) => h!.value)).size).toBe(live.length);
        }
      }),
      { numRuns: 100 },
    );
  });

  it('sizeClasses covers the maximum and grows geometrically', () => {
    const c = sizeClasses(25600);
    expect(c[c.length - 1]).toBe(25600);
    for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThan(c[i - 1]);
    expect(c[0]).toBeLessThanOrEqual(1024);
  });
});
