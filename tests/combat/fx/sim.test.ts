/**
 * Functional + fuzz: the combat effects simulation driven by combat events, on a real FxSim (the
 * shared particle pools) — 30 mm impacts by surface (the dust carpet of a burst, sparks, splashes,
 * armour sparks + ricochets), Maverick detonations (ground and air burst), vehicle kills with their
 * secondary, per-frame caps, pooling, camera shake, and reset.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CombatFxSim } from '../../../src/combat/fx/sim';
import { secondaryPlan, soundArrivalS } from '../../../src/combat/fx/plan';
import { FxSim } from '../../../src/fx/sim';
import { particleAlpha, particleHeat, particleSize, type ParticlePool } from '../../../src/fx/pool';
import { CONFIG } from '../../../src/config';
import type { CombatEvent, ImpactSurface } from '../../../src/combat/types';
import type { Vec3 } from '../../../src/types';

const C = CONFIG.fx.combat;
const DT = 1 / 60;
const GROUND = 30;
const env = { groundHeight: () => GROUND };
const SHOOTER: Vec3 = { x: 0, y: GROUND + 400, z: 1200 };

function make() {
  const fx = new FxSim(11);
  const sim = new CombatFxSim({ seed: 5 });
  return { fx, sim };
}

let clock = 0;
const impact = (x: number, z: number, surface: ImpactSurface, extra: Partial<Extract<CombatEvent, { type: 'impact' }>> = {}): CombatEvent => ({
  type: 'impact', time: clock, weapon: 'gun', point: { x, y: GROUND, z }, surface, targetId: surface === 'target' ? 1 : null, ...extra,
});

function frames(sim: CombatFxSim, fx: FxSim, seconds: number, camera: Vec3 | null = SHOOTER) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) {
    clock += DT;
    sim.update(DT, fx, env, SHOOTER, camera);
    fx.step(DT, 0, 0, 0);
  }
}

const alive = (p: ParticlePool) => {
  const out: number[] = [];
  for (let i = 0; i < p.capacity; i++) if (p.alive[i]) out.push(i);
  return out;
};
const visible = (p: ParticlePool) => alive(p).filter((i) => particleAlpha(p, i) > 0.02);

describe('30 mm impacts by surface', () => {
  it('dirt: brown dust kicked up that lingers for seconds, then clears', () => {
    const { fx, sim } = make();
    sim.onEvent(impact(0, 0, 'dirt'));
    frames(sim, fx, 0.4);
    const dust = visible(fx.smoke);
    expect(dust.length).toBeGreaterThanOrEqual(3);
    for (const i of dust) expect(fx.smoke.r[i]).toBeGreaterThan(fx.smoke.b[i]);
    expect(Math.max(...dust.map((i) => fx.smoke.py[i]))).toBeGreaterThan(GROUND + 1.5);
    frames(sim, fx, 3);
    expect(visible(fx.smoke).length).toBeGreaterThan(0);
    frames(sim, fx, 12);
    expect(visible(fx.smoke).length).toBe(0);
  });

  it('a 2 s burst walking along the ground leaves a carpet of dust along the whole line', () => {
    const { fx, sim } = make();
    const rate = 65;
    for (let k = 0; k < 2 * rate; k++) {
      const x = -25 + (50 * k) / (2 * rate) + Math.sin(k * 7.3) * 4;
      const z = Math.cos(k * 3.1) * 5;
      sim.onEvent(impact(x, z, k % 3 === 0 ? 'grass' : 'dirt'));
      frames(sim, fx, 1 / rate);
    }
    frames(sim, fx, 0.8);
    const dust = visible(fx.smoke);
    expect(dust.length).toBeGreaterThan(100);
    const xs = dust.map((i) => fx.smoke.px[i]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(40);
    // A low, wide carpet: most of it within ~15 m of the ground.
    const low = dust.filter((i) => fx.smoke.py[i] < GROUND + 15).length;
    expect(low / dust.length).toBeGreaterThan(0.8);
    // Some HEI rounds sparkled (hot fire particles or sparks appeared during the burst).
    expect(sim.stats().flashes).toBeGreaterThan(10);
  });

  it('water: tall white splash columns rising fast, plus mist', () => {
    const { fx, sim } = make();
    sim.onEvent(impact(0, 0, 'water'));
    frames(sim, fx, 0.05);
    const spray = alive(fx.smoke);
    expect(spray.length).toBeGreaterThanOrEqual(C.water.column);
    expect(Math.max(...spray.map((i) => fx.smoke.vy[i]))).toBeGreaterThan(9);
    for (const i of spray) expect(fx.smoke.b[i]).toBeGreaterThan(0.75);
    frames(sim, fx, 0.6);
    expect(Math.max(...alive(fx.smoke).map((i) => fx.smoke.py[i]))).toBeGreaterThan(GROUND + 5);
  });

  it('asphalt/rock: sparks (glowing streaks) and grey dust', () => {
    const { fx, sim } = make();
    sim.onEvent(impact(0, 0, 'asphalt'));
    frames(sim, fx, 0.05);
    expect(sim.streaks.count).toBeGreaterThanOrEqual(3);
    const puffs = alive(fx.smoke);
    expect(puffs.length).toBeGreaterThan(0);
    for (const i of puffs) expect(Math.abs(fx.smoke.r[i] - fx.smoke.b[i])).toBeLessThan(0.08);
  });

  it('armour: a white-hot incendiary flash and a spray of sparks; a ricochet flies off fast', () => {
    const { fx, sim } = make();
    sim.onEvent(impact(0, 0, 'target'));
    frames(sim, fx, 0.02);
    const hot = alive(fx.fire).filter((i) => particleHeat(fx.fire, i) > 1);
    expect(hot.length).toBeGreaterThanOrEqual(1);
    expect(sim.streaks.count).toBeGreaterThanOrEqual(5);
    const before = sim.streaks.count;
    sim.onEvent(impact(0, 0, 'target', { ricochet: true }));
    frames(sim, fx, 0.02);
    expect(sim.streaks.count).toBeGreaterThan(before);
    let fastest = 0;
    for (let i = 0; i < sim.streaks.capacity; i++) {
      if (!sim.streaks.alive[i]) continue;
      fastest = Math.max(fastest, Math.hypot(sim.streaks.vx[i], sim.streaks.vy[i], sim.streaks.vz[i]));
    }
    expect(fastest).toBeGreaterThan(150);
  });

  it('a gun "hit" without an impact event still sparks; with one it is not doubled', () => {
    const { fx, sim } = make();
    sim.onEvent({ type: 'hit', time: 0, weapon: 'gun', targetId: 1, point: { x: 0, y: GROUND + 1, z: 0 }, damage: 3, health: 50, face: 'top' });
    frames(sim, fx, DT);
    expect(sim.stats().impacts).toBe(1);
    sim.onEvent(impact(5, 0, 'target'));
    sim.onEvent({ type: 'hit', time: 0, weapon: 'gun', targetId: 1, point: { x: 5, y: GROUND + 0.5, z: 0 }, damage: 3, health: 47, face: 'top' });
    frames(sim, fx, DT);
    expect(sim.stats().impacts).toBe(2);
  });
});

describe('Maverick detonation', () => {
  it('on the ground: flash (lights the scene), fireball, a dust ring racing outward, a dirt column, lingering smoke', () => {
    const { fx, sim } = make();
    sim.onEvent({ type: 'detonation', time: 0, weapon: 'missile', position: { x: 0, y: GROUND + 0.5, z: 0 }, targetId: null, blastRadiusM: 18, surface: 'dirt' });
    frames(sim, fx, DT);
    expect(fx.flashLevel).toBeGreaterThan(0.5);
    frames(sim, fx, 0.2);
    const fire = alive(fx.fire).filter((i) => particleHeat(fx.fire, i) > 0.5);
    expect(fire.length).toBeGreaterThan(10);
    expect(Math.max(...fire.map((i) => particleSize(fx.fire, i)))).toBeGreaterThan(4);
    const smoke = alive(fx.smoke);
    const ring = smoke.filter((i) => fx.smoke.py[i] < GROUND + 3 && Math.hypot(fx.smoke.vx[i], fx.smoke.vz[i]) > 8);
    expect(ring.length).toBeGreaterThan(15);
    const column = smoke.filter((i) => fx.smoke.vy[i] > 8);
    expect(column.length).toBeGreaterThan(8);
    frames(sim, fx, 10);
    expect(visible(fx.smoke).length).toBeGreaterThan(5);
  });

  it('bigger than a 30 mm impact', () => {
    const a = make();
    a.sim.onEvent(impact(0, 0, 'dirt'));
    frames(a.sim, a.fx, 0.3);
    const b = make();
    b.sim.onEvent({ type: 'detonation', time: 0, weapon: 'missile', position: { x: 0, y: GROUND, z: 0 }, targetId: null, blastRadiusM: 18, surface: 'dirt' });
    frames(b.sim, b.fx, 0.3);
    expect(b.fx.smoke.count + b.fx.fire.count).toBeGreaterThan(8 * (a.fx.smoke.count + a.fx.fire.count));
  });

  it('air burst (self-destruct): fireball and a black puff, no ground ring or dirt', () => {
    const { fx, sim } = make();
    sim.onEvent({ type: 'detonation', time: 0, weapon: 'missile', position: { x: 0, y: GROUND + 120, z: 0 }, targetId: null, blastRadiusM: 18, surface: 'dirt' });
    frames(sim, fx, 0.25);
    expect(fx.flashLevel).toBeGreaterThan(0);
    expect(alive(fx.fire).length).toBeGreaterThan(5);
    const low = alive(fx.smoke).filter((i) => fx.smoke.py[i] < GROUND + 20);
    expect(low.length).toBe(0);
    const black = alive(fx.smoke).filter((i) => fx.smoke.r[i] < 0.1);
    expect(black.length).toBeGreaterThan(3);
  });
});

describe('vehicle destroyed', () => {
  it('a tank: big flash + fireball + dark debris, then its ammunition cooks off (secondary) on schedule', () => {
    const { fx, sim } = make();
    const t0 = 12.5;
    sim.onEvent({ type: 'destroyed', time: t0, weapon: 'missile', targetId: 7, kind: 'tank', position: { x: 0, y: GROUND, z: 0 } });
    frames(sim, fx, DT);
    expect(fx.flashLevel).toBeGreaterThan(0.9);
    expect(fx.debris.count).toBeGreaterThan(5);
    for (let i = 0; i < fx.debris.capacity; i++) if (fx.debris.alive[i]) expect(fx.debris.r[i]).toBeLessThan(0.4);
    const plan = secondaryPlan(7, 'tank', t0);
    expect(plan.delayS).not.toBeNull();
    // Let the first flash die, then watch for the second one.
    let second = -1;
    for (let t = DT; t < 2; t += DT) {
      const before = fx.flashLevel;
      frames(sim, fx, DT);
      if (t > 0.2 && fx.flashLevel > before + 0.2 && second < 0) second = t;
    }
    expect(second).toBeGreaterThan(plan.delayS! - 0.1);
    expect(second).toBeLessThan(plan.delayS! + 0.1);
    expect(sim.stats().secondaries).toBe(1);
  });

  it('a truck explosion is smaller than a tank\'s', () => {
    const a = make();
    a.sim.onEvent({ type: 'destroyed', time: 1, weapon: 'gun', targetId: 1, kind: 'truck', position: { x: 0, y: GROUND, z: 0 } });
    frames(a.sim, a.fx, 0.1);
    const b = make();
    b.sim.onEvent({ type: 'destroyed', time: 1, weapon: 'gun', targetId: 1, kind: 'tank', position: { x: 0, y: GROUND, z: 0 } });
    frames(b.sim, b.fx, 0.1);
    expect(b.fx.fire.count).toBeGreaterThan(a.fx.fire.count);
  });
});

describe('budgets and pooling', () => {
  it('a storm of 1,000 impacts in one frame plays at most maxImpactFxPerFrame effects (merged, bigger)', () => {
    const { fx, sim } = make();
    for (let k = 0; k < 1000; k++) sim.onEvent(impact((k % 50) * 2, Math.floor(k / 50) * 2, k % 2 ? 'dirt' : 'asphalt'));
    frames(sim, fx, DT);
    const s = sim.stats();
    expect(s.impacts).toBe(1000);
    expect(s.lastFrameEffects).toBeLessThanOrEqual(CONFIG.combat.maxImpactFxPerFrame);
    expect(fx.smoke.count).toBeLessThanOrEqual(fx.smoke.capacity);
    // Bounded work: at most a few particles per merged effect.
    expect(fx.smoke.count + fx.fire.count).toBeLessThan(CONFIG.combat.maxImpactFxPerFrame * 20);
  });

  it('no growth after warm-up: the same arrays, pending and streaks stay within their capacities', () => {
    const { fx, sim } = make();
    const arrays = [sim.streaks.px, sim.batch.x];
    for (let k = 0; k < 600; k++) {
      sim.onEvent(impact(k % 40, 0, 'target', { ricochet: k % 5 === 0 }));
      if (k % 50 === 0) sim.onEvent({ type: 'destroyed', time: k, weapon: 'gun', targetId: k, kind: 'tank', position: { x: 0, y: GROUND, z: 0 } });
      if (k % 30 === 0) sim.onEvent({ type: 'detonation', time: k, weapon: 'missile', position: { x: 0, y: GROUND, z: 0 }, targetId: null, blastRadiusM: 18, surface: 'dirt' });
      frames(sim, fx, DT);
    }
    expect(sim.streaks.px).toBe(arrays[0]);
    expect(sim.batch.x).toBe(arrays[1]);
    expect(sim.streaks.count).toBeLessThanOrEqual(C.streakCapacity);
    expect(sim.stats().pending).toBeLessThanOrEqual(C.maxPending);
  });
});

describe('camera shake', () => {
  it('the gun vibrates the cockpit more than the outside views', () => {
    const { sim } = make();
    expect(sim.shake(true, 1, true)).toBeCloseTo(C.shake.gunCockpit, 3);
    expect(sim.shake(false, 1, true)).toBeCloseTo(C.shake.gunOutside, 3);
    expect(sim.shake(true, 1, false)).toBe(0);
  });
  it('a blast 343 m away shakes the camera only after ~1 s (the pressure wave), then fades', () => {
    const { fx, sim } = make();
    const cam = { x: 0, y: GROUND, z: 343 };
    sim.onEvent({ type: 'detonation', time: 0, weapon: 'missile', position: { x: 0, y: GROUND, z: 0 }, targetId: null, blastRadiusM: 18, surface: 'dirt' });
    frames(sim, fx, 0.5, cam);
    expect(sim.shake(false, 0, false)).toBe(0);
    frames(sim, fx, soundArrivalS(343) - 0.5 + 0.05, cam);
    expect(sim.shake(false, 0, false)).toBeGreaterThan(0.01);
    frames(sim, fx, 3, cam);
    expect(sim.shake(false, 0, false)).toBeLessThan(1e-3);
  });
  it('a blast right under the camera shakes hard', () => {
    const { fx, sim } = make();
    sim.onEvent({ type: 'destroyed', time: 0, weapon: 'missile', targetId: 3, kind: 'tank', position: { x: 0, y: GROUND, z: 0 } });
    frames(sim, fx, 0.1, { x: 0, y: GROUND + 20, z: 0 });
    expect(sim.shake(false, 0, false)).toBeGreaterThan(0.3);
  });
});

describe('reset and fuzz', () => {
  it('reset kills every streak, pending secondary and shake', () => {
    const { fx, sim } = make();
    sim.onEvent({ type: 'destroyed', time: 0, weapon: 'missile', targetId: 3, kind: 'tank', position: { x: 0, y: GROUND, z: 0 } });
    sim.onEvent(impact(0, 0, 'target', { ricochet: true }));
    frames(sim, fx, 0.05, { x: 0, y: GROUND + 20, z: 0 });
    expect(sim.stats().pending).toBeGreaterThan(0);
    sim.onEvent(impact(0, 0, 'dirt'));
    sim.reset();
    fx.reset();
    frames(sim, fx, 3, { x: 0, y: GROUND + 20, z: 0 });
    expect(sim.streaks.count).toBe(0);
    expect(sim.stats().pending).toBe(0);
    expect(sim.stats().secondaries).toBe(0);
    expect(sim.shake(false, 0, false)).toBe(0);
    expect(fx.smoke.count + fx.fire.count + fx.debris.count).toBe(0);
  });

  const surfaces: ImpactSurface[] = ['runway', 'asphalt', 'grass', 'dirt', 'field', 'forest', 'rock', 'snow', 'sand', 'urban', 'water', 'target'];
  const num = fc.oneof(fc.double({ min: -5000, max: 5000, noNaN: true }), fc.constant(Number.NaN), fc.constant(Infinity));
  const vec = fc.record({ x: num, y: num, z: num });
  const event: fc.Arbitrary<CombatEvent> = fc.oneof(
    fc.record({ type: fc.constant('impact' as const), time: num, weapon: fc.constantFrom('gun' as const, 'missile' as const), point: vec, surface: fc.constantFrom(...surfaces), targetId: fc.oneof(fc.constant(null), fc.integer()), ricochet: fc.boolean() }),
    fc.record({ type: fc.constant('detonation' as const), time: num, weapon: fc.constantFrom('gun' as const, 'missile' as const), position: vec, targetId: fc.constant(null), blastRadiusM: num, surface: fc.constantFrom(...surfaces) }),
    fc.record({ type: fc.constant('destroyed' as const), time: num, weapon: fc.constant('missile' as const), targetId: fc.integer(), kind: fc.constantFrom('tank' as const, 'ifv' as const, 'apc' as const, 'truck' as const, 'aaa' as const), position: vec }),
    fc.record({ type: fc.constant('hit' as const), time: num, weapon: fc.constant('gun' as const), targetId: fc.integer(), point: vec, damage: num, health: num, face: fc.constant('top' as const) }),
    fc.record({ type: fc.constantFrom('gunStart' as const, 'reload' as const), time: num }),
  );

  it('fuzz: random event storms never exceed the pools/caps, never NaN, and leave nothing alive after reset', () => {
    fc.assert(
      fc.property(fc.array(fc.array(event, { maxLength: 60 }), { minLength: 1, maxLength: 12 }), fc.array(fc.oneof(fc.double({ min: 0, max: 0.3, noNaN: true }), fc.constant(Number.NaN)), { minLength: 12, maxLength: 12 }), (batches, dts) => {
        const fx = new FxSim(3);
        const sim = new CombatFxSim({ seed: 9 });
        batches.forEach((b, k) => {
          for (const e of b) sim.onEvent(e);
          sim.update(dts[k], fx, env, SHOOTER, { x: 0, y: 40, z: 0 });
          fx.step(Number.isFinite(dts[k]) ? dts[k] : 0, 0, 0, 0);
          expect(sim.stats().lastFrameEffects).toBeLessThanOrEqual(CONFIG.combat.maxImpactFxPerFrame);
          expect(sim.streaks.count).toBeLessThanOrEqual(sim.streaks.capacity);
          expect(sim.stats().pending).toBeLessThanOrEqual(C.maxPending);
          const sh = sim.shake(k % 2 === 0, 1, k % 3 === 0);
          expect(sh >= 0 && sh <= 1).toBe(true);
          for (const p of [fx.smoke, fx.fire, fx.debris]) {
            expect(p.count).toBeLessThanOrEqual(p.capacity);
            for (let i = 0; i < p.capacity; i++) if (p.alive[i]) expect(Number.isFinite(p.px[i] + p.py[i] + p.pz[i])).toBe(true);
          }
          for (let i = 0; i < sim.streaks.capacity; i++) if (sim.streaks.alive[i]) expect(Number.isFinite(sim.streaks.px[i] + sim.streaks.py[i] + sim.streaks.pz[i])).toBe(true);
        });
        sim.reset();
        fx.reset();
        sim.update(1 / 60, fx, env, SHOOTER, null);
        expect(sim.streaks.count + sim.stats().pending + fx.smoke.count + fx.fire.count + fx.debris.count).toBe(0);
        expect(sim.shake(true, 0, false)).toBe(0);
      }),
      { numRuns: 60 },
    );
  });
});
