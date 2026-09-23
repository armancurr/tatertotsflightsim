#!/usr/bin/env node
/**
 * Audio check in the LIVE game, in Google Chrome for Testing (never the user's Chrome), with
 * autoplay allowed so the real AudioContext runs without a click.
 *
 *   node scripts/audio-check.mjs [http://127.0.0.1:8092/]
 *
 * 1. Runs `runAudioSelfTest()` in the live page: every sound rendered offline through the real
 *    graph + output chain, measured (dBFS RMS, peak, pitch) and mix-checked.
 * 2. Meters the real-time output (post-limiter, `simAudio.meter()`) while forcing situations with
 *    `simAudio.override(...)`: Cessna idle/full/cockpit/stall horn, F-16 idle/MIL/AB/cockpit, a crash
 *    with a `sim:explosion` event, and the silence of the crash after a reset.
 * Exits 1 if a self-test check fails, the live context does not run, or anything clips.
 */
import { chromium } from 'playwright';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function testBrowserPath() {
  if (process.env.TEST_BROWSER) return process.env.TEST_BROWSER;
  const cache = join(homedir(), 'Library/Caches/ms-playwright');
  const dirs = existsSync(cache) ? readdirSync(cache).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1])) : [];
  for (const d of dirs) {
    for (const rel of ['chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
      const p = join(cache, d, rel);
      if (existsSync(p)) return p;
    }
  }
  throw new Error("No Chrome for Testing in ~/Library/Caches/ms-playwright — set TEST_BROWSER (never the user's Google Chrome).");
}

