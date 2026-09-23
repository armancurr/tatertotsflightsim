/**
 * F-16C cockpit: unit (the bent panel frame), part positions (stick, throttle, gear handle, seat,
 * canopy bow and sills, HUD glass), view clearance from the design eye (the combiner is never
 * covered, the forward / over-the-nose / over-the-side views), cockpit-only detail, the moving
 * parts (throttle, gear handle, stick, landing-light switch), the painters on a recording canvas,
 * dispose; fuzz of the readings and of the motion offsets.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { createF16Model, F16_PART } from '../../../src/aircraft/f16';
import { CANOPY_BOW_Z, CONSOLE, HUD_COMBINER, LAYOUT, LIVE_ATLAS, PANEL, STATIC_ATLAS, STICK, THROTTLE, buildCockpit, panelFrame, panelPoint } from '../../../src/aircraft/f16/cockpit';
import { createLiveInstruments, liveReadings, paintStaticAtlas } from '../../../src/aircraft/f16/cockpitPaint';
import { createDefaultVisualState, createRestReadings, type AircraftVisualState } from '../../../src/aircraft/types';
import { F16_AIRCRAFT } from '../../../src/config';
import { geoCtx, installOffscreenStub } from '../../ui/geoCtx';

const G = F16_AIRCRAFT.geometry;
const EYE = new THREE.Vector3(G.pilotEye.x, G.pilotEye.y, G.pilotEye.z);
const DEG = Math.PI / 180;
type Model = ReturnType<typeof createF16Model>;

function state(patch: Partial<AircraftVisualState> = {}): AircraftVisualState {
  return { ...createDefaultVisualState(), engineRunning: true, cameraMode: 'cockpit', instruments: createRestReadings(), ...patch };
}
function part(m: Model, name: string): THREE.Mesh {
  const o = m.root.getObjectByName(name);
  if (!o) throw new Error(`missing ${name}`);
  return o as THREE.Mesh;
}
function opaque(m: Model): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  m.root.updateMatrixWorld(true);
  m.root.traverseVisible((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh && !(mesh.material as THREE.Material).transparent && !o.userData.noBounds) out.push(o);
  });
  return out;
}
const dirOf = (yawDeg: number, pitchDeg: number) =>
  new THREE.Vector3(Math.sin(yawDeg * DEG) * Math.cos(pitchDeg * DEG), Math.sin(pitchDeg * DEG), -Math.cos(yawDeg * DEG) * Math.cos(pitchDeg * DEG));
/** Bounds of the vertices of a geometry whose uv passes `pick`. */
function weighted(g: THREE.BufferGeometry, pick: (u: number, v: number) => boolean): THREE.Box3 {
  const p = g.getAttribute('position');
  const uv = g.getAttribute('uv');
  const b = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < p.count; i++) if (pick(uv.getX(i), uv.getY(i))) b.expandByPoint(v.fromBufferAttribute(p, i));
  return b;
}

describe('F-16 cockpit: the bent instrument panel (unit + property)', () => {
  it('every panel frame is orthonormal and right-handed; the face looks at the pilot', () => {
    fc.assert(
      fc.property(fc.double({ min: -PANEL.halfWidth, max: PANEL.halfWidth, noNaN: true }), fc.double({ min: -PANEL.depth, max: 0, noNaN: true }), (x, y) => {
        const m = panelFrame(x, y);
        const ex = new THREE.Vector3().setFromMatrixColumn(m, 0);
        const ey = new THREE.Vector3().setFromMatrixColumn(m, 1);
        const ez = new THREE.Vector3().setFromMatrixColumn(m, 2);
        for (const e of [ex, ey, ez]) expect(Math.abs(e.length() - 1)).toBeLessThan(1e-9);
        expect(Math.abs(ex.dot(ey))).toBeLessThan(1e-9);
        expect(new THREE.Vector3().crossVectors(ex, ey).distanceTo(ez)).toBeLessThan(1e-9);
        const p = new THREE.Vector3().setFromMatrixPosition(m);
        expect(ez.dot(EYE.clone().sub(p).normalize())).toBeGreaterThan(0.6);
      }),
      { numRuns: 300 },
    );
  });

  it('the centre and wing mappings meet on the fold (a crease, not a gap) and the wings wrap toward the pilot', () => {
    for (const y of [0, -0.1, -0.3]) {
      for (const s of [-1, 1]) {
        const a = panelPoint(s * (PANEL.fold - 1e-9), y);
        const b = panelPoint(s * (PANEL.fold + 1e-9), y);
        expect(a.distanceTo(b)).toBeLessThan(1e-6);
        expect(panelPoint(s * PANEL.halfWidth, y).z).toBeGreaterThan(panelPoint(0, y).z + 0.05);
      }
    }
  });
});

