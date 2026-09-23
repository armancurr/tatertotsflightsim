// @vitest-environment happy-dom
/**
 * Boot sequence (src/boot.ts) and the WebGL probe (src/render/capabilities.ts), with fake canvases
 * and a fake game module: no WebGL 2 → an error card and the game is never downloaded; a failed
 * download or a start-up exception → an error card; software GL → billboard clouds; a lost WebGL
 * context → a banner, then a Reload offer if it isn't restored.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIG } from '../../src/config';
import { boot, watchContextLoss, type BootDeps } from '../../src/boot';
import { probeWebGL, type ProbeEnv } from '../../src/render/capabilities';
import { startupErrorContent, webglErrorContent, type ErrorContent } from '../../src/ui/veil';

function fakeGl(renderer: string, exts: string[] = ['EXT_color_buffer_float', 'WEBGL_debug_renderer_info', 'WEBGL_lose_context']) {
  let lost = 0;
  return {
    RENDERER: 0x1f01,
    getExtension: (n: string) => {
      if (!exts.includes(n)) return null;
      if (n === 'WEBGL_debug_renderer_info') return { UNMASKED_RENDERER_WEBGL: 0x9246 };
      if (n === 'WEBGL_lose_context') return { loseContext: () => lost++ };
      return {};
    },
    getParameter: (p: number) => (p === 0x9246 ? renderer : 'WebKit WebGL'),
    get lost() {
      return lost;
    },
  };
}

function env(kind: 'webgl2' | 'webgl1' | 'none' | 'blocked', renderer = 'ANGLE Metal Renderer: Apple M2 Max'): ProbeEnv {
  const gl = fakeGl(renderer);
  return {
    createCanvas: () => ({
      getContext: (k: string) => {
        if (k === 'webgl2') return kind === 'webgl2' ? gl : null;
        if (k === 'webgl') return kind === 'webgl1' ? {} : null;
        return null;
      },
    }),
    hasWebGL2Api: kind === 'webgl2' || kind === 'blocked',
    hasWorker: true,
    hasOffscreenCanvas: true,
  };
}

describe('WebGL probe', () => {
  it('reports the renderer and the extensions the pipeline needs, and releases its context', () => {
    const e = env('webgl2');
    const c = probeWebGL(e);
    expect(c.ok).toBe(true);
    expect(c.renderer).toMatch(/M2 Max/);
    expect(c.floatColorBuffer).toBe(true);
    expect(c.clipControl).toBe(false);
  });
  it('tells "no WebGL 2", "WebGL 1 only" and "context failed" apart', () => {
    expect(probeWebGL(env('none')).problem).toBe('no-webgl2');
    expect(probeWebGL(env('webgl1')).problem).toBe('webgl1-only');
    expect(probeWebGL(env('blocked')).problem).toBe('context-failed');
  });
  it('a canvas that throws counts as no context', () => {
    const c = probeWebGL({ createCanvas: () => ({ getContext: () => { throw new Error('nope'); } }), hasWebGL2Api: true, hasWorker: false, hasOffscreenCanvas: false });
    expect(c.ok).toBe(false);
    expect(c.problem).toBe('context-failed');
  });
});

describe('boot', () => {
  const cloud0 = CONFIG.render.cloudMode;
  let shown: ErrorContent[];
  beforeEach(() => {
    shown = [];
    document.body.innerHTML = '<div id="app"></div><div id="hud"></div>';
  });
  afterEach(() => {
    CONFIG.render.cloudMode = cloud0;
    document.body.innerHTML = '';
  });

  const deps = (over: Partial<BootDeps> = {}): BootDeps => ({
    doc: document,
    search: '',
    userAgent: 'Mozilla/5.0 Chrome/140.0.0.0 Safari/537.36',
    devicePixelRatio: 2,
    viewport: { width: 1440, height: 900 },
    probeEnv: env('webgl2'),
    loadApp: async () => ({ startApp: async () => ({}) }),
    showError: (c) => shown.push(c),
    webglErrorContent,
    startupErrorContent,
    log: () => {},
    ...over,
  });

  it('starts the game with the #app and #hud elements on a WebGL 2 browser', async () => {
    const startApp = vi.fn(async () => ({}));
    const r = await boot(deps({ loadApp: async () => ({ startApp }) }));
    expect(r.status).toBe('started');
    expect(startApp).toHaveBeenCalledWith(document.getElementById('app'), document.getElementById('hud'));
    expect(shown).toHaveLength(0);
    expect(r.plan?.level).toBe('auto');
  });

  it('no WebGL 2: shows the friendly card and never downloads the game', async () => {
    const loadApp = vi.fn(async () => ({ startApp: async () => ({}) }));
    const r = await boot(deps({ probeEnv: env('none'), loadApp }));
    expect(r.status).toBe('no-webgl');
    expect(loadApp).not.toHaveBeenCalled();
    expect(shown[0].message).toMatch(/WebGL 2/);
  });

  it('a failed download of the game code → a reload card', async () => {
    const r = await boot(deps({ loadApp: () => Promise.reject(new TypeError('Failed to fetch dynamically imported module: /assets/app.js')) }));
    expect(r.status).toBe('load-failed');
    expect(shown[0].reload).toBe(true);
    expect(shown[0].title).toMatch(/loading/);
  });

  it('an exception while starting → a card with the details', async () => {
    const r = await boot(deps({ loadApp: async () => ({ startApp: () => Promise.reject(new Error('terrain exploded')) }) }));
    expect(r.status).toBe('start-failed');
    expect(shown[0].details).toContain('terrain exploded');
  });

  it('a software renderer gets billboard clouds — unless ?clouds= says otherwise', async () => {
    const swift = env('webgl2', 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)');
    await boot(deps({ probeEnv: swift }));
    expect(CONFIG.render.cloudMode).toBe('billboard');
    CONFIG.render.cloudMode = cloud0;
    await boot(deps({ probeEnv: swift, search: '?clouds=volumetric' }));
    expect(CONFIG.render.cloudMode).toBe(cloud0);
  });
});

describe('WebGL context loss', () => {
  it('shows a banner, removes it when the context comes back, and offers a reload when it does not', () => {
    vi.useFakeTimers();
    try {
      const el = document.createElement('div');
      const canvas = document.createElement('canvas');
      el.appendChild(canvas);
      document.body.appendChild(el);
      const notices: { text: string; action?: string; removed: boolean }[] = [];
      const show = (text: string, action?: { label: string }) => {
        const n = { text, action: action?.label, removed: false };
        notices.push(n);
        return { element: el, setText: () => {}, remove: () => { n.removed = true; } };
      };
      const stop = watchContextLoss(el, show, 1000);
      canvas.dispatchEvent(new Event('webglcontextlost'));
      expect(notices[0].text).toMatch(/restoring/);
      canvas.dispatchEvent(new Event('webglcontextrestored'));
      expect(notices[0].removed).toBe(true);
      vi.advanceTimersByTime(2000);
      expect(notices).toHaveLength(1);
      canvas.dispatchEvent(new Event('webglcontextlost'));
      vi.advanceTimersByTime(1500);
      expect(notices.at(-1)!.action).toBe('Reload');
      stop();
      canvas.dispatchEvent(new Event('webglcontextlost'));
      expect(notices).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
