/**
 * Where the weapons HUD's text goes, so nothing overlaps (pure maths, no DOM):
 *
 *  - `jetHudKeepOut` — the rectangles the jet HUD (src/ui/jetHud.ts) fills with its own text and
 *    scales in a HUD box: corner data (G / MAX / THR / AB), the airspeed and altitude columns with
 *    their boxed readouts, Mach / AOA / radar altitude / VS, the GEAR / SPD BRK cues and the
 *    heading tape band (ticks, labels, caret, digital heading and the weapons HUD's range caret),
 *    for the full and the compact (small combiner glass) layouts, on the glass and in screen space.
 *    It mirrors drawJetHud's formulas; tests/ui/weaponsHudLayout.test.ts draws the jet HUD and
 *    checks every one of its texts falls inside these rects, so the two cannot drift apart.
 *  - `TextPlacer` — a tiny collision-free placer: hard obstacles (other text, the jet HUD's
 *    keep-out, the text's own symbol) are never crossed; soft ones (the other weapons symbols) are
 *    avoided when there is room. A block of lines is tried in a fixed order of candidate spots
 *    around its symbol (below, above, right, left, the diagonals, then further out), keeping last
 *    frame's spot while it stays clear (no flicker). If a block fits nowhere its least important
 *    lines are dropped — so text never overlaps other text or the heading tape, by construction.
 *
 * Text size is estimated from the monospace font (≈ 0.62 em per character, plus the halo), which is
 * what the HUDs draw with (SF Mono / Menlo / DejaVu Sans Mono all advance 0.60 em).
 */
import { CONFIG, type Config } from '../config';
import { jetHeadingTape, jetHudCompact } from './jetHud';

/** Monospace advance per character, em (a little over the fonts' 0.60 for safety). */
export const CHAR_EM = 0.62;

/** Width of an n-character line at `px`, halo included. */
export function textWidth(chars: number, px: number): number {
  return Math.max(0, chars) * CHAR_EM * px + px * 0.25;
}

/** Height of a line at `px`, halo included. */
export function textHeight(px: number): number {
  return px * 1.15;
}

const fin = (x: number): boolean => typeof x === 'number' && Number.isFinite(x);
const sz = (x: number): number => (fin(x) && x > 0 ? Math.min(x, 1e5) : 0);

// ─── The jet HUD's own space ─────────────────────────────────────────────────

export interface JetHudSpace {
  /** The jet HUD's box in the weapons HUD's coordinates (glass: its HUD box at 0, 0). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Drawn on the combiner glass (min font 11 px, corner data at the top, compact below 190 px). */
  glass: boolean;
  /** Boresight y in the box, px (glass: projected; screen: hud.jet.boresightY × h). */
  boreY: number;
  gearUp: boolean;
  /** The weapons HUD's font (the range caret on the tape is sized from it). */
  font: number;
  /** The conditional cues, when known (undefined = keep their room free): SPD BRK, AB / ENG OFF. */
  speedBrake?: boolean;
  abOrEngine?: boolean;
  /** The weapons HUD draws its range caret at the heading tape's ends (undefined = keep room for it). */
  caret?: boolean;
}

/** The heading tape's rects are the last JET_TAPE_RECTS of jetHudKeepOut's output. */
export const JET_TAPE_RECTS = 2;

/**
 * Fill `out` (x0, y0, x1, y1 per rect) with the jet HUD's text/scale areas; returns the rect count.
 * `out` must hold at least JET_KEEP_OUT_MAX rects.
 */
export const JET_KEEP_OUT_MAX = 16;

