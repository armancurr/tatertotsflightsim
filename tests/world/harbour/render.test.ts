/**
 * The port renderer (src/world/harbour/render.ts) driven in node (no WebGL: the BatchedMesh and point
 * bookkeeping is plain JS): the draw-call budget (three: structures + buoys, lights, beams), time-sliced
 * build, buoys riding the drawn sea near the camera and hidden far away, lights flashing their
 * characters at night, the beams sweeping only in the dark, and the per-frame cost.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';
import { createPortRenderer, BUOY_RANGES, beamGeometry, type PortRenderer, type PortFrame } from '../../../src/world/harbour/render';
import { navaids, lightOn } from '../../../src/world/harbour/navaids';
import { portWorks, pierWorld } from '../../../src/world/harbour/layout';

let port: PortRenderer;
const nav = navaids();
const works = portWorks();
const frame = (o: Partial<PortFrame> = {}): PortFrame => ({ camX: -4700, camY: 200, camZ: 8600, waveTime: 0, night: 0, viewportHeight: 900, ...o });
const drawables = (g: THREE.Object3D) => {
  let n = 0;
  g.traverse((o) => {
    if (((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) && o.visible) n++;
  });
  return n;
};

beforeAll(() => {
  port = createPortRenderer();
  let guard = 0;
  while (!port.build(8) && guard++ < 5000);
}, 60_000);

describe('port renderer', () => {
  it('builds in small slices', () => {
    expect(port.ready).toBe(true);
    expect(port.stats().buildSteps).toBeGreaterThan(10);
    expect(port.stats().maxBuildStepMs).toBeLessThan(250);
    expect(port.stats().instances).toBe(3 + nav.buoys.length);
  });

  it('draws in at most three calls: one batch (piers, lighthouse, every buoy), one point list, the beams', () => {
    port.update(frame({ night: 1 }));
    expect(drawables(port.group)).toBeLessThanOrEqual(3);
    expect(port.stats().drawCalls).toBeLessThanOrEqual(3);
    port.update(frame({ night: 0 }));
    expect(drawables(port.group)).toBeLessThanOrEqual(1);
    let batches = 0;
    port.group.traverse((o) => (batches += (o as THREE.BatchedMesh).isBatchedMesh ? 1 : 0));
    expect(batches).toBe(1);
  });

  it('buoys near the camera ride the waves; far ones sit still; very far ones are hidden', () => {
    const b = nav.buoys.find((x) => x.id === 'marina-1-port')!;
    const cam = { camX: b.x + 60, camZ: b.z + 60, camY: 20 };
    const m = new THREE.Matrix4();
    const batch = port.group.children.find((c) => (c as THREE.BatchedMesh).isBatchedMesh) as THREE.BatchedMesh;
    const idx = 3 + nav.buoys.indexOf(b);
    const ys: number[] = [];
    for (let t = 0; t < 8; t += 0.5) {
      port.update(frame({ ...cam, waveTime: t }));
      batch.getMatrixAt(idx, m);
      ys.push(m.elements[13]);
    }
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(0.02);
    expect(port.stats().buoysBobbing).toBeGreaterThan(0);
    // from 50 km away: none shown
    port.update(frame({ camX: 40000, camZ: 40000 }));
    expect(port.stats().buoysShown).toBe(0);
    // from the marina: only those within the view range
    port.update(frame());
    const inRange = nav.buoys.filter((x) => Math.hypot(x.x + 4700, x.z - 8600) < BUOY_RANGES.view).length;
    expect(port.stats().buoysShown).toBe(inRange);
  });

  it('at night the lights flash their characters; by day they are off', () => {
    const b = nav.buoys.find((x) => x.id === 'cruise-2-starboard')!;
    let onFrames = 0;
    let offFrames = 0;
    for (let t = 0; t < 12; t += 0.05) {
      port.update(frame({ camX: b.x + 100, camZ: b.z, night: 1, waveTime: t }));
      if (lightOn(b.character, t, b.phase)) onFrames++;
      else offFrames++;
    }
    expect(onFrames).toBeGreaterThan(0);
    expect(offFrames).toBeGreaterThan(onFrames);
    port.update(frame({ night: 1, waveTime: 3.3 }));
    const lit = port.stats().lights;
    // pier lamps (steady) + whichever flashing lights are on + the lighthouse lantern
    expect(lit).toBeGreaterThan(works.cruise.lamps.length);
    port.update(frame({ night: 0 }));
    expect(port.stats().lights).toBe(0);
  });

  it('the beams sweep round with the optic, only in the dark', () => {
    port.update(frame({ night: 0 }));
    expect(port.beam.visible).toBe(false);
    port.update(frame({ night: 0.9, waveTime: 0 }));
    expect(port.beam.visible).toBe(true);
    const r0 = port.beam.rotation.y;
    port.update(frame({ night: 0.9, waveTime: 2.5 }));
    // a quarter turn clockwise seen from above (rotation.y decreases)
    expect(port.beam.rotation.y - r0).toBeCloseTo(-Math.PI / 2, 4);
    expect(port.beam.position.y).toBeCloseTo(nav.lighthouse.focalY, 6);
    // two cones, the second trailing the first
    const g = beamGeometry(54);
    expect(g.index!.count).toBeGreaterThan(0);
    g.dispose();
  });

  it('is cheap per frame (well under a millisecond at the port at night)', () => {
    const p = pierWorld(works.cruise.frame, works.cruise.pier.u1, 200);
    for (let i = 0; i < 20; i++) port.update(frame({ camX: p.x, camZ: p.z, night: 1, waveTime: i / 60 }));
    const t0 = performance.now();
    for (let i = 0; i < 300; i++) port.update(frame({ camX: p.x, camZ: p.z, night: 1, waveTime: i / 60 }));
    expect((performance.now() - t0) / 300).toBeLessThan(0.5);
  });
});
