/**
 * A geometry-tracking CanvasRenderingContext2D stand-in for the gauge tests: it applies
 * translate/rotate/scale/setTransform/save/restore like a real canvas and records every stroked
 * segment, filled polygon, arc, text and drawImage in DEVICE coordinates (y down, like the
 * screen). Tests then ask physical questions — "does the horizon's right end rise?", "where does
 * the needle tip point?" — instead of checking which API calls were made.
 *
 * `installOffscreenStub()` makes the gauges' static-face cache work in node (faces go into a
 * throw-away context and come back as one drawImage), so only the moving parts are recorded.
 */
type M = [number, number, number, number, number, number];

export interface Pt {
  x: number;
  y: number;
}
export interface Segment {
  a: Pt;
  b: Pt;
  style: string;
  width: number;
}
export interface Fill {
  pts: Pt[];
  style: string;
}
export interface Arc {
  c: Pt;
  r: number;
  style: string;
}
export interface Text {
  s: string;
  p: Pt;
  style: string;
}
export interface Image {
  /** Where the image's local point (u, v) (in its destination rect units) lands on the device. */
  map(u: number, v: number): Pt;
  x: number;
  y: number;
  w: number;
  h: number;
  m: M;
}

export interface GeoCtx {
  ctx: CanvasRenderingContext2D;
  segments: Segment[];
  fills: Fill[];
  arcs: Arc[];
  texts: Text[];
  images: Image[];
  /** Every number that went through a drawing call (for finiteness checks). */
  numbers: number[];
  reset(): void;
}

const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];
const apply = (m: M, x: number, y: number): Pt => ({ x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] });

