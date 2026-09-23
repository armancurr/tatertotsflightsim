import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { createAudio, type AudioInputs } from '../../src/audio';
import { cycleFrequency, firingFrequency, bladePassFrequency, engineMix } from '../../src/audio/mapping';
import { CONFIG } from '../../src/config';
import { MockAudioContext, allParams, violations } from './mockAudio';
import type { CameraMode, SurfaceType } from '../../src/types';

const A = CONFIG.audio;
const DT = 1 / 60;

const IDLE: AudioInputs = {
  rpm: 0, power: 0, engineRunning: false, starting: false, airspeedKt: 0, onGround: true, groundSpeedKt: 0,
  stallWarning: false, gearMoving: false, flapsMoving: false, touchdownFpm: null, crashed: false,
  cameraMode: 'chase', paused: false, brake: 0, surface: 'runway',
};
const RUN: AudioInputs = { ...IDLE, rpm: 2400, power: 0.8, engineRunning: true, airspeedKt: 100, onGround: false };
const inp = (p: Partial<AudioInputs> = {}): AudioInputs => ({ ...RUN, ...p });

async function makeAudio() {
  let ctx: MockAudioContext | null = null;
  const audio = createAudio({
    createContext: () => {
      ctx = new MockAudioContext();
      return ctx as unknown as AudioContext;
    },
  });
  await audio.resume();
  return { audio, ctx: ctx as unknown as MockAudioContext };
}

function run(audio: ReturnType<typeof createAudio>, ctx: MockAudioContext, a: AudioInputs, seconds: number) {
  const n = Math.max(1, Math.round(seconds / DT));
  for (let i = 0; i < n; i++) {
    ctx.advance(DT);
    audio.update(a, DT);
  }
}

beforeEach(() => {
  violations.length = 0;
});
afterEach(() => {
  expect(violations).toEqual([]);
});

describe('createAudio without WebAudio', () => {
  it('never throws when AudioContext is unavailable', async () => {
    const g = globalThis as { AudioContext?: unknown };
    const saved = g.AudioContext;
    delete g.AudioContext;
    try {
      const audio = createAudio();
      await expect(audio.resume()).resolves.toBeUndefined();
      expect(() => audio.update(RUN, DT)).not.toThrow();
      audio.setMuted(true);
      expect(audio.muted).toBe(true);
      expect(audio.context).toBeNull();
      expect(() => audio.dispose()).not.toThrow();
    } finally {
      if (saved) g.AudioContext = saved;
    }
  });
  it('never throws when the AudioContext constructor throws', async () => {
    const audio = createAudio({ createContext: () => { throw new Error('blocked'); } });
    await expect(audio.resume()).resolves.toBeUndefined();
    expect(() => audio.update(RUN, DT)).not.toThrow();
    expect(() => audio.dispose()).not.toThrow();
  });
  it('never throws when resume() rejects', async () => {
    const audio = createAudio({
      createContext: () => {
        const c = new MockAudioContext();
        c.resume = () => Promise.reject(new Error('nope'));
        return c as unknown as AudioContext;
      },
    });
    await expect(audio.resume()).resolves.toBeUndefined();
    expect(() => audio.update(RUN, DT)).not.toThrow();
  });
});

describe('createAudio lifecycle', () => {
  it('creates the context lazily on resume() (first user gesture), and only once', async () => {
    let made = 0;
    const audio = createAudio({ createContext: () => { made++; return new MockAudioContext() as unknown as AudioContext; } });
    audio.update(RUN, DT);
    expect(made).toBe(0);
    await audio.resume();
    await audio.resume();
    expect(made).toBe(1);
    expect((audio.context as unknown as MockAudioContext).state).toBe('running');
  });
  it('applies the inputs received before the gesture as soon as the graph exists', async () => {
    const audio = createAudio({ createContext: () => new MockAudioContext() as unknown as AudioContext });
    audio.update(inp({ rpm: 2700, power: 1 }), DT);
    await audio.resume();
    expect(audio.levels().exhaust).toBeGreaterThan(0.5);
  });
  it('dispose closes the context and later calls are harmless', async () => {
    const { audio, ctx } = await makeAudio();
    audio.dispose();
    expect(ctx.state).toBe('closed');
    expect(() => audio.update(RUN, DT)).not.toThrow();
    await expect(audio.resume()).resolves.toBeUndefined();
  });
  it('an injected (offline) context builds the graph immediately', () => {
    const ctx = new MockAudioContext();
    const audio = createAudio({ context: ctx as unknown as BaseAudioContext });
    audio.update(RUN, DT);
    expect(audio.levels().exhaust).toBeGreaterThan(0);
    expect(ctx.count('oscillator')).toBeGreaterThan(3);
  });
});

