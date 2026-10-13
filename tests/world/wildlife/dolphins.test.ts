import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { fcParams } from '../../support/fc';
import {
  bowSlot,
  breath,
  createDolphinPlan,
  DolphinSim,
  freeMemberPose,
  insideHull,
  newBreath,
  newDolphinPose,
  podFrame,
  type DolphinFrame,
  type HullBox,
  type ShipTrack,
  type VesselInfo,
} from '../../../src/world/wildlife/dolphins';
import { exclusionAt, seaDepthAt } from '../../../src/world/wildlife/zones';
import { WILDLIFE } from '../../../src/world/wildlife/tuning';
import { KT } from '../../../src/world/traffic/rng';
import { DEG, toBody, water, zoneCtx } from './support';

const plan = createDolphinPlan(zoneCtx, water);
/** The Princess V50's hull box (src/world/port.ts BERTH_YACHT, rounded out). */
const V50: HullBox = { stemZ: -9.3, transomZ: 6.4, beam: 4.2 };

describe('dolphins: placement', () => {
  it('builds every configured pod (coastal + ship pods) with 3–8 members each', () => {
    expect(plan.rejected).toEqual([]);
    expect(plan.pods.filter((p) => p.kind === 'coastal').length).toBe(WILDLIFE.dolphin.pods.length);
    expect(plan.pods.filter((p) => p.kind === 'ship').length).toBe(WILDLIFE.dolphin.shipPods.length);
    for (const p of plan.pods) {
      expect(p.n).toBeGreaterThanOrEqual(3);
      expect(p.n).toBeLessThanOrEqual(8);
    }
    expect(plan.members.length).toBe(plan.pods.reduce((s, p) => s + p.n, 0));
  });

  it('pod loops keep ≥ 5 m of water and stay out of every exclusion zone', () => {
    for (const p of plan.pods) {
      if (!p.route) continue;
      for (let i = 0; i < p.route.n; i += 3) {
        const x = p.route.x[i];
        const z = p.route.z[i];
        expect(seaDepthAt(water, x, z), `${p.id} depth at ${x.toFixed(0)},${z.toFixed(0)}`).toBeGreaterThanOrEqual(WILDLIFE.dolphin.minDepth);
        expect(exclusionAt(zoneCtx, 'dolphin', x, z), p.id).toBeNull();
        const Z = WILDLIFE.zones;
        expect(Math.hypot(x - Z.gunnery.x, z - Z.gunnery.z)).toBeGreaterThan(Z.gunnery.r);
        expect(Math.hypot(x - Z.oilRig.x, z - Z.oilRig.z)).toBeGreaterThan(Z.oilRig.r);
      }
    }
  });

  it('every member of a free pod stays in the water (≥ 3 m deep under it) over a long run', () => {
    const pose = newDolphinPose();
    for (const m of plan.members) {
      const pod = plan.pods[m.pod];
      if (pod.kind !== 'coastal') continue;
      for (let t = 0; t < 3000; t += 37) {
        freeMemberPose(pod, m, t, pose);
        expect(seaDepthAt(water, pose.x, pose.z), pod.id).toBeGreaterThan(3);
      }
    }
  });
});

describe('dolphins: free motion', () => {
  it('is continuous (position, height, heading) and swims at dolphin speeds', () => {
    const a = newDolphinPose();
    const b = newDolphinPose();
    const dt = 0.05;
    for (const m of plan.members.slice(0, 20)) {
      const pod = plan.pods[m.pod];
      if (pod.kind !== 'coastal') continue;
      freeMemberPose(pod, m, 0, a);
      for (let t = dt; t < 200; t += dt) {
        freeMemberPose(pod, m, t, b);
        expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThan(8 * dt);
        expect(Math.abs(b.dy - a.dy)).toBeLessThan(9 * dt);
        const dh = Math.abs(((b.heading - a.heading + 540) % 360) - 180);
        expect(dh).toBeLessThan(30 * dt * 10);
        a.x = b.x; a.z = b.z; a.dy = b.dy; a.heading = b.heading;
      }
    }
  });

  it('spends most of the time under the surface and breaks it to breathe every cycle', () => {
    const br = newBreath();
    for (const m of plan.members.slice(0, 12)) {
      let above = 0;
      let n = 0;
      let surfacings = 0;
      let was = false;
      for (let t = 0; t < 600; t += 0.05) {
        breath(m, 'cruise', t, br);
        const up = br.dy > -0.3;
        if (up) above++;
        if (up && !was) surfacings++;
        was = up;
        n++;
        // never higher than a leap, never deeper than a few metres
        expect(br.dy).toBeLessThan(3.5);
        expect(br.dy).toBeGreaterThan(-4);
      }
      expect(above / n).toBeLessThan(0.3);
      expect(surfacings).toBeGreaterThanOrEqual(Math.floor(600 / m.period) - 1);
    }
  });

  it('is deterministic: an independently built plan gives the same poses', () => {
    const plan2 = createDolphinPlan(zoneCtx, water);
    const a = newDolphinPose();
    const b = newDolphinPose();
    for (let i = 0; i < plan.members.length; i++) {
      const pod = plan.pods[plan.members[i].pod];
      if (pod.kind !== 'coastal') continue;
      for (const t of [0, 13.7, 999.1, 86400.3]) {
        freeMemberPose(pod, plan.members[i], t, a);
        freeMemberPose(plan2.pods[plan2.members[i].pod], plan2.members[i], t, b);
        expect(b).toEqual(a);
      }
    }
  });
});

