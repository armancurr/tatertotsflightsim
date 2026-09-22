import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { getLayout } from '../../../src/world/layout';
import { terrainHeight } from '../../../src/world/heightfield';
import { toRunwayCoords } from '../../../src/world/runway';
import { CONFIG } from '../../../src/config';
import {
  buildCircuit, createCircuitState, stepCircuit, circuitPose, newAirPose, keepClear, crossingTrack, crossingPose, airlinerTrack, airlinerPose, contrailPoint,
  buildHeliRoute, heliPose, createScheduler, runwayOccupiedByPlayer, CROSS_HALF, GEAR_HEIGHT, type LegName, type PlayerRef, type CircuitState,
} from '../../../src/world/traffic/air';
import { samplePath, newPathSample } from '../../../src/world/traffic/path';

const layout = getLayout();
const rw = layout.airport.runway;
const E = rw.elevation;
const FT = 0.3048;
const PA = CONFIG.world.traffic.air.patternAltitudeFt * FT;
const R_CLEAR = CONFIG.world.traffic.playerClearance;

describe('circuit geometry (left-hand traffic, runway 36)', () => {
  const cl = buildCircuit(layout, CONFIG, 'c172');
  const smp = newPathSample();

  it('every leg is finite, near the airfield and at sane heights', () => {
    for (const [name, p] of Object.entries(cl.legs)) {
      for (let s = 0; s <= p.length; s += 5) {
        samplePath(p, s, smp);
        for (const k of ['x', 'y', 'z', 'heading', 'curvature', 'grade', 'speed'] as const) expect(Number.isFinite(smp[k]), `${name}.${k}`).toBe(true);
        expect(smp.y).toBeGreaterThanOrEqual(E + GEAR_HEIGHT.c172 - 0.01);
        expect(smp.y).toBeLessThanOrEqual(E + PA + 1);
        expect(Math.hypot(smp.x - rw.center.x, smp.z - rw.center.z)).toBeLessThan(4500);
        expect(smp.speed).toBeGreaterThan(0);
        expect(smp.speed).toBeLessThan(55);
      }
      expect(p.duration, name).toBeGreaterThan(5);
      expect(Number.isFinite(p.duration)).toBe(true);
    }
  });

  it('downwind is flown at 1,000 ft AGL on the west side, heading south', () => {
    const p = cl.legs.down;
    for (let s = 0; s <= p.length; s += 50) {
      samplePath(p, s, smp);
      expect(smp.y - E).toBeCloseTo(PA, 0);
      const c = toRunwayCoords(smp.x, smp.z, rw);
      expect(c.across).toBeCloseTo(-CONFIG.world.traffic.air.downwindOffset, 0);
      expect(smp.heading).toBeCloseTo(180, 0);
    }
  });

  it('circuit turns are all to the left; final is aligned with runway 36 and lands on the runway', () => {
    for (const name of ['up', 'final'] as const) {
      const p = cl.legs[name];
      for (let s = 0; s <= p.length; s += 5) expect(samplePath(p, s, smp).curvature, name).toBeLessThanOrEqual(1e-4);
    }
    const tng = cl.legs.tng;
    const ground = cl.ground.tng!;
    expect(ground.length).toBe(1);
    for (let s = ground[0][0]; s <= ground[0][1]; s += 5) {
      samplePath(tng, s, smp);
      const c = toRunwayCoords(smp.x, smp.z, rw);
      expect(c.along).toBeGreaterThan(150); // touchdown well past the threshold
      expect(c.along).toBeLessThan(rw.length);
      expect(Math.abs(c.across)).toBeLessThan(1);
      expect(Math.abs(smp.heading - rw.headingDeg % 360) < 1 || Math.abs(smp.heading - 360) < 1).toBe(true);
    }
    // glide: descending through the final at roughly 3–5°
    samplePath(cl.legs.final, cl.legs.final.length - 5, smp);
    const glide = (-Math.atan(smp.grade) * 180) / Math.PI;
    expect(glide).toBeGreaterThan(2.5);
    expect(glide).toBeLessThan(5.5);
  });

  it('legs join end-to-start (position and heading continuous)', () => {
    const joins: [LegName, LegName][] = [['up', 'down'], ['down', 'final'], ['final', 'tng'], ['final', 'full'], ['final', 'ga'], ['tng', 'up'], ['to', 'up'], ['ga', 'down'], ['orbit', 'down']];
    const a = newPathSample();
    const b = newPathSample();
    for (const [x, y] of joins) {
      const px = cl.legs[x as 'up'];
      const py = cl.legs[y as 'up'];
      samplePath(px, px.length, a);
      samplePath(py, 0, b);
      expect(Math.hypot(a.x - b.x, a.z - b.z), `${x}→${y}`).toBeLessThan(1);
      expect(Math.abs(a.y - b.y), `${x}→${y} y`).toBeLessThan(1);
      const dh = Math.abs(((a.heading - b.heading + 540) % 360) - 180);
      expect(dh, `${x}→${y} heading`).toBeLessThan(6);
    }
    samplePath(cl.legs.full, cl.legs.full.length, a);
    expect(Math.hypot(a.x - cl.hold.x, a.z - cl.hold.z)).toBeLessThan(1);
    samplePath(cl.legs.to, 0, b);
    expect(Math.hypot(b.x - cl.hold.x, b.z - cl.hold.z)).toBeLessThan(1);
  });

  it('the go-around side-steps: never within the clearance of an aircraft waiting at the threshold', () => {
    const player = { x: rw.threshold.x + rw.dir.x * 45, y: E + 1.2, z: rw.threshold.z + rw.dir.z * 45 };
    for (const name of ['final', 'ga', 'up', 'down', 'orbit'] as const) {
      const p = cl.legs[name];
      for (let s = 0; s <= p.length; s += 5) {
        samplePath(p, s, smp);
        expect(Math.hypot(smp.x - player.x, smp.y - player.y, smp.z - player.z), `${name} @${s}`).toBeGreaterThan(R_CLEAR);
      }
    }
  });
});

