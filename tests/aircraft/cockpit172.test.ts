/**
 * The 172RG cockpit: the panel laid out at real sizes in front of the right seat positions, the
 * 3D controls through their holes, the gear handle and lights following the gear, the yokes on
 * their shafts, a clear view ahead through the windshield, the panel drawer robust to any
 * readings, and dispose freeing everything.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { fcParams } from '../support/fc';
import { CONFIG } from '../../src/config';
import { createAircraft, createDefaultVisualState } from '../../src/aircraft';
import { PANEL, PANEL_GAUGES, PANEL_LAYOUT as PL, PANEL_BOTTOM_Y } from '../../src/aircraft/panel';
import { GEAR_HANDLE_DOWN_Y, GEAR_HANDLE_UP_Y, LIP_Y, glareshieldTopY } from '../../src/aircraft/cockpit';
import { drawCessnaPanel } from '../../src/aircraft/panelFace';
import { createRestReadings } from '../../src/aircraft/types';
import type { InstrumentReadings } from '../../src/types';

const EYE = CONFIG.aircraft.geometry.pilotEye;
const DEG = Math.PI / 180;

describe('panel layout (real sizes, body frame)', () => {
  it('puts the six-pack centred on the pilot, gauges on the face and never overlapping', () => {
    expect(PL.attitude.x).toBeCloseTo(EYE.x, 2);
    expect(PL.heading.x).toBeCloseTo(EYE.x, 2);
    for (const [name, g] of PANEL_GAUGES) {
      expect(g.x - g.d / 2, name).toBeGreaterThan(-PANEL.widthM / 2);
      expect(g.x + g.d / 2, name).toBeLessThan(PANEL.widthM / 2);
      expect(g.y + g.d / 2, name).toBeLessThan(PANEL.topY);
      expect(g.y - g.d / 2, name).toBeGreaterThan(PANEL_BOTTOM_Y);
    }
    for (let i = 0; i < PANEL_GAUGES.length; i++) {
      for (let j = i + 1; j < PANEL_GAUGES.length; j++) {
        const [a, ga] = PANEL_GAUGES[i];
        const [b, gb] = PANEL_GAUGES[j];
        expect(Math.hypot(ga.x - gb.x, ga.y - gb.y), `${a}/${b}`).toBeGreaterThanOrEqual((ga.d + gb.d) / 2 - 1e-9);
      }
    }
  });

  it('flight instruments are 3⅛" (≈ 80 mm) — not dinner plates', () => {
    for (const k of ['airspeed', 'attitude', 'altimeter', 'turn', 'heading', 'vsi'] as const) {
      expect(PL[k].d).toBeGreaterThan(0.075);
      expect(PL[k].d).toBeLessThan(0.09);
    }
    // The stack is a standard 6¼" avionics width.
    expect(PL.stack.w).toBeCloseTo(0.159, 3);
  });

  it('the panel top sits 12–16° below the eye and the whole face is 0.65–0.8 m ahead', () => {
    const dep = Math.atan2(EYE.y - LIP_Y, EYE.z - PANEL.z) / DEG;
    expect(dep).toBeGreaterThan(12);
    expect(dep).toBeLessThan(16);
    expect(EYE.z - PANEL.z).toBeGreaterThan(0.65);
    expect(EYE.z - PANEL.z).toBeLessThan(0.8);
  });
});

describe('the 3D cockpit', () => {
  const readings = (over: Partial<InstrumentReadings>): InstrumentReadings => ({ ...createRestReadings(), ...over });

  it('yokes sit on their shafts in front of each seat; the controls come through their holes', () => {
    const ac = createAircraft({ quality: 'low' });
    const v = createDefaultVisualState();
    v.cameraMode = 'cockpit';
    ac.setVisualState(v, 1 / 60);
    const yl = ac.root.getObjectByName('yoke.left')!;
    const yr = ac.root.getObjectByName('yoke.right')!;
    expect(yl.position.x).toBeCloseTo(PL.yokeShafts[0].x);
    expect(yr.position.x).toBeCloseTo(PL.yokeShafts[1].x);
    expect(yl.position.z).toBeGreaterThan(PANEL.z + 0.15);
    const th = ac.root.getObjectByName('throttle')!;
    expect(th.position.x).toBeCloseTo(PL.throttle.x);
    expect(th.position.y).toBeCloseTo(PL.throttle.y);
    const fl = ac.root.getObjectByName('flapLever')!;
    expect(fl.position.x).toBeCloseTo(PL.flapLever.x);
    ac.dispose();
  });

  it('gear handle and lights follow the gear: down → handle down + green; up → handle up + amber; transit → both dark', () => {
    const ac = createAircraft({ quality: 'low' });
    const v = createDefaultVisualState();
    v.cameraMode = 'cockpit';
    const handle = ac.root.getObjectByName('gearHandle')!;
    const green = (ac.root.getObjectByName('gearLight.down') as THREE.Mesh).material as THREE.MeshBasicMaterial;
    const amber = (ac.root.getObjectByName('gearLight.up') as THREE.Mesh).material as THREE.MeshBasicMaterial;
    const lum = (m: THREE.MeshBasicMaterial) => m.color.r + m.color.g + m.color.b;

    v.instruments = readings({ gear: 'down', gearLight: 'green' });
    v.gearPos = 1;
    ac.setVisualState(v, 1 / 60);
    expect(handle.position.y).toBeCloseTo(GEAR_HANDLE_DOWN_Y);
    expect(lum(green)).toBeGreaterThan(1);
    expect(lum(amber)).toBeLessThan(0.3);

    v.instruments = readings({ gear: 'up', gearLight: 'off' });
    v.gearPos = 0;
    ac.setVisualState(v, 1 / 60);
    expect(handle.position.y).toBeCloseTo(GEAR_HANDLE_UP_Y);
    expect(lum(amber)).toBeGreaterThan(1);
    expect(lum(green)).toBeLessThan(0.3);

    v.instruments = readings({ gear: 'transit', gearLight: 'red' });
    v.gearPos = 0.5;
    ac.setVisualState(v, 1 / 60);
    expect(lum(amber)).toBeLessThan(0.3);
    expect(lum(green)).toBeLessThan(0.3);
    ac.dispose();
  });

  it('the view ahead is clear: rays from the eye within ±25° azimuth and −9…+20° elevation miss the cabin furniture', () => {
    const ac = createAircraft({ quality: 'low' });
    const v = createDefaultVisualState();
    v.cameraMode = 'cockpit';
    ac.setVisualState(v, 1 / 60);
    ac.root.updateMatrixWorld(true);
    const blockers: THREE.Object3D[] = [];
    const interior = ac.root.getObjectByName('interior')!;
    interior.traverse((o) => {
      // The airframe (shell, windshield post and header trim) is not furniture: the posts are
      // checked on their own in cockpitRealism.test.ts. Visors and the windshield glint are see-through.
      if ((o as THREE.Mesh).isMesh && !['cabinShell', 'cabinTrim', 'sunVisors', 'windshieldGlint'].includes(o.name)) blockers.push(o);
    });
    const rc = new THREE.Raycaster();
    const eye = new THREE.Vector3(EYE.x, EYE.y, EYE.z);
    let clear = 0;
    let n = 0;
    for (let az = -25; az <= 25; az += 5) {
      for (let el = -9; el <= 20; el += 3) {
        const d = new THREE.Vector3(Math.sin(az * DEG) * Math.cos(el * DEG), Math.sin(el * DEG), -Math.cos(az * DEG) * Math.cos(el * DEG));
        rc.set(eye, d);
        rc.far = 3;
        n++;
        if (rc.intersectObjects(blockers, false).length === 0) clear++;
      }
    }
    // The wet compass hangs at the top centre; everything else ahead is open.
    expect(clear / n).toBeGreaterThan(0.95);
    // …and the glareshield is below −12° right ahead of the pilot.
    expect(Math.atan2(EYE.y - glareshieldTopY(EYE.x, PANEL.z + 0.02), EYE.z - PANEL.z) / DEG).toBeGreaterThan(12);
    ac.dispose();
  });

  it('dispose frees every geometry and material', () => {
    const ac = createAircraft({ quality: 'low' });
    const geos = new Set<THREE.BufferGeometry>();
    const mats = new Set<THREE.Material>();
    ac.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) geos.add(m.geometry);
      if (m.material) (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => mats.add(x));
    });
    let gd = 0;
    let md = 0;
    geos.forEach((g) => g.addEventListener('dispose', () => gd++));
    mats.forEach((m) => m.addEventListener('dispose', () => md++));
    ac.dispose();
    expect(gd).toBe(geos.size);
    expect(md).toBe(mats.size);
  });
});

describe('property: panel drawer and cockpit controls never go NaN', () => {
  const num = fc.oneof(fc.double(), fc.constantFrom(NaN, Infinity, -Infinity, 0, 1e9, -1e9));
  it('drawCessnaPanel feeds only finite numbers to the canvas, for any readings and sizes', () => {
    const bad: string[] = [];
    const ctx = new Proxy({} as Record<string, unknown>, {
      get(t, k: string) {
        if (k in t) return t[k];
        if (k === 'getTransform') return () => ({ a: 1, b: 0 });
        if (k === 'measureText') return () => ({ width: 10 });
        if (k === 'createLinearGradient' || k === 'createRadialGradient') {
          return (...a: number[]) => {
            if (a.some((x) => !Number.isFinite(x))) bad.push(k);
            return { addColorStop: () => undefined };
          };
        }
        return (...a: unknown[]) => {
          if (a.some((x) => typeof x === 'number' && !Number.isFinite(x))) bad.push(k);
        };
      },
      set(t, k: string, val) {
        t[k] = val;
        return true;
      },
    }) as unknown as CanvasRenderingContext2D;
    fc.assert(
      fc.property(num, num, num, num, num, num, num, num, fc.constantFrom(PANEL.width, 1024, 300), (a, b, c, d, e, f, g, h, w) => {
        const r = { ...createRestReadings(), airspeedKt: a, altitudeFt: b, headingDeg: c, pitchDeg: d, rollDeg: e, rpm: f, throttlePct: g, flapsDeg: h, verticalSpeedFpm: a, turnRateDegPerSec: b, slipSkid: c, engineStatus: 'RUNNING' as const };
        drawCessnaPanel(ctx, w, w * 0.375, r);
        expect(bad).toEqual([]);
      }),
      fcParams(60),
    );
  });

  it('random visual states keep every cockpit control transform finite', () => {
    const ac = createAircraft({ quality: 'low' });
    const names = ['yoke.left', 'yoke.right', 'throttle', 'gearHandle', 'flapLever', 'trimWheel'];
    fc.assert(
      fc.property(num, num, num, num, num, fc.constantFrom('up', 'down', 'transit' as const), (el, ail, thr, flaps, trim, gear) => {
        const v = createDefaultVisualState();
        v.cameraMode = 'cockpit';
        v.elevator = el;
        v.aileron = ail;
        v.gearPos = Number.isFinite(thr) ? thr : 0.5;
        v.instruments = { ...createRestReadings(), throttlePct: thr, flapsTargetDeg: flaps, trimPct: trim, gear };
        ac.setVisualState(v, 1 / 60);
        for (const n of names) {
          const o = ac.root.getObjectByName(n)!;
          for (const x of [...o.position.toArray(), o.rotation.x, o.rotation.y, o.rotation.z]) expect(Number.isFinite(x)).toBe(true);
        }
      }),
      fcParams(80),
    );
    ac.dispose();
  });
});
