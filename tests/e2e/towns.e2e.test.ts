/**
 * End-to-end: the building shaders (near archetypes with trees, awnings and water towers, the mid
 * LOD with its dithered tree cross-fade, the shadow depth material) compile and draw in a real
 * browser — the towns gallery preview at dusk (lit windows) and a city view in the full world.
 * Any three.js shader compile/link error is logged with console.error, so a clean console after
 * the first frames means every building program linked.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { detectGpu, launchChrome, startViteServer, watchProblems, type E2EServer, type PageProblems } from '../support/e2e';

let server: E2EServer;
let browser: Browser;
let timeout = 90_000;

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

async function open(path: string): Promise<{ page: Page; problems: PageProblems }> {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const problems = watchProblems(page);
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning' && /shader|program|glsl/i.test(m.text())) warnings.push(m.text());
  });
  await page.goto(`${server.url}${path}`, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as unknown as { __ready: boolean }).__ready === true, null, { timeout });
  // a few more frames so every program (colour, mid, depth) has been used
  await page.waitForTimeout(1500);
  problems.consoleErrors.push(...warnings);
  return { page, problems };
}

describe('building shaders (e2e)', () => {
  it('the gallery (every archetype, trees, awnings, a water tower, a round tower) compiles and draws at dusk', async () => {
    const { page, problems } = await open('/preview/towns.html?gallery=1&hud=0&tod=3&x=250&z=120&y=45&pitch=-12');
    const st = (await page.evaluate(() => (window as unknown as { __stats: () => Record<string, number> }).__stats())) as Record<string, number>;
    expect(problems.all()).toEqual([]);
    expect(st.ready).toBe(true);
    expect(st.nearInstances).toBeGreaterThan(30);
    expect(st.drawCalls).toBeGreaterThanOrEqual(4);
    expect(st.night).toBeGreaterThan(0.5);
    // the renderer issued the draws (colour + shadow passes)
    expect(st.calls).toBeGreaterThan(st.drawCalls);
    await page.close();
  }, 30 * 60_000);

  it('the world: Port Chateau with near and mid LODs and tree cross-fades, no shader errors', async () => {
    const { page, problems } = await open('/preview/townsWorld.html?hud=0&t=2&x=-4700&z=5600&y=400&look=-4700,6700&tod=1&no=hud,audio,fx,vegetation,grass,cars,ships,airTraffic,targets,combatfx,weapons,missiles');
    const st = (await page.evaluate(() => (window as unknown as { __stats: () => { towns: Record<string, number> } }).__stats())) as { towns: Record<string, number> };
    expect(problems.all()).toEqual([]);
    expect(st.towns.ready).toBe(true);
    expect(st.towns.nearInstances).toBeGreaterThan(1000);
    expect(st.towns.drawCalls).toBeGreaterThanOrEqual(4);
    await page.close();
  }, 30 * 60_000);
});
