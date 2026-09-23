/**
 * The jet HUD on its combiner glass (cockpit view). A real HUD is collimated at infinity: its
 * symbols are fixed to the aircraft (gun cross, tapes) or to the world (horizon, pitch ladder,
 * flight-path marker), and the glass only frames them. Here, every frame:
 *
 *  - the combiner's outline (the 4 corners of its geometry's bounding box, in its mid-plane) is
 *    projected through the camera → the clip quadrilateral on screen;
 *  - the HUD's own drawing plane ("HUD px") is tied to the aircraft: an affine map, linearised at
 *    the boresight, takes HUD px → viewport px (1 HUD px ≈ 1 screen px looking straight ahead;
 *    looking around moves, turns and stretches it exactly like the glass);
 *  - the HUD box = the largest HUD-px rectangle inside the glass: the tapes, texts, stores block…
 *    are laid out in it;
 *  - the horizon line is the camera's exact vanishing line of the horizontal plane, expressed in
 *    HUD px (so it lands on the world horizon), and the flight-path marker the exact projection
 *    of the velocity vector.
 *
 * `projectHudGlass` is pure (matrices as column-major arrays, three.js `elements`) and writes into a
 * preallocated `HudGlass` (no allocations per frame); `projectHudGlassObjects` reads them from a
 * three.js camera + combiner mesh. Nothing here ever produces NaN: a degenerate case → not visible.
 */
import type * as THREE from 'three';

const DEG = Math.PI / 180;
const fin = (x: number): boolean => typeof x === 'number' && Number.isFinite(x);

export interface HudGlass {
  /** The glass is in front of the camera and (at least partly) on screen. */
  visible: boolean;
  /** Viewport, CSS px. */
  vw: number;
  vh: number;
  /** Glass outline on screen (x0, y0 … x3, y3), CSS px, in order around the quad. */
  quad: Float64Array;
  /** Bounding rect of the quad on screen (for clearing), CSS px. */
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  /** HUD box size (HUD px): the largest rectangle inside the glass. */
  w: number;
  h: number;
  /** Affine HUD-box px → viewport CSS px, canvas order (a, b, c, d, e, f): x' = a·x + c·y + e, y' = b·x + d·y + f. */
  m: Float64Array;
  /** Inverse: viewport CSS px → HUD-box px. */
  inv: Float64Array;
  /** HUD px per degree at the boresight. */
  ppd: number;
  /** Boresight (the aircraft's nose, fuselage datum) in the HUD box, px. */
  boreX: number;
  boreY: number;
  /** Horizon: ladder-frame rotation (canvas rad) at the boresight and the horizon's offset below the boresight along the rolled vertical, px. */
  horizonOk: boolean;
  rotation: number;
  horizonOffset: number;
  /** Flight-path marker (velocity vector) in the HUD box, px. */
  fpmOk: boolean;
  fpmX: number;
  fpmY: number;
  /** Scratch: the view matrix rotation, the projection terms. */
  v: Float64Array;
  p: Float64Array;
}

export function createHudGlass(): HudGlass {
  return {
    visible: false, vw: 0, vh: 0, quad: new Float64Array(8), minX: 0, minY: 0, maxX: 0, maxY: 0, w: 0, h: 0,
    m: new Float64Array([1, 0, 0, 1, 0, 0]), inv: new Float64Array([1, 0, 0, 1, 0, 0]), ppd: 1, boreX: 0, boreY: 0,
    horizonOk: false, rotation: 0, horizonOffset: 0, fpmOk: false, fpmX: 0, fpmY: 0,
    v: new Float64Array(16), p: new Float64Array(16),
  };
}

// Scratch (module-level, reused).
const scr = { x: 0, y: 0 };
const loc = new Float64Array(8);
const order = [0, 1, 2, 3];
const ang = new Float64Array(4);

/** Project a world direction (vx, vy, vz) to viewport px through g.v / g.p. False if not in front. */
function projDir(g: HudGlass, x: number, y: number, z: number): boolean {
  const e = g.v;
  const vx = e[0] * x + e[4] * y + e[8] * z;
  const vy = e[1] * x + e[5] * y + e[9] * z;
  const vz = e[2] * x + e[6] * y + e[10] * z;
  return clipToScreen(g, vx, vy, vz, 0);
}

