/**
 * Which browser the automated tests (tests/support/e2e.ts) and scripts/shot.mjs launch.
 *
 * Resolution order: TEST_BROWSER → (macOS only) the newest "Google Chrome for Testing" in the
 * Playwright cache → Playwright's own bundled Chromium (no executablePath, no channel). Never the
 * user's installed Google Chrome. Unit tests pin each rung; the fuzz tests throw random
 * environments (env vars × platform × cache contents) at the resolver.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  browserArgs, isSoftwareRenderer, launchOptions, resolveTestBrowser, wantsSoftwareGl, type BrowserProbe,
} from '../../scripts/test-browser.mjs';
import { ROOT, e2eTimeScale, setE2ETimeScale, testBrowserPath } from '../support/e2e';
import { fcParams } from '../support/fc';

const MAC_HOME = '/Users/pilot';
const MAC_CACHE = `${MAC_HOME}/Library/Caches/ms-playwright`;
const CFT_ARM = 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const CFT_X64 = 'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const OLD_CHROMIUM = 'chrome-mac/Chromium.app/Contents/MacOS/Chromium';
const USER_CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** A fake filesystem: a set of existing file paths; directory listings derived from it. */
function probe(opts: { env?: Record<string, string | undefined>; platform?: string; home?: string; files?: string[] }): BrowserProbe {
  const files = new Set(opts.files ?? []);
  return {
    env: opts.env ?? {},
    platform: opts.platform ?? 'darwin',
    home: opts.home ?? MAC_HOME,
    exists: (p: string) => files.has(p) || [...files].some((f) => f.startsWith(`${p}/`)),
    list: (dir: string) => [...new Set([...files].filter((f) => f.startsWith(`${dir}/`)).map((f) => f.slice(dir.length + 1).split('/')[0]))],
  };
}

