/**
 * The air traffic driver: unit (clearance above the terrain), fuzz, and functional runs
 * (many frames with a moving player, pause, teleport, fast-forward).
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { getLayout } from '../../../src/world/layout';
import { terrainHeight } from '../../../src/world/heightfield';
import { CONFIG } from '../../../src/config';
import { airSimJob, keepClearAbove, type AirSim } from '../../../src/world/traffic/airSim';
import { drain } from '../../../src/world/traffic/jobs';
import { createCircuitState, stepCircuit, type PlayerRef } from '../../../src/world/traffic/air';

const layout = getLayout();
const rw = layout.airport.runway;
const R = CONFIG.world.traffic.playerClearance;
const onRunway = (): PlayerRef => ({ x: rw.threshold.x + rw.dir.x * 45, y: rw.elevation + 1.2, z: rw.threshold.z + rw.dir.z * 45, agl: 0 });
const make = (t0 = 0, player: PlayerRef | null = onRunway()): AirSim => drain(airSimJob({ layout, heightAt: terrainHeight, t0, player }));
const snapshot = (s: AirSim) => s.entities.map((e) => [e.kind, e.pose.x, e.pose.y, e.pose.z, e.pose.heading, e.pose.visible]);

describe('keepClearAbove', () => {
  it('fuzz: ≥ R from the player and never pushed under the floor', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -3000, max: 3000, noNaN: true }), fc.double({ min: 0, max: 3000, noNaN: true }), fc.double({ min: -3000, max: 3000, noNaN: true }),
        fc.double({ min: -3000, max: 3000, noNaN: true }), fc.double({ min: 0, max: 3000, noNaN: true }), fc.double({ min: -3000, max: 3000, noNaN: true }), fc.double({ min: 0, max: 400, noNaN: true }),
        (x, y, z, px, py, pz, floor) => {
          const p = { x, y: Math.max(y, floor), z };
          const y0 = p.y;
          keepClearAbove(p, { x: px, y: py, z: pz }, R, floor);
          expect(Math.hypot(p.x - px, p.y - py, p.z - pz)).toBeGreaterThanOrEqual(R - 1e-6);
          expect(p.y).toBeGreaterThanOrEqual(Math.min(y0, floor) - 1e-9);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('air traffic driver (functional)', () => {
  it('builds in small steps; a start time fast-forwards the circuit exactly', () => {
    const job = airSimJob({ layout, heightAt: terrainHeight, t0: 600, player: null });
    let steps = 0;
    let sim: AirSim | undefined;
    for (;;) {
      const r = job.next();
      steps++;
      if (r.done) {
        sim = r.value;
        break;
      }
    }
    expect(steps).toBeGreaterThan(30);
    const ref = createCircuitState(layout);
    stepCircuit(ref, 600, null);
    expect(sim!.circuit!.time).toBeCloseTo(ref.time, 6);
    expect(sim!.circuit!.aircraft.map((a) => [a.leg, Math.round(a.t * 10)])).toEqual(ref.aircraft.map((a) => [a.leg, Math.round(a.t * 10)]));
    const c = CONFIG.world.traffic.air;
    expect(sim!.entities).toHaveLength(c.circuit + c.crossing + (c.helicopter ? 1 : 0) + c.airliners);
  });

  it('30 minutes of frames with a wandering player: finite poses, fixed entity pool, airborne traffic always ≥ the clearance', () => {
    const sim = make(0);
    const n = sim.entities.length;
    let t = 0;
    const player = { ...onRunway() };
    let minD = Infinity;
    let rnd = 12345;
    const rand = () => ((rnd = (rnd * 1103515245 + 12345) >>> 0) / 4294967296);
    let hdg = 0;
    for (let f = 0; f < 30 * 60 * 30; f++) {
      const dt = 1 / 30;
      t += dt;
      // the player takes off after a minute and wanders around at 300–2,000 m
      if (t > 60) {
        hdg += (rand() - 0.5) * 0.02;
        player.x += Math.sin(hdg) * 55 * dt;
        player.z -= Math.cos(hdg) * 55 * dt;
        player.y = Math.min(2000, player.y + 3 * dt);
        player.agl = player.y - terrainHeight(player.x, player.z);
      }
      sim.update(t, dt, player);
      expect(sim.entities.length).toBe(n);
      if (f % 10) continue;
      for (const e of sim.entities) {
        const p = e.pose;
        for (const v of [p.x, p.y, p.z, p.heading, p.pitch, p.roll]) expect(Number.isFinite(v)).toBe(true);
        if (!p.visible || p.onGround) continue;
        minD = Math.min(minD, Math.hypot(p.x - player.x, p.y - player.y, p.z - player.z));
        if (e.role !== 'airliner') expect(p.y).toBeGreaterThan(terrainHeight(p.x, p.z));
      }
    }
    expect(minD).toBeGreaterThanOrEqual(R - 1e-6);
  }, 120_000);

  it('a paused clock (dt = 0, same t) leaves every pose unchanged', () => {
    const sim = make(100);
    const p = onRunway();
    sim.update(100.5, 0.5, p);
    const a = snapshot(sim);
    for (let i = 0; i < 50; i++) sim.update(100.5, 0, p);
    expect(snapshot(sim)).toEqual(a);
  });

  it('teleport: crossing traffic re-anchors around the new position, nothing spawns inside the spawn clearance', () => {
    const sim = make(0);
    sim.update(10, 10, onRunway());
    const far: PlayerRef = { x: -20000, y: 1500, z: -15000, agl: 1000 };
    sim.reanchor(10, far);
    for (const e of sim.entities.filter((x) => x.role === 'crossing')) {
      const p = e.pose;
      const d = Math.hypot(p.x - far.x, p.z - far.z);
      expect(d).toBeGreaterThan(CONFIG.world.traffic.spawnClearance);
      expect(d).toBeLessThan(16000); // on a track through the new area
    }
    // … and the crossings then pass within a few km of the new position
    let closest = Infinity;
    for (let t = 10; t < 700; t += 1) {
      sim.update(t, 1, far);
      for (const e of sim.entities.filter((x) => x.role === 'crossing' && x.pose.visible)) closest = Math.min(closest, Math.hypot(e.pose.x - far.x, e.pose.z - far.z));
    }
    expect(closest).toBeLessThan(5000);
  }, 30_000);

  it('crossing traffic actually crosses the path of a player flying straight (tracks lead the player)', () => {
    for (const [vx, vz] of [[0, -50], [45, 20], [-30, 35]]) {
      const player: PlayerRef = { x: 2000, y: 1400, z: 5000, agl: 900, vx, vz };
      const sim = make(0, player);
      sim.reanchor(0, player);
      // closest approach per crossing cycle
      const best = new Map<string, number>();
      for (let t = 0; t < 1200; t += 0.5) {
        player.x += vx * 0.5;
        player.z += vz * 0.5;
        player.agl = player.y - terrainHeight(player.x, player.z);
        sim.update(t, 0.5, player);
        sim.entities.forEach((e, i) => {
          if (e.role !== 'crossing' || !e.pose.visible) return;
          const key = `${i}:${Math.round(e.pose.heading)}`;
          const d = Math.hypot(e.pose.x - player.x, e.pose.y - player.y, e.pose.z - player.z);
          expect(d).toBeGreaterThanOrEqual(R - 1e-6);
          best.set(key, Math.min(best.get(key) ?? Infinity, d));
        });
      }
      const passes = [...best.values()];
      expect(passes.filter((d) => d < 5000).length, `${vx},${vz}: ${passes.map(Math.round)}`).toBeGreaterThanOrEqual(3);
      expect(Math.min(...passes), `${vx},${vz}`).toBeLessThan(1800);
    }
  }, 60_000);

  it('fuzz: any start time and player position builds a sane simulation', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 3000, noNaN: true }), fc.double({ min: -30000, max: 30000, noNaN: true }), fc.double({ min: -30000, max: 30000, noNaN: true }), (t0, x, z) => {
        const y = terrainHeight(x, z) + 500;
        const player: PlayerRef = { x, y, z, agl: 500 };
        const sim = make(t0, player);
        sim.update(t0 + 0.1, 0.1, player);
        for (const e of sim.entities) {
          for (const v of [e.pose.x, e.pose.y, e.pose.z]) expect(Number.isFinite(v)).toBe(true);
          if (e.pose.visible && !e.pose.onGround) expect(Math.hypot(e.pose.x - x, e.pose.y - y, e.pose.z - z)).toBeGreaterThanOrEqual(R - 1e-6);
        }
      }),
      { numRuns: 15 },
    );
  }, 60_000);
});