/** Project a world point. */
function projPoint(g: HudGlass, x: number, y: number, z: number): boolean {
  const e = g.v;
  const vx = e[0] * x + e[4] * y + e[8] * z + e[12];
  const vy = e[1] * x + e[5] * y + e[9] * z + e[13];
  const vz = e[2] * x + e[6] * y + e[10] * z + e[14];
  return clipToScreen(g, vx, vy, vz, 1);
}

function clipToScreen(g: HudGlass, vx: number, vy: number, vz: number, w: number): boolean {
  const p = g.p;
  const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12] * w;
  const cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13] * w;
  const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15] * w;
  if (!(fin(cx) && fin(cy) && fin(cw)) || cw <= 1e-6) return false;
  scr.x = ((cx / cw + 1) / 2) * g.vw;
  scr.y = ((1 - cy / cw) / 2) * g.vh;
  return fin(scr.x) && fin(scr.y) && Math.abs(scr.x) < 1e6 && Math.abs(scr.y) < 1e6;
}

/** Rotate a body vector by quaternion q (x, y, z, w) into out3 (index o). */
function rot(out: Float64Array, o: number, q: ArrayLike<number>, x: number, y: number, z: number): void {
  const qx = q[0];
  const qy = q[1];
  const qz = q[2];
  const qw = q[3];
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[o] = x + qw * tx + (qy * tz - qz * ty);
  out[o + 1] = y + qw * ty + (qz * tx - qx * tz);
  out[o + 2] = z + qw * tz + (qx * ty - qy * tx);
}

const byAngle = (a: number, b: number): number => ang[a] - ang[b];

/** Second-smallest / second-largest of one coordinate of the 4 corners in `loc` (the rectangle inside a near-rectangle). */
function second(off: number, largest: boolean): number {
  let m1 = largest ? -Infinity : Infinity;
  let m2 = m1;
  for (let k = 0; k < 4; k++) {
    const v = loc[2 * k + off];
    if (largest ? v > m1 : v < m1) {
      m2 = m1;
      m1 = v;
    } else if (largest ? v > m2 : v < m2) m2 = v;
  }
  return m2;
}

const axes = new Float64Array(9); // forward, right, up (world)
const pts = new Float64Array(6);

/** Inputs for projectHudGlass (all arrays column-major / xyz, reused by the caller). */
export interface HudGlassInput {
  /** Camera matrixWorldInverse and projectionMatrix elements. */
  view: ArrayLike<number>;
  proj: ArrayLike<number>;
  /** Viewport, CSS px. */
  vw: number;
  vh: number;
  /** The combiner's 4 outline corners in WORLD space (x, y, z × 4), in order around the glass. */
  corners: ArrayLike<number>;
  /** Aircraft orientation (body → world quaternion x, y, z, w). */
  body: ArrayLike<number>;
  /** World velocity (m/s), or null. */
  velocity: ArrayLike<number> | null;
}

