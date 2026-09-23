/**
 * End-to-end harness: a private Vite dev server for this checkout (free port, 127.0.0.1, own
 * dependency cache) and a headless Chromium — never the user's own Google Chrome (browser choice:
 * scripts/test-browser.mjs) — plus polling helpers around `window.sim`.
 *
 * Runs on a real GPU where there is one (Metal on macOS) and on CPU-only machines such as CI
 * runners (SwiftShader). `detectGpu()` tells the two apart; on a software renderer every
 * `waitForSim` timeout is stretched (`setE2ETimeScale`) because the sim advances at most
 * `maxSubSteps` physics steps per rendered frame, so it runs slower than real time at a few fps.
 *
 * E2E tests talk to the app ONLY through `window.sim` and the keyboard (plus the page title,
 * viewport and the full-screen canvas size), so they keep working when the interim build is
 * replaced by the full app.
 */
import { createServer, type ViteDevServer } from 'vite';
import { chromium, type Browser, type ConsoleMessage, type Page } from 'playwright';
import { createHash } from 'node:crypto';
import { createServer as createNetServer } from 'node:net';
import { realpathSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSoftwareRenderer, launchOptions, resolveTestBrowser } from '../../scripts/test-browser.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** A free TCP port on 127.0.0.1. */
export async function freePort(): Promise<number> {
  return new Promise((res, rej) => {
    const srv = createNetServer();
    srv.unref();
    srv.on('error', rej);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      srv.close(() => (addr && typeof addr === 'object' ? res(addr.port) : rej(new Error('no port'))));
    });
  });
}

export interface E2EServer {
  url: string;
  close(): Promise<void>;
}

/**
 * Start Vite on a free port. The dependency cache goes to the OS temp dir (keyed by the checkout
 * path) so it never touches the node_modules/.vite of a dev server running from another checkout
 * (worktrees share node_modules through a symlink).
 */
export async function startViteServer(root = ROOT): Promise<E2EServer> {
  const port = await freePort();
  const cacheDir = join(tmpdir(), `flightsim-e2e-vite-${createHash('sha1').update(root).digest('hex').slice(0, 10)}`);
  const allow = [root, cacheDir];
  const nm = join(root, 'node_modules');
  if (existsSync(nm)) allow.push(dirname(realpathSync(nm)));
  const server: ViteDevServer = await createServer({
    root,
    cacheDir,
    logLevel: 'error',
    clearScreen: false,
    server: { host: '127.0.0.1', port, strictPort: true, hmr: false, watch: null, fs: { allow } },
  });
  await server.listen();
  return { url: `http://127.0.0.1:${port}/`, close: () => server.close() };
}

/**
 * The browser binary for automated tests: TEST_BROWSER → (macOS) the newest Chrome for Testing in
 * the Playwright cache → undefined = Playwright's own bundled Chromium. NEVER the user's Google
 * Chrome (an automation instance of it hijacks the Dock icon). Pass it as `executablePath`.
 */
export function testBrowserPath(): string | undefined {
  return resolveTestBrowser().executablePath;
}

/** Headless Chromium with GPU WebGL where available (same resolver and flags as scripts/shot.mjs). */
export function launchChrome(): Promise<Browser> {
  return chromium.launch(launchOptions());
}

export interface GpuInfo {
  /** WebGL renderer string, e.g. "ANGLE Metal Renderer: Apple M2 Max" or "…SwiftShader…". */
  renderer: string;
  /** CPU rasteriser (SwiftShader, llvmpipe) or no WebGL2: expect single-digit fps. */
  software: boolean;
}

/** Which WebGL2 renderer this page gets. */
export async function detectGpu(page: Page): Promise<GpuInfo> {
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return 'no webgl2';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
  });
  return { renderer, software: isSoftwareRenderer(renderer) };
}

let timeScale = Math.max(1, Number(process.env.E2E_TIME_SCALE) || 1);

