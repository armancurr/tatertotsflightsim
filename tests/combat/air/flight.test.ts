import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { CONFIG } from '../../../src/config';
import {
  attitudeQuat, bankFor, G, gLimitedBank, newFlightState, stepFlight, turnRateFor, wrapPi, type FlightCommand, type FlightSpec,
} from '../../../src/combat/air/flight';

const DEG = Math.PI / 180;
const F = CONFIG.combat.air.flight;
const specs: Record<string, FlightSpec> = { fighter: F.fighter, attack: F.attack, helo: F.helo };

const cmd = (o: Partial<FlightCommand> = {}): FlightCommand => ({ turnRate: 0, altitude: 1000, speed: 190, maxBank: 45 * DEG, altitudeTau: 9, ...o });
const nose = (q: { x: number; y: number; z: number; w: number }) => new THREE.Vector3(0, 0, -1).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));
const wing = (q: { x: number; y: number; z: number; w: number }) => new THREE.Vector3(1, 0, 0).applyQuaternion(new THREE.Quaternion(q.x, q.y, q.z, q.w));

describe('air flight: attitude', () => {
  it('matches three.js Euler YXZ (pitch, −heading, −bank)', () => {
    fc.assert(
      fc.property(fc.double({ min: -4, max: 4, noNaN: true }), fc.double({ min: -1.4, max: 1.4, noNaN: true }), fc.double({ min: -1.4, max: 1.4, noNaN: true }), (h, p, b) => {
        const q = attitudeQuat({ x: 0, y: 0, z: 0, w: 1 }, h, p, b);
        const t = new THREE.Quaternion().setFromEuler(new THREE.Euler(p, -h, -b, 'YXZ'));
        expect(Math.abs(q.x * t.x + q.y * t.y + q.z * t.z + q.w * t.w)).toBeCloseTo(1, 9);
      }),
    );
  });

  it('heading 90° level points the nose east; a right bank drops the right wing', () => {
    const q = attitudeQuat({ x: 0, y: 0, z: 0, w: 1 }, 90 * DEG, 0, 0);
    const n = nose(q);
    expect(n.x).toBeCloseTo(1, 9);
    expect(n.z).toBeCloseTo(0, 9);
    const qb = attitudeQuat({ x: 0, y: 0, z: 0, w: 1 }, 0, 0, 30 * DEG);
    expect(wing(qb).y).toBeCloseTo(-0.5, 9);
  });

  it('the velocity points along the heading and path angle', () => {
    const s = newFlightState(0, 1000, 0, 90 * DEG, 200);
    expect(s.velocity.x).toBeCloseTo(200, 6);
    expect(s.velocity.z).toBeCloseTo(0, 6);
  });
});

describe('air flight: coordinated turns', () => {
  it('bank matches the turn rate (ω = g·tanφ/V) through a sustained turn', () => {
    const s = newFlightState(0, 1500, 0, 0, 190);
    const want = 4 * DEG;
    for (let i = 0; i < 600; i++) stepFlight(s, cmd({ turnRate: want, altitude: 1500, maxBank: 60 * DEG }), F.fighter, 1 / 60);
    expect(s.turnRate).toBeCloseTo((G * Math.tan(s.bank)) / s.speed, 9);
    expect(s.bank).toBeCloseTo(bankFor(want, 190), 3);
    expect(s.turnRate).toBeCloseTo(want, 4);
    // Turning right (clockwise seen from above): heading increased ~ 4°/s × (10 s − roll-in).
    expect(wrapPi(s.heading)).toBeGreaterThan(35 * DEG);
    // Right wing down.
    expect(wing(s.orientation).y).toBeLessThan(0);
    // Level turn: load factor 1/cos φ.
    expect(s.load).toBeCloseTo(1 / Math.cos(s.bank), 2);
  });

  it('never banks past the command limit, nor past the g limit in a break', () => {
    const s = newFlightState(0, 2000, 0, 0, 190);
    for (let i = 0; i < 300; i++) stepFlight(s, cmd({ turnRate: 1, maxBank: 45 * DEG, altitude: 2000 }), F.fighter, 1 / 60);
    expect(Math.abs(s.bank)).toBeLessThanOrEqual(45 * DEG + 1e-9);
    for (let i = 0; i < 300; i++) stepFlight(s, cmd({ turnRate: -1, maxBank: 89 * DEG, altitude: 2000 }), F.fighter, 1 / 60);
    expect(s.bank).toBeLessThan(0);
    expect(Math.abs(s.bank)).toBeLessThanOrEqual(gLimitedBank(F.fighter.maxG) + 1e-9);
    expect(1 / Math.cos(s.bank)).toBeLessThanOrEqual(F.fighter.maxG + 1e-6);
  });

  it('rolls no faster than its roll rate', () => {
    const s = newFlightState(0, 2000, 0, 0, 55);
    let prev = s.bank;
    for (let i = 0; i < 120; i++) {
      stepFlight(s, cmd({ turnRate: 1, speed: 55, maxBank: 50 * DEG, altitude: 2000 }), F.helo, 1 / 60);
      expect(Math.abs(s.bank - prev)).toBeLessThanOrEqual((F.helo.rollRateDeg * DEG) / 60 + 1e-9);
      prev = s.bank;
    }
  });

  it('turn radius at the cruise bank is V²/(g tanφ)', () => {
    const V = 190;
    expect(V / turnRateFor(45 * DEG, V)).toBeCloseTo((V * V) / G, 6);
  });
});