/** Fill `g` for this frame. Returns g (g.visible false when the glass can't be seen). */
export function projectHudGlass(g: HudGlass, inp: HudGlassInput): HudGlass {
  g.visible = false;
  g.horizonOk = false;
  g.fpmOk = false;
  const vw = fin(inp.vw) && inp.vw > 0 ? Math.min(inp.vw, 1e5) : 0;
  const vh = fin(inp.vh) && inp.vh > 0 ? Math.min(inp.vh, 1e5) : 0;
  g.vw = vw;
  g.vh = vh;
  if (!vw || !vh) return g;
  for (let i = 0; i < 16; i++) {
    const a = inp.view[i];
    const b = inp.proj[i];
    if (!fin(a) || !fin(b)) return g;
    g.v[i] = a;
    g.p[i] = b;
  }
  const q = inp.body;
  const ql = Math.hypot(q[0], q[1], q[2], q[3]);
  if (!fin(ql) || ql < 1e-6) return g;
  // Body axes in the world: nose (−Z), right (+X), up (+Y).
  rot(axes, 0, q, 0, 0, -1);
  rot(axes, 3, q, 1, 0, 0);
  rot(axes, 6, q, 0, 1, 0);
  for (let i = 0; i < 9; i++) axes[i] /= ql * ql;

  // Glass corners on screen.
  const c = inp.corners;
  const quad = g.quad;
  for (let k = 0; k < 4; k++) {
    if (!projPoint(g, c[3 * k], c[3 * k + 1], c[3 * k + 2])) return g;
    quad[2 * k] = scr.x;
    quad[2 * k + 1] = scr.y;
  }
  // Order the corners around their centroid (whatever order the geometry gave).
  const cx = (quad[0] + quad[2] + quad[4] + quad[6]) / 4;
  const cy = (quad[1] + quad[3] + quad[5] + quad[7]) / 4;
  for (let k = 0; k < 4; k++) {
    order[k] = k;
    ang[k] = Math.atan2(quad[2 * k + 1] - cy, quad[2 * k] - cx);
  }
  order.sort(byAngle);
  for (let k = 0; k < 4; k++) {
    loc[2 * k] = quad[2 * order[k]];
    loc[2 * k + 1] = quad[2 * order[k] + 1];
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let k = 0; k < 8; k++) {
    quad[k] = loc[k];
    if (k % 2 === 0) {
      minX = Math.min(minX, loc[k]);
      maxX = Math.max(maxX, loc[k]);
    } else {
      minY = Math.min(minY, loc[k]);
      maxY = Math.max(maxY, loc[k]);
    }
  }
  g.minX = minX;
  g.minY = minY;
  g.maxX = maxX;
  g.maxY = maxY;
  // Entirely off screen → nothing to draw.
  if (maxX < 0 || maxY < 0 || minX > vw || minY > vh) return g;

  // Boresight and the local basis (central differences, ±1°).
  const t1 = Math.tan(DEG);
  const fx = axes[0];
  const fy = axes[1];
  const fz = axes[2];
  if (!projDir(g, fx, fy, fz)) return g;
  const bx = scr.x;
  const by = scr.y;
  let ok = projDir(g, fx + axes[3] * t1, fy + axes[4] * t1, fz + axes[5] * t1);
  pts[0] = scr.x;
  pts[1] = scr.y;
  ok = ok && projDir(g, fx - axes[3] * t1, fy - axes[4] * t1, fz - axes[5] * t1);
  pts[2] = scr.x;
  pts[3] = scr.y;
  if (!ok) return g;
  const dux = (pts[0] - pts[2]) / 2;
  const duy = (pts[1] - pts[3]) / 2;
  ok = projDir(g, fx + axes[6] * t1, fy + axes[7] * t1, fz + axes[8] * t1);
  pts[0] = scr.x;
  pts[1] = scr.y;
  ok = ok && projDir(g, fx - axes[6] * t1, fy - axes[7] * t1, fz - axes[8] * t1);
  pts[2] = scr.x;
  pts[3] = scr.y;
  if (!ok) return g;
  const dvx = (pts[0] - pts[2]) / 2;
  const dvy = (pts[1] - pts[3]) / 2;
  // HUD px per degree: the camera's focal length (vertical), so 1 HUD px ≈ 1 screen px ahead.
  const ppd = Math.abs(g.p[5]) * (vh / 2) * DEG;
  if (!fin(ppd) || ppd < 1e-3) return g;
  // M: HUD px (x right, y down) → screen px, relative to the boresight.
  const a = dux / ppd;
  const b = duy / ppd;
  const cc = -dvx / ppd;
  const d = -dvy / ppd;
  const det = a * d - b * cc;
  if (!fin(det) || Math.abs(det) < 1e-6) return g;
  const ia = d / det;
  const ib = -b / det;
  const ic = -cc / det;
  const id = a / det;
  // Glass corners in HUD px (relative to the boresight) → the inscribed box.
  for (let k = 0; k < 4; k++) {
    const sx = quad[2 * k] - bx;
    const sy = quad[2 * k + 1] - by;
    loc[2 * k] = ia * sx + ic * sy;
    loc[2 * k + 1] = ib * sx + id * sy;
  }
  const left = second(0, false);
  const right = second(0, true);
  const top = second(1, false);
  const bottom = second(1, true);
  const W = right - left;
  const H = bottom - top;
  if (!(fin(W) && fin(H)) || W < 4 || H < 4) return g;
  g.w = W;
  g.h = H;
  g.ppd = ppd;
  g.boreX = -left;
  g.boreY = -top;
  const m = g.m;
  m[0] = a;
  m[1] = b;
  m[2] = cc;
  m[3] = d;
  m[4] = bx + a * left + cc * top;
  m[5] = by + b * left + d * top;
  const inv = g.inv;
  inv[0] = ia;
  inv[1] = ib;
  inv[2] = ic;
  inv[3] = id;
  inv[4] = -(ia * m[4] + ic * m[5]);
  inv[5] = -(ib * m[4] + id * m[5]);
  g.visible = true;

  // Horizon: the vanishing line of the horizontal plane, h(s) = A·sx + B·sy + C (> 0 = sky).
  const e = g.v;
  const ux = e[4];
  const uy = e[5];
  const uz = e[6];
  const p = g.p;
  if (Math.abs(p[0]) > 1e-9 && Math.abs(p[5]) > 1e-9) {
    const A = (ux * (2 / vw)) / p[0];
    const B = (uy * (-2 / vh)) / p[5];
    const C = (ux * (p[8] - 1)) / p[0] + (uy * (1 + p[9])) / p[5] - uz;
    // In HUD-box px: s = m·b.
    const A2 = A * m[0] + B * m[1];
    const B2 = A * m[2] + B * m[3];
    const C2 = A * m[4] + B * m[5] + C;
    const len = Math.hypot(A2, B2);
    if (fin(len) && len > 1e-12 && fin(C2)) {
      const nx = A2 / len;
      const ny = B2 / len;
      g.rotation = Math.atan2(nx, -ny);
      g.horizonOffset = nx * g.boreX + ny * g.boreY + C2 / len;
      g.horizonOk = fin(g.rotation) && fin(g.horizonOffset);
    }
  }

  // Flight-path marker: the velocity vector (when moving).
  const vel = inp.velocity;
  if (vel && fin(vel[0]) && fin(vel[1]) && fin(vel[2])) {
    const sp = Math.hypot(vel[0], vel[1], vel[2]);
    if (sp > 8 && projDir(g, vel[0] / sp, vel[1] / sp, vel[2] / sp)) {
      hudGlassToBox(g, scr, scr.x, scr.y);
      g.fpmX = scr.x;
      g.fpmY = scr.y;
      g.fpmOk = fin(scr.x) && fin(scr.y);
    }
  }
  return g;
}

