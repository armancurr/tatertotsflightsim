/**
 * Uniform-grid spatial index over polylines (rivers, roads) for fast
 * "distance to the nearest line + interpolated per-vertex values" queries.
 * PURE; no allocation per query.
 *
 * Values are soft-weighted over every segment within reach
 * (weight = exp(−(d − dmin) / softness)), so where two branches are nearly
 * equidistant (inside a bend, at a junction) the result blends smoothly instead
 * of jumping — the heightfield stays continuous.
 */
export interface XZ {
  x: number;
  z: number;
}

export interface PolyQuery {
  /** Distance to the nearest segment, m. */
  d: number;
  /** Soft-weighted interpolated per-vertex values. */
  v: Float64Array;
  /** Index of the nearest segment and the parameter (0..1) along it. */
  seg: number;
  t: number;
  /** Line index of the nearest segment. */
  line: number;
}

export function newPolyQuery(k: number): PolyQuery {
  return { d: Infinity, v: new Float64Array(k), seg: -1, t: 0, line: -1 };
}

export class PolylineIndex {
  readonly k: number;
  readonly radius: number;
  readonly segCount: number;
  private readonly ax: Float64Array;
  private readonly az: Float64Array;
  private readonly vx: Float64Array;
  private readonly vz: Float64Array;
  private readonly invLen2: Float64Array;
  private readonly valA: Float64Array;
  private readonly valB: Float64Array;
  private readonly segLine: Int32Array;
  private readonly minX: number;
  private readonly minZ: number;
  private readonly nx: number;
  private readonly nz: number;
  private readonly cell: number;
  private readonly cellStart: Int32Array;
  private readonly items: Int32Array;
  private readonly softness: number;
  private readonly scratchD: Float64Array;
  private readonly scratchS: Int32Array;
  private readonly scratchT: Float64Array;

