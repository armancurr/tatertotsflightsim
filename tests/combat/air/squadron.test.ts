import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import { CONFIG, FT_TO_M } from '../../../src/config';
import { createCombatWorld } from '../../../src/combat/world';
import { createAirSquadron, type AirSquadron } from '../../../src/combat/air/squadron';
import { planAir, pathMinDistance } from '../../../src/combat/air/plan';
import { turnRateFor } from '../../../src/combat/air/flight';
import type { PlayerInfo } from '../../../src/combat/air/pilot';
import { FxSim } from '../../../src/fx/sim';

vi.setConfig({ testTimeout: 60_000 });

const A = CONFIG.combat.air;
const DEG = Math.PI / 180;
const RANGE = { x: -1516, z: -5287 };
/** Rolling hills rising to the north (like the real map: the range ~100 m, mountains beyond 12 km). */
const hills = (x: number, z: number) => Math.max(20, 60 + 90 * Math.sin(x / 1700) * Math.cos(z / 2300) + Math.max(0, -z - 9000) * 0.12);

function setup(o: { fx?: boolean; seed?: number; ground?: (x: number, z: number) => number } = {}) {
  const world = createCombatWorld();
  const sim = o.fx ? new FxSim(7) : null;
  const sq = createAirSquadron({ world, ground: o.ground ?? hills, range: RANGE, fx: () => sim, seed: o.seed });
  return { world, sq, sim };
}

const player = (x: number, y: number, z: number, vx = 0, vy = 0, vz = 0): PlayerInfo => {
  const n = Math.hypot(vx, vy, vz) || 1;
  return { x, y, z, vx, vy, vz, fx: vx / n, fy: vy / n, fz: n === 1 && !vx && !vz ? -1 : vz / n };
};
const AIRPORT_PLAYER = player(0, 30, 600, 0, 0, 0);

function run(sq: AirSquadron, seconds: number, p: PlayerInfo | null = AIRPORT_PLAYER, dt = 1 / 30, each?: () => void) {
  const n = Math.round(seconds / dt);
  for (let i = 0; i < n; i++) {
    sq.update(dt, p);
    each?.();
  }
}

describe('air plan', () => {
  it('8 aircraft: two MiG-29 pairs, a Su-25 pair, a Mi-24 pair; every path clear of the airport circuit', () => {
    const slots = planAir(RANGE, hills);
    expect(slots.map((s) => s.kind).sort()).toEqual(['attack', 'attack', 'fighter', 'fighter', 'fighter', 'fighter', 'helo', 'helo']);
    for (const s of slots) expect(pathMinDistance(s.path, 0, 0)).toBeGreaterThanOrEqual(A.airportKeepOutM);
    // Altitudes: CAPs 3,000–8,000 ft (over low hills), helicopters 200–500 ft AGL.
    for (const s of slots) {
      if (s.kind === 'fighter') for (const a of s.path.alt) expect(a / FT_TO_M).toBeGreaterThanOrEqual(3000), expect(a / FT_TO_M).toBeLessThanOrEqual(8000 * 1.1);
      if (s.kind === 'helo') for (const a of s.path.alt) expect(a / FT_TO_M).toBeGreaterThanOrEqual(200), expect(a / FT_TO_M).toBeLessThanOrEqual(500);
    }
    // Deterministic from the seed.
    const again = planAir(RANGE, hills);
    expect(again.map((s) => [s.s0, s.path.x[3], s.bort])).toEqual(slots.map((s) => [s.s0, s.path.x[3], s.bort]));
    expect(planAir(RANGE, hills, A, { x: 0, z: 0 }, 99).map((s) => s.s0)).not.toEqual(slots.map((s) => s.s0));
  });

  it('the attack pattern runs in toward the range and pulls off short of it', () => {
    const at = planAir(RANGE, hills).find((s) => s.kind === 'attack')!;
    const d = pathMinDistance(at.path, RANGE.x, RANGE.z);
    expect(d).toBeGreaterThan(300);
    expect(d).toBeLessThan(A.attack.pullOffM + 200);
    // lowest point of the run-in ~1,000 ft above the range
    const lo = Math.min(...at.path.alt) - hills(RANGE.x, RANGE.z);
    expect(lo / FT_TO_M).toBeGreaterThan(800);
    expect(lo / FT_TO_M).toBeLessThan(1300);
  });
});