/** Viewport px → HUD-box px. */
export function hudGlassToBox(g: HudGlass, out: { x: number; y: number }, sx: number, sy: number): { x: number; y: number } {
  const i = g.inv;
  const x = i[0] * sx + i[2] * sy + i[4];
  const y = i[1] * sx + i[3] * sy + i[5];
  out.x = x;
  out.y = y;
  return out;
}

/** HUD-box px → viewport px. */
export function hudBoxToScreen(g: HudGlass, out: { x: number; y: number }, x: number, y: number): { x: number; y: number } {
  const m = g.m;
  const sx = m[0] * x + m[2] * y + m[4];
  const sy = m[1] * x + m[3] * y + m[5];
  out.x = sx;
  out.y = sy;
  return out;
}

/** Is viewport point (x, y) inside the glass quad (convex, any winding)? */
export function insideGlass(g: HudGlass, x: number, y: number, tol = 0): boolean {
  const q = g.quad;
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const ax = q[2 * k];
    const ay = q[2 * k + 1];
    const bx = q[(2 * k + 2) % 8];
    const by = q[(2 * k + 3) % 8];
    const len = Math.hypot(bx - ax, by - ay) || 1;
    const cr = ((bx - ax) * (y - ay) - (by - ay) * (x - ax)) / len;
    if (Math.abs(cr) <= tol) continue;
    const s = cr > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return true;
}

/** Trace the glass outline as the current path (viewport px under the context's transform) and clip to it. */
export function clipToGlass(ctx: CanvasRenderingContext2D, g: HudGlass): void {
  const q = g.quad;
  ctx.beginPath();
  ctx.moveTo(q[0], q[1]);
  ctx.lineTo(q[2], q[3]);
  ctx.lineTo(q[4], q[5]);
  ctx.lineTo(q[6], q[7]);
  ctx.closePath();
  ctx.clip();
}