describe('dolphins: bow slots', () => {
  it('put most of a pod at the bow and a couple alongside the after body', () => {
    const s = { bx: 0, bz: 0 };
    let bow = 0;
    let quarter = 0;
    for (let k = 0; k < 8; k++) {
      bowSlot(k, 0, V50, 2.7, s);
      if (s.bz < V50.stemZ + 5) bow++;
      else if (s.bz > V50.stemZ + 5) quarter++;
    }
    expect(bow).toBeGreaterThanOrEqual(6);
    expect(quarter).toBe(2);
  });

  it('are always outside the hull box (grown by the clearance + half a body when ahead)', () => {
    const s = { bx: 0, bz: 0 };
    for (const hull of [V50, { stemZ: -140, transomZ: 135, beam: 32 }, { stemZ: -2, transomZ: 1.3, beam: 1.2 }]) {
      for (let k = 0; k < 8; k++) {
        for (let t = 0; t < 120; t += 0.25) {
          bowSlot(k, t, hull, 2.7, s);
          expect(insideHull(s.bx, s.bz, hull, WILDLIFE.dolphin.ride.hullClearance), `k${k} t${t}`).toBe(false);
          // in the boat's waves: ≤ 16 m ahead of the stem, beside the forward third, or alongside the after body
          expect(s.bz).toBeGreaterThan(hull.stemZ - 16);
          const L = hull.transomZ - hull.stemZ;
          const forward = s.bz < hull.stemZ + Math.max(0.3 * L + 2, 9);
          const quarter = s.bz > hull.transomZ - 0.35 * L - 2 && s.bz < hull.transomZ + 5 && Math.abs(s.bx) < hull.beam / 2 + 5;
          expect(forward || quarter, `k${k} bz ${s.bz}`).toBe(true);
        }
      }
    }
  });
});

// ─── The bow-riding state machine ─────────────────────────────────────────────

interface Drive {
  /** Speed (kt) and turn rate (deg/s) as a function of time. */
  kt: (t: number) => number;
  turn: (t: number) => number;
}