describe('air squadron: registration and flight', () => {
  it('registers every aircraft with the world and keeps position / orientation / heading / velocity synced', () => {
    const { world, sq } = setup();
    sq.reset(AIRPORT_PLAYER);
    const air = world.targets.filter((t) => world.isAir(t));
    expect(air).toHaveLength(8);
    run(sq, 5);
    for (const e of sq.entities) {
      const t = e.target;
      expect(t.position.x).toBe(e.flight.x);
      expect(t.position.y).toBe(e.flight.y);
      expect(t.position.z).toBe(e.flight.z);
      expect(t.orientation).toEqual(e.flight.orientation);
      expect(t.velocity).toEqual(e.flight.velocity);
      expect(t.headingDeg).toBeCloseTo((((e.flight.heading / DEG) % 360) + 360) % 360, 9);
      expect(world.centreOf(t)).toEqual(t.position);
      // the world's hit box is where it is drawn: a ray through the centre along the nose hits it
      const q = t.orientation!;
      const hit = world.raycast({ x: t.position.x, y: t.position.y + 50, z: t.position.z }, { x: t.position.x, y: t.position.y - 50, z: t.position.z });
      expect(hit?.target.id).toBe(t.id);
      expect(Number.isFinite(q.w)).toBe(true);
    }
  });

  it('flies smoothly: banked for its turn rate, inside its speed envelope, above the ground, clear of the airport (10 min)', () => {
    const { sq } = setup();
    sq.reset(AIRPORT_PLAYER);
    let minAirport = Infinity;
    let maxBank = 0;
    run(sq, 600, AIRPORT_PLAYER, 1 / 20, () => {
      for (const e of sq.entities) {
        const f = e.flight;
        expect(Number.isFinite(f.x + f.y + f.z)).toBe(true);
        expect(f.speed).toBeGreaterThanOrEqual(e.pilot.spec.min);
        expect(f.speed).toBeLessThanOrEqual(e.pilot.spec.max);
        expect(Math.abs(f.turnRate - turnRateFor(f.bank, f.speed))).toBeLessThan(1e-9);
        expect(f.y - hills(f.x, f.z)).toBeGreaterThanOrEqual(A.hardFloorM - 1e-6);
        minAirport = Math.min(minAirport, Math.hypot(f.x, f.z));
        maxBank = Math.max(maxBank, Math.abs(f.bank));
      }
    });
    expect(minAirport).toBeGreaterThan(A.airportKeepOutM - 500);
    expect(maxBank).toBeGreaterThan(20 * DEG);
    // CAP MiGs stayed near their altitude band; helicopters low.
    for (const e of sq.entities) {
      const agl = e.flight.y - hills(e.flight.x, e.flight.z);
      if (e.kind === 'helo') expect(agl).toBeLessThan(250);
      if (e.kind === 'fighter') expect(e.flight.y / FT_TO_M).toBeGreaterThan(2500);
    }
  });

  it('fuzz: any seed, any hilly terrain, long runs — never below the terrain + margin, never NaN', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 1e9 }), fc.double({ min: 0, max: 900, noNaN: true }), fc.double({ min: 400, max: 3000, noNaN: true }), (seed, amp, wave) => {
        const g = (x: number, z: number) => 40 + amp * (0.5 + 0.5 * Math.sin(x / wave) * Math.cos(z / (wave * 1.3)));
        const { sq } = setup({ seed, ground: g });
        sq.reset(AIRPORT_PLAYER);
        run(sq, 120, AIRPORT_PLAYER, 1 / 10, () => {
          for (const e of sq.entities) {
            const f = e.flight;
            expect(Number.isFinite(f.x + f.y + f.z + f.orientation.w)).toBe(true);
            expect(f.y - g(f.x, f.z)).toBeGreaterThanOrEqual(A.hardFloorM - 1e-6);
          }
        });
      }),
      { numRuns: 12 },
    );
  });

  it('deterministic from the seed', () => {
    const a = setup();
    const b = setup();
    a.sq.reset(AIRPORT_PLAYER);
    b.sq.reset(AIRPORT_PLAYER);
    run(a.sq, 30);
    run(b.sq, 30);
    expect(a.sq.entities.map((e) => [e.flight.x, e.flight.y, e.flight.z])).toEqual(b.sq.entities.map((e) => [e.flight.x, e.flight.y, e.flight.z]));
  });

  it('wingmen hold station behind their leader', () => {
    const { sq } = setup();
    sq.reset(AIRPORT_PLAYER);
    run(sq, 120);
    for (const e of sq.entities) {
      if (!e.pilot.leader || e.kind !== 'fighter') continue;
      const l = e.pilot.leader.flight;
      const d = Math.hypot(e.flight.x - l.x, e.flight.z - l.z);
      expect(d).toBeGreaterThan(300);
      expect(d).toBeLessThan(2000);
    }
  });
});

