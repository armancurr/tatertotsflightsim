/**
 * Fires, columns and storms in the pure effects simulation (src/fx/sim.ts), measured the way real
 * footage looks: a vehicle/wreck fire is a clustered VOLUME of varied flame tongues (distinct seeds,
 * sizes, shapes, tiles) that rise with buoyancy and turn into black oily smoke; smoke columns rise
 * hundreds of metres, widen with height and bend downwind; sparks/embers are streaks; any storm of
 * emitters stays inside the pools and reset leaves nothing alive.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FxSim } from '../../src/fx/sim';
import { particleAlpha, particleHeat, particleSize, type ParticlePool } from '../../src/fx/pool';
import { FLAME_TILES, SPARK_TILE, particleKind } from '../../src/fx/sprites';
import { CONFIG } from '../../src/config';

const FX = CONFIG.fx;
const DT = 1 / 60;
const run = (sim: FxSim, s: number, wx = 0, wz = 0) => {
  for (let i = 0; i < Math.round(s / DT); i++) sim.step(DT, wx, 0, wz);
};
const live = (p: ParticlePool) => {
  const out: number[] = [];
  for (let i = 0; i < p.capacity; i++) if (p.alive[i]) out.push(i);
  return out;
};
const visible = (p: ParticlePool) => live(p).filter((i) => particleAlpha(p, i) > 0.01);
const flames = (sim: FxSim) => visible(sim.fire).filter((i) => particleHeat(sim.fire, i) > 0.3 && sim.fire.gravity[i] === 0 && sim.fire.tile[i] !== SPARK_TILE);
const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / Math.max(1, a.length);
const cv = (a: number[]) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((v) => (v - m) ** 2))) / m;
};
/** Pearson correlation. */
const corr = (a: number[], b: number[]) => {
  const ma = mean(a), mb = mean(b);
  let s = 0, sa = 0, sb = 0;
  for (let i = 0; i < a.length; i++) {
    s += (a[i] - ma) * (b[i] - mb);
    sa += (a[i] - ma) ** 2;
    sb += (b[i] - mb) ** 2;
  }
  return s / Math.sqrt(sa * sb);
};

describe('a wreck fire is a volume of varied flames, not stamped icons', () => {
  const sim = new FxSim(21);
  sim.addFire(0, 1.2, 0, 0, 1, 60, 2.5, true);
  run(sim, 4);
  const f = flames(sim);
  it('many overlapping flames at once, of clearly different sizes and shapes', () => {
    expect(f.length).toBeGreaterThan(14);
    const sizes = f.map((i) => particleSize(sim.fire, i));
    expect(cv(sizes)).toBeGreaterThan(0.2);
    const aspects = f.map((i) => sim.fire.aspect[i]);
    expect(Math.min(...aspects)).toBeLessThan(0.7); // tall narrow tongues…
    expect(Math.max(...aspects)).toBeGreaterThan(0.85); // …and broad bodies / billows
    const tiles = new Set(f.map((i) => sim.fire.tile[i]).filter((t) => particleKind(t) === 'flame'));
    expect(tiles.size).toBeGreaterThanOrEqual(3);
    expect(new Set(f.map((i) => sim.fire.seed[i])).size).toBe(f.length); // every flame its own seed
  });
  it('flames stay small and short-lived (licks, not tall icons) and within the fire radius', () => {
    for (const i of f) {
      expect(particleSize(sim.fire, i)).toBeLessThan(4.5);
      expect(sim.fire.life[i]).toBeLessThan(1.6);
      expect(Math.hypot(sim.fire.px[i], sim.fire.pz[i])).toBeLessThan(2.5 + 4);
    }
  });
  it('the fire has a body: the flames overlap into a cluster ~2–4 × the radius tall', () => {
    const top = Math.max(...f.map((i) => sim.fire.py[i] + particleSize(sim.fire, i) / 2));
    expect(top).toBeGreaterThan(2.5);
    expect(top).toBeLessThan(14);
  });
  it('buoyancy: flames rise and older flames are higher', () => {
    expect(mean(f.map((i) => sim.fire.vy[i]))).toBeGreaterThan(0.5);
    const tongues = f.filter((i) => particleKind(sim.fire.tile[i]) === 'flame');
    expect(corr(tongues.map((i) => sim.fire.age[i]), tongues.map((i) => sim.fire.py[i]))).toBeGreaterThan(0.2);
  });
  it('the flames turn into black oily smoke that rises above them', () => {
    const smoke = visible(sim.smoke);
    expect(smoke.length).toBeGreaterThan(8);
    for (const i of smoke) expect((sim.smoke.r[i] + sim.smoke.g[i] + sim.smoke.b[i]) / 3).toBeLessThan(0.1);
    expect(mean(smoke.map((i) => sim.smoke.py[i]))).toBeGreaterThan(4);
  });
  it('a bigger, hotter fire has taller flames than a small one', () => {
    const small = new FxSim(4), big = new FxSim(4);
    small.addFire(0, 0.5, 0, 0, 0.4, 60, 0.8, true);
    big.addFire(0, 1.5, 0, 0, 1.2, 60, 3, true);
    run(small, 3);
    run(big, 3);
    const top = (s: FxSim) => Math.max(...flames(s).map((i) => s.fire.py[i] + particleSize(s.fire, i) / 2));
    expect(top(big)).toBeGreaterThan(top(small) * 1.5);
  });
});

