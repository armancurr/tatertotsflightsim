/**
 * The sea traffic renderer, driven in node (no WebGL: BatchedMesh/InstancedMesh bookkeeping is
 * plain JS): build slicing, draw-call budget, visibility and LOD rules, pools, pause, sails.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { createShips, MAX_SPRAY, type Ships, type ShipsFrame } from '../../../src/world/traffic/ships';
import { CONFIG } from '../../../src/config';
import { poseMatrix } from '../../../src/world/traffic/points';
import { relWind } from '../../../src/world/traffic/sea';

const sc = CONFIG.world.traffic.sea;
let ships: Ships;
const frame = (o: Partial<ShipsFrame> = {}): ShipsFrame => ({ camX: -4700, camY: 300, camZ: 7300, t: 0, waveTime: 0, dt: 1 / 60, night: 0, viewportHeight: 900, ...o });
const renderables = (g: THREE.Object3D) => {
  let n = 0;
  g.traverse((o) => {
    if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) if (o.visible) n++;
  });
  return n;
};

beforeAll(() => {
  ships = createShips();
  let guard = 0;
  while (!ships.build(8) && guard++ < 5000);
}, 60_000);

describe('pose matrix convention', () => {
  it('heading clockwise from north, pitch nose-up, roll right-side-down', () => {
    const m = new THREE.Matrix4();
    const nose = (h: number, p: number, r: number) => new THREE.Vector3(0, 0, -1).transformDirection(poseMatrix(m, 0, 0, 0, h, p, r));
    const right = (h: number, p: number, r: number) => new THREE.Vector3(1, 0, 0).transformDirection(poseMatrix(m, 0, 0, 0, h, p, r));
    expect(nose(90, 0, 0).x).toBeCloseTo(1);
    expect(nose(180, 0, 0).z).toBeCloseTo(1);
    expect(nose(0, 10, 0).y).toBeGreaterThan(0.15);
    expect(right(0, 0, 20).y).toBeLessThan(-0.3);
    expect(right(270, 0, 0).z).toBeCloseTo(-1);
  });
});

describe('ships renderer (functional)', () => {
  it('builds in many small steps and draws in at most 3 calls', () => {
    const s = ships.stats();
    expect(s.ready).toBe(true);
    expect(s.buildSteps).toBeGreaterThan(40);
    expect(s.rejected).toEqual([]);
    expect(s.moored).toBeGreaterThan(150);
    ships.update(frame({ night: 1 }));
    expect(renderables(ships.group)).toBeLessThanOrEqual(3);
    expect(ships.stats().drawCalls).toBeLessThanOrEqual(3);
  });

  it('marina close up: moored boats near the camera at full detail, far ones simplified; all gone from 20 km', () => {
    const f = ships.plan!.marina.frame;
    ships.update(frame({ camX: f.ox, camY: 120, camZ: f.oz + 150 }));
    let near = 0;
    let far = 0;
    for (let i = 0; i < ships.stats().moored; i++) {
      const v = ships.vesselInfo(`moored:${i}`)!;
      expect(v.visible).toBe(true);
      const d = Math.hypot(v.x - f.ox, 120 - v.y, v.z - (f.oz + 150));
      if (d < sc.lodDistance * 0.95) {
        expect(v.lod).toBe(0);
        near++;
      }
      if (d > sc.lodDistance * 1.05) {
        expect(v.lod).toBe(1);
        far++;
      }
    }
    expect(near).toBeGreaterThan(20);
    ships.update(frame({ camX: f.ox, camY: 500, camZ: f.oz - 20000 }));
    for (let i = 0; i < ships.stats().moored; i++) expect(ships.vesselInfo(`moored:${i}`)!.visible).toBe(false);
    void far;
  });

  it('small craft vanish beyond the view distance, the big ships stay visible much farther', () => {
    for (const t of [0, 900, 2700]) {
      ships.update(frame({ t, camX: 0, camY: 3000, camZ: -8000 }));
      for (const r of ships.plan!.routes) {
        const v = ships.vesselInfo(r.id)!;
        const d = Math.hypot(v.x, v.y - 3000, v.z + 8000);
        const limit = r.kind === 'container' || r.kind === 'tanker' || r.kind === 'ferry' ? sc.shipViewDistance : sc.viewDistance;
        if (d < limit - 1) expect(v.visible, `${r.id} @${d.toFixed(0)}`).toBe(true);
        if (d > limit + 1) expect(v.visible, `${r.id} @${d.toFixed(0)}`).toBe(false);
      }
    }
  });

  it('20 minutes at 10 fps along the coast: finite poses, afloat, pools bounded, wakes and spray present', () => {
    let maxSpray = 0;
    let maxWakes = 0;
    let t = 100;
    const N = 20 * 60 * 10;
    for (let i = 0; i < N; i++) {
      const dt = 1 / 10;
      t += dt;
      const camX = -9000 + (i / N) * 16000;
      ships.update(frame({ t, waveTime: t, dt, camX, camY: 250, camZ: 8600, night: i % 2 }));
      const s = ships.stats();
      maxSpray = Math.max(maxSpray, s.spray);
      maxWakes = Math.max(maxWakes, s.wakes);
      expect(s.spray).toBeLessThanOrEqual(MAX_SPRAY);
      expect(s.wakes).toBeLessThanOrEqual(s.routes);
      expect(s.drawCalls).toBeLessThanOrEqual(3);
      if (i % 50) continue;
      for (const r of ships.plan!.routes) {
        const v = ships.vesselInfo(r.id)!;
        for (const k of [v.x, v.y, v.z]) expect(Number.isFinite(k)).toBe(true);
        if (v.visible) expect(Math.abs(v.y - r.level)).toBeLessThan(1.6);
      }
    }
    expect(maxWakes).toBeGreaterThan(3);
    expect(maxSpray).toBeGreaterThan(5);
  }, 120_000);

  it('paused (no traffic step, same times): nothing moves', () => {
    const f = frame({ t: 5000, waveTime: 777, camX: -4700, camY: 200, camZ: 8200 });
    ships.update(f);
    const snap = () => ships.plan!.routes.map((r) => ships.vesselInfo(r.id)).concat([0, 5, 50].map((i) => ships.vesselInfo(`moored:${i}`)));
    const a = JSON.stringify(snap());
    for (let i = 0; i < 20; i++) ships.update({ ...f, dt: 0 });
    expect(JSON.stringify(snap())).toBe(a);
  });

  it('sails: the boom swings smoothly through a gybe and the sails fill on the boom\'s side', () => {
    const r = ships.plan!.routes.find((x) => x.kind === 'sail')!;
    ships.reset();
    let prevBoom: number | null = null;
    let flips = 0;
    let prevSide: string | null = null;
    const dt = 1 / 8;
    for (let t = 0; t < r.path.duration * 1.05; t += dt) {
      const v0 = ships.vesselInfo(r.id)!;
      ships.update(frame({ t, waveTime: t, dt, camX: v0.x, camY: 60, camZ: v0.z + 100 }));
      const v = ships.vesselInfo(r.id)!;
      if (prevBoom !== null) expect(Math.abs(v.boom - prevBoom)).toBeLessThanOrEqual(60 * dt + 1e-9);
      if (Math.abs(v.boom) > 1) expect(v.sail).toBe(v.boom < 0 ? 'port' : 'starboard');
      if (prevSide && v.sail !== prevSide) flips++;
      prevSide = v.sail;
      prevBoom = v.boom;
    }
    // a triangle course: at least one tack and one gybe per lap
    expect(flips).toBeGreaterThanOrEqual(2);
    expect(Math.abs(relWind(230, 0))).toBeGreaterThan(0);
  }, 60_000);

  it('fuzz: any camera, time and light level keeps the budget and finite poses', () => {
    fc.assert(
      fc.property(fc.double({ min: -50000, max: 50000, noNaN: true }), fc.double({ min: 0, max: 12000, noNaN: true }), fc.double({ min: -30000, max: 40000, noNaN: true }), fc.double({ min: 0, max: 1e5, noNaN: true }), fc.double({ min: 0, max: 1, noNaN: true }), (x, y, z, t, night) => {
        ships.update(frame({ camX: x, camY: y, camZ: z, t, waveTime: t, night }));
        const s = ships.stats();
        expect(s.drawCalls).toBeLessThanOrEqual(3);
        expect(renderables(ships.group)).toBeLessThanOrEqual(3);
        for (const r of ships.plan!.routes) {
          const v = ships.vesselInfo(r.id)!;
          expect(Number.isFinite(v.x + v.y + v.z)).toBe(true);
        }
      }),
      { numRuns: 60 },
    );
  }, 60_000);
});
