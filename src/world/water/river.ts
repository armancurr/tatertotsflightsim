/**
 * The river as one continuous water ribbon (PURE geometry builder).
 *
 * One section per centreline point (~40 m apart), two vertices per section on
 * the sloping water surface, half-width = water half-width + margin (the carved
 * banks hide the margin close up; the shader fades the edge at the true width
 * far away). Per-vertex data drives the shader:
 *   across  unit vector centre → vertex (the vertex shader widens hairline
 *           rivers to a minimum pixel width along it, so the river is never dashed)
 *   attrs   [halfWidth, depth, flow, foam, s, fade, speed, side] (RIVER_STRIDE)
 *     flow  ∫ v_ref / v(s) ds — the flow-advection coordinate: a pattern
 *           sampled at (flow − v_ref·t) moves downstream at the local speed v(s)
 *     foam  rapids foam 0..1 from the smoothed water-surface slope
 *     fade  1 upstream → 0 past the coast (the river blends into the sea)
 */
import type { Bridge, River, XZ } from '../layout';

export const RIVER_STRIDE = 8;

export interface RiverRibbonOptions {
  seaLevel: number;
  coastZAt(x: number): number;
  /** Flow speed in the plains / steep reaches (m/s) and the slope where rapids begin. */
  speed: number;
  speedSteep: number;
  rapidsSlope: number;
  /** Extra half-width beyond the water's edge (m). */
  margin: number;
}

export interface RiverRibbon {
  sections: number;
  /** Vertex positions (x, water level, z); vertex 2i = left, 2i+1 = right of section i. */
  position: Float32Array;
  /** Unit (x, z) vector from the centreline to the vertex. */
  across: Float32Array;
  attrs: Float32Array;
  index: Uint32Array;
  /** Total length of the ribbon along the channel (m). */
  length: number;
}

const smoothstep = (a: number, b: number, x: number) => {
  let t = (x - a) / (b - a);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};

export function buildRiverRibbon(rv: River, o: RiverRibbonOptions): RiverRibbon {
  const P = rv.points;
  const N = P.length;
  // arc length and the coast crossing
  const S = new Float64Array(N);
  for (let i = 1; i < N; i++) S[i] = S[i - 1] + Math.hypot(P[i].x - P[i - 1].x, P[i].z - P[i - 1].z);
  let sCoast = Infinity;
  for (let i = 0; i < N; i++)
    if (P[i].z > o.coastZAt(P[i].x)) {
      sCoast = S[i];
      break;
    }
  const fadeAt = (s: number) => (Number.isFinite(sCoast) ? 1 - smoothstep(sCoast - 250, sCoast + 200, s) : 1);
  let n = N;
  for (let i = 0; i < N; i++)
    if (fadeAt(S[i]) <= 0) {
      n = i + 1;
      break;
    }
  n = Math.max(2, Math.min(N, n));

  const position = new Float32Array(n * 2 * 3);
  const across = new Float32Array(n * 2 * 2);
  const attrs = new Float32Array(n * 2 * RIVER_STRIDE);
  const index = new Uint32Array((n - 1) * 6);
  const vRef = o.speed;
  let flow = 0;
  let prevSpeed = o.speed;
  for (let i = 0; i < n; i++) {
    // tangent smoothed over a window that grows with the width (no folds on the inside of tight bends)
    const hw = rv.halfWidths[i];
    const w = hw + o.margin;
    const kT = Math.max(1, Math.round(w / 15));
    const a = P[Math.max(0, i - kT)];
    const b = P[Math.min(N - 1, i + kT)];
    let tx = b.x - a.x;
    let tz = b.z - a.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl;
    tz /= tl;
    // water-surface slope, smoothed over ±2 sections
    const i0 = Math.max(0, i - 2);
    const i1 = Math.min(N - 1, i + 2);
    const ds = S[i1] - S[i0];
    const slope = ds > 0 ? Math.max(0, (rv.levels[i0] - rv.levels[i1]) / ds) : 0;
    const speed = o.speed + (o.speedSteep - o.speed) * smoothstep(o.rapidsSlope * 0.1, o.rapidsSlope * 8, slope);
    const foam = smoothstep(o.rapidsSlope, o.rapidsSlope * 8, slope);
    if (i > 0) flow += ((S[i] - S[i - 1]) * vRef * 2) / (speed + prevSpeed);
    prevSpeed = speed;
    const nx = -tz;
    const nz = tx;
    const y = rv.levels[i];
    const fade = fadeAt(S[i]);
    for (let side = 0; side < 2; side++) {
      const sg = side === 0 ? -1 : 1;
      const v = i * 2 + side;
      position[v * 3] = P[i].x + nx * w * sg;
      position[v * 3 + 1] = y;
      position[v * 3 + 2] = P[i].z + nz * w * sg;
      across[v * 2] = nx * sg;
      across[v * 2 + 1] = nz * sg;
      const q = v * RIVER_STRIDE;
      attrs[q] = hw;
      attrs[q + 1] = rv.depths[i];
      attrs[q + 2] = flow;
      attrs[q + 3] = foam;
      attrs[q + 4] = S[i];
      attrs[q + 5] = fade;
      attrs[q + 6] = speed;
      attrs[q + 7] = sg;
    }
    if (i > 0) {
      const k = (i - 1) * 6;
      const A = (i - 1) * 2;
      // (a, b, c), (b, d, c) are counter-clockwise seen from above for n = (−tz, tx)
      index[k] = A;
      index[k + 1] = A + 1;
      index[k + 2] = A + 2;
      index[k + 3] = A + 1;
      index[k + 4] = A + 3;
      index[k + 5] = A + 2;
    }
  }
  return { sections: n, position, across, attrs, index, length: S[n - 1] };
}

/**
 * Where a bridge's piers stand in the river: two piers on the bridge axis,
 * ±0.45 of the water half-width from the crossing (three spans).
 */
export function riverPiers(b: Bridge, halfWidth: number): XZ[] {
  const h = (b.headingDeg * Math.PI) / 180;
  const dx = Math.sin(h);
  const dz = -Math.cos(h);
  const o = 0.45 * halfWidth;
  return [
    { x: b.x - dx * o, z: b.z - dz * o },
    { x: b.x + dx * o, z: b.z + dz * o },
  ];
}