describe('smoke', () => {
  it('fuel/vehicle smoke is black; dust and tyre smoke are light', () => {
    const sim = new FxSim(3);
    sim.addColumn(0, 0, 0, 0, 1, 30);
    sim.shockRing(100, 0, 0, 1, 'dirt');
    run(sim, 1);
    const s = visible(sim.smoke);
    const col = s.filter((i) => Math.hypot(sim.smoke.px[i], sim.smoke.pz[i]) < 20);
    const dust = s.filter((i) => Math.hypot(sim.smoke.px[i] - 100, sim.smoke.pz[i]) < 60);
    expect(col.length).toBeGreaterThan(5);
    expect(dust.length).toBeGreaterThan(5);
    expect(Math.max(...col.map((i) => sim.smoke.r[i]))).toBeLessThan(0.1);
    expect(Math.min(...dust.map((i) => sim.smoke.r[i]))).toBeGreaterThan(0.25);
  });
  it('a smoke column rises hundreds of metres, widens with height and bends downwind (readable from 5 km)', () => {
    const sim = new FxSim(9);
    sim.addColumn(0, 0, 0, 0, 1, 120);
    run(sim, 45, 5, 0);
    const s = visible(sim.smoke);
    const ys = s.map((i) => sim.smoke.py[i]);
    const top = Math.max(...ys);
    expect(top).toBeGreaterThan(180);
    // puffs grow with height (the plume spreads)
    expect(corr(ys, s.map((i) => particleSize(sim.smoke, i)))).toBeGreaterThan(0.5);
    const high = s.filter((i) => sim.smoke.py[i] > top * 0.6);
    expect(mean(high.map((i) => particleSize(sim.smoke, i)))).toBeGreaterThan(22);
    // …and are carried downwind
    expect(mean(high.map((i) => sim.smoke.px[i]))).toBeGreaterThan(60);
    // at 5 km a pixel is ~6 m: the plume is tens of pixels tall and several wide
    expect(top / 6).toBeGreaterThan(30);
  });
  it('columns disperse after their duration (plus one puff lifetime)', () => {
    const sim = new FxSim(9);
    sim.addColumn(0, 0, 0, 0, 1, 10);
    run(sim, 10 + FX.crash.smokeLife[1] + 1);
    expect(visible(sim.smoke)).toHaveLength(0);
    expect(sim.activeEmitters()).toBe(0);
  });
});

