/**
 * End-to-end: the player's wake in the real page (headless Chrome for Testing, GPU WebGL). Proves
 * what node cannot: with the wake active the sea shader (per-pixel foam lace, boils, aerated water)
 * and the wake-map shader (two render targets: the field and the track direction) compile and link,
 * the map is drawn every frame, spray flies, and the 'low' quality preset's cheaper path (no
 * per-pixel foam structure, a half-resolution map) compiles too. Also a ship-sized wake
 * (?wakeHull=265,32: a kilometres-wide map) stays clean. Observed only through window.sim.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchChrome, startViteServer, waitForSim, watchProblems, type E2EServer, type PageProblems } from '../../support/e2e';

let server: E2EServer;
let browser: Browser;

type WakeStats = Record<string, any>;

async function drive(page: Page, query: string, kt: number): Promise<{ problems: PageProblems }> {
  const problems = watchProblems(page);
  await page.goto(`${server.url}?veil=0&aircraft=v50&spawn=sea&cam=chase${query}`, { waitUntil: 'load' });
  await waitForSim(page, (s) => typeof s.fps === 'number' && s.fps > 0 && !!s.vessel, 'window.sim with a vessel', 90_000);
  await page.evaluate((speedKt) => {
    const s = (window as any).sim;
    s.teleport({ x: s.position.x, z: s.position.z, headingDeg: s.heading, speedKt });
  }, kt);
  await page.waitForFunction(() => {
    const w = (window as any).sim?.debug?.()?.systems?.playerWake;
    return w?.map && w.strip > 20 && w.trackSpan > 6;
  }, undefined, { timeout: 60_000 });
  return { problems };
}

const wake = (page: Page): Promise<WakeStats> => page.evaluate(() => (window as any).sim.debug().systems.playerWake);

beforeAll(async () => {
  [server, browser] = await Promise.all([startViteServer(), launchChrome()]);
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('the wake in Chrome', () => {
  it('underway at 25 kt: the wake map and the sea compile, the map is drawn, spray flies, the console stays clean', async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const { problems } = await drive(page, '&quality=high', 25);
    await page.waitForTimeout(1500);
    const w = await wake(page);
    expect(problems.all()).toEqual([]);
    expect(w.active).toBe(true);
    expect(w.map).toBe(true);
    expect(w.mapExtent).toBe(520);
    expect(w.mapRes).toBe(1024);
    expect(w.spray).toBeGreaterThan(10);
    expect(w.drawCalls).toBeLessThanOrEqual(2);
    await page.close();
  }, 180_000);

  it("the 'low' quality preset: the cheaper path compiles (half-resolution map, no per-pixel foam structure)", async () => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
    const { problems } = await drive(page, '&quality=low', 20);
    const w = await wake(page);
    expect(problems.all()).toEqual([]);
    expect(w.map).toBe(true);
    expect(w.mapRes).toBe(512);
    await page.close();
  }, 180_000);

  it('a ship-sized wake (?wakeHull=265,32): a kilometres-wide map, clean console', async () => {
    const page = await browser.newPage({ viewport: { width: 1024, height: 700 } });
    const { problems } = await drive(page, '&wakeHull=265,32', 18);
    const w = await wake(page);
    expect(problems.all()).toEqual([]);
    expect(w.map).toBe(true);
    expect(w.mapExtent).toBeGreaterThan(1800);
    await page.close();
  }, 180_000);
});
