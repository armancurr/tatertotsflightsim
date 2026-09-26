import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createWildlife, type PlayerInfo, type WildlifeFrame } from '../../../src/world/wildlife';
import { podFrame } from '../../../src/world/wildlife/dolphins';
import { whalePose, newWhalePose } from '../../../src/world/wildlife/whales';
import { createSurfaceSampler } from '../../../src/world/wildlife/surface';
import { getSeaSpectrum } from '../../../src/world/water/waves';
import { KT } from '../../../src/world/traffic/rng';
import { WILDLIFE } from '../../../src/world/wildlife/tuning';
import { DEG, layout, marina, water } from './support';

const wild = createWildlife({ layout, marina, water });
const V50 = { stemZ: -9.3, transomZ: 6.4, beam: 4.2 };

function frame(over: Partial<WildlifeFrame> = {}): WildlifeFrame {
  return { t: 0, trafficT: 0, dt: 1 / 60, camX: marina.frame.ox, camY: 20, camZ: marina.frame.oz + 150, player: null, viewportHeight: 900, ...over };
}

/** Runs `n` frames from `f` (a moving vessel if `player` is set) and returns per-frame update times (ms). */
function run(f: WildlifeFrame, n: number, each?: (f: WildlifeFrame) => void): number[] {
  const times: number[] = [];
  for (let k = 0; k < n; k++) {
    f.t += f.dt;
    f.trafficT += f.dt;
    const p = f.player;
    if (p) {
      p.x += p.vx * f.dt;
      p.z += p.vz * f.dt;
      f.camX = p.x - Math.sin(p.heading * DEG) * 15;
      f.camZ = p.z + Math.cos(p.heading * DEG) * 15;
    }
    each?.(f);
    const t0 = performance.now();
    wild.update(f);
    times.push(performance.now() - t0);
  }
  return times;
}

const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

function vesselNear(pod: string, t: number): PlayerInfo {
  const p = wild.dolphins.plan.pods.find((q) => q.id === pod)!;
  const pf = podFrame(p, t, { x: 0, z: 0, heading: 0, speed: 0 });
  const h = pf.heading * DEG;
  const speed = 13 * KT;
  return { x: pf.x + Math.cos(h) * 120, y: 0.5, z: pf.z + Math.sin(h) * 120, heading: pf.heading, speed, vx: Math.sin(h) * speed, vy: 0, vz: -Math.cos(h) * speed, vessel: true, hull: V50 };
}