export function jetHudKeepOut(out: Float64Array, s: JetHudSpace, cfg: Config = CONFIG): number {
  const W = sz(s.w);
  const H = sz(s.h);
  if (!W || !H || out.length < JET_KEEP_OUT_MAX * 4) return 0;
  const ox = fin(s.x) ? s.x : 0;
  const oy = fin(s.y) ? s.y : 0;
  let n = 0;
  const put = (x0: number, y0: number, x1: number, y1: number) => {
    if (!(fin(x0) && fin(y0) && fin(x1) && fin(y1))) return;
    out[4 * n] = ox + Math.min(x0, x1);
    out[4 * n + 1] = oy + Math.min(y0, y1);
    out[4 * n + 2] = ox + Math.max(x0, x1);
    out[4 * n + 3] = oy + Math.max(y0, y1);
    n++;
  };
  /** A line of `chars` characters at (x, y), aligned left / right / centre. */
  const line = (x: number, y: number, chars: number, px: number, align: 'left' | 'right' | 'center') => {
    const w = textWidth(chars, px);
    const h = textHeight(px) / 2;
    const x0 = align === 'left' ? x - px * 0.15 : align === 'right' ? x - w + px * 0.15 : x - w / 2;
    put(x0, y - h, x0 + w, y + h);
  };
  const minFont = s.glass ? 11 : 9;
  const compact = jetHudCompact(W, H, s.glass);
  const big = Math.max(minFont + 2, H * 0.038);
  const small = Math.max(minFont, H * 0.03);
  const boreY = fin(s.boreY) ? s.boreY : H * cfg.hud.jet.boresightY;

  // Corner data.
  const topY = s.glass ? big * 0.8 : H * 0.05;
  line(W * 0.03, topY, 6, big, 'left'); // G 1.0
  if (!compact) {
    line(W * 0.03, topY + big * 1.2, 8, small, 'left'); // MAX 1.0
    line(W * 0.97, topY, 8, big, 'right'); // THR 100%
  }
  if (s.abOrEngine !== false) line(W * 0.97, compact ? topY : topY + big * 1.2, 14, small, 'right'); // AB  ENG FAILED

  // Airspeed (left) and altitude (right) columns with their readout boxes.
  const span = compact ? big * 0.8 : H * 0.2;
  const tapeY = compact ? H * 0.45 : s.glass ? Math.max(boreY, big * 1.2 + small * 1.4 + span + 4) : boreY;
  const bh = big * 1.45;
  const bwS = Math.max(big * 3.6, big * (CHAR_EM * 3 + 1));
  const bwA = Math.max(big * 3.6, big * (CHAR_EM * 6 + 1));
  const xs = W * 0.19;
  const xa = W * 0.81;
  if (compact) {
    put(2 - 2, tapeY - bh / 2 - 2, 2 + bwS + 2, tapeY + bh / 2 + 2);
    put(W - bwA - 4, tapeY - bh / 2 - 2, W, tapeY + bh / 2 + 2);
  } else {
    const lab = small * 0.9;
    const bxS = Math.max(1, xs - H * 0.03 - bwS);
    const bxA = Math.min(W - bwA - 1, xa + H * 0.03);
    const y0 = Math.min(tapeY - span - textHeight(lab) / 2, tapeY - bh / 2) - 2;
    const y1 = Math.max(tapeY + span + textHeight(lab) / 2, tapeY + bh / 2) + 2;
    put(Math.min(bxS, xs - H * 0.03 - textWidth(4, lab)) - 2, y0, Math.max(xs + 3, bxS + bwS + 1), y1);
    put(Math.min(xa - 3, bxA - 1), y0, Math.max(bxA + bwA, xa + H * 0.03 + textWidth(6, lab)) + 2, y1);
  }

  // Under the columns: Mach / AOA / GS (left), radar altitude / VS (right), then GEAR / SPD BRK.
  const low = tapeY + span + big * 1.2;
  if (!compact) {
    line(W * 0.03, low, 6, big, 'left'); // M 0.85
    line(W * 0.03, low + big * 1.3, 9, small, 'left'); // AOA -12.5
    line(W * 0.03, low + big * 2.4, 7, small, 'left'); // GS 1720
    line(W * 0.97, low, 7, big, 'right'); // R 4,990
    line(W * 0.97, low + big * 1.3, 10, small, 'right'); // VS +12,340
  }
  let cy = compact ? low + small * 1.3 : low + big * 2.5;
  if (!s.gearUp) {
    line(W * 0.97, cy, 7, small, 'right'); // GEAR DN
    cy += big * 1.2;
  }
  if (s.speedBrake !== false) line(W * 0.97, cy, 7, small, 'right'); // SPD BRK

  // Heading tape (the last two rects): the tape — ticks, labels and, when the weapons HUD draws it,
  // the range caret at its ends — then the centre caret with the digital heading under/over it.
  const tape = jetHeadingTape(W, H, s.gearUp, compact);
  const ty = tape.y;
  const d = tape.dir;
  const F = fin(s.font) && s.font > 0 ? s.font : 12;
  const caret = s.caret !== false;
  const labY = ty + d * Math.max(H * 0.042, compact ? small * 1.05 : 0);
  const hs = textHeight(small) / 2;
  let t0 = Math.min(ty, ty + d * H * 0.02, labY - hs);
  let t1 = Math.max(ty, ty + d * H * 0.02, labY + hs);
  if (caret) {
    t0 = Math.min(t0, ty - F * 0.6);
    t1 = Math.max(t1, ty + F * 0.6);
  }
  const hw = tape.halfWidth + (caret ? Math.max(small * 0.3, F * 0.75) : small * 0.3);
  put(W / 2 - hw, t0 - 2, W / 2 + hw, t1 + 2);
  const c0 = ty - d * H * 0.026;
  let c1 = c0;
  let cw = H * 0.014;
  if (!compact) {
    const hy = ty - d * H * 0.058;
    c1 = hy + (d < 0 ? hs : -hs);
    cw = Math.max(cw, textWidth(3, small) / 2);
  }
  put(W / 2 - cw - 2, Math.min(ty, c0, c1) - 1, W / 2 + cw + 2, Math.max(ty, c0, c1) + 1);
  return n;
}

