/**
 * Boot sequence (main.ts calls `boot()` with the real browser; tests pass fakes):
 *
 *   1. Probe WebGL 2 — before downloading the game code. None → a friendly error card, not a blank page.
 *   2. Pick the quality preset (src/render/quality.ts) and apply its cloud mode to the config before
 *      the atmosphere is built (unless ?clouds= overrides it).
 *   3. Load the game code (a separate chunk) and start it. A failed download (e.g. a redeploy while the
 *      page was open) or a start-up exception → an error card with a Reload button and the details.
 *   4. While it runs: a lost WebGL context shows a banner; if the browser doesn't restore it, a Reload
 *      button.
 */
import { CONFIG } from './config';
import { probeWebGL, type ProbeEnv, type WebGLCapabilities } from './render/capabilities';
import { planQuality, qualityFromQuery, type QualityPlan } from './render/quality';
import type { ErrorContent, Notice } from './ui/veil';

export interface BootDeps {
  doc: Document;
  search: string;
  userAgent: string;
  devicePixelRatio: number;
  viewport: { width: number; height: number };
  probeEnv: ProbeEnv;
  /** Loads the game module (a dynamic import in the browser). */
  loadApp(): Promise<{ startApp(container: HTMLElement, hudRoot: HTMLElement): Promise<unknown> }>;
  showError(content: ErrorContent): void;
  webglErrorContent(problem: 'no-webgl2' | 'webgl1-only' | 'context-failed', userAgent: string): ErrorContent;
  startupErrorContent(error: unknown, userAgent: string): ErrorContent;
  showNotice?(text: string, action?: { label: string; onClick: () => void }): Notice;
  log?(...args: unknown[]): void;
}

export interface BootResult {
  status: 'started' | 'no-webgl' | 'load-failed' | 'start-failed';
  caps: WebGLCapabilities;
  plan: QualityPlan | null;
}

/** How long a lost WebGL context may take to come back before we offer a reload. */
export const CONTEXT_RESTORE_WAIT_MS = 4000;

export async function boot(d: BootDeps): Promise<BootResult> {
  const log = d.log ?? ((...a: unknown[]) => console.error(...a));
  const caps = probeWebGL(d.probeEnv);
  if (!caps.ok) {
    d.showError(d.webglErrorContent(caps.problem ?? 'no-webgl2', d.userAgent));
    return { status: 'no-webgl', caps, plan: null };
  }

  const plan = planQuality(qualityFromQuery(d.search), {
    devicePixelRatio: d.devicePixelRatio,
    cssWidth: d.viewport.width,
    cssHeight: d.viewport.height,
    renderer: caps.renderer,
  });
  let hasClouds = false;
  try {
    hasClouds = new URLSearchParams(d.search).has('clouds');
  } catch {
    hasClouds = false;
  }
  if (plan.cloudMode && !hasClouds) CONFIG.render.cloudMode = plan.cloudMode;

  const container = d.doc.getElementById('app');
  const hudRoot = d.doc.getElementById('hud');
  if (container && d.showNotice) watchContextLoss(container, d.showNotice);

  let app: Awaited<ReturnType<BootDeps['loadApp']>>;
  try {
    app = await d.loadApp();
  } catch (e) {
    log("Tater's Flight Sim: the game code failed to load", e);
    d.showError(d.startupErrorContent(e, d.userAgent));
    return { status: 'load-failed', caps, plan };
  }
  try {
    if (!container || !hudRoot) throw new Error('index.html is missing #app or #hud');
    await app.startApp(container, hudRoot);
  } catch (e) {
    log("Tater's Flight Sim failed to start", e);
    d.showError(d.startupErrorContent(e, d.userAgent));
    return { status: 'start-failed', caps, plan };
  }
  return { status: 'started', caps, plan };
}

/**
 * A lost WebGL context (GPU reset, driver update, too many contexts): three.js restores it when the
 * browser allows; tell the player meanwhile, and offer a reload if it doesn't come back.
 * The context events don't bubble, so listen in the capture phase on the container.
 */
export function watchContextLoss(container: HTMLElement, show: NonNullable<BootDeps['showNotice']>, waitMs = CONTEXT_RESTORE_WAIT_MS): () => void {
  let notice: Notice | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const onLost = () => {
    notice?.remove();
    notice = show('The graphics were reset by the browser — restoring…');
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      notice?.remove();
      notice = show('The graphics could not be restored.', { label: 'Reload', onClick: () => location.reload() });
    }, waitMs);
  };
  const onRestored = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    notice?.remove();
    notice = null;
  };
  container.addEventListener('webglcontextlost', onLost, true);
  container.addEventListener('webglcontextrestored', onRestored, true);
  return () => {
    container.removeEventListener('webglcontextlost', onLost, true);
    container.removeEventListener('webglcontextrestored', onRestored, true);
    onRestored();
  };
}