describe('F-16 cockpit: part positions', () => {
  let m: Model;
  let detail: THREE.BufferGeometry;
  beforeAll(() => {
    m = createF16Model();
    m.setVisualState(state(), 1 / 30);
    m.root.updateMatrixWorld(true);
    detail = part(m, F16_PART.cockpitDetail).geometry;
  });
  afterAll(() => m.dispose());

  it('the side-stick grip stands on the forward right console, at the pilot’s right hand', () => {
    const b = weighted(detail, (_u, v) => v >= 0.9 && v <= 1);
    expect(b.isEmpty()).toBe(false);
    const c = b.getCenter(new THREE.Vector3());
    expect(c.x).toBeGreaterThan(0.28);
    expect(c.x).toBeLessThan(0.45);
    expect(b.max.y).toBeGreaterThan(CONSOLE.top + 0.1);
    expect(b.max.y).toBeLessThan(CONSOLE.top + 0.2);
    expect(Math.abs(c.z - STICK.z)).toBeLessThan(0.08);
    expect(c.z).toBeLessThan(EYE.z);
  });

  it('the throttle grip sits on the left console (with the left glove on it)', () => {
    const b = weighted(detail, (u) => u > 0.99 && u <= 1.001);
    const c = b.getCenter(new THREE.Vector3());
    expect(c.x).toBeLessThan(-0.28);
    expect(c.x).toBeGreaterThan(-0.46);
    expect(b.min.y).toBeGreaterThan(CONSOLE.top - 0.01);
    expect(c.z).toBeGreaterThan(THROTTLE.zIdle - THROTTLE.travel - 0.1);
    expect(c.z).toBeLessThan(THROTTLE.zIdle + 0.05);
  });

  it('the gear handle is on the left auxiliary panel, low, left of the knees, ahead of the pilot', () => {
    const b = weighted(detail, (u) => u >= 2.5);
    const c = b.getCenter(new THREE.Vector3());
    expect(c.x).toBeLessThan(-0.2);
    expect(c.y).toBeGreaterThan(0.4);
    expect(c.y).toBeLessThan(0.62);
    expect(c.z).toBeLessThan(EYE.z - 0.4);
  });

  it('the landing-light switch is beside the gear handle', () => {
    const b = weighted(detail, (_u, v) => v >= 2);
    const c = b.getCenter(new THREE.Vector3());
    expect(c.distanceTo(panelPoint(LAYOUT.landingSwitch.x, LAYOUT.landingSwitch.y))).toBeLessThan(0.03);
  });

  it('the ACES II headrest is right behind the head; the ejection handle is between the knees, in sight', () => {
    const ray = new THREE.Raycaster();
    ray.set(EYE, dirOf(180, 5));
    const hit = ray.intersectObjects(opaque(m), false)[0];
    expect(hit?.object.name).toMatch(/^f16\.cockpit\.(interior|detail)$/);
    expect(hit!.distance).toBeLessThan(0.45);
    expect(hit!.distance).toBeGreaterThan(0.12);
    // The yellow loop: nothing hides it from the eye.
    const handle = new THREE.Vector3(0, 0.335 + 0.03, -4.775 - 0.03);
    ray.set(EYE, handle.clone().sub(EYE).normalize());
    const h2 = ray.intersectObjects(opaque(m), false)[0];
    expect(h2).toBeTruthy();
    expect(h2.distance).toBeGreaterThan(EYE.distanceTo(handle) - 0.06);
  });

  it('the canopy bow is behind the pilot; the canopy sill rails run along both sides', () => {
    expect(CANOPY_BOW_Z).toBeGreaterThan(EYE.z + 0.5);
    const frame = part(m, 'f16.canopy.frame').geometry;
    for (const s of [-1, 1]) {
      const b = weighted(frame, () => true);
      void b;
      const p = frame.getAttribute('position');
      const v = new THREE.Vector3();
      let zMin = Infinity;
      let zMax = -Infinity;
      for (let i = 0; i < p.count; i++) {
        v.fromBufferAttribute(p, i);
        if (s * v.x > 0.38 && v.y > 0.42 && v.y < 0.52) {
          zMin = Math.min(zMin, v.z);
          zMax = Math.max(zMax, v.z);
        }
      }
      expect(zMin).toBeLessThan(EYE.z - 1);
      expect(zMax).toBeGreaterThan(EYE.z + 1);
    }
  });

  it('the pilot’s hands hold the grips (glove within 6 cm of the stick and the throttle grips)', () => {
    const stick = weighted(detail, (_u, v) => v >= 0.9 && v <= 1).getCenter(new THREE.Vector3());
    const throttle = weighted(detail, (u) => u > 0.99 && u <= 1.001).getCenter(new THREE.Vector3());
    const gloveR = weighted(detail, (_u, v) => Math.abs(v - 0.6) < 1e-4).getCenter(new THREE.Vector3());
    expect(gloveR.distanceTo(stick)).toBeLessThan(0.06);
    expect(throttle.x).toBeLessThan(-0.3);
  });
});