// ─── Placing text ────────────────────────────────────────────────────────────

export interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One line of a block: its text length, size and weight. */
export interface LineSpec {
  chars: number;
  px: number;
}

/** Where a block was put: each line's reference x (by `align`) and centre y. */
export interface Placed {
  ok: boolean;
  /** Candidate index used (for next frame's hysteresis). */
  spot: number;
  align: 'left' | 'right' | 'center';
  /** Reference x per line (left edge / right edge / centre by `align`) and centre y. */
  x: Float64Array;
  y: Float64Array;
  /** Which lines are shown (dropped lines are 0). */
  shown: Uint8Array;
}

export function createPlaced(maxLines = 6): Placed {
  return { ok: false, spot: -1, align: 'center', x: new Float64Array(maxLines), y: new Float64Array(maxLines), shown: new Uint8Array(maxLines) };
}

/** A fixed spot for a block: reference x, the bottom line's centre y, alignment. */
export interface FixedSpot {
  x: number;
  y: number;
  align: 'left' | 'right' | 'center';
}

export interface PlaceOptions {
  /** The side tried first around the symbol. */
  prefer: 'below' | 'above' | 'right' | 'left';
  /** First try: line 0 above the symbol, the rest below (the lock box's LOCK over its data). */
  split: boolean;
  /** Line indices dropped one by one (first first) when the block fits nowhere. */
  dropOrder: readonly number[];
  /** Gap to the symbol, px, and how many rings further out to try. */
  gap: number;
  far: number;
  /** Fixed spots tried after the symbol's (or alone without a symbol). */
  fixed: readonly FixedSpot[];
  nFixed: number;
}

export function placeOptions(o: Partial<PlaceOptions> = {}): PlaceOptions {
  const fixed = o.fixed ?? [];
  return { prefer: o.prefer ?? 'below', split: o.split ?? false, dropOrder: o.dropOrder ?? [], gap: o.gap ?? 4, far: o.far ?? 10, fixed, nFixed: o.nFixed ?? fixed.length };
}

const MAX_HARD = 96;
const MAX_SOFT = 16;
const MAX_LINES = 6;

/** Direction order per preferred side: below 0, above 1, right 2, left 3, then the diagonals 4–7. */
const PREFER: Record<PlaceOptions['prefer'], readonly number[]> = {
  below: [0, 2, 3, 1, 4, 5, 6, 7],
  above: [1, 2, 3, 0, 6, 7, 4, 5],
  right: [2, 0, 1, 3, 4, 6, 5, 7],
  left: [3, 0, 1, 2, 5, 7, 4, 6],
};

