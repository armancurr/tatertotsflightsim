/**
 * Functional (node): the self-test machinery on a mock OfflineAudioContext — its timeline of
 * suspend points really drives the synth (the crash's secondary explosions and the reset happen
 * during the render), and the mix checks judge relative levels and clipping. The audio itself is
 * measured in a real browser by selftest.e2e.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runAudioSelfTest, mixChecks, SCENARIOS, type SelfTestResult } from '../../src/audio/selftest';
import { MockOfflineContext, violations } from './mockAudio';

const factory = (ch: number, len: number, sr: number) => new MockOfflineContext(ch, len, sr) as unknown as OfflineAudioContext;

beforeEach(() => {
  violations.length = 0;
});
afterEach(() => {
  expect(violations).toEqual([]);
});

describe('runAudioSelfTest timeline (mock offline context)', () => {
  it('the crash scenario plays the impact and its secondary explosions during the render', async () => {
    const [r] = await runAudioSelfTest({ factory, only: 'crash (impact', sampleRate: 8000 });
    expect(r.name).toBe('crash (impact + secondary explosions)');
    const m = /(\d+) explosions played/.exec(r.detail);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThanOrEqual(2);
  });

  it('every scenario runs without throwing or scheduling invalid automation', async () => {
    const res = await runAudioSelfTest({ factory, sampleRate: 8000, seconds: 1 });
    expect(res.length).toBe(SCENARIOS.length + mixChecks(res).length);
    for (const r of res) expect(r.detail).not.toMatch(/threw/);
    for (const r of res) expect(Number.isFinite(r.db) && Number.isFinite(r.peak) && Number.isFinite(r.rms)).toBe(true);
  }, 30_000);
});

describe('mix checks', () => {
  const row = (name: string, db: number, peak = 0.5): SelfTestResult => ({ name, rms: 10 ** (db / 20), db, peak, ok: true, detail: '' });
  const good = (): SelfTestResult[] => [
    row('piston idle 700 rpm', -30), row('piston cruise 2400 rpm', -20), row('piston full power 2700 rpm', -18.5),
    row('piston cruise, cockpit', -17), row('jet idle', -27), row('jet MIL (100 %)', -14), row('jet afterburner', -10.5),
    row('jet MIL, cockpit', -20), row('stall horn (cockpit)', -14), row('gear warning horn (cockpit)', -14),
    row('crash (impact + secondary explosions)', -9, 0.9),
  ];
  it('a balanced mix passes', () => {
    const c = mixChecks(good());
    expect(c.length).toBeGreaterThan(8);
    expect(c.filter((x) => !x.ok).map((x) => x.name)).toEqual([]);
  });
  it('flags an afterburner that is not louder than MIL, a quiet jet, and clipping', () => {
    const r = good();
    r.find((x) => x.name === 'jet afterburner')!.db = -18;
    r.find((x) => x.name === 'jet MIL (100 %)')!.db = -19;
    r.find((x) => x.name === 'crash (impact + secondary explosions)')!.peak = 1.2;
    const failed = mixChecks(r).filter((x) => !x.ok).map((x) => x.name);
    expect(failed).toContain('mix: jet MIL < afterburner');
    expect(failed).toContain('mix: the jet is louder than the Cessna');
    expect(failed).toContain('mix: nothing clips (limiter + soft clipper)');
  });
});
