/**
 * Loft generator: a sequence of cross-section rings → one smooth indexed
 * BufferGeometry with normals and UVs.
 *
 *  - Every ring has the same number of points, flat [x0,y0,z0, x1,y1,z1, …].
 *  - Closed rings (default) get a duplicated seam vertex so U runs 0..1 cleanly.
 *  - Normals come from central differences across the grid, so the surface is
 *    smooth; a point repeated in a ring (or a ring repeated) makes a crease.
 *  - Orientation is automatic: whichever way the rings wind, front faces and
 *    normals end up on the outside (away from each ring's centroid).
 *  - Optional flat caps close the first/last ring (fan from the centroid).
 */
import * as THREE from 'three';

export interface LoftOptions {
  /** Rings are closed loops (default true). Open strips are lofted edge to edge. */
  closed?: boolean;
  capStart?: boolean;
  capEnd?: boolean;
  /** V coordinate of each ring; default = cumulative centroid distance normalised to 0..1. */
  v?: ArrayLike<number>;
  /** U coordinate of each ring point (length N+1 for closed rings incl. seam, N for open); default j/N. */
  u?: ArrayLike<number>;
  /** 'auto' (default) turns the surface outward; 'keep' uses the natural winding; 'flip' reverses it. */
  orient?: 'auto' | 'keep' | 'flip';
}

const EPS2 = 1e-14;