/**
 * Collision-free text placement for one frame: `reset(display)`, add the obstacles, then place the
 * blocks in priority order (each placed line becomes a hard obstacle for the next). No allocation
 * per frame.
 */
export class TextPlacer {
  readonly display: Box = { x0: 0, y0: 0, x1: 0, y1: 0 };
  readonly hard = new Float64Array(MAX_HARD * 4);
  nHard = 0;
  readonly soft = new Float64Array(MAX_SOFT * 4);
  nSoft = 0;
  /** Rects of every line placed this frame (x0, y0, x1, y1) — for tests and QA. */
  readonly placed = new Float64Array(MAX_HARD * 4);
  nPlaced = 0;
  // Scratch for the block being placed.
  private readonly rects = new Float64Array(MAX_LINES * 4);
  private readonly spec: LineSpec[] = [];
  private readonly idx: number[] = [];
  private m = 0;
  private bh = 0;
  private step = 0;
  private baseStep = 0;
  private sym: Box | null = null;
  private opts: PlaceOptions = placeOptions();
  private cAlign: 'left' | 'right' | 'center' = 'center';
  private cX = 0;
  private cY = 0;
  private cSplit = false;
  private cSplitY = 0;

  reset(x0: number, y0: number, x1: number, y1: number): void {
    this.display.x0 = x0;
    this.display.y0 = y0;
    this.display.x1 = x1;
    this.display.y1 = y1;
    this.nHard = 0;
    this.nSoft = 0;
    this.nPlaced = 0;
  }

  addHard(x0: number, y0: number, x1: number, y1: number): void {
    if (this.nHard >= MAX_HARD || !(fin(x0) && fin(y0) && fin(x1) && fin(y1))) return;
    const i = 4 * this.nHard++;
    this.hard[i] = Math.min(x0, x1);
    this.hard[i + 1] = Math.min(y0, y1);
    this.hard[i + 2] = Math.max(x0, x1);
    this.hard[i + 3] = Math.max(y0, y1);
  }

  addHardRects(r: Float64Array, n: number): void {
    for (let k = 0; k < n; k++) this.addHard(r[4 * k], r[4 * k + 1], r[4 * k + 2], r[4 * k + 3]);
  }

  addSoft(x0: number, y0: number, x1: number, y1: number): void {
    if (this.nSoft >= MAX_SOFT || !(fin(x0) && fin(y0) && fin(x1) && fin(y1))) return;
    const i = 4 * this.nSoft++;
    this.soft[i] = Math.min(x0, x1);
    this.soft[i + 1] = Math.min(y0, y1);
    this.soft[i + 2] = Math.max(x0, x1);
    this.soft[i + 3] = Math.max(y0, y1);
  }

  /** Is the rect inside the display, clear of the hard obstacles, `own` (its symbol) and, optionally, the soft ones? */
  clear(x0: number, y0: number, x1: number, y1: number, soft: boolean, own?: Box | null): boolean {
    if (!(fin(x0) && fin(y0) && fin(x1) && fin(y1))) return false;
    const d = this.display;
    if (x0 < d.x0 || y0 < d.y0 || x1 > d.x1 || y1 > d.y1) return false;
    if (own && x0 < own.x1 && own.x0 < x1 && y0 < own.y1 && own.y0 < y1) return false;
    const h = this.hard;
    for (let k = 0; k < this.nHard; k++) {
      const i = 4 * k;
      if (x0 < h[i + 2] && h[i] < x1 && y0 < h[i + 3] && h[i + 1] < y1) return false;
    }
    if (soft) {
      const s = this.soft;
      for (let k = 0; k < this.nSoft; k++) {
        const i = 4 * k;
        if (x0 < s[i + 2] && s[i] < x1 && y0 < s[i + 3] && s[i + 1] < y1) return false;
      }
    }
    return true;
  }