describe('F-16 cockpit: view from the design eye', () => {
  let m: Model;
  beforeAll(() => {
    m = createF16Model();
    m.setVisualState(state(), 1 / 30);
    m.root.updateMatrixWorld(true);
  });
  afterAll(() => m.dispose());

  it('the HUD combiner is ~25° × 20° and nothing opaque covers any part of it', () => {
    const glass = m.hudCombiner!;
    const c = HUD_COMBINER;
    const ray = new THREE.Raycaster();
    // Only the cockpit and the canopy frame can come between the eye and the glass (0.6 m away).
    const occ = opaque(m).filter((o) => o.name.startsWith('f16.cockpit') || o.name === 'f16.canopy.frame');
    const toBody = glass.matrixWorld;
    const ang = (a: THREE.Vector3, b: THREE.Vector3) => a.clone().sub(EYE).angleTo(b.clone().sub(EYE)) / DEG;
    const P = (u: number, v: number) => new THREE.Vector3(u * c.w / 2, v * c.h / 2, 0).applyMatrix4(toBody);
    expect(ang(P(-1, 0), P(1, 0))).toBeGreaterThan(22);
    expect(ang(P(-1, 0), P(1, 0))).toBeLessThan(28);
    expect(ang(P(0, -1), P(0, 1))).toBeGreaterThan(18);
    expect(ang(P(0, -1), P(0, 1))).toBeLessThan(23);
    for (let i = 0; i <= 8; i++) {
      for (let j = 0; j <= 8; j++) {
        const q = P(-0.97 + (1.94 * i) / 8, -0.97 + (1.94 * j) / 8);
        const d = q.clone().sub(EYE);
        ray.set(EYE, d.clone().normalize());
        const hit = ray.intersectObjects(occ, false)[0];
        if (hit) expect(hit.distance, `glass (${i}, ${j}) hidden by ${hit.object.name}`).toBeGreaterThan(d.length());
      }
    }
  }, 30000);

  it('over the nose: the cockpit’s first obstruction straight ahead is ~13.5° down, at the bottom edge of the glass', () => {
    // (The radome itself peeks ~1° higher, 2.9 m ahead: anchors.test.ts checks the whole jet, 12–17°.)
    const occ = opaque(m).filter((o) => o.name.startsWith('f16.cockpit'));
    const ray = new THREE.Raycaster();
    let first = 90;
    for (let p = 0; p >= -30; p -= 0.1) {
      ray.set(EYE, dirOf(0, p));
      const hit = ray.intersectObjects(occ, false)[0];
      if (hit && hit.distance < 5) {
        first = -p;
        break;
      }
    }
    expect(first).toBeGreaterThan(12.5);
    expect(first).toBeLessThan(14.5);
    const bottom = new THREE.Vector3(0, -HUD_COMBINER.h / 2, 0).applyMatrix4(m.hudCombiner!.matrixWorld);
    const glassBottomDeg = Math.atan2(EYE.y - bottom.y, EYE.z - bottom.z) / DEG;
    expect(Math.abs(glassBottomDeg - first)).toBeLessThan(1);
  }, 30000);

  it('a bubble-canopy view: clear to the sides and up, over the sills down to 30°, and no frame ahead', () => {
    const occ = opaque(m);
    const ray = new THREE.Raycaster();
    const blocked = (yaw: number, pitch: number) => {
      ray.set(EYE, dirOf(yaw, pitch));
      const hit = ray.intersectObjects(occ, false)[0];
      return hit && hit.distance < 8 ? hit : null;
    };
    for (const yaw of [-120, -90, -60, 60, 90, 120]) for (const pitch of [-30, -10, 0, 20, 45]) expect(blocked(yaw, pitch), `yaw ${yaw} pitch ${pitch}: ${blocked(yaw, pitch)?.object.name}`).toBeNull();
    for (const yaw of [-30, 30]) for (const pitch of [-10, 0, 20, 45]) expect(blocked(yaw, pitch), `yaw ${yaw} pitch ${pitch}`).toBeNull();
    for (const pitch of [-8, 0, 10, 30, 60, 85]) expect(blocked(0, pitch)).toBeNull();
    // The instrument panel is below the glareshield: straight ahead at 25–45° down you see it.
    for (const pitch of [-25, -35, -45]) expect(blocked(0, pitch)?.object.name).toMatch(/f16\.cockpit/);
  }, 30000);
});

