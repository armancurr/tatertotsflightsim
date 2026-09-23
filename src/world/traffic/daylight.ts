/**
 * Daylight for traffic (PURE + one three.js sync helper): how "night" it is for
 * navigation lights, lamps and lit windows (0 in daylight, rising through the
 * golden hour, 1 once the sun is 2° below the horizon), and copying the
 * atmosphere's sun/sky into the traffic materials' shared uniforms.
 */
import type { LightingUniforms } from './materials';

/** 0 day … 1 night for a sun elevation (deg): ~0.23 at the golden-hour preset (9°), ~0.7 at dawn (4°). */
export function nightFactor(sunElevationDeg: number): number {
  if (!Number.isFinite(sunElevationDeg)) return 0;
  const t = Math.min(1, Math.max(0, (sunElevationDeg + 2) / 16));
  return 1 - t * t * (3 - 2 * t);
}

/** Sun elevation (deg) from a unit sun direction's y. */
export const sunElevationDeg = (sunDirY: number): number => (Math.asin(Math.max(-1, Math.min(1, sunDirY))) * 180) / Math.PI;

interface RGB {
  r: number;
  g: number;
  b: number;
}

/** Copies the sun direction, the sun at the camera and the sky irradiance into the shared uniforms. */
export function syncLighting(u: LightingUniforms, sunDir: { x: number; y: number; z: number }, sunAtCamera: RGB | null | undefined, sky: RGB | null | undefined): void {
  u.uSunDir.value.set(sunDir.x, sunDir.y, sunDir.z).normalize();
  if (sunAtCamera) u.uSunColor.value.setRGB(sunAtCamera.r, sunAtCamera.g, sunAtCamera.b);
  if (sky) u.uSky.value.setRGB(sky.r, sky.g, sky.b);
}