function run(st: CircuitState, seconds: number, player: PlayerRef | null, dt = 1 / 60, each?: (st: CircuitState) => void) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    stepCircuit(st, dt, player);
    each?.(st);
  }
}

describe('circuit state machine (functional)', () => {
  it('flies touch-and-goes, full stops with taxi-back and take-offs over two hours, never NaN, never two on the runway', () => {
    const st = createCircuitState(layout);
    const seen = new Set<LegName>();
    const pose = newAirPose();
    let minSep = Infinity;
    let minMixed = Infinity;
    let minGround = Infinity;
    const poses = st.aircraft.map(() => newAirPose());
    run(st, 7200, null, 0.1, (s) => {
      let onRunway = 0;
      s.aircraft.forEach((a, i) => {
        seen.add(a.leg);
        circuitPose(s, a, poses[i]);
        const p = poses[i];
        for (const k of ['x', 'y', 'z', 'heading', 'pitch', 'roll'] as const) expect(Number.isFinite(p[k])).toBe(true);
        expect(Math.abs(p.roll)).toBeLessThanOrEqual(35);
        expect(p.y).toBeGreaterThanOrEqual(E + 1);
        const c = toRunwayCoords(p.x, p.z, rw);
        if (p.onGround && Math.abs(c.across) < rw.halfWidth && c.along > -5 && c.along < rw.length + 5) onRunway++;
      });
      expect(onRunway).toBeLessThanOrEqual(1);
      for (let i = 0; i < poses.length; i++)
        for (let j = i + 1; j < poses.length; j++) {
          const d = Math.hypot(poses[i].x - poses[j].x, poses[i].y - poses[j].y, poses[i].z - poses[j].z);
          if (!poses[i].onGround && !poses[j].onGround) minSep = Math.min(minSep, d);
          else if (poses[i].onGround && poses[j].onGround) minGround = Math.min(minGround, d); // taxi queue
          else minMixed = Math.min(minMixed, d); // e.g. landing traffic passing over the hold-short line
        }
    });
    for (const leg of ['up', 'down', 'final', 'tng', 'full', 'hold', 'to'] as LegName[]) expect(seen.has(leg), leg).toBe(true);
    expect(st.aircraft.reduce((n, a) => n + a.laps, 0)).toBeGreaterThan(20);
    expect(minSep).toBeGreaterThan(150);
    expect(minMixed).toBeGreaterThan(25);
    expect(minGround).toBeGreaterThan(15);
    void pose;
  });

  it('goes around (and never comes within the clearance) while the player sits at the runway 36 threshold', () => {
    const st = createCircuitState(layout);
    const player: PlayerRef = { x: rw.threshold.x + rw.dir.x * 45, y: E + 1.2, z: rw.threshold.z + rw.dir.z * 45, agl: 0 };
    expect(runwayOccupiedByPlayer(rw, player)).toBe(true);
    const p = newAirPose();
    const legs = new Set<LegName>();
    run(st, 3600, player, 0.1, (s) => {
      for (const a of s.aircraft) {
        legs.add(a.leg);
        circuitPose(s, a, p);
        expect(Math.hypot(p.x - player.x, p.y - player.y, p.z - player.z)).toBeGreaterThan(R_CLEAR);
      }
    });
    expect(legs.has('ga')).toBe(true);
    expect(legs.has('tng')).toBe(false);
    expect(legs.has('full')).toBe(false);
  });

  it('is deterministic and independent of the frame rate', () => {
    const a = createCircuitState(layout);
    const b = createCircuitState(layout);
    run(a, 900, null, 1 / 60);
    // b at another frame rate, up to exactly the same number of fixed steps
    while (b.time < a.time - 1e-6) stepCircuit(b, 1 / 144, null);
    expect(b.time).toBeCloseTo(a.time, 6);
    expect(a.aircraft.map((x) => [x.leg, Math.round(x.t * 100)])).toEqual(b.aircraft.map((x) => [x.leg, Math.round(x.t * 100)]));
  });

  it('fuzz: random player wandering and frame times never break the circuit', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ x: fc.double({ min: -4000, max: 4000, noNaN: true }), z: fc.double({ min: -4000, max: 4000, noNaN: true }), agl: fc.double({ min: 0, max: 800, noNaN: true }), dt: fc.double({ min: 0, max: 0.25, noNaN: true }), hold: fc.integer({ min: 1, max: 3000 }) }), { minLength: 1, maxLength: 6 }),
        (segs) => {
          const st = createCircuitState(layout);
          const p = newAirPose();
          for (const sg of segs) {
            const player: PlayerRef = { x: sg.x, y: E + sg.agl, z: sg.z, agl: sg.agl };
            for (let i = 0; i < sg.hold; i++) stepCircuit(st, sg.dt, player);
            for (const a of st.aircraft) {
              circuitPose(st, a, p);
              for (const k of ['x', 'y', 'z', 'heading', 'pitch', 'roll', 'speed'] as const) expect(Number.isFinite(p[k])).toBe(true);
              expect(p.y).toBeGreaterThan(E);
              expect(p.y).toBeLessThan(E + PA + 5);
              expect(Math.hypot(p.x, p.z)).toBeLessThan(5000);
            }
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});

