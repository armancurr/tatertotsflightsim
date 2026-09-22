/**
 * Solid airport structures for the physics: footprints (oriented boxes and
 * cylinders) with their top heights, and a fast pure lookup
 * (x, z) → top height MSL or −Infinity. PURE.
 */
import type { AirportPlan } from './plan';

export type Obstacle =
  | { type: 'box'; x: number; z: number; halfW: number; halfD: number; headingDeg: number; top: number }
  | { type: 'cylinder'; x: number; z: number; r: number; top: number };

/**
 * Box convention = layout BuildingSpot: `headingDeg` is the direction the front
 * faces; `halfW` runs across the front, `halfD` front to back.
 */
export function createObstacleSource(shapes: readonly Obstacle[]): (x: number, z: number) => number {
  const n = shapes.length;
  // Flattened: per shape [type, x, z, cos, sin, halfW, halfD / r, top], plus a bounding radius.
  const data = new Float64Array(n * 9);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  shapes.forEach((s, i) => {
    const o = i * 9;
    data[o + 1] = s.x;
    data[o + 2] = s.z;
    data[o + 7] = s.top;
    let br: number;
    if (s.type === 'box') {
      const h = (s.headingDeg * Math.PI) / 180;
      data[o] = 0;
      data[o + 3] = Math.cos(h);
      data[o + 4] = Math.sin(h);
      data[o + 5] = s.halfW;
      data[o + 6] = s.halfD;
      br = Math.hypot(s.halfW, s.halfD);
    } else {
      data[o] = 1;
      data[o + 5] = s.r;
      data[o + 6] = s.r;
      br = s.r;
    }
    data[o + 8] = br * br;
    minX = Math.min(minX, s.x - br);
    maxX = Math.max(maxX, s.x + br);
    minZ = Math.min(minZ, s.z - br);
    maxZ = Math.max(maxZ, s.z + br);
  });
  let active = true;
  const fn = (x: number, z: number): number => {
    // NaN fails every comparison → −Infinity
    if (!active || !(x >= minX && x <= maxX && z >= minZ && z <= maxZ)) return -Infinity;
    let top = -Infinity;
    for (let i = 0; i < n; i++) {
      const o = i * 9;
      const dx = x - data[o + 1];
      const dz = z - data[o + 2];
      if (dx * dx + dz * dz > data[o + 8]) continue;
      if (data[o] === 1) {
        if (data[o + 7] > top) top = data[o + 7];
        continue;
      }
      // front direction f = (sin h, −cos h); across-front r = (cos h, sin h)
      const c = data[o + 3];
      const s = data[o + 4];
      const u = dx * c + dz * s; // across the front
      const v = dx * s - dz * c; // along the front direction
      if (u >= -data[o + 5] && u <= data[o + 5] && v >= -data[o + 6] && v <= data[o + 6] && data[o + 7] > top) top = data[o + 7];
    }
    return top;
  };
  (fn as ObstacleFn).disable = () => {
    active = false;
  };
  return fn;
}

export type ObstacleFn = ((x: number, z: number) => number) & { disable?: () => void };

/** Parked C172 footprint (wingspan × length) and height. */
export const PARKED_AIRCRAFT_SIZE = { span: 11.0, length: 8.3, height: 2.72 };

export function airportObstacles(plan: AirportPlan, heightAt: (x: number, z: number) => number = () => plan.elevation): Obstacle[] {
  const out: Obstacle[] = [];
  const box = (b: { center: { x: number; z: number }; width: number; depth: number; headingDeg: number }, height: number) =>
    out.push({ type: 'box', x: b.center.x, z: b.center.z, halfW: b.width / 2, halfD: b.depth / 2, headingDeg: b.headingDeg, top: heightAt(b.center.x, b.center.z) + height });
  for (const h of plan.hangars) box(h.spot, h.spot.height);
  box(plan.terminal, plan.terminal.height + 1.2); // parapet + rooftop plant
  const t = plan.tower;
  box(t, t.height);
  // mast + beacon on the tower roof
  out.push({ type: 'cylinder', x: t.center.x, z: t.center.z, r: 0.6, top: heightAt(t.center.x, t.center.z) + t.height + 3.6 });
  // parked aircraft
  for (const p of plan.parked) {
    out.push({
      type: 'box',
      x: p.x,
      z: p.z,
      halfW: PARKED_AIRCRAFT_SIZE.span / 2,
      halfD: PARKED_AIRCRAFT_SIZE.length / 2,
      headingDeg: p.headingDeg,
      top: heightAt(p.x, p.z) + PARKED_AIRCRAFT_SIZE.height,
    });
  }
  // windsock mast
  out.push({ type: 'cylinder', x: plan.windsock.x, z: plan.windsock.z, r: 0.5, top: heightAt(plan.windsock.x, plan.windsock.z) + 6.6 });
  // fuel tank
  out.push({ type: 'cylinder', x: plan.fuelTank.x, z: plan.fuelTank.z, r: 4, top: heightAt(plan.fuelTank.x, plan.fuelTank.z) + 3.2 });
  out.push({ type: 'cylinder', x: plan.fuelPump.x, z: plan.fuelPump.z, r: 1, top: heightAt(plan.fuelPump.x, plan.fuelPump.z) + 2.0 });
  return out;
}