describe('air flight: speed and altitude', () => {
  it('speed stays inside the envelope and changes at the accel/decel limits', () => {
    const s = newFlightState(0, 2000, 0, 0, 190);
    stepFlight(s, cmd({ speed: 5000 }), F.fighter, 1);
    expect(s.speed).toBeCloseTo(190 + F.fighter.accel * 0.25, 6); // dt clamped to 0.25 s
    for (let i = 0; i < 600; i++) stepFlight(s, cmd({ speed: 5000, altitude: 2000 }), F.fighter, 0.1);
    expect(s.speed).toBe(F.fighter.max);
    for (let i = 0; i < 600; i++) stepFlight(s, cmd({ speed: 0, altitude: 2000 }), F.fighter, 0.1);
    expect(s.speed).toBe(F.fighter.min);
  });

  it('climbs to a commanded altitude within the climb angle and levels off', () => {
    const s = newFlightState(0, 1000, 0, 0, 165);
    let maxG = 0;
    for (let i = 0; i < 60 * 60; i++) {
      stepFlight(s, cmd({ speed: 165, altitude: 1800, maxBank: 0.5 }), F.attack, 1 / 60);
      maxG = Math.max(maxG, s.gamma);
    }
    expect(maxG).toBeLessThanOrEqual(F.attack.maxClimbDeg * DEG + 1e-9);
    expect(Math.abs(s.y - 1800)).toBeLessThan(5);
    expect(Math.abs(s.gamma)).toBeLessThan(0.01);
    // Jets show angle of attack: nose above the path.
    expect(s.pitch).toBeGreaterThan(s.gamma);
  });

  it('a helicopter flies nose-down at speed', () => {
    const s = newFlightState(0, 200, 0, 0, 55);
    for (let i = 0; i < 120; i++) stepFlight(s, cmd({ speed: 55, altitude: 200, maxBank: 0.4 }), F.helo, 1 / 60);
    expect(s.pitch).toBeLessThan(-3 * DEG);
  });

  it('holds above the floor', () => {
    const s = newFlightState(0, 120, 0, 0, 190);
    for (let i = 0; i < 600; i++) stepFlight(s, cmd({ altitude: -500 }), F.fighter, 1 / 60, () => 100);
    expect(s.y).toBeGreaterThanOrEqual(100);
  });
});

describe('air flight: fuzz', () => {
  it('random commands and time steps: no NaN, inside the envelope, coordinated, above a hilly floor', () => {
    const kinds = Object.keys(specs);
    fc.assert(
      fc.property(
        fc.constantFrom(...kinds),
        fc.array(fc.record({ turn: fc.double({ min: -2, max: 2, noNaN: true }), alt: fc.double({ min: -3000, max: 9000, noNaN: true }), v: fc.double({ min: -100, max: 900 }), bank: fc.double({ min: -1, max: 3 }), dt: fc.double({ min: 0, max: 0.4 }), n: fc.integer({ min: 1, max: 200 }) }), { minLength: 1, maxLength: 25 }),
        (kind, seq) => {
          const spec = specs[kind];
          const s = newFlightState(100, 800, -300, 1, spec.cruise);
          const floor = (x: number, z: number) => 300 + 250 * Math.sin(x / 900) * Math.cos(z / 1300);
          for (const c of seq) {
            for (let i = 0; i < c.n; i++) {
              stepFlight(s, { turnRate: c.turn, altitude: c.alt, speed: c.v, maxBank: c.bank, altitudeTau: 9 }, spec, c.dt, floor);
              for (const v of [s.x, s.y, s.z, s.speed, s.heading, s.gamma, s.bank, s.turnRate, s.orientation.x, s.orientation.w, s.velocity.y]) expect(Number.isFinite(v)).toBe(true);
              expect(s.speed).toBeGreaterThanOrEqual(spec.min);
              expect(s.speed).toBeLessThanOrEqual(spec.max);
              expect(1 / Math.cos(s.bank)).toBeLessThanOrEqual(spec.maxG + 1e-6);
              expect(s.y).toBeGreaterThanOrEqual(floor(s.x, s.z) - 1e-6);
              expect(Math.abs(s.turnRate - turnRateFor(s.bank, s.speed))).toBeLessThan(1e-9);
              const q = s.orientation;
              expect(Math.hypot(q.x, q.y, q.z, q.w)).toBeCloseTo(1, 9);
            }
          }
        },
      ),
      { numRuns: 120 },
    );
  });
});