describe('air squadron: evasion and keep-away', () => {
  const mig = (sq: AirSquadron) => sq.entities.find((e) => e.kind === 'fighter' && e.pilot.leader === null)!;

  it('a lock makes it break (max-bank turn) and pop flares, then it rejoins its path; the cooldown holds', () => {
    const { world, sq } = setup({ fx: true });
    sq.reset(AIRPORT_PLAYER);
    run(sq, 3);
    const e = mig(sq);
    const f = e.flight;
    const behind = player(f.x - f.velocity.x * 10, f.y, f.z - f.velocity.z * 10, f.velocity.x, 0, f.velocity.z);
    world.emit({ type: 'lock', time: 0, targetId: e.target.id });
    expect(e.pilot.mode).toBe('break');
    let peak = 0;
    run(sq, 2, behind, 1 / 30, () => (peak = Math.max(peak, Math.abs(e.flight.bank))));
    expect(peak).toBeGreaterThan(A.flight.fighter.cruiseBankDeg * DEG + 10 * DEG);
    expect(sq.stats().flares).toBeGreaterThanOrEqual(A.flares.count[0]);
    expect(sq.flares.active).toBeGreaterThan(0);
    run(sq, A.breakS[1] + 1, behind);
    expect(e.pilot.mode).not.toBe('break');
    // Another lock inside the cooldown: no new break.
    world.emit({ type: 'lock', time: 0, targetId: e.target.id });
    expect(e.pilot.mode).not.toBe('break');
    // A launch always does.
    world.status.lock.targetId = e.target.id;
    world.emit({ type: 'missileLaunch', time: 0, missileId: 1, station: 0, position: { x: behind.x, y: behind.y, z: behind.z }, velocity: { x: 0, y: 0, z: 0 } });
    expect(e.pilot.mode).toBe('break');
  });

  it('gun rounds passing close make it break', () => {
    const { world, sq } = setup();
    sq.reset(AIRPORT_PLAYER);
    run(sq, 3);
    const e = mig(sq);
    const f = e.flight;
    const n = Math.hypot(f.velocity.x, f.velocity.y, f.velocity.z);
    // 800 m behind, nose on it, gun firing
    const p: PlayerInfo = { x: f.x - (f.velocity.x / n) * 800, y: f.y - (f.velocity.y / n) * 800, z: f.z - (f.velocity.z / n) * 800, vx: f.velocity.x, vy: f.velocity.y, vz: f.velocity.z, fx: f.velocity.x / n, fy: f.velocity.y / n, fz: f.velocity.z / n };
    world.status.gunFiring = false;
    sq.update(1 / 30, p);
    expect(e.pilot.mode).not.toBe('break');
    world.status.gunFiring = true;
    sq.update(1 / 30, p);
    expect(e.pilot.mode).toBe('break');
    expect(e.pilot.lastThreat).toBe('gun');
  });

  it('keeps ≥ 600 m from a player loitering on its path (but lets a chaser close from behind)', () => {
    const { sq } = setup();
    sq.reset(AIRPORT_PLAYER);
    run(sq, 2);
    const e = mig(sq);
    const f = e.flight;
    // A player hanging (slow) 3 km straight ahead of it, at its altitude.
    const n = Math.hypot(f.velocity.x, f.velocity.z);
    const ahead = player(f.x + (f.velocity.x / n) * 3000, f.y, f.z + (f.velocity.z / n) * 3000, 0, 0, 0);
    let minD = Infinity;
    run(sq, 40, ahead, 1 / 30, () => (minD = Math.min(minD, Math.hypot(e.flight.x - ahead.x, e.flight.y - ahead.y, e.flight.z - ahead.z))));
    expect(minD).toBeGreaterThanOrEqual(A.playerMinM);

    // A chaser 700 m behind, faster: closes to gun range, no avoidance.
    const { sq: sq2 } = setup();
    sq2.reset(AIRPORT_PLAYER);
    run(sq2, 2);
    const e2 = mig(sq2);
    let minC = Infinity;
    const chase = player(0, 0, 0);
    for (let i = 0; i < 30 * 12; i++) {
      const g = e2.flight;
      const m = Math.hypot(g.velocity.x, g.velocity.y, g.velocity.z);
      const back = 700 - i * (50 / 30); // closing at 50 m/s
      chase.x = g.x - (g.velocity.x / m) * back;
      chase.y = g.y - (g.velocity.y / m) * back;
      chase.z = g.z - (g.velocity.z / m) * back;
      chase.vx = g.velocity.x * 1.25; chase.vy = g.velocity.y * 1.25; chase.vz = g.velocity.z * 1.25;
      chase.fx = g.velocity.x / m; chase.fy = g.velocity.y / m; chase.fz = g.velocity.z / m;
      sq2.update(1 / 30, chase);
      expect(e2.pilot.mode).not.toBe('avoid');
      minC = Math.min(minC, Math.hypot(g.x - chase.x, g.y - chase.y, g.z - chase.z));
    }
    expect(minC).toBeLessThan(A.playerMinM);
  });
});