describe('sparks, embers, burning debris', () => {
  it('sparks and embers are procedural streaks (spark tile), with a velocity to streak along', () => {
    const sim = new FxSim(2);
    sim.sparks(0, 5, 0, 0, 5, 0, 40);
    sim.explosion(50, 1, 0, 0, 1);
    run(sim, 0.1);
    const sp = live(sim.fire).filter((i) => sim.fire.tile[i] === SPARK_TILE);
    expect(sp.length).toBeGreaterThan(40);
    for (const i of sp) expect(Math.hypot(sim.fire.vx[i], sim.fire.vy[i], sim.fire.vz[i])).toBeGreaterThan(0.5);
  });
  it('burning fragments carry varied little flames (not one repeated icon)', () => {
    const sim = new FxSim(12);
    for (let k = 0; k < 6; k++) sim.fragments(k * 3, 2, 0, 0, 5, 3, 0, 1, true);
    run(sim, 1.5);
    const f = flames(sim).filter((i) => particleKind(sim.fire.tile[i]) === 'flame');
    expect(f.length).toBeGreaterThan(8);
    expect(new Set(f.map((i) => sim.fire.tile[i])).size).toBeGreaterThanOrEqual(3);
    expect(cv(f.map((i) => sim.fire.aspect[i]))).toBeGreaterThan(0.08);
    expect(cv(f.map((i) => particleSize(sim.fire, i)))).toBeGreaterThan(0.12);
  });
  it('explosions throw embers too', () => {
    const sim = new FxSim(2);
    sim.explosion(0, 1, 0, 0, 1);
    run(sim, 0.3);
    const embers = live(sim.fire).filter((i) => sim.fire.tile[i] === SPARK_TILE && sim.fire.gravity[i] > 0 && sim.fire.gravity[i] < 9);
    expect(embers.length).toBeGreaterThan(5);
  });
});

describe('fire glow on the smoke', () => {
  it('every fire lights its own smoke (not only the biggest one)', () => {
    const sim = new FxSim(5);
    sim.addFire(0, 1, 0, 0, 1, 60, 2, true);
    sim.addFire(300, 1, 0, 0, 0.6, 60, 1.5, true);
    run(sim, 2);
    expect(sim.glowAt(0, 4, 0)).toBeGreaterThan(0.3);
    expect(sim.glowAt(300, 4, 0)).toBeGreaterThan(0.2);
    expect(sim.glowAt(150, 4, 0)).toBeLessThan(0.05);
  });
});

describe('determinism', () => {
  it('the same seed gives the same fire, particle for particle; another seed differs', () => {
    const go = (seed: number) => {
      const sim = new FxSim(seed);
      sim.addFire(0, 1, 0, 0, 1, 60, 2, true);
      sim.addColumn(0, 0, 0, 0, 1, 60);
      sim.explosion(10, 1, 0, 0, 1);
      run(sim, 2, 3, 1);
      return [Array.from(sim.fire.px), Array.from(sim.fire.seed), Array.from(sim.smoke.py), Array.from(sim.fire.aspect)];
    };
    expect(go(33)).toEqual(go(33));
    expect(go(33)).not.toEqual(go(34));
  });
});

