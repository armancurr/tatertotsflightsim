/**
 * "Tater", the mascot of Tater's Flight Sim: a flying potato in brown-leather aviator goggles and a
 * red cape, streaking up and to the right. Drawn procedurally — an inline SVG for the DOM (top bar,
 * loading veil, menu) and the same shapes on a 2D canvas (`drawMascot`, e.g. for a livery decal).
 * Everything lives in a 64×64 design box; nothing is loaded from the network.
 *
 * Palette (shared with the Cessna's tail art): potato #f0c26a → #c98a3c → #8f5a24, cape
 * #e8392f → #a3161a, strap #5a381c, lens #aee8ff → #2d6f9c, chrome rims #e6eaef.
 */

export const MASCOT_COLORS = {
  potatoLight: '#f6d07c',
  potato: '#d59a48',
  potatoDark: '#8f5a24',
  spot: '#a86d2c',
  cape: '#e8392f',
  capeDark: '#a3161a',
  strap: '#5a381c',
  lensLight: '#b8ecff',
  lensDark: '#2d6f9c',
  rim: '#e6eaef',
  mouth: '#5b3417',
} as const;

const C = MASCOT_COLORS;

/** The cape, flowing back from the potato's shoulders (design-box path). */
const CAPE = 'M26 21C19 17.5 10 17.5 2.5 21C5.5 23 6 25.5 4 28C8 28 9.5 30.5 8 33.5C12 33 14.5 35 14 38.5C18 36 22.5 35.5 27 37Z';
/** Inner fold of the cape (shadow). */
const CAPE_FOLD = 'M26 24C20.5 22.5 14.5 23 9.5 25.5C13 26.5 15 28.5 15.5 31.5C19 30.5 23 31 26.5 32.5Z';
/** The whole figure leans into a climb. */
const TILT_DEG = -10;
/** The potato: a lumpy oval tilted nose-up. */
const POTATO = 'M17.5 34.5C16 26 22.5 18 33 16.5C43.5 15 55 18.5 58.5 26C61.5 32.5 57 41 47.5 44.5C38 48 26.5 47.5 21 42.5C19 40.8 17.9 37.8 17.5 34.5Z';
/** Goggle strap across the "forehead". */
const STRAP = 'M20.5 29C27 25.5 37 23.2 47 22.8C51.5 22.6 55.5 23 58.3 24';
const MOUTH = 'M41.5 36.5C44 39.3 48.3 39.6 51.4 36.8';
const SPEED = 'M2 40H11M5 45H14M8 35H13';

let uid = 0;

/**
 * Self-contained inline SVG of the mascot (the 64-unit design box, cropped to viewBox 0 8 64 48). `title` sets the accessible label;
 * gradient ids are unique per call so several copies can share a page.
 */
export function mascotSvg(opts: { title?: string; className?: string } = {}): string {
  const p = `tfm${++uid}`;
  const title = opts.title ?? 'Tater, the flying potato';
  const cls = opts.className ? ` class="${opts.className}"` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 8 64 48"${cls} role="img" aria-label="${title}">` +
    `<defs>` +
    `<radialGradient id="${p}b" cx="0.42" cy="0.3" r="0.75"><stop offset="0" stop-color="${C.potatoLight}"/><stop offset="0.55" stop-color="${C.potato}"/><stop offset="1" stop-color="${C.potatoDark}"/></radialGradient>` +
    `<linearGradient id="${p}c" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.cape}"/><stop offset="1" stop-color="${C.capeDark}"/></linearGradient>` +
    `<radialGradient id="${p}l" cx="0.35" cy="0.3" r="0.8"><stop offset="0" stop-color="${C.lensLight}"/><stop offset="1" stop-color="${C.lensDark}"/></radialGradient>` +
    `</defs>` +
    `<g transform="rotate(${TILT_DEG} 32 32)">` +
    `<path d="${SPEED}" stroke="#ffffff" stroke-opacity="0.55" stroke-width="1.6" stroke-linecap="round" fill="none"/>` +
    `<path d="${CAPE}" fill="url(#${p}c)"/>` +
    `<path d="${CAPE_FOLD}" fill="${C.capeDark}" fill-opacity="0.55"/>` +
    `<path d="${POTATO}" fill="url(#${p}b)" stroke="${C.potatoDark}" stroke-width="0.8"/>` +
    `<ellipse cx="27" cy="38" rx="1.6" ry="1.1" fill="${C.spot}" opacity="0.7"/>` +
    `<ellipse cx="33.5" cy="42" rx="1.1" ry="0.8" fill="${C.spot}" opacity="0.6"/>` +
    `<ellipse cx="24" cy="31.5" rx="1" ry="0.7" fill="${C.spot}" opacity="0.55"/>` +
    `<ellipse cx="55" cy="35" rx="1" ry="0.75" fill="${C.spot}" opacity="0.5"/>` +
    `<path d="${STRAP}" stroke="${C.strap}" stroke-width="3.4" stroke-linecap="round" fill="none"/>` +
    `<circle cx="41" cy="27.5" r="5.3" fill="url(#${p}l)" stroke="${C.rim}" stroke-width="1.7"/>` +
    `<circle cx="51.8" cy="27.2" r="4.9" fill="url(#${p}l)" stroke="${C.rim}" stroke-width="1.7"/>` +
    `<path d="M46.3 27.4H46.6" stroke="${C.rim}" stroke-width="2.2" stroke-linecap="round"/>` +
    `<ellipse cx="39.4" cy="25.8" rx="1.6" ry="1" fill="#ffffff" opacity="0.85"/>` +
    `<ellipse cx="50.3" cy="25.6" rx="1.4" ry="0.9" fill="#ffffff" opacity="0.85"/>` +
    `<path d="${MOUTH}" stroke="${C.mouth}" stroke-width="1.5" stroke-linecap="round" fill="none"/>` +
    `</g></svg>`
  );
}

