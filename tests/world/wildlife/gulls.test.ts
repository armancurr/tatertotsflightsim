import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { fcParams } from '../../support/fc';
import { createGullPlan, flockCentre, GullSim, type BoatPose, type GullFrame } from '../../../src/world/wildlife/gulls';
import { marinaObstacleTop } from '../../../src/world/traffic/harbourObstacles';
import { WILDLIFE } from '../../../src/world/wildlife/tuning';
import { marina } from './support';

const G = WILDLIFE.gull;
const plan = createGullPlan(marina, { windFromDeg: 215, fishingBoats: 2 });

function frame(over: Partial<GullFrame> = {}): GullFrame {
  const fish: BoatPose[] = [
    { x: -4600, z: 12700, heading: 90, speed: 1.9, length: 20, valid: true },
    { x: 3300, z: 12700, heading: 270, speed: 1.7, length: 20, valid: true },
  ];
  return { t: 0, dt: 1 / 30, camX: marina.frame.ox, camY: 40, camZ: marina.frame.oz + 200, fishing: fish, player: null, threats: new Float64Array(64), threatCount: 0, ...over };
}

function run(sim: GullSim, f: GullFrame, seconds: number, each?: (f: GullFrame) => void): void {
  const n = Math.round(seconds / f.dt);
  for (let k = 0; k < n; k++) {
    f.t += f.dt;
    each?.(f);
    sim.update(f);
  }
}

describe('gulls: placement', () => {
  it('has the flocks, perched birds, fishing-boat and player followers the tuning asks for', () => {
    const count = (r: string) => plan.gulls.filter((g) => g.role === r).length;
    expect(count('flock')).toBe(G.flocks.reduce((s, f) => s + f.n, 0));
    expect(count('perch')).toBe(G.perched.breakwater + G.perched.piles + G.perched.visitorPiles + G.perched.beacons + G.perched.quay);
    expect(count('fishing')).toBe(2 * G.fishing);
    expect(count('player')).toBe(G.player);
  });

  it('perched birds stand on top of a marina structure (breakwater, pile, beacon, quay)', () => {
    for (const g of plan.gulls.filter((q) => q.role === 'perch')) {
      const top = marinaObstacleTop(marina, g.px, g.pz);
      expect(top, `${g.px.toFixed(1)},${g.pz.toFixed(1)}`).toBeGreaterThan(0.5);
      expect(Math.abs(g.py - top)).toBeLessThan(0.4);
    }
  });

  it('flock birds stay over their home (marina / harbour) and at gull heights', () => {
    const sim = new GullSim(plan);
    const f = frame();
    const c = { x: 0, z: 0 };
    run(sim, f, 240, () => {
      plan.gulls.forEach((g, i) => {
        if (g.role !== 'flock' || !sim.poses.visible[i]) return;
        const fl = plan.flocks[g.group];
        flockCentre(fl, g.group, f.t, c);
        expect(Math.hypot(sim.poses.x[i] - fl.x, sim.poses.z[i] - fl.z)).toBeLessThan(fl.r * 2.3);
        expect(sim.poses.y[i]).toBeGreaterThan(1.5);
        expect(sim.poses.y[i]).toBeLessThan(80);
      });
    });
  });
});

