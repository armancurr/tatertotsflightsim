/**
 * Entry point. Checks that the browser can run the simulator (WebGL 2) before loading the game code,
 * picks the quality preset, then loads and starts the full simulator (src/game/app.ts wires physics,
 * world, atmosphere, aircraft, cameras, HUD, audio and effects together). Anything that goes wrong
 * ends on a friendly error card instead of a blank page (src/boot.ts, src/ui/veil.ts).
 */
import { boot } from './boot';
import { browserProbeEnv } from './render/capabilities';
import { showErrorScreen, showNotice, startupErrorContent, webglErrorContent } from './ui/veil';

void boot({
  doc: document,
  search: location.search,
  userAgent: navigator.userAgent,
  devicePixelRatio: window.devicePixelRatio || 1,
  viewport: { width: window.innerWidth, height: window.innerHeight },
  probeEnv: browserProbeEnv(document),
  // A separate chunk: a browser without WebGL 2 never downloads the game.
  loadApp: () => import('./game/app'),
  showError: (c) => showErrorScreen(document, c),
  webglErrorContent,
  startupErrorContent,
  showNotice: (text, action) => showNotice(document, text, action),
});
