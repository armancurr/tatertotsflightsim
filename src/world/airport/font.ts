/**
 * Runway numeral "font": FAA-style designator digits (60 ft tall, 20 ft wide,
 * 3:1) described as stroke centrelines, turned into quads with mitred joins.
 * Pure (no three.js) so the marking layout can be tested in node.
 *
 * Digit frame: x ∈ [0, width] to the right, y ∈ [0, height] up (reading
 * direction). Stroke centrelines are inset by half the stroke width so the
 * outline fills the box exactly.
 */

export interface P2 {
  x: number;
  y: number;
}
export type Quad2 = [P2, P2, P2, P2];

export interface Stroke {
  pts: P2[];
  closed: boolean;
}

/** Normalised digit cell: 1 wide, 3 tall, stroke 0.25 (5 ft on a 20 ft cell). */
export const DIGIT_BOX = { width: 1, height: 3, stroke: 0.25 } as const;

const H = DIGIT_BOX.stroke / 2;
const X0 = H;
const X1 = DIGIT_BOX.width - H;
const Y0 = H;
const Y1 = DIGIT_BOX.height - H;
const YM = DIGIT_BOX.height / 2;
const R = 0.3; // corner radius of the rounded corners (centreline)

type Corner = [number, number, number?]; // x, y, radius (0 = sharp)

/** Polyline through corner points, rounding corners with a radius (arc tangent to both legs). */
function rounded(corners: Corner[], closed = false): Stroke {
  const n = corners.length;
  const out: P2[] = [];
  for (let i = 0; i < n; i++) {
    const [x, y, r = 0] = corners[i];
    const hasPrev = closed || i > 0;
    const hasNext = closed || i < n - 1;
    if (!r || !hasPrev || !hasNext) {
      out.push({ x, y });
      continue;
    }
    const p = corners[(i - 1 + n) % n];
    const q = corners[(i + 1) % n];
    const ax = p[0] - x, ay = p[1] - y;
    const bx = q[0] - x, by = q[1] - y;
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    const ux = ax / la, uy = ay / la, vx = bx / lb, vy = by / lb;
    const cosT = Math.max(-1, Math.min(1, ux * vx + uy * vy));
    const theta = Math.acos(cosT); // interior angle
    const t = Math.min(r / Math.tan(theta / 2), la * 0.5, lb * 0.5); // tangent length
    const rr = t * Math.tan(theta / 2);
    const sx = x + ux * t, sy = y + uy * t; // arc start (on the incoming leg)
    const ex = x + vx * t, ey = y + vy * t; // arc end (on the outgoing leg)
    // centre: along the bisector
    const bxn = ux + vx, byn = uy + vy;
    const bl = Math.hypot(bxn, byn) || 1;
    const cd = rr / Math.sin(theta / 2);
    const cx = x + (bxn / bl) * cd, cy = y + (byn / bl) * cd;
    const a0 = Math.atan2(sy - cy, sx - cx);
    const a1 = Math.atan2(ey - cy, ex - cx);
    let da = a1 - a0;
    while (da > Math.PI) da -= Math.PI * 2;
    while (da < -Math.PI) da += Math.PI * 2;
    const steps = Math.max(2, Math.ceil(Math.abs(da) / (Math.PI / 12)));
    for (let s = 0; s <= steps; s++) {
      const a = a0 + (da * s) / steps;
      out.push({ x: cx + Math.cos(a) * rr, y: cy + Math.sin(a) * rr });
    }
  }
  // drop duplicate consecutive points (an arc ending where the next begins)
  const pts = out.filter((p, i) => {
    const q = i > 0 ? out[i - 1] : closed ? out[out.length - 1] : null;
    return !q || Math.hypot(p.x - q.x, p.y - q.y) > 1e-9;
  });
  return { pts, closed };
}

const W = DIGIT_BOX.width;
const HT = DIGIT_BOX.height;
const DIGITS: Record<string, Stroke[]> = {
  '0': [rounded([[X0, Y0, R], [X1, Y0, R], [X1, Y1, R], [X0, Y1, R]], true)],
  '1': [{ pts: [{ x: W / 2, y: 0 }, { x: W / 2, y: HT }], closed: false }],
  '2': [rounded([[0, Y1], [X1, Y1, R], [X1, 2.05, R], [X0, 0.9, R], [X0, Y0], [W, Y0]])],
  '3': [rounded([[0, Y1], [X1, Y1, R], [X1, Y0, R], [0, Y0]]), { pts: [{ x: 0.3, y: YM }, { x: X1, y: YM }], closed: false }],
  '4': [rounded([[X0, HT], [X0, 1.15], [W, 1.15]]), { pts: [{ x: X1, y: HT }, { x: X1, y: 0 }], closed: false }],
  '5': [rounded([[W, Y1], [X0, Y1], [X0, YM], [X1, YM, R], [X1, Y0, R], [0, Y0]])],
  '6': [rounded([[W, Y1], [X0, Y1, R], [X0, Y0, R], [X1, Y0, R], [X1, YM, R], [X0, YM]])],
  '7': [rounded([[0, Y1], [X1, Y1], [X1, 2.2], [0.42, 0.55], [0.42, 0]])],
  '8': [rounded([[X0, Y0, R], [X1, Y0, R], [X1, Y1, R], [X0, Y1, R]], true), { pts: [{ x: X0, y: YM }, { x: X1, y: YM }], closed: false }],
  '9': [rounded([[0, Y0], [X1, Y0, R], [X1, Y1, R], [X0, Y1, R], [X0, YM, R], [W, YM]])],
};
// Clamp every open stroke end that should touch the box edge exactly (square cut at the box).
for (const d of Object.keys(DIGITS)) for (const s of DIGITS[d]) for (const p of s.pts) {
  p.x = Math.max(0, Math.min(DIGIT_BOX.width, p.x));
  p.y = Math.max(0, Math.min(DIGIT_BOX.height, p.y));
}