describe('gulls: motion', () => {
  it('moves continuously at bird speeds', () => {
    const sim = new GullSim(plan);
    const f = frame();
    const prev = plan.gulls.map(() => ({ x: NaN, y: NaN, z: NaN }));
    let worst = 0;
    let worstWho = '';
    run(sim, f, 120, () => {
      plan.gulls.forEach((g, i) => {
        if (!sim.poses.visible[i]) return;
        const p = prev[i];
        if (Number.isFinite(p.x)) {
          const v = Math.hypot(sim.poses.x[i] - p.x, sim.poses.y[i] - p.y, sim.poses.z[i] - p.z) / f.dt;
          if (v > worst) { worst = v; worstWho = `${g.role} ${i} r=${g.r.toFixed(1)} t=${f.t.toFixed(1)}`; }
        }
        p.x = sim.poses.x[i];
        p.y = sim.poses.y[i];
        p.z = sim.poses.z[i];
      });
    });
    expect(worst, worstWho).toBeLessThan(22);
  });

  it('flaps and glides (both happen), wings folded only when perched', () => {
    const sim = new GullSim(plan);
    const f = frame();
    let glide = 0;
    let flap = 0;
    run(sim, f, 60, () => {
      plan.gulls.forEach((g, i) => {
        if (g.role !== 'flock' || !sim.poses.visible[i]) return;
        if (sim.poses.flap[i] < 0.15) glide++;
        if (sim.poses.flap[i] > 0.7) flap++;
        expect(sim.poses.fold[i]).toBe(0);
      });
    });
    expect(glide).toBeGreaterThan(100);
    expect(flap).toBeGreaterThan(100);
    plan.gulls.forEach((g, i) => {
      if (g.role === 'perch') expect(sim.poses.fold[i]).toBe(1);
    });
  });

  it('is deterministic for the same frames', () => {
    const a = new GullSim(plan);
    const b = new GullSim(createGullPlan(marina, { windFromDeg: 215, fishingBoats: 2 }));
    const fa = frame();
    const fb = frame();
    run(a, fa, 30);
    run(b, fb, 30);
    expect(Array.from(b.poses.x)).toEqual(Array.from(a.poses.x));
    expect(Array.from(b.poses.heading)).toEqual(Array.from(a.poses.heading));
  });

  it('fishing-boat followers wheel astern of their boat, dipping to the water but never into it', () => {
    const sim = new GullSim(plan);
    const f = frame({ camX: -4600, camY: 30, camZ: 12800 });
    let dips = 0;
    run(sim, f, 200, () => {
      const b = f.fishing[0] as BoatPose;
      b.x += 1.9 * f.dt;
      plan.gulls.forEach((g, i) => {
        if (g.role !== 'fishing' || g.group !== 0 || !sim.poses.visible[i]) return;
        const d = Math.hypot(sim.poses.x[i] - b.x, sim.poses.z[i] - b.z);
        expect(d).toBeLessThan(80);
        // mostly astern (x < boat x for an eastbound boat)
        expect(sim.poses.x[i]).toBeLessThan(b.x + 25);
        expect(sim.poses.y[i]).toBeGreaterThanOrEqual(1.6);
        if (sim.poses.y[i] < 3) dips++;
      });
    });
    expect(dips).toBeGreaterThan(0);
  });
});