const base = process.argv[2] ?? 'http://127.0.0.1:8092/';
const browser = await chromium.launch({
  headless: true,
  executablePath: testBrowserPath(),
  args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && problems.push(`console.error: ${m.text()}`));
let bad = false;

await page.goto(`${base}?veil=0&aircraft=c172rg`, { waitUntil: 'load' });
await page.waitForFunction(() => window.sim && window.sim.fps > 0 && window.simAudio, null, { timeout: 60_000 });

// ── 1. Offline self-test in the live page ──
const results = await page.evaluate(() => window.runAudioSelfTest());
console.log('\n── runAudioSelfTest() in the live page (offline render, real graph) ──');
for (const r of results) {
  if (!r.ok) bad = true;
  console.log(`${r.ok ? 'ok  ' : 'FAIL'} ${r.name.padEnd(48)} ${r.name.startsWith('mix:') ? '' : `${r.db.toFixed(1).padStart(6)} dBFS  peak ${r.peak.toFixed(3)}  `}${r.detail}`);
}

// ── 2. The real-time context, metered post-limiter ──
await page.evaluate(() => window.simAudio.resume());
const state = await page.evaluate(() => window.sim.debug && document.hidden === false ? 'visible' : 'hidden');
const ctxState = await page.waitForFunction(() => {
  const l = window.simAudio.levels();
  return l.master > 0 ? 'running' : null;
}, null, { timeout: 5000 }).then(() => 'running').catch(() => 'not running');
console.log(`\n── live AudioContext: ${ctxState} (page ${state}) ──`);
if (ctxState !== 'running') bad = true;

/** Force inputs, let them settle, then meter the output for `ms`. */
async function measure(name, setup, ms = 1200) {
  const r = await page.evaluate(async ({ setup, ms }) => {
    const sa = window.simAudio;
    // eslint-disable-next-line no-new-func
    await new Function('sim', 'sa', `return (async () => { ${setup} })()`)(window.sim, sa);
    await new Promise((res) => setTimeout(res, 700));
    let acc = 0;
    let n = 0;
    let peak = 0;
    const t0 = performance.now();
    while (performance.now() - t0 < ms) {
      const m = sa.meter();
      if (m) {
        acc += m.rms * m.rms;
        n++;
        peak = Math.max(peak, m.peak);
      }
      await new Promise((res) => setTimeout(res, 40));
    }
    const rms = Math.sqrt(acc / Math.max(1, n));
    return { rms, peak, db: rms > 1e-6 ? 20 * Math.log10(rms) : -120, levels: sa.levels(), engine: sa.engine };
  }, { setup, ms });
  if (r.peak > 0.99) bad = true;
  console.log(`${name.padEnd(44)} ${r.db.toFixed(1).padStart(6)} dBFS  peak ${r.peak.toFixed(3)}  [${r.engine}] ${summary(r.levels)}`);
  return r;
}
const summary = (L) =>
  L.jet
    ? `N2 ${L.corePct.toFixed(0)}%  whine ${L.whineHz.toFixed(0)} Hz  roar ${L.roar.toFixed(2)}  AB ${L.afterburner.toFixed(2)}  crackle ${L.crackle.toFixed(2)}`
    : `fire ${L.firingHz.toFixed(1)} Hz  exhaust ${L.exhaust.toFixed(2)}  prop ${L.prop.toFixed(2)}  horn ${L.horn.toFixed(2)}  fire-bed ${L.fire.toFixed(2)}  crashLive ${L.crashLive}`;

const ON = "sa.override({ engineRunning: true, starting: false, onGround: true, groundSpeedKt: 0, airspeedKt: 0, crashed: false, touchdownFpm: null, stallWarning: false, gearWarning: false,";
await measure('C172 idle 700 rpm (chase)', `sim.setCamera('chase'); ${ON} rpm: 700, power: 0.045 });`);
await measure('C172 full power 2700 rpm (chase)', `${ON} rpm: 2700, power: 1 });`);
await measure('C172 cruise 2400 rpm (cockpit)', `sim.setCamera('cockpit'); ${ON} rpm: 2400, power: 0.7, onGround: false, airspeedKt: 110 });`);
await measure('C172 stall horn (cockpit, engine idle)', `${ON} rpm: 1200, power: 0.2, onGround: false, airspeedKt: 48, stallWarning: true });`);
await measure('C172 gear horn (cockpit)', `${ON} rpm: 1100, power: 0.1, onGround: false, airspeedKt: 80, gearWarning: true });`);

await page.evaluate(() => window.sim.selectAircraft('f16'));
await page.waitForFunction(() => window.simAudio.engine === 'jet', null, { timeout: 5000 }).catch(() => (bad = true));
await measure('F-16 idle (chase)', `sim.setCamera('chase'); ${ON} rpm: 70, power: 0.02 });`);
await measure('F-16 MIL (chase)', `${ON} rpm: 100, power: 1 });`);
await measure('F-16 afterburner (chase)', `${ON} rpm: 100, power: 1, afterburner: 1 });`);
await measure('F-16 MIL (cockpit)', `sim.setCamera('cockpit'); ${ON} rpm: 100, power: 1, onGround: false, airspeedKt: 350 });`);
await measure('F-16 afterburner (cockpit)', `${ON} rpm: 100, power: 1, afterburner: 1, onGround: false, airspeedKt: 350 });`);
const crash = await measure(
  'F-16 crash at 300 kt + sim:explosion (chase)',
  `sim.setCamera('chase'); ${ON} rpm: 100, power: 1, afterburner: 1, onGround: false, airspeedKt: 300 });
   await new Promise((r) => setTimeout(r, 300));
   sa.override({ crashed: true, crashSpeedKt: 300, rpm: 0, power: 0, engineRunning: false, afterburner: 0 });
   setTimeout(() => dispatchEvent(new CustomEvent('sim:explosion', { detail: { position: { x: 0, y: 0, z: 0 }, size: 1 } })), 900);`,
  2500,
);
if (!(crash.levels.explosions >= 1 && crash.levels.crashes >= 1)) bad = true;
const after = await measure('after reset (crash silenced, F-16 idle)', `sa.override(null); sim.reset(); ${ON} rpm: 70, power: 0.02 });`);
if (after.levels.fire !== 0 || after.levels.pendingExplosions !== 0 || after.levels.crashLive !== 0) bad = true;
await page.evaluate(() => window.simAudio.override(null));

if (problems.length) {
  console.log('\nproblems:\n' + problems.join('\n'));
  bad = true;
}
await browser.close();
console.log(bad ? '\nAUDIO CHECK: FAIL' : '\nAUDIO CHECK: OK');
process.exit(bad ? 1 : 0);