  /**
   * Place a stack of `n` lines (top to bottom, `step` px apart) next to a symbol's box `sym` (or at
   * fixed spots): the options' split first, then the preferred side, the other sides and the
   * diagonals at growing gaps, then the fixed spots — clear of everything if possible, else clear of
   * the hard obstacles only; last frame's spot is kept while fully clear. When nothing fits the
   * `dropOrder` lines go one by one. Placed lines become hard obstacles.
   */
  placeBlock(out: Placed, lines: readonly LineSpec[], n: number, step: number, sym: Box | null, opts: PlaceOptions): Placed {
    const N = Math.min(n, lines.length, out.x.length, MAX_LINES);
    for (let k = 0; k < out.shown.length; k++) out.shown[k] = k < N ? 1 : 0;
    this.sym = sym;
    this.opts = opts;
    this.baseStep = fin(step) && step > 0 ? step : 12;
    let dropped = 0;
    for (;;) {
      if (this.tryPlace(out, lines, N)) {
        out.ok = true;
        return out;
      }
      if (dropped >= opts.dropOrder.length) break;
      const di = opts.dropOrder[dropped++];
      if (di >= 0 && di < N) out.shown[di] = 0;
      let any = false;
      for (let k = 0; k < N; k++) if (out.shown[k]) any = true;
      if (!any) break;
    }
    out.ok = false;
    out.spot = -1;
    for (let k = 0; k < out.shown.length; k++) out.shown[k] = 0;
    return out;
  }

  private tryPlace(out: Placed, lines: readonly LineSpec[], N: number): boolean {
    const spec = this.spec;
    const idx = this.idx;
    spec.length = 0;
    idx.length = 0;
    for (let k = 0; k < N; k++) {
      if (!out.shown[k]) continue;
      spec.push(lines[k]);
      idx.push(k);
    }
    const m = spec.length;
    if (m === 0) return false;
    this.m = m;
    // lines of a block never touch: at least the tallest line apart
    let tall = 0;
    for (let k = 0; k < m; k++) tall = Math.max(tall, textHeight(spec[k].px));
    this.step = Math.max(this.baseStep, tall + 0.01);
    this.bh = (m - 1) * this.step;
    const total = this.total();
    let chosen = -1;
    if (out.spot >= 0 && out.spot < total && this.test(out.spot, true)) chosen = out.spot;
    for (let pass = 0; chosen < 0 && pass < 2; pass++) {
      for (let c = 0; c < total; c++) {
        if (this.test(c, pass === 0)) {
          chosen = c;
          break;
        }
      }
    }
    if (chosen < 0) return false;
    this.test(chosen, false);
    out.spot = chosen;
    out.align = this.cAlign;
    const r = this.rects;
    for (let k = 0; k < m; k++) {
      const li = idx[k];
      out.x[li] = this.cX;
      out.y[li] = this.lineY(k);
      this.commit(r[4 * k], r[4 * k + 1], r[4 * k + 2], r[4 * k + 3]);
    }
    return true;
  }

  private nSym(): number {
    return this.sym ? 1 + 8 * Math.max(1, Math.round(this.opts.far)) : 0;
  }

  private total(): number {
    return this.nSym() + Math.min(this.opts.nFixed, this.opts.fixed.length);
  }

  private lineY(k: number): number {
    return this.cSplit ? (k === 0 ? this.cSplitY : this.cY + (k - 1) * this.step) : this.cY + k * this.step;
  }

  /** Candidate `c`, clear (of the soft obstacles too when `soft`)? Leaves its line rects in `rects`. */
  private test(c: number, soft: boolean): boolean {
    if (!this.cand(c)) return false;
    const r = this.rects;
    for (let k = 0; k < this.m; k++) {
      lineRect(r, k, this.spec[k], this.cX, this.lineY(k), this.cAlign);
      if (!this.clear(r[4 * k], r[4 * k + 1], r[4 * k + 2], r[4 * k + 3], soft, this.sym)) return false;
    }
    return true;
  }

