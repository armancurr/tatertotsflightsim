/**
 * Paint: FAA precision-runway markings (AC 150/5340-1) plus taxiway, apron and
 * car-park markings, as quads in runway coordinates (a along, c across). PURE.
 *
 * Runway (per end): threshold "piano keys" (count from the runway width,
 * 150 ft long, starting 20 ft in), the designator 40 ft past them (60 ft tall
 * numerals), touchdown-zone bars (500/1500/2000… ft) and the aiming point
 * (1000 ft) — only as many groups as keep 900 ft between the two ends —, a
 * dashed centreline (120 ft stripes, ≈80 ft gaps) and full-length side stripes.
 */
import type { RunwayFrame } from '../runway';
import { strokeQuads, textQuads, type P2 } from './font';
import type { AirportPlan, RC } from './plan';

export const FT = 0.3048;
export const IN = 0.0254;

export type MarkKind =
  | 'threshold'
  | 'designator'
  | 'centerline'
  | 'tdz'
  | 'aiming'
  | 'edge'
  | 'taxi-centerline'
  | 'hold-short'
  | 'tiedown'
  | 'carpark'
  | 'fuel';

export type PaintColor = 'white' | 'yellow';

export interface MarkQuad {
  kind: MarkKind;
  color: PaintColor;
  /** Runway end the marking belongs to ('36', '18'), for runway markings. */
  end?: string;
  /** Numeral this stroke belongs to (designators). */
  digit?: string;
  /** Owner name (hold-short: connector name). */
  name?: string;
  style?: 'solid' | 'dashed';
  /** Corners in runway coordinates, counter-clockwise in (a, c). */
  p: [RC, RC, RC, RC];
}

export const MARKING = {
  keyLength: 150 * FT,
  keyWidth: 5.75 * FT,
  minKeyWidth: 1.5,
  keyStart: 20 * FT,
  designatorGap: 40 * FT,
  designatorHeight: 60 * FT,
  designatorCell: 20 * FT,
  designatorSpace: 10 * FT,
  centerlineGapAfterDesignator: 40 * FT,
  centerlineDash: 120 * FT,
  centerlineGap: 80 * FT,
  centerlineWidth: (w: number) => (w >= 23 ? 36 * IN : 18 * IN),
  sideStripeWidth: (w: number) => (w >= 25 ? 36 * IN : 18 * IN),
  /** Clear space kept between the widest marking and the side stripe, m. */
  margin: 0.6,
  tdzLength: 75 * FT,
  tdzBarWidth: 6 * FT,
  tdzBarGap: 5 * FT,
  aimingLength: 150 * FT,
  aimingWidth: 20 * FT,
  /** [distance from threshold (ft), bars per side]; 0 bars = aiming point. */
  tdzGroups: [
    [500, 3],
    [1000, 0],
    [1500, 2],
    [2000, 2],
    [2500, 1],
    [3000, 1],
  ] as [number, number][],
  /** Minimum clear distance between the two ends' touchdown-zone systems. */
  tdzClear: 900 * FT,
  taxiLine: 0.25,
  holdLine: 0.3,
  holdDash: 3 * FT,
};

const PIANO_TABLE: [number, number][] = [
  [60, 4],
  [75, 6],
  [100, 8],
  [150, 12],
  [200, 16],
];

/** Half-width available to markings inside the side stripes. */
const usableHalf = (width: number) => width / 2 - MARKING.sideStripeWidth(width) - MARKING.margin;

/** FAA threshold stripe count for a runway width (nearest standard width, reduced until it fits). */
export function pianoKeyCount(widthM: number): number {
  const ft = widthM / FT;
  let best = PIANO_TABLE[0];
  for (const e of PIANO_TABLE) if (Math.abs(e[0] - ft) < Math.abs(best[0] - ft)) best = e;
  let n = best[1];
  const avail = usableHalf(widthM);
  while (n > 4 && n * MARKING.minKeyWidth > avail) n -= 2;
  return n;
}

/** Runway designator for a heading: tens of degrees, 36 for north, no leading zero. */
export function runwayDesignator(headingDeg: number): string {
  const micro = Math.round((((headingDeg % 360) + 360) % 360) * 1e6); // integer micro-degrees
  let n = Math.floor((micro + 5_000_000) / 10_000_000) % 36;
  if (n === 0) n = 36;
  return String(n);
}

