/**
 * End-to-end: the look-dev post stack (filmic curve, eye-adaptation metering, bloom chain, camera
 * white balance) compiles, links and runs in a real browser at every time of day, with no GL errors
 * or feedback-loop warnings; the camera opens up at golden hour; the 'low' quality preset drops bloom.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { detectGpu, launchChrome, startViteServer, waitForSim, watchProblems, type E2EServer, type PageProblems } from '../support/e2e';

let server: E2EServer;
let browser: Browser;
let timeout = 60_000;
const LIGHT = 'no=audio,vegetation,grass,cars,ships,airTraffic,targets,combatfx,weapons,missiles';

beforeAll(async () => {
  [server, browser] = await Promise.all([startViteServer(), launchChrome()]);
  const probe = await browser.newPage();
  const gpu = await detectGpu(probe);
  await probe.close();
  if (gpu.software) timeout = 20 * 60_000;
}, 30 * 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

type RenderHooks = {
  __render: {
    post: () => { bloom: number; bloomLevels: number; metering: boolean };
    meter: () => { on: boolean; trim: number; target: number; exposedMean: number; exposure: number } | null;
    clouds: () => { exposure: number };
  };
  sim: { setTimeOfDay: (i: number) => void };
};

async function open(query: string): Promise<{ page: Page; problems: PageProblems }> {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const problems = watchProblems(page);
  page.on('console', (m) => {
    if (m.type() === 'warning' && /shader|program|glsl|feedback|GL_INVALID|framebuffer/i.test(m.text())) problems.consoleErrors.push(m.text());
  });
  await page.goto(`${server.url}/?veil=0&${LIGHT}&${query}`, { waitUntil: 'load' });
  await waitForSim(page, (s) => typeof s.fps === 'number' && s.fps > 0, 'window.sim with fps > 0', timeout);
  await page.waitForTimeout(2500);
  return { page, problems };
}

describe('look-dev post stack (e2e)', () => {
  it('bloom + metering + filmic curve run clean at every time of day; golden hour exposes more than morning', async () => {
    const { page, problems } = await open('tod=0&quality=high');
    const post = await page.evaluate(() => (window as unknown as RenderHooks).__render.post());
    expect(post.bloom).toBeGreaterThan(0);
    expect(post.bloomLevels).toBeGreaterThanOrEqual(3);
    expect(post.metering).toBe(true);
    const exposures: number[] = [];
    for (const tod of [0, 1, 2, 3]) {
      await page.evaluate((t) => (window as unknown as RenderHooks).sim.setTimeOfDay(t), tod);
      await page.waitForTimeout(1200);
      const m = await page.evaluate(() => (window as unknown as RenderHooks).__render.meter());
      expect(m).not.toBeNull();
      expect(Number.isFinite(m!.trim)).toBe(true);
      expect(m!.trim).toBeGreaterThanOrEqual(0.69);
      expect(m!.trim).toBeLessThanOrEqual(1.41);
      expect(m!.exposedMean).toBeGreaterThan(0.01);
      expect(m!.exposedMean).toBeLessThan(5);
      exposures.push(await page.evaluate(() => (window as unknown as RenderHooks).__render.clouds().exposure));
    }
    expect(exposures[2]).toBeGreaterThan(1.5 * exposures[0]);
    expect(exposures[3]).toBeGreaterThan(exposures[2]);
    expect(problems.all()).toEqual([]);
    await page.close();
  }, 30 * 60_000);

  it('the low quality preset turns bloom off (and still renders clean)', async () => {
    const { page, problems } = await open('tod=2&quality=low');
    const post = await page.evaluate(() => (window as unknown as RenderHooks).__render.post());
    expect(post.bloom).toBe(0);
    expect(problems.all()).toEqual([]);
    await page.close();
  }, 30 * 60_000);
});