  /**
   * @param lines polylines (≥ 2 points each)
   * @param values per line, per vertex, `k` values to interpolate
   * @param radius queries farther than this from every line return false
   * @param cellSize grid cell size, m
   * @param softness value blending distance, m
   */
  constructor(lines: XZ[][], values: number[][][], k: number, radius: number, cellSize: number, softness = 20) {
    this.k = k;
    this.radius = radius;
    this.cell = cellSize;
    this.softness = softness;
    let n = 0;
    for (const l of lines) n += Math.max(0, l.length - 1);
    this.segCount = n;
    this.ax = new Float64Array(n);
    this.az = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vz = new Float64Array(n);
    this.invLen2 = new Float64Array(n);
    this.valA = new Float64Array(n * k);
    this.valB = new Float64Array(n * k);
    this.segLine = new Int32Array(n);
    let minX = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxZ = -Infinity;
    let s = 0;
    lines.forEach((pts, li) => {
      for (let i = 1; i < pts.length; i++, s++) {
        const a = pts[i - 1];
        const b = pts[i];
        this.ax[s] = a.x;
        this.az[s] = a.z;
        this.vx[s] = b.x - a.x;
        this.vz[s] = b.z - a.z;
        const l2 = this.vx[s] * this.vx[s] + this.vz[s] * this.vz[s];
        this.invLen2[s] = l2 > 1e-12 ? 1 / l2 : 0;
        for (let j = 0; j < k; j++) {
          this.valA[s * k + j] = values[li][i - 1][j];
          this.valB[s * k + j] = values[li][i][j];
        }
        this.segLine[s] = li;
        minX = Math.min(minX, a.x, b.x);
        minZ = Math.min(minZ, a.z, b.z);
        maxX = Math.max(maxX, a.x, b.x);
        maxZ = Math.max(maxZ, a.z, b.z);
      }
    });
    if (n === 0) {
      minX = minZ = 0;
      maxX = maxZ = 0;
    }
    this.minX = minX - radius - cellSize;
    this.minZ = minZ - radius - cellSize;
    this.nx = Math.max(1, Math.ceil((maxX + radius + cellSize - this.minX) / cellSize));
    this.nz = Math.max(1, Math.ceil((maxZ + radius + cellSize - this.minZ) / cellSize));
    // Bin segments (conservatively: segment bbox expanded by the radius).
    const counts = new Int32Array(this.nx * this.nz + 1);
    const forCells = (seg: number, fn: (c: number) => void) => {
      const x0 = Math.min(this.ax[seg], this.ax[seg] + this.vx[seg]) - radius;
      const x1 = Math.max(this.ax[seg], this.ax[seg] + this.vx[seg]) + radius;
      const z0 = Math.min(this.az[seg], this.az[seg] + this.vz[seg]) - radius;
      const z1 = Math.max(this.az[seg], this.az[seg] + this.vz[seg]) + radius;
      const i0 = Math.max(0, Math.floor((x0 - this.minX) / cellSize));
      const i1 = Math.min(this.nx - 1, Math.floor((x1 - this.minX) / cellSize));
      const j0 = Math.max(0, Math.floor((z0 - this.minZ) / cellSize));
      const j1 = Math.min(this.nz - 1, Math.floor((z1 - this.minZ) / cellSize));
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) fn(j * this.nx + i);
    };
    for (let seg = 0; seg < n; seg++) forCells(seg, (c) => counts[c + 1]++);
    for (let c = 0; c < this.nx * this.nz; c++) counts[c + 1] += counts[c];
    this.cellStart = counts;
    this.items = new Int32Array(counts[this.nx * this.nz]);
    const fill = counts.slice(0, this.nx * this.nz);
    for (let seg = 0; seg < n; seg++) forCells(seg, (c) => (this.items[fill[c]++] = seg));
    let maxPerCell = 1;
    for (let c = 0; c < this.nx * this.nz; c++) maxPerCell = Math.max(maxPerCell, counts[c + 1] - counts[c]);
    this.scratchD = new Float64Array(maxPerCell);
    this.scratchS = new Int32Array(maxPerCell);
    this.scratchT = new Float64Array(maxPerCell);
  }

  /** True if (x, z) is within `radius` of a line; fills `out`. */
  query(x: number, z: number, out: PolyQuery): boolean {
    const ci = Math.floor((x - this.minX) / this.cell);
    const cj = Math.floor((z - this.minZ) / this.cell);
    if (ci < 0 || cj < 0 || ci >= this.nx || cj >= this.nz) return false;
    const c = cj * this.nx + ci;
    const s0 = this.cellStart[c];
    const s1 = this.cellStart[c + 1];
    if (s0 === s1) return false;
    const r2 = this.radius * this.radius;
    const ax = this.ax;
    const az = this.az;
    const vx = this.vx;
    const vz = this.vz;
    const il = this.invLen2;
    let m = 0;
    let best = r2;
    let bestI = -1;
    for (let p = s0; p < s1; p++) {
      const s = this.items[p];
      const dx = x - ax[s];
      const dz = z - az[s];
      let t = (dx * vx[s] + dz * vz[s]) * il[s];
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = dx - vx[s] * t;
      const ez = dz - vz[s] * t;
      const d2 = ex * ex + ez * ez;
      if (d2 < r2) {
        this.scratchD[m] = d2;
        this.scratchS[m] = s;
        this.scratchT[m] = t;
        if (d2 < best) {
          best = d2;
          bestI = m;
        }
        m++;
      }
    }
    if (bestI < 0) return false;
    const dmin = Math.sqrt(best);
    const k = this.k;
    const v = out.v;
    for (let j = 0; j < k; j++) v[j] = 0;
    let wsum = 0;
    const inv = 1 / this.softness;
    for (let q = 0; q < m; q++) {
      const d = q === bestI ? dmin : Math.sqrt(this.scratchD[q]);
      const w = Math.exp(-(d - dmin) * inv);
      if (w < 1e-4) continue;
      const s = this.scratchS[q];
      const t = this.scratchT[q];
      for (let j = 0; j < k; j++) {
        const a = this.valA[s * k + j];
        v[j] += w * (a + (this.valB[s * k + j] - a) * t);
      }
      wsum += w;
    }
    for (let j = 0; j < k; j++) v[j] /= wsum;
    out.d = dmin;
    out.seg = this.scratchS[bestI];
    out.t = this.scratchT[bestI];
    out.line = this.segLine[out.seg];
    return true;
  }
}
