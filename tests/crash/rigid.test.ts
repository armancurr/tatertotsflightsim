/**
 * The crash debris simulation (src/crash/rigid.ts): rigid boxes with gravity, bounce, Coulomb
 * friction, tumbling, compound attachments that shear off, water and tree canopies.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { DebrisWorld, FREE, ASLEEP, ATTACHED, SUNK, EV_DETACH, EV_GROUND, EV_WATER, type DebrisEnv } from '../../src/crash/rigid';
import { CONFIG } from '../../src/config';

const D = CONFIG.crash.debris;
const flat = (h = 0): DebrisEnv => ({ groundHeight: () => h });
const noDrag = { ...D, airDrag: 0, spinDrag: 0 };
const run = (w: DebrisWorld, env: DebrisEnv, seconds: number, dt = 1 / 60) => {
  for (let t = 0; t < seconds - 1e-9; t += dt) w.step(dt, env);
};
const speed = (w: DebrisWorld, i: number) => Math.hypot(w.vx[i], w.vy[i], w.vz[i]);
const spin = (w: DebrisWorld, i: number) => Math.hypot(w.wx[i], w.wy[i], w.wz[i]);
const cube = { hx: 0.5, hy: 0.5, hz: 0.5 };

describe('DebrisWorld: free flight', () => {
  it('falls with gravity (no drag): y = y0 − g t²/2', () => {
    const w = new DebrisWorld(4, noDrag);
    const i = w.add({ x: 0, y: 100, z: 0, mass: 50, ...cube });
    run(w, flat(), 1);
    expect(w.py[i]).toBeCloseTo(100 - 0.5 * D.gravity, 1);
    expect(w.vy[i]).toBeCloseTo(-D.gravity, 1);
  });
  it('spins about its angular velocity with a unit quaternion', () => {
    const w = new DebrisWorld(4, noDrag);
    const i = w.add({ x: 0, y: 500, z: 0, mass: 50, ...cube, wy: 2 });
    run(w, flat(), 1);
    expect(Math.hypot(w.qx[i], w.qy[i], w.qz[i], w.qw[i])).toBeCloseTo(1, 6);
    const yaw = 2 * Math.atan2(w.qy[i], w.qw[i]);
    expect(yaw).toBeCloseTo(2, 1);
  });
  it('keeps its momentum: a part thrown forward keeps moving forward', () => {
    const w = new DebrisWorld(4, noDrag);
    const i = w.add({ x: 0, y: 200, z: 0, mass: 50, ...cube, vz: -40 });
    run(w, flat(), 1);
    expect(w.pz[i]).toBeCloseTo(-40, 0);
  });
});

describe('DebrisWorld: ground contact', () => {
  it('bounces with its restitution', () => {
    const w = new DebrisWorld(4, noDrag);
    const i = w.add({ x: 0, y: 12.5, z: 0, mass: 40, ...cube, restitution: 0.5, friction: 0.5 });
    let vIn = 0;
    let vOut = 0;
    for (let k = 0; k < 400; k++) {
      const before = w.vy[i];
      w.step(1 / 240, flat());
      if (before < -5 && w.vy[i] > 0) {
        vIn = -before;
        vOut = w.vy[i];
        break;
      }
    }
    expect(vIn).toBeGreaterThan(10);
    expect(vOut / vIn).toBeGreaterThan(0.4);
    expect(vOut / vIn).toBeLessThan(0.6);
  });
  it('slides to rest with Coulomb friction (≈ v²/2μg) and falls asleep', () => {
    const w = new DebrisWorld(4, noDrag);
    const i = w.add({ x: 0, y: 0.5, z: 0, mass: 200, hx: 1, hy: 0.5, hz: 2, vz: -12, friction: 0.5, restitution: 0.1 });
    run(w, flat(), 8);
    const dist = -w.pz[i];
    const ideal = (12 * 12) / (2 * 0.5 * D.gravity);
    expect(dist).toBeGreaterThan(ideal * 0.6);
    expect(dist).toBeLessThan(ideal * 1.15);
    expect(w.state[i]).toBe(ASLEEP);
    expect(speed(w, i)).toBe(0);
  });
  it('a wing hitting the ground tip-first cartwheels (the strike spins it)', () => {
    const w = new DebrisWorld(4, noDrag);
    // a 5 m wing, rolled 30°, moving forward and down
    const a = (30 * Math.PI) / 180;
    const i = w.add({ x: 0, y: 2.0, z: 0, qx: 0, qy: 0, qz: Math.sin(a / 2), qw: Math.cos(a / 2), mass: 60, hx: 2.5, hy: 0.08, hz: 0.7, vz: -25, vy: -6, friction: 0.7, restitution: 0.3 });
    expect(spin(w, i)).toBe(0);
    let maxSpin = 0;
    for (let k = 0; k < 60; k++) {
      w.step(1 / 60, flat());
      maxSpin = Math.max(maxSpin, spin(w, i));
    }
    expect(maxSpin).toBeGreaterThan(2);
  });
  it('rests on a slope when friction holds it and never sinks into the ground', () => {
    const w = new DebrisWorld(4, D);
    const slope = 0.3; // ~17°
    const env: DebrisEnv = { groundHeight: (x) => x * slope };
    const i = w.add({ x: 0, y: 3, z: 0, mass: 100, hx: 1, hy: 0.4, hz: 1.5, friction: 0.7, restitution: 0.2 });
    run(w, env, 10);
    expect(w.state[i]).toBe(ASLEEP);
    expect(w.minClearance(i, env)).toBeGreaterThanOrEqual(-1e-6);
    expect(Math.abs(w.px[i])).toBeLessThan(6);
  });
  it('reports hard ground hits as events', () => {
    const w = new DebrisWorld(4, D);
    w.add({ x: 0, y: 3, z: 0, mass: 100, ...cube, vy: -15 });
    let hits = 0;
    for (let k = 0; k < 30; k++) {
      w.step(1 / 60, flat());
      for (let e = 0; e < w.events.count; e++) if (w.events.type[e] === EV_GROUND) hits++;
    }
    expect(hits).toBeGreaterThan(0);
  });
});

describe('DebrisWorld: attachments (parts shed during a slide)', () => {
  it('an attached part rides rigidly with its parent', () => {
    const w = new DebrisWorld(4, noDrag);
    const core = w.add({ x: 0, y: 50, z: 0, mass: 400, hx: 0.6, hy: 0.7, hz: 3, vz: -20, wy: 0.5 });
    const wing = w.add({ x: 3, y: 50.5, z: 0, mass: 60, hx: 2.5, hy: 0.08, hz: 0.7, vz: -20 });
    w.attach(wing, core);
    expect(w.state[wing]).toBe(ATTACHED);
    const d0 = Math.hypot(w.px[wing] - w.px[core], w.py[wing] - w.py[core], w.pz[wing] - w.pz[core]);
    run(w, flat(-1000), 1);
    const d1 = Math.hypot(w.px[wing] - w.px[core], w.py[wing] - w.py[core], w.pz[wing] - w.pz[core]);
    expect(d1).toBeCloseTo(d0, 5);
    expect(w.pz[wing]).toBeLessThan(-15);
  });
  it('sheds a part at its scheduled time with the parent velocity at that point', () => {
    const w = new DebrisWorld(4, noDrag);
    const core = w.add({ x: 0, y: 50, z: 0, mass: 400, hx: 0.6, hy: 0.7, hz: 3, vz: -20 });
    const tail = w.add({ x: 0, y: 50.5, z: 4, mass: 30, hx: 1.5, hy: 0.6, hz: 0.6, vz: -20 });
    w.attach(tail, core);
    w.scheduleDetach(tail, 0.5, Infinity);
    let detached = false;
    for (let k = 0; k < 60; k++) {
      w.step(1 / 60, flat(-1000));
      for (let e = 0; e < w.events.count; e++) if (w.events.type[e] === EV_DETACH && w.events.body[e] === tail) detached = true;
    }
    expect(detached).toBe(true);
    expect(w.state[tail]).toBe(FREE);
    expect(w.vz[tail]).toBeLessThan(-15);
  });
  it('a hard strike on an attached wing shears it off', () => {
    const w = new DebrisWorld(4, D);
    const a = (25 * Math.PI) / 180;
    const core = w.add({ x: 0, y: 3, z: 0, qz: Math.sin(a / 2), qw: Math.cos(a / 2), mass: 500, hx: 0.6, hy: 0.7, hz: 3, vz: -30, vy: -8 });
    const wing = w.add({ x: -3.5 * Math.cos(a), y: 3 - 3.5 * Math.sin(a), z: 0, qz: Math.sin(a / 2), qw: Math.cos(a / 2), mass: 60, hx: 2.8, hy: 0.08, hz: 0.7, vz: -30, vy: -8 });
    w.attach(wing, core);
    w.scheduleDetach(wing, Infinity, 60 * 4);
    run(w, flat(), 1);
    expect(w.state[wing]).not.toBe(ATTACHED);
  });
  it('the compound (parent + attached parts) never sinks below the ground', () => {
    const w = new DebrisWorld(4, D);
    const core = w.add({ x: 0, y: 1.5, z: 0, mass: 500, hx: 0.6, hy: 0.7, hz: 3, vz: -30, vy: -3 });
    const wing = w.add({ x: 3, y: 1.0, z: 0, mass: 60, hx: 2.5, hy: 0.08, hz: 0.7, vz: -30, vy: -3 });
    w.attach(wing, core);
    for (let k = 0; k < 240; k++) {
      w.step(1 / 60, flat());
      expect(w.minClearance(core, flat())).toBeGreaterThanOrEqual(-1e-6);
      expect(w.minClearance(wing, flat())).toBeGreaterThanOrEqual(-1e-6);
    }
  });
});

describe('DebrisWorld: water and trees', () => {
  const sea: DebrisEnv = { groundHeight: () => -30, waterLevel: () => 0 };
  it('a light part slaps into the water, floats for a while, then floods and sinks', () => {
    const w = new DebrisWorld(4, D);
    const i = w.add({ x: 0, y: 3, z: 0, mass: 80, hx: 2.5, hy: 0.1, hz: 0.7, vy: -12, vz: -20, float: 1.5, floodTime: 8 });
    let splash = false;
    for (let k = 0; k < 120; k++) {
      w.step(1 / 60, sea);
      for (let e = 0; e < w.events.count; e++) if (w.events.type[e] === EV_WATER) splash = true;
    }
    expect(splash).toBe(true);
    expect(w.inWater[i]).toBe(1);
    expect(w.py[i]).toBeGreaterThan(-1.5); // floating at 2 s
    expect(speed(w, i)).toBeLessThan(8); // water drag
    run(w, sea, 40);
    expect(w.state[i]).toBe(SUNK);
  });
  it('a heavy engine sinks at once', () => {
    const w = new DebrisWorld(4, D);
    const i = w.add({ x: 0, y: 2, z: 0, mass: 150, hx: 0.4, hy: 0.4, hz: 0.5, vy: -10, float: 0 });
    run(w, sea, 6);
    expect(w.py[i]).toBeLessThan(-D.sinkDepth);
    expect(w.state[i]).toBe(SUNK);
  });
  it('tree canopies slow parts down more than open air', () => {
    const open = new DebrisWorld(2, D);
    const wood = new DebrisWorld(2, D);
    const a = open.add({ x: 0, y: 12, z: 0, mass: 60, ...cube, vz: -30 });
    const b = wood.add({ x: 0, y: 12, z: 0, mass: 60, ...cube, vz: -30 });
    run(open, flat(-100), 0.5);
    run(wood, { groundHeight: () => -100, obstacleTop: () => 15 }, 0.5);
    expect(speed(wood, b)).toBeLessThan(speed(open, a) * 0.75);
  });
});

describe('DebrisWorld: pool', () => {
  it('holds at most its capacity; clear empties it', () => {
    const w = new DebrisWorld(3, D);
    expect(w.add({ x: 0, y: 1, z: 0, mass: 1, ...cube })).toBe(0);
    expect(w.add({ x: 0, y: 1, z: 0, mass: 1, ...cube })).toBe(1);
    expect(w.add({ x: 0, y: 1, z: 0, mass: 1, ...cube })).toBe(2);
    expect(w.add({ x: 0, y: 1, z: 0, mass: 1, ...cube })).toBe(-1);
    expect(w.count).toBe(3);
    w.clear();
    expect(w.count).toBe(0);
    expect(w.add({ x: 0, y: 1, z: 0, mass: 1, ...cube })).toBe(0);
  });
  it('sanitises garbage inputs', () => {
    const w = new DebrisWorld(3, D);
    const i = w.add({ x: Number.NaN, y: Infinity, z: 0, mass: -5, hx: Number.NaN, hy: 0, hz: -1, vx: Number.NaN, wy: 1e9 });
    run(w, flat(), 1);
    for (const a of [w.px, w.py, w.pz, w.vx, w.vy, w.vz, w.qx, w.qy, w.qz, w.qw, w.wx, w.wy, w.wz]) expect(Number.isFinite(a[i])).toBe(true);
  });
  it('step allocates nothing: the same typed arrays before and after', () => {
    const w = new DebrisWorld(3, D);
    const arrs = [w.px, w.vx, w.qx, w.state, w.events.type];
    w.add({ x: 0, y: 5, z: 0, mass: 10, ...cube, vy: -10 });
    run(w, flat(), 2);
    expect([w.px, w.vx, w.qx, w.state, w.events.type]).toEqual(arrs);
  });
});

// ── Fuzz ────────────────────────────────────────────────────────────────────
/** Rolling terrain with slopes ≤ ~30°. */
const terrain = (a: number, b: number, c: number): DebrisEnv => ({
  groundHeight: (x, z) => a * Math.sin(x * 0.05 + c) * 4 + b * Math.cos(z * 0.07 - c) * 3 + 0.1 * x * a,
});
const body = fc.record({
  x: fc.double({ min: -20, max: 20, noNaN: true }),
  y: fc.double({ min: 0, max: 40, noNaN: true }),
  z: fc.double({ min: -20, max: 20, noNaN: true }),
  vx: fc.double({ min: -60, max: 60, noNaN: true }),
  vy: fc.double({ min: -60, max: 30, noNaN: true }),
  vz: fc.double({ min: -80, max: 80, noNaN: true }),
  wx: fc.double({ min: -10, max: 10, noNaN: true }),
  wy: fc.double({ min: -10, max: 10, noNaN: true }),
  wz: fc.double({ min: -10, max: 10, noNaN: true }),
  ax: fc.double({ min: -1, max: 1, noNaN: true }),
  ay: fc.double({ min: -1, max: 1, noNaN: true }),
  az: fc.double({ min: -1, max: 1, noNaN: true }),
  mass: fc.double({ min: 5, max: 800, noNaN: true }),
  hx: fc.double({ min: 0.1, max: 3, noNaN: true }),
  hy: fc.double({ min: 0.05, max: 1, noNaN: true }),
  hz: fc.double({ min: 0.1, max: 4, noNaN: true }),
  restitution: fc.double({ min: 0, max: 0.6, noNaN: true }),
  friction: fc.double({ min: 0.6, max: 1, noNaN: true }),
  attach: fc.boolean(),
});