describe('gulls: scatter', () => {
  it('a boat passing close flushes perched birds; they land on their spot again once it has gone', () => {
    const sim = new GullSim(plan);
    const f = frame();
    run(sim, f, 1);
    const pi = plan.gulls.findIndex((g) => g.role === 'perch');
    const g = plan.gulls[pi];
    expect(sim.perched(pi)).toBe(true);
    // a boat drives past the perch
    let flushed = false;
    run(sim, f, 20, () => {
      const s = (f.t - 1) / 20;
      f.threats[0] = g.px - 60 + 120 * s;
      f.threats[1] = 1;
      f.threats[2] = g.pz + 10;
      f.threats[3] = G.scatter.boat;
      f.threatCount = 1;
      if (!sim.perched(pi)) flushed = true;
    });
    expect(flushed).toBe(true);
    f.threatCount = 0;
    run(sim, f, 150);
    expect(sim.perched(pi)).toBe(true);
    expect(sim.poses.x[pi]).toBeCloseTo(g.px, 6);
    expect(sim.poses.y[pi]).toBeCloseTo(g.py, 6);
  });

  it('flying birds shy away from an aircraft passing through the flock', () => {
    const base = new GullSim(plan);
    const pushed = new GullSim(plan);
    const fa = frame();
    const fb = frame();
    const fl = plan.flocks[0];
    const c = { x: 0, z: 0 };
    let minBase = Infinity;
    let minPushed = Infinity;
    const threat = (f: GullFrame) => {
      flockCentre(fl, 0, f.t, c);
      f.threats[0] = c.x;
      f.threats[1] = fl.alt;
      f.threats[2] = c.z;
      f.threats[3] = G.scatter.aircraft;
    };
    for (let k = 0; k < 300; k++) {
      fa.t += fa.dt;
      fb.t += fb.dt;
      threat(fa);
      threat(fb);
      fb.threatCount = 1;
      base.update(fa);
      pushed.update(fb);
      if (k < 150) continue;
      plan.gulls.forEach((g, i) => {
        if (g.role !== 'flock' || g.group !== 0) return;
        minBase = Math.min(minBase, Math.hypot(base.poses.x[i] - fa.threats[0], base.poses.y[i] - fa.threats[1], base.poses.z[i] - fa.threats[2]));
        minPushed = Math.min(minPushed, Math.hypot(pushed.poses.x[i] - fb.threats[0], pushed.poses.y[i] - fb.threats[1], pushed.poses.z[i] - fb.threats[2]));
      });
    }
    expect(minPushed).toBeGreaterThan(minBase + 5);
  });

  it('fuzz: no bird ever comes within the camera clearance, wherever the camera goes', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ dx: fc.noBias(fc.integer({ min: -120, max: 120 })), y: fc.noBias(fc.integer({ min: 1, max: 60 })), dz: fc.noBias(fc.integer({ min: -120, max: 400 })) }), { minLength: 2, maxLength: 5 }),
        (path) => {
          const sim = new GullSim(plan);
          const f = frame();
          const legT = 6;
          for (let k = 0; k < path.length * legT * 20; k++) {
            f.dt = 1 / 20;
            f.t += f.dt;
            const s = (k / 20) / legT;
            const a = path[Math.min(path.length - 1, Math.floor(s))];
            const b = path[Math.min(path.length - 1, Math.floor(s) + 1)];
            const u = s - Math.floor(s);
            f.camX = marina.frame.ox + a.dx + (b.dx - a.dx) * u;
            f.camY = a.y + (b.y - a.y) * u;
            f.camZ = marina.frame.oz + a.dz + (b.dz - a.dz) * u;
            f.threats[0] = f.camX;
            f.threats[1] = f.camY;
            f.threats[2] = f.camZ;
            f.threats[3] = G.scatter.camera;
            f.threatCount = 1;
            sim.update(f);
            for (let i = 0; i < plan.gulls.length; i++) {
              if (!sim.poses.visible[i]) continue;
              const d = Math.hypot(sim.poses.x[i] - f.camX, sim.poses.y[i] - f.camY, sim.poses.z[i] - f.camZ);
              expect(d).toBeGreaterThanOrEqual(G.cameraClearance - 1e-6);
            }
          }
        },
      ),
      fcParams(10),
    );
  }, 60_000);
});

describe('gulls: following the player', () => {
  it('join when the boat gets underway, hover over the wake astern, and leave after it stops', () => {
    const sim = new GullSim(plan);
    const player: BoatPose = { x: -5000, z: 10800, heading: 180, speed: 0, length: 15.5, valid: true };
    const f = frame({ camX: -5000, camY: 5, camZ: 10780, player });
    // the player's own boat is a threat to other birds, not to its followers
    f.threatCount = 1;
    f.playerThreat = 0;
    f.threats[3] = G.scatter.boat;
    const idx = plan.gulls.map((g, i) => (g.role === 'player' ? i : -1)).filter((i) => i >= 0);
    run(sim, f, 5);
    expect(idx.every((i) => !sim.poses.visible[i])).toBe(true);
    player.speed = 10;
    run(sim, f, 60, () => {
      player.z += player.speed * f.dt;
      f.camZ = player.z - 20;
      f.threats[0] = player.x;
      f.threats[1] = 2;
      f.threats[2] = player.z;
    });
    expect(sim.stats().followers).toBe(true);
    for (const i of idx) {
      expect(sim.poses.visible[i]).toBe(1);
      // around the after body and astern (south-bound boat: smaller z), within the wake's reach, above the water
      expect(sim.poses.z[i]).toBeLessThan(player.z + 10);
      expect(Math.hypot(sim.poses.x[i] - player.x, sim.poses.z[i] - player.z)).toBeLessThan(90);
      expect(sim.poses.y[i]).toBeGreaterThan(3);
    }
    player.speed = 0;
    run(sim, f, G.playerLinger + 60);
    expect(sim.stats().followers).toBe(false);
    expect(idx.every((i) => !sim.poses.visible[i])).toBe(true);
  });
});
