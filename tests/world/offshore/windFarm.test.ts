/**
 * The Tater Bank wind farm (src/world/offshore/windFarm.ts): placement (depth 15–45 m, clear of Seal
 * Rock, the islands and every traffic route, inside its box, spacing), the wind the turbines turn in
 * (config sea wind, or env.wind at hub height), yaw into the wind, the rotor-speed curve, and the
 * obstacles (tower, nacelle, the swept disc facing the wind — re-aimed when the wind veers).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CONFIG } from '../../../src/config';
import { TURBINE, createWindFarmPhysics, offshoreWind, rotorRpm, turbineYawDeg, windAtHeight, windFarmLayout, towerRadiusAt, SUBSTATION } from '../../../src/world/offshore/windFarm';
import { getHeightfield } from '../../../src/world/heightfield';
import { getLayout } from '../../../src/world/layout';
import { createSeaPlan } from '../../../src/world/traffic/sea';
import { createEnvironment } from '../../../src/world/environment';
import { routePoints, minDistance } from './helpers';

const hf = getHeightfield();
const { turbines, substation } = windFarmLayout();

describe('wind farm placement', () => {
  it('12–20 turbines in x ∈ [9000, 13500], z ∈ [9600, 12000], each in 15–45 m of water', () => {
    expect(turbines.length).toBeGreaterThanOrEqual(12);
    expect(turbines.length).toBeLessThanOrEqual(20);
    for (const t of turbines) {
      expect(t.x).toBeGreaterThanOrEqual(9000);
      expect(t.x).toBeLessThanOrEqual(13500);
      expect(t.z).toBeGreaterThanOrEqual(9600);
      expect(t.z).toBeLessThanOrEqual(12000);
      const d = -hf.height(t.x, t.z);
      expect(d).toBeGreaterThanOrEqual(15);
      expect(d).toBeLessThanOrEqual(45);
      expect(hf.waterLevel(t.x, t.z)).toBe(0);
    }
    const sd = -hf.height(substation.x, substation.z);
    expect(sd).toBeGreaterThanOrEqual(15);
    expect(sd).toBeLessThanOrEqual(45);
  });

  it('≥ 800 m clear of Seal Rock and away from the other islands; ≥ 3 rotor diameters between turbines (in the grid) and ≥ 1 D to the substation', () => {
    const rock = getLayout().islands.find((i) => i.name === 'Seal Rock')!;
    for (const t of turbines) {
      expect(Math.hypot(t.x - rock.x, t.z - rock.z) - rock.radius - TURBINE.rotorRadius).toBeGreaterThanOrEqual(800 - TURBINE.rotorRadius);
      for (const isl of getLayout().islands) expect(Math.hypot(t.x - isl.x, t.z - isl.z) - isl.radius).toBeGreaterThanOrEqual(800);
      for (const u of turbines) if (u !== t) expect(Math.hypot(t.x - u.x, t.z - u.z)).toBeGreaterThanOrEqual(3 * 2 * TURBINE.rotorRadius - 1);
      expect(Math.hypot(t.x - substation.x, t.z - substation.z)).toBeGreaterThan(2 * TURBINE.rotorRadius);
    }
  });

  it('clear of every traffic route by ≥ 1.5 km', () => {
    const pts = routePoints(createSeaPlan(getLayout(), createEnvironment()));
    for (const t of [...turbines, substation]) expect(minDistance(pts, t.x, t.z)).toBeGreaterThanOrEqual(1500);
  });
});

describe('wind, yaw and rotor speed', () => {
  it('uses the sea wind from config (from 215°, 12 kt) raised to hub height', () => {
    const w = offshoreWind(null);
    expect(w.fromDeg).toBe(CONFIG.world.water.windFromDeg);
    expect(w.speed10).toBeCloseTo(CONFIG.world.water.windKt * 0.514444, 4);
    expect(w.speedHub).toBeGreaterThan(w.speed10 * 1.3);
    expect(w.speedHub).toBeCloseTo(windAtHeight(w.speed10, 150), 9);
  });

  it('follows env.wind (the direction the air moves TOWARD) when there is one; calm falls back to config', () => {
    // air moving toward the north-east (+x, −z) blows FROM the south-west (225°)
    const env = { wind: () => ({ x: 7, y: 0, z: -7 }) };
    const w = offshoreWind(env);
    expect(w.fromDeg).toBeCloseTo(225, 6);
    expect(w.speedHub).toBeCloseTo(Math.hypot(7, 7), 6);
    const calm = offshoreWind({ wind: () => ({ x: 0, y: 0, z: 0 }) });
    expect(calm.fromDeg).toBe(CONFIG.world.water.windFromDeg);
    fc.assert(fc.property(fc.double({ min: 0, max: 359.99, noNaN: true }), fc.double({ min: 1, max: 30, noNaN: true }), (from, v) => {
      const to = ((from + 180) * Math.PI) / 180;
      const r = offshoreWind({ wind: () => ({ x: Math.sin(to) * v, y: 0, z: -Math.cos(to) * v }) });
      const d = Math.abs(((r.fromDeg - from + 540) % 360) - 180);
      expect(d).toBeLessThan(1e-6);
      // the rotor faces the wind's source
      expect(turbineYawDeg(r.fromDeg)).toBeCloseTo(r.fromDeg, 6);
    }));
  });

  it('rotor speed: idle below cut-in, tip-speed ratio control, capped at rated, feathered above cut-out', () => {
    expect(rotorRpm(0)).toBe(0);
    expect(rotorRpm(2.9)).toBe(0);
    expect(rotorRpm(25)).toBe(0);
    expect(rotorRpm(NaN)).toBe(0);
    expect(rotorRpm(14)).toBe(TURBINE.ratedRpm);
    let prev = 0;
    for (let v = 3; v < 25; v += 0.5) {
      const r = rotorRpm(v);
      expect(r).toBeGreaterThanOrEqual(prev);
      expect(r).toBeLessThanOrEqual(TURBINE.ratedRpm);
      expect(r).toBeGreaterThanOrEqual(TURBINE.minRpm);
      prev = r;
    }
    // the configured sea breeze turns them at ~5–7 rpm (a blade tip at ~60–80 m/s)
    const r = rotorRpm(offshoreWind(null).speedHub);
    expect(r).toBeGreaterThan(5);
    expect(r).toBeLessThan(7);
    expect(rotorRpm(8)).toBeGreaterThan(rotorRpm(5));
  });
});

describe('turbine obstacles', () => {
  const phys = createWindFarmPhysics(215);
  const t = turbines[5];
  const toward = (deg: number) => ({ x: Math.sin((deg * Math.PI) / 180), z: -Math.cos((deg * Math.PI) / 180) });

  it('the tower is solid to the nacelle roof; open sea between turbines is clear', () => {
    expect(phys.obstacleTop(t.x, t.z)).toBeGreaterThanOrEqual(TURBINE.hubHeight + TURBINE.nacelle.height / 2);
    expect(phys.obstacleTop(t.x + 300, t.z + 300)).toBe(-Infinity);
    expect(phys.obstacleTop(0, 0)).toBe(-Infinity);
    expect(towerRadiusAt(0)).toBe(TURBINE.tpR);
    expect(towerRadiusAt(TURBINE.hubHeight)).toBeCloseTo(TURBINE.towerTopR, 6);
  });

  it('the swept disc stands across the wind, upwind of the tower, its rim at hub ± √(R² − s²)', () => {
    const f = toward(215);
    const across = { x: -f.z, z: f.x };
    const R = TURBINE.rotorRadius;
    for (const s of [30, 80, 105]) {
      const x = t.x + f.x * TURBINE.overhang + across.x * s;
      const z = t.z + f.z * TURBINE.overhang + across.z * s;
      expect(phys.obstacleTop(x, z)).toBeCloseTo(TURBINE.hubHeight + Math.sqrt(R * R - s * s), 6);
    }
    // 60 m along the wind from the tower (behind or in front of the disc): clear
    expect(phys.obstacleTop(t.x + f.x * 60, t.z + f.z * 60)).toBe(-Infinity);
    expect(phys.obstacleTop(t.x - f.x * 60, t.z - f.z * 60)).toBe(-Infinity);
    // beyond the tip: clear
    expect(phys.obstacleTop(t.x + f.x * TURBINE.overhang + across.x * (R + 5), t.z + f.z * TURBINE.overhang + across.z * (R + 5))).toBe(-Infinity);
  });

  it('the disc turns with the wind (setWindFrom)', () => {
    const p = createWindFarmPhysics(215);
    const f = toward(215);
    const across = { x: -f.z, z: f.x };
    const x = t.x + f.x * TURBINE.overhang + across.x * 90;
    const z = t.z + f.z * TURBINE.overhang + across.z * 90;
    expect(p.obstacleTop(x, z)).toBeGreaterThan(TURBINE.hubHeight);
    p.setWindFrom(215 + 90);
    expect(p.obstacleTop(x, z)).toBe(-Infinity);
  });

  it('the substation is a block to its top', () => {
    expect(phys.obstacleTop(substation.x, substation.z)).toBe(SUBSTATION.top);
  });
});
