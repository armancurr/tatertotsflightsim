/**
 * Small geometry builders shared by the vessel models: a quad grid from a 2D array of points
 * (winding chosen from an outward hint, smooth normals within the grid), a fan cap for a closed
 * outline, planar UVs, and boxes / beams between two points. Every output is indexed with
 * position / normal / uv so it can be tinted and merged (src/aircraft/materials.ts `tint`/`merge`).
 */
import * as THREE from 'three';

export type P3 = [number, number, number];
/** A direction that faces OUT of the surface: fixed, or per quad from its centre. */
export type Hint = P3 | ((x: number, y: number, z: number) => P3);

const hintAt = (h: Hint, x: number, y: number, z: number): P3 => (typeof h === 'function' ? h(x, y, z) : h);

/**
 * A rows × cols grid of points → an indexed triangle mesh. The winding is chosen per quad so each
 * face's normal agrees with `outward` (a grid may be degenerate in places: zero-area quads are
 * kept but harmless). Normals are smooth across the grid (split grids for creases).
 * `uv(i, j)` gives texture coordinates (default: j / (cols−1), i / (rows−1)).
 */
export function gridGeometry(grid: P3[][], outward: Hint, uv?: (i: number, j: number) => [number, number]): THREE.BufferGeometry {
  const rows = grid.length;
  const cols = grid[0]?.length ?? 0;
  const pos = new Float32Array(rows * cols * 3);
  const uvs = new Float32Array(rows * cols * 2);
  for (let i = 0; i < rows; i++) {
    if (grid[i].length !== cols) throw new Error('gridGeometry: ragged grid');
    for (let j = 0; j < cols; j++) {
      const k = i * cols + j;
      pos.set(grid[i][j], k * 3);
      const t = uv ? uv(i, j) : [cols > 1 ? j / (cols - 1) : 0, rows > 1 ? i / (rows - 1) : 0];
      uvs[k * 2] = t[0];
      uvs[k * 2 + 1] = t[1];
    }
  }
  const idx: number[] = [];
  for (let i = 0; i < rows - 1; i++) {
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j;
      const b = (i + 1) * cols + j;
      const c = (i + 1) * cols + j + 1;
      const d = i * cols + j + 1;
      const pa = grid[i][j];
      const pb = grid[i + 1][j];
      const pc = grid[i + 1][j + 1];
      const pd = grid[i][j + 1];
      // Quad normal from its diagonals (robust when one edge is degenerate).
      const e1 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
      const e2 = [pd[0] - pb[0], pd[1] - pb[1], pd[2] - pb[2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const h = hintAt(outward, (pa[0] + pc[0]) / 2, (pa[1] + pc[1]) / 2, (pa[2] + pc[2]) / 2);
      // n = (c − a) × (d − b) is the normal of the winding a → b → c → d.
      if (n[0] * h[0] + n[1] * h[1] + n[2] * h[2] >= 0) idx.push(a, b, c, a, c, d);
      else idx.push(a, c, b, a, d, c);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

/**
 * A flat-ish cap over a closed outline (a fan from its centroid; the outline must be star-shaped
 * about the centroid — true for hull sections, windows, deck plates). Faces toward `outward`.
 */
export function fanCap(outline: P3[], outward: P3, uv?: (p: P3) => [number, number]): THREE.BufferGeometry {
  const n = outline.length;
  const c: P3 = [0, 0, 0];
  for (const p of outline) for (let k = 0; k < 3; k++) c[k] += p[k] / n;
  const pos = new Float32Array((n + 1) * 3);
  const uvs = new Float32Array((n + 1) * 2);
  pos.set(c, 0);
  outline.forEach((p, i) => pos.set(p, (i + 1) * 3));
  [c, ...outline].forEach((p, i) => {
    const t = uv ? uv(p) : [p[0], p[1]];
    uvs[i * 2] = t[0];
    uvs[i * 2 + 1] = t[1];
  });
  const idx: number[] = [];
  for (let i = 0; i < n; i++) {
    const a = outline[i];
    const b = outline[(i + 1) % n];
    const e1 = [a[0] - c[0], a[1] - c[1], a[2] - c[2]];
    const e2 = [b[0] - c[0], b[1] - c[1], b[2] - c[2]];
    const nn = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
    const dot = nn[0] * outward[0] + nn[1] * outward[1] + nn[2] * outward[2];
    if (dot >= 0) idx.push(0, i + 1, ((i + 1) % n) + 1);
    else idx.push(0, ((i + 1) % n) + 1, i + 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  const len = Math.hypot(...outward) || 1;
  const nor = new Float32Array((n + 1) * 3);
  for (let i = 0; i <= n; i++) nor.set([outward[0] / len, outward[1] / len, outward[2] / len], i * 3);
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setIndex(idx);
  return g;
}

/** Replace the UVs with a planar projection (metres × scale) onto two body axes. */
export function planarUV(g: THREE.BufferGeometry, a: 'x' | 'y' | 'z', b: 'x' | 'y' | 'z', scale = 1): THREE.BufferGeometry {
  const p = g.getAttribute('position');
  const uv = new Float32Array(p.count * 2);
  const get = (i: number, ax: 'x' | 'y' | 'z') => (ax === 'x' ? p.getX(i) : ax === 'y' ? p.getY(i) : p.getZ(i));
  for (let i = 0; i < p.count; i++) {
    uv[i * 2] = get(i, a) * scale;
    uv[i * 2 + 1] = get(i, b) * scale;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** Axis-aligned box from its min / max corners. */
export function boxMinMax(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(Math.abs(x1 - x0), Math.abs(y1 - y0), Math.abs(z1 - z0));
  g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  return g;
}

/**
 * A rectangular beam from a to b: `w` wide along the side axis (perpendicular to the beam and to
 * `up`), `t` thick along the remaining axis.
 */
export function beam(a: THREE.Vector3, b: THREE.Vector3, w: number, t: number, up = new THREE.Vector3(0, 1, 0)): THREE.BufferGeometry {
  const d = b.clone().sub(a);
  const len = d.length();
  const g = new THREE.BoxGeometry(w, t, len);
  const zAxis = d.clone().normalize();
  const xAxis = new THREE.Vector3().crossVectors(up, zAxis);
  if (xAxis.lengthSq() < 1e-8) xAxis.set(1, 0, 0);
  xAxis.normalize();
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
  g.applyMatrix4(new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis));
  g.translate((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  return g;
}

/** A round tube through a polyline (stainless rails, handholds). */
export function railTube(points: THREE.Vector3[], r: number, radial = 8, perSegment = 4, closed = false): THREE.BufferGeometry {
  const curve = new THREE.CatmullRomCurve3(points, closed, 'centripetal', 0.5);
  return new THREE.TubeGeometry(curve, Math.max(2, points.length * perSegment), r, radial, closed);
}