/** Multiplier on every `waitForSim` timeout (≥ 1). Starts at E2E_TIME_SCALE (default 1). */
export function e2eTimeScale(): number {
  return timeScale;
}

/** Stretch every later `waitForSim` timeout by this factor (e.g. on a software renderer). */
export function setE2ETimeScale(scale: number): void {
  timeScale = Math.max(1, Number.isFinite(scale) ? scale : 1);
}

export interface PageProblems {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  all(): string[];
}

/** Record console errors, uncaught page errors, failed requests and HTTP ≥ 400 responses. */
export function watchProblems(page: Page): PageProblems {
  const p: PageProblems = {
    consoleErrors: [],
    pageErrors: [],
    failedRequests: [],
    all() { return [...this.consoleErrors, ...this.pageErrors, ...this.failedRequests]; },
  };
  page.on('console', (m: ConsoleMessage) => { if (m.type() === 'error') p.consoleErrors.push(`console.error: ${m.text()}`); });
  page.on('pageerror', (e) => p.pageErrors.push(`pageerror: ${e.message}`));
  page.on('requestfailed', (r) => p.failedRequests.push(`requestfailed: ${r.url()} ${r.failure()?.errorText ?? ''}`));
  page.on('response', (r) => { if (r.status() >= 400) p.failedRequests.push(`HTTP ${r.status()}: ${r.url()}`); });
  return p;
}

export type Sim = Record<string, unknown> & {
  airspeed: number; altitude: number; heading: number; pitch: number; roll: number; throttle: number;
  gear: string; flaps: number; state: string; fps: number; camera?: string; paused?: boolean; time?: number;
  gearHandle?: string; altitudeAGL?: number;
};

/** A plain-data copy of window.sim (functions dropped), or null before the app has installed it. */
export function readSim(page: Page): Promise<Sim | null> {
  return page.evaluate(() => {
    const s = (window as unknown as { sim?: Record<string, unknown> }).sim;
    if (!s || typeof s.state !== 'string') return null;
    return JSON.parse(JSON.stringify(s)) as Record<string, unknown>;
  }) as Promise<Sim | null>;
}

/**
 * Poll window.sim until `pred` holds (checked in Node on a fresh copy each time); returns that copy.
 * Throws with the last seen snapshot on timeout. The timeout is multiplied by `e2eTimeScale()`.
 */
export async function waitForSim(page: Page, pred: (s: Sim) => boolean, what: string, timeoutMs = 10_000, everyMs = 50): Promise<Sim> {
  const t0 = Date.now();
  timeoutMs *= timeScale;
  let last: Sim | null = null;
  for (;;) {
    last = await readSim(page);
    if (last && pred(last)) return last;
    if (Date.now() - t0 > timeoutMs) {
      const brief = last ? JSON.stringify(pick(last, ['state', 'airspeed', 'altitude', 'heading', 'throttle', 'gear', 'gearHandle', 'flaps', 'camera', 'paused', 'time', 'fps'])) : 'window.sim missing';
      throw new Error(`timed out after ${timeoutMs} ms waiting for: ${what}; last window.sim = ${brief}`);
    }
    await page.waitForTimeout(everyMs);
  }
}

function pick(o: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const r: Record<string, unknown> = {};
  for (const k of keys) if (k in o) r[k] = o[k];
  return r;
}

/** Size of the largest canvas on the page (CSS box) and its drawing buffer. */
export function mainCanvasSize(page: Page): Promise<{ cssW: number; cssH: number; bufW: number; bufH: number } | null> {
  return page.evaluate(() => {
    let best: HTMLCanvasElement | null = null;
    let area = -1;
    for (const c of Array.from(document.querySelectorAll('canvas'))) {
      const r = c.getBoundingClientRect();
      if (r.width * r.height > area) { area = r.width * r.height; best = c; }
    }
    if (!best) return null;
    const r = best.getBoundingClientRect();
    return { cssW: r.width, cssH: r.height, bufW: best.width, bufH: best.height };
  });
}