describe('F-16 cockpit: what shows where', () => {
  it('cockpit view: the detail and live instruments show and the outside pilot hides; outside: the reverse', () => {
    const m = createF16Model();
    m.setVisualState(state({ cameraMode: 'cockpit' }), 1 / 30);
    expect(part(m, F16_PART.cockpitDetail).visible).toBe(true);
    expect(part(m, F16_PART.cockpitLive).visible).toBe(true);
    expect(part(m, F16_PART.pilotHead).visible).toBe(false);
    for (const mode of ['chase', 'external', 'orbit'] as const) {
      m.setVisualState(state({ cameraMode: mode }), 1 / 30);
      expect(part(m, F16_PART.cockpitDetail).visible).toBe(false);
      expect(part(m, F16_PART.cockpitLive).visible).toBe(false);
      expect(part(m, F16_PART.pilotHead).visible).toBe(true);
    }
    m.dispose();
  });

  it('the cockpit geometry stays inside the canopy and the fuselage (no part pokes out through the glass)', () => {
    const pit = buildCockpit();
    const box = new THREE.Box3();
    for (const g of [pit.interior, pit.detail, pit.panelFace, pit.live]) box.union(new THREE.Box3().setFromBufferAttribute(g.getAttribute('position') as THREE.BufferAttribute));
    expect(box.max.x).toBeLessThan(0.49);
    expect(box.min.x).toBeGreaterThan(-0.49);
    expect(box.max.y).toBeLessThan(1.28);
    expect(box.min.z).toBeGreaterThan(-5.9);
    for (const g of Object.values(pit)) g.dispose();
  });
});