function runRide(start: { x: number; z: number; heading: number }, drive: Drive, seconds: number, dt = 1 / 30, sim = new DolphinSim(plan, water)) {
  const v: VesselInfo = { x: start.x, z: start.z, heading: start.heading, speed: 0, vx: 0, vz: 0, hull: V50 };
  const f: DolphinFrame = { t: 0, dt, trafficT: 0, camX: v.x, camZ: v.z, vessel: v, ships: [] };
  const modes: string[] = [];
  const violations: string[] = [];
  const prev = plan.members.map(() => ({ x: NaN, z: NaN }));
  let maxStep = 0;
  let worstAt = '';
  for (let t = 0; t < seconds; t += dt) {
    v.speed = drive.kt(t) * KT;
    v.heading = (v.heading + drive.turn(t) * dt + 360) % 360;
    const h = v.heading * DEG;
    v.vx = Math.sin(h) * v.speed;
    v.vz = -Math.cos(h) * v.speed;
    v.x += v.vx * dt;
    v.z += v.vz * dt;
    f.t = t;
    f.camX = v.x;
    f.camZ = v.z;
    sim.update(f);
    const mode = sim.riding >= 0 ? sim.pods[sim.riding].mode : 'none';
    if (modes[modes.length - 1] !== mode) modes.push(mode);
    for (let i = 0; i < plan.members.length; i++) {
      const p = sim.poses[i];
      if (!p.visible) {
        prev[i].x = NaN;
        continue;
      }
      const b = toBody(p.x, p.z, v.x, v.z, v.heading);
      if (insideHull(b.bx, b.bz, V50, WILDLIFE.dolphin.ride.hullClearance - 1e-6)) violations.push(`t=${t.toFixed(2)} member ${i} at ${b.bx.toFixed(2)},${b.bz.toFixed(2)}`);
      if (Number.isFinite(prev[i].x) && plan.pods[plan.members[i].pod].kind === 'coastal') {
        const step = Math.hypot(p.x - prev[i].x, p.z - prev[i].z) / dt;
        if (step > maxStep) {
          maxStep = step;
          worstAt = `t=${t.toFixed(2)} member ${i} pod ${plan.members[i].pod} mode ${sim.pods[plan.members[i].pod].mode} body ${b.bx.toFixed(2)},${b.bz.toFixed(2)}`;
        }
      }
      prev[i].x = p.x;
      prev[i].z = p.z;
    }
  }
  return { sim, v, modes, violations, maxStep, worstAt };
}

/** A start 150 m abeam of pod `p`'s centre, heading along its loop. */
function nearPod(p: number, off = 150): { x: number; z: number; heading: number } {
  const pf = { x: 0, z: 0, heading: 0, speed: 0 };
  podFrame(plan.pods[p], 0, pf);
  const h = pf.heading * DEG;
  return { x: pf.x + Math.cos(h) * off, z: pf.z + Math.sin(h) * off, heading: pf.heading };
}

