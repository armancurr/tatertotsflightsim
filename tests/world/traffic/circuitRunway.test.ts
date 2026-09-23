/**
 * Circuit traffic on either runway (src/world/traffic/air.ts):
 *
 *  - unit: the circuit takes the runway end most into the surface wind (the windsocks' 330°/8 kt →
 *    36; other winds → 3, 18, 21; calm → 36; a forced end), with the parallel taxiway only on 36/18;
 *  - fuzz: for any wind the chosen end has (within the main runway's small preference) the largest
 *    head wind; the whole circuit stays sane (finite, near the field, above the ground);
 *  - functional: on every end the circuit is left-hand, lands and takes off on that runway's
 *    pavement, taxis back (36/18) on taxiway A only; with the player on runway 03 (crossing the
 *    active 36) nobody lands, rolls or takes off through it — they go around — and once the player
 *    has gone, landings resume.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { CONFIG, type Config } from '../../../src/config';
import { getLayout } from '../../../src/world/layout';
import { terrainHeight } from '../../../src/world/heightfield';
import { isOnRunway, runwayEndFrame, runwayEnds, toRunwayCoords } from '../../../src/world/runway';
import {
  activeCircuitRunway, buildCircuit, circuitBlockedByPlayer, circuitPose, createCircuitState, newAirPose, reanchorCircuit, stepCircuit,
  GEAR_HEIGHT, type PlayerRef,
} from '../../../src/world/traffic/air';
import { newPathSample, samplePath } from '../../../src/world/traffic/path';
import { fcParams } from '../../support/fc';

const layout = getLayout();
const E = CONFIG.world.airport.elevation;
const FT = 0.3048;
const PA = CONFIG.world.traffic.air.patternAltitudeFt * FT;

const withWind = (fromDeg: number, speedKt: number, circuitRunway = 'auto'): Config =>
  ({
    ...CONFIG,
    world: {
      ...CONFIG.world,
      airportRender: { ...CONFIG.world.airportRender, wind: { fromDeg, speedKt } },
      traffic: { ...CONFIG.world.traffic, air: { ...CONFIG.world.traffic.air, circuitRunway } },
    },
  }) as Config;

const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

/** Inside an oriented rectangle (layout paved areas)? */
function inRect(r: { center: { x: number; z: number }; halfLength: number; halfWidth: number; headingDeg: number }, x: number, z: number, tol = 1.5): boolean {
  const h = (r.headingDeg * Math.PI) / 180;
  const dx = x - r.center.x;
  const dz = z - r.center.z;
  const along = dx * Math.sin(h) - dz * Math.cos(h);
  const across = dx * Math.cos(h) + dz * Math.sin(h);
  return Math.abs(along) <= r.halfLength + tol && Math.abs(across) <= r.halfWidth + tol;
}
const onPavement = (x: number, z: number, tol = 1.5) => layout.airport.pavedAreas.some((r) => inRect(r, x, z, tol));

