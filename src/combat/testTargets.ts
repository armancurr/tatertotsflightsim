/**
 * PURE: the `?targets=test` debug set (owned by the weapons system) — a few vehicles on the ground
 * at the target range for gun QA before the real range is populated: a T-72 showing its rear to
 * the run-in, one head-on, one side-on, a BMP-2, a parked Ural and one Ural driving across.
 */
import type { Environment } from '../types';
import type { NewTarget, RangeInfo } from './types';

export const TEST_GROUP = 'weapons-test';
/** The range used before the targets system sets one (same as the app's ?spawn=range fallback). */
export const DEFAULT_RANGE: RangeInfo = { x: 0, z: -7000, headingDeg: 0 };

export function testTargets(range: RangeInfo | null, env: Environment): NewTarget[] {
  const r = range ?? DEFAULT_RANGE;
  const h = (r.headingDeg * Math.PI) / 180;
  // Run-in axis (forward = the way the jet flies over the range) and its right.
  const fx = Math.sin(h), fz = -Math.cos(h);
  const rx = Math.cos(h), rz = Math.sin(h);
  const at = (fwd: number, right: number) => {
    const x = r.x + fx * fwd + rx * right;
    const z = r.z + fz * fwd + rz * right;
    return { x, y: env.groundHeight(x, z), z };
  };
  const hdg = (d: number) => (((r.headingDeg + d) % 360) + 360) % 360;
  const truckSpeed = 6;
  const across = hdg(90);
  const ah = (across * Math.PI) / 180;
  return [
    { kind: 'tank', position: at(0, 0), headingDeg: hdg(0), group: TEST_GROUP },
    { kind: 'tank', position: at(60, -45), headingDeg: hdg(180), group: TEST_GROUP },
    { kind: 'tank', position: at(-50, 50), headingDeg: hdg(90), group: TEST_GROUP },
    { kind: 'ifv', position: at(110, 30), headingDeg: hdg(30), group: TEST_GROUP },
    { kind: 'truck', position: at(-90, -30), headingDeg: hdg(270), group: TEST_GROUP },
    { kind: 'truck', position: at(160, -120), headingDeg: across, group: TEST_GROUP, velocity: { x: Math.sin(ah) * truckSpeed, y: 0, z: -Math.cos(ah) * truckSpeed } },
  ];
}