/**
 * The mascot on a 2D canvas, centred at (x, y), `size` px across (the 64-unit design box).
 * Uses Path2D from the same path data when the platform has it, else simple shapes.
 */
export function drawMascot(ctx: CanvasRenderingContext2D, x: number, y: number, size: number): void {
  if (!(Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(size) && size > 0)) return;
  if (Math.abs(x) > 1e7 || Math.abs(y) > 1e7 || size > 1e5) return;
  const k = size / 64;
  ctx.save();
  ctx.translate(x - size / 2, y - size / 2);
  ctx.scale(k, k);
  ctx.translate(32, 32);
  ctx.rotate((TILT_DEG * Math.PI) / 180);
  ctx.translate(-32, -32);
  const P2D = (globalThis as { Path2D?: new (d: string) => Path2D }).Path2D;
  const shape = (d: string, fallback: () => void) => {
    if (P2D) return new P2D(d);
    ctx.beginPath();
    fallback();
    return undefined;
  };
  const fillPath = (d: string, style: string | CanvasGradient, fallback: () => void) => {
    const p = shape(d, fallback);
    ctx.fillStyle = style;
    if (p) ctx.fill(p);
    else ctx.fill();
  };
  const strokePath = (d: string, style: string, width: number, fallback: () => void) => {
    const p = shape(d, fallback);
    ctx.strokeStyle = style;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    if (p) ctx.stroke(p);
    else ctx.stroke();
  };
  // Cape.
  const cape = ctx.createLinearGradient(30, 20, 5, 35);
  cape.addColorStop(0, C.cape);
  cape.addColorStop(1, C.capeDark);
  fillPath(CAPE, cape, () => {
    ctx.moveTo(26, 21);
    ctx.bezierCurveTo(19, 17.5, 10, 17.5, 2.5, 21);
    ctx.bezierCurveTo(5.5, 23, 6, 25.5, 4, 28);
    ctx.bezierCurveTo(8, 28, 9.5, 30.5, 8, 33.5);
    ctx.bezierCurveTo(12, 33, 14.5, 35, 14, 38.5);
    ctx.bezierCurveTo(18, 36, 22.5, 35.5, 27, 37);
    ctx.closePath();
  });
  // Potato.
  const body = ctx.createRadialGradient(34, 24, 2, 38, 31, 26);
  body.addColorStop(0, C.potatoLight);
  body.addColorStop(0.55, C.potato);
  body.addColorStop(1, C.potatoDark);
  fillPath(POTATO, body, () => ctx.ellipse(38, 31.5, 21, 14.5, -0.12, 0, Math.PI * 2));
  ctx.fillStyle = C.spot;
  for (const [sx, sy, rx, ry] of [[27, 38, 1.6, 1.1], [33.5, 42, 1.1, 0.8], [24, 31.5, 1, 0.7], [55, 35, 1, 0.75]]) {
    ctx.beginPath();
    ctx.ellipse(sx, sy, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  // Goggles.
  strokePath(STRAP, C.strap, 3.4, () => {
    ctx.moveTo(20.5, 29);
    ctx.bezierCurveTo(27, 25.5, 37, 23.2, 47, 22.8);
    ctx.bezierCurveTo(51.5, 22.6, 55.5, 23, 58.3, 24);
  });
  for (const [lx, ly, lr] of [[41, 27.5, 5.3], [51.8, 27.2, 4.9]]) {
    const lens = ctx.createRadialGradient(lx - 1.8, ly - 1.6, 0.5, lx, ly, lr);
    lens.addColorStop(0, C.lensLight);
    lens.addColorStop(1, C.lensDark);
    ctx.beginPath();
    ctx.arc(lx, ly, lr, 0, Math.PI * 2);
    ctx.fillStyle = lens;
    ctx.fill();
    ctx.strokeStyle = C.rim;
    ctx.lineWidth = 1.7;
    ctx.stroke();
  }
  // Smile.
  strokePath(MOUTH, C.mouth, 1.5, () => {
    ctx.moveTo(41.5, 36.5);
    ctx.bezierCurveTo(44, 39.3, 48.3, 39.6, 51.4, 36.8);
  });
  ctx.restore();
}
