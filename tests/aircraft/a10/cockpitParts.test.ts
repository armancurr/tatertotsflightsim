/**
 * The A-10C cockpit's parts where a pilot expects them: 5 × 5" MFCDs either side of the centre
 * instruments, the UFC under the HUD, gear handle + lights on the left, engine instruments for both
 * engines on the right, fire handles on the glareshield, the stick on the centreline between the
 * knees and the throttles on the left console (both moving with the controls), the seat behind the
 * eye — plus the painted dash layout itself (no instrument overlaps another or leaves the panel).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as THREE from 'three';
import { createA10Model, A10_PART } from '../../../src/aircraft/a10';
import { HUD, PANEL, STICK, THROTTLE, hudCentre, panelPoint, stickAngles, throttleAngle } from '../../../src/aircraft/a10/cockpit';
import { AHCP, CONSOLE, ENGINE, GAUGE, GEAR, MFCD, UFC } from '../../../src/aircraft/a10/panel';
import { createDefaultVisualState, createRestReadings, type AircraftVisualState } from '../../../src/aircraft/types';
import { A10_AIRCRAFT } from '../../../src/config';

const EYE = A10_AIRCRAFT.geometry.pilotEye;
type Model = ReturnType<typeof createA10Model>;
const state = (patch: Partial<AircraftVisualState> = {}): AircraftVisualState => ({ ...createDefaultVisualState(), engineRunning: true, cameraMode: 'cockpit', instruments: createRestReadings(), ...patch });

/** World-space bounding box of a named mesh, in the model's body frame. */
function boxOf(m: Model, name: string): THREE.Box3 {
  m.root.updateMatrixWorld(true);
  const o = m.root.getObjectByName(name)!;
  const b = new THREE.Box3().setFromObject(o);
  const inv = m.root.matrixWorld.clone().invert();
  return b.applyMatrix4(inv);
}

