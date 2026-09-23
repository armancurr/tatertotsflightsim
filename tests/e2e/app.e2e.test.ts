/**
 * End-to-end: the real page in headless Chromium (GPU WebGL where there is a GPU), driven only
 * through the keyboard and observed only through `window.sim` (plus the title, the viewport and
 * the full-screen canvas). A private Vite server is started for this checkout on a free port.
 *
 * The tests share one page and run in order (each leaves the sim in a known state).
 *
 * CPU-only machines (CI runners): WebGL falls back to SwiftShader at well under 1 fps, and the
 * sim advances at most 1/12 s per rendered frame, so there the same tests run with stretched
 * waits (setE2ETimeScale), a frame-rate floor of "renders at all" instead of 20 fps, and shorter
 * sim-time distances. Every test still runs. TEST_SOFTWARE_GL=1 reproduces this on any machine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Browser, Page } from 'playwright';
import {
  detectGpu, e2eTimeScale, launchChrome, mainCanvasSize, readSim, setE2ETimeScale, startViteServer, waitForSim, watchProblems,
  type E2EServer, type GpuInfo, type PageProblems, type Sim,
} from '../support/e2e';

// Upper bounds only: pass/fail is decided by waitForSim's own (scaled) timeouts, which are seconds
// on a GPU. The headroom is for CPU-only runners, where one rendered frame can take seconds.
const STEP_TIMEOUT = 15 * 60_000;
const angleDiff = (a: number, b: number) => Math.abs(((a - b + 540) % 360) - 180);

let server: E2EServer;
let browser: Browser;
let page: Page;
let problems: PageProblems;
let initial: Sim;
let gpu: GpuInfo;
/** fps every GPU should beat; on a software renderer, just "renders". */
let minFps = 20;
/** Sim seconds the "runs" test waits for, and the airspeed gain asked of the take-off run. */
let runSimSeconds = 3;
let accelKt = 10;
const t0 = Date.now();

beforeAll(async () => {
  [server, browser] = await Promise.all([startViteServer(), launchChrome()]);
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  gpu = await detectGpu(page);
  if (gpu.software) {
    setE2ETimeScale(Math.max(e2eTimeScale(), 60));
    minFps = 0;
    runSimSeconds = 0.3;
    accelKt = 2;
  }
  // eslint-disable-next-line no-console
  console.log(`[e2e] WebGL: ${gpu.renderer}${gpu.software ? ' (software: stretched waits, fps floor 0)' : ''}`);
  problems = watchProblems(page);
  await page.goto(server.url, { waitUntil: 'load' });
  // The app is up once window.sim reports a frame rate.
  initial = await waitForSim(page, (s) => typeof s.fps === 'number' && s.fps > 0, 'window.sim with fps > 0', 30_000);
}, 30 * 60_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
  // eslint-disable-next-line no-console
  console.log(`[e2e] total ${((Date.now() - t0) / 1000).toFixed(1)} s`);
});

async function press(key: string) {
  await page.keyboard.press(key);
}

