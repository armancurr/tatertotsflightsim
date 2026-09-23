/**
 * The crash director's effect recipes in the pure effects simulation (src/fx/sim.ts): the white-hot
 * flash, a rolling fireball, secondary fuel explosions, a shockwave dust ring, sparks, water
 * splashes, ploughing dust, fires that follow burning parts, and the lingering smoke column.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FxSim } from '../../src/fx/sim';
import { particleAlpha, particleHeat, particleSize, type ParticlePool } from '../../src/fx/pool';
import { CONFIG } from '../../src/config';

const DT = 1 / 60;
const run = (sim: FxSim, s: number) => {
  for (let i = 0; i < Math.round(s / DT); i++) sim.step(DT, 0, 0, 0);
};
const alive = (p: ParticlePool) => {
  const out: number[] = [];
  for (let i = 0; i < p.capacity; i++) if (p.alive[i]) out.push(i);
  return out;
};
const visible = (p: ParticlePool) => alive(p).filter((i) => particleAlpha(p, i) > 0.01);

describe('flash', () => {
  it('a white-hot flash: huge sprites hotter than any fireball flame and a light pulse that is gone within half a second', () => {
    const sim = new FxSim(5);
    sim.flash(0, 32, 0, 1);
    run(sim, 0.05);
    expect(sim.flashLevel).toBeGreaterThan(0.5);
    const hot = visible(sim.fire).filter((i) => particleHeat(sim.fire, i) > 1.05);
    expect(hot.length).toBeGreaterThan(0);
    expect(Math.max(...hot.map((i) => particleSize(sim.fire, i)))).toBeGreaterThan(8);
    run(sim, 0.5);
    expect(sim.flashLevel).toBeLessThan(0.1);
    expect(visible(sim.fire).filter((i) => particleHeat(sim.fire, i) > 1.05)).toHaveLength(0);
  });
});

describe('fireball and secondary explosions', () => {
  it('the fireball expands to tens of metres, burns for over a second, rolls into black smoke', () => {
    const sim = new FxSim(7);
    sim.fireball(0, 32, 0, 30, 0, -5, -40, 1);
    run(sim, 0.8);
    const fire = visible(sim.fire).filter((i) => particleHeat(sim.fire, i) > 0.35);
    expect(fire.length).toBeGreaterThan(30);
    for (const i of fire) expect(particleHeat(sim.fire, i)).toBeLessThan(1.05); // orange flame, not white-hot
    let minX = Infinity, maxX = -Infinity;
    for (const i of fire) {
      minX = Math.min(minX, sim.fire.px[i] - particleSize(sim.fire, i) / 2);
      maxX = Math.max(maxX, sim.fire.px[i] + particleSize(sim.fire, i) / 2);
    }
    expect(maxX - minX).toBeGreaterThan(20);
    run(sim, 3);
    const smoke = visible(sim.smoke);
    expect(smoke.length).toBeGreaterThan(40);
    const dark = smoke.filter((i) => (sim.smoke.r[i] + sim.smoke.g[i] + sim.smoke.b[i]) / 3 < 0.15);
    expect(dark.length / smoke.length).toBeGreaterThan(0.6);
    // the black mushroom rises
    const meanY = smoke.reduce((s, i) => s + sim.smoke.py[i], 0) / smoke.length;
    expect(meanY).toBeGreaterThan(40);
  });
  it('a secondary explosion is a smaller fireball with its own flash', () => {
    const big = new FxSim(3);
    const small = new FxSim(3);
    big.fireball(0, 32, 0, 30, 0, 0, 0, 1);
    small.explosion(0, 31, 0, 30, 0.5);
    run(big, 0.3);
    run(small, 0.3);
    expect(small.flashLevel).toBeGreaterThan(0);
    const n = visible(small.fire).filter((i) => particleHeat(small.fire, i) > 0.4).length;
    expect(n).toBeGreaterThan(5);
    expect(n).toBeLessThan(visible(big.fire).length);
  });
});

describe('shockwave, sparks, splash, dust', () => {
  it('the shockwave dust ring races outward low over the ground', () => {
    const sim = new FxSim(9);
    sim.shockRing(100, 30, -50, 1, 'field');
    run(sim, 0.4);
    const ring = visible(sim.smoke);
    expect(ring.length).toBeGreaterThan(20);
    const r = ring.map((i) => Math.hypot(sim.smoke.px[i] - 100, sim.smoke.pz[i] + 50));
    const mean = r.reduce((s, v) => s + v, 0) / r.length;
    expect(mean).toBeGreaterThan(7);
    for (const i of ring) expect(sim.smoke.py[i]).toBeLessThan(30 + 4);
    // isotropic: the ring's centre stays at the impact
    const cx = ring.reduce((s, i) => s + sim.smoke.px[i], 0) / ring.length;
    expect(Math.abs(cx - 100)).toBeLessThan(mean * 0.3);
  });
  it('sparks are tiny, fast, hot and fall', () => {
    const sim = new FxSim(2);
    sim.sparks(0, 31, 0, 0, 0, -30, 40);
    run(sim, 0.1);
    const sp = visible(sim.fire);
    expect(sp.length).toBeGreaterThan(20);
    for (const i of sp) {
      expect(particleSize(sim.fire, i)).toBeLessThan(0.5);
      expect(particleHeat(sim.fire, i)).toBeGreaterThan(0.5);
    }
    const vy0 = sp.reduce((s, i) => s + sim.fire.vy[i], 0) / sp.length;
    run(sim, 0.3);
    const sp2 = visible(sim.fire);
    const vy1 = sp2.reduce((s, i) => s + sim.fire.vy[i], 0) / Math.max(1, sp2.length);
    expect(vy1).toBeLessThan(vy0);
  });
  it('a water splash throws a white column up', () => {
    const sim = new FxSim(4);
    sim.splash(0, 0, 0, 1);
    run(sim, 0.5);
    const s = visible(sim.smoke);
    expect(s.length).toBeGreaterThan(15);
    expect(Math.max(...s.map((i) => sim.smoke.py[i]))).toBeGreaterThan(5);
    for (const i of s) expect((sim.smoke.r[i] + sim.smoke.g[i] + sim.smoke.b[i]) / 3).toBeGreaterThan(0.6);
  });
  it('ploughing dust: a sliding wreck throws dust in proportion to its speed', () => {
    const fast = new FxSim(6);
    const still = new FxSim(6);
    for (let k = 0; k < 60; k++) {
      fast.dust(0, 30, -k * 0.4, 30, 0, -25, 25, DT, 'field');
      still.dust(0, 30, 0, 30, 0, 0, 0, DT, 'field');
      fast.step(DT, 0, 0, 0);
      still.step(DT, 0, 0, 0);
    }
    expect(alive(fast.smoke).length).toBeGreaterThan(15);
    expect(alive(still.smoke)).toHaveLength(0);
  });
});

describe('fires that follow burning parts, and the smoke column', () => {
  it('a part fire burns where the part is, follows it, and dies after its duration', () => {
    const sim = new FxSim(8);
    const h = sim.addFire(0, 31, 0, 30, 1, 6, 1.5);
    expect(h).toBeGreaterThanOrEqual(0);
    run(sim, 1);
    expect(sim.fireLevel).toBeGreaterThan(0.2);
    sim.moveFire(h, 50, 31, 0, 30);
    // new flames appear at the new place
    run(sim, 0.8);
    const flames = visible(sim.fire).filter((i) => particleHeat(sim.fire, i) > 0.3);
    expect(flames.length).toBeGreaterThan(3);
    const near = flames.filter((i) => Math.abs(sim.fire.px[i] - 50) < 6);
    expect(near.length / flames.length).toBeGreaterThan(0.5);
    // smoke rises from it
    expect(visible(sim.smoke).length).toBeGreaterThan(3);
    run(sim, 8);
    expect(visible(sim.fire).filter((i) => particleHeat(sim.fire, i) > 0.3)).toHaveLength(0);
  });
  it('quenching a fire in water stops the flames at once and leaves steam', () => {
    const sim = new FxSim(8);
    const h = sim.addFire(0, 1, 0, 0, 1, 20, 1.5);
    run(sim, 1);
    sim.quench(h);
    run(sim, 1.5);
    expect(visible(sim.fire).filter((i) => particleHeat(sim.fire, i) > 0.3)).toHaveLength(0);
    const steam = visible(sim.smoke).filter((i) => (sim.smoke.r[i] + sim.smoke.g[i] + sim.smoke.b[i]) / 3 > 0.5);
    expect(steam.length).toBeGreaterThan(0);
  });
  it('the smoke column keeps rising for its duration and can follow the wreck', () => {
    const sim = new FxSim(8);
    const h = sim.addColumn(0, 30, 0, 30, 1, 30);
    run(sim, 10);
    sim.moveFire(h, 20, 30, 0, 30);
    run(sim, 10);
    const s = visible(sim.smoke);
    // a steady stream: at least a third of the (decaying) emission rate × 10 s of puffs still in the air
    expect(s.length).toBeGreaterThan(CONFIG.fx.crash.smokeRate * 10 * 0.35 * 0.9);
    expect(Math.max(...s.map((i) => sim.smoke.py[i]))).toBeGreaterThan(90);
    run(sim, 40);
    expect(visible(sim.smoke)).toHaveLength(0);
  });
  it('stale handles are ignored after a reset or recycling', () => {
    const sim = new FxSim(8);
    const h = sim.addFire(0, 1, 0, 0, 1, 20, 1);
    sim.reset();
    expect(() => sim.moveFire(h, 5, 5, 5, 0)).not.toThrow();
    expect(() => sim.quench(h)).not.toThrow();
    expect(() => sim.moveFire(-1, 0, 0, 0, 0)).not.toThrow();
    run(sim, 1);
    expect(alive(sim.fire)).toHaveLength(0);
  });
  it('pool bounds: any number of fires/bursts never exceeds the pools or the emitters', () => {
    const sim = new FxSim(8);
    const handles = new Set<number>();
    for (let k = 0; k < 200; k++) {
      const h = sim.addFire(k, 1, 0, 0, 1, 30, 2);
      if (h >= 0) handles.add(h);
      sim.explosion(k, 5, 0, 0, 1);
      sim.fireball(k, 5, 0, 0, 0, 0, 0, 1);
    }
    expect(sim.activeEmitters()).toBeLessThanOrEqual(CONFIG.fx.maxEmitters);
    run(sim, 0.5);
    expect(sim.smoke.count).toBeLessThanOrEqual(sim.smoke.capacity);
    expect(sim.fire.count).toBeLessThanOrEqual(sim.fire.capacity);
  });
  it('fuzz: random recipe calls with garbage never produce NaN particles', () => {
    const num = fc.oneof(fc.double(), fc.constant(Number.NaN), fc.constant(Infinity), fc.double({ min: -100, max: 100, noNaN: true }));
    fc.assert(
      fc.property(fc.array(fc.tuple(fc.integer({ min: 0, max: 9 }), num, num, num, num), { maxLength: 25 }), (calls) => {
        const sim = new FxSim(1);
        let h = -1;
        for (const [k, a, b, c, d] of calls) {
          switch (k) {
            case 0: sim.flash(a, b, c, d); break;
            case 1: sim.fireball(a, b, c, d, a, b, c, d); break;
            case 2: sim.explosion(a, b, c, d, a); break;
            case 3: sim.shockRing(a, b, c, d, 'field'); break;
            case 4: sim.sparks(a, b, c, d, a, b, 30); break;
            case 5: sim.splash(a, b, c, d); break;
            case 6: sim.dust(a, b, c, d, a, b, c, DT, 'dirt'); break;
            case 7: h = sim.addFire(a, b, c, d, a, b, c); break;
            case 8: sim.moveFire(h, a, b, c, d); break;
            default: sim.step(Math.abs(a) % 0.3, b, c, d);
          }
        }
        sim.step(0.1, 0, 0, 0);
        for (const p of [sim.smoke, sim.fire, sim.debris]) {
          for (const i of alive(p)) {
            expect(Number.isFinite(p.px[i] + p.py[i] + p.pz[i])).toBe(true);
            expect(Number.isFinite(particleSize(p, i))).toBe(true);
          }
        }
        expect(Number.isFinite(sim.fireLevel)).toBe(true);
        expect(Number.isFinite(sim.flashLevel)).toBe(true);
      }),
      { numRuns: 150 },
    );
  });
});
