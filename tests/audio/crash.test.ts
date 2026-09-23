/**
 * Functional: the crash sound design on the mock AudioContext — a layered impact (boom, crunch,
 * metal tearing, debris clatter, scraping), randomised secondary explosions (or the crash effects'
 * own `sim:explosion` / `sim:impact` events), the burning fire bed, the engine cut, and a reset that
 * silences all of it cleanly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createAudio, type AudioInputs } from '../../src/audio';
import { CONFIG } from '../../src/config';
import { MockAudioContext, MockScheduled, MockGain, violations } from './mockAudio';

const C = CONFIG.audio.crash;
const DT = 1 / 60;

const IDLE: AudioInputs = {
  rpm: 0, power: 0, engineRunning: false, starting: false, airspeedKt: 0, onGround: true, groundSpeedKt: 0,
  stallWarning: false, gearMoving: false, flapsMoving: false, touchdownFpm: null, crashed: false,
  cameraMode: 'chase', paused: false, brake: 0, surface: 'runway',
};
const FLYING: AudioInputs = { ...IDLE, rpm: 2500, power: 0.9, engineRunning: true, airspeedKt: 110, onGround: false };
const CRASHED: AudioInputs = { ...FLYING, crashed: true, crashSpeedKt: 110 };

async function makeAudio(seed = 4711) {
  let ctx: MockAudioContext | null = null;
  const audio = createAudio({
    seed,
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

const sourcesSince = (ctx: MockAudioContext, from: number) =>
  ctx.nodes.slice(from).filter((n) => n instanceof MockScheduled) as MockScheduled[];

beforeEach(() => {
  violations.length = 0;
});
afterEach(() => {
  expect(violations).toEqual([]);
});

describe('crash: layered impact', () => {
  it('the impact is massive and layered: boom + crunch + metal tearing + clatter + scraping, spread over seconds', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, FLYING, 0.1);
    const from = ctx.nodes.length;
    const t0 = ctx.currentTime + DT;
    run(audio, ctx, CRASHED, DT);
    const src = sourcesSince(ctx, from);
    expect(src.length).toBeGreaterThan(40);
    const oscs = src.filter((s) => s.kind === 'oscillator') as unknown as { frequency: { events: { value: number }[] } }[];
    // a sub-bass boom (sweeping down below 40 Hz)
    expect(oscs.some((o) => o.frequency.events.some((e) => e.value < 40))).toBe(true);
    // the layers keep coming for a couple of seconds (debris, scraping), all scheduled with stop times
    const starts = src.map((s) => s.started! - t0);
    expect(Math.max(...starts)).toBeGreaterThan(1.5);
    for (const s of src) {
      expect(s.stopped).not.toBeNull();
      expect(s.stopped! - s.started!).toBeLessThan(8);
    }
    expect(audio.levels().crashes).toBe(1);
  });

  it('cuts the engine, lights the fire bed and plans secondary explosions', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, FLYING, 0.1);
    run(audio, ctx, CRASHED, 0.2);
    const L = audio.levels();
    expect(L.exhaust).toBe(0);
    expect(L.prop).toBe(0);
    expect(L.fire).toBeGreaterThan(0);
    expect(L.pendingExplosions).toBeGreaterThanOrEqual(C.secondaryMin);
    expect(L.pendingExplosions).toBeLessThanOrEqual(C.secondaryMax);
  });

  it('secondary explosions go off on their randomised schedule, then the fire burns down', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, FLYING, 0.1);
    run(audio, ctx, CRASHED, 0.2);
    const planned = audio.levels().pendingExplosions;
    run(audio, ctx, CRASHED, C.secondaryLastS + 0.5);
    expect(audio.levels().pendingExplosions).toBe(0);
    expect(audio.levels().explosions).toBe(planned);
    const early = audio.levels().fire;
    run(audio, ctx, CRASHED, 60);
    expect(audio.levels().fire).toBeLessThan(early * 0.3);
    expect(audio.levels().crashes).toBe(1);
  });

  it('the schedule differs between crashes (randomised per crash)', async () => {
    const times: number[][] = [];
    for (const seed of [1, 2]) {
      const { audio, ctx } = await makeAudio(seed);
      run(audio, ctx, FLYING, 0.1);
      run(audio, ctx, CRASHED, 0.1);
      const seen: number[] = [];
      let last = 0;
      for (let i = 0; i < 600; i++) {
        run(audio, ctx, CRASHED, DT);
        if (audio.levels().explosions > last) {
          last = audio.levels().explosions;
          seen.push(Math.round(i * DT * 100) / 100);
        }
      }
      times.push(seen);
    }
    expect(times[0]).not.toEqual(times[1]);
  });

  it('pausing freezes the crash timeline (no explosions while paused)', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, FLYING, 0.1);
    run(audio, ctx, CRASHED, 0.1);
    run(audio, ctx, { ...CRASHED, paused: true }, 20);
    expect(audio.levels().explosions).toBe(0);
    expect(audio.levels().master).toBe(0);
  });
});

describe('crash: window events from the crash effects', () => {
  it('sim:explosion plays an explosion and takes over from the randomised schedule', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, FLYING, 0.1);
    run(audio, ctx, CRASHED, 0.1);
    expect(audio.levels().pendingExplosions).toBeGreaterThan(0);
    const from = ctx.nodes.length;
    audio.explosion({ size: 1, distanceM: 30 });
    expect(sourcesSince(ctx, from).length).toBeGreaterThan(3);
    expect(audio.levels().explosions).toBe(1);
    expect(audio.levels().pendingExplosions).toBe(0);
    run(audio, ctx, CRASHED, C.secondaryLastS + 1);
    expect(audio.levels().explosions).toBe(1);
  });

  it('sim:impact plays a crunch scaled by speed; far events are quieter; floods are rate-limited', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, CRASHED, 0.1);
    const peakOf = (from: number) =>
      Math.max(...(ctx.nodes.slice(from).filter((n) => n.kind === 'gain') as MockGain[]).flatMap((g) => g.gain.events.map((e) => e.value)));
    let from = ctx.nodes.length;
    audio.impact({ speed: 40, distanceM: 10 });
    const near = peakOf(from);
    ctx.advance(2);
    from = ctx.nodes.length;
    audio.impact({ speed: 40, distanceM: 800 });
    const far = peakOf(from);
    expect(near).toBeGreaterThan(far * 3);
    ctx.advance(2);
    const before = audio.levels().impacts;
    for (let i = 0; i < 100; i++) audio.impact({ speed: 20, distanceM: 10 });
    expect(audio.levels().impacts - before).toBeLessThanOrEqual(C.maxImpactsPerS);
    for (let i = 0; i < 100; i++) audio.explosion({ size: 0.5, distanceM: 10 });
    expect(audio.levels().explosions).toBeLessThanOrEqual(C.maxExplosionsPerS);
  });

  it('events with junk payloads are ignored safely', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, CRASHED, 0.1);
    expect(() => audio.explosion({ size: Number.NaN, distanceM: Infinity })).not.toThrow();
    expect(() => audio.impact({ speed: -Infinity, distanceM: Number.NaN })).not.toThrow();
    expect(() => audio.explosion({})).not.toThrow();
    expect(audio.levels().errors).toBe(0);
  });
});

describe('crash: reset silences everything', () => {
  it('reset stops every crash sound, the fire and the pending explosions', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, FLYING, 0.1);
    const from = ctx.nodes.length;
    run(audio, ctx, CRASHED, 0.5);
    expect(audio.levels().crashLive).toBeGreaterThan(10);
    const tReset = ctx.currentTime + DT;
    const exploded = audio.levels().explosions;
    run(audio, ctx, IDLE, DT); // the new state is not crashed
    const L = audio.levels();
    expect(L.pendingExplosions).toBe(0);
    expect(L.fire).toBe(0);
    for (const s of sourcesSince(ctx, from)) {
      if (s.kind !== 'bufferSource' && s.kind !== 'oscillator') continue;
      expect(s.stopped!).toBeLessThanOrEqual(tReset + 0.3);
    }
    ctx.advance(1);
    ctx.endFinished();
    expect(audio.levels().crashLive).toBe(0);
    // nothing new plays afterwards
    const after = ctx.nodes.length;
    run(audio, ctx, IDLE, 12);
    expect(ctx.nodes.length).toBe(after);
    expect(audio.levels().explosions).toBe(exploded);
  });

  it('reset() (the system hook) also silences an ongoing crash and re-arms for the next one', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, FLYING, 0.1);
    run(audio, ctx, CRASHED, 0.3);
    audio.reset();
    expect(audio.levels().pendingExplosions).toBe(0);
    expect(audio.levels().fire).toBe(0);
    ctx.advance(1);
    ctx.endFinished();
    expect(audio.levels().crashLive).toBe(0);
    run(audio, ctx, FLYING, 0.2);
    run(audio, ctx, CRASHED, 0.2);
    expect(audio.levels().crashes).toBe(2);
    expect(audio.levels().pendingExplosions).toBeGreaterThan(0);
  });

  it('no node leak across many crash/reset cycles', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, FLYING, 0.1);
    ctx.advance(1);
    ctx.endFinished();
    const baseline = ctx.liveNodes();
    for (let i = 0; i < 4; i++) {
      run(audio, ctx, CRASHED, 3);
      audio.explosion({ size: 0.7, distanceM: 50 });
      audio.impact({ speed: 30, distanceM: 20 });
      run(audio, ctx, FLYING, 0.2);
      ctx.advance(2);
      ctx.endFinished();
    }
    expect(ctx.liveNodes()).toBe(baseline);
  });
});