describe('crossing GA, helicopter, airliners', () => {
  const seed = CONFIG.world.traffic.seed;

  it('fuzz: crossing tracks start far away, pass ≥ 700 m from the anchor, at 2,500–6,500 ft or 1,500 ft above the terrain', () => {
    fc.assert(
      fc.property(fc.nat({ max: 7 }), fc.nat({ max: 10000 }), fc.double({ min: -30000, max: 30000, noNaN: true }), fc.double({ min: -30000, max: 20000, noNaN: true }), (slot, cycle, ax, az) => {
        const c = crossingTrack(seed, slot, cycle, { x: ax, z: az }, 100, terrainHeight);
        expect(Math.hypot(c.x0 - ax, c.z0 - az)).toBeGreaterThan(CROSS_HALF - 1);
        expect(Math.hypot(c.dx, c.dz)).toBeCloseTo(1, 9);
        // closest approach
        const t = (ax - c.x0) * c.dx + (az - c.z0) * c.dz;
        const miss = Math.hypot(c.x0 + c.dx * t - ax, c.z0 + c.dz * t - az);
        expect(miss).toBeGreaterThan(690);
        expect(c.y).toBeGreaterThanOrEqual(2500 * FT - 1);
        const p = crossingPose(c, 100 + c.duration * 0.5, newAirPose());
        expect(p.y - terrainHeight(p.x, p.z)).toBeGreaterThan(1400 * FT);
        for (let k = 0; k <= 40; k++) {
          const q = crossingPose(c, 100 + (c.duration * k) / 40, newAirPose());
          if (q.visible) expect(q.y - terrainHeight(q.x, q.z)).toBeGreaterThan(1400 * FT);
        }
        expect(c.speed).toBeGreaterThan(95 * 0.5144);
      }),
      { numRuns: 300 },
    );
  });

  it('scheduler: nothing starts within the spawn clearance of the player; cycles roll over deterministically', () => {
    const anchor = { x: 1234, z: -567 };
    const make = () =>
      createScheduler(3, (s, c, a, st) => crossingTrack(seed, s, c, a, st, terrainHeight), (s) => 0.36 * ((s * 0.37) % 1), 0, anchor);
    const a = make();
    const b = make();
    const p = newAirPose();
    for (const s of a.slots) {
      crossingPose(s, 0, p);
      expect(Math.hypot(p.x - anchor.x, p.z - anchor.z)).toBeGreaterThan(CONFIG.world.traffic.spawnClearance);
    }
    for (let t = 0; t < 3000; t += 1) {
      const anc = { x: anchor.x + t * 20, z: anchor.z };
      const before = a.slots.map((s) => s.cycle);
      a.update(t, anc);
      b.update(t, anc);
      a.slots.forEach((s, i) => {
        if (s.cycle !== before[i]) {
          crossingPose(s, t, p);
          expect(Math.hypot(p.x - anc.x, p.z - anc.z)).toBeGreaterThan(CONFIG.world.traffic.spawnClearance);
        }
      });
    }
    expect(a.slots.map((s) => [s.cycle, s.x0, s.y])).toEqual(b.slots.map((s) => [s.cycle, s.x0, s.y]));
    expect(a.slots.every((s) => s.cycle > 0)).toBe(true);
  });

  it('helicopter circles over Port Chateau ~1,000 ft above the rooftops', () => {
    const h = buildHeliRoute(layout, terrainHeight);
    const city = layout.towns.find((t) => t.name === 'Port Chateau')!;
    const p = newAirPose();
    for (let t = 0; t < h.path.duration; t += 5) {
      heliPose(h, t, p);
      expect(Math.hypot(p.x - city.x, p.z - city.z)).toBeLessThan(city.radius);
      const agl = p.y - terrainHeight(p.x, p.z);
      expect(agl).toBeGreaterThan(250);
      expect(agl).toBeLessThan(420);
      expect(Math.abs(p.roll)).toBeLessThan(30);
    }
  });

  it('fuzz: airliners cruise at FL300–380 and lay persistent contrails behind them', () => {
    fc.assert(
      fc.property(fc.nat({ max: 5 }), fc.nat({ max: 5000 }), fc.double({ min: -3e4, max: 3e4, noNaN: true }), fc.double({ min: 0, max: 600, noNaN: true }), (slot, cycle, ax, tau) => {
        const a = airlinerTrack(seed, slot, cycle, { x: ax, z: 0 }, 0);
        expect(a.y).toBeGreaterThanOrEqual(30000 * FT - 1);
        expect(a.y).toBeLessThanOrEqual(38000 * FT + 1);
        const p = airlinerPose(a, tau, newAirPose());
        const c = { x: 0, y: 0, z: 0 };
        contrailPoint(a, tau, 30, c);
        // behind the aircraft along its track (plus the wind drift), slightly lower
        const back = (p.x - c.x) * a.dx + (p.z - c.z) * a.dz;
        expect(back).toBeGreaterThan(a.speed * 30 - 20 * 30);
        expect(c.y).toBeLessThan(p.y);
        expect(Number.isFinite(c.x + c.y + c.z)).toBe(true);
      }),
      { numRuns: 200 },
    );
  });

  it('fuzz: keepClear always leaves ≥ R and leaves far points alone', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -5000, max: 5000, noNaN: true }), fc.double({ min: -500, max: 3000, noNaN: true }), fc.double({ min: -5000, max: 5000, noNaN: true }),
        fc.double({ min: -5000, max: 5000, noNaN: true }), fc.double({ min: 0, max: 3000, noNaN: true }), fc.double({ min: -5000, max: 5000, noNaN: true }),
        (x, y, z, px, py, pz) => {
          const p = { x, y, z };
          const pl = { x: px, y: py, z: pz };
          const d0 = Math.hypot(x - px, y - py, z - pz);
          keepClear(p, pl, R_CLEAR);
          const d1 = Math.hypot(p.x - px, p.y - py, p.z - pz);
          expect(d1).toBeGreaterThanOrEqual(R_CLEAR - 1e-6);
          if (d0 > R_CLEAR + 1200) expect(d1).toBeCloseTo(d0, 6);
          expect(d1).toBeGreaterThanOrEqual(d0 - 1e-6);
        },
      ),
      { numRuns: 500 },
    );
  });
});
