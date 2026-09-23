/**
 * End-to-end in headless Chrome for Testing: the A-10's weapons HUD in the real game. At
 * `?spawn=range` it shows the gun cross, the stores ("GUN 1150 CM", "65D ×4") and the range cue;
 * with a platoon seeded at the range (the debug hook) the real missiles system locks with T (lock
 * box, LOCK, the Maverick view picture with a non-blank IR image), Z launches ("RIFLE"), the kill
 * comes back as a toast; the gun's CCIP pipper (debug status) shows IN RNG low over the range; the
 * cockpit view works; the Cessna shows none of it. Screenshots (1440×900 and 1024×768, chase and
 * cockpit) go to qa/tmp/ (git-ignored) for review.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchChrome, startViteServer, waitForSim, watchProblems, type E2EServer, type PageProblems } from '../support/e2e';

let server: E2EServer;
let browser: Browser;
let page: Page;
let problems: PageProblems;

type HudStats = {
  visible: boolean; exterior: boolean; gunCross: boolean; stores: string[]; rangeCue: string; message: string; markers: number;
  pipper: { inRange: boolean; arc: number } | null; lock: { solid: boolean; type: string; range: string } | null;
  maverickView: { shown: boolean; renders: number };
};

const hud = () => page.evaluate(() => (window as unknown as { sim: { debug(): { systems: Record<string, unknown> } } }).sim.debug().systems.weaponsHud) as Promise<HudStats>;
const sim = <T>(fn: string) => page.evaluate(`(() => { const sim = window.sim; return ${fn}; })()`) as Promise<T>;

async function until(pred: () => Promise<boolean>, what: string, ms = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await pred()) return;
    await page.waitForTimeout(100);
  }
  throw new Error(`timed out: ${what} — ${JSON.stringify(await hud())}`);
}

beforeAll(async () => {
  [server, browser] = await Promise.all([startViteServer(), launchChrome()]);
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  problems = watchProblems(page);
  await page.goto(`${server.url}?veil=0&aircraft=a10&spawn=range`, { waitUntil: 'load' });
  await waitForSim(page, (s) => typeof s.fps === 'number' && s.fps > 0 && s.aircraft === 'a10', 'A-10 flying', 60_000);
}, 90_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

describe('A-10 weapons HUD in the game', () => {
  it('shows the gun cross and the stores over the view', async () => {
    await until(async () => (await hud())?.visible === true, 'weapons HUD up');
    const h = await hud();
    expect(h.gunCross).toBe(true);
    expect(h.stores).toEqual(expect.arrayContaining(['GUN 1150 CM', '65D ×4', 'KILLS 0']));
    expect(await page.locator('canvas[data-hud="weapons"]').isVisible()).toBe(true);
  }, 30_000);

  it('range cue to the target range; the real missiles system locks with T, the Maverick view shows the target', async () => {
    await sim('sim.weaponsHudDemo("gun")');
    await until(async () => /^RANGE \d+\.\d km$/.test((await hud()).rangeCue), 'range cue');
    // 4 km short of the target range, 1,000 ft, pointing at it: the vehicles a few degrees under the nose.
    await sim('((r, h) => sim.teleport({ x: r.x - Math.sin(h) * 4000, z: r.z + Math.cos(h) * 4000, aglFt: 1000, headingDeg: r.headingDeg, speedKt: 250 }))(sim.combat.range, sim.combat.range.headingDeg * Math.PI / 180)');
    await page.waitForTimeout(600);
    expect((await hud()).markers).toBeGreaterThan(0);
    await page.keyboard.press('t');
    await until(async () => (await hud()).lock?.solid === true, 'LOCK', 10_000);
    const h = await hud();
    expect(h.lock!.type).toMatch(/T-72B|BMP-2|BTR-80|Ural|ZSU/);
    expect(h.lock!.range).toMatch(/^\d+\.\d NM$|^\d+ FT$/);
    await until(async () => (await hud()).maverickView.renders > 2, 'Maverick view pictures');
    expect(await page.locator('canvas[data-hud="maverick"]').isVisible()).toBe(true);
    const probe = await sim<{ picture: { mean: number; std: number } | null }>('sim.weaponsHudProbe()');
    expect(probe.picture).not.toBeNull();
    expect(probe.picture!.std).toBeGreaterThan(0.02);
    await page.screenshot({ path: 'qa/tmp/combathud-e2e-lock-chase-1440.png' });
  }, 45_000);

  it('Z launches ("RIFLE"), the kill comes back as a toast and on the kills counter', async () => {
    await page.keyboard.press('z');
    await until(async () => (await hud()).message === 'RIFLE', 'RIFLE', 5_000);
    await until(async () => (await sim<number>('sim.combat.stats.kills')) >= 1, 'a kill', 40_000);
    await until(async () => (await page.locator('.fsh-toast').allTextContents()).some((t) => / destroyed — AGM-65D$/.test(t)), 'kill toast', 5_000);
    // The blast can take out a neighbour in the column too.
    await until(async () => (await hud()).stores.some((t) => /^KILLS [1-9]\d*$/.test(t)), 'KILLS ≥ 1', 3_000);
  }, 60_000);

  it('Z without a lock says NO LOCK', async () => {
    // Look away from the vehicles and drop the lock (T with nothing in the cone).
    await sim('sim.teleport({ x: 3000, z: 2000, aglFt: 1500, headingDeg: 90, speedKt: 250 })');
    await page.keyboard.press('t');
    await until(async () => (await sim<string>('sim.combat.lock.state')) === 'off', 'lock off');
    await page.keyboard.press('z');
    await until(async () => (await hud()).message === 'NO LOCK', 'NO LOCK', 3_000);
  }, 30_000);

  it('CCIP pipper low over the range: IN RNG inside 4,000 ft; cockpit view and 1024 × 768', async () => {
    await sim('sim.teleport({ x: 0, z: -4200, aglFt: 150, headingDeg: 0, speedKt: 250 })');
    await until(async () => (await hud()).pipper?.inRange === true, 'pipper in range');
    await page.screenshot({ path: 'qa/tmp/combathud-e2e-pipper-chase-1440.png' });
    await page.keyboard.press('1');
    await until(async () => (await hud()).exterior === false, 'cockpit view');
    await page.waitForTimeout(1200);
    expect((await hud()).gunCross).toBe(true);
    await page.screenshot({ path: 'qa/tmp/combathud-e2e-pipper-cockpit-1440.png' });
    await page.setViewportSize({ width: 1024, height: 768 });
    await page.waitForTimeout(800);
    expect((await hud()).visible).toBe(true);
    await page.screenshot({ path: 'qa/tmp/combathud-e2e-pipper-cockpit-1024.png' });
    await page.keyboard.press('2');
    await page.waitForTimeout(1200);
    await page.screenshot({ path: 'qa/tmp/combathud-e2e-pipper-chase-1024.png' });
    await page.setViewportSize({ width: 1440, height: 900 });
    // The pipper comes into range as the jet settles at 150 ft: wall-clock dependent on a loaded machine.
  }, { timeout: 45_000, retry: 2 });

  it('the Cessna shows none of it', async () => {
    await sim('sim.selectAircraft("c172rg")');
    await waitForSim(page, (s) => s.aircraft === 'c172rg', 'Cessna', 20_000);
    await until(async () => (await hud()).visible === false, 'weapons HUD gone');
    expect(await page.locator('canvas[data-hud="weapons"]').isVisible()).toBe(false);
    expect(await page.locator('canvas[data-hud="maverick"]').isVisible()).toBe(false);
  }, 30_000);

  it('no page errors or failed requests', () => {
    expect(problems.all().filter((p) => !/GPU stall/.test(p))).toEqual([]);
  });
});