describe('A-10 cockpit parts', () => {
  let m: Model;
  beforeAll(() => {
    m = createA10Model();
    m.setVisualState(state(), 1 / 30);
  });
  afterAll(() => m.dispose());

  it('two 5 × 5" MFCD screens (0.127 m) sit either side of the centre instruments, below the UFC', () => {
    expect(MFCD.screen).toBeCloseTo(0.127, 3);
    const screens = m.root.getObjectByName('a10.cockpit.screens') as THREE.Mesh;
    const pos = screens.geometry.getAttribute('position') as THREE.BufferAttribute;
    const has = (p: THREE.Vector3) => {
      for (let i = 0; i < pos.count; i++) if (Math.hypot(pos.getX(i) - p.x, pos.getY(i) - p.y, pos.getZ(i) - p.z) < 1e-3) return true;
      return false;
    };
    const h = MFCD.screen / 2;
    for (const s of [-1, 1]) for (const [dx, dy] of [[-h, -h], [h, -h], [h, h], [-h, h]]) expect(has(panelPoint(s * MFCD.x + dx, MFCD.y + dy, 0.009)), `side ${s}`).toBe(true);
    // The centre column (ADI/HSI) sits between the bezels; the UFC above them, under the HUD.
    expect(MFCD.x - MFCD.bezel / 2).toBeGreaterThan(GAUGE.adi.r * 1.22);
    expect(UFC.y - UFC.h / 2).toBeGreaterThan(MFCD.y + MFCD.bezel / 2 - 0.01);
    expect(Math.abs(UFC.x - hudCentre().x)).toBeLessThan(0.01);
  });

  it('the dash layout: every instrument, panel and screen fits the dash and nothing overlaps', () => {
    type R = { name: string; x0: number; x1: number; y0: number; y1: number };
    const rects: R[] = [];
    const rect = (name: string, x: number, y: number, w: number, h: number) => rects.push({ name, x0: x - w / 2, x1: x + w / 2, y0: y - h / 2, y1: y + h / 2 });
    for (const [k, g] of Object.entries(GAUGE)) rect(k, g.x, g.y, g.r * 2.44, g.r * 2.44);
    ENGINE.rows.forEach((row, i) => [ENGINE.x0, ENGINE.x1].forEach((x, j) => rect(`${row}${j}`, x, ENGINE.y0 + i * ENGINE.dy, ENGINE.r * 2.44, ENGINE.r * 2.44)));
    rect('mfcdL', -MFCD.x, MFCD.y, MFCD.bezel, MFCD.bezel);
    rect('mfcdR', MFCD.x, MFCD.y, MFCD.bezel, MFCD.bezel);
    rect('ufc', UFC.x, UFC.y, UFC.w, UFC.h);
    rect('ahcp', AHCP.x, AHCP.y, AHCP.w, AHCP.h);
    rect('gear', GEAR.handleX, GEAR.handleY, 0.05, 0.09);
    for (const r of rects) {
      expect(r.x0, r.name).toBeGreaterThanOrEqual(-PANEL.w / 2);
      expect(r.x1, r.name).toBeLessThanOrEqual(PANEL.w / 2);
      expect(r.y0, r.name).toBeGreaterThanOrEqual(-PANEL.h / 2);
      expect(r.y1, r.name).toBeLessThanOrEqual(PANEL.h / 2);
    }
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i];
        const b = rects[j];
        const overlap = a.x0 < b.x1 - 1e-6 && b.x0 < a.x1 - 1e-6 && a.y0 < b.y1 - 1e-6 && b.y0 < a.y1 - 1e-6;
        expect(overlap, `${a.name} × ${b.name}`).toBe(false);
      }
  });

  it('gear handle and lights on the left of the dash, engine instruments for both engines on the right', () => {
    expect(GEAR.handleX).toBeLessThan(-MFCD.x - MFCD.bezel / 2);
    expect(GEAR.lights).toHaveLength(3);
    for (const [x] of GEAR.lights) expect(x).toBeLessThan(-MFCD.x - MFCD.bezel / 2);
    expect(Math.min(ENGINE.x0, ENGINE.x1) - ENGINE.r).toBeGreaterThan(MFCD.x + MFCD.bezel / 2);
    expect(ENGINE.rows).toEqual(expect.arrayContaining(['ITT', 'CORE', 'FAN', 'FF']));
    expect(GAUGE.fuel.x).toBeGreaterThan(0.3);
  });

  it('the HUD stands on the glareshield centreline, above the UFC; the eye looks through it', () => {
    const c = hudCentre();
    expect(c.x).toBe(0);
    expect(c.y).toBeGreaterThan(panelPoint(UFC.x, UFC.y + UFC.h / 2).y);
    expect(c.z).toBeLessThan(EYE.z - 0.5);
    expect(HUD.bottomY).toBeLessThan(EYE.y);
  });

  it('the stick stands on the centreline between the knees; the throttles on the left console; the seat behind the eye', () => {
    const stick = boxOf(m, A10_PART.stick);
    const grip = stick.max.y;
    expect(Math.abs((stick.min.x + stick.max.x) / 2)).toBeLessThan(0.03);
    expect(grip).toBeGreaterThan(0.6);
    expect(grip).toBeLessThan(EYE.y - 0.3);
    expect(stick.min.z).toBeGreaterThan(-4.8);
    const thr = boxOf(m, A10_PART.throttle);
    expect(thr.max.x).toBeLessThan(-CONSOLE.xIn + 0.02);
    expect(thr.min.y).toBeGreaterThan(CONSOLE.y - 0.05);
    const seat = m.root.getObjectByName('a10.cockpit.interior')!;
    expect(seat).toBeTruthy();
    expect(STICK.pivot.z).toBeLessThan(EYE.z);
    expect(THROTTLE.pivot.x).toBeLessThan(-CONSOLE.xIn);
  });

  it('the stick moves with the controls (aft on + elevator, right on + aileron) and the throttles go forward with power', () => {
    const tip = () => {
      m.root.updateMatrixWorld(true);
      const b = boxOf(m, A10_PART.stick);
      return new THREE.Vector3((b.min.x + b.max.x) / 2, b.max.y, (b.min.z + b.max.z) / 2);
    };
    m.setVisualState(state({ elevator: 0, aileron: 0 }), 1 / 30);
    const c = tip();
    m.setVisualState(state({ elevator: 1, aileron: 0 }), 1 / 30);
    expect(tip().z).toBeGreaterThan(c.z + 0.04);
    m.setVisualState(state({ elevator: 0, aileron: 1 }), 1 / 30);
    expect(tip().x).toBeGreaterThan(c.x + 0.04);
    m.setVisualState(state({ elevator: 0, aileron: -1 }), 1 / 30);
    expect(tip().x).toBeLessThan(c.x - 0.04);
    const grip = () => {
      m.root.updateMatrixWorld(true);
      const b = boxOf(m, A10_PART.throttle);
      return (b.min.z + b.max.z) / 2;
    };
    m.setVisualState(state({ instruments: { ...createRestReadings(), throttlePct: 0 } }), 1 / 30);
    const idle = grip();
    m.setVisualState(state({ instruments: { ...createRestReadings(), throttlePct: 100 } }), 1 / 30);
    expect(grip()).toBeLessThan(idle - 0.05);
    // Pure mappings are bounded.
    expect(Math.abs(stickAngles(5, -5).pitch)).toBeLessThanOrEqual((STICK.pitchDeg * Math.PI) / 180 + 1e-12);
    expect(throttleAngle(Number.NaN)).toBe(throttleAngle(0));
  });

  it('outside the cockpit the model keeps its budget: ≤ 70 draw calls', () => {
    m.setVisualState(state({ cameraMode: 'chase' }), 1 / 30);
    let calls = 0;
    m.root.traverseVisible((o) => {
      if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) calls++;
    });
    expect(calls).toBeLessThanOrEqual(70);
  });
});
