/**
 * The naval guns' effects (src/combat/navalFx.ts, pure): a 16-inch splash throws a column of water
 * 60–100 m high that collapses in seconds and leaves drifting mist and a foam ring; the muzzle blast
 * makes an incandescent flash, a lingering smoke cloud and a pressure ring on the water beside the
 * ship; bursts; the camera shake arrives at the speed of sound; the pool recycles and never NaNs.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { NavalFxSim, PK, RING } from '../../src/combat/navalFx';

const run = (fx: NavalFxSim, s: number, dt = 1 / 30) => {
  for (let t = 0; t < s - 1e-9; t += dt) fx.step(dt);
};
const maxY = (fx: NavalFxSim, kind: number) => {
  let m = -Infinity;
  for (let i = 0; i < fx.cap; i++) if (fx.alive[i] && fx.kind[i] === kind) m = Math.max(m, fx.py[i]);
  return m;
};
const count = (fx: NavalFxSim, kind: number) => {
  let n = 0;
  for (let i = 0; i < fx.cap; i++) if (fx.alive[i] && fx.kind[i] === kind) n++;
  return n;
};

describe('water column', () => {
  it('rises to 60–110 m within ~4 s, then collapses; mist lingers; a foam ring spreads to ~55 m and fades', () => {
    const fx = new NavalFxSim({ seed: 3 });
    fx.waterColumn(0, 0, 0, 1);
    expect(fx.columns).toBe(1);
    let top = 0;
    let tTop = 0;
    for (let t = 0; t < 6; t += 1 / 30) {
      fx.step(1 / 30);
      const y = maxY(fx, PK.spray);
      if (y > top) {
        top = y;
        tTop = t;
      }
    }
    expect(top).toBeGreaterThan(60);
    expect(top).toBeLessThan(115);
    expect(tTop).toBeGreaterThan(2);
    expect(tTop).toBeLessThan(5.5);
    run(fx, 6);
    expect(count(fx, PK.spray)).toBe(0); // the water has fallen back
    expect(count(fx, PK.mist)).toBeGreaterThan(0);
    expect(fx.ringCount).toBe(1);
    let r = -1;
    for (let i = 0; i < fx.ringCap; i++) if (fx.ringAlive[i] && fx.ringKind[i] === RING.foam) r = fx.ringRadius(i);
    expect(r).toBeGreaterThan(45);
    expect(r).toBeLessThan(60);
    run(fx, 45);
    expect(fx.ringCount).toBe(0);
  });

  it('nothing falls below the sea surface', () => {
    const fx = new NavalFxSim({ seed: 9 });
    fx.waterColumn(10, 0, -20, 1.4);
    for (let t = 0; t < 12; t += 1 / 20) {
      fx.step(1 / 20);
      for (let i = 0; i < fx.cap; i++) if (fx.alive[i]) expect(fx.py[i]).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('muzzle blast', () => {
  it('flash (emissive, gone in half a second), smoke that hangs for tens of seconds, a dark pressure ring on the water', () => {
    const fx = new NavalFxSim({ seed: 5 });
    fx.muzzleBlast(0, 14, 0, 1, 0.1, 0, 5, 0, 0, 1, 0);
    expect(fx.blasts).toBe(1);
    let emit = 0;
    for (let i = 0; i < fx.cap; i++) if (fx.alive[i]) emit = Math.max(emit, fx.emitOf(i));
    expect(emit).toBeGreaterThan(0.9);
    expect(count(fx, PK.flash)).toBeGreaterThan(4);
    let pressure = -1;
    for (let i = 0; i < fx.ringCap; i++) if (fx.ringAlive[i] && fx.ringKind[i] === RING.pressure) pressure = i;
    expect(pressure).toBeGreaterThanOrEqual(0);
    // the ring sits out along the line of fire (starboard, +x here), racing outward
    expect(fx.ringX[pressure]).toBeGreaterThan(5);
    run(fx, 0.7);
    expect(count(fx, PK.flash)).toBe(0);
    expect(fx.ringRadius(pressure)).toBeGreaterThan(100);
    run(fx, 2);
    expect(fx.ringCount).toBe(0);
    run(fx, 10);
    expect(count(fx, PK.smoke)).toBeGreaterThan(10);
    // the smoke rolled out along the line of fire
    let mx = 0;
    let n = 0;
    for (let i = 0; i < fx.cap; i++) if (fx.alive[i] && fx.kind[i] === PK.smoke) ((mx += fx.px[i]), n++);
    expect(mx / n).toBeGreaterThan(30);
  });

  it('a gun high above the sea makes no pressure ring', () => {
    const fx = new NavalFxSim();
    fx.muzzleBlast(0, 200, 0, 0, 0.2, -1);
    expect(fx.ringCount).toBe(0);
  });
});

describe('shake and bookkeeping', () => {
  it('a blast is felt d / 343 s later, fades within seconds, and is weaker far away', () => {
    const fx = new NavalFxSim();
    fx.muzzleBlast(0, 10, 0, 0, 0, -1);
    expect(fx.shakeAt(0, 10, 30)).toBe(0); // the pressure wave is still on its way (30 m: 0.09 s)
    run(fx, 0.12, 1 / 60);
    expect(fx.shakeAt(0, 10, 30)).toBeGreaterThan(0.5);
    expect(fx.shakeAt(686, 10, 0)).toBe(0); // 2 s away
    run(fx, 2.05, 1 / 60);
    const far = fx.shakeAt(686, 10, 0);
    expect(far).toBeGreaterThan(0);
    expect(far).toBeLessThan(0.3);
    run(fx, 4);
    expect(fx.shakeAt(0, 10, 30)).toBe(0);
  });

  it('burst: flash + black smoke, and a small column when on the water', () => {
    const fx = new NavalFxSim();
    fx.burst(0, 2, 0, true);
    expect(fx.columns).toBe(1);
    expect(count(fx, PK.smoke)).toBeGreaterThan(5);
    const g = new NavalFxSim();
    g.burst(0, 30, 0, false);
    expect(g.columns).toBe(0);
  });

  it('a full pool recycles the oldest particles; reset clears everything', () => {
    const fx = new NavalFxSim({ particles: 200, rings: 4 });
    for (let k = 0; k < 10; k++) fx.waterColumn(k * 100, 0, 0);
    expect(fx.count).toBe(200);
    expect(fx.ringCount).toBe(4);
    fx.reset();
    expect(fx.count).toBe(0);
    expect(fx.ringCount).toBe(0);
  });

  it('fuzz: any positions, directions, scales and steps never produce NaN', () => {
    fc.assert(fc.property(
      fc.array(fc.record({ k: fc.integer({ min: 0, max: 2 }), x: fc.double(), y: fc.double(), z: fc.double(), d: fc.double(), s: fc.double(), dt: fc.double() }), { maxLength: 12 }),
      (ops) => {
        const fx = new NavalFxSim({ particles: 400 });
        for (const o of ops) {
          if (o.k === 0) fx.waterColumn(o.x, o.y, o.z, o.s);
          else if (o.k === 1) fx.muzzleBlast(o.x, o.y, o.z, o.d, o.s, o.dt, 0, 0, 0, o.s);
          else fx.burst(o.x, o.y, o.z, o.s > 0, o.s);
          fx.step(o.dt, o.d, o.s);
        }
        for (let i = 0; i < fx.cap; i++) {
          if (!fx.alive[i]) continue;
          expect(Number.isFinite(fx.px[i] + fx.py[i] + fx.pz[i] + fx.sizeOf(i) + fx.alphaOf(i) + fx.emitOf(i))).toBe(true);
        }
        expect(Number.isFinite(fx.shakeAt(0, 0, 0))).toBe(true);
      },
    ), { numRuns: 80 });
  });
});
