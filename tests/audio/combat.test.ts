/**
 * Functional (mock WebAudio): the combat sound — the gun's gate and fundamental (GAU-8 65 Hz, M61
 * 100 Hz, rising with the spin), its exterior delay line at d / 343 m/s, impacts and explosions
 * scheduled at their own distance / c (so impacts near a listener are heard before the gun far away),
 * the missile launch and motor, reset stopping everything (future one-shots included), no leaks,
 * the TF34 turbofan voice, and the audio system wiring (combat events → sounds, A-10 → 'turbofan').
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { createAudio, type AudioInputs } from '../../src/audio';
import type { CombatAudioFrame } from '../../src/audio/combat';
import { tf34WhistleHz } from '../../src/audio/turbofanMapping';
import { MockAudioContext, MockDelay, MockOscillator, MockScheduled, violations } from './mockAudio';
import { CONFIG } from '../../src/config';
import { FLEET } from '../../src/fleet';

const DT = 1 / 60;
const IDLE: AudioInputs = {
  rpm: 0, power: 0, engineRunning: false, starting: false, airspeedKt: 0, onGround: true, groundSpeedKt: 0,
  stallWarning: false, gearMoving: false, flapsMoving: false, touchdownFpm: null, crashed: false,
  cameraMode: 'chase', paused: false, brake: 0, surface: 'runway',
};
const GUN: CombatAudioFrame = { gunRateRps: 65, gunCaliberMm: 30, gunSpin: 1, gunFiring: true, gunDistanceM: 30, cockpit: false, motor: 0, motorDistanceM: 0 };

async function make(engine?: 'piston' | 'jet' | 'turbofan') {
  let ctx: MockAudioContext | null = null;
  const audio = createAudio({
    engine,
    createContext: () => {
      ctx = new MockAudioContext();
      return ctx as unknown as AudioContext;
    },
  });
  await audio.resume();
  return { audio, ctx: ctx as unknown as MockAudioContext };
}
const step = (a: ReturnType<typeof createAudio>, ctx: MockAudioContext, f: CombatAudioFrame, s = DT, inputs: AudioInputs = IDLE) => {
  for (let i = 0; i < Math.max(1, Math.round(s / DT)); i++) {
    ctx.advance(DT);
    a.update(inputs, DT);
    a.combat.update(f);
  }
};
const delays = (ctx: MockAudioContext) => ctx.nodes.filter((n) => n instanceof MockDelay && !n.disconnected) as MockDelay[];
const startsAfter = (ctx: MockAudioContext, t: number) => ctx.nodes.filter((n) => n instanceof MockScheduled && n.started !== null && n.started > t + 1e-6) as MockScheduled[];

beforeEach(() => {
  violations.length = 0;
});
afterEach(() => {
  expect(violations).toEqual([]);
});

describe('the gun', () => {
  it('GAU-8/A: the buzz fundamental is 65 Hz at full spin; the gate opens only while firing', async () => {
    const { audio, ctx } = await make('turbofan');
    step(audio, ctx, GUN, 0.2);
    let L = audio.levels();
    expect(L.gun).toBe(1);
    expect(L.gunHz).toBe(65);
    const pulse = ctx.nodes.find((n) => n instanceof MockOscillator && Math.abs(n.frequency.value - 65) < 1e-6);
    expect(pulse).toBeDefined();
    step(audio, ctx, { ...GUN, gunFiring: false, gunSpin: 0.6 }, 0.1);
    L = audio.levels();
    expect(L.gun).toBe(0);
  });
  it('M61A1: 100 Hz; the rate climbs with the barrels spinning up', async () => {
    const { audio, ctx } = await make('jet');
    step(audio, ctx, { ...GUN, gunRateRps: 100, gunCaliberMm: 20, gunSpin: 0.5 }, 0.05);
    expect(audio.levels().gunHz).toBeCloseTo(50);
    step(audio, ctx, { ...GUN, gunRateRps: 100, gunCaliberMm: 20, gunSpin: 1 }, 0.05);
    expect(audio.levels().gunHz).toBe(100);
  });
  it('outside, the BRRRT goes through a delay line of distance / 343 m/s; in the cockpit there is no delay', async () => {
    const { audio, ctx } = await make();
    step(audio, ctx, { ...GUN, gunDistanceM: 686 }, 0.3);
    expect(audio.levels().gunDelayS).toBeCloseTo(2, 3);
    const gunDelay = delays(ctx)[0];
    expect(gunDelay.delayTime.value).toBeCloseTo(2, 3);
    step(audio, ctx, { ...GUN, cockpit: true }, 0.3);
    expect(audio.levels().gunDelayS).toBe(0);
  });
});

describe('distance: each sound arrives at its own d / c', () => {
  it('an impact 1,029 m away is scheduled 3 s later; one 34 m away 0.1 s later', async () => {
    const { audio, ctx } = await make();
    step(audio, ctx, { ...GUN, gunFiring: false, gunSpin: 0 }, 0.05);
    const t0 = ctx.currentTime;
    const before = ctx.nodes.length;
    audio.combat.impact({ distanceM: 1029, surface: 'dirt' });
    const far = ctx.nodes.slice(before).filter((n) => n instanceof MockScheduled) as MockScheduled[];
    expect(far.length).toBeGreaterThan(0);
    for (const s of far) expect(s.started!).toBeCloseTo(t0 + 3, 2);
    const mid = ctx.nodes.length;
    audio.combat.impact({ distanceM: 34.3, surface: 'target', ricochet: true });
    const near = ctx.nodes.slice(mid).filter((n) => n instanceof MockScheduled) as MockScheduled[];
    expect(Math.min(...near.map((s) => s.started!))).toBeCloseTo(t0 + 0.1, 2);
    expect(audio.levels().impactsPlayed).toBe(2);
  });
  it('a Maverick detonation 1,715 m away booms 5 s later, with a long tail; a cook-off adds pops and the secondary', async () => {
    const { audio, ctx } = await make();
    step(audio, ctx, { ...GUN, gunFiring: false, gunSpin: 0 }, 0.05);
    const t0 = ctx.currentTime;
    const n0 = ctx.nodes.length;
    audio.combat.detonation({ distanceM: 1715, size: 1 });
    const boom = ctx.nodes.slice(n0).filter((n) => n instanceof MockScheduled) as MockScheduled[];
    expect(Math.min(...boom.map((s) => s.started!))).toBeCloseTo(t0 + 5, 2);
    expect(Math.max(...boom.map((s) => s.stopped!))).toBeGreaterThan(t0 + 7);
    const n1 = ctx.nodes.length;
    audio.combat.cookoff({ distanceM: 343, size: 1.1, secondaryDelayS: 0.9, secondarySize: 0.6 });
    const cook = ctx.nodes.slice(n1).filter((n) => n instanceof MockScheduled) as MockScheduled[];
    expect(cook.length).toBeGreaterThan(boom.length);
    expect(cook.some((s) => Math.abs(s.started! - (t0 + 1 + 0.9)) < 0.02)).toBe(true);
    expect(audio.levels().booms).toBe(3);
  });
  it('missile launch: whoosh + roar at the rail; the motor plays through its own delay line', async () => {
    const { audio, ctx } = await make();
    audio.combat.launch({ distanceM: 5 });
    expect(audio.levels().launches).toBe(1);
    step(audio, ctx, { ...GUN, gunFiring: false, gunSpin: 0, motor: 1, motorDistanceM: 343 }, 0.3);
    expect(audio.levels().motor).toBe(1);
    expect(delays(ctx).some((d) => Math.abs(d.delayTime.value - 1) < 1e-3)).toBe(true);
  });
});

describe('reset and hygiene', () => {
  it('reset stops every scheduled combat sound (future ones never start) and flushes the delay lines', async () => {
    const { audio, ctx } = await make();
    step(audio, ctx, { ...GUN, gunDistanceM: 800 }, 0.2);
    audio.combat.detonation({ distanceM: 2000 });
    audio.combat.impact({ distanceM: 1500, surface: 'dirt' });
    const t = ctx.currentTime;
    const future = startsAfter(ctx, t + 1);
    expect(future.length).toBeGreaterThan(3);
    const oldDelays = delays(ctx);
    audio.reset();
    for (const s of future) expect(s.stopped!).toBeLessThanOrEqual(t + 0.2);
    ctx.advance(1);
    ctx.endFinished();
    for (const d of oldDelays) expect(d.disconnected).toBe(true);
    expect(delays(ctx).length).toBe(2);
    step(audio, ctx, { ...GUN, gunFiring: false, gunSpin: 0 }, 0.1);
    expect(audio.levels().combatLive).toBe(0);
  });
  it('fuzz: random event storms never schedule invalid automation or leak nodes', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.tuple(fc.constantFrom('impact', 'detonation', 'cookoff', 'launch', 'frame', 'reset'), fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity)), fc.boolean()), { maxLength: 80 }),
        async (ops) => {
          violations.length = 0;
          const { audio, ctx } = await make('turbofan');
          for (const [op, d, b] of ops) {
            if (op === 'impact') audio.combat.impact({ distanceM: d, surface: b ? 'target' : 'dirt', ricochet: b });
            else if (op === 'detonation') audio.combat.detonation({ distanceM: d, air: b });
            else if (op === 'cookoff') audio.combat.cookoff({ distanceM: d, secondaryDelayS: b ? d : null });
            else if (op === 'launch') audio.combat.launch({ distanceM: d });
            else if (op === 'reset') audio.reset();
            else step(audio, ctx, { ...GUN, gunDistanceM: d, gunSpin: d, gunFiring: b, cockpit: !b, motor: b ? 1 : 0, motorDistanceM: d }, DT, { ...IDLE, rpm: 90, power: 0.8, engineRunning: true });
          }
          ctx.advance(60);
          ctx.endFinished();
          step(audio, ctx, { ...GUN, gunFiring: false, gunSpin: 0 }, DT);
          const L = audio.levels();
          expect(L.errors).toBe(0);
          expect(L.combatLive).toBe(0);
          for (const v of Object.values(L)) expect(Number.isFinite(v)).toBe(true);
          expect(violations).toEqual([]);
          audio.dispose();
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('TF34 turbofan voice', () => {
  it("the A-10 uses the 'turbofan' sound; its whistle is the fan blade-pass tone rising with N1", async () => {
    expect(FLEET.find((d) => d.id === 'a10')!.sound).toBe('turbofan');
    const { audio, ctx } = await make('turbofan');
    expect(audio.engine).toBe('turbofan');
    step(audio, ctx, { ...GUN, gunFiring: false, gunSpin: 0 }, 0.2, { ...IDLE, rpm: 70, power: 0.02, engineRunning: true });
    let L = audio.levels();
    expect(L.turbofan).toBe(1);
    expect(L.jet).toBe(0);
    expect(L.whineHz).toBeCloseTo(tf34WhistleHz(70), 3);
    step(audio, ctx, { ...GUN, gunFiring: false, gunSpin: 0 }, 0.2, { ...IDLE, rpm: 100, power: 1, engineRunning: true });
    L = audio.levels();
    expect(L.whineHz).toBeCloseTo(tf34WhistleHz(100), 3);
    expect(L.whineHz).toBeGreaterThan(3000);
    expect(L.afterburner).toBe(0);
    audio.setEngine('piston');
    step(audio, ctx, { ...GUN, gunFiring: false, gunSpin: 0 }, 0.1, { ...IDLE, rpm: 2400, power: 0.8, engineRunning: true });
    expect(audio.levels().turbofan).toBe(0);
    expect(CONFIG.audio.turbofan.fanBlades).toBe(28);
  });
});