export function loftGeometry(rings: ArrayLike<number>[], opts: LoftOptions = {}): THREE.BufferGeometry {
  const closed = opts.closed !== false;
  const M = rings.length;
  if (M < 2) throw new Error('loftGeometry needs at least two rings');
  const N = rings[0].length / 3;
  for (const r of rings) if (r.length !== N * 3) throw new Error('loftGeometry: rings differ in point count');
  const cols = closed ? N + 1 : N;
  const quadsU = closed ? N : N - 1;

  // Grid positions (with seam column for closed rings).
  const P = new Float32Array(M * cols * 3);
  for (let i = 0; i < M; i++) {
    const r = rings[i];
    for (let j = 0; j < cols; j++) {
      const s = (j % N) * 3;
      const d = (i * cols + j) * 3;
      P[d] = r[s];
      P[d + 1] = r[s + 1];
      P[d + 2] = r[s + 2];
    }
  }

  // Ring centroids (for orientation and default V).
  const C = new Float64Array(M * 3);
  for (let i = 0; i < M; i++) {
    const r = rings[i];
    let x = 0, y = 0, z = 0;
    for (let j = 0; j < N; j++) {
      x += r[j * 3];
      y += r[j * 3 + 1];
      z += r[j * 3 + 2];
    }
    C[i * 3] = x / N;
    C[i * 3 + 1] = y / N;
    C[i * 3 + 2] = z / N;
  }

  const ringPt = (i: number, j: number, out: number[]) => {
    const r = rings[i];
    const jj = closed ? ((j % N) + N) % N : j;
    out[0] = r[jj * 3];
    out[1] = r[jj * 3 + 1];
    out[2] = r[jj * 3 + 2];
  };
  const same = (a: number[], b: number[]) => {
    const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2];
    return dx * dx + dy * dy + dz * dz < EPS2;
  };

  // Normals: du × dv with creases at repeated points / rings.
  const Nrm = new Float32Array(M * cols * 3);
  const degenerate: number[] = [];
  const p0 = [0, 0, 0], pa = [0, 0, 0], pb = [0, 0, 0];
  const du = [0, 0, 0], dv = [0, 0, 0];
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < cols; j++) {
      const jc = closed ? j % N : j;
      ringPt(i, jc, p0);
      // U derivative
      let hasPrev = closed || jc > 0;
      let hasNext = closed || jc < N - 1;
      if (hasPrev) ringPt(i, jc - 1, pa);
      if (hasNext) ringPt(i, jc + 1, pb);
      if (hasPrev && same(pa, p0)) hasPrev = false;
      if (hasNext && same(pb, p0)) hasNext = false;
      diff(hasPrev ? pa : p0, hasNext ? pb : p0, du);
      // If the point is doubled on both sides (degenerate), look one further out.
      if (!hasPrev && !hasNext) {
        if (closed || jc < N - 2) ringPt(i, jc + 2, pb);
        diff(p0, pb, du);
      }
      // V derivative
      let vPrev = i > 0;
      let vNext = i < M - 1;
      if (vPrev) ringPt(i - 1, jc, pa);
      if (vNext) ringPt(i + 1, jc, pb);
      if (vPrev && same(pa, p0)) vPrev = false;
      if (vNext && same(pb, p0)) vNext = false;
      diff(vPrev ? pa : p0, vNext ? pb : p0, dv);
      if (!vPrev && !vNext) {
        // Doubled ring: fall back to the centroid direction.
        dv[0] = C[Math.min(M - 1, i + 1) * 3] - C[Math.max(0, i - 1) * 3];
        dv[1] = C[Math.min(M - 1, i + 1) * 3 + 1] - C[Math.max(0, i - 1) * 3 + 1];
        dv[2] = C[Math.min(M - 1, i + 1) * 3 + 2] - C[Math.max(0, i - 1) * 3 + 2];
      }
      let nx = du[1] * dv[2] - du[2] * dv[1];
      let ny = du[2] * dv[0] - du[0] * dv[2];
      let nz = du[0] * dv[1] - du[1] * dv[0];
      let len = Math.hypot(nx, ny, nz);
      if (len < 1e-12) {
        // Collapsed ring (a tip): resolved after orientation (points along the loft axis, away from the body).
        degenerate.push(i * cols + j);
        nx = 0; ny = 1; nz = 0; len = 1;
      }
      const d = (i * cols + j) * 3;
      Nrm[d] = nx / len;
      Nrm[d + 1] = ny / len;
      Nrm[d + 2] = nz / len;
    }
  }

  // Orientation: natural winding has face normal = du × dv (see indices below).
  let flip = opts.orient === 'flip';
  if (!opts.orient || opts.orient === 'auto') {
    let s = 0;
    for (let i = 0; i < M; i++) {
      for (let j = 0; j < cols; j++) {
        const d = (i * cols + j) * 3;
        s +=
          Nrm[d] * (P[d] - C[i * 3]) +
          Nrm[d + 1] * (P[d + 1] - C[i * 3 + 1]) +
          Nrm[d + 2] * (P[d + 2] - C[i * 3 + 2]);
      }
    }
    flip = s < 0;
  }
  if (flip) for (let k = 0; k < Nrm.length; k++) Nrm[k] = -Nrm[k];
  for (const vi of degenerate) {
    const i = Math.floor(vi / cols);
    const sgn = i === 0 ? -1 : 1;
    const ai = Math.min(M - 1, i + 1), bi = Math.max(0, i - 1);
    let ax = sgn * (C[ai * 3] - C[bi * 3]);
    let ay = sgn * (C[ai * 3 + 1] - C[bi * 3 + 1]);
    let az = sgn * (C[ai * 3 + 2] - C[bi * 3 + 2]);
    const l = Math.hypot(ax, ay, az) || 1;
    Nrm[vi * 3] = ax / l;
    Nrm[vi * 3 + 1] = ay / l;
    Nrm[vi * 3 + 2] = az / l;
  }

  // UVs
  const V = new Float32Array(M);
  if (opts.v) {
    for (let i = 0; i < M; i++) V[i] = opts.v[i];
  } else {
    let acc = 0;
    V[0] = 0;
    for (let i = 1; i < M; i++) {
      acc += Math.hypot(C[i * 3] - C[i * 3 - 3], C[i * 3 + 1] - C[i * 3 - 2], C[i * 3 + 2] - C[i * 3 - 1]);
      V[i] = acc;
    }
    if (acc > 0) for (let i = 0; i < M; i++) V[i] /= acc;
  }
  const UV = new Float32Array(M * cols * 2);
  for (let i = 0; i < M; i++) {
    for (let j = 0; j < cols; j++) {
      const d = (i * cols + j) * 2;
      UV[d] = opts.u ? opts.u[j] : j / (closed ? N : N - 1);
      UV[d + 1] = V[i];
    }
  }

  // Indices: quad (i,j)-(i,j+1)-(i+1,j+1)-(i+1,j) → triangles (a,b,d), (b,c,d) have normal du × dv.
  const capStart = !!opts.capStart && closed;
  const capEnd = !!opts.capEnd && closed;
  const capVerts = (capStart ? N + 1 : 0) + (capEnd ? N + 1 : 0);
  const totalVerts = M * cols + capVerts;
  const totalIdx = (M - 1) * quadsU * 6 + (capStart ? N * 3 : 0) + (capEnd ? N * 3 : 0);
  const index = totalVerts > 65535 ? new Uint32Array(totalIdx) : new Uint16Array(totalIdx);
  let k = 0;
  for (let i = 0; i < M - 1; i++) {
    for (let j = 0; j < quadsU; j++) {
      const a = i * cols + j;
      const b = i * cols + j + 1;
      const c = (i + 1) * cols + j + 1;
      const d = (i + 1) * cols + j;
      if (!flip) {
        index[k++] = a; index[k++] = b; index[k++] = d;
        index[k++] = b; index[k++] = c; index[k++] = d;
      } else {
        index[k++] = a; index[k++] = d; index[k++] = b;
        index[k++] = b; index[k++] = d; index[k++] = c;
      }
    }
  }

  const pos = new Float32Array(totalVerts * 3);
  const nor = new Float32Array(totalVerts * 3);
  const uvs = new Float32Array(totalVerts * 2);
  pos.set(P);
  nor.set(Nrm);
  uvs.set(UV);

  let vbase = M * cols;
  const addCap = (ringIndex: number, atStart: boolean) => {
    const r = rings[ringIndex];
    // Newell normal of the ring polygon.
    let nx = 0, ny = 0, nz = 0;
    for (let j = 0; j < N; j++) {
      const q = ((j + 1) % N) * 3;
      const p = j * 3;
      nx += (r[p + 1] - r[q + 1]) * (r[p + 2] + r[q + 2]);
      ny += (r[p + 2] - r[q + 2]) * (r[p] + r[q]);
      nz += (r[p] - r[q]) * (r[p + 1] + r[q + 1]);
    }
    let len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    // Point the cap away from the neighbouring ring (outward).
    const other = atStart ? 1 : M - 2;
    const ax = C[ringIndex * 3] - C[other * 3];
    const ay = C[ringIndex * 3 + 1] - C[other * 3 + 1];
    const az = C[ringIndex * 3 + 2] - C[other * 3 + 2];
    const outward = nx * ax + ny * ay + nz * az >= 0;
    if (!outward) { nx = -nx; ny = -ny; nz = -nz; }
    const centre = vbase + N;
    for (let j = 0; j < N; j++) {
      const d = (vbase + j) * 3;
      pos[d] = r[j * 3]; pos[d + 1] = r[j * 3 + 1]; pos[d + 2] = r[j * 3 + 2];
      nor[d] = nx; nor[d + 1] = ny; nor[d + 2] = nz;
      uvs[(vbase + j) * 2] = opts.u ? opts.u[j] : j / N;
      uvs[(vbase + j) * 2 + 1] = V[ringIndex];
    }
    const dc = centre * 3;
    pos[dc] = C[ringIndex * 3]; pos[dc + 1] = C[ringIndex * 3 + 1]; pos[dc + 2] = C[ringIndex * 3 + 2];
    nor[dc] = nx; nor[dc + 1] = ny; nor[dc + 2] = nz;
    uvs[centre * 2] = 0.5;
    uvs[centre * 2 + 1] = V[ringIndex];
    // Wind each fan triangle so its face normal matches (nx,ny,nz).
    for (let j = 0; j < N; j++) {
      const a = vbase + j;
      const b = vbase + ((j + 1) % N);
      const pa3 = a * 3, pb3 = b * 3;
      const e1x = pos[pa3] - pos[dc], e1y = pos[pa3 + 1] - pos[dc + 1], e1z = pos[pa3 + 2] - pos[dc + 2];
      const e2x = pos[pb3] - pos[dc], e2y = pos[pb3 + 1] - pos[dc + 1], e2z = pos[pb3 + 2] - pos[dc + 2];
      const fx = e1y * e2z - e1z * e2y, fy = e1z * e2x - e1x * e2z, fz = e1x * e2y - e1y * e2x;
      if (fx * nx + fy * ny + fz * nz >= 0) {
        index[k++] = centre; index[k++] = a; index[k++] = b;
      } else {
        index[k++] = centre; index[k++] = b; index[k++] = a;
      }
    }
    vbase += N + 1;
  };
  if (capStart) addCap(0, true);
  if (capEnd) addCap(M - 1, false);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(new THREE.BufferAttribute(index, 1));
  return g;
}

function diff(a: number[], b: number[], out: number[]) {
  out[0] = b[0] - a[0];
  out[1] = b[1] - a[1];
  out[2] = b[2] - a[2];
}