describe('which runway the circuit uses', () => {
  it('the windsocks’ 330° at 8 kt → runway 36 (head wind 6.9 kt), with taxiway A on its right', () => {
    const r = activeCircuitRunway(CONFIG);
    expect(r.designator).toBe('36');
    expect(r.headwindKt).toBeCloseTo(8 * Math.cos((30 * Math.PI) / 180), 6);
    expect(r.taxiSide).toBe(1);
    expect(createCircuitState(layout, CONFIG).runway.designator).toBe('36');
  });

  it('other winds pick the end most into the wind; calm → 36; a forced end wins', () => {
    expect(activeCircuitRunway(withWind(40, 10)).designator).toBe('3');
    expect(activeCircuitRunway(withWind(40, 10)).taxiSide).toBe(0);
    expect(activeCircuitRunway(withWind(170, 10)).designator).toBe('18');
    expect(activeCircuitRunway(withWind(170, 10)).taxiSide).toBe(-1);
    expect(activeCircuitRunway(withWind(215, 12)).designator).toBe('21');
    expect(activeCircuitRunway(withWind(120, 1)).designator).toBe('36');
    expect(activeCircuitRunway(withWind(330, 8, '03')).designator).toBe('3');
    expect(activeCircuitRunway(withWind(330, 8, '21')).designator).toBe('21');
  });

  it('fuzz: the chosen end has the most head wind (the main runway may win by < 1 kt)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 360, noNaN: true }), fc.double({ min: 3, max: 30, noNaN: true }), (from, kt) => {
        const cfg = withWind(from, kt);
        const r = activeCircuitRunway(cfg);
        let best = -Infinity;
        for (const e of runwayEnds(cfg)) best = Math.max(best, kt * Math.cos((wrap(from - e.frame.headingDeg) * Math.PI) / 180));
        expect(r.headwindKt).toBeGreaterThanOrEqual(best - 0.76);
        expect(r.headwindKt).toBeGreaterThan(-1e-9 - 0.76 + Math.min(0, best));
      }),
      fcParams(300),
    );
  });
});

describe('the circuit on each runway end', () => {
  const smp = newPathSample();
  for (const [des, wind] of [['36', 330], ['18', 170], ['3', 40], ['21', 215]] as [string, number][]) {
    it(`runway ${des}: left-hand, lands and lifts off on its pavement, pattern altitude on the downwind, above the ground`, () => {
      const cfg = withWind(wind, 10);
      const act = activeCircuitRunway(cfg);
      expect(act.designator).toBe(des);
      const frame = runwayEndFrame(des, cfg)!;
      for (const kind of ['c172', 'pa28'] as const) {
        const cl = buildCircuit(layout, cfg, kind, act);
        // every leg: finite, near the field, never underground
        for (const [name, p] of Object.entries(cl.legs)) {
          for (let s = 0; s <= p.length; s += 10) {
            samplePath(p, s, smp);
            expect(Number.isFinite(smp.x + smp.y + smp.z + smp.heading), `${des} ${name}`).toBe(true);
            expect(Math.hypot(smp.x - frame.center.x, smp.z - frame.center.z)).toBeLessThan(4500);
            expect(smp.y, `${des} ${name} at ${s}`).toBeGreaterThan(terrainHeight(smp.x, smp.z) + GEAR_HEIGHT[kind] - 1.5);
          }
        }
        // touch-and-go: on the ground only on this runway's pavement
        for (const [a, b] of cl.ground.tng ?? []) {
          for (let s = a; s <= b; s += 5) {
            samplePath(cl.legs.tng, s, smp);
            expect(isOnRunway(smp.x, smp.z, frame), `${des} tng ground at ${s}`).toBe(true);
          }
        }
        // take-off roll too (after lining up from the hold)
        for (const [a, b] of cl.ground.to ?? []) {
          for (let s = a; s <= b; s += 5) {
            samplePath(cl.legs.to, s, smp);
            expect(onPavement(smp.x, smp.z) || isOnRunway(smp.x, smp.z, frame)).toBe(true);
          }
        }
        // downwind: left of the landing direction, at pattern altitude, flown the other way
        const dw = cl.legs.down;
        samplePath(dw, dw.length / 2, smp);
        const rc = toRunwayCoords(smp.x, smp.z, frame);
        expect(rc.across).toBeLessThan(-800);
        expect(smp.y - E).toBeCloseTo(PA, 0);
        expect(Math.abs(wrap(smp.heading - frame.headingDeg - 180))).toBeLessThan(5);
        // final: aligned with the runway
        const fin = cl.legs.tng;
        samplePath(fin, 5, smp);
        expect(Math.abs(wrap(smp.heading - frame.headingDeg))).toBeLessThan(5);
      }
    });
  }

  it('runways 36 and 18: the full-stop taxi-back stays on the runway and taxiway A; 3 and 21 fly touch-and-goes only', () => {
    for (const [des, wind] of [['36', 330], ['18', 170]] as [string, number][]) {
      const cfg = withWind(wind, 10);
      const act = activeCircuitRunway(cfg);
      const cl = buildCircuit(layout, cfg, 'c172', act);
      for (const [a, b] of cl.ground.full ?? []) {
        for (let s = a; s <= b; s += 4) {
          samplePath(cl.legs.full, s, smp);
          // (the taxi turns cut the fillets by a few metres, like a real aircraft on a wide fillet)
          expect(onPavement(smp.x, smp.z, 5), `${des} full-stop taxi at ${Math.round(smp.x)},${Math.round(smp.z)}`).toBe(true);
        }
      }
      expect(onPavement(cl.hold.x, cl.hold.z)).toBe(true);
    }
    const st = createCircuitState(layout, withWind(40, 10));
    let fulls = 0;
    let tngs = 0;
    for (let i = 0; i < 20 * 60 * 60; i++) {
      stepCircuit(st, 0.1, null);
      for (const a of st.aircraft) {
        if (a.leg === 'full' || a.leg === 'hold') fulls++;
        if (a.leg === 'tng') tngs++;
      }
    }
    expect(fulls).toBe(0);
    expect(tngs).toBeGreaterThan(100);
  }, 60_000);
});

