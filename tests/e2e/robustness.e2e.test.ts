/**
 * End-to-end robustness of what a stranger downloads: the PRODUCTION build (vite build with the
 * GitHub Pages sub-path --base, served by vite preview) in headless Chromium.
 *
 *   - boots with no console errors, page errors or failed requests, and every chunk and worker is
 *     served from under the sub-path;
 *   - aircraft switches and resets don't leak GPU textures/geometries, event listeners or workers
 *     (the short version of the 20-minute soak, qa: see the browser report);
 *   - window resizes (desktop, phone portrait, full HD) keep the canvas full-size with a drawing
 *     buffer of css × pixel ratio; devicePixelRatio 1 and 2 get the right quality range;
 *   - a frozen/hidden tab resumes cleanly (no catch-up jump) and the audio is suspended while hidden.
 *
 * CPU-only machines (CI) render at well under 1 fps: waits are stretched as in app.e2e.test.ts.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build, preview, type PreviewServer } from 'vite';
import {
  ROOT, detectGpu, e2eTimeScale, freePort, launchChrome, mainCanvasSize, readSim, setE2ETimeScale, waitForSim, watchProblems,
  type PageProblems,
} from '../support/e2e';

const BASE = '/tatertotsflightsim/';
const STEP_TIMEOUT = 30 * 60_000;

let outDir: string;
let server: PreviewServer;
let url: string;
let browser: Browser;
let software = false;

/** Counts live event listeners (window, document, total) and workers, installed before the app loads. */
const COUNTERS = () => {
  const reg = new WeakMap<object, Map<string, Set<unknown>>>();
  const c = { total: 0, window: 0, document: 0 };
  const key = (t: string, o: unknown) => `${t}|${typeof o === 'boolean' ? o : !!(o && (o as { capture?: boolean }).capture)}`;
  const add = EventTarget.prototype.addEventListener;
  const rem = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, fn: unknown, opts?: unknown) {
    if (fn) {
      let m = reg.get(this);
      if (!m) reg.set(this, (m = new Map()));
      const k = key(type, opts);
      let s = m.get(k);
      if (!s) m.set(k, (s = new Set()));
      if (!s.has(fn)) {
        s.add(fn);
        c.total++;
        if (this === window) c.window++;
        if (this === document) c.document++;
      }
    }
    return add.call(this, type, fn as EventListener, opts as AddEventListenerOptions);
  } as typeof EventTarget.prototype.addEventListener;
  EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, fn: unknown, opts?: unknown) {
    const s = reg.get(this)?.get(key(type, opts));
    if (s?.delete(fn)) {
      c.total--;
      if (this === window) c.window--;
      if (this === document) c.document--;
    }
    return rem.call(this, type, fn as EventListener, opts as EventListenerOptions);
  } as typeof EventTarget.prototype.removeEventListener;
  const W = window.Worker;
  const workers = { live: 0, made: 0 };
  window.Worker = class extends W {
    constructor(u: string | URL, o?: WorkerOptions) {
      super(u, o);
      workers.live++;
      workers.made++;
    }
    terminate() {
      workers.live--;
      super.terminate();
    }
  };
  (window as unknown as Record<string, unknown>).__counts = () => ({ ...c, workers: { ...workers } });
};

type Counts = { total: number; window: number; document: number; workers: { live: number; made: number } };
const counts = (p: Page) => p.evaluate(() => (window as unknown as { __counts(): Counts }).__counts());
const gpuMem = (p: Page) => p.evaluate(() => {
  const r = (window as unknown as { sim: { render: { geometries: number; textures: number } } }).sim.render;
  return { geometries: r.geometries, textures: r.textures };
});

/** Let `simSeconds` of sim time pass (≥ a few rendered frames on any renderer). */
async function settle(p: Page, simSeconds: number) {
  const s0 = (await readSim(p))!;
  await waitForSim(p, (s) => (s.time as number) > (s0.time as number) + simSeconds, `sim time +${simSeconds} s`, 20_000);
}