describe('DebrisWorld: fuzz', () => {
  it('random impacts on random terrain: never NaN, never below the ground, energy only drains, everything comes to rest', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: -1, max: 1, noNaN: true }),
        fc.double({ min: 0, max: 6, noNaN: true }),
        fc.array(body, { minLength: 1, maxLength: 6 }),
        fc.array(fc.double({ min: 1 / 240, max: 0.1, noNaN: true }), { minLength: 1, maxLength: 5 }),
        (a, b, c, bodies, dts) => {
          const env = terrain(a, b, c);
          const w = new DebrisWorld(8, D);
          for (const s of bodies) {
            const n = Math.hypot(s.ax, s.ay, s.az) || 1;
            const ang = n; // rotation angle = |axis| (≤ √3 rad)
            const k = Math.sin(ang / 2) / n;
            const g = env.groundHeight(s.x, s.z);
            const i = w.add({ ...s, y: g + Math.max(s.hx, s.hy, s.hz) * 1.8 + s.y, qx: s.ax * k, qy: s.ay * k, qz: s.az * k, qw: Math.cos(ang / 2) });
            if (s.attach && i > 0) w.attach(i, 0);
          }
          // initial overlap may be pushed out once: measure energy after the first tiny step
          w.step(1e-4, env);
          const e0 = w.energy();
          const w0 = w.pushWork;
          // energy may only rise by the work of pushing bodies out of the ground (plus the tumbling
          // integrator's round-off: 0.5 % of the initial kinetic energy)
          const k0 = w.kinetic();
          const tol = () => w.pushWork - w0 + 0.005 * k0 + 1e-6 * Math.abs(e0) + 0.5;
          let t = 0;
          let k = 0;
          while (t < 70) {
            const dt = dts[k++ % dts.length];
            w.step(dt, env);
            t += dt;
            for (let i = 0; i < w.count; i++) {
              for (const arr of [w.px, w.py, w.pz, w.vx, w.vy, w.vz, w.qx, w.qy, w.qz, w.qw, w.wx, w.wy, w.wz]) {
                if (!Number.isFinite(arr[i])) throw new Error(`NaN in body ${i} at t=${t}`);
              }
              const cl = w.minClearance(i, env);
              if (cl < -1e-6) throw new Error(`body ${i} ${cl.toFixed(4)} m below the ground at t=${t}`);
            }
            const e = w.energy();
            if (e > e0 + tol()) throw new Error(`energy rose ${e0} → ${e} (push-out work ${w.pushWork - w0}) at t=${t}`);
            if (w.allAtRest()) break;
          }
          expect(w.allAtRest()).toBe(true);
          expect(w.energy()).toBeLessThan(e0 + tol());
        },
      ),
      { numRuns: 60 },
    );
  }, 60000);
});