describe('F-16 cockpit: moving parts', () => {
  const motion = (m: Model) => (part(m, F16_PART.cockpitDetail).material as THREE.Material).userData.motion as Record<'throttle' | 'handle' | 'stick' | 'landing', THREE.Vector3>;

  it('the throttle slides forward with the lever; the stick leans a few mm with the controls; the landing switch flips', () => {
    const m = createF16Model();
    const at = (pct: number) => {
      m.setVisualState(state({ instruments: { ...createRestReadings(), throttlePct: pct } }), 1 / 30);
      return motion(m).throttle.z;
    };
    expect(at(100)).toBeLessThan(at(0) - THROTTLE.travel * 0.95);
    m.setVisualState(state({ elevator: 1, aileron: -1 }), 1 / 30);
    expect(motion(m).stick.z).toBeGreaterThan(0.003);
    expect(motion(m).stick.x).toBeLessThan(-0.003);
    expect(motion(m).stick.length()).toBeLessThan(0.012);
    m.setVisualState(state({ lights: { nav: true, strobe: false, beacon: false, landing: true, taxi: false } }), 1 / 30);
    const up = motion(m).landing.y;
    m.setVisualState(state({ lights: { nav: true, strobe: false, beacon: false, landing: false, taxi: true } }), 1 / 30);
    expect(up).toBeGreaterThan(0.005);
    expect(motion(m).landing.y).toBeLessThan(-0.005);
    m.dispose();
  });

  it('the gear handle goes UP as soon as the gear starts up, DN as soon as it starts down', () => {
    const m = createF16Model();
    const handleY = (g: number) => {
      m.setVisualState(state({ gearPos: g }), 1 / 30);
      return motion(m).handle.y;
    };
    expect(handleY(1)).toBe(0);
    expect(handleY(0.97)).toBeGreaterThan(0.03);
    expect(handleY(0.5)).toBeGreaterThan(0.03);
    expect(handleY(0)).toBeGreaterThan(0.03);
    expect(handleY(0.02)).toBe(0);
    expect(handleY(1)).toBe(0);
    m.dispose();
  });

  it('fuzz: whatever the sim sends, the motion offsets stay finite and small', () => {
    const m = createF16Model();
    const wild = fc.oneof(fc.double({ noNaN: false }), fc.constantFrom(Number.NaN, Infinity, -Infinity, 1e12));
    fc.assert(
      fc.property(wild, wild, wild, wild, fc.double({ min: -1, max: 2, noNaN: false }), (thr, el, ail, dt, gear) => {
        m.setVisualState(state({ elevator: el, aileron: ail, gearPos: gear, instruments: { ...createRestReadings(), throttlePct: thr } }), dt);
        for (const v of Object.values(motion(m))) {
          for (const c of v.toArray()) expect(Number.isFinite(c)).toBe(true);
          expect(v.length()).toBeLessThan(0.1);
        }
      }),
      { numRuns: 300 },
    );
    m.dispose();
  });
});

