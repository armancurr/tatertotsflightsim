/**
 * E2E: the audio self-test in a real browser (headless Chrome for Testing). Every sound is rendered
 * offline through the real WebAudio graph and output chain (compressor → limiter → soft clipper) and
 * measured: levels, pitch (piston and marine-diesel firing rates, turbine whine, horns), the crash's secondary
 * explosions, silence after a reset — and the mix checks (relative levels, nothing clips).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchChrome, startViteServer, watchProblems, type E2EServer, type PageProblems } from '../support/e2e';
import type { SelfTestResult } from '../../src/audio/selftest';

let server: E2EServer;
let browser: Browser;
let page: Page;
let problems: PageProblems;
let results: SelfTestResult[] = [];

beforeAll(async () => {
  [server, browser] = await Promise.all([startViteServer(), launchChrome()]);
  page = await browser.newPage();
  problems = watchProblems(page);
  await page.goto(`${server.url}tests/audio/selftest.html`, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as unknown as { __audioReady?: boolean }).__audioReady === true, null, { timeout: 30_000 });
  results = (await page.evaluate(() => (window as unknown as { runAudioSelfTest: () => Promise<unknown> }).runAudioSelfTest())) as SelfTestResult[];
  // eslint-disable-next-line no-console
  console.log(results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(46)} ${r.name.startsWith('mix:') ? '' : `${r.db.toFixed(1).padStart(6)} dBFS  peak ${r.peak.toFixed(3)}  `}${r.detail}`).join('\n'));
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const get = (name: string) => {
  const r = results.find((x) => x.name === name);
  if (!r) throw new Error(`no result "${name}"`);
  return r;
};

describe('audio self-test in Chrome for Testing', () => {
  it('every scenario and mix check passes', () => {
    expect(results.length).toBeGreaterThan(25);
    expect(results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`)).toEqual([]);
    expect(problems.all()).toEqual([]);
  });

  it('levels sit in the designed ranges (dBFS RMS)', () => {
    const want: [string, number, number][] = [
      ['piston idle 700 rpm', -32, -20],
      ['piston cruise 2400 rpm', -24, -12],
      ['piston full power 2700 rpm', -22, -10],
      ['piston cruise, cockpit', -26, -13],
      ['jet idle', -28, -16],
      ['jet MIL (100 %)', -19, -8],
      ['jet afterburner', -16, -5],
      ['jet MIL, cockpit', -25, -11],
      ['stall horn (cockpit)', -28, -12],
      ['gear warning horn (cockpit)', -30, -12],
      ['wind 120 kt (engine off)', -34, -18],
      ['crash (impact + secondary explosions)', -16, -2],
      ['marine idle 700 rpm (moored)', -34, -24],
      ['marine cruise 3000 rpm, planing 28 kt', -26, -16],
      ['marine full 3500 rpm, 34 kt', -25, -15],
      ['marine cruise, cockpit (saloon helm)', -29, -18],
      ['marine water at 30 kt (engines silent)', -33, -22],
    ];
    const off = want.filter(([n, lo, hi]) => !(get(n).db >= lo && get(n).db <= hi)).map(([n, lo, hi]) => `${n}: ${get(n).db.toFixed(1)} (want ${lo}…${hi})`);
    expect(off).toEqual([]);
  });

  it('combat: GAU-8/A fundamental ≈ 65 Hz, M61A1 ≈ 100 Hz (outside and in the cockpit); TF34 whistle rises with N1; booms arrive at d / c', () => {
    const hz = (name: string) => Number(/fundamental ([\d.]+) Hz/.exec(get(name).detail)?.[1]);
    expect(hz('GAU-8/A burst (outside, 30 m)')).toBeCloseTo(65, 0);
    expect(hz('GAU-8/A burst (cockpit)')).toBeCloseTo(65, 0);
    expect(hz('M61A1 burst (outside, 30 m)')).toBeCloseTo(100, 0);
    const whistle = (name: string) => Number(/whistle peak ([\d.]+) Hz/.exec(get(name).detail)?.[1]);
    expect(whistle('turbofan 100 %')).toBeGreaterThan(whistle('turbofan idle') * 2);
    for (const n of ['GAU-8/A burst (outside, 30 m)', 'M61A1 burst (outside, 30 m)', 'Maverick boom 686 m away arrives 2 s later', 'tank cook-off 150 m away', 'turbofan 100 %']) {
      expect(get(n).ok, n).toBe(true);
      expect(get(n).peak, n).toBeLessThanOrEqual(0.99);
    }
    const want: [string, number, number][] = [
      ['GAU-8/A burst (outside, 30 m)', -16, -4],
      ['GAU-8/A burst (cockpit)', -16, -4],
      ['turbofan 100 %', -28, -16],
      ['turbofan idle', -36, -22],
    ];
    expect(want.filter(([n, lo, hi]) => !(get(n).db >= lo && get(n).db <= hi)).map(([n]) => `${n}: ${get(n).db.toFixed(1)}`)).toEqual([]);
  });

  it('nothing clips: every render peaks below full scale', () => {
    for (const r of results) if (!r.name.startsWith('mix:')) expect(r.peak, r.name).toBeLessThanOrEqual(0.99);
  });
});
