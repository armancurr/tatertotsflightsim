/**
 * Which browser the automated tests (tests/support/e2e.ts) and scripts/shot.mjs launch.
 * Works on macOS, Linux and Windows. Resolution order:
 *
 *   1. TEST_BROWSER=/path/to/a/chromium-binary          (any platform)
 *   2. macOS: the newest "Google Chrome for Testing" in Playwright's cache
 *      (PLAYWRIGHT_BROWSERS_PATH, or ~/Library/Caches/ms-playwright). Launched with an explicit
 *      executablePath it runs the full browser in headless mode, which gets Metal GPU WebGL.
 *   3. Playwright's own bundled Chromium (`npx playwright install chromium`): no executablePath,
 *      no channel — Playwright picks the build that matches its version.
 *
 * TEST_SOFTWARE_GL=1 forces CPU WebGL (SwiftShader) on any machine — what a GPU-less CI runner
 * gets — so CI-only failures can be reproduced locally.
 *
 * It NEVER launches your everyday Google Chrome: an automation instance of it takes over the
 * Chrome icon in the Dock, so your normal profile won't open until it quits. Pointing
 * TEST_BROWSER at it is refused.
 *
 * Plain ESM JavaScript (typed by test-browser.d.mts) so Node scripts can import it directly.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix } from 'node:path';

/** Browser binaries inside a Playwright `chromium-<revision>` folder on macOS, preferred first. */
const MAC_LAYOUTS = [
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
];

/** The everyday Google Chrome (stable/beta/dev/canary) on macOS, Windows and Linux — never Chrome for Testing. */
const USER_CHROME = [
  /\/Google Chrome( Beta| Dev| Canary)?\.app\//i,
  /[\\/]Google[\\/]Chrome( Beta| Dev| SxS)?[\\/]Application[\\/]/i,
  /\/opt\/google\/chrome/i,
  /(^|[\\/])google-chrome(-stable|-beta|-unstable)?$/i,
];

/** The real machine: environment, platform, home directory and filesystem. */
export function systemProbe() {
  return {
    env: process.env,
    platform: process.platform,
    home: homedir(),
    exists: existsSync,
    list: (dir) => {
      try { return readdirSync(dir); } catch { return []; }
    },
  };
}

/**
 * @param {import('./test-browser.d.mts').BrowserProbe} [probe]
 * @returns {import('./test-browser.d.mts').ResolvedBrowser}
 */
export function resolveTestBrowser(probe = systemProbe()) {
  const fromEnv = (probe.env.TEST_BROWSER ?? '').trim();
  if (fromEnv) {
    if (USER_CHROME.some((re) => re.test(fromEnv))) {
      throw new Error(`TEST_BROWSER points at your everyday Google Chrome (${fromEnv}). Use Chromium or Chrome for Testing instead (npx playwright install chromium) — an automation instance of Google Chrome hijacks the normal one.`);
    }
    return { executablePath: fromEnv, source: 'TEST_BROWSER' };
  }
  if (probe.platform === 'darwin') {
    const custom = probe.env.PLAYWRIGHT_BROWSERS_PATH;
    const cache = custom && custom !== '0' ? custom : posix.join(probe.home, 'Library/Caches/ms-playwright');
    const revisions = probe.list(cache)
      .map((d) => /^chromium-(\d+)$/.exec(d))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .sort((a, b) => b - a);
    for (const rev of revisions) {
      for (const rel of MAC_LAYOUTS) {
        const p = posix.join(cache, `chromium-${rev}`, rel);
        if (probe.exists(p)) return { executablePath: p, source: 'chrome-for-testing' };
      }
    }
  }
  return { executablePath: undefined, source: 'playwright' };
}

/**
 * GPU switches for headless WebGL2. macOS: ANGLE on Metal (the real GPU). Elsewhere: let Chrome use
 * a GPU if it has one and fall back to SwiftShader (CPU WebGL) on GPU-less machines such as CI
 * runners. `softwareGl` (TEST_SOFTWARE_GL=1) forces SwiftShader everywhere.
 */
export function browserArgs(platform = process.platform, softwareGl = false) {
  if (softwareGl) return ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  return platform === 'darwin'
    ? ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist']
    : ['--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];
}

/** TEST_SOFTWARE_GL set to 1/true/yes. */
export function wantsSoftwareGl(env = process.env) {
  return /^(1|true|yes)$/i.test((env.TEST_SOFTWARE_GL ?? '').trim());
}

/** Options for playwright's `chromium.launch()`: headless, the resolved binary (if any) and GPU args. Never a `channel`. */
export function launchOptions(extraArgs = [], probe = systemProbe()) {
  const { executablePath } = resolveTestBrowser(probe);
  const opts = { headless: true, args: [...browserArgs(probe.platform, wantsSoftwareGl(probe.env)), ...extraArgs] };
  if (executablePath) opts.executablePath = executablePath;
  return opts;
}

/** True when WebGL is drawn by the CPU (SwiftShader, llvmpipe, …) or missing — expect a few fps. */
export function isSoftwareRenderer(renderer) {
  return !renderer || /swiftshader|llvmpipe|softpipe|software|basic render|no webgl/i.test(renderer);
}