describe('wildlife renderer', () => {
  it('draws each species with one instanced mesh, plus one point list (and two see-through passes near the camera)', () => {
    const meshes = wild.group.children.filter((o) => o instanceof THREE.InstancedMesh);
    const points = wild.group.children.filter((o) => o instanceof THREE.Points);
    expect(meshes.length).toBe(6);
    expect(points.length).toBe(1);
    const names = wild.group.children.map((o) => o.name).sort();
    expect(names).toEqual(['wildlife.dolphins', 'wildlife.dolphins.underwater', 'wildlife.gulls', 'wildlife.points', 'wildlife.seals', 'wildlife.whales', 'wildlife.whales.underwater']);
  });

  it('stays inside the draw-call budget (≤ 7) wherever the camera is', () => {
    wild.reset();
    const spots: Partial<WildlifeFrame>[] = [
      { camX: marina.frame.ox, camY: 25, camZ: marina.frame.oz + 150 },
      { camX: -3700, camY: 450, camZ: 12500 },
      { camX: 7600, camY: 30, camZ: 10500 },
      { camX: 0, camY: 3000, camZ: 9000 },
    ];
    for (const s of spots) {
      const f = frame(s);
      run(f, 30);
      expect(wild.stats().drawCalls, JSON.stringify(s)).toBeLessThanOrEqual(7);
    }
  });

  it('costs well under half a millisecond per frame (median) at the busiest places', () => {
    wild.reset();
    // the marina (gulls, perched birds, flocks) with a boat underway through it
    const f1 = frame({ player: { x: marina.frame.ox - 300, y: 0.5, z: marina.frame.oz + 380, heading: 90, speed: 8 * KT, vx: 8 * KT, vy: 0, vz: 0, vessel: true, hull: V50 } });
    run(f1, 60);
    const marinaMs = median(run(f1, 400));
    // a pod riding the bow + whales in view
    wild.reset();
    const f2 = frame({ player: vesselNear('pod-4', 0) });
    run(f2, 60);
    const rideMs = median(run(f2, 400));
    // eslint-disable-next-line no-console
    console.log(`wildlife update: marina ${marinaMs.toFixed(3)} ms, riding ${rideMs.toFixed(3)} ms (median)`);
    expect(marinaMs).toBeLessThan(0.5);
    expect(rideMs).toBeLessThan(0.5);
  });

  it('a pod rides the bow of the player\'s vessel and is drawn at the surface around the hull', () => {
    wild.reset();
    const f = frame({ player: vesselNear('pod-2', 0) });
    run(f, 60 * 40);
    const s = wild.stats();
    expect(s.riding).toBe('pod-2');
    expect(s.dolphinsDrawn).toBeGreaterThan(3);
    expect(s.particles).toBeGreaterThanOrEqual(0);
  });

  it('draws animals on or under the drawn sea, never floating above it (except in a leap / breach)', () => {
    wild.reset();
    const f = frame({ camX: -3700, camY: 30, camZ: 12500 });
    const sampler = createSurfaceSampler(getSeaSpectrum());
    const m = new THREE.Matrix4();
    const p = new THREE.Vector3();
    const whales = wild.group.getObjectByName('wildlife.whales') as THREE.InstancedMesh;
    const pose = newWhalePose();
    run(f, 60 * 60, (fr) => {
      sampler.setCamera(fr.camX, fr.camZ);
    });
    for (let i = 0; i < whales.count; i++) {
      whales.getMatrixAt(i, m);
      p.setFromMatrixPosition(m);
      const s = sampler.sample(p.x, p.z, f.t, 0, 14, 3.5, 40);
      // the body centre: below the surface unless breaching
      expect(p.y - s.heave).toBeLessThan(0.45 * 15);
    }
    // and the pure poses agree: a whale's centre is only above the surface in a breach
    for (let i = 0; i < wild.whales.whales.length; i++) {
      for (let t = 0; t < 3000; t += 1) {
        whalePose(wild.whales, i, t, pose);
        if (pose.phase !== 'breach') expect(pose.dy).toBeLessThan(0.1);
      }
    }
  });

  it('gulls at the marina: flocks and perched birds are drawn, far ones as dots', () => {
    wild.reset();
    const f = frame({ camX: marina.frame.ox + 20, camY: 6, camZ: marina.frame.oz + 260 });
    run(f, 60);
    const s = wild.stats();
    expect(s.gullsDrawn).toBeGreaterThan(40);
    expect(s.perched).toBeGreaterThan(30);
    const far = frame({ camX: marina.frame.ox, camY: 30, camZ: marina.frame.oz + 1500 });
    run(far, 30);
    expect(wild.stats().gullDots).toBeGreaterThan(10);
  });

  it('seals lie on Seal Rock and show only near it', () => {
    const seals = wild.group.getObjectByName('wildlife.seals') as THREE.InstancedMesh;
    expect(seals.count).toBe(wild.seals.length);
    run(frame({ camX: 7800, camY: 30, camZ: 10300 }), 2);
    expect(seals.visible).toBe(true);
    run(frame({ camX: -5000, camY: 30, camZ: 9000 }), 2);
    expect(seals.visible).toBe(false);
  });

  it('disposes cleanly', () => {
    const w2 = createWildlife({ layout, marina, water });
    const scene = new THREE.Scene();
    scene.add(w2.group);
    w2.update(frame());
    w2.dispose();
    expect(scene.children.includes(w2.group)).toBe(false);
  });

  it('keeps the gull budget and particle list within their capacities', () => {
    expect(wild.gulls.plan.gulls.length).toBeLessThan(200);
    expect(wild.dolphins.plan.members.length).toBeLessThan(64);
    expect(WILDLIFE.whale.whales.length).toBeLessThanOrEqual(6);
  });
});