const rect = (kind: MarkKind, color: PaintColor, a0: number, a1: number, c0: number, c1: number, extra: Partial<MarkQuad> = {}): MarkQuad => ({
  kind,
  color,
  ...extra,
  p: [
    { a: a0, c: c0 },
    { a: a1, c: c0 },
    { a: a1, c: c1 },
    { a: a0, c: c1 },
  ],
});

/** Mirror a quad to the other runway end (a → L − a, c → −c keeps CCW order). */
const mirror = (q: MarkQuad, L: number, end: string): MarkQuad => ({
  ...q,
  end,
  p: q.p.map((p) => ({ a: L - p.a, c: -p.c })) as MarkQuad['p'],
});

/** Markings of one end, built for the 36 end (threshold at a = 0, pilot looking +a, right = +c). */
function endMarkings(rw: RunwayFrame, designator: string): { quads: MarkQuad[]; designatorTop: number; tdzEnd: number } {
  const w = rw.width;
  const L = rw.length;
  const quads: MarkQuad[] = [];
  const avail = usableHalf(w);

  // piano keys
  const n = pianoKeyCount(w);
  const kw = Math.min(MARKING.keyWidth, avail / n);
  const k0 = MARKING.keyStart;
  const k1 = k0 + MARKING.keyLength;
  for (let i = 0; i < n / 2; i++) {
    const inner = kw * (1 + 2 * i); // centre gap = 2 kw, spacing = kw
    quads.push(rect('threshold', 'white', k0, k1, inner, inner + kw));
    quads.push(rect('threshold', 'white', k0, k1, -inner - kw, -inner));
  }

  // designator
  const desStart = k1 + MARKING.designatorGap;
  const halfText = (2 * MARKING.designatorCell + MARKING.designatorSpace) / 2;
  const ds = Math.min(1, avail / halfText);
  const cell = MARKING.designatorCell * ds;
  const height = MARKING.designatorHeight * ds;
  const text = textQuads(designator, { cellWidth: cell, height, gap: MARKING.designatorSpace * ds, strokeWidth: cell * 0.25 });
  for (const q of text.quads) {
    const p = q.p.map((pt: P2) => ({ a: desStart + pt.y, c: pt.x })) as MarkQuad['p'];
    // (x right, y up) → (c, a) swaps handedness; reverse to keep CCW in (a, c)
    quads.push({ kind: 'designator', color: 'white', digit: q.digit, p: [p[0], p[3], p[2], p[1]] });
  }
  const designatorTop = desStart + height;

  // touchdown zone + aiming point
  const clHalf = MARKING.centerlineWidth(w) / 2;
  const band = 3 * MARKING.tdzBarWidth + 2 * MARKING.tdzBarGap;
  const bandMax = avail - (clHalf + 1);
  const bs = Math.min(1, bandMax / band);
  const barW = MARKING.tdzBarWidth * bs;
  const barGap = MARKING.tdzBarGap * bs;
  const inner = Math.max(clHalf + 1, Math.min(avail - band * bs, 0.18 * w));
  let tdzEnd = 0;
  const limit = L / 2 - MARKING.tdzClear / 2;
  for (const [ft, bars] of MARKING.tdzGroups) {
    const a0 = ft * FT;
    const len = bars === 0 ? MARKING.aimingLength : MARKING.tdzLength;
    if (a0 + len > limit || a0 < designatorTop + 1) continue;
    if (bars === 0) {
      const aw = Math.min(MARKING.aimingWidth, avail - inner);
      quads.push(rect('aiming', 'white', a0, a0 + len, -inner - aw, -inner));
      quads.push(rect('aiming', 'white', a0, a0 + len, inner, inner + aw));
    } else {
      for (let b = 0; b < bars; b++) {
        const c0 = inner + b * (barW + barGap);
        quads.push(rect('tdz', 'white', a0, a0 + len, c0, c0 + barW));
        quads.push(rect('tdz', 'white', a0, a0 + len, -c0 - barW, -c0));
      }
    }
    tdzEnd = Math.max(tdzEnd, a0 + len);
  }
  return { quads, designatorTop, tdzEnd };
}

