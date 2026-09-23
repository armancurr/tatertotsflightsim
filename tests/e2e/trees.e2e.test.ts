/**
 * End-to-end: the tree shaders (near leaf cards with per-tree clump variation, their shadow depth
 * material, the impostor billboards, the impostor bake) compile, link and draw in a real browser,
 * and the LOD switch is seamless: every species drawn as its near mesh and as its impostor at the
 * switch distance has the same brightness and about the same size on screen (trees preview,
 * `compare=1`), at midday and at golden hour (back-lit translucency on both paths).
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

interface Stat {
  rgb: [number, number, number];
  luma: number;
  pixels: number;
}
interface Compare {
  name: string;
  near: Stat;
  impostor: Stat;
}

async function open(path: string): Promise<{ page: Page; problems: PageProblems }> {
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 } });
  const problems = watchProblems(page);
  const warnings: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'warning' && /shader|program|glsl/i.test(m.text())) warnings.push(m.text());
  });
  await page.goto(`${server.url}${path}`, { waitUntil: 'load' });
  await page.waitForFunction(() => (window as unknown as { __ready: boolean }).__ready === true, null, { timeout });
  problems.consoleErrors.push(...warnings);
  return { page, problems };
}

async function compare(tod: number): Promise<{ rows: Compare[]; problems: PageProblems; page: Page }> {
  const { page, problems } = await open(`/preview/trees.html?compare=1&tod=${tod}`);
  await page.waitForFunction(() => (window as unknown as { __compare: unknown }).__compare !== null, null, { timeout });
  const rows = (await page.evaluate(() => (window as unknown as { __compare: unknown }).__compare)) as Compare[];
  return { rows, problems, page };
}

describe('tree shaders and LOD consistency (e2e)', () => {
  for (const [tod, label] of [
    [1, 'midday'],
    [2, 'golden hour'],
  ] as const) {
    it(`${label}: every species' impostor matches its near mesh in brightness (±18 %) and size (±30 %) at the switch distance`, async () => {
      const { rows, problems, page } = await compare(tod);
      expect(problems.all()).toEqual([]);
      expect(rows.length).toBe(7);
      for (const r of rows) {
        const ctx = `${r.name}: near ${JSON.stringify(r.near)} impostor ${JSON.stringify(r.impostor)}`;
        expect(r.near.pixels, ctx).toBeGreaterThan(2000);
        expect(r.impostor.pixels, ctx).toBeGreaterThan(2000);
        expect(Math.abs(r.impostor.luma / r.near.luma - 1), ctx).toBeLessThan(0.18);
        expect(Math.abs(r.impostor.pixels / r.near.pixels - 1), ctx).toBeLessThan(0.3);
        // green foliage (not a black or white billboard)
        expect(r.near.rgb[1], ctx).toBeGreaterThanOrEqual(r.near.rgb[2]);
        expect(r.impostor.rgb[1], ctx).toBeGreaterThanOrEqual(r.impostor.rgb[2]);
      }
      await page.close();
    }, 30 * 60_000);
  }

  it('variants, dead and turning trees and the impostor rows draw without shader errors', async () => {
    for (const t of [0.001, 0.5, 0.99]) {
      const { page, problems } = await open(`/preview/trees.html?imp=1&variants=3&t=${t}&tod=3`);
      await page.waitForTimeout(800);
      expect(problems.all()).toEqual([]);
      await page.close();
    }
  }, 30 * 60_000);
});
