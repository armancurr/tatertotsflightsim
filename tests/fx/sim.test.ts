import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { FxSim } from '../../src/fx/sim';
import { particleHeat, particleSize, particleAlpha, type ParticlePool } from '../../src/fx/pool';
import { CONFIG } from '../../src/config';

const FX = CONFIG.fx;
const DT = 1 / 60;

function run(sim: FxSim, seconds: number, wind = { x: 0, y: 0, z: 0 }) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) sim.step(DT, wind.x, wind.y, wind.z);
}

function alive(p: ParticlePool): number[] {
  const out: number[] = [];
  for (let i = 0; i < p.capacity; i++) if (p.alive[i]) out.push(i);
  return out;
}

const visible = (p: ParticlePool) => alive(p).filter((i) => particleAlpha(p, i) > 0.01);

describe('FxSim crash', () => {
  it('a fast crash makes a fireball, embers, debris and a smoke column', () => {
    const sim = new FxSim(7);
    sim.crash(0, 30, 0, 110, 0, -5, -50, 29);
    run(sim, 0.5);
    const hot = alive(sim.fire).filter((i) => particleHeat(sim.fire, i) > 0.5);
    expect(hot.length).toBeGreaterThan(30);
    expect(sim.debris.count).toBeGreaterThan(10);
    expect(sim.fireLevel).toBeGreaterThan(0.5);
    // the fireball is big
    expect(Math.max(...hot.map((i) => particleSize(sim.fire, i)))).toBeGreaterThan(8);
  });
  it('the smoke column rises high, and lingers ~20 s', () => {
    const sim = new FxSim(7);
    sim.crash(0, 30, 0, 100, 0, 0, 0, 29);
    run(sim, 10);
    const vis = visible(sim.smoke);
    expect(vis.length).toBeGreaterThan(80);
    const top = Math.max(...vis.map((i) => sim.smoke.py[i]));
    expect(top).toBeGreaterThan(29 + 70);
    run(sim, 8); // t = 18 s: still smoking
    expect(visible(sim.smoke).length).toBeGreaterThan(60);
    run(sim, 30); // t = 48 s: gone
    expect(visible(sim.smoke).length).toBe(0);
    expect(sim.fireLevel).toBe(0);
  });
  it('smoke drifts downwind', () => {
    const sim = new FxSim(7);
    sim.crash(0, 30, 0, 100, 0, 0, 0, 29);
    run(sim, 12, { x: 8, y: 0, z: 0 });
    const vis = visible(sim.smoke);
    const meanX = vis.reduce((s, i) => s + sim.smoke.px[i], 0) / vis.length;
    expect(meanX).toBeGreaterThan(20);
  });
  it('fire stays near the wreck; smoke is dark near the source', () => {
    const sim = new FxSim(7);
    sim.crash(100, 30, -40, 100, 0, 0, 0, 29);
    run(sim, 6);
    for (const i of alive(sim.fire)) {
      if (particleHeat(sim.fire, i) < 0.6 || sim.fire.gravity[i] !== 0) continue; // skip embers
      expect(Math.hypot(sim.fire.px[i] - 100, sim.fire.pz[i] + 40)).toBeLessThan(40);
    }
    const low = alive(sim.smoke).filter((i) => sim.smoke.py[i] < 45 && particleAlpha(sim.smoke, i) > 0.05);
    for (const i of low) expect(sim.smoke.r[i]).toBeLessThan(0.2);
  });
  it('a slow crash (below fireMinKt) has no fire, only dust, debris and a little smoke', () => {
    const sim = new FxSim(7);
    sim.crash(0, 30, 0, FX.crash.fireMinKt - 5, 0, 0, -8, 29);
    run(sim, 0.5);
    expect(alive(sim.fire).filter((i) => particleHeat(sim.fire, i) > 0.2).length).toBe(0);
    expect(sim.fireLevel).toBe(0);
    expect(sim.smoke.count).toBeGreaterThan(5);
    expect(sim.debris.count).toBeGreaterThan(0);
  });
  it('ditching in water: spray, no fire', () => {
    const sim = new FxSim(7);
    sim.crash(0, 0.5, 0, 90, 0, 0, -45, 0, true);
    run(sim, 0.3);
    expect(sim.fireLevel).toBe(0);
    expect(alive(sim.fire).filter((i) => particleHeat(sim.fire, i) > 0.2).length).toBe(0);
    expect(sim.smoke.count).toBeGreaterThan(10);
  });
  it('debris lands and stays on the ground', () => {
    const sim = new FxSim(7);
    sim.crash(0, 31, 0, 120, 0, -5, -60, 29);
    run(sim, 15);
    expect(sim.debris.count).toBeGreaterThan(5);
    for (const i of alive(sim.debris)) expect(sim.debris.py[i]).toBeGreaterThanOrEqual(29 - 1e-3);
    const moving = alive(sim.debris).filter((i) => Math.hypot(sim.debris.vx[i], sim.debris.vy[i], sim.debris.vz[i]) > 0.5);
    expect(moving.length).toBe(0);
  });
});