describe('engine', () => {
  it('drives the oscillators at the cycle, firing and blade-pass frequencies', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, inp({ rpm: 2400 }), 0.2);
    const L = audio.levels();
    expect(L.cycleHz).toBeCloseTo(cycleFrequency(2400), 6);
    expect(L.firingHz).toBeCloseTo(firingFrequency(2400), 6);
    expect(L.bladeHz).toBeCloseTo(bladePassFrequency(2400), 6);
    const freqs = ctx.nodes.filter((n) => n.kind === 'oscillator').map((o) => (o as unknown as { frequency: { value: number } }).frequency.value);
    expect(freqs.some((f) => Math.abs(f - 20) < 1e-6)).toBe(true); // 2400/120
    expect(freqs.some((f) => Math.abs(f - 80) < 1e-6)).toBe(true); // firing = blade pass
  });
  it('is louder at full power than at idle, and silent when stopped', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, inp({ rpm: 700, power: 0.045 }), 0.1);
    const idle = audio.levels();
    run(audio, ctx, inp({ rpm: 2700, power: 1 }), 0.1);
    const full = audio.levels();
    expect(full.exhaust).toBeGreaterThan(idle.exhaust);
    expect(full.prop).toBeGreaterThan(idle.prop);
    run(audio, ctx, { ...IDLE }, 0.1);
    expect(audio.levels().exhaust).toBe(0);
    expect(audio.levels().prop).toBe(0);
  });
  it('the levels are the mapping values scaled by the configured volumes', async () => {
    const { audio, ctx } = await makeAudio();
    const a = inp({ rpm: 2100, power: 0.6 });
    run(audio, ctx, a, 0.1);
    const m = engineMix({ rpm: 2100, power: 0.6, engineRunning: true, starting: false, crashed: false });
    expect(audio.levels().exhaust).toBeCloseTo(m.exhaust, 9);
    expect(audio.levels().engineVolume).toBeCloseTo(A.engineVolume, 9);
  });
  it('starter cranks while starting; the catch plays a burst', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, inp({ rpm: 180, power: 0, engineRunning: false, starting: true, onGround: true, airspeedKt: 0 }), 0.5);
    expect(audio.levels().starter).toBeGreaterThan(0);
    const before = ctx.started('bufferSource');
    run(audio, ctx, inp({ rpm: 500, power: 0.05, engineRunning: true, starting: false, onGround: true, airspeedKt: 0 }), 0.05);
    expect(audio.levels().starter).toBe(0);
    expect(ctx.started('bufferSource')).toBeGreaterThan(before);
  });
  it('doppler raises the pitch of an approaching aircraft in exterior views only', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, inp({ cameraMode: 'external', closingSpeedMs: 50 }), 0.05);
    expect(audio.levels().doppler).toBeGreaterThan(1.1);
    expect(audio.levels().cycleHz).toBeGreaterThan(cycleFrequency(2400) * 1.1);
    run(audio, ctx, inp({ cameraMode: 'cockpit', closingSpeedMs: 50 }), 0.05);
    expect(audio.levels().doppler).toBe(1);
  });
});

describe('view', () => {
  it('cockpit muffles through the cabin low-pass; exterior is open; cabin sounds fade outside', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, inp({ cameraMode: 'cockpit' }), 0.05);
    expect(audio.levels().viewCutoff).toBe(A.cabinCutoffHz);
    expect(audio.levels().cabin).toBe(1);
    run(audio, ctx, inp({ cameraMode: 'chase' }), 0.05);
    expect(audio.levels().viewCutoff).toBe(A.exteriorCutoffHz);
    expect(audio.levels().cabin).toBeLessThan(0.3);
  });
  it('far exterior cameras attenuate', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, inp({ cameraMode: 'external', listenerDistanceM: 400 }), 0.05);
    expect(audio.levels().distance).toBeLessThan(0.1);
  });
});

