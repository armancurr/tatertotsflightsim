/**
 * 747-400 flight deck (functional, geometry built in node): parts and draw calls, cockpit-only
 * visibility, the view from the captain's design eye (forward cone clear through the windscreen,
 * ~20° over the nose, the six displays and the standby instruments unobstructed from the pilots'
 * eyes), the moving parts follow the controls, the deck light lets the sun in only through the
 * windows (+ fuzz), the geometry stays inside the room, and dispose releases everything.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { createB747FlightDeck, attachFlightDeck, DECK_PART, type B747FlightDeck } from '../../../src/aircraft/b747/flightDeck';
import { DECK_LIGHT_GLSL, deckSunVisibility } from '../../../src/aircraft/b747/flightDeckLight';
import { DISPLAY, DISPLAY_AT, DISPLAY_IDS, EYE_CAPTAIN, EYE_FO, GLARESHIELD, OVERHEAD, PANEL, THRUST, deckToBody, insideRoom, panelPoint, type V3 } from '../../../src/aircraft/b747/flightDeckLayout';
import { createDefaultVisualState, createRestReadings, type AircraftVisualState } from '../../../src/aircraft/types';
import { createB747Model } from '../../../src/aircraft/b747';

const DEG = Math.PI / 180;
const vec = (p: V3) => new THREE.Vector3(p.x, p.y, p.z);
function vs(patch: Partial<AircraftVisualState> = {}, r: Record<string, unknown> = {}): AircraftVisualState {
  return { ...createDefaultVisualState(), cameraMode: 'cockpit', engineRunning: true, instruments: { ...createRestReadings(), ...r } as never, ...patch };
}
const dirOf = (yawDeg: number, pitchDeg: number) =>
  new THREE.Vector3(Math.sin(yawDeg * DEG) * Math.cos(pitchDeg * DEG), Math.sin(pitchDeg * DEG), -Math.cos(yawDeg * DEG) * Math.cos(pitchDeg * DEG));
function opaque(root: THREE.Object3D, except: THREE.Object3D[] = []): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  root.updateMatrixWorld(true);
  root.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !(m.material as THREE.Material).transparent && !except.includes(o)) out.push(o);
  });
  return out;
}
const byName = (d: B747FlightDeck, n: string) => {
  const o = d.group.getObjectByName(n);
  if (!o) throw new Error(`missing ${n}`);
  return o;
};

describe('747 flight deck: build, parts, draw calls, visibility', () => {
  let d: B747FlightDeck;
  beforeAll(() => {
    d = createB747FlightDeck();
    d.setVisualState(vs(), 1 / 60);
    d.group.updateMatrixWorld(true);
  }, 30000);
  afterAll(() => d.dispose());

  it('has every named part: lining, faces, glass, six displays + standby, levers, columns, yokes, pedals', () => {
    for (const n of [DECK_PART.lining, DECK_PART.faces, DECK_PART.glass, DECK_PART.standby, DECK_PART.thrust, DECK_PART.speedBrake, DECK_PART.flap, DECK_PART.gear, DECK_PART.pedals, DECK_PART.column('L'), DECK_PART.column('R'), DECK_PART.yoke('L'), DECK_PART.yoke('R')]) byName(d, n);
    for (const id of DISPLAY_IDS) byName(d, DECK_PART.screen(id));
    expect((byName(d, DECK_PART.thrust) as THREE.InstancedMesh).count).toBe(4);
  });

  it('is cheap: ≤ 20 draw calls in the cockpit view', () => {
    let calls = 0;
    d.group.traverseVisible((o) => {
      if ((o as THREE.Mesh).isMesh) calls++;
    });
    expect(calls).toBeLessThanOrEqual(20);
  });

  it('shows only in the cockpit view (and not after a crash)', () => {
    const e = createB747FlightDeck();
    e.setVisualState(vs({ cameraMode: 'chase' }), 1 / 60);
    expect(e.group.visible).toBe(false);
    e.setVisualState(vs({ cameraMode: 'cockpit' }), 1 / 60);
    expect(e.group.visible).toBe(true);
    e.setVisualState(vs({ cameraMode: 'cockpit', crashed: true }), 1 / 60);
    expect(e.group.visible).toBe(false);
    e.dispose();
  }, 30000);

  it('sits in the body frame at the config eye (the group origin is the captain’s eye station)', () => {
    const eye = deckToBody(EYE_CAPTAIN);
    const p = new THREE.Vector3(EYE_CAPTAIN.x, 0, 0).applyMatrix4(d.group.matrixWorld);
    expect(p.distanceTo(vec(eye))).toBeLessThan(1e-9);
  });

  it('the lining, furniture and panel faces stay inside the room (≤ 6 cm into the walls)', () => {
    for (const n of [DECK_PART.lining, DECK_PART.faces]) {
      const g = (byName(d, n) as THREE.Mesh).geometry;
      const p = g.getAttribute('position');
      let bad = 0;
      for (let i = 0; i < p.count; i++) if (!insideRoom({ x: p.getX(i), y: p.getY(i), z: p.getZ(i) }, -0.06)) bad++;
      expect(bad, n).toBe(0);
    }
  });
});

describe('747 flight deck: the view from the pilots’ eyes', () => {
  let d: B747FlightDeck;
  const ray = new THREE.Raycaster();
  beforeAll(() => {
    d = createB747FlightDeck();
    d.setVisualState(vs(), 1 / 60);
    d.group.position.set(0, 0, 0); // work in the deck frame
    d.group.updateMatrixWorld(true);
  }, 30000);
  afterAll(() => d.dispose());
  const hit = (from: THREE.Vector3, dir: THREE.Vector3, occ: THREE.Object3D[], max = 6) => {
    ray.set(from, dir.clone().normalize());
    const h = ray.intersectObjects(occ, false)[0];
    return h && h.distance < max ? h : null;
  };

  it('forward cone clear through the windscreen: ±15° either side of the nose, from 16° down to 22° up', () => {
    const occ = opaque(d.group);
    const eye = vec(EYE_CAPTAIN);
    for (let yaw = -15; yaw <= 15; yaw += 5) for (let pitch = -16; pitch <= 22; pitch += 2) {
      const h = hit(eye, dirOf(yaw, pitch), occ);
      expect(h, `yaw ${yaw} pitch ${pitch}: ${h?.object.name}`).toBeNull();
    }
  }, 30000);

  it('over the nose: the glareshield is the first obstruction straight ahead, ~20° down (747-400: ~20°)', () => {
    const occ = opaque(d.group);
    const eye = vec(EYE_CAPTAIN);
    let first = 90;
    for (let p = 0; p >= -40; p -= 0.1) {
      if (hit(eye, dirOf(0, p), occ, 3)) {
        first = -p;
        break;
      }
    }
    expect(first).toBeGreaterThan(18.5);
    expect(first).toBeLessThan(22.5);
    // …at the glareshield lip.
    expect(Math.atan2(-GLARESHIELD.lipY, -GLARESHIELD.lipZ) / DEG).toBeCloseTo(first, 0);
  }, 30000);

  it('the six displays and the standby instruments are unobstructed from the pilots’ eyes', () => {
    const screens = DISPLAY_IDS.map((id) => byName(d, DECK_PART.screen(id)));
    const occ = opaque(d.group, screens);
    const hs = DISPLAY.screen / 2 - 0.004;
    for (const id of DISPLAY_IDS) {
      const { px, py } = DISPLAY_AT[id];
      // The captain sees his own PFD/ND, the EICAS and the F/O's; the F/O likewise.
      for (const eyeP of [EYE_CAPTAIN, EYE_FO]) {
        const eye = vec(eyeP);
        for (let i = 0; i <= 4; i++) for (let j = 0; j <= 4; j++) {
          const q = vec(panelPoint(px - hs + (2 * hs * i) / 4, py - hs + (2 * hs * j) / 4, 0.0245));
          const dvec = q.clone().sub(eye);
          const h = hit(eye, dvec, occ, 5);
          if (h) expect(h.distance, `${id} (${i},${j}) from x=${eyeP.x}: hidden by ${h.object.name}`).toBeGreaterThan(dvec.length() - 0.005);
        }
      }
    }
  }, 60000);

  it('looking up shows the overhead panel; looking down, the pedestal and thrust levers are there', () => {
    const occ = opaque(d.group);
    const eye = vec(EYE_CAPTAIN);
    // A point in the middle of the overhead panel's left half.
    const oh = new THREE.Vector3(-0.2, OVERHEAD.front.y + (OVERHEAD.back.y - OVERHEAD.front.y) * 0.45 - 0.01, OVERHEAD.front.z + (OVERHEAD.back.z - OVERHEAD.front.z) * 0.45);
    const up = hit(eye, oh.clone().sub(eye), occ, 2);
    // The panel face or a switch standing on it — nothing else in between.
    expect(up).not.toBeNull();
    expect(up!.distance).toBeGreaterThan(oh.distanceTo(eye) - 0.05);
    expect(oh.clone().sub(eye).angleTo(new THREE.Vector3(0, 0, -1)) / DEG).toBeGreaterThan(40);
    const m = new THREE.Matrix4();
    (byName(d, DECK_PART.thrust) as THREE.InstancedMesh).getMatrixAt(1, m);
    const knob = new THREE.Vector3(0, THRUST.length + 0.01, 0.015).applyMatrix4(m);
    const h = hit(eye, knob.clone().sub(eye), occ, 3);
    expect(h?.object.name).toBe(DECK_PART.thrust);
  }, 30000);
});

describe('747 flight deck: moving parts follow the controls', () => {
  it('thrust levers forward with the throttle, flap lever aft with the flaps, speed brake aft when up, gear lever, yoke and column', () => {
    const d = createB747FlightDeck();
    const settle = (v: AircraftVisualState) => {
      for (let i = 0; i < 90; i++) d.setVisualState(v, 1 / 30);
      d.group.updateMatrixWorld(true);
    };
    const knobZ = () => {
      const m = new THREE.Matrix4();
      (byName(d, DECK_PART.thrust) as THREE.InstancedMesh).getMatrixAt(0, m);
      return new THREE.Vector3(0, THRUST.length, 0).applyMatrix4(m).z;
    };
    const tip = (n: string, local: THREE.Vector3) => local.clone().applyMatrix4(byName(d, n).matrixWorld);
    settle(vs({}, { throttlePct: 0, flapsTargetDeg: 0 }));
    const z0 = knobZ();
    const flap0 = tip(DECK_PART.flap, new THREE.Vector3(0, 0.2, 0));
    const sb0 = tip(DECK_PART.speedBrake, new THREE.Vector3(0, 0.2, 0));
    const yoke0 = tip(DECK_PART.yoke('L'), new THREE.Vector3(0.18, 0.09, 0));
    const col0 = tip(DECK_PART.column('L'), new THREE.Vector3(0, 0.6, 0.24));
    const gear0 = tip(DECK_PART.gear, new THREE.Vector3(0, 0, 0.1));
    settle(vs({ speedBrake: 1, elevator: 1, aileron: 1, gearPos: 0.5 }, { throttlePct: 100, flapsTargetDeg: 30, gearHandleDown: false }));
    expect(z0 - knobZ()).toBeGreaterThan(0.12);
    expect(tip(DECK_PART.flap, new THREE.Vector3(0, 0.2, 0)).z - flap0.z).toBeGreaterThan(0.1);
    expect(tip(DECK_PART.speedBrake, new THREE.Vector3(0, 0.2, 0)).z - sb0.z).toBeGreaterThan(0.08);
    // Right aileron: the yoke's right grip goes down.
    expect(tip(DECK_PART.yoke('L'), new THREE.Vector3(0.18, 0.09, 0)).y - yoke0.y).toBeLessThan(-0.08);
    // Up elevator: the column comes aft.
    expect(tip(DECK_PART.column('L'), new THREE.Vector3(0, 0.6, 0.24)).z - col0.z).toBeGreaterThan(0.05);
    // Gear handle UP: the knob rises.
    expect(tip(DECK_PART.gear, new THREE.Vector3(0, 0, 0.1)).y - gear0.y).toBeGreaterThan(0.04);
    d.dispose();
  }, 30000);
});

describe('747 flight deck light (sun through the windows only)', () => {
  const up = { x: 0, y: 1, z: 0 };
  it('sun overhead: the pedestal and the floor are in the roof’s shade; sun ahead-low: the pedestal is lit through the windscreen', () => {
    expect(deckSunVisibility({ x: 0, y: -0.7, z: -0.3 }, up)).toBe(0);
    expect(deckSunVisibility({ x: 0.3, y: -1.2, z: 0.5 }, up)).toBe(0);
    expect(deckSunVisibility({ x: -0.3, y: -0.2, z: -0.2 }, { x: 0, y: 0.25, z: -1 })).toBe(1);
  });
  it('sun low on the left: it comes in the left side window and lights the right console', () => {
    expect(deckSunVisibility({ x: 0.9, y: -0.59, z: 0.05 }, { x: -1, y: 0.3, z: 0 })).toBeGreaterThan(0.9);
    // …but not through the left wall below the window.
    expect(deckSunVisibility({ x: 0.9, y: -0.9, z: 0.05 }, { x: -1, y: 0.05, z: 0 })).toBe(0);
  });
  it('the glareshield shades the displays from a sun ahead and above', () => {
    const d = panelPoint(DISPLAY_AT.pfdL.px, 0, 0.03);
    expect(deckSunVisibility(d, { x: 0, y: 0.6, z: -1 })).toBe(0);
  });
  it('fuzz: always finite and within 0..1; the GLSL has the same function', () => {
    const n = fc.oneof(fc.double({ min: -3, max: 3, noNaN: true }), fc.constantFrom(NaN, Infinity, 0));
    fc.assert(
      fc.property(n, n, n, n, n, n, (px, py, pz, sx, sy, sz) => {
        const v = deckSunVisibility({ x: px, y: py, z: pz }, { x: sx, y: sy, z: sz });
        expect(Number.isFinite(v) && v >= 0 && v <= 1).toBe(true);
      }),
      { numRuns: 500 },
    );
    expect(DECK_LIGHT_GLSL).toContain('float deckVis(vec3 p, vec3 s)');
    expect(DECK_LIGHT_GLSL).not.toMatch(/NaN|Infinity/);
  });
});

describe('747 flight deck: attach + dispose', () => {
  it('attaches into the 747 model, animates with it, and disposes every geometry and material', () => {
    const model = createB747Model();
    const deck = (model as { flightDeck?: B747FlightDeck }).flightDeck!;
    expect(deck).toBeDefined();
    expect(model.root.getObjectByName(DECK_PART.group)).toBeTruthy();
    model.setVisualState(vs(), 1 / 60);
    expect(deck.group.visible).toBe(true);
    model.setVisualState(vs({ cameraMode: 'orbit' }), 1 / 60);
    expect(deck.group.visible).toBe(false);
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    deck.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) geos.add(m.geometry);
      if (m.material) mats.add(m.material as THREE.Material);
    });
    const spies = [...geos].map((g) => vi.spyOn(g, 'dispose'));
    const mspies = [...mats].map((m) => vi.spyOn(m, 'dispose'));
    model.dispose();
    for (const s of [...spies, ...mspies]) expect(s).toHaveBeenCalled();
    expect(deck.group.parent).toBeNull();
    void attachFlightDeck;
    void PANEL;
  }, 30000);
});
