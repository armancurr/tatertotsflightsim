import { describe, it, expect } from 'vitest';
import { airDensity } from '../../src/physics';

describe('atmosphere (ISA density)', () => {
  it('is 1.225 kg/m³ at sea level', () => {
    expect(airDensity(0)).toBeCloseTo(1.225, 4);
  });
  it('matches the ISA table in the troposphere', () => {
    expect(airDensity(1000)).toBeCloseTo(1.1117, 3);
    expect(airDensity(3048)).toBeCloseTo(0.9046, 3); // 10 000 ft
    expect(airDensity(11000)).toBeCloseTo(0.3639, 3);
  });
  it('falls monotonically with altitude and stays positive and finite', () => {
    let prev = Infinity;
    for (let h = -500; h <= 20000; h += 250) {
      const rho = airDensity(h);
      expect(Number.isFinite(rho)).toBe(true);
      expect(rho).toBeGreaterThan(0);
      expect(rho).toBeLessThan(prev);
      prev = rho;
    }
    expect(Number.isFinite(airDensity(NaN))).toBe(true);
  });
});
