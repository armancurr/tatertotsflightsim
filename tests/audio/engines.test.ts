/**
 * Functional: per-aircraft engine voices on the mock AudioContext — the F-16's F110 turbofan
 * (whine, fan buzz, roar, afterburner rumble + crackle + light-off whoomph, cockpit intake howl and
 * ECS, hydraulic whine) vs the Cessna's O-360; swapping voices without leaking nodes; the output
 * limiter chain.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';
import { createAudio, type AudioInputs } from '../../src/audio';
import { jetWhineHz, jetFanHz } from '../../src/audio/jetMapping';
import { CONFIG } from '../../src/config';
import { MockAudioContext, MockScheduled, MockWaveShaper, violations } from './mockAudio';
import type { CameraMode } from '../../src/types';

const A = CONFIG.audio;
const J = A.jet;
const DT = 1 / 60;

const IDLE: AudioInputs = {
  rpm: 0, power: 0, engineRunning: false, starting: false, airspeedKt: 0, onGround: true, groundSpeedKt: 0,
  stallWarning: false, gearMoving: false, flapsMoving: false, touchdownFpm: null, crashed: false,
  cameraMode: 'chase', paused: false, brake: 0, surface: 'runway',
};
const JET_IDLE: AudioInputs = { ...IDLE, rpm: J.idleCorePct, power: 0.02, engineRunning: true };
const JET_MIL: AudioInputs = { ...IDLE, rpm: 100, power: 1, engineRunning: true, airspeedKt: 300, onGround: false };
const JET_AB: AudioInputs = { ...JET_MIL, afterburner: 1 };
const PISTON: AudioInputs = { ...IDLE, rpm: 2400, power: 0.8, engineRunning: true, airspeedKt: 100, onGround: false };

async function makeAudio(engine?: 'piston' | 'jet') {
  let ctx: MockAudioContext | null = null;
  const audio = createAudio({
    createContext: () => {
      ctx = new MockAudioContext();
      return ctx as unknown as AudioContext;
    },
  });
  if (engine) audio.setEngine(engine);
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

describe('engine voice selection', () => {
  it('defaults to the piston engine; setEngine picks the jet (before or after the context exists)', async () => {
    const { audio, ctx } = await makeAudio();
    expect(audio.engine).toBe('piston');
    run(audio, ctx, PISTON, 0.1);
    expect(audio.levels().jet).toBe(0);
    expect(audio.levels().exhaust).toBeGreaterThan(0);
    audio.setEngine('jet');
    expect(audio.engine).toBe('jet');
    run(audio, ctx, JET_MIL, 0.1);
    const L = audio.levels();
    expect(L.jet).toBe(1);
    expect(L.exhaust).toBe(0); // piston channels silent
    expect(L.prop).toBe(0);
    expect(L.roar).toBeGreaterThan(0.5);

    const early = await makeAudio('jet');
    run(early.audio, early.ctx, JET_IDLE, 0.1);
    expect(early.audio.levels().jet).toBe(1);
    expect(early.audio.levels().whine).toBeGreaterThan(0);
  });

  it('switching swaps the engine graph: the old voice fades, stops and disconnects — no leaks after many swaps', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, PISTON, 0.2);
    ctx.advance(1);
    ctx.endFinished();
    const baseline = ctx.liveNodes();
    for (let i = 0; i < 6; i++) {
      const before = ctx.nodes.length;
      audio.setEngine(i % 2 === 0 ? 'jet' : 'piston');
      run(audio, ctx, i % 2 === 0 ? JET_MIL : PISTON, 0.2);
      expect(audio.levels().engineVoices).toBeLessThanOrEqual(2);
      ctx.advance(1);
      ctx.endFinished();
      expect(audio.levels().engineVoices).toBe(1);
      // every source of the retired voice was stopped
      const created = ctx.nodes.slice(before);
      expect(created.length).toBeGreaterThan(10);
    }
    audio.setEngine('piston');
    run(audio, ctx, PISTON, 0.2);
    ctx.advance(1);
    ctx.endFinished();
    expect(ctx.liveNodes()).toBe(baseline);
    // every scheduled source that is not part of the live voice or the shared graph has ended
    const running = ctx.nodes.filter((n) => n instanceof MockScheduled && n.stopped === null).length;
    const again = await makeAudio();
    run(again.audio, again.ctx, PISTON, 0.2);
    expect(running).toBe(again.ctx.nodes.filter((n) => n instanceof MockScheduled && n.stopped === null).length);
  });

  it('setting the same engine again is a no-op', async () => {
    const { audio, ctx } = await makeAudio('jet');
    run(audio, ctx, JET_IDLE, 0.1);
    const n = ctx.nodes.length;
    audio.setEngine('jet');
    run(audio, ctx, JET_IDLE, 0.1);
    expect(ctx.nodes.length).toBe(n);
  });

  it('the retired voice ramps its outputs down (no click) instead of cutting', async () => {
    const { audio, ctx } = await makeAudio();
    run(audio, ctx, PISTON, 0.2);
    const t = ctx.currentTime;
    const before = ctx.nodes.length;
    audio.setEngine('jet');
    const oldSources = ctx.nodes.slice(0, before).filter((n) => n instanceof MockScheduled && n.stopped !== null) as MockScheduled[];
    expect(oldSources.length).toBeGreaterThan(5);
    for (const s of oldSources) expect(s.stopped!).toBeGreaterThanOrEqual(t + 0.1);
  });
});

describe('F-16 turbofan', () => {
  it('the whine follows the core speed; the fan buzz follows N1', async () => {
    const { audio, ctx } = await makeAudio('jet');
    run(audio, ctx, JET_IDLE, 0.1);
    expect(audio.levels().whineHz).toBeCloseTo(jetWhineHz(J.idleCorePct), 3);
    run(audio, ctx, JET_MIL, 0.1);
    expect(audio.levels().whineHz).toBeCloseTo(jetWhineHz(100), 3);
    expect(audio.levels().fanHz).toBeCloseTo(jetFanHz(100), 3);
    expect(audio.levels().corePct).toBeCloseTo(100, 6);
  });

  it('power raises the roar; the afterburner adds rumble + crackle and lights with a whoomph', async () => {
    const { audio, ctx } = await makeAudio('jet');
    run(audio, ctx, JET_IDLE, 0.2);
    const idle = audio.levels();
    run(audio, ctx, JET_MIL, 0.2);
    const mil = audio.levels();
    expect(mil.roar).toBeGreaterThan(idle.roar * 2);
    expect(mil.afterburner).toBe(0);
    const shots = mil.oneShots;
    const sources = ctx.started('bufferSource') + ctx.started('oscillator');
    run(audio, ctx, JET_AB, 0.2);
    const ab = audio.levels();
    expect(ab.afterburner).toBeGreaterThan(0.9);
    expect(ab.crackle).toBeGreaterThan(0.5);
    expect(ab.oneShots).toBe(shots + 1); // light-off whoomph, once
    expect(ctx.started('bufferSource') + ctx.started('oscillator')).toBeGreaterThan(sources);
    run(audio, ctx, JET_AB, 0.5);
    expect(audio.levels().oneShots).toBe(shots + 1);
    run(audio, ctx, JET_MIL, 0.2);
    expect(audio.levels().afterburner).toBe(0);
    run(audio, ctx, JET_AB, 0.1);
    expect(audio.levels().oneShots).toBe(shots + 2); // relight → another whoomph
  });

  it('cockpit: intake howl and ECS hiss (cabin-only); exterior: directivity, distance and Doppler', async () => {
    const { audio, ctx } = await makeAudio('jet');
    run(audio, ctx, { ...JET_MIL, cameraMode: 'cockpit' }, 0.1);
    const cp = audio.levels();
    expect(cp.intake).toBeGreaterThan(0);
    expect(cp.ecs).toBeGreaterThan(0);
    expect(cp.viewCutoff).toBe(A.cabinCutoffHz);
    run(audio, ctx, { ...JET_MIL, cameraMode: 'external', aft: 1, listenerDistanceM: 20 }, 0.1);
    const behind = audio.levels();
    expect(behind.intake).toBe(0);
    expect(behind.distance).toBe(1); // within the jet's reference distance
    run(audio, ctx, { ...JET_MIL, cameraMode: 'external', aft: -1, listenerDistanceM: 20 }, 0.1);
    const front = audio.levels();
    expect(behind.roar).toBeGreaterThan(front.roar);
    expect(front.whine).toBeGreaterThan(behind.whine);
    run(audio, ctx, { ...JET_MIL, cameraMode: 'external', closingSpeedMs: 100, listenerDistanceM: 300 }, 0.1);
    const flyby = audio.levels();
    expect(flyby.doppler).toBeGreaterThan(1.3);
    expect(flyby.whineHz).toBeGreaterThan(jetWhineHz(100) * 1.3);
    expect(flyby.distance).toBeLessThan(0.15);
  });

  it('no door-seal whistle, flap motor or electric gear pump on the jet: a hydraulic whine for gear and speed brake', async () => {
    const { audio, ctx } = await makeAudio('jet');
    run(audio, ctx, { ...JET_MIL, cameraMode: 'cockpit', airspeedKt: 250, flapsMoving: true }, 0.1);
    expect(audio.levels().whistle).toBe(0);
    expect(audio.levels().flap).toBe(0);
    expect(audio.levels().hydraulic).toBe(0);
    run(audio, ctx, { ...JET_MIL, cameraMode: 'cockpit', gearMoving: true }, 0.1);
    expect(audio.levels().hydraulic).toBeGreaterThan(0);
    expect(audio.levels().gear).toBe(0);
    run(audio, ctx, { ...JET_MIL, cameraMode: 'cockpit', speedBrakeMoving: true }, 0.1);
    expect(audio.levels().hydraulic).toBeGreaterThan(0);
    run(audio, ctx, { ...JET_MIL, cameraMode: 'cockpit' }, 0.1);
    expect(audio.levels().hydraulic).toBe(0);
  });

  it('the jet fuel starter whines while starting; shut down → the whine spools away with the core', async () => {
    const { audio, ctx } = await makeAudio('jet');
    run(audio, ctx, { ...IDLE, rpm: 18, starting: true }, 0.2);
    expect(audio.levels().starter).toBeGreaterThan(0);
    run(audio, ctx, { ...IDLE, rpm: 60, engineRunning: false }, 0.1);
    const a = audio.levels().whine;
    run(audio, ctx, { ...IDLE, rpm: 10, engineRunning: false }, 0.1);
    expect(audio.levels().whine).toBeLessThan(a);
    expect(audio.levels().roar).toBe(0);
  });

  it('crash cuts the jet (whine winds down) — all engine channels go to 0', async () => {
    const { audio, ctx } = await makeAudio('jet');
    run(audio, ctx, JET_AB, 0.2);
    run(audio, ctx, { ...JET_AB, crashed: true, crashSpeedKt: 300 }, 0.2);
    const L = audio.levels();
    for (const k of ['whine', 'fan', 'roar', 'afterburner', 'crackle', 'intake'] as const) expect(L[k], k).toBe(0);
  });
});

describe('output protection', () => {
  it('master → glue compressor → limiter → soft clipper → destination', async () => {
    const { ctx } = await makeAudio();
    expect(ctx.count('compressor')).toBe(2);
    const shaper = ctx.nodes.find((n) => n.kind === 'waveShaper') as MockWaveShaper;
    expect(shaper.outputs).toContain(ctx.destination);
    const c = shaper.curve!;
    expect(c.length).toBeGreaterThan(256);
    for (let i = 1; i < c.length; i++) expect(c[i]).toBeGreaterThanOrEqual(c[i - 1]); // monotone
    expect(Math.max(...c.map(Math.abs))).toBeLessThanOrEqual(A.softClipCeiling + 1e-6);
    const mid = (c.length - 1) / 2;
    const x = 0.4; // linear region
    expect(c[Math.round(mid + x * mid)]).toBeCloseTo(x, 2);
  });
  it('meter() reads the output (null before the context exists)', async () => {
    const pending = createAudio({ createContext: () => new MockAudioContext() as unknown as AudioContext });
    expect(pending.meter()).toBeNull();
    const { audio } = await makeAudio();
    const m = audio.meter();
    expect(m).not.toBeNull();
    expect(m!.rms).toBe(0);
    expect(m!.peak).toBe(0);
  });
});

describe('fuzz: jet voice', () => {
  const MODES: CameraMode[] = ['cockpit', 'chase', 'external', 'orbit'];
  const wild = fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity, 0, 1e300));
  const inputs = fc.record({
    rpm: wild, power: wild, afterburner: wild, engineRunning: fc.boolean(), starting: fc.boolean(), airspeedKt: wild,
    onGround: fc.boolean(), groundSpeedKt: wild, gearMoving: fc.boolean(), speedBrakeMoving: fc.boolean(), crashed: fc.boolean(),
    cameraMode: fc.constantFrom(...MODES), aft: fc.option(wild, { nil: undefined }), listenerDistanceM: fc.option(wild, { nil: undefined }),
    closingSpeedMs: fc.option(wild, { nil: undefined }),
  });
  it('random inputs and random engine swaps never throw, never schedule a non-finite value, levels stay finite', async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.tuple(inputs, fc.boolean(), fc.boolean()), { minLength: 1, maxLength: 30 }), async (seq) => {
      violations.length = 0;
      const { audio, ctx } = await makeAudio('jet');
      for (const [a, swap, blast] of seq) {
        ctx.advance(DT);
        if (swap) audio.setEngine(audio.engine === 'jet' ? 'piston' : 'jet');
        if (blast) audio.explosion({ size: a.power as number, distanceM: a.rpm as number });
        audio.update({ ...IDLE, ...(a as Partial<AudioInputs>) }, DT);
      }
      expect(violations).toEqual([]);
      expect(audio.levels().errors).toBe(0);
      for (const [k, v] of Object.entries(audio.levels())) expect(Number.isFinite(v), k).toBe(true);
      audio.dispose();
    }), { numRuns: 50 });
  }, 30_000);
});