describe('F-16 cockpit painters', () => {
  it('liveReadings fuzz: every value finite and in range, whatever the visual state', () => {
    const wild = fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity));
    fc.assert(
      fc.property(fc.record({ a: wild, b: wild, c: wild, d: wild, e: wild, f: wild, g: wild, h: wild, t: wild, inst: fc.boolean(), run: fc.boolean() }), (r) => {
        const v: AircraftVisualState = {
          ...createDefaultVisualState(),
          time: r.t,
          gearPos: r.g,
          afterburner: r.h,
          engineRunning: r.run,
          instruments: r.inst ? { ...createRestReadings(), airspeedKt: r.a, altitudeFt: r.b, pitchDeg: r.c, rollDeg: r.d, headingDeg: r.e, throttlePct: r.f, verticalSpeedFpm: r.a, aoaDeg: r.b, rpm: r.c, mach: r.d } : null,
        };
        const L = liveReadings(v, true);
        for (const [k, x] of Object.entries(L)) if (typeof x === 'number') expect(Number.isFinite(x), k).toBe(true);
        expect(L.headingDeg).toBeGreaterThanOrEqual(0);
        expect(L.headingDeg).toBeLessThan(360);
        expect(Math.abs(L.rollDeg)).toBeLessThanOrEqual(180);
        expect(L.throttle).toBeGreaterThanOrEqual(0);
        expect(L.throttle).toBeLessThanOrEqual(1);
        expect(L.fuelLb).toBeGreaterThan(0);
      }),
      { numRuns: 400 },
    );
  });

  it('the static atlas paints the panel, consoles and ICP inside the atlas with finite coordinates', () => {
    const uninstall = installOffscreenStub();
    const g = geoCtx();
    paintStaticAtlas(g.ctx);
    uninstall();
    expect(g.numbers.every(Number.isFinite)).toBe(true);
    expect(g.texts.length).toBeGreaterThan(80);
    for (const t of g.texts) {
      expect(t.p.x).toBeGreaterThanOrEqual(0);
      expect(t.p.x).toBeLessThanOrEqual(STATIC_ATLAS.width);
      expect(t.p.y).toBeGreaterThanOrEqual(0);
      expect(t.p.y).toBeLessThanOrEqual(STATIC_ATLAS.height);
    }
    expect(g.texts.some((t) => t.s === 'MASTER ARM')).toBe(true);
    expect(g.texts.some((t) => t.s === 'ENTR')).toBe(true);
  });

  it('the live instruments draw every page from random states: finite, inside the live atlas, the SMS counts the missiles left', () => {
    const uninstall = installOffscreenStub();
    const g = geoCtx();
    const live = createLiveInstruments(g.ctx);
    fc.assert(
      fc.property(fc.double({ min: -1000, max: 1000, noNaN: true }), fc.double({ min: -200, max: 200, noNaN: true }), fc.double({ min: 0, max: 1e5, noNaN: true }), fc.boolean(), fc.boolean(), (a, b, t, s0, s1) => {
        g.reset();
        live.draw(state({ time: t, airStores: [s0, s1], instruments: { ...createRestReadings(), airspeedKt: a, pitchDeg: b, rollDeg: a, headingDeg: b * 3, altitudeFt: a * 30, verticalSpeedFpm: b * 100 } }), s0);
        expect(g.numbers.every(Number.isFinite)).toBe(true);
        for (const tx of g.texts) {
          expect(tx.p.x).toBeGreaterThanOrEqual(-1);
          expect(tx.p.x).toBeLessThanOrEqual(LIVE_ATLAS.width + 1);
          expect(tx.p.y).toBeLessThanOrEqual(LIVE_ATLAS.height + 1);
        }
        const n = (s0 ? 1 : 0) + (s1 ? 1 : 0);
        expect(g.texts.some((tx) => tx.s.startsWith(`${n} AIM-9M`))).toBe(true);
      }),
      { numRuns: 60 },
    );
    uninstall();
  });
});

describe('F-16 cockpit: dispose', () => {
  it('disposes every cockpit geometry and material', () => {
    const m = createF16Model();
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    part(m, F16_PART.cockpit).traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      geos.add(mesh.geometry);
      mats.add(mesh.material as THREE.Material);
    });
    let g = 0;
    let mt = 0;
    for (const x of geos) x.addEventListener('dispose', () => g++);
    for (const x of mats) x.addEventListener('dispose', () => mt++);
    m.dispose();
    expect(geos.size).toBeGreaterThanOrEqual(6);
    expect(g).toBe(geos.size);
    expect(mt).toBe(mats.size);
  });
});
