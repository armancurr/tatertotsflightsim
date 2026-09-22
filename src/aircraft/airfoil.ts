/**
 * NACA 4-digit airfoil sections as 2D rings (x along the chord 0..1, y up),
 * ready to be placed in 3D by the wing/tail/propeller builders.
 *
 * Ring order is always: upper surface from the leading edge toward the trailing
 * edge, then the lower surface back toward the leading edge. The trailing edge
 * point is repeated (a crease for the loft generator); the leading edge is smooth.
 */

/** Half-thickness of a NACA 00xx section at chord station x (closed trailing edge). */
export function nacaThickness(t: number, x: number): number {
  const xx = Math.max(0, Math.min(1, x));
  return 5 * t * (0.2969 * Math.sqrt(xx) - 0.126 * xx - 0.3516 * xx * xx + 0.2843 * xx * xx * xx - 0.1036 * xx * xx * xx * xx);
}

/** Mean camber line height of a NACA mpxx section. */
export function nacaCamber(m: number, p: number, x: number): number {
  if (m === 0 || p === 0) return 0;
  return x < p ? (m / (p * p)) * (2 * p * x - x * x) : (m / ((1 - p) * (1 - p))) * (1 - 2 * p + 2 * p * x - x * x);
}

export interface NacaRingOptions {
  /** Max camber (fraction of chord), e.g. 0.02 for a 2412. */
  m: number;
  /** Position of max camber (fraction of chord), e.g. 0.4. */
  p: number;
  /** Max thickness (fraction of chord). */
  t: number;
  /** Points per surface. */
  n: number;
  /** Keep only the part forward of this chord station, closed flat at the cut (the wing box ahead of a hinge). */
  to?: number;
  /** Keep only the part aft of this chord station, with a rounded nose at the cut (a control surface). */
  from?: number;
  /** Points on the rounded nose of a `from` section (default 5). */
  nosePoints?: number;
  /** Scale the thickness (not the camber) — used to thin wingtips and blade tips. */
  thicknessScale?: number;
}

/** Flat [x0,y0, x1,y1, …] ring. */
export function nacaRing(o: NacaRingOptions): number[] {
  const { m, p, t, n } = o;
  const ts = o.thicknessScale ?? 1;
  const a = o.from ?? 0;
  const b = o.to ?? 1;
  // Cosine spacing: full sections and control surfaces are dense at both ends,
  // front parts (cut at a hinge) are dense at the leading edge only.
  const xs: number[] = [];
  for (let k = 0; k < n; k++) {
    const s = k / (n - 1);
    const f = a === 0 && b < 1 ? 1 - Math.cos((s * Math.PI) / 2) : 0.5 - 0.5 * Math.cos(s * Math.PI);
    xs.push(a + (b - a) * f);
  }
  const up = (x: number) => nacaCamber(m, p, x) + nacaThickness(t, x) * ts;
  const lo = (x: number) => nacaCamber(m, p, x) - nacaThickness(t, x) * ts;
  const out: number[] = [];

  if (a === 0 && b === 1) {
    for (let k = 0; k < n; k++) out.push(xs[k], up(xs[k]));
    // TE repeated (crease), then the lower surface back to just aft of the LE.
    for (let k = n - 1; k >= 1; k--) out.push(xs[k], lo(xs[k]));
    return out;
  }

  if (a === 0) {
    // Front part, cut flat at x = b (hinge wall with creased corners).
    for (let k = 0; k < n; k++) out.push(xs[k], up(xs[k]));
    out.push(b, up(b));
    out.push(b, lo(b));
    for (let k = n - 1; k >= 1; k--) out.push(xs[k], lo(xs[k]));
    return out;
  }

  // Rear part (control surface): upper hinge → TE, TE repeated, lower back to the hinge, round nose.
  for (let k = 0; k < n; k++) out.push(xs[k], up(xs[k]));
  for (let k = n - 1; k >= 0; k--) out.push(xs[k], lo(xs[k]));
  const yc = nacaCamber(m, p, a);
  const r = Math.max(1e-4, nacaThickness(t, a) * ts);
  const np = o.nosePoints ?? 5;
  for (let k = 1; k <= np; k++) {
    // From the lower hinge point (−90°) round the front (−180°) to the upper hinge point (−270°).
    const phi = -Math.PI / 2 - (Math.PI * k) / (np + 1);
    out.push(a + r * Math.cos(phi) * 0.9, yc + r * Math.sin(phi));
  }
  return out;
}

/** Symmetric-section shorthand (tail surfaces, struts). */
export function symmetricRing(t: number, n: number, extra: Partial<NacaRingOptions> = {}): number[] {
  return nacaRing({ m: 0, p: 0, t, n, ...extra });
}