export function runwayMarkings(rw: RunwayFrame): MarkQuad[] {
  const L = rw.length;
  const w = rw.width;
  const d36 = runwayDesignator(rw.headingDeg);
  const d18 = runwayDesignator(rw.headingDeg + 180);
  const e36 = endMarkings(rw, d36);
  const e18 = endMarkings(rw, d18);
  const out: MarkQuad[] = [];
  for (const q of e36.quads) out.push({ ...q, end: d36 });
  for (const q of e18.quads) out.push(mirror(q, L, d18));

  // centreline: evenly fitted between the two designators
  const s0 = e36.designatorTop + MARKING.centerlineGapAfterDesignator;
  const s1 = L - (e18.designatorTop + MARKING.centerlineGapAfterDesignator);
  const avail = s1 - s0;
  const dash = MARKING.centerlineDash;
  const n = Math.floor((avail + MARKING.centerlineGap) / (dash + MARKING.centerlineGap));
  const clHalf = MARKING.centerlineWidth(w) / 2;
  if (n >= 2) {
    const gap = (avail - n * dash) / (n - 1);
    for (let i = 0; i < n; i++) {
      const a0 = s0 + i * (dash + gap);
      out.push(rect('centerline', 'white', a0, a0 + dash, -clHalf, clHalf));
    }
  } else if (n === 1) {
    const a0 = L / 2 - dash / 2;
    out.push(rect('centerline', 'white', a0, a0 + dash, -clHalf, clHalf));
  }

  // side stripes
  const sw = MARKING.sideStripeWidth(w);
  out.push(rect('edge', 'white', 0, L, -rw.halfWidth, -rw.halfWidth + sw));
  out.push(rect('edge', 'white', 0, L, rw.halfWidth - sw, rw.halfWidth));
  return out;
}

// ─── taxiway / apron / car park ───────────────────────────────────────────────

/** A painted line along a polyline (runway coords) as quads. */
function line(kind: MarkKind, color: PaintColor, pts: RC[], width: number, extra: Partial<MarkQuad> = {}): MarkQuad[] {
  const qs = strokeQuads({ pts: pts.map((p) => ({ x: p.a, y: p.c })), closed: false }, width);
  return qs.map((q) => ({ kind, color, ...extra, p: q.map((p) => ({ a: p.x, c: p.y })) as MarkQuad['p'] }));
}

/** Quarter arc from `from` to `to` around `centre` (all runway coords). */
function arc(centre: RC, from: RC, to: RC, steps = 9): RC[] {
  const r = Math.hypot(from.a - centre.a, from.c - centre.c);
  const t0 = Math.atan2(from.c - centre.c, from.a - centre.a);
  let t1 = Math.atan2(to.c - centre.c, to.a - centre.a);
  let d = t1 - t0;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  t1 = t0 + d;
  const out: RC[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = t0 + (d * i) / steps;
    out.push({ a: centre.a + Math.cos(t) * r, c: centre.c + Math.sin(t) * r });
  }
  return out;
}

