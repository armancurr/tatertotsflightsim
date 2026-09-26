#!/usr/bin/env node
/**
 * Wake QA harness (dev only): drives a vessel through `window.sim` in Chrome for Testing and
 * photographs its wake from a fixed set of views, so before/after pairs are the same shots.
 *
 *   node scripts/wake-shots.mjs <outDir> [--port 8108] [--aircraft v50] [--only chase22,aerial800]
 *        [--size 1440x900] [--prefix before-]
 *
 * Views: chase22 (22 kt chase, like the owner's report), chase34 (full speed), helmAft (the helm,
 * head turned aft), turn (a hard turn to port, chase), aerial800 / aerial3000 (orbit camera pulled
 * out to ~800 / ~3,000 ft above the wake), golden (golden hour, chase), night (night, chase), port
 * (fps at the marina), offshore (fps at sea), shipAerial / shipChase / ski (synthetic hull sizes via
 * ?wakeHull=), lowQuality (?quality=low). Prints fps and the wake's stats per view.
 * The orbit camera's range is widened at runtime through the dev server's config module (the same
 * module instance the app uses) — nothing is written to the game.
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { launchOptions } from './test-browser.mjs';

const args = process.argv.slice(2);
const outDir = args[0] ?? 'qa/screenshots/wake';
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const port = opt('port', '8108');
const craft = opt('aircraft', 'v50');
const prefix = opt('prefix', '');
const only = opt('only', '');
const [W, H] = opt('size', '1440x900').split('x').map(Number);
mkdirSync(outDir, { recursive: true });

const VIEWS = {
  chase22: { tod: 1, kt: 22, cam: 'chase', settle: 26 },
  chase34: { tod: 1, kt: 34, cam: 'chase', settle: 26 },
  helmAft: { tod: 1, kt: 24, cam: 'cockpit', settle: 24, look: { dx: 560, dy: 40 } },
  turn: { tod: 1, kt: 28, cam: 'chase', settle: 16, turn: 'ArrowLeft', turnS: 6 },
  aerial800: { tod: 1, kt: 26, cam: 'orbit', settle: 60, orbit: { dist: 330, pitchDeg: 48, dx: 0 } },
  aerial3000: { tod: 1, kt: 26, cam: 'orbit', settle: 75, orbit: { dist: 1250, pitchDeg: 48, dx: 0 } },
  golden: { tod: 2, kt: 24, cam: 'chase', settle: 24 },
  night: { tod: 3, kt: 24, cam: 'chase', settle: 24 }, // 'Dawn': the game's dimmest preset (sun 4°)
  dusk: { tod: 3, kt: 24, cam: 'chase', settle: 24, sunDeg: -3 }, // the sun just below the horizon (civil twilight)
  port: { tod: 1, kt: 0, cam: 'chase', settle: 6, berth: true },
  // synthetic hulls through ?wakeHull= (the V50 drives, the wake is drawn for the given size)
  shipAerial: { tod: 1, kt: 20, cam: 'orbit', settle: 100, orbit: { dist: 900, pitchDeg: 40 }, q: '&wakeHull=265,32' },
  shipChase: { tod: 1, kt: 20, cam: 'chase', settle: 60, q: '&wakeHull=265,32' },
  ski: { tod: 1, kt: 33, cam: 'chase', settle: 20, q: '&wakeHull=3.3,1.2,jet' },
  lowQuality: { tod: 1, kt: 22, cam: 'chase', settle: 26, quality: 'low' },
  offshore: { tod: 1, kt: 24, cam: 'chase', settle: 20 },
};

// --perf: uncapped frames (no vsync), and the mean fps over 6 s after the settle
const perf = args.includes('--perf');
const browser = await chromium.launch(launchOptions(['--enable-unsafe-webgpu', ...(perf ? ['--disable-gpu-vsync', '--disable-frame-rate-limit'] : [])]));
const names = only ? only.split(',') : Object.keys(VIEWS);
for (const name of names) {
  const v = VIEWS[name];
  if (!v) continue;
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errs = [];
  page.on('pageerror', (e) => errs.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error' || /shader|THREE\.WebGLProgram/i.test(m.text())) errs.push(m.text());
  });
  const spawn = v.berth ? 'berth' : 'sea';
  await page.goto(`http://127.0.0.1:${port}/?aircraft=${craft}&spawn=${spawn}&cam=${v.cam}&tod=${v.tod}&quality=${v.quality ?? 'high'}${v.q ?? ''}`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof window.sim?.fps === 'number' && window.sim.fps > 0 && window.sim.vessel, undefined, { timeout: 90_000 });
  await page.waitForTimeout(3000);
  if (!v.berth) {
    await page.evaluate(({ kt }) => {
      const p = window.sim.position;
      window.sim.teleport({ x: p.x, z: p.z, headingDeg: window.sim.heading, speedKt: kt });
    }, { kt: v.kt });
  }
  if (v.sunDeg !== undefined) {
    await page.evaluate(async ({ deg, tod }) => {
      const { CONFIG } = await import('/src/config.ts');
      CONFIG.atmosphere.timeOfDay[tod].elevationDeg = deg;
      window.sim.setTimeOfDay(tod);
    }, { deg: v.sunDeg, tod: v.tod });
  }
  if (v.orbit) {
    // widen the orbit camera's range in the running app's config (same module instances), then
    // zoom out with the wheel and drag the elevation up
    await page.evaluate(async ({ o, craft }) => {
      const { getAircraftDef } = await import('/src/fleet/index.ts');
      const { CONFIG } = await import('/src/config.ts');
      for (const c of [getAircraftDef(craft).config.camera.orbit, CONFIG.camera.orbit]) {
        c.maxDistance = Math.max(c.maxDistance, o.dist);
        c.autoRotateDegPerSec = 0;
      }
    }, { o: v.orbit, craft });
    await page.mouse.move(W / 2, H / 2);
    const notches = Math.log(v.orbit.dist / 30) / Math.log(1.12);
    for (let i = 0; i < Math.ceil(notches); i++) await page.mouse.wheel(0, 100);
    await page.mouse.down();
    const dy = (v.orbit.pitchDeg - 12) / 0.3;
    for (let i = 1; i <= 10; i++) await page.mouse.move(W / 2, H / 2 + (dy * i) / 10);
    await page.mouse.up();
  }
  const turnAt = v.turn ? v.settle - v.turnS : Infinity;
  const t0 = Date.now();
  let turning = false;
  while ((Date.now() - t0) / 1000 < v.settle) {
    if (!turning && (Date.now() - t0) / 1000 > turnAt) {
      await page.keyboard.down(v.turn);
      turning = true;
    }
    // a helmsman on the lever: short taps of W / S hold the target speed
    if (v.kt > 0 && !turning) {
      const kt = await page.evaluate(() => window.sim.vessel?.speedKt ?? 0);
      const key = kt > v.kt + 0.7 ? 'KeyS' : kt < v.kt - 0.7 && v.kt < 33 ? 'KeyW' : v.kt >= 33 ? 'KeyW' : null;
      if (key) {
        await page.keyboard.down(key);
        await page.waitForTimeout(Math.min(120, 25 * Math.abs(kt - v.kt) + 20));
        await page.keyboard.up(key);
      }
    }
    await page.waitForTimeout(200);
  }
  if (v.look) {
    await page.mouse.move(W / 2, H / 2);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(W / 2 + (v.look.dx * i) / 10, H / 2 + (v.look.dy * i) / 10);
    await page.waitForTimeout(400);
  }
  let perfFps = null;
  if (perf) {
    const samples = [];
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(500);
      samples.push(await page.evaluate(() => window.sim.fps));
    }
    samples.sort((a, b) => a - b);
    perfFps = samples[Math.floor(samples.length / 2)];
  }
  // GPU time of the scene pass (EXT_disjoint_timer_query; smoothed), median of 12 reads, and the pixel ratio
  let gpu = null;
  if (perf) {
    const g = [];
    for (let i = 0; i < 12; i++) {
      await page.waitForTimeout(250);
      g.push(await page.evaluate(() => { const r = window.__render; const s = r?.gpu?.() ?? {}; return { scene: s.scene ?? null, post: s.post ?? null, pr: r?.pixelRatio?.() }; }));
    }
    const sc = g.map((x) => x.scene).filter((x) => x !== null).sort((a, b) => a - b);
    gpu = { sceneMs: sc.length ? sc[Math.floor(sc.length / 2)] : null, pixelRatio: g[g.length - 1].pr };
  }
  // --bench: paused, uncapped; alternate the sea's wake sampling off / on (3 s windows × 4) and report
  // the mean frame time of each: the wake's cost in the sea shader, free of machine drift between runs
  let bench = null;
  if (args.includes('--bench')) {
    bench = await page.evaluate(async () => {
      const { WAKE_MAP_UNIFORMS } = await import('/src/world/water/wakeMap.ts');
      const xf = WAKE_MAP_UNIFORMS.uWakeXf.value;
      let w = xf.w;
      Object.defineProperty(xf, 'w', { get: () => (window.__wakeOff ? 0 : w), set: (v) => { w = v; }, configurable: true });
      window.sim.pause();
      const win = (ms) => new Promise((res) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < ms) requestAnimationFrame(f); else res((performance.now() - t0) / n); }; requestAnimationFrame(f); });
      const off = [];
      const on = [];
      for (let i = 0; i < 4; i++) {
        window.__wakeOff = true; await win(400); off.push(await win(3000));
        window.__wakeOff = false; await win(400); on.push(await win(3000));
      }
      const med = (a) => a.slice().sort((x, y) => x - y)[a.length >> 1];
      return { offMs: +med(off).toFixed(3), onMs: +med(on).toFixed(3), wakeMs: +(med(on) - med(off)).toFixed(3), off: off.map((x) => +x.toFixed(2)), on: on.map((x) => +x.toFixed(2)) };
    });
  }
  const info = await page.evaluate(() => {
    const s = window.sim;
    const pw = s.debug?.().systems?.playerWake;
    return { fps: s.fps, avg: s.perf?.avg, kt: s.vessel?.speedKt, planing: s.vessel?.planing, hdg: s.heading, pos: s.position, wake: pw };
  });
  const file = `${outDir}/${prefix}${name}.png`;
  await page.screenshot({ path: file });
  if (v.look) await page.mouse.up();
  if (turning) await page.keyboard.up(v.turn);
  if (perfFps !== null) info.perfFps = perfFps;
  if (gpu) info.gpu = gpu;
  if (bench) info.bench = bench;
  console.log(`${name}: ${file} ${JSON.stringify(info)}${errs.length ? ` ERRORS: ${errs.slice(0, 5).join(' | ')}` : ''}`);
  await page.close();
}
await browser.close();
