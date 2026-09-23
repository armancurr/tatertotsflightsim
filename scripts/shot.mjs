#!/usr/bin/env node
/**
 * Headless screenshot + console check, for development QA.
 *
 *   node scripts/shot.mjs <url> <out.png> [--size 1440x900] [--wait 3000]
 *        [--eval "<js run in the page before the shot; may return a value>"] [--eval-after-ms 0]
 *
 * Prints the GPU renderer string, every console message, page errors, failed
 * requests and the --eval result. Exits 1 if the page threw or a request failed.
 * Browser: TEST_BROWSER → (macOS) Chrome for Testing from the Playwright cache, on the Metal GPU →
 * Playwright's bundled Chromium (Linux/Windows; SwiftShader if there is no GPU). Never your own
 * Google Chrome — see scripts/test-browser.mjs.
 */
import { chromium } from 'playwright';
import { isSoftwareRenderer, launchOptions } from './test-browser.mjs';

const args = process.argv.slice(2);
const url = args[0];
const out = args[1];
if (!url || !out) {
  console.error('usage: node scripts/shot.mjs <url> <out.png> [--size WxH] [--wait ms] [--eval js]');
  process.exit(2);
}
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const [w, h] = opt('size', '1440x900').split('x').map(Number);
const wait = Number(opt('wait', '3000'));
const evalJs = opt('eval', null);

const browser = await chromium.launch(launchOptions(['--enable-unsafe-webgpu']));
const page = await browser.newPage({ viewport: { width: w, height: h } });
let bad = false;
page.on('console', (m) => console.log(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => { bad = true; console.log(`[pageerror] ${e.message}`); });
page.on('requestfailed', (r) => { bad = true; console.log(`[requestfailed] ${r.url()} ${r.failure()?.errorText}`); });
page.on('response', (r) => { if (r.status() >= 400) { bad = true; console.log(`[http ${r.status()}] ${r.url()}`); } });

await page.goto(url, { waitUntil: 'load' });
await page.waitForTimeout(wait);
const gpu = await page.evaluate(() => {
  const c = document.createElement('canvas');
  const gl = c.getContext('webgl2');
  if (!gl) return 'no webgl2';
  const ext = gl.getExtension('WEBGL_debug_renderer_info');
  return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
});
console.log(`[gpu] ${gpu}${isSoftwareRenderer(gpu) ? ' (software rendering: expect a low frame rate)' : ''}`);
if (evalJs) {
  const result = await page.evaluate(`(async () => { ${evalJs.includes('return') ? evalJs : `return (${evalJs})`} })()`);
  console.log(`[eval] ${JSON.stringify(result)}`);
  await page.waitForTimeout(Number(opt('eval-after-ms', '0')));
}
await page.screenshot({ path: out });
console.log(`[shot] ${out} (${w}x${h})`);
await browser.close();
process.exit(bad ? 1 : 0);
