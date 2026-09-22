/**
 * Road markings (PURE): the one table the road shader is generated from and
 * the tests check. US/FAA-consistent style (the airport uses FAA markings):
 * yellow centre lines separate opposing traffic, white edge lines, white
 * crosswalks ("continental" bars) and stop bars at town junctions.
 *
 * Coordinates: `across` (m, + = right of increasing s), `along` (m, the road's
 * arc length), `d` (m, distance to the junction centre at the nearer end).
 */
import type { NetKind } from './network';

export type PaintColor = 'white' | 'yellow';

export interface MarkLine {
  /** Centre offset across the road, m (lines are listed for both sides). */
  offset: number;
  halfWidth: number;
  color: PaintColor;
  /** Dash length and period along the road, m (dash 0 = solid). */
  dash: number;
  period: number;
  /** Centre line (stops before town crosswalks) vs edge line (breaks at every junction). */
  role: 'centre' | 'edge';
}

/** US standard broken line: 10 ft line, 30 ft gap. */
export const DASH = 3;
export const DASH_PERIOD = 12;
/** Paint widths (half), m: 4–6 in lines. */
const EDGE_HW = 0.075;
const CENTRE_HW = 0.06;
const DOUBLE_GAP = 0.1;

/** Travel lane width per kind (both directions have one lane), m. */
export function laneWidth(kind: NetKind, width: number): number {
  switch (kind) {
    case 'highway':
      return 3.65;
    case 'road':
    case 'access':
      return Math.min(3.3, width / 2 - 0.2);
    default:
      return width / 2;
  }
}

export function markingLines(kind: NetKind, width: number, arterial: boolean): MarkLine[] {
  const hw = width / 2;
  const out: MarkLine[] = [];
  const double = (hwLine: number) => {
    const o = DOUBLE_GAP / 2 + hwLine;
    out.push({ offset: -o, halfWidth: hwLine, color: 'yellow', dash: 0, period: 0, role: 'centre' });
    out.push({ offset: o, halfWidth: hwLine, color: 'yellow', dash: 0, period: 0, role: 'centre' });
  };
  const edges = (at: number) => {
    out.push({ offset: -at, halfWidth: EDGE_HW, color: 'white', dash: 0, period: 0, role: 'edge' });
    out.push({ offset: at, halfWidth: EDGE_HW, color: 'white', dash: 0, period: 0, role: 'edge' });
  };
  switch (kind) {
    case 'highway':
      double(CENTRE_HW);
      edges(laneWidth(kind, width) + EDGE_HW + DOUBLE_GAP / 2);
      break;
    case 'road':
    case 'access':
      out.push({ offset: 0, halfWidth: CENTRE_HW, color: 'yellow', dash: DASH, period: DASH_PERIOD, role: 'centre' });
      edges(Math.min(hw - 0.25, laneWidth(kind, width) + EDGE_HW));
      break;
    case 'street':
      if (arterial) double(CENTRE_HW);
      break;
    default:
      break;
  }
  return out;
}

// ─── Junction markings (towns) ────────────────────────────────────────────────

export interface JunctionMarks {
  /** Crosswalk band: d ∈ [cw0, cw1]. */
  cw0: number;
  cw1: number;
  /** Stop bar: d ∈ [stop0, stop1], on the approaching half only. */
  stop0: number;
  stop1: number;
  /** Continental bars across the road: bar width and period, m. */
  bar: number;
  barPeriod: number;
}

/**
 * Markings on the leg of a town junction whose crossing road has half width
 * `h` (along this road) and sidewalk width `y` (the crosswalk continues that
 * sidewalk across this road).
 */
export function junctionMarks(h: number, y: number): JunctionMarks {
  const a = Math.abs(h);
  const cw0 = a + 0.5;
  const cw1 = cw0 + Math.max(2.4, y - 0.4);
  return { cw0, cw1, stop0: cw1 + 0.6, stop1: cw1 + 1.05, bar: 0.6, barPeriod: 1.2 };
}

// ─── Evaluator (TS mirror of the shader, for tests) ───────────────────────────

/** Box-filtered coverage of the interval [a, b] by a pixel footprint of width fw centred at x. */
export function bandCoverage(x: number, a: number, b: number, fw: number): number {
  const f = Math.max(fw, 1e-4);
  return Math.max(0, Math.min(1, (Math.min(x + f / 2, b) - Math.max(x - f / 2, a)) / f));
}

/** Cumulative "on" length of a pulse train (on for `on` of every `period`) from 0 to t. */
function pulseIntegral(t: number, on: number, period: number): number {
  const k = Math.floor(t / period);
  return k * on + Math.min(t - k * period, on);
}

/** Box-filtered coverage of a pulse train at t (exact: no aliasing at any footprint). */
export function dashCoverage(t: number, on: number, period: number, fw: number): number {
  const f = Math.max(fw, 1e-4);
  return (pulseIntegral(t + f / 2, on, period) - pulseIntegral(t - f / 2, on, period)) / f;
}

export interface JunctionState {
  /** Distance to the junction centre at the nearer end, and its (signed) crossing half width and sidewalk width. */
  d: number;
  h: number;
  y: number;
  /** +1 if increasing s approaches this junction (the end), −1 if it's the start. */
  side: 1 | -1;
}

/** Paint coverage (0..1) and colour at a road point, point-sampled (fw → 0). */
export function paintAt(kind: NetKind, width: number, arterial: boolean, across: number, along: number, j: JunctionState | null, fw = 1e-3): { white: number; yellow: number } {
  const hw = width / 2;
  let white = 0;
  let yellow = 0;
  if (Math.abs(across) > hw) return { white, yellow };
  const town = !!j && j.h > 0;
  const jm = j ? junctionMarks(j.h, j.y) : null;
  for (const l of markingLines(kind, width, arterial)) {
    if (j && j.h !== 0) {
      if (l.role === 'edge' && j.d < Math.abs(j.h) + 0.5) continue;
      if (town && jm && j.d < jm.stop1 + 0.3) continue;
    }
    let c = bandCoverage(across, l.offset - l.halfWidth, l.offset + l.halfWidth, fw);
    if (l.dash > 0) c *= dashCoverage(along, l.dash, l.period, fw);
    if (l.color === 'white') white = Math.max(white, c);
    else yellow = Math.max(yellow, c);
  }
  if (town && j && jm) {
    const inner = hw - 0.25;
    const cw = bandCoverage(j.d, jm.cw0, jm.cw1, fw) * dashCoverage(across + inner, jm.bar, jm.barPeriod, fw) * bandCoverage(across, -inner, inner, fw);
    const stop = bandCoverage(j.d, jm.stop0, jm.stop1, fw) * bandCoverage(across * j.side, 0.15, inner, fw);
    white = Math.max(white, cw, stop);
  }
  return { white, yellow };
}