describe('dolphins: bow riding', () => {
  const pod = plan.pods.findIndex((p) => p.id === 'pod-2');

  it('a vessel at 15 kt near a pod: the pod approaches, rides, peels off and goes home — never inside the hull', () => {
    const r = runRide(nearPod(pod), { kt: () => 15, turn: () => 0 }, 420);
    expect(r.violations).toEqual([]);
    // engaged at once (the boat starts in reach), rode, peeled off, and swam home (no longer riding)
    expect(r.modes.slice(0, 4)).toEqual(['approach', 'ride', 'peel', 'none']);
    expect(['home', 'free']).toContain(r.sim.pods[pod].mode);
    expect(r.sim.pods[pod].engagements).toBe(1);
    // positions stay continuous (limited swimming speed, the hull guard never has to jump them)
    expect(r.maxStep).toBeLessThan(15 * KT + WILDLIFE.dolphin.ride.catchUp + 1);
  });

  it('while riding, the pod holds station at the bow (every member within a few metres of its slot)', () => {
    const sim = new DolphinSim(plan, water);
    const v: VesselInfo = { ...nearPod(pod), speed: 12 * KT, vx: 0, vz: 0, hull: V50 };
    const f: DolphinFrame = { t: 0, dt: 1 / 30, trafficT: 0, camX: v.x, camZ: v.z, vessel: v, ships: [] };
    const s = { bx: 0, bz: 0 };
    let checked = 0;
    for (let t = 0; t < 150; t += f.dt) {
      const h = v.heading * DEG;
      v.vx = Math.sin(h) * v.speed;
      v.vz = -Math.cos(h) * v.speed;
      v.x += v.vx * f.dt;
      v.z += v.vz * f.dt;
      f.t = t;
      sim.update(f);
      if (sim.pods[pod].mode === 'ride' && sim.pods[pod].timer > 8) {
        for (let k = 0; k < plan.pods[pod].n; k++) {
          const i = plan.pods[pod].first + k;
          const p = sim.poses[i];
          bowSlot(k, t, V50, plan.members[i].length, s);
          const b = toBody(p.x, p.z, v.x, v.z, v.heading);
          expect(Math.hypot(b.bx - s.bx, b.bz - s.bz)).toBeLessThan(3);
          // matching the boat's speed and heading
          expect(Math.abs(p.speed - v.speed)).toBeLessThan(2.5);
        }
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('after peeling off the pod swims home and is back on its deterministic track', () => {
    const r = runRide(nearPod(pod), { kt: (t) => (t < 200 ? 15 : 0), turn: () => 0 }, 900, 1 / 10);
    expect(r.sim.pods[pod].mode).toBe('free');
    const a = newDolphinPose();
    const pf = podFrame(plan.pods[pod], 900, { x: 0, z: 0, heading: 0, speed: 0 });
    r.sim.update({ t: 900, dt: 0.1, trafficT: 0, camX: pf.x, camZ: pf.z, vessel: r.v, ships: [] });
    for (let k = 0; k < plan.pods[pod].n; k++) {
      const i = plan.pods[pod].first + k;
      freeMemberPose(plan.pods[pod], plan.members[i], 900, a);
      expect(Math.hypot(r.sim.poses[i].x - a.x, r.sim.poses[i].z - a.z)).toBeLessThan(0.5);
    }
  });

  it('does not engage when too slow, too fast or too far', () => {
    for (const kt of [3, 32]) {
      const r = runRide(nearPod(pod), { kt: () => kt, turn: () => 0 }, 30);
      expect(r.modes, `${kt} kt`).toEqual(['none']);
    }
    const far = runRide(nearPod(pod, 900), { kt: () => 12, turn: () => 0 }, 10);
    expect(far.modes).toEqual(['none']);
  });

  it('peels off when the vessel slows below the window, then cools down', () => {
    const r = runRide(nearPod(pod), { kt: (t) => (t < 60 ? 14 : 2), turn: () => 0 }, 90);
    expect(r.modes).toContain('peel');
    expect(r.sim.pods[pod].cooldown).toBeGreaterThan(0);
    expect(r.violations).toEqual([]);
  });

  const runs = { engaged: 0 };
  it('fuzz: any manoeuvres (speed and turn changes, reversing) never put a dolphin inside the hull', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ kt: fc.noBias(fc.integer({ min: -4, max: 30 })), turn: fc.noBias(fc.integer({ min: -12, max: 12 })) }), { minLength: 3, maxLength: 8 }),
        fc.integer({ min: 0, max: plan.pods.length - 1 }),
        (legs, p0) => {
          const p = plan.pods[p0].kind === 'coastal' ? p0 : pod;
          const legT = 25;
          const leg = (t: number) => legs[Math.min(legs.length - 1, Math.floor(t / legT))];
          const r = runRide(nearPod(p, 60), { kt: (t) => (leg(t).kt < 0 ? 0 : leg(t).kt), turn: (t) => leg(t).turn }, legs.length * legT, 1 / 20);
          expect(r.violations).toEqual([]);
          expect(r.maxStep, r.worstAt).toBeLessThan(30);
          runs.engaged += r.sim.pods.some((s) => s.engagements > 0) ? 1 : 0;
        },
      ),
      fcParams(12),
    );
    // the property is not vacuous: most runs had a pod come over
    expect(runs.engaged).toBeGreaterThan(3);
  }, 60_000);
});

describe('dolphins: ship pods', () => {
  it('ride a big ship\'s bow only inside their windows, outside its hull, continuously', () => {
    const sim = new DolphinSim(plan, water);
    const ships: ShipTrack[] = plan.pods.filter((p) => p.kind === 'ship').map(() => ({ x: 0, z: 15000, course: 90, speed: 8.7, hull: { stemZ: -147, transomZ: 147, beam: 32.3 }, valid: true }));
    const f: DolphinFrame = { t: 0, dt: 0.1, trafficT: 0, camX: 0, camZ: 15000, vessel: null, ships };
    const shipPod = plan.pods.findIndex((p) => p.kind === 'ship');
    const i0 = plan.pods[shipPod].first;
    let shown = 0;
    let hidden = 0;
    let prev: { x: number; z: number } | null = null;
    for (let T = 0; T < WILDLIFE.dolphin.shipRide.period * 1.5; T += 0.1) {
      for (const s of ships) s.x = 8.7 * T;
      f.trafficT = T;
      f.camX = ships[0].x;
      sim.update(f);
      const p = sim.poses[i0];
      if (!p.visible) {
        hidden++;
        prev = null;
        continue;
      }
      shown++;
      const b = toBody(p.x, p.z, ships[0].x, ships[0].z, 90);
      expect(insideHull(b.bx, b.bz, ships[0].hull, 0.5)).toBe(false);
      if (prev) expect(Math.hypot(p.x - prev.x, p.z - prev.z) / 0.1).toBeLessThan(8.7 + 6);
      prev = { x: p.x, z: p.z };
    }
    expect(shown).toBeGreaterThan(100);
    expect(hidden).toBeGreaterThan(100);
  });
});