/** A quantised key of what moves the glass on screen (redraw when it changes). */
export function hudGlassKey(g: HudGlass, out: Float64Array, at: number): void {
  if (!g.visible) {
    for (let i = 0; i < 6; i++) out[at + i] = -1;
    return;
  }
  out[at] = Math.round(g.m[4] * 4);
  out[at + 1] = Math.round(g.m[5] * 4);
  out[at + 2] = Math.round(g.m[0] * 2000);
  out[at + 3] = Math.round(g.m[1] * 2000);
  out[at + 4] = Math.round(g.m[2] * 2000);
  out[at + 5] = Math.round((g.m[3] + g.w + g.h * 1000) * 100);
}

export const HUD_GLASS_KEY_LENGTH = 6;

// ─── three.js glue ───────────────────────────────────────────────────────────

const outlineCache = new WeakMap<THREE.BufferGeometry, Float64Array>();

/**
 * The combiner's outline in its own (mesh-local) space: the bounding box's 4 corners in the plane
 * through its centre across its thinnest axis (a flat glass → its 4 corners). Cached per geometry.
 */
export function combinerOutline(mesh: THREE.Object3D): Float64Array | null {
  const geo = (mesh as THREE.Mesh).geometry as THREE.BufferGeometry | undefined;
  if (!geo || !geo.getAttribute) return null;
  let o = outlineCache.get(geo);
  if (o) return o;
  if (!geo.boundingBox) geo.computeBoundingBox();
  const bb = geo.boundingBox;
  if (!bb || bb.isEmpty()) return null;
  const mn = [bb.min.x, bb.min.y, bb.min.z];
  const mx = [bb.max.x, bb.max.y, bb.max.z];
  const size = [mx[0] - mn[0], mx[1] - mn[1], mx[2] - mn[2]];
  const thin = size[0] <= size[1] && size[0] <= size[2] ? 0 : size[1] <= size[2] ? 1 : 2;
  const u = thin === 0 ? 1 : 0;
  const v = thin === 2 ? 1 : 2;
  o = new Float64Array(12);
  const mid = (mn[thin] + mx[thin]) / 2;
  const corners = [[mn[u], mn[v]], [mx[u], mn[v]], [mx[u], mx[v]], [mn[u], mx[v]]];
  corners.forEach(([a, b], k) => {
    o![3 * k + thin] = mid;
    o![3 * k + u] = a;
    o![3 * k + v] = b;
  });
  outlineCache.set(geo, o);
  return o;
}

const worldCorners = new Float64Array(12);
const bodyQ = new Float64Array(4);
const velA = new Float64Array(3);
const input: HudGlassInput = { view: [], proj: [], vw: 0, vh: 0, corners: worldCorners, body: bodyQ, velocity: null };

/**
 * Project the combiner mesh through the camera (updates the combiner's world matrix first: the
 * loop moves the aircraft before the render updates matrices). `body` = the aircraft's attitude.
 */
export function projectHudGlassObjects(
  g: HudGlass,
  camera: THREE.Camera,
  combiner: THREE.Object3D,
  body: { x: number; y: number; z: number; w: number },
  velocity: { x: number; y: number; z: number } | null,
  vw: number,
  vh: number,
): HudGlass {
  const outline = combinerOutline(combiner);
  if (!outline || !combiner.visible) {
    g.visible = false;
    return g;
  }
  combiner.updateWorldMatrix(true, false);
  const e = combiner.matrixWorld.elements;
  for (let k = 0; k < 4; k++) {
    const x = outline[3 * k];
    const y = outline[3 * k + 1];
    const z = outline[3 * k + 2];
    worldCorners[3 * k] = e[0] * x + e[4] * y + e[8] * z + e[12];
    worldCorners[3 * k + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    worldCorners[3 * k + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  bodyQ[0] = body.x;
  bodyQ[1] = body.y;
  bodyQ[2] = body.z;
  bodyQ[3] = body.w;
  if (velocity) {
    velA[0] = velocity.x;
    velA[1] = velocity.y;
    velA[2] = velocity.z;
  }
  input.view = camera.matrixWorldInverse.elements;
  input.proj = camera.projectionMatrix.elements;
  input.vw = vw;
  input.vh = vh;
  input.velocity = velocity ? velA : null;
  return projectHudGlass(g, input);
}