describe('resolveTestBrowser — resolution order', () => {
  it('1. TEST_BROWSER wins on every platform, even with a Chrome for Testing in the cache', () => {
    for (const platform of ['darwin', 'linux', 'win32']) {
      const r = resolveTestBrowser(probe({ platform, env: { TEST_BROWSER: '/opt/chromium/chrome' }, files: [`${MAC_CACHE}/chromium-1243/${CFT_ARM}`] }));
      expect(r).toMatchObject({ executablePath: '/opt/chromium/chrome', source: 'TEST_BROWSER' });
    }
  });

  it('2. macOS: the newest chromium-<rev> Chrome for Testing in ~/Library/Caches/ms-playwright', () => {
    const r = resolveTestBrowser(probe({
      files: [`${MAC_CACHE}/chromium-1208/${CFT_ARM}`, `${MAC_CACHE}/chromium-1234/${CFT_ARM}`, `${MAC_CACHE}/chromium-999/${CFT_ARM}`, `${MAC_CACHE}/chromium_headless_shell-2000/x`],
    }));
    expect(r).toMatchObject({ executablePath: `${MAC_CACHE}/chromium-1234/${CFT_ARM}`, source: 'chrome-for-testing' });
  });

  it('2. macOS: Intel (chrome-mac-x64) and old Chromium.app layouts are found too', () => {
    expect(resolveTestBrowser(probe({ files: [`${MAC_CACHE}/chromium-1243/${CFT_X64}`] })).executablePath).toBe(`${MAC_CACHE}/chromium-1243/${CFT_X64}`);
    expect(resolveTestBrowser(probe({ files: [`${MAC_CACHE}/chromium-1100/${OLD_CHROMIUM}`] })).executablePath).toBe(`${MAC_CACHE}/chromium-1100/${OLD_CHROMIUM}`);
  });

  it('2. macOS: PLAYWRIGHT_BROWSERS_PATH moves the cache', () => {
    const r = resolveTestBrowser(probe({ env: { PLAYWRIGHT_BROWSERS_PATH: '/srv/pw' }, files: [`/srv/pw/chromium-1243/${CFT_ARM}`, `${MAC_CACHE}/chromium-1234/${CFT_ARM}`] }));
    expect(r.executablePath).toBe(`/srv/pw/chromium-1243/${CFT_ARM}`);
  });

  it('3. macOS with an empty cache → Playwright\'s bundled Chromium (no executablePath)', () => {
    expect(resolveTestBrowser(probe({}))).toEqual({ executablePath: undefined, source: 'playwright' });
    // A revision folder without a browser inside (interrupted download) is ignored.
    expect(resolveTestBrowser(probe({ files: [`${MAC_CACHE}/chromium-1243/INSTALLATION_COMPLETE`] })).source).toBe('playwright');
  });

  it('3. Linux and Windows always use Playwright\'s bundled Chromium (the macOS cache scan is macOS-only)', () => {
    for (const platform of ['linux', 'win32']) {
      const home = '/home/<user>';
      const r = resolveTestBrowser(probe({ platform, home, files: [`${home}/Library/Caches/ms-playwright/chromium-1243/${CFT_ARM}`] }));
      expect(r).toEqual({ executablePath: undefined, source: 'playwright' });
    }
  });

  it('an empty or blank TEST_BROWSER counts as unset', () => {
    expect(resolveTestBrowser(probe({ platform: 'linux', env: { TEST_BROWSER: '   ' } })).source).toBe('playwright');
    expect(resolveTestBrowser(probe({ platform: 'linux', env: { TEST_BROWSER: '' } })).source).toBe('playwright');
  });

  it('refuses TEST_BROWSER pointing at the everyday Google Chrome (an automation instance hijacks it)', () => {
    expect(() => resolveTestBrowser(probe({ env: { TEST_BROWSER: USER_CHROME } }))).toThrow(/Google Chrome/);
    expect(() => resolveTestBrowser(probe({ platform: 'win32', env: { TEST_BROWSER: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' } }))).toThrow(/Google Chrome/);
    expect(() => resolveTestBrowser(probe({ platform: 'linux', env: { TEST_BROWSER: '/opt/google/chrome/chrome' } }))).toThrow(/Google Chrome/);
    // Chrome for Testing itself is fine.
    expect(resolveTestBrowser(probe({ env: { TEST_BROWSER: `${MAC_CACHE}/chromium-1243/${CFT_ARM}` } })).source).toBe('TEST_BROWSER');
  });
});

describe('browserArgs / launchOptions', () => {
  it('Metal ANGLE only on macOS; elsewhere GPU if present, SwiftShader otherwise', () => {
    expect(browserArgs('darwin')).toContain('--use-angle=metal');
    for (const p of ['linux', 'win32', 'freebsd']) {
      expect(browserArgs(p).some((a) => a.includes('metal'))).toBe(false);
      expect(browserArgs(p)).toContain('--enable-unsafe-swiftshader');
    }
  });

  it('TEST_SOFTWARE_GL=1 forces SwiftShader on every platform (reproduces a GPU-less CI runner)', () => {
    for (const v of ['1', 'true', 'YES', ' 1 ']) expect(wantsSoftwareGl({ TEST_SOFTWARE_GL: v }), v).toBe(true);
    for (const v of [undefined, '', '0', 'false', 'no']) expect(wantsSoftwareGl({ TEST_SOFTWARE_GL: v }), String(v)).toBe(false);
    for (const platform of ['darwin', 'linux', 'win32']) {
      const o = launchOptions([], probe({ platform, env: { TEST_SOFTWARE_GL: '1' } }));
      expect(o.args).toContain('--use-angle=swiftshader');
      expect(o.args.some((a) => a.includes('metal'))).toBe(false);
    }
  });

  it('launch options are headless, never use a channel, and add extra args after the defaults', () => {
    const o = launchOptions(['--enable-unsafe-webgpu'], probe({ platform: 'linux' }));
    expect(o.headless).toBe(true);
    expect('channel' in o).toBe(false);
    expect('executablePath' in o).toBe(false);
    expect(o.args.at(-1)).toBe('--enable-unsafe-webgpu');
    const mac = launchOptions([], probe({ files: [`${MAC_CACHE}/chromium-1243/${CFT_ARM}`] }));
    expect(mac.executablePath).toBe(`${MAC_CACHE}/chromium-1243/${CFT_ARM}`);
  });
});

describe('isSoftwareRenderer', () => {
  it('flags CPU rasterisers and passes real GPUs', () => {
    for (const s of [
      'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
      'Google SwiftShader', 'llvmpipe (LLVM 15.0.7, 256 bits)', 'Mesa softpipe', 'Microsoft Basic Render Driver', 'no webgl2', '',
    ]) expect(isSoftwareRenderer(s), s).toBe(true);
    for (const s of ['ANGLE Metal Renderer: Apple M2 Max', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Mesa Intel(R) UHD Graphics 620 (KBL GT2)', 'AMD Radeon Pro 5500M OpenGL Engine']) {
      expect(isSoftwareRenderer(s), s).toBe(false);
    }
  });
});

describe('resolveTestBrowser — fuzz over environments', () => {
  const platformArb = fc.constantFrom('darwin', 'linux', 'win32', 'freebsd');
  const layoutArb = fc.constantFrom(CFT_ARM, CFT_X64, OLD_CHROMIUM, 'INSTALLATION_COMPLETE', 'chrome-linux/chrome');
  const cacheArb = fc.array(fc.record({ kind: fc.constantFrom('chromium', 'chromium_headless_shell', 'firefox', 'webkit'), rev: fc.integer({ min: 1, max: 99_999 }), layout: layoutArb }), { maxLength: 8 });
  const envValue = fc.option(fc.oneof(fc.constant(''), fc.constant('  '), fc.constantFrom('/opt/chromium/chrome', 'C:\\chromium\\chrome.exe', '/x/Chromium.app/Contents/MacOS/Chromium')), { nil: undefined });
  const envArb = fc.record({
    TEST_BROWSER: envValue,
    PLAYWRIGHT_BROWSERS_PATH: fc.option(fc.constantFrom('/srv/pw', '0'), { nil: undefined }),
    CI: fc.option(fc.constantFrom('true', '1'), { nil: undefined }),
    TEST_SOFTWARE_GL: fc.option(fc.constantFrom('1', '0', 'true', ''), { nil: undefined }),
  });

  /** The expected answer, computed independently of the implementation. */
  function oracle(env: Record<string, string | undefined>, platform: string, cacheRoot: string, cache: { kind: string; rev: number; layout: string }[]) {
    const tb = env.TEST_BROWSER?.trim();
    if (tb) return { executablePath: tb, source: 'TEST_BROWSER' };
    if (platform === 'darwin') {
      const found = cache
        .filter((c) => c.kind === 'chromium' && [CFT_ARM, CFT_X64, OLD_CHROMIUM].includes(c.layout))
        .sort((a, b) => b.rev - a.rev || [CFT_ARM, CFT_X64, OLD_CHROMIUM].indexOf(a.layout) - [CFT_ARM, CFT_X64, OLD_CHROMIUM].indexOf(b.layout))[0];
      if (found) return { executablePath: `${cacheRoot}/chromium-${found.rev}/${found.layout}`, source: 'chrome-for-testing' };
    }
    return { executablePath: undefined, source: 'playwright' };
  }

  it('matches the oracle for every combination of env vars, platform and cache contents', () => {
    fc.assert(fc.property(envArb, platformArb, cacheArb, (env, platform, cache) => {
      const pbp = env.PLAYWRIGHT_BROWSERS_PATH;
      const cacheRoot = pbp && pbp !== '0' ? pbp : `${MAC_HOME}/Library/Caches/ms-playwright`;
      const files = cache.map((c) => `${cacheRoot}/${c.kind}-${c.rev}/${c.layout}`);
      const r = resolveTestBrowser(probe({ env, platform, files }));
      expect(r).toEqual(oracle(env, platform, cacheRoot, cache));
    }), fcParams(400));
  });

  it('never resolves to the user\'s Google Chrome and never asks for a channel', () => {
    fc.assert(fc.property(envArb, platformArb, cacheArb, (env, platform, cache) => {
      const files = cache.map((c) => `${MAC_CACHE}/${c.kind}-${c.rev}/${c.layout}`);
      const o = launchOptions([], probe({ env, platform, files }));
      expect('channel' in o).toBe(false);
      expect(o.executablePath ?? '').not.toMatch(/\/Google Chrome\.app\//);
      const software = ['1', 'true'].includes(env.TEST_SOFTWARE_GL ?? '');
      expect(o.args.includes('--use-angle=metal')).toBe(platform === 'darwin' && !software);
      expect(o.args.includes('--use-angle=swiftshader')).toBe(software);
    }), fcParams(300));
  });
});

describe('e2e time scale (stretches waitForSim on slow renderers)', () => {
  it('is at least 1 and ignores junk', () => {
    const before = e2eTimeScale();
    try {
      expect(before).toBeGreaterThanOrEqual(1);
      setE2ETimeScale(60);
      expect(e2eTimeScale()).toBe(60);
      fc.assert(fc.property(fc.oneof(fc.double(), fc.constant(Number.NaN), fc.constant(-Infinity)), (x) => {
        setE2ETimeScale(x);
        const t = e2eTimeScale();
        expect(Number.isFinite(t)).toBe(true);
        expect(t).toBeGreaterThanOrEqual(1);
        if (Number.isFinite(x) && x >= 1) expect(t).toBe(x);
      }), fcParams(200));
    } finally {
      setE2ETimeScale(before);
    }
  });
});

describe('wiring', () => {
  it('tests/support/e2e.ts testBrowserPath() is the shared resolver applied to this machine', () => {
    const r = resolveTestBrowser();
    expect(testBrowserPath()).toBe(r.executablePath);
  });

  it('scripts/shot.mjs uses the shared resolver (no private copy, no channel, no hard-coded Chrome)', () => {
    const src = readFileSync(join(ROOT, 'scripts/shot.mjs'), 'utf8');
    expect(src).toMatch(/from '\.\/test-browser\.mjs'/);
    expect(src).not.toMatch(/function testBrowserPath/);
    expect(src).not.toMatch(/channel\s*:/);
    expect(src).not.toMatch(/Library\/Caches\/ms-playwright/);
  });

  it('tests/support/e2e.ts uses the shared resolver and never asks for a channel', () => {
    const src = readFileSync(join(ROOT, 'tests/support/e2e.ts'), 'utf8');
    expect(src).toMatch(/scripts\/test-browser\.mjs'/);
    expect(src).not.toMatch(/channel\s*:/);
    expect(src).not.toMatch(/'--use-angle=metal'/);
  });
});