export function taxiMarkings(plan: AirportPlan): MarkQuad[] {
  const out: MarkQuad[] = [];
  const tw = plan.taxiway;
  const side = plan.holdLines[0]?.side ?? (tw.c >= 0 ? 1 : -1);
  const rwEdge = plan.rw.halfWidth;
  const W = MARKING.taxiLine;
  const Rc = plan.filletRadius + tw.halfWidth; // centreline turn radius

  // parallel taxiway centreline between the end connectors' turns
  const cons = [...plan.connectors].sort((x, y) => x.a - y.a);
  const first = cons[0];
  const last = cons[cons.length - 1];
  const startA = first && first.a - first.halfWidth <= tw.a0 + 1 ? first.a + Rc : tw.a0 + 2;
  const endA = last && last.a + last.halfWidth >= tw.a1 - 1 ? last.a - Rc : tw.a1 - 2;
  out.push(...line('taxi-centerline', 'yellow', [{ a: startA, c: tw.c }, { a: endA, c: tw.c }], W));

  for (const k of cons) {
    const atStart = k === first && k.a - k.halfWidth <= tw.a0 + 1;
    const atEnd = k === last && k.a + k.halfWidth >= tw.a1 - 1;
    const cStart = side * (rwEdge + 0.6); // stop just off the runway
    const cTurn = tw.c - side * Rc;
    if (atStart || atEnd) {
      const s = atStart ? 1 : -1; // direction the taxiway continues
      out.push(...line('taxi-centerline', 'yellow', [{ a: k.a, c: cStart }, { a: k.a, c: cTurn }], W));
      out.push(...line('taxi-centerline', 'yellow', arc({ a: k.a + s * Rc, c: cTurn }, { a: k.a, c: cTurn }, { a: k.a + s * Rc, c: tw.c }), W));
    } else {
      // T junction: straight across to the taxiway centreline and on to the first apron taxilane
      const lane = plan.taxilanes[0];
      const cEnd = lane && k.a > plan.apron.a0 && k.a < plan.apron.a1 ? lane.c : tw.c;
      out.push(...line('taxi-centerline', 'yellow', [{ a: k.a, c: cStart }, { a: k.a, c: cEnd }], W));
      for (const s of [-1, 1]) out.push(...line('taxi-centerline', 'yellow', arc({ a: k.a + s * Rc, c: cTurn }, { a: k.a, c: cTurn }, { a: k.a + s * Rc, c: tw.c }), W));
    }
  }

  // apron taxilanes
  for (const l of plan.taxilanes) out.push(...line('taxi-centerline', 'yellow', [{ a: l.a0, c: l.c }, { a: l.a1, c: l.c }], W));

  // hold-short: 2 dashed lines on the runway side, 2 solid on the taxiway side
  const hl = MARKING.holdLine;
  for (const h of plan.holdLines) {
    const base = h.c - h.side * (3.5 * hl); // runway-side edge of the 7-line-width group
    for (let i = 0; i < 4; i++) {
      const c0 = base + h.side * (2 * i * hl);
      const c1 = c0 + h.side * hl;
      const lo = Math.min(c0, c1);
      const hi = Math.max(c0, c1);
      if (i >= 2) out.push(rect('hold-short', 'yellow', h.a - h.halfWidth, h.a + h.halfWidth, lo, hi, { name: h.name, style: 'solid' }));
      else {
        const d = MARKING.holdDash;
        const nd = Math.floor((2 * h.halfWidth + d) / (2 * d));
        const span = nd * d + (nd - 1) * d;
        for (let j = 0; j < nd; j++) {
          const a0 = h.a - span / 2 + j * 2 * d;
          out.push(rect('hold-short', 'yellow', a0, a0 + d, lo, hi, { name: h.name, style: 'dashed' }));
        }
      }
    }
  }

  // tie-down "T" at every parking spot: wing bar + fuselage stem toward the tail
  for (const s of plan.layout.parkingSpots) {
    const a = s.x * plan.rw.dir.x + s.z * plan.rw.dir.z - (plan.rw.threshold.x * plan.rw.dir.x + plan.rw.threshold.z * plan.rw.dir.z);
    const c = (s.x - plan.rw.threshold.x) * plan.rw.right.x + (s.z - plan.rw.threshold.z) * plan.rw.right.z;
    const t = 0.15;
    out.push(rect('tiedown', 'white', a - 5.3, a + 5.3, c - t / 2, c + t / 2));
    const c0 = c + side * 0.4;
    const c1 = c + side * 6.5;
    out.push(rect('tiedown', 'white', a - t / 2, a + t / 2, Math.min(c0, c1), Math.max(c0, c1)));
  }

  // fuel pad outline
  {
    const f = plan.fuel;
    const a = (f.x - plan.rw.threshold.x) * plan.rw.dir.x + (f.z - plan.rw.threshold.z) * plan.rw.dir.z;
    const c = (f.x - plan.rw.threshold.x) * plan.rw.right.x + (f.z - plan.rw.threshold.z) * plan.rw.right.z;
    const ha = 7, hc = 5, t = 0.2;
    out.push(rect('fuel', 'yellow', a - ha, a + ha, c - hc, c - hc + t));
    out.push(rect('fuel', 'yellow', a - ha, a + ha, c + hc - t, c + hc));
    out.push(rect('fuel', 'yellow', a - ha, a - ha + t, c - hc + t, c + hc - t));
    out.push(rect('fuel', 'yellow', a + ha - t, a + ha, c - hc + t, c + hc - t));
  }

  // car park stall lines
  const seen = new Set<string>();
  const sw = plan.stalls.length > 1 ? Math.abs(plan.stalls[1].a - plan.stalls[0].a) : 2.7;
  for (const st of plan.stalls) {
    for (const edge of [st.a - sw / 2, st.a + sw / 2]) {
      const key = `${edge.toFixed(2)}|${st.c0.toFixed(2)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(rect('carpark', 'white', edge - 0.06, edge + 0.06, st.c0 + 0.2, st.c1 - 0.2));
    }
  }
  return out;
}