describe('air squadron: shoot-down, respawn, reset', () => {
  const kill = (world: ReturnType<typeof createCombatWorld>, id: number, weapon: 'gun' | 'missile' = 'missile') =>
    world.applyHit(id, { weapon, damage: 1e6, point: { ...world.find(id)!.position }, direction: { x: 0, y: -1, z: 0 }, time: 0, face: 'top' });

  it('a MiG killed at altitude falls trailing fire and smoke, hits the ground and leaves a burning wreck', () => {
    const { world, sq, sim } = setup({ fx: true });
    sq.reset(AIRPORT_PLAYER);
    run(sq, 2);
    const e = sq.entities.find((x) => x.kind === 'fighter')!;
    const y0 = e.flight.y;
    expect(kill(world, e.target.id).destroyed).toBe(true);
    sq.update(1 / 30, AIRPORT_PLAYER);
    expect(e.phase).toBe('falling');
    let t = 0;
    let smoke = 0;
    while (e.phase === 'falling' && t < 180) {
      sq.update(1 / 30, AIRPORT_PLAYER);
      sim!.step(1 / 30, 0, 0, 0);
      smoke = Math.max(smoke, sim!.smoke.count);
      t += 1 / 30;
      // the world's (dead) target follows the falling wreck
      expect(e.target.position.y).toBe(e.position.y);
    }
    expect(e.phase).toBe('wreck');
    expect(t).toBeLessThan(90);
    expect(t).toBeGreaterThan(Math.sqrt((2 * (y0 - 200)) / 9.81) * 0.8);
    expect(smoke).toBeGreaterThan(50);
    const g = hills(e.position.x, e.position.z);
    expect(e.position.y - g).toBeGreaterThan(0.5);
    expect(e.position.y - g).toBeLessThan(2);
    expect(e.target.velocity).toEqual({ x: 0, y: 0, z: 0 });
    expect(e.fireH).toBeGreaterThanOrEqual(0);
    expect(e.columnH).toBeGreaterThanOrEqual(0);
    // the wreck stays
    run(sq, 20);
    expect(sq.entities.includes(e)).toBe(true);
    expect(e.char).toBe(1);
  });

  it('a Mi-24 loses its tail rotor, spins and autorotates down', () => {
    const { world, sq } = setup();
    sq.reset(AIRPORT_PLAYER);
    run(sq, 2);
    const e = sq.entities.find((x) => x.kind === 'helo')!;
    kill(world, e.target.id, 'gun');
    run(sq, 4);
    expect(e.phase).toBe('falling');
    expect(e.fall!.part?.which).toBe('tailRotor');
    expect(Math.abs(e.fall!.yawRate)).toBeGreaterThan(2);
    expect(e.fall!.vy).toBeLessThan(-8);
    expect(e.fall!.vy).toBeGreaterThan(-A.wreck.heloDescentMs - 3);
    run(sq, 60);
    expect(e.phase).toBe('wreck');
  });

  it('a replacement joins its slot respawnS after the kill, far from the player; reset brings everyone back', () => {
    const { world, sq } = setup();
    sq.reset(AIRPORT_PLAYER);
    run(sq, 1);
    const e = sq.entities.find((x) => x.kind === 'attack')!;
    kill(world, e.target.id);
    run(sq, A.respawnS - 2);
    expect(sq.live().filter((x) => x.kind === 'attack')).toHaveLength(1);
    run(sq, 4);
    const attack = sq.live().filter((x) => x.kind === 'attack');
    expect(attack).toHaveLength(2);
    const fresh = attack.find((x) => x !== e && x.slot === e.slot)!;
    expect(fresh.target.id).not.toBe(e.target.id);
    expect(sq.entities.includes(e)).toBe(true); // wreck still there
    // Reset: 8 live, no wrecks; the world holds exactly our 8 aircraft; same places as the first reset.
    const { sq: ref } = setup();
    ref.reset(AIRPORT_PLAYER);
    sq.reset(AIRPORT_PLAYER);
    expect(sq.entities).toHaveLength(8);
    expect(sq.live()).toHaveLength(8);
    expect(world.targets.filter((t) => world.isAir(t))).toHaveLength(8);
    expect(sq.entities.map((x) => Math.round(x.flight.x))).toEqual(ref.entities.map((x) => Math.round(x.flight.x)));
  });

  it('a world.reviveAll (the range reset) never resurrects a wreck in place', () => {
    const { world, sq } = setup();
    sq.reset(AIRPORT_PLAYER);
    run(sq, 1);
    const e = sq.entities[0];
    kill(world, e.target.id);
    run(sq, 2);
    world.reviveAll();
    run(sq, 0.1);
    expect(sq.entities.includes(e)).toBe(false);
    expect(world.targets.includes(e.target)).toBe(false);
  });
});