describe('FxSim touchdown', () => {
  const wheels = (y: number) => [{ x: -1.27, y, z: 0.45 }, { x: 1.27, y, z: 0.45 }];
  it('puffs at both mains; a hard landing makes more and bigger smoke than a greaser', () => {
    const soft = new FxSim(3);
    soft.touchdown(wheels(30), 30, 90, 0, 0, -30, 'runway');
    const hard = new FxSim(3);
    hard.touchdown(wheels(30), 30, 750, 0, 0, -30, 'runway');
    expect(hard.smoke.count).toBeGreaterThan(soft.smoke.count);
    run(soft, 1);
    run(hard, 1);
    const maxSize = (s: FxSim) => Math.max(...alive(s.smoke).map((i) => particleSize(s.smoke, i)));
    expect(maxSize(hard)).toBeGreaterThan(maxSize(soft) * 1.5);
    const xs = alive(hard.smoke).map((i) => hard.smoke.px[i]);
    expect(Math.min(...xs)).toBeLessThan(-0.5);
    expect(Math.max(...xs)).toBeGreaterThan(0.5);
  });
  it('the smoke stays behind as the aircraft rolls on (spawned along the spin-up path)', () => {
    const sim = new FxSim(3);
    sim.touchdown(wheels(30), 30, 500, 0, 0, -30, 'runway');
    const zs = alive(sim.smoke).map((i) => sim.smoke.pz[i]);
    expect(Math.min(...zs)).toBeLessThan(0.45 - 2); // later puffs further along -z (the direction of travel)
    run(sim, 2);
    for (const i of alive(sim.smoke)) expect(Math.abs(sim.smoke.vz[i])).toBeLessThan(10);
  });
  it('surface decides the colour: tyre smoke on pavement, brown dust on dirt', () => {
    const a = new FxSim(3);
    a.touchdown(wheels(30), 30, 400, 0, 0, -30, 'runway');
    const b = new FxSim(3);
    b.touchdown(wheels(30), 30, 400, 0, 0, -30, 'dirt');
    const i = alive(a.smoke)[0];
    const j = alive(b.smoke)[0];
    expect(a.smoke.r[i]).toBeCloseTo(a.smoke.b[i], 1);
    expect(b.smoke.r[j]).toBeGreaterThan(b.smoke.b[j] + 0.1);
  });
  it('touchdown smoke fades within a few seconds', () => {
    const sim = new FxSim(3);
    sim.touchdown(wheels(30), 30, 800, 0, 0, -30, 'runway');
    run(sim, 6);
    expect(visible(sim.smoke).length).toBe(0);
  });
});

describe('FxSim reset & robustness', () => {
  it('reset clears everything', () => {
    const sim = new FxSim(1);
    sim.crash(0, 30, 0, 100, 0, 0, 0, 29);
    run(sim, 1);
    sim.reset();
    expect(sim.smoke.count + sim.fire.count + sim.debris.count).toBe(0);
    expect(sim.fireLevel).toBe(0);
    run(sim, 2);
    expect(sim.smoke.count + sim.fire.count + sim.debris.count).toBe(0);
  });
  it('repeated crashes never exceed capacity', () => {
    const sim = new FxSim(1);
    for (let k = 0; k < 12; k++) {
      sim.crash(k * 10, 30, 0, 150, 0, 0, -70, 29);
      run(sim, 0.5);
    }
    expect(sim.smoke.count).toBeLessThanOrEqual(FX.smokeCapacity);
    expect(sim.fire.count).toBeLessThanOrEqual(FX.fireCapacity);
    expect(sim.debris.count).toBeLessThanOrEqual(FX.debrisCapacity);
  });
  it('fuzz: random crash/touchdown/step/reset sequences keep every live particle finite', () => {
    const wild = fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity, 0, 1e9));
    const op = fc.oneof(
      fc.record({ k: fc.constant('crash' as const), x: wild, y: wild, s: wild, v: wild, g: wild, water: fc.boolean() }),
      fc.record({ k: fc.constant('td' as const), x: wild, y: wild, fpm: wild, v: wild, surface: fc.constantFrom('runway', 'grass', 'water', 'snow', 'nope') }),
      fc.record({ k: fc.constant('step' as const), dt: wild, w: wild }),
      fc.record({ k: fc.constant('reset' as const) }),
    );
    fc.assert(fc.property(fc.array(op, { maxLength: 25 }), (ops) => {
      const sim = new FxSim(5);
      for (const o of ops) {
        if (o.k === 'crash') sim.crash(o.x, o.y, o.x, o.s, o.v, o.v, o.v, o.g, o.water);
        else if (o.k === 'td') sim.touchdown([{ x: o.x, y: o.y, z: o.x }, { x: o.y, y: o.y, z: o.x }], o.y, o.fpm, o.v, o.v, o.v, o.surface as never);
        else if (o.k === 'step') sim.step(o.dt, o.w, o.w, o.w);
        else sim.reset();
      }
      for (const p of [sim.smoke, sim.fire, sim.debris]) {
        expect(p.count).toBeLessThanOrEqual(p.capacity);
        for (const i of alive(p)) {
          for (const arr of [p.px, p.py, p.pz, p.vx, p.vy, p.vz]) expect(Number.isFinite(arr[i])).toBe(true);
          expect(Number.isFinite(particleSize(p, i))).toBe(true);
        }
      }
      expect(Number.isFinite(sim.fireLevel)).toBe(true);
      expect(Number.isFinite(sim.glowAt(0, 0, 0))).toBe(true);
    }), { numRuns: 80 });
  });
});
