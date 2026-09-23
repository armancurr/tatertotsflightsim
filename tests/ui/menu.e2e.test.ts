/**
 * End-to-end in headless Chrome for Testing: the pause menu, the aircraft picker and the jet HUD in
 * the real game — Esc opens/closes the menu, Restart works after a crash (twice), the picker
 * switches to the F-16 (jet HUD up, six-pack gone) and the choice survives a fresh load.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { launchChrome, readSim, startViteServer, waitForSim, watchProblems, type E2EServer, type PageProblems } from '../support/e2e';

const STEP = 30_000;
let server: E2EServer;
let browser: Browser;
let page: Page;
let problems: PageProblems;

beforeAll(async () => {
  [server, browser] = await Promise.all([startViteServer(), launchChrome()]);
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  problems = watchProblems(page);
  await page.goto(`${server.url}?veil=0`, { waitUntil: 'load' });
  await waitForSim(page, (s) => typeof s.fps === 'number' && s.fps > 0, 'app running', 40_000);
}, 70_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const visible = (sel: string) => page.evaluate((s) => {
  const el = document.querySelector(s) as HTMLElement | null;
  if (!el) return false;
  for (let e: HTMLElement | null = el; e; e = e.parentElement) if (e.hidden) return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}, sel);

describe('menu, picker and jet HUD in the game', () => {
  it('shows the branded top bar with the picker in the upper right', async () => {
    expect(await visible('.tfs-topbar')).toBe(true);
    const box = await page.locator('.tfs-picker-button').boundingBox();
    expect(box!.x).toBeGreaterThan(1440 * 0.7);
    expect(box!.y).toBeLessThan(40);
    expect(await page.locator('.tfs-brand').textContent()).toContain("Tater's");
  });

  it('Esc pauses and opens the menu; Esc again resumes and closes it', async () => {
    await page.keyboard.press('Escape');
    await waitForSim(page, (s) => s.paused === true, 'paused by Esc');
    expect(await visible('.tfs-panel')).toBe(true);
    await page.keyboard.press('Escape');
    await waitForSim(page, (s) => s.paused === false, 'resumed by Esc');
    expect(await visible('.tfs-panel')).toBe(false);
  }, STEP);

  it('after a crash, Restart on runway puts the aircraft back on the runway — every time', async () => {
    for (let i = 0; i < 2; i++) {
      await page.evaluate(() => (window as unknown as { sim: { teleport(t: object): void } }).sim.teleport({ x: 0, z: -3000, aglFt: 120, headingDeg: 0, speedKt: 100 }));
      await page.keyboard.down('ArrowUp');
      try {
        await waitForSim(page, (s) => s.state === 'crashed', 'crashed into the ground', 20_000);
      } finally {
        await page.keyboard.up('ArrowUp');
      }
      await page.keyboard.press('Escape');
      await waitForSim(page, (s) => s.paused === true, 'menu up');
      await page.click('.tfs-panel button:has-text("Restart on runway")');
      const s = await waitForSim(page, (x) => x.state === 'ground' && x.paused === false && x.airspeed < 2, 'restarted on the runway', 8000);
      expect(Math.abs(s.roll)).toBeLessThan(3);
    }
  }, 60_000);

  it('the picker switches to the F-16 (jet HUD, no six-pack) and the choice comes back on a fresh load', async () => {
    await page.click('.tfs-picker-button');
    await page.click('.tfs-picker-list [role="option"]:has-text("F-16")');
    await waitForSim(page, (s) => s.aircraft === 'f16', 'flying the F-16', 15_000);
    await page.waitForTimeout(300);
    expect(await visible('canvas[data-hud="jet"]')).toBe(true);
    expect(await visible('.fsh-left')).toBe(false);
    // Arrow keys fly again after picking (the picker gave the keyboard back).
    const focusInPicker = await page.evaluate(() => !!document.activeElement?.closest('.tfs-picker'));
    expect(focusInPicker).toBe(false);
    // A fresh load without ?aircraft= restores the saved F-16.
    await page.goto(`${server.url}?veil=0`, { waitUntil: 'load' });
    await waitForSim(page, (s) => s.aircraft === 'f16', 'saved F-16 restored', 40_000);
    // Back to the Cessna through the menu.
    await page.keyboard.press('Escape');
    await waitForSim(page, (s) => s.paused === true, 'menu up');
    await page.click('.tfs-card[data-aircraft="c172rg"]');
    await waitForSim(page, (s) => s.aircraft === 'c172rg' && s.paused === false, 'back in the Cessna', 15_000);
    expect(await visible('.fsh-left')).toBe(true);
    const s = await readSim(page);
    expect(s!.state).toBe('ground');
  }, 90_000);

  it('no page errors or failed requests along the way', () => {
    expect(problems.all().filter((p) => !/GPU stall/.test(p))).toEqual([]);
  });
});