  private cand(c: number): boolean {
    const sym = this.sym;
    const o = this.opts;
    const spec = this.spec;
    const m = this.m;
    const nSym = this.nSym();
    this.cSplit = false;
    if (sym && c < nSym) {
      const cx = (sym.x0 + sym.x1) / 2;
      const cy = (sym.y0 + sym.y1) / 2;
      const h0 = textHeight(spec[0].px) / 2;
      const hN = textHeight(spec[m - 1].px) / 2;
      const bh = this.bh;
      let dir: number;
      let g: number;
      if (c === 0) {
        if (o.split && m >= 2) {
          this.cSplit = true;
          this.cAlign = 'center';
          this.cX = cx;
          this.cSplitY = sym.y0 - o.gap - h0;
          this.cY = sym.y1 + o.gap + textHeight(spec[1].px) / 2;
          return true;
        }
        dir = PREFER[o.prefer][0];
        g = o.gap;
      } else {
        const j = c - 1;
        dir = PREFER[o.prefer][j % 8];
        g = o.gap + Math.floor(j / 8) * Math.max(3, this.step * 0.5);
      }
      switch (dir) {
        case 0: // below
          this.cAlign = 'center';
          this.cX = cx;
          this.cY = sym.y1 + g + h0;
          return true;
        case 1: // above
          this.cAlign = 'center';
          this.cX = cx;
          this.cY = sym.y0 - g - hN - bh;
          return true;
        case 2: // right
          this.cAlign = 'left';
          this.cX = sym.x1 + g;
          this.cY = cy - bh / 2;
          return true;
        case 3: // left
          this.cAlign = 'right';
          this.cX = sym.x0 - g;
          this.cY = cy - bh / 2;
          return true;
        case 4: // below-right
          this.cAlign = 'left';
          this.cX = sym.x1 + g * 0.5;
          this.cY = sym.y1 + g * 0.5 + h0;
          return true;
        case 5: // below-left
          this.cAlign = 'right';
          this.cX = sym.x0 - g * 0.5;
          this.cY = sym.y1 + g * 0.5 + h0;
          return true;
        case 6: // above-right
          this.cAlign = 'left';
          this.cX = sym.x1 + g * 0.5;
          this.cY = sym.y0 - g * 0.5 - hN - bh;
          return true;
        default: // above-left
          this.cAlign = 'right';
          this.cX = sym.x0 - g * 0.5;
          this.cY = sym.y0 - g * 0.5 - hN - bh;
          return true;
      }
    }
    const f = o.fixed[c - nSym];
    if (!f || c - nSym >= o.nFixed) return false;
    this.cAlign = f.align;
    this.cX = f.x;
    this.cY = f.y - this.bh; // the bottom line sits at the spot; the block grows upward
    return true;
  }

  /** Record a placed line's rect as a hard obstacle. */
  private commit(x0: number, y0: number, x1: number, y1: number): void {
    this.addHard(x0, y0, x1, y1);
    if (this.nPlaced < MAX_HARD) {
      const i = 4 * this.nPlaced++;
      this.placed[i] = x0;
      this.placed[i + 1] = y0;
      this.placed[i + 2] = x1;
      this.placed[i + 3] = y1;
    }
  }
}

/** Rect of a line (x0, y0, x1, y1 into `out` at slot k) with reference x / centre y and alignment. */
export function lineRect(out: Float64Array, k: number, spec: LineSpec, x: number, y: number, align: 'left' | 'right' | 'center'): void {
  const w = textWidth(spec.chars, spec.px);
  const h = textHeight(spec.px) / 2;
  const x0 = align === 'left' ? x - spec.px * 0.15 : align === 'right' ? x - w + spec.px * 0.15 : x - w / 2;
  out[4 * k] = x0;
  out[4 * k + 1] = y - h;
  out[4 * k + 2] = x0 + w;
  out[4 * k + 3] = y + h;
}

/** Do two rects (x0, y0, x1, y1 at slots i and j) overlap (touching edges don't count)? */
export function rectsOverlap(a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number): boolean {
  return a[4 * i] < b[4 * j + 2] && b[4 * j] < a[4 * i + 2] && a[4 * i + 1] < b[4 * j + 3] && b[4 * j + 1] < a[4 * i + 3];
}
