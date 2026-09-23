/**
 * The air traffic renderer, driven in node: draw-call budget, mesh/dot/hidden rules, disc and
 * light pools, contrails, pause and teleport behaviour.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { createAirTraffic, CONTRAIL_SAMPLES, type AirTraffic, type AirTrafficFrame } from '../../../src/world/traffic/airTraffic';
import { getLayout } from '../../../src/world/layout';
import { CONFIG } from '../../../src/config';
import type { PlayerRef } from '../../../src/world/traffic/air';

const ac = CONFIG.world.traffic.air;
const rw = getLayout().airport.runway;
const onRunway = (): PlayerRef => ({ x: rw.threshold.x + rw.dir.x * 45, y: rw.elevation + 1.2, z: rw.threshold.z + rw.dir.z * 45, agl: 0 });
let air: AirTraffic;
const frame = (o: Partial<AirTrafficFrame> = {}): AirTrafficFrame => {
  const p = onRunway();
  return { camX: p.x, camY: p.y + 3, camZ: p.z + 15, t: 0, dt: 1 / 60, night: 0, viewportHeight: 900, fovDeg: 60, player: p, ...o };
};
const renderables = (g: THREE.Object3D) => {
  let n = 0;
  g.traverse((o) => {
    if (((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) && o.visible) n++;
  });
  return n;
};

beforeAll(() => {
  air = createAirTraffic({ t0: 0, player: onRunway });
  let guard = 0;
  while (!air.build(8) && guard++ < 1000);
}, 60_000);

describe('air traffic renderer (functional)', () => {
  it('builds in small steps and draws in at most 4 calls', () => {
    const s = air.stats();
    expect(s.ready).toBe(true);
    expect(s.buildSteps).toBeGreaterThan(8);
    expect(s.entities).toBe(ac.circuit + ac.crossing + (ac.helicopter ? 1 : 0) + ac.airliners);
    air.update(frame({ night: 1 }));
    expect(renderables(air.group)).toBeLessThanOrEqual(4);
    expect(air.stats().drawCalls).toBeLessThanOrEqual(4);
  });

  it('meshes near, dots far, nothing beyond the dot distance; LOD by distance', () => {
    let t = 0;
    for (let i = 0; i < 3000; i++) {
      t += 0.25;
      air.update(frame({ t, dt: 0.25 }));
      for (let k = 0; k < air.stats().entities; k++) {
        const e = air.entityInfo(k)!;
        const md = e.kind === 'a320' ? ac.meshDistance * 3 : ac.meshDistance;
        if (e.mode === 'mesh') {
          expect(e.dist).toBeLessThan(md);
          expect(e.lod).toBe(e.dist > (e.kind === 'a320' ? 2000 : 550) ? 1 : 0);
        }
        if (e.mode === 'dot') {
          expect(e.dist).toBeGreaterThanOrEqual(md);
          expect(e.dist).toBeLessThanOrEqual(ac.dotDistance * (e.kind === 'a320' ? 2 : 1));
        }
      }
      const s = air.stats();
      expect(s.discs).toBeLessThanOrEqual(s.entities * 2);
      expect(s.contrails).toBeLessThanOrEqual(ac.airliners);
      expect(s.meshes + s.dots).toBeLessThanOrEqual(s.entities);
    }
  }, 60_000);

  it('a telephoto view draws the real model instead of the dot (mesh whenever it spans > 3 px)', () => {
    const f = frame({ t: 751, dt: 0.1 });
    air.update(f);
    const k = Array.from({ length: air.stats().entities }, (_, i) => air.entityInfo(i)!).findIndex((e) => e.mode === 'dot' && e.kind !== 'a320' && e.dist < 20000);
    expect(k).toBeGreaterThanOrEqual(0);
    const e = air.entityInfo(k)!;
    air.update({ ...f, dt: 0, fovDeg: 1.5 });
    expect(air.entityInfo(k)!.mode).toBe('mesh');
    air.update({ ...f, dt: 0, fovDeg: 60 });
    expect(air.entityInfo(k)!.mode).toBe(e.mode);
  });

  it('the circuit traffic is drawn as meshes from the runway, with spinning props; airliners lay contrails', () => {
    let meshes = 0;
    let discs = 0;
    let trails = 0;
    for (let t = 752; t < 1652; t += 1) {
      air.update(frame({ t, dt: 1 }));
      const s = air.stats();
      meshes = Math.max(meshes, s.meshes);
      discs = Math.max(discs, s.discs);
      trails = Math.max(trails, s.contrails);
    }
    expect(meshes).toBeGreaterThanOrEqual(2);
    expect(discs).toBeGreaterThanOrEqual(1);
    expect(trails).toBeGreaterThanOrEqual(1);
  });

  it('contrail ribbons: finite, camera-facing strips with bounded opacity', () => {
    let seen = false;
    for (let t = 1660; t < 2300 && !seen; t += 5) {
      air.update(frame({ t, dt: 5 }));
      const mesh = air.group.getObjectByName('traffic.contrails') as THREE.Mesh;
      const n = air.stats().contrails;
      if (!n) continue;
      seen = true;
      const P = mesh.geometry.getAttribute('position').array as Float32Array;
      const D = mesh.geometry.getAttribute('aTrail').array as Float32Array;
      for (let i = 0; i < n * CONTRAIL_SAMPLES * 2; i++) {
        for (let k = 0; k < 3; k++) expect(Number.isFinite(P[i * 3 + k])).toBe(true);
        expect(D[i * 4]).toBeGreaterThanOrEqual(0);
        expect(D[i * 4]).toBeLessThanOrEqual(1);
        expect(D[i * 4 + 2]).toBeGreaterThanOrEqual(0);
        expect(D[i * 4 + 2]).toBeLessThanOrEqual(1);
        expect(P[i * 3 + 1]).toBeGreaterThan(8000); // up at cruise level
      }
      expect(mesh.geometry.drawRange.count).toBe(n * (CONTRAIL_SAMPLES - 1) * 6);
    }
    expect(seen).toBe(true);
  }, 30_000);

  it('paused: poses and render state frozen', () => {
    const f = frame({ t: 2400, dt: 0 });
    air.update({ ...f, dt: 0.5 });
    const snap = () => JSON.stringify(Array.from({ length: air.stats().entities }, (_, k) => air.entityInfo(k)));
    const a = snap();
    for (let i = 0; i < 30; i++) air.update(f);
    expect(snap()).toBe(a);
  });

  it('teleport: traffic re-anchors around the new position and keeps its distance', () => {
    const far: PlayerRef = { x: 15000, y: 1800, z: -12000, agl: 900 };
    air.reanchor(2500, far);
    for (let t = 2500; t < 3100; t += 0.5) {
      air.update(frame({ t, dt: 0.5, camX: far.x, camY: far.y + 3, camZ: far.z + 15, player: far }));
      for (let k = 0; k < air.stats().entities; k++) {
        const e = air.entityInfo(k)!;
        if (e.mode === 'hidden') continue;
        expect(Math.hypot(e.x - far.x, e.y - far.y, e.z - far.z)).toBeGreaterThanOrEqual(CONFIG.world.traffic.playerClearance - 1e-6);
      }
    }
  }, 30_000);

  it('fuzz: any camera, time and light level stays within the budget', () => {
    fc.assert(
      fc.property(fc.double({ min: -40000, max: 40000, noNaN: true }), fc.double({ min: 0, max: 12000, noNaN: true }), fc.double({ min: -40000, max: 40000, noNaN: true }), fc.double({ min: 0, max: 5e4, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (x, y, z, t, night) => {
        const p: PlayerRef = { x, y, z, agl: y };
        air.update(frame({ camX: x, camY: y, camZ: z, t, dt: 0.1, night, player: p }));
        const s = air.stats();
        expect(s.drawCalls).toBeLessThanOrEqual(4);
        expect(renderables(air.group)).toBeLessThanOrEqual(4);
        expect(s.lights).toBeLessThanOrEqual(s.entities * 10);
      }),
      { numRuns: 60 },
    );
  }, 60_000);
});