export function geoCtx(): GeoCtx {
  let m: M = [1, 0, 0, 1, 0, 0];
  const stack: { m: M; fill: unknown; stroke: unknown; lw: number }[] = [];
  let subpaths: Pt[][] = [];
  /** After closePath the next lineTo starts a new subpath at the closing point (canvas semantics). */
  let closedAt: Pt | null = null;
  const out: Omit<GeoCtx, 'ctx' | 'reset'> = { segments: [], fills: [], arcs: [], texts: [], images: [], numbers: [] };
  const props: Record<string, unknown> = {
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, font: '10px sans-serif', textAlign: 'start', textBaseline: 'alphabetic',
    globalAlpha: 1, lineCap: 'butt', lineJoin: 'miter', canvas: { width: 1000, height: 1000 },
  };
  const style = (v: unknown) => (typeof v === 'string' ? v : 'gradient');
  const num = (...a: unknown[]) => {
    for (const v of a) if (typeof v === 'number') out.numbers.push(v);
  };
  let pendingArcs: { c: Pt; r: number }[] = [];
  const api: Record<string, (...a: never[]) => unknown> = {
    save: () => stack.push({ m: [...m] as M, fill: props.fillStyle, stroke: props.strokeStyle, lw: props.lineWidth as number }),
    restore: () => {
      const s = stack.pop();
      if (s) {
        m = s.m;
        props.fillStyle = s.fill;
        props.strokeStyle = s.stroke;
        props.lineWidth = s.lw;
      }
    },
    translate: (x: number, y: number) => {
      num(x, y);
      m = mul(m, [1, 0, 0, 1, x, y]);
    },
    rotate: (a: number) => {
      num(a);
      m = mul(m, [Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]);
    },
    scale: (x: number, y: number) => {
      num(x, y);
      m = mul(m, [x, 0, 0, y, 0, 0]);
    },
    setTransform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
      num(a, b, c, d, e, f);
      m = [a, b, c, d, e, f];
    },
    transform: (a: number, b: number, c: number, d: number, e: number, f: number) => {
      num(a, b, c, d, e, f);
      m = mul(m, [a, b, c, d, e, f]);
    },
    resetTransform: () => {
      m = [1, 0, 0, 1, 0, 0];
    },
    getTransform: () => ({ a: m[0], b: m[1], c: m[2], d: m[3], e: m[4], f: m[5] }),
    beginPath: () => {
      subpaths = [];
      pendingArcs = [];
      closedAt = null;
    },
    moveTo: (x: number, y: number) => {
      num(x, y);
      closedAt = null;
      subpaths.push([apply(m, x, y)]);
    },
    lineTo: (x: number, y: number) => {
      num(x, y);
      if (closedAt) subpaths.push([closedAt]);
      closedAt = null;
      if (!subpaths.length) subpaths.push([]);
      subpaths[subpaths.length - 1].push(apply(m, x, y));
    },
    closePath: () => {
      const s = subpaths[subpaths.length - 1];
      if (s && s.length) {
        s.push(s[0]);
        closedAt = s[0];
      }
    },
    rect: (x: number, y: number, w: number, h: number) => {
      num(x, y, w, h);
      subpaths.push([apply(m, x, y), apply(m, x + w, y), apply(m, x + w, y + h), apply(m, x, y + h), apply(m, x, y)]);
    },
    arc: (x: number, y: number, r: number, a0: number, a1: number) => {
      num(x, y, r, a0, a1);
      const c = apply(m, x, y);
      const scale = Math.hypot(m[0], m[1]);
      pendingArcs.push({ c, r: r * scale });
      subpaths.push([apply(m, x + r * Math.cos(a0), y + r * Math.sin(a0)), apply(m, x + r * Math.cos(a1), y + r * Math.sin(a1))]);
    },
    ellipse: (x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number) => {
      num(x, y, rx, ry, rot, a0, a1);
      pendingArcs.push({ c: apply(m, x, y), r: Math.max(rx, ry) * Math.hypot(m[0], m[1]) });
    },
    arcTo: (x1: number, y1: number, x2: number, y2: number, r: number) => {
      num(x1, y1, x2, y2, r);
      if (!subpaths.length) subpaths.push([]);
      subpaths[subpaths.length - 1].push(apply(m, x1, y1));
    },
    quadraticCurveTo: (cx: number, cy: number, x: number, y: number) => {
      num(cx, cy, x, y);
      if (!subpaths.length) subpaths.push([]);
      subpaths[subpaths.length - 1].push(apply(m, x, y));
    },
    bezierCurveTo: (a: number, b: number, c: number, d: number, x: number, y: number) => {
      num(a, b, c, d, x, y);
      if (!subpaths.length) subpaths.push([]);
      subpaths[subpaths.length - 1].push(apply(m, x, y));
    },
    stroke: () => {
      const st = style(props.strokeStyle);
      const lw = (props.lineWidth as number) * Math.hypot(m[0], m[1]);
      for (const s of subpaths) for (let i = 1; i < s.length; i++) out.segments.push({ a: s[i - 1], b: s[i], style: st, width: lw });
    },
    fill: () => {
      const st = style(props.fillStyle);
      for (const s of subpaths) if (s.length >= 2) out.fills.push({ pts: s, style: st });
      for (const a of pendingArcs) out.arcs.push({ ...a, style: st });
    },
    clip: () => undefined,
    fillRect: (x: number, y: number, w: number, h: number) => {
      num(x, y, w, h);
      out.fills.push({ pts: [apply(m, x, y), apply(m, x + w, y), apply(m, x + w, y + h), apply(m, x, y + h)], style: style(props.fillStyle) });
    },
    strokeRect: (x: number, y: number, w: number, h: number) => num(x, y, w, h),
    clearRect: (x: number, y: number, w: number, h: number) => num(x, y, w, h),
    fillText: (s: string, x: number, y: number) => {
      num(x, y);
      out.texts.push({ s: String(s), p: apply(m, x, y), style: style(props.fillStyle) });
    },
    strokeText: (_s: string, x: number, y: number) => num(x, y),
    measureText: (s: string) => ({ width: String(s).length * 6, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 }),
    drawImage: (_img: unknown, x: number, y: number, w: number, h: number) => {
      num(x, y, w, h);
      const mm = [...m] as M;
      out.images.push({ x, y, w, h, m: mm, map: (u, v) => apply(mm, x + u, y + v) });
    },
    createLinearGradient: (...a: number[]) => {
      num(...a);
      return { addColorStop: () => undefined };
    },
    createRadialGradient: (...a: number[]) => {
      num(...a);
      return { addColorStop: () => undefined };
    },
    createConicGradient: () => ({ addColorStop: () => undefined }),
    createPattern: () => ({}),
    setLineDash: () => undefined,
    getLineDash: () => [],
  };
  const ctx = new Proxy(props, {
    get(target, key: string) {
      if (key in api) return api[key];
      if (key in target) return target[key];
      return () => undefined;
    },
    set(target, key: string, value) {
      if (typeof value === 'number') out.numbers.push(value);
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  return {
    ctx,
    ...out,
    reset() {
      out.segments.length = 0;
      out.fills.length = 0;
      out.arcs.length = 0;
      out.texts.length = 0;
      out.images.length = 0;
      out.numbers.length = 0;
      m = [1, 0, 0, 1, 0, 0];
      stack.length = 0;
    },
  };
}

/** A context that accepts everything and draws nothing (what the stubbed OffscreenCanvas hands out). */
function nullCtx(): CanvasRenderingContext2D {
  const grad = { addColorStop: () => undefined };
  return new Proxy({} as Record<string, unknown>, {
    get(t, k: string) {
      if (k in t) return t[k];
      if (k === 'measureText') return (s: string) => ({ width: String(s).length * 6 });
      if (k === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
      if (k.startsWith('create')) return () => grad;
      return () => undefined;
    },
    set(t, k: string, v) {
      t[k] = v;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
}

/** Give node an OffscreenCanvas so the gauge face cache blits faces with drawImage. Returns an uninstall function. */
export function installOffscreenStub(): () => void {
  const g = globalThis as unknown as { OffscreenCanvas?: unknown };
  const prev = g.OffscreenCanvas;
  g.OffscreenCanvas = class {
    width: number;
    height: number;
    constructor(w: number, h: number) {
      this.width = w;
      this.height = h;
    }
    getContext() {
      return nullCtx();
    }
  };
  return () => {
    g.OffscreenCanvas = prev;
  };
}

// ─── Geometry helpers for assertions ─────────────────────────────────────────

export const len = (s: Segment) => Math.hypot(s.b.x - s.a.x, s.b.y - s.a.y);

/** The longest stroked segment (the attitude indicator's horizon line is far longer than anything else). */
export function longest(segs: Segment[]): Segment {
  return segs.reduce((best, s) => (len(s) > len(best) ? s : best), segs[0]);
}

/**
 * Screen tilt of a line in degrees, positive = counter-clockwise on screen (its right end higher),
 * independent of the order the ends were drawn in.
 */
export function screenTiltDeg(s: Segment): number {
  const [l, r] = s.a.x <= s.b.x ? [s.a, s.b] : [s.b, s.a];
  return (Math.atan2(l.y - r.y, r.x - l.x) * 180) / Math.PI;
}

/**
 * Signed distance (px) of point p from the line through s, positive when p lies on the "upper"
 * side of the line as drawn on screen (smaller y after levelling the line).
 */
export function aboveLine(s: Segment, p: Pt): number {
  const [l, r] = s.a.x <= s.b.x ? [s.a, s.b] : [s.b, s.a];
  const dx = r.x - l.x;
  const dy = r.y - l.y;
  const L = Math.hypot(dx, dy) || 1;
  // Normal pointing "up" on screen for a left-to-right line: (dy, -dx)/L.
  return ((p.x - l.x) * dy - (p.y - l.y) * dx) / L;
}

/** Clockwise-from-12-o'clock angle (deg, -180..180) of p around centre c. */
export function dialAngle(c: Pt, p: Pt): number {
  return (Math.atan2(p.x - c.x, c.y - p.y) * 180) / Math.PI;
}

/** The polygon point farthest from c (a needle's tip). */
export function tipOf(f: Fill, c: Pt): Pt {
  return f.pts.reduce((best, p) => (Math.hypot(p.x - c.x, p.y - c.y) > Math.hypot(best.x - c.x, best.y - c.y) ? p : best), f.pts[0]);
}

export const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