async function openPage(query: string, opts: { width?: number; height?: number; dpr?: number; counters?: boolean } = {}) {
  const ctx = await browser.newContext({ viewport: { width: opts.width ?? 1440, height: opts.height ?? 900 }, deviceScaleFactor: opts.dpr ?? 1 });
  const page = await ctx.newPage();
  if (opts.counters) await page.addInitScript(COUNTERS);
  const problems = watchProblems(page);
  await page.goto(`${url}${query}`, { waitUntil: 'load' });
  await waitForSim(page, (s) => typeof s.fps === 'number' && s.fps > 0, 'window.sim with fps > 0', 60_000);
  return { page, problems, close: () => ctx.close() };
}

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'tater-dist-'));
  await build({ root: ROOT, base: BASE, logLevel: 'error', build: { outDir, emptyOutDir: true } });
  const port = await freePort();
  server = await preview({ root: ROOT, base: BASE, logLevel: 'error', build: { outDir }, preview: { host: '127.0.0.1', port, strictPort: true } });
  url = `http://127.0.0.1:${port}${BASE}`;
  browser = await launchChrome();
  const probe = await browser.newPage();
  const gpu = await detectGpu(probe);
  await probe.close();
  software = gpu.software;
  if (software) setE2ETimeScale(Math.max(e2eTimeScale(), 120));
  // eslint-disable-next-line no-console
  console.log(`[robustness] WebGL: ${gpu.renderer}; production build at ${url}`);
}, 10 * 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe('production build (GitHub Pages sub-path) in Chrome', () => {
  it('index.html references everything under the --base sub-path', () => {
    const html = readFileSync(join(outDir, 'index.html'), 'utf8');
    expect(html).toContain(`src="${BASE}assets/`);
    expect(html).not.toMatch(/(src|href)="\/(assets|favicon)/);
  });

  it('boots with no console errors, page errors or failed requests; chunks and workers load from the sub-path', async () => {
    const { page, problems, close } = await openPage('?veil=0');
    try {
      await settle(page, software ? 0.3 : 3);
      expect(problems.all()).toEqual([]);
      const res = await page.evaluate(() => performance.getEntriesByType('resource').map((e) => e.name));
      const scripts = res.filter((n) => /\.js(\?|$)/.test(n));
      expect(scripts.some((n) => /\/assets\/three-[\w-]+\.js$/.test(n)), 'three.js chunk').toBe(true);
      expect(scripts.some((n) => /\/assets\/app-[\w-]+\.js$/.test(n)), 'game chunk').toBe(true);
      expect(scripts.some((n) => /terrainWorker-[\w-]+\.js$/.test(n)), 'terrain worker').toBe(true);
      for (const n of scripts) expect(new URL(n).pathname.startsWith(`${BASE}assets/`), n).toBe(true);
    } finally {
      await close();
    }
  }, STEP_TIMEOUT);

  it('aircraft switches and resets leak no GPU textures/geometries, listeners or workers', async () => {
    const { page, problems, close } = await openPage('?veil=0&quality=high', { counters: true });
    try {
      // One-time allocations (each aircraft's first appearance, the first resets: missile renderers,
      // the Maverick picture target…) are not leaks, so compare like with like: the inventory after
      // k and after k + n identical rounds (switch through all three aircraft, then reset) must be the
      // same — a leak grows with every round (the A-10 leaked one texture per build before the deferred
      // disposal: +5 here). A little slack for the living world (air traffic, ships) allocating on its own.
      const ids = ['a10', 'f16', 'c172rg'];
      const round = async () => {
        for (const id of ids) {
          await page.evaluate((a) => (window as unknown as { sim: { selectAircraft(id: string): void } }).sim.selectAircraft(a), id);
          await settle(page, software ? 0.3 : 0.8);
        }
        for (let i = 0; i < (software ? 1 : 3); i++) {
          await page.keyboard.press('KeyR');
          await settle(page, software ? 0.2 : 0.3);
        }
        await settle(page, software ? 0.5 : 1.5);
      };
      const rounds = software ? 1 : 5;
      await round();
      await round();
      const gpu0 = await gpuMem(page);
      const c0 = await counts(page);
      for (let i = 0; i < rounds; i++) await round();
      const gpu1 = await gpuMem(page);
      const c1 = await counts(page);
      expect(gpu1.textures, `textures ${gpu0.textures} → ${gpu1.textures} over ${rounds} rounds`).toBeLessThanOrEqual(gpu0.textures + 2);
      expect(gpu1.geometries, `geometries ${gpu0.geometries} → ${gpu1.geometries}`).toBeLessThanOrEqual(gpu0.geometries + 8);
      expect(c1.window, 'window listeners').toBeLessThanOrEqual(c0.window);
      expect(c1.document, 'document listeners').toBeLessThanOrEqual(c0.document);
      expect(c1.total, 'all listeners').toBeLessThanOrEqual(c0.total + 2);
      expect(c1.workers.live, 'live workers').toBeLessThanOrEqual(c0.workers.live);
      expect(problems.all()).toEqual([]);
    } finally {
      await close();
    }
  }, STEP_TIMEOUT);

  it('resizes (desktop → phone portrait → full HD) keep the canvas full-size, buffer = css × pixel ratio', async () => {
    const { page, problems, close } = await openPage('?veil=0');
    try {
      for (const [w, h] of [[1024, 768], [390, 844], [1920, 1080]] as const) {
        await page.setViewportSize({ width: w, height: h });
        const t = Date.now();
        const ok = async () => {
          const c = await mainCanvasSize(page);
          const pr = await page.evaluate(() => (window as unknown as { __render: { pixelRatio(): number } }).__render.pixelRatio());
          return { c, pr, good: !!c && Math.abs(c.cssW - w) <= 1 && Math.abs(c.cssH - h) <= 1 && Math.abs(c.bufW - Math.floor(w * pr)) <= 2 && Math.abs(c.bufH - Math.floor(h * pr)) <= 2 };
        };
        let r = await ok();
        while (!r.good && Date.now() - t < 10_000 * e2eTimeScale()) {
          await page.waitForTimeout(100);
          r = await ok();
        }
        expect(r.good, `${w}×${h}: ${JSON.stringify(r)}`).toBe(true);
        await settle(page, software ? 0.2 : 0.5);
      }
      expect(problems.all()).toEqual([]);
    } finally {
      await close();
    }
  }, STEP_TIMEOUT);

  it('devicePixelRatio 1 renders ≤ 1 pixel per CSS pixel; devicePixelRatio 2 may climb to the configured cap', async () => {
    for (const dpr of [1, 2]) {
      const { page, problems, close } = await openPage('?veil=0', { dpr });
      try {
        const q = await page.evaluate(() => (window as unknown as { __render: { quality(): { maxPixelRatio: number; initialPixelRatio: number; tier: string } } }).__render.quality());
        if (dpr === 1) expect(q.maxPixelRatio).toBeLessThanOrEqual(1);
        else if (!software) expect(q.maxPixelRatio).toBeGreaterThan(1);
        expect(q.initialPixelRatio).toBeLessThanOrEqual(q.maxPixelRatio);
        expect(problems.all()).toEqual([]);
      } finally {
        await close();
      }
    }
  }, STEP_TIMEOUT);

  it('a frozen (background) tab resumes without a catch-up jump; hidden → audio suspended, shown → resumed', async () => {
    const { page, problems, close } = await openPage('?veil=0');
    try {
      await settle(page, software ? 0.3 : 1);
      // Unlock audio with a key (Shift: no sim action), as a player's first key press would.
      await page.keyboard.press('Shift');
      type A = { simAudio?: { context(): { state: string } } };
      const audioState = () => page.evaluate(() => (window as unknown as A).simAudio?.context().state ?? 'none');
      const t = Date.now();
      while ((await audioState()) !== 'running' && Date.now() - t < 5000) await page.waitForTimeout(100);
      const unlocked = (await audioState()) === 'running';

      // A background tab gets no frames; neither does a page whose main thread is stuck. Stall it for
      // 3 s: the first frame afterwards must advance the sim by at most config.sim.maxFrameDt, not 3 s.
      const jump = await page.evaluate(async () => {
        const sim = (window as unknown as { sim: { time: number } }).sim;
        const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
        await frame();
        const t0 = sim.time;
        const w = performance.now();
        while (performance.now() - w < 3000) {
          /* stalled */
        }
        await frame();
        await frame();
        return sim.time - t0;
      });
      expect(jump, 'sim seconds across a 3 s stall').toBeLessThan(0.6);
      await settle(page, software ? 0.2 : 0.5);

      if (unlocked) {
        const setHidden = (h: boolean) => page.evaluate((hidden) => {
          Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
          Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => (hidden ? 'hidden' : 'visible') });
          document.dispatchEvent(new Event('visibilitychange'));
        }, h);
        await setHidden(true);
        await page.waitForFunction(() => (window as unknown as A).simAudio?.context().state === 'suspended', null, { timeout: 5000 });
        await setHidden(false);
        await page.waitForFunction(() => (window as unknown as A).simAudio?.context().state === 'running', null, { timeout: 5000 });
      }
      expect(problems.all()).toEqual([]);
    } finally {
      await close();
    }
  }, STEP_TIMEOUT);
});
