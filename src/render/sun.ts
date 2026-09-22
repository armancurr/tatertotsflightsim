/**
 * Pure sun-vector and shadow-frustum math (no three.js, allocation-free when
 * `out` vectors are passed). World frame: +X east, +Y up, +Z south, north = -Z.
 */
import type { Vec3 } from '../types';

const DEG = Math.PI / 180;

/**
 * Unit vector pointing TOWARD the sun.
 * @param elevationDeg angle above the horizon
 * @param azimuthDeg   compass bearing, clockwise from north (0 = north/-Z, 90 = east/+X)
 */
export function sunDirectionFromAngles(elevationDeg: number, azimuthDeg: number, out: Vec3 = { x: 0, y: 0, z: 0 }): Vec3 {
  const el = elevationDeg * DEG;
  const az = azimuthDeg * DEG;
  const c = Math.cos(el);
  out.x = Math.sin(az) * c;
  out.y = Math.sin(el);
  out.z = -Math.cos(az) * c;
  return out;
}

/**
 * The light-space right/up axes of a directional-light shadow camera looking
 * along -sunDir, matching three.js `Matrix4.lookAt(eye, target, up = +Y)`:
 * z = sunDir, x = normalize(up × z), y = z × x.
 */
export function shadowLightBasis(sunDir: Vec3, outRight: Vec3, outUp: Vec3): void {
  // up × z with up = (0,1,0): (z.z, 0, -z.x)
  let rx = sunDir.z;
  let ry = 0;
  let rz = -sunDir.x;
  let l = Math.hypot(rx, ry, rz);
  if (l < 1e-6) {
    // Sun straight overhead: three nudges z; any horizontal right axis works.
    rx = 1;
    ry = 0;
    rz = 0;
    l = 1;
  }
  rx /= l;
  ry /= l;
  rz /= l;
  outRight.x = rx;
  outRight.y = ry;
  outRight.z = rz;
  // y = z × x
  outUp.x = sunDir.y * rz - sunDir.z * ry;
  outUp.y = sunDir.z * rx - sunDir.x * rz;
  outUp.z = sunDir.x * ry - sunDir.y * rx;
  const ul = Math.hypot(outUp.x, outUp.y, outUp.z) || 1;
  outUp.x /= ul;
  outUp.y /= ul;
  outUp.z /= ul;
}

const _r: Vec3 = { x: 0, y: 0, z: 0 };
const _u: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * Snap the shadow-camera centre to the shadow-map texel grid (in the light's
 * right/up plane) so the shadow of a static object does not crawl/shimmer as
 * the focus point moves. The component along the sun ray is left untouched.
 */
export function snapShadowCenter(focus: Vec3, sunDir: Vec3, halfExtent: number, mapSize: number, out: Vec3): Vec3 {
  shadowLightBasis(sunDir, _r, _u);
  const texel = (2 * halfExtent) / mapSize;
  const lx = focus.x * _r.x + focus.y * _r.y + focus.z * _r.z;
  const ly = focus.x * _u.x + focus.y * _u.y + focus.z * _u.z;
  const dx = Math.round(lx / texel) * texel - lx;
  const dy = Math.round(ly / texel) * texel - ly;
  out.x = focus.x + _r.x * dx + _u.x * dy;
  out.y = focus.y + _r.y * dx + _u.y * dy;
  out.z = focus.z + _r.z * dx + _u.z * dy;
  return out;
}