describe('the player on a runway crossing the active one', () => {
  const r03 = runwayEndFrame('3')!;
  // lined up at the 03 threshold, ready to go
  const player: PlayerRef = { x: r03.threshold.x + r03.dir.x * 40, y: E + 1.5, z: r03.threshold.z + r03.dir.z * 40, agl: 0 };

  it('blocks the 36 circuit: no landing, roll or take-off through the intersection; they go around', () => {
    const st = createCircuitState(layout, CONFIG);
    expect(st.crossing.map((f) => f.name)).toContain('03/21');
    expect(circuitBlockedByPlayer(st, player)).toBe(true);
    expect(circuitBlockedByPlayer(st, { ...player, agl: 400, y: E + 400 })).toBe(false);
    // let the circuit get busy first, then the player appears there (spawn)
    let guard = 0;
    while (!st.aircraft.some((a) => a.leg === 'tng' || a.leg === 'to' || a.leg === 'full') && guard++ < 100000) stepCircuit(st, 0.1, null);
    reanchorCircuit(st, player);
    const pose = newAirPose();
    const inter = { x: 0, z: 0 };
    {
      // where the runways cross
      const a = st.runway.frame;
      const den = a.dir.x * r03.dir.z - a.dir.z * r03.dir.x;
      const t = ((r03.threshold.x - a.threshold.x) * r03.dir.z - (r03.threshold.z - a.threshold.z) * r03.dir.x) / den;
      inter.x = a.threshold.x + a.dir.x * t;
      inter.z = a.threshold.z + a.dir.z * t;
    }
    let gas = 0;
    for (let i = 0; i < 25 * 60 * 10; i++) {
      stepCircuit(st, 0.1, player);
      for (const a of st.aircraft) {
        expect(['tng', 'full', 'to', 'hold'].includes(a.leg), `aircraft ${a.id} on ${a.leg} while the player is on 03`).toBe(false);
        circuitPose(st, a, pose);
        // nobody low over the intersection
        if (Math.hypot(pose.x - inter.x, pose.z - inter.z) < 400) expect(pose.y - E).toBeGreaterThan(100);
      }
    }
    gas = st.log.filter((l) => l.endsWith(':ga')).length;
    expect(gas).toBeGreaterThan(0);
    // the player takes off and leaves: landings resume
    let landed = false;
    for (let i = 0; i < 20 * 60 * 10 && !landed; i++) {
      stepCircuit(st, 0.1, { x: 5000, y: 1500, z: -9000, agl: 1400 });
      landed = st.aircraft.some((a) => a.leg === 'tng' || a.leg === 'full');
    }
    expect(landed).toBe(true);
  }, 60_000);
});