describe('master / mute / pause', () => {
  it('mute and pause ramp the master to 0; unmute restores the configured volume', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, RUN, 0.05);
    expect(audio.levels().master).toBeCloseTo(A.masterVolume, 9);
    audio.setMuted(true);
    expect(audio.muted).toBe(true);
    expect(audio.levels().master).toBe(0);
    run(audio, ctx, RUN, 0.05);
    expect(audio.levels().master).toBe(0);
    audio.setMuted(false);
    run(audio, ctx, RUN, 0.05);
    expect(audio.levels().master).toBeCloseTo(A.masterVolume, 9);
    run(audio, ctx, inp({ paused: true }), 0.05);
    expect(audio.levels().master).toBe(0);
  });
  it('no clicks: after construction every continuous param only moves via setTargetAtTime', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, RUN, 0.05);
    const params = allParams(ctx);
    const direct = params.map((p) => p.directSets);
    run(audio, ctx, inp({ rpm: 900, power: 0.1, cameraMode: 'cockpit', stallWarning: true, gearMoving: true }), 0.3);
    run(audio, ctx, inp({ rpm: 2700, power: 1, cameraMode: 'orbit' }), 0.3);
    audio.setMuted(true);
    expect(params.map((p) => p.directSets)).toEqual(direct);
    for (const p of params) for (const e of p.events) if (e.type === 'target') expect(e.tau!).toBeGreaterThan(0.005);
  });
  it('does not flood the automation timeline when nothing changes', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, RUN, 0.1);
    const count = () => allParams(ctx).reduce((s, p) => s + p.events.length, 0);
    const before = count();
    run(audio, ctx, RUN, 1);
    expect(count() - before).toBeLessThan(20);
  });
});

describe('warnings and systems', () => {
  it('stall horn follows the warning (needs airflow)', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, inp({ stallWarning: true, airspeedKt: 50 }), 0.05);
    expect(audio.levels().horn).toBeCloseTo(A.stallHornVolume, 9);
    run(audio, ctx, inp({ stallWarning: false, airspeedKt: 50 }), 0.05);
    expect(audio.levels().horn).toBe(0);
  });
  it('gear warning horn follows the warning, is silent in a wreck, and is a different sound from the stall horn', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, inp({ gearWarning: true, cameraMode: 'cockpit' }), 0.05);
    expect(audio.levels().gearHorn).toBeCloseTo(A.gearHornVolume, 9);
    expect(audio.levels().horn).toBe(0);
    run(audio, ctx, inp({ gearWarning: false }), 0.05);
    expect(audio.levels().gearHorn).toBe(0);
    run(audio, ctx, inp({ gearWarning: true, crashed: true }), 0.05);
    expect(audio.levels().gearHorn).toBe(0);
    // Distinct: lower, electronic tone vs the ~1.8 kHz reed; intermittent at a few Hz.
    expect(A.gearHornHz).toBeLessThan(A.stallHornHz * 0.6);
    expect(A.gearHornRateHz).toBeGreaterThanOrEqual(1.5);
    expect(A.gearHornRateHz).toBeLessThanOrEqual(4);
  });
  it('the gear horn works without the optional input (old callers): silent', async () => {
    const { audio, ctx } = await makeAudio();
    const a = { ...RUN } as AudioInputs;
    delete (a as Partial<AudioInputs>).gearWarning;
    run(audio, ctx, a, 0.05);
    expect(audio.levels().gearHorn).toBe(0);
  });
  it('gear motor hums while moving and clunks when it locks; flap motor whines', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, inp({ gearMoving: true, flapsMoving: true }), 0.5);
    expect(audio.levels().gear).toBeGreaterThan(0);
    expect(audio.levels().flap).toBeGreaterThan(0);
    const shots = audio.levels().oneShots;
    run(audio, ctx, inp({ gearMoving: false, flapsMoving: false }), 0.05);
    expect(audio.levels().gear).toBe(0);
    expect(audio.levels().flap).toBe(0);
    expect(audio.levels().oneShots).toBe(shots + 1);
  });
  it('wind rises with airspeed, whistle in the cockpit only', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, inp({ airspeedKt: 40 }), 0.05);
    const slow = audio.levels().wind;
    run(audio, ctx, inp({ airspeedKt: 130, cameraMode: 'cockpit' }), 0.05);
    expect(audio.levels().wind).toBeGreaterThan(slow);
    expect(audio.levels().whistle).toBeGreaterThan(0);
    run(audio, ctx, inp({ airspeedKt: 130, cameraMode: 'chase' }), 0.05);
    expect(audio.levels().whistle).toBe(0);
  });
  it('rolling rumble on the ground only; brakes scrub', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, inp({ onGround: true, groundSpeedKt: 40, surface: 'grass', brake: 1 }), 0.05);
    expect(audio.levels().rolling).toBeGreaterThan(0);
    expect(audio.levels().scrub).toBeGreaterThan(0);
    run(audio, ctx, inp({ onGround: false, groundSpeedKt: 40 }), 0.05);
    expect(audio.levels().rolling).toBe(0);
  });
});