export function digitStrokes(d: string): Stroke[] {
  const s = DIGITS[d];
  if (!s) throw new Error(`no runway numeral for "${d}"`);
  return s;
}

/**
 * Thick polyline → quads (one per segment) with mitred joins, square ends.
 * Each quad is counter-clockwise in (x right, y up).
 */
export function strokeQuads(s: Stroke, width: number): Quad2[] {
  const pts = s.pts;
  const n = pts.length;
  const hw = width / 2;
  const segs = s.closed ? n : n - 1;
  // left normal per segment
  const nx: number[] = [];
  const ny: number[] = [];
  for (let i = 0; i < segs; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const l = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    nx.push(-(b.y - a.y) / l);
    ny.push((b.x - a.x) / l);
  }
  // offset (left) at each vertex
  const off = (i: number): P2 => {
    const prev = s.closed ? (i - 1 + segs) % segs : i - 1;
    const next = s.closed ? i % segs : i;
    const hasPrev = s.closed || i > 0;
    const hasNext = s.closed || i < n - 1;
    if (!hasPrev) return { x: nx[next] * hw, y: ny[next] * hw };
    if (!hasNext) return { x: nx[prev] * hw, y: ny[prev] * hw };
    let mx = nx[prev] + nx[next];
    let my = ny[prev] + ny[next];
    const ml = Math.hypot(mx, my) || 1;
    mx /= ml;
    my /= ml;
    const cos = mx * nx[next] + my * ny[next];
    const len = hw / Math.max(cos, 0.35);
    return { x: mx * len, y: my * len };
  };
  const quads: Quad2[] = [];
  for (let i = 0; i < segs; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];
    const oa = off(i);
    const ob = off(s.closed ? (i + 1) % n : i + 1);
    // right side first (a−, b−), then left (b+, a+) → CCW
    quads.push([
      { x: a.x - oa.x, y: a.y - oa.y },
      { x: b.x - ob.x, y: b.y - ob.y },
      { x: b.x + ob.x, y: b.y + ob.y },
      { x: a.x + oa.x, y: a.y + oa.y },
    ]);
  }
  // Clip to the digit box where a square end on the box edge overshoots due to the mitre.
  return quads;
}

export interface TextLayout {
  cells: { x0: number; x1: number }[];
  quads: { index: number; digit: string; p: Quad2 }[];
}

/**
 * Lays out a numeral string in cells of `cellWidth`, `gap` apart, centred on
 * x = 0, baseline y = 0, digits scaled to `height` with `strokeWidth` strokes.
 */
export function textQuads(text: string, o: { cellWidth: number; height: number; gap: number; strokeWidth: number }): TextLayout {
  const n = text.length;
  const total = n * o.cellWidth + (n - 1) * o.gap;
  const sx = o.cellWidth / DIGIT_BOX.width;
  const sy = o.height / DIGIT_BOX.height;
  // stroke width expressed in normalised units (use the horizontal scale; strokes are ~equal both ways)
  const swN = o.strokeWidth / sx;
  const cells: TextLayout['cells'] = [];
  const quads: TextLayout['quads'] = [];
  for (let i = 0; i < n; i++) {
    const x0 = -total / 2 + i * (o.cellWidth + o.gap);
    cells.push({ x0, x1: x0 + o.cellWidth });
    const d = text[i];
    for (const s of scaleStrokeInset(digitStrokes(d), swN)) {
      for (const q of strokeQuads(s, swN)) {
        quads.push({
          index: i,
          digit: d,
          p: q.map((p) => ({ x: x0 + clamp(p.x, 0, DIGIT_BOX.width) * sx, y: clamp(p.y, 0, DIGIT_BOX.height) * sy })) as Quad2,
        });
      }
    }
  }
  return { cells, quads };
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

/** Re-inset the stroke centrelines for a stroke width other than the design width. */
function scaleStrokeInset(strokes: Stroke[], sw: number): Stroke[] {
  if (Math.abs(sw - DIGIT_BOX.stroke) < 1e-9) return strokes;
  const h0 = DIGIT_BOX.stroke / 2;
  const h1 = sw / 2;
  const map = (v: number, max: number) => {
    // move points that sit on the design inset line to the new inset line (linear in between)
    const t = (v - h0) / (max - 2 * h0);
    return h1 + t * (max - 2 * h1);
  };
  return strokes.map((s) => ({
    closed: s.closed,
    pts: s.pts.map((p) => ({
      x: p.x <= 0 || p.x >= DIGIT_BOX.width || Math.abs(p.x - DIGIT_BOX.width / 2) < 1e-9 ? p.x : map(p.x, DIGIT_BOX.width),
      y: p.y <= 0 || p.y >= DIGIT_BOX.height ? p.y : map(p.y, DIGIT_BOX.height),
    })),
  }));
}
