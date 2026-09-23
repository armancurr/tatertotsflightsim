/**
 * End-to-end: ships and air traffic in the real page (headless Chrome for Testing, GPU WebGL).
 * Proves what node cannot: every traffic shader compiles and links, both systems build and draw
 * within their budgets, and the traffic clock follows pause / resume, teleports re-anchor traffic.
 * Observed only through window.sim (debug().systems.ships / .airTraffic).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchChrome, startViteServer, waitForSim, watchProblems, type E2EServer, type PageProblems } from '../../support/e2e';

let server: E2EServer;
let browser: Browser;
let page: Page;
let problems: PageProblems;

type Stats = { ships: Record<string, any>; air: Record<string, any>; timings: Record<string, number> };
const stats = (): Promise<Stats> =>
  page.evaluate(() => {
    const d = (window as any).sim.debug();
    return { ships: d.systems.ships, air: d.systems.airTraffic, timings: d.timings };
  });
const waitFrames = (ms: number) => page.waitForTimeout(ms);

beforeAll(async () => {
  [server, browser] = await Promise.all([startViteServer(), launchChrome()]);
  page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  problems = watchProblems(page);
  // dawn (lights, lit windows), the ferry under way nearby, a moored marina within view
  await page.goto(`${server.url}?veil=0&tod=3&tt=282&spawn=3000,6600,800,90,90&cam=chase`, { waitUntil: 'load' });
  await waitForSim(page, (s) => typeof s.fps === 'number' && s.fps > 0, 'window.sim with fps > 0', 45_000);
  await page.waitForFunction(() => {
    const d = (window as any).sim?.debug?.();
    return d?.systems?.ships?.ready && d?.systems?.airTraffic?.ready;
  }, undefined, { timeout: 45_000 });
  await waitFrames(1500);
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('traffic in Chrome', () => {
  it('builds both systems, compiles every shader (no console errors) and stays within the draw-call budget', async () => {
    const s = await stats();
    expect(problems.all()).toEqual([]);
    expect(s.ships.ready).toBe(true);
    expect(s.air.ready).toBe(true);
    expect(s.ships.rejected).toEqual([]);
    expect(s.ships.drawCalls).toBeLessThanOrEqual(3);
    expect(s.air.drawCalls).toBeLessThanOrEqual(4);
    expect(s.ships.drawCalls + s.air.drawCalls).toBeGreaterThanOrEqual(4); // vessels, wakes, lights, contrails…
    expect(s.ships.lights).toBeGreaterThan(10); // dawn: navigation lights and lamps are on
    // the build was sliced: no single step anywhere near a long frame
    // The slicing itself is unit-tested; in a live browser on a busy machine a slice can stall, so allow 2×.
    expect(s.ships.maxBuildStepMs).toBeLessThan(100);
    expect(s.air.maxBuildStepMs).toBeLessThan(100);
  });

  it('the traffic clock stops while paused and runs again on resume', async () => {
    await page.evaluate(() => (window as any).sim.pause());
    await waitFrames(300);
    const a = (await stats()).ships.trafficTime;
    await waitFrames(1200);
    const b = (await stats()).ships.trafficTime;
    expect(b).toBe(a);
    await page.evaluate(() => (window as any).sim.resume());
    await waitFrames(1500);
    const c = (await stats()).ships.trafficTime;
    expect(c).toBeGreaterThan(b + 0.5);
  });

  it('a teleport re-anchors the crossing traffic around the new position, all airborne traffic keeps its distance', async () => {
    await page.evaluate(() => (window as any).sim.teleport({ x: -18000, z: -12000, aglFt: 3000, headingDeg: 90, speedKt: 95 }));
    await waitFrames(1500);
    const s = await stats();
    const pos = await page.evaluate(() => (window as any).sim.position);
    const crossing = (s.air.aircraft as string[]).filter((a) => a.startsWith('crossing')).map((a) => a.split(' ')[1].split(',').map(Number));
    expect(crossing.length).toBeGreaterThan(0);
    for (const [x, , z] of crossing) expect(Math.hypot(x - pos.x, z - pos.z)).toBeLessThan(26000);
    for (const a of s.air.aircraft as string[]) {
      const [x, y, z] = a.split(' ')[1].split(',').map(Number);
      if (a.endsWith('hidden')) continue;
      if (a.startsWith('circuit') && y < 40) continue; // on the ground at the airfield
      expect(Math.hypot(x - pos.x, y - pos.y, z - pos.z)).toBeGreaterThan(300);
    }
    expect(problems.all()).toEqual([]);
  });
});