describe('one-shots', () => {
  it('touchdown plays once per event, harder = louder', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, inp({ onGround: true }), 0.05);
    const s0 = audio.levels().oneShots;
    audio.update(inp({ onGround: true, touchdownFpm: -120 }), DT);
    const soft = audio.levels().lastTouchdown;
    run(audio, ctx, inp({ onGround: true }), 0.3);
    audio.update(inp({ onGround: true, touchdownFpm: -800 }), DT);
    const hard = audio.levels().lastTouchdown;
    expect(audio.levels().oneShots).toBe(s0 + 2);
    expect(hard).toBeGreaterThan(soft);
  });
  it('crash: boom + debris once, engine cut, fire bed; reset restores', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, inp({ rpm: 2500, power: 0.9 }), 0.1);
    const sources = ctx.started('bufferSource');
    run(audio, ctx, inp({ rpm: 2500, power: 0.9, crashed: true, crashSpeedKt: 90 }), 0.5);
    expect(ctx.started('bufferSource')).toBeGreaterThan(sources + 5);
    expect(audio.levels().exhaust).toBe(0);
    expect(audio.levels().prop).toBe(0);
    expect(audio.levels().fire).toBeGreaterThan(0);
    const shots = audio.levels().oneShots;
    run(audio, ctx, inp({ crashed: true }), 0.5);
    expect(audio.levels().oneShots).toBe(shots); // no retrigger (crackles are not counted as events)
    run(audio, ctx, { ...IDLE }, 0.1);
    expect(audio.levels().fire).toBe(0);
  });
  it('one-shot sources are stopped (released) after they finish', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, RUN, 0.05);
    const before = ctx.nodes.length;
    audio.update(inp({ touchdownFpm: -500 }), DT);
    const oneShot = ctx.nodes.slice(before).filter((n) => n.kind === 'bufferSource' || n.kind === 'oscillator');
    expect(oneShot.length).toBeGreaterThan(0);
    for (const n of oneShot) {
      const s = n as unknown as { started: number | null; stopped: number | null };
      expect(s.started).not.toBeNull();
      expect(s.stopped).not.toBeNull();
      expect(s.stopped!).toBeGreaterThan(s.started!);
      expect(s.stopped! - s.started!).toBeLessThan(4);
    }
  });
});

describe('fuzz', () => {
  const MODES: CameraMode[] = ['cockpit', 'chase', 'external', 'orbit'];
  const SURF: SurfaceType[] = ['runway', 'grass', 'water', 'rock', 'snow'];
  const wild = fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity, 0, -0, 1e300));
  const inputs = fc.record({
    rpm: wild, power: wild, engineRunning: fc.boolean(), starting: fc.boolean(), airspeedKt: wild, onGround: fc.boolean(),
    groundSpeedKt: wild, stallWarning: fc.boolean(), gearMoving: fc.boolean(), flapsMoving: fc.boolean(),
    touchdownFpm: fc.option(wild, { nil: null }), crashed: fc.boolean(), cameraMode: fc.constantFrom(...MODES),
    paused: fc.boolean(), brake: wild, surface: fc.constantFrom(...SURF),
    listenerDistanceM: fc.option(wild, { nil: undefined }), closingSpeedMs: fc.option(wild, { nil: undefined }),
    crashSpeedKt: fc.option(wild, { nil: undefined }),
  });
  it('random input sequences never throw and never schedule a non-finite value', async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.tuple(inputs, wild, fc.boolean()), { minLength: 1, maxLength: 40 }), async (seq) => {
      violations.length = 0;
      const { audio, ctx } = await makeAudio();
      for (const [a, dt, mute] of seq) {
        ctx.advance(Number.isFinite(dt) ? Math.min(Math.abs(dt), 1) : DT);
        audio.update(a as AudioInputs, dt);
        if (mute) audio.setMuted(!audio.muted);
      }
      expect(violations).toEqual([]);
      expect(audio.levels().errors).toBe(0);
      for (const v of Object.values(audio.levels())) expect(Number.isFinite(v)).toBe(true);
      audio.dispose();
    }), { numRuns: 60 });
  }, 30_000);
});
