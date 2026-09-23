/**
 * Functional (headless, the real physics + the real keyboard pipeline + the pure gun core): the QA
 * pilot's gunRun() — set-up on the attack axis, a long straight run-in lined up on the target, a
 * gentle push-over (positive g), the CCIP pipper walked onto the target, a burst from ~4,000 ft
 * slant, a safe pull-off (and, if it survived, a second pass) — destroys the vehicle, from the
 * `?spawn=range` start and from a start off to the side; and the A-10's auto-trim leaves it trimmed
 * for cruise, not for the dive.
 */
import { describe, expect, it } from 'vitest';
import { createHeadlessRun } from './qa-pilot.harness';
import type { NewTarget } from '../../src/combat/types';

const RANGE = { x: -1516, z: -5287, headingDeg: 350 };
type GunRunResult = { result: string; fired: boolean; kills: number; pipperErrM: number | null; minAglFt: number; minG: number; minGAttack: number; slantAtFireM: number | null; rounds: number; passes: number };

function spawnRange(bearingFromRangeDeg: number, distM: number) {
  const b = (bearingFromRangeDeg * Math.PI) / 180;
  const x = RANGE.x + Math.sin(b) * distM;
  const z = RANGE.z - Math.cos(b) * distM;
  return { x, z, aglFt: 1500, headingDeg: (bearingFromRangeDeg + 180) % 360, speedKt: 250 };
}

async function gunPass(targets: NewTarget[], start: ReturnType<typeof spawnRange>, o: object = {}, id = 1) {
  const run = createHeadlessRun({ aircraft: 'a10', start, combat: { range: RANGE, targets }, maxSimS: 1500 });
  const res = (await (run.pilot as unknown as { gunRun(id: number, o?: object): Promise<GunRunResult> }).gunRun(id, o)) as GunRunResult;
  return { run, res };
}

describe('QA pilot gunRun (A-10, headless)', () => {
  it('from ?spawn=range (4 km short, pointing at it): a T-72 from behind — pipper on at 4,000 ft, positive g, safe pull-off, destroyed within two passes', async () => {
    const { run, res } = await gunPass([
      { kind: 'tank', position: { x: RANGE.x, y: 0, z: RANGE.z }, headingDeg: 350, group: 'test' },
      { kind: 'truck', position: { x: RANGE.x + 60, y: 0, z: RANGE.z + 30 }, headingDeg: 80, group: 'test' },
    ], spawnRange(170, 4000), { attacks: 2 });
    expect(res.result).toBe('done');
    expect(res.fired).toBe(true);
    expect(res.passes).toBeLessThanOrEqual(2);
    expect(res.kills).toBeGreaterThanOrEqual(1);
    expect(run.world!.targets[0].alive).toBe(false);
    expect(res.pipperErrM!).toBeLessThan(12);
    expect(res.slantAtFireM!).toBeGreaterThan(900);
    expect(res.slantAtFireM!).toBeLessThan(1300);
    expect(res.minGAttack).toBeGreaterThan(0); // push-over, tracking, pull-off: never a negative-g bunt
    expect(res.minG).toBeGreaterThan(-0.5);
    expect(res.minAglFt).toBeGreaterThan(400);
    expect(run.state.phase).not.toBe('crashed');
    // trimmed for the climb-out, not left nose-down from the dive
    expect(Math.abs(run.controls.elevatorTrim)).toBeLessThan(0.4);
  }, 120_000);

  it('from off to the side (west of the range, heading east): a BTR-80, destroyed within two passes', async () => {
    const { run, res } = await gunPass([
      { kind: 'apc', position: { x: RANGE.x + 200, y: 0, z: RANGE.z + 150 }, headingDeg: 90, group: 'test' },
    ], spawnRange(260, 5000), { attacks: 2 });
    expect(res.result).toBe('done');
    expect(res.kills).toBeGreaterThanOrEqual(1);
    expect(run.world!.targets[0].alive).toBe(false);
    expect(res.minGAttack).toBeGreaterThan(0);
    expect(res.minG).toBeGreaterThan(-0.5);
    expect(res.minAglFt).toBeGreaterThan(400);
  }, 120_000);
});
