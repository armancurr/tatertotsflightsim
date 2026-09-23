/**
 * End-to-end: the water in the real page (headless Chrome for Testing, GPU WebGL). Proves what
 * node cannot: the sea, lake, river and reed shaders compile and link (three reports shader errors
 * on the console), the worker bakes the four-channel bathymetry clipmap, the reeds stream in by
 * distance, and flying from the coast to a lake and up the river keeps the console clean.
 * Observed only through window.sim (debug().systems.water).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchChrome, startViteServer, waitForSim, watchProblems, type E2EServer, type PageProblems } from '../../support/e2e';

let server: E2EServer;
let browser: Browser;
let page: Page;
let problems: PageProblems;

type WaterStats = Record<string, any>;
const water = (): Promise<WaterStats> => page.evaluate(() => (window as any).sim.debug().systems.water);

beforeAll(async () => {
  [server, browser] = await Promise.all([startViteServer(), launchChrome()]);
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  problems = watchProblems(page);
  // low over the lowland river (reeds, bank reflections), golden hour
  await page.goto(`${server.url}?veil=0&tod=2&pause=1&spawn=3860,-1300,400,180,95&cam=chase`, { waitUntil: 'load' });
  await waitForSim(page, (s) => typeof s.fps === 'number' && s.fps > 0, 'window.sim with fps > 0', 60_000);
  await page.waitForFunction(() => {
    const w = (window as any).sim?.debug?.()?.systems?.water;
    return w?.detailReady && w?.near?.valid && w?.far?.valid;
  }, undefined, { timeout: 60_000 });
  await page.waitForTimeout(1500);
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('water in Chrome', () => {
  it('compiles every water shader (no console errors), bakes in the worker, draws within budget', async () => {
    const w = await water();
    expect(problems.all()).toEqual([]);
    expect(w.worker).toBe(true);
    expect(w.detailReady).toBe(true);
    expect(w.bathyBakes).toBeGreaterThanOrEqual(2);
    expect(w.drawCalls).toBeLessThanOrEqual(12);
    expect(w.reedChunks).toBeGreaterThan(3);
    expect(w.reedsVisible).toBeGreaterThan(0); // over the river's lowland reach
  }, 30_000);

  it('flies to the lake, the mountain torrent and the river mouth at every time of day with a clean console', async () => {
    const spots = [
      { x: -7150, z: -9750, aglFt: 60, headingDeg: 10 },
      { x: 7300, z: -20000, aglFt: 500, headingDeg: 200 },
      { x: 3300, z: 5200, aglFt: 1200, headingDeg: 180 },
    ];
    for (const [i, s] of spots.entries()) {
      await page.evaluate(([spot, tod]) => {
        (window as any).sim.setTimeOfDay(tod);
        (window as any).sim.teleport({ ...spot, speedKt: 95 });
      }, [s, i + 1] as const);
      await page.waitForTimeout(2500);
      const w = await water();
      expect(w.drawCalls).toBeLessThanOrEqual(12);
      expect(Number.isFinite(w.lastBakeMs)).toBe(true);
    }
    expect(problems.all()).toEqual([]);
  }, 120_000);
});
