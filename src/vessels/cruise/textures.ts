/**
 * MS Tater Star canvas textures, painted in code (browser only; null in node):
 *
 *  - the window atlas: one row per style (balcony cabins, cabin windows, lounge glazing, plain
 *    wall, the set-in promenade), each row one deck high and WINDOW_TILE_M of wall wide, repeating
 *    along the wall (u) — the superstructure's walls pick their row by v (no per-window geometry);
 *  - its night twin: the same panes lit warm (not every cabin — some are dark) on black, the
 *    walls' emissive map, faded in by the model after sunset;
 *  - the name on the bow ("TATER STAR" — the config's registration).
 */
import * as THREE from 'three';
import { WINDOW_ROWS, WINDOW_ROW_COUNT } from './shape';

export const ATLAS = { width: 1024, rowPx: 128 } as const;
export const NAME_TEX = { width: 1024, height: 128 } as const;

export interface CruiseTextures {
  windows: THREE.Texture;
  windowsLit: THREE.Texture;
  name: THREE.Texture;
}

/** Tiny deterministic hash → [0, 1). */
function hash(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** The v range (bottom, top) of an atlas row, inset by a couple of texels so mipmaps don't bleed. */
export function atlasRowV(row: number): [number, number] {
  const n = WINDOW_ROW_COUNT;
  const pad = 2 / (ATLAS.rowPx * n);
  return [1 - (row + 1) / n + pad, 1 - row / n - pad];
}

const WALL = '#eeeeea';
const WALL_SHADE = 'rgba(0,0,0,0.10)';

type Pane = (x: number, y: number, w: number, h: number, key: number) => void;

/** Glass with a sky reflection toward the top. */
function glass(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const g = c.createLinearGradient(0, y, 0, y + h);
  g.addColorStop(0, '#4d5f6c');
  g.addColorStop(0.35, '#2a3945');
  g.addColorStop(1, '#172128');
  c.fillStyle = g;
  c.fillRect(x, y, w, h);
}

/** Paint one row (one deck, floor at the bottom of the rect) in day colours, calling `pane` for every window. */
function paintRow(c: CanvasRenderingContext2D, row: number, y0: number, W: number, H: number, pane: Pane) {
  c.fillStyle = WALL;
  c.fillRect(0, y0, W, H);
  // the deck above's overhang shadow and the deck line
  const sh = c.createLinearGradient(0, y0, 0, y0 + H * 0.16);
  sh.addColorStop(0, 'rgba(0,0,0,0.22)');
  sh.addColorStop(1, 'rgba(0,0,0,0)');
  c.fillStyle = sh;
  c.fillRect(0, y0, W, H * 0.16);
  c.fillStyle = WALL_SHADE;
  c.fillRect(0, y0 + H - 3, W, 3);
  const px = W / 12.8; // px per metre along the wall
  const yy = (f: number) => y0 + H * f;
  if (row === WINDOW_ROWS.balcony) {
    const cab = 3.2 * px;
    for (let k = 0; k < W / cab; k++) {
      const x = k * cab;
      pane(x + 12, yy(0.12), cab - 24, H * 0.86, k);
      // balcony front: a glass panel and a white rail over the door's lower part
      c.fillStyle = 'rgba(190,205,212,0.55)';
      c.fillRect(x + 12, yy(0.6), cab - 24, H * 0.38);
      c.fillStyle = '#f7f7f4';
      c.fillRect(x + 12, yy(0.58), cab - 24, H * 0.035);
      // dividers
      c.fillStyle = '#e4e4df';
      c.fillRect(x, yy(0.08), 12, H * 0.92);
      c.fillRect(x + cab - 12, yy(0.08), 12, H * 0.92);
    }
  } else if (row === WINDOW_ROWS.cabin) {
    const cab = 3.2 * px;
    for (let k = 0; k < W / cab; k++) {
      const x = k * cab;
      pane(x + cab * 0.14, yy(0.3), cab * 0.72, H * 0.4, k);
    }
  } else if (row === WINDOW_ROWS.lounge) {
    const bay = 1.6 * px;
    for (let k = 0; k < W / bay; k++) pane(k * bay + 5, yy(0.14), bay - 10, H * 0.74, Math.floor(k / 3));
  } else if (row === WINDOW_ROWS.plain) {
    const bay = 6.4 * px;
    for (let k = 0; k < W / bay; k++) {
      pane(k * bay + bay * 0.2, yy(0.35), bay * 0.12, H * 0.3, k);
      pane(k * bay + bay * 0.62, yy(0.35), bay * 0.12, H * 0.3, k + 50);
    }
  } else if (row === WINDOW_ROWS.promenade) {
    const bay = 3.2 * px;
    for (let k = 0; k < W / bay; k++) {
      pane(k * bay + 14, yy(0.16), bay - 28, H * 0.62, k);
      c.fillStyle = '#dcdcd6';
      c.fillRect(k * bay, yy(0.1), 14, H * 0.9);
    }
  }
}

function paintAtlas(day: CanvasRenderingContext2D, lit: CanvasRenderingContext2D) {
  const W = ATLAS.width;
  const H = ATLAS.rowPx;
  // a faint glow over the whole wall: the deck lights washing the white paint
  lit.fillStyle = '#1c1915';
  lit.fillRect(0, 0, W, H * WINDOW_ROW_COUNT);
  for (let row = 0; row < WINDOW_ROW_COUNT; row++) {
    const y0 = row * H;
    paintRow(day, row, y0, W, H, (x, y, w, h, key) => {
      glass(day, x, y, w, h);
      // curtains drawn in some cabins (a lighter, warmer pane)
      const k = hash(row * 1000 + key);
      if (row !== WINDOW_ROWS.lounge && k < 0.1) {
        day.fillStyle = 'rgba(214,196,168,0.25)';
        day.fillRect(x, y, w, h);
      }
      // night: most panes lit warm, public rooms brighter and whiter
      const on = row === WINDOW_ROWS.lounge || row === WINDOW_ROWS.promenade ? 0.92 : 0.66;
      if (k < on) {
        const b = 0.55 + 0.45 * hash(row * 77 + key * 3.1);
        const warm = row === WINDOW_ROWS.lounge ? [255, 226, 180] : [255, 196, 120];
        lit.fillStyle = `rgb(${(warm[0] * b) | 0},${(warm[1] * b) | 0},${(warm[2] * b) | 0})`;
        lit.fillRect(x, y, w, h);
      }
    });
  }
}

function paintName(c: CanvasRenderingContext2D, W: number, H: number, name: string) {
  c.clearRect(0, 0, W, H);
  c.fillStyle = '#1b2a44';
  c.font = `700 ${Math.round(H * 0.78)}px Georgia, "Times New Roman", serif`;
  c.textAlign = 'center';
  c.textBaseline = 'middle';
  const spaced = name.split('').join(String.fromCharCode(8202));
  c.fillText(spaced, W / 2, H * 0.54, W * 0.96);
}

export function createCruiseTextures(registration: string): CruiseTextures | null {
  if (typeof document === 'undefined') return null;
  const canvas = (w: number, h: number) => {
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
  };
  const dc = canvas(ATLAS.width, ATLAS.rowPx * WINDOW_ROW_COUNT);
  const lc = canvas(ATLAS.width, ATLAS.rowPx * WINDOW_ROW_COUNT);
  const nc = canvas(NAME_TEX.width, NAME_TEX.height);
  const d = dc.getContext('2d');
  const l = lc.getContext('2d');
  const n = nc.getContext('2d');
  if (!d || !l || !n) return null;
  paintAtlas(d, l);
  paintName(n, NAME_TEX.width, NAME_TEX.height, registration);
  const tex = (c: HTMLCanvasElement) => {
    const x = new THREE.CanvasTexture(c);
    x.colorSpace = THREE.SRGBColorSpace;
    x.anisotropy = 8;
    x.wrapS = THREE.RepeatWrapping;
    x.wrapT = THREE.ClampToEdgeWrapping;
    return x;
  };
  const name = tex(nc);
  name.wrapS = THREE.ClampToEdgeWrapping;
  return { windows: tex(dc), windowsLit: tex(lc), name };
}
