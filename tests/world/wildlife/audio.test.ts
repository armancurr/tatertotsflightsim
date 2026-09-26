import { describe, expect, it } from 'vitest';
import { airCutoff, createWildlifeAudio, distanceGain, gullCallRate, panOf, RANGES, type WildlifeListener } from '../../../src/audio/wildlife';
import { MockAudioContext, violations } from '../../audio/mockAudio';

const listener = (over: Partial<WildlifeListener> = {}): WildlifeListener => ({
  x: 0, y: 2, z: 0, rx: 1, ry: 0, rz: 0, paused: false, dt: 1 / 60,
  gulls: { x: [5, 30, 900], y: [8, 10, 10], z: [5, -20, 0], visible: [1, 1, 1] }, gullCount: 3, ...over,
});

/** Seeded PRNG so the call stream is reproducible. */
const prng = (seed: number) => () => {
  seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  return seed / 4294967296;
};

async function started() {
  let ctx: MockAudioContext | null = null;
  const a = createWildlifeAudio({ createContext: () => (ctx = new MockAudioContext()) as unknown as BaseAudioContext, target: null, random: prng(12345) });
  await a.resume();
  return { a, ctx: ctx as unknown as MockAudioContext };
}

describe('wildlife audio: mappings', () => {
  it('distance gain falls with distance and is silent past the range', () => {
    const R = RANGES.blow;
    let prev = Infinity;
    for (let d = 0; d < R.max * 1.2; d += 50) {
      const g = distanceGain(d, R.ref, R.max);
      expect(g).toBeLessThanOrEqual(prev + 1e-12);
      expect(g).toBeGreaterThanOrEqual(0);
      expect(g).toBeLessThanOrEqual(1);
      prev = g;
    }
    expect(distanceGain(R.max, R.ref, R.max)).toBe(0);
    expect(distanceGain(Number.NaN, 1, 10)).toBe(0);
  });

  it('pans to the side the source is on, calls more often with more gulls, air dulls far sounds', () => {
    expect(panOf(10, 0, 0, 1, 0, 0)).toBeGreaterThan(0.5);
    expect(panOf(-10, 0, 0, 1, 0, 0)).toBeLessThan(-0.5);
    expect(panOf(0, 0, -10, 1, 0, 0)).toBeCloseTo(0, 6);
    expect(gullCallRate(0)).toBe(0);
    expect(gullCallRate(10)).toBeGreaterThan(gullCallRate(2));
    expect(gullCallRate(1000)).toBeLessThanOrEqual(2.2);
    expect(airCutoff(2000)).toBeLessThan(airCutoff(20));
  });
});

describe('wildlife audio: the synth', () => {
  it('plays a blow near the listener (delayed by the distance), nothing out of range, no invalid automation', async () => {
    violations.length = 0;
    const { a, ctx } = await started();
    a.update(listener());
    const before = ctx.nodes.length;
    a.event('blow', 300, 3, 0, 1);
    expect(ctx.nodes.length).toBeGreaterThan(before);
    expect(a.stats().played.blow).toBe(1);
    const src = ctx.nodes.filter((n) => n.kind === 'bufferSource').pop() as unknown as { started: number };
    expect(src.started).toBeGreaterThan(300 / 343);
    a.event('dolphinBlow', 5000, 0, 0, 1);
    expect(a.stats().played.dolphinBlow).toBeUndefined();
    a.event('breach', 400, 0, 0, 1);
    a.event('flush', 10, 3, 10, 6);
    expect(violations).toEqual([]);
    a.dispose();
  });

  it('gulls near the listener call now and then; far ones do not', async () => {
    const { a } = await started();
    const l = listener();
    for (let k = 0; k < 60 * 30; k++) a.update(l);
    expect(a.stats().played.gull ?? 0).toBeGreaterThan(0);
    const { a: b } = await started();
    const far = listener({ gulls: { x: [5000], y: [10], z: [0], visible: [1] }, gullCount: 1 });
    for (let k = 0; k < 60 * 30; k++) b.update(far);
    expect(b.stats().played.gull ?? 0).toBe(0);
    a.dispose();
    b.dispose();
  });

  it('mute and pause silence the output', async () => {
    const { a, ctx } = await started();
    a.update(listener());
    const master = ctx.nodes.find((n) => n.kind === 'gain') as unknown as { gain: { value: number } };
    expect(master.gain.value).toBe(1);
    a.toggleMute();
    expect(a.muted).toBe(true);
    expect(master.gain.value).toBe(0);
    a.toggleMute();
    a.update(listener({ paused: true }));
    expect(master.gain.value).toBe(0);
    a.dispose();
  });

  it('does nothing (and never throws) before the context exists', () => {
    const a = createWildlifeAudio({ createContext: () => null, target: null });
    a.update(listener());
    a.event('blow', 0, 0, 0, 1);
    expect(a.stats().state).toBe('none');
    a.dispose();
  });
});
