/**
 * End-to-end: a NaN/Inf in the HDR scene must never turn into black blocks on screen.
 *
 * The bug (JT, 2026-09-23): F-16 in chase view, afterburner lit, 4× MSAA — a big stair-stepped
 * black rectangle over the jet. The plume shader took pow() of an interpolated varying that MSAA
 * extrapolates slightly below 0 at silhouette edges (NaN on Apple GPUs); additive blending wrote the
 * NaN into the HDR target and the bloom chain's 13-tap blurs spread it into whole mip texels.
 *
 * 1. The repro itself: afterburner, chase view, 4× MSAA pinned — no black blocks.
 * 2. Containment: the plume is forced to write NaN (its intensity uniform) — the damage stays the
 *    size of the plume instead of spreading through bloom (and the eye adaptation keeps working).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { detectGpu, launchChrome, startViteServer, waitForSim, watchProblems, type E2EServer } from '../support/e2e';

let server: E2EServer;
let browser: Browser;
let timeout = 60_000;
let software = false;

beforeAll(async () => {
  [server, browser] = await Promise.all([startViteServer(), launchChrome()]);
  const probe = await browser.newPage();
  const gpu = await detectGpu(probe);
  await probe.close();
  software = gpu.software;
  if (gpu.software) timeout = 20 * 60_000;
}, 30 * 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const QUERY = 'veil=0&aircraft=f16&cam=chase&msaa=4&dyn=0&quality=high&no=audio,cars,ships,airTraffic';

/** Opens the sim with a hook that hands the test three's scenes (the devtools 'observe' event). */
async function open(): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.addInitScript(() => {
    const et = new EventTarget();
    const w = window as unknown as { __scenes: unknown[]; __THREE_DEVTOOLS__: EventTarget };
    w.__scenes = [];
    et.addEventListener('observe', (e) => {
      const d = (e as CustomEvent).detail as { isScene?: boolean };
      if (d && d.isScene) w.__scenes.push(d);
    });
    w.__THREE_DEVTOOLS__ = et;
  });
  await page.goto(`${server.url}/?${QUERY}`, { waitUntil: 'load' });
  await waitForSim(page, (s) => typeof s.fps === 'number' && s.fps > 0, 'window.sim with fps > 0', timeout);
  await page.waitForTimeout(2000);
  // Near the tank range, low, afterburner — where JT saw it.
  await page.evaluate(() => {
    const sim = (window as unknown as { sim: { combat: { range: { x: number; z: number } }; teleport: (o: object) => void } }).sim;
    const r = sim.combat.range;
    const h = (280 * Math.PI) / 180;
    sim.teleport({ x: r.x - Math.sin(h) * 3900, z: r.z + Math.cos(h) * 3900, aglFt: 550, headingDeg: 280, speedKt: 270 });
  });
  return page;
}

/** Number of 16×16 cells of the screenshot (below the title bar) that are pure black. */
async function blackCells(page: Page): Promise<number> {
  const png = (await page.screenshot()).toString('base64');
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext('2d')!;
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    const B = 16;
    let cells = 0;
    for (let y = 48; y + B <= c.height; y += B)
      for (let x = 0; x + B <= c.width; x += B) {
        let black = 0;
        for (let yy = 0; yy < B; yy += 4)
          for (let xx = 0; xx < B; xx += 4) {
            const i = ((y + yy) * c.width + x + xx) * 4;
            if (d[i] + d[i + 1] + d[i + 2] < 6) black++;
          }
        if (black === 16) cells++;
      }
    return cells;
  }, png);
}

/** Holds afterburner and returns the worst black-cell count over `n` one-second samples. */
async function worstUnderAfterburner(page: Page, n: number): Promise<number> {
  await page.keyboard.down('KeyW');
  let worst = 0;
  for (let i = 0; i < n; i++) {
    await page.waitForTimeout(1000);
    worst = Math.max(worst, await blackCells(page));
  }
  await page.keyboard.up('KeyW');
  return worst;
}

describe('HDR NaN containment (e2e)', () => {
  it('F-16 afterburner in chase view with 4× MSAA draws no black blocks', async (ctx) => {
    if (software) ctx.skip(); // MSAA edge extrapolation needs a real GPU rasteriser
    const page = await open();
    const problems = watchProblems(page);
    const plume = await page.evaluate(() => {
      const w = window as unknown as { __scenes: Array<{ getObjectByName: (n: string) => unknown }> };
      return w.__scenes.some((s) => s.getObjectByName('f16.plume'));
    });
    expect(plume).toBe(true);
    const worst = await worstUnderAfterburner(page, 7);
    expect(worst).toBeLessThanOrEqual(2);
    expect(problems.all()).toEqual([]);
    await page.close();
  }, 30 * 60_000);

  it('a NaN written by a scene shader stays the size of that object: bloom and metering do not spread it', async (ctx) => {
    if (software) ctx.skip();
    const page = await open();
    // Force the plume to write NaN (its intensity uniform, re-set by the model every frame, is
    // overwritten right before the draw).
    const hooked = await page.evaluate(() => {
      type U = { uAB: { value: number } };
      type M = { material: { uniforms: U }; onBeforeRender: () => void };
      const w = window as unknown as { __scenes: Array<{ getObjectByName: (n: string) => M | undefined }> };
      for (const s of w.__scenes) {
        const p = s.getObjectByName('f16.plume');
        if (p) {
          p.onBeforeRender = () => {
            p.material.uniforms.uAB.value = Number.NaN;
          };
          return true;
        }
      }
      return false;
    });
    expect(hooked).toBe(true);
    const worst = await worstUnderAfterburner(page, 6);
    // The plume covers a few dozen pixels in chase view; spread through bloom it was 500–750 cells.
    expect(worst).toBeLessThanOrEqual(24);
    // Eye adaptation survived (a NaN in its feedback loop would black out the frame for good).
    const trimOk = await page.evaluate(() => {
      const m = (window as unknown as { __render?: { meter?: () => { trim: number } | null } }).__render?.meter?.();
      return m == null || Number.isFinite(m.trim);
    });
    expect(trimOk).toBe(true);
    await page.close();
  }, 30 * 60_000);
});