describe('flight simulator in Chrome (window.sim + keyboard)', () => {
  it('has the title "Tater\'s Flight Sim · Tater Tots Flight Simulator"', async () => {
    expect(await page.title()).toBe("Tater's Flight Sim · Tater Tots Flight Simulator");
  });

  it('window.sim exposes the required fields with the right types and plausible initial values', () => {
    const s = initial;
    for (const k of ['airspeed', 'altitude', 'heading', 'pitch', 'roll', 'throttle', 'flaps', 'fps'] as const) {
      expect(typeof s[k], k).toBe('number');
      expect(Number.isFinite(s[k]), k).toBe(true);
    }
    for (const k of ['gear', 'state'] as const) expect(typeof s[k], k).toBe('string');
    expect(s.state).toBe('ground');
    expect(s.gear).toBe('down');
    expect(s.airspeed).toBeLessThan(2);
    expect(s.throttle).toBe(0);
    expect(s.flaps).toBe(0);
    expect(angleDiff(s.heading, 360), `heading ${s.heading}`).toBeLessThan(3);
    expect(Math.abs(s.pitch)).toBeLessThan(5);
    expect(Math.abs(s.roll)).toBeLessThan(2);
    expect(s.altitude).toBeGreaterThanOrEqual(-10);
    expect(s.altitude).toBeLessThan(1000);
    expect(s.heading).toBeGreaterThanOrEqual(0);
    expect(s.heading).toBeLessThanOrEqual(360);
    expect(['cockpit', 'chase', 'external', 'orbit']).toContain(s.camera);
    expect(s.paused).toBe(false);
  });

  it('runs 5 s with no console errors, page errors or failed/4xx requests, and reports > 20 fps', async () => {
    const start = await readSim(page);
    await page.waitForTimeout(5000);
    const s = await waitForSim(page, (x) => (x.time as number) > (start!.time as number) + runSimSeconds, `sim time +${runSimSeconds} s`, 10_000);
    expect(problems.all()).toEqual([]);
    expect(s.state).toBe('ground');
    expect(s.fps, `fps on ${gpu.renderer}`).toBeGreaterThan(minFps);
  }, STEP_TIMEOUT);

  it('holding W raises sim.throttle; at full throttle the airspeed builds', async () => {
    await page.keyboard.down('KeyW');
    try {
      await waitForSim(page, (s) => s.throttle > 20, 'throttle rising while W is held', 5000);
      await waitForSim(page, (s) => s.throttle >= 100, 'throttle reaching 100 %', 8000);
    } finally {
      await page.keyboard.up('KeyW');
    }
    const a0 = (await readSim(page))!.airspeed;
    const s = await waitForSim(page, (x) => x.airspeed > a0 + accelKt, `airspeed +${accelKt} kt at full throttle`, 12_000);
    expect(s.throttle).toBe(100);
    expect(['ground', 'airborne']).toContain(s.state);
  }, STEP_TIMEOUT);

  it('R resets to a stationary aircraft on the runway, throttle idle', async () => {
    await press('KeyR');
    const s = await waitForSim(page, (x) => x.state === 'ground' && x.airspeed < 1 && x.throttle === 0, 'reset to the runway');
    expect(Math.abs(s.altitude - initial.altitude)).toBeLessThan(5);
    expect(angleDiff(s.heading, 360)).toBeLessThan(3);
    expect(s.gear).toBe('down');
  }, STEP_TIMEOUT);

  it('P pauses (sim.paused, sim.time frozen) and P resumes', async () => {
    await press('KeyP');
    const p = await waitForSim(page, (s) => s.paused === true, 'paused');
    await page.waitForTimeout(600);
    const p2 = (await readSim(page))!;
    expect(p2.paused).toBe(true);
    expect(p2.time).toBe(p.time);
    await press('KeyP');
    await waitForSim(page, (s) => s.paused === false, 'resumed');
    await waitForSim(page, (s) => (s.time as number) > (p.time as number) + 0.3, 'sim time advancing again', 5000);
  }, STEP_TIMEOUT);

  it('keys 1–4 select cockpit / chase / external / orbit and C cycles', async () => {
    const want: [string, string][] = [['Digit1', 'cockpit'], ['Digit2', 'chase'], ['Digit3', 'external'], ['Digit4', 'orbit']];
    for (const [key, mode] of want) {
      await press(key);
      await waitForSim(page, (s) => s.camera === mode, `camera ${mode} after ${key}`, 3000);
    }
    await press('KeyC');
    await waitForSim(page, (s) => s.camera === 'cockpit', 'C cycles orbit → cockpit', 3000);
    await press('KeyC');
    await waitForSim(page, (s) => s.camera === 'chase', 'C cycles cockpit → chase', 3000);
  }, STEP_TIMEOUT);

  it('F lowers the flaps (sim.flaps rises) and V raises them again', async () => {
    await press('KeyF');
    await waitForSim(page, (s) => s.flaps > 3, 'flaps extending after F', 5000);
    await press('KeyV');
    await waitForSim(page, (s) => s.flaps === 0, 'flaps retracting after V', 8000);
  }, STEP_TIMEOUT);

  it('Shift+R puts the aircraft on final approach: airborne, well above the field, flying', async () => {
    await page.keyboard.press('Shift+KeyR');
    const s = await waitForSim(page, (x) => x.state === 'airborne' && x.altitude > initial.altitude + 600, 'airborne on the approach', 5000);
    expect(s.airspeed).toBeGreaterThan(60);
    expect(s.airspeed).toBeLessThan(90);
    expect(s.gear).toBe('down');
    expect(s.flaps).toBeGreaterThan(0);
    expect(angleDiff(s.heading, 360)).toBeLessThan(5);
    if (typeof s.altitudeAGL === 'number') expect(s.altitudeAGL).toBeGreaterThan(600);
  }, STEP_TIMEOUT);

  it('G raises the gear handle in the air (gear goes into transit) and G lowers it again', async () => {
    await press('KeyG');
    const up = await waitForSim(page, (s) => s.gear === 'transit', 'gear in transit after G', 3000);
    if (up.gearHandle !== undefined) expect(up.gearHandle).toBe('up');
    await press('KeyG');
    const down = await waitForSim(page, (s) => s.gearHandle === undefined || s.gearHandle === 'down', 'gear handle down after the second G', 3000);
    expect(['transit', 'down']).toContain(down.gear);
    await press('KeyR');
    await waitForSim(page, (s) => s.state === 'ground' && s.gear === 'down', 'back on the runway');
  }, STEP_TIMEOUT);

  it('resizing 1440×900 → 1024×768 keeps the canvas full-size, with no errors', async () => {
    const before = await mainCanvasSize(page);
    expect(before).not.toBeNull();
    expect(before!.cssW).toBeCloseTo(1440, 0);
    expect(before!.cssH).toBeCloseTo(900, 0);
    await page.setViewportSize({ width: 1024, height: 768 });
    const t = Date.now();
    let c = await mainCanvasSize(page);
    while ((Math.abs(c!.cssW - 1024) > 1 || Math.abs(c!.bufW / c!.bufH - 1024 / 768) > 0.02) && Date.now() - t < 5000 * e2eTimeScale()) {
      await page.waitForTimeout(50);
      c = await mainCanvasSize(page);
    }
    expect(Math.abs(c!.cssW - 1024)).toBeLessThanOrEqual(1);
    expect(Math.abs(c!.cssH - 768)).toBeLessThanOrEqual(1);
    expect(Math.abs(c!.bufW / c!.bufH - 1024 / 768), 'drawing buffer keeps the viewport aspect').toBeLessThan(0.02);
    // Keeps rendering after the resize.
    const s0 = (await readSim(page))!;
    await waitForSim(page, (s) => (s.time as number) > (s0.time as number) + Math.min(0.5, runSimSeconds) && s.fps > minFps, 'still running after resize', 5000);
    expect(problems.all()).toEqual([]);
  }, STEP_TIMEOUT);
});
