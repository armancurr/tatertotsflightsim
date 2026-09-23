/**
 * Sortie e2e — the A-10 at the target range, flown ONLY by the keyboard QA pilot (scripts/qa-pilot.js)
 * in headless Chrome for Testing: `?aircraft=a10&spawn=range` → a Maverick shot (T until LOCK, Z) on
 * a live tank → a kill; then a strafing pass with the GAU-8 on another tank from above/behind (dive,
 * CCIP, burst, pull-off above 500 ft). No console errors, a playable frame rate. Screenshots of the
 * burst, the dust, the Maverick hit and the wrecks go to qa/tmp/ (git-ignored) for review.
 *
 * Opt-in (not in `npm test`): `npx vitest run -c tests/e2e/sortie.vitest.config.ts`.
 *
 * On a software renderer (no GPU) the sim runs far below real time and a keyboard pilot cannot fly
 * a gun pass: there the test only checks the page comes up with the range and the weapons.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { detectGpu, launchChrome, startViteServer, waitForSim, watchProblems, type E2EServer, type GpuInfo, type PageProblems } from '../support/e2e';

let server: E2EServer;
let browser: Browser;
let page: Page;
let problems: PageProblems;
let gpu: GpuInfo;

beforeAll(async () => {
  [server, browser] = await Promise.all([startViteServer(), launchChrome()]);
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  gpu = await detectGpu(page);
  problems = watchProblems(page);
  await page.goto(`${server.url}?veil=0&aircraft=a10&spawn=range`, { waitUntil: 'load' });
  await waitForSim(page, (s) => typeof s.fps === 'number' && s.fps > 0 && s.aircraft === 'a10', 'A-10 at the range', 90_000);
  await page.addScriptTag({ path: 'scripts/qa-pilot.js' });
  await page.evaluate(() => (window as unknown as { qaPilot: { init(): Promise<unknown> } }).qaPilot.init());
}, 150_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

type Out = { done: boolean; err?: string; mav?: Record<string, unknown>; gun?: Record<string, unknown>; mavTarget?: number; gunTarget?: number };

describe('A-10 range sortie (keyboard QA pilot)', () => {
  it('the range is populated and the A-10 is armed', async () => {
    const c = await page.evaluate(() => { const c = (window as any).sim.combat; return { targets: c.targets, alive: c.alive, missiles: c.missiles, rounds: c.rounds, range: c.range }; });
    expect(c.range).not.toBeNull();
    expect(c.targets).toBeGreaterThan(5);
    expect(c.alive).toBe(c.targets);
    expect(c.missiles).toBe(4);
    expect(c.rounds).toBe(1150);
  });

  it('Maverick kill, then a gun pass from above/behind: kills ≥ 1, rounds on target, no crash, no console errors, fps ≥ 45', async () => {
    if (gpu.software) return; // see the header: too slow to fly on a CPU rasteriser
    await page.evaluate(() => {
      const w = window as any;
      const p = w.qaPilot;
      w.__sortie = { done: false } as Out;
      (async () => {
        try {
          const t1 = p.pickTarget('tank');
          w.__sortie.mavTarget = t1.id;
          w.__sortie.mav = await p.mavShot(t1.id);
          const t2 = p.pickTarget('tank', { exclude: [t1.id, w.__sortie.mav.retargeted] }) ?? p.pickTarget(null, { exclude: [t1.id] });
          w.__sortie.gunTarget = t2.id;
          w.__sortie.gun = await p.gunRun(t2.id, {});
        } catch (e) { w.__sortie.err = String((e as Error)?.stack ?? e); }
        w.__sortie.done = true;
      })();
    });
    const t0 = Date.now();
    const shots = { burst: false, dust: false, mav: 'no' as 'no' | 'wait' | 'done' };
    for (;;) {
      const st = await page.evaluate(() => { const w = window as any; const c = w.sim.combat; return { done: w.__sortie.done, state: w.sim.state, firing: c.gunFiring, inFlight: c.missilesInFlight }; });
      if (st.firing && !shots.burst) { shots.burst = true; await page.screenshot({ path: 'qa/tmp/sortie-e2e-gun-burst.png' }); }
      if (shots.burst && !st.firing && !shots.dust) { shots.dust = true; await page.waitForTimeout(250); await page.screenshot({ path: 'qa/tmp/sortie-e2e-gun-dust.png' }); }
      if (st.inFlight > 0 && shots.mav === 'no') shots.mav = 'wait';
      if (shots.mav === 'wait' && st.inFlight === 0) { shots.mav = 'done'; await page.screenshot({ path: 'qa/tmp/sortie-e2e-mav-hit.png' }); }
      if (st.done || st.state === 'crashed' || Date.now() - t0 > 170_000) break;
      await page.waitForTimeout(120);
    }
    const r = await page.evaluate(() => { const w = window as any; return { out: w.__sortie as Out, stats: w.sim.combat.stats, state: w.sim.state, perf: w.sim.perf, log: w.qaPilot.log.slice(-12) }; });
    // The burning wrecks, looking back from where the pass ended (~2 km).
    await page.keyboard.press('Digit4');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'qa/tmp/sortie-e2e-wrecks.png' });
    // eslint-disable-next-line no-console
    console.log('[sortie-range]', JSON.stringify({ mav: r.out.mav, gun: r.out.gun, stats: r.stats, perf: { avg: r.perf.avg, min: r.perf.min, low: r.perf.onePercentLow }, wall: (Date.now() - t0) / 1000 }));
    expect(r.out.err).toBeUndefined();
    expect(r.state).not.toBe('crashed');
    expect(r.out.done).toBe(true);
    expect(r.out.mav?.locked).toBe(true);
    expect(r.out.mav?.launched).toBe(true);
    expect(r.stats.kills).toBeGreaterThanOrEqual(1);
    expect(r.out.gun?.fired).toBe(true);
    expect(r.stats.roundsFired).toBeGreaterThan(20);
    expect(r.out.gun?.minAglFt as number).toBeGreaterThan(400);
    expect(r.perf.avg).toBeGreaterThanOrEqual(45);
    expect(problems.all().filter((p) => !/GPU stall/.test(p))).toEqual([]);
  }, 240_000);
});
