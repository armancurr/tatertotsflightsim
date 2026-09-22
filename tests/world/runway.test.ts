import { describe, it, expect } from 'vitest';
import { runwayFrame, toRunwayCoords, fromRunwayCoords, isOnRunway } from '../../src/world/runway';

describe('runway frame', () => {
  const rw = runwayFrame();
  it('runway 36 points north with its threshold at the south end', () => {
    expect(rw.dir.x).toBeCloseTo(0);
    expect(rw.dir.z).toBeCloseTo(-1);
    expect(rw.threshold.z).toBeCloseTo(800);
    expect(rw.farEnd.z).toBeCloseTo(-800);
    expect(rw.right.x).toBeCloseTo(1);
  });
  it('converts to and from runway coordinates', () => {
    const c = toRunwayCoords(10, 700);
    expect(c.along).toBeCloseTo(100); // 100 m past the 36 threshold
    expect(c.across).toBeCloseTo(10); // east = right of centreline facing north
    const p = fromRunwayCoords(100, 10);
    expect(p.x).toBeCloseTo(10);
    expect(p.z).toBeCloseTo(700);
  });
  it('knows what is on the runway', () => {
    expect(isOnRunway(0, 0)).toBe(true);
    expect(isOnRunway(14, 799)).toBe(true);
    expect(isOnRunway(16, 0)).toBe(false);
    expect(isOnRunway(0, 801)).toBe(false);
  });
});