describe('fuzz: random emitter storms', () => {
  const pos = fc.double({ min: -2000, max: 2000, noNaN: true });
  const small = fc.double({ min: -5, max: 5, noNaN: true });
  const amt = fc.double({ min: 0, max: 3, noNaN: true });
  const call = fc.oneof(
    fc.record({ k: fc.constant('fire' as const), x: pos, z: pos, i: amt, d: fc.double({ min: 0, max: 200, noNaN: true }), r: fc.double({ min: 0, max: 30, noNaN: true }), smoky: fc.boolean() }),
    fc.record({ k: fc.constant('column' as const), x: pos, z: pos, i: amt, d: fc.double({ min: 0, max: 700, noNaN: true }) }),
    fc.record({ k: fc.constant('explosion' as const), x: pos, z: pos, s: amt }),
    fc.record({ k: fc.constant('fireball' as const), x: pos, z: pos, v: small, i: amt }),
    fc.record({ k: fc.constant('sparks' as const), x: pos, z: pos, n: fc.integer({ min: 0, max: 400 }) }),
    fc.record({ k: fc.constant('flash' as const), x: pos, s: amt }),
    fc.record({ k: fc.constant('fragments' as const), x: pos, v: small, burning: fc.boolean() }),
    fc.record({ k: fc.constant('ring' as const), x: pos, i: amt }),
    fc.record({ k: fc.constant('move' as const), h: fc.integer({ min: -2, max: 5000 }), x: pos }),
    fc.record({ k: fc.constant('quench' as const), h: fc.integer({ min: -2, max: 5000 }) }),
    fc.record({ k: fc.constant('step' as const), dt: fc.double({ min: 0, max: 0.5, noNaN: true }), w: small }),
  );
  it('pools never overflow, nothing goes NaN, and reset leaves nothing alive', () => {
    fc.assert(
      fc.property(fc.array(call, { maxLength: 60 }), fc.integer({ min: 0, max: 1e6 }), (calls, seed) => {
        const sim = new FxSim(seed);
        const handles: number[] = [];
        for (const c of calls) {
          switch (c.k) {
            case 'fire': handles.push(sim.addFire(c.x, 2, c.z, 0, c.i, c.d, c.r, c.smoky)); break;
            case 'column': handles.push(sim.addColumn(c.x, 0, c.z, 0, c.i, c.d)); break;
            case 'explosion': sim.explosion(c.x, 1, c.z, 0, c.s); break;
            case 'fireball': sim.fireball(c.x, 2, c.z, 0, c.v * 20, c.v, c.v * 10, c.i); break;
            case 'sparks': sim.sparks(c.x, 1, c.z, 0, 3, 0, c.n); break;
            case 'flash': sim.flash(c.x, 3, 0, c.s); break;
            case 'fragments': sim.fragments(c.x, 2, 0, 0, c.v * 10, c.v, 0, 1, c.burning); break;
            case 'ring': sim.shockRing(c.x, 0, 0, c.i, 'dirt'); break;
            case 'move': sim.moveFire(handles.length ? handles[c.h % handles.length] : c.h, c.x, 2, 0, 0); break;
            case 'quench': sim.quench(handles.length ? handles[c.h % handles.length] : c.h); break;
            default: sim.step(c.dt, c.w, 0, c.w);
          }
          for (const p of [sim.smoke, sim.fire, sim.debris]) {
            expect(p.count).toBeLessThanOrEqual(p.capacity);
            expect(p.count).toBeGreaterThanOrEqual(0);
          }
        }
        sim.step(0.2, 3, 0, 1);
        for (const p of [sim.smoke, sim.fire, sim.debris]) {
          let n = 0;
          for (let i = 0; i < p.capacity; i++) {
            if (!p.alive[i]) continue;
            n++;
            expect(Number.isFinite(p.px[i] + p.py[i] + p.pz[i] + p.vx[i] + p.vy[i] + p.vz[i])).toBe(true);
            expect(Number.isFinite(particleSize(p, i) + particleAlpha(p, i) + particleHeat(p, i))).toBe(true);
            expect(p.aspect[i]).toBeGreaterThan(0);
            expect(sim.glowAt(p.px[i], p.py[i], p.pz[i])).toBeGreaterThanOrEqual(0);
          }
          expect(n).toBe(p.count);
        }
        expect(sim.activeEmitters()).toBeLessThanOrEqual(FX.maxEmitters);
        expect(Number.isFinite(sim.fireLevel + sim.flashLevel)).toBe(true);
        sim.reset();
        for (const p of [sim.smoke, sim.fire, sim.debris]) {
          expect(p.count).toBe(0);
          expect(Array.from(p.alive).every((a) => a === 0)).toBe(true);
        }
        expect(sim.activeEmitters()).toBe(0);
        expect(sim.fireLevel).toBe(0);
        expect(sim.flashLevel).toBe(0);
        sim.step(0.5, 0, 0, 0);
        expect(sim.smoke.count + sim.fire.count + sim.debris.count).toBe(0);
        expect(sim.glowAt(0, 0, 0)).toBe(0);
      }),
      { numRuns: 120 },
    );
  });
});

it('flame tiles exist for the tongues', () => {
  expect(FLAME_TILES.length).toBeGreaterThanOrEqual(4);
});
