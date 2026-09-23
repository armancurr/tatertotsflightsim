/**
 * The jet HUD on its combiner glass (src/ui/hudGlass.ts): unit (projection + clip maths with real
 * three.js cameras), fuzz (random head-look angles and attitudes never give NaN; everything is
 * drawn under a clip equal to the projected glass; the texts' anchors sit inside it; fonts ≥ 11 px)
 * and functional (a node-built F-16 + its cockpit camera: the horizon drawn on the glass lies on the
 * world horizon's projection within 2 px).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { createHudGlass, hudBoxToScreen, insideGlass, projectHudGlassObjects } from '../../src/ui/hudGlass';
import { createJetHudState, drawJetHud, jetHudGeometryOnGlass } from '../../src/ui/jetHud';
import { createF16Model } from '../../src/aircraft/f16';
import { F16_AIRCRAFT } from '../../src/config';
import { geoCtx } from './geoCtx';
import { makeReadings } from './fixtures';
import { fcParams } from '../support/fc';

const DEG = Math.PI / 180;
const VW = 1440;
const VH = 900;
const EYE = F16_AIRCRAFT.geometry.pilotEye;

/** F-16 at `pos` with attitude (pitch, roll, heading) and the cockpit camera (7° look-down + head look). */
function scene(pitch: number, roll: number, hdg: number, yaw = 0, look = 0, w = VW, h = VH) {
  const jet = createF16Model();
  const root = jet.root;
  root.position.set(0, 500, 0);
  root.quaternion.setFromEuler(new THREE.Euler(pitch * DEG, -hdg * DEG, -roll * DEG, 'YXZ'));
  root.updateMatrixWorld(true);
  const cam = new THREE.PerspectiveCamera(68, w / h, 0.1, 90000);
  const eye = new THREE.Vector3(EYE.x, EYE.y, EYE.z).applyQuaternion(root.quaternion).add(root.position);
  cam.position.copy(eye);
  const head = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw * DEG).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (look - 7) * DEG));
  cam.quaternion.copy(root.quaternion).multiply(head);
  cam.updateMatrixWorld();
  cam.updateProjectionMatrix();
  const vel = new THREE.Vector3(0, 0, -150).applyQuaternion(root.quaternion);
  const g = projectHudGlassObjects(createHudGlass(), cam, jet.hudCombiner!, root.quaternion, vel, w, h);
  return { jet, cam, g, vel };
}

function project(cam: THREE.Camera, p: THREE.Vector3, w = VW, h = VH) {
  const v = p.clone().project(cam);
  return { x: ((v.x + 1) / 2) * w, y: ((1 - v.y) / 2) * h };
}

describe('HUD glass projection (unit)', () => {
  it('looking ahead: the F-16 glass is ~25° × 20° around the boresight; 1 HUD px ≈ 1 screen px', () => {
    const { g, jet } = scene(0, 0, 0);
    expect(g.visible).toBe(true);
    expect(g.w / g.ppd).toBeGreaterThan(22);
    expect(g.w / g.ppd).toBeLessThan(28);
    expect(g.h / g.ppd).toBeGreaterThan(17);
    expect(g.h / g.ppd).toBeLessThan(23);
    expect(Math.abs(g.m[0] - 1)).toBeLessThan(0.05);
    expect(Math.abs(g.m[3] - 1)).toBeLessThan(0.05);
    // Boresight near the top quarter, centred.
    expect(Math.abs(g.boreX - g.w / 2)).toBeLessThan(3);
    expect(g.boreY / g.h).toBeGreaterThan(0.15);
    expect(g.boreY / g.h).toBeLessThan(0.4);
    jet.dispose();
  });

  it('the boresight maps onto the projection of the nose direction; the FPM onto the velocity', () => {
    const { g, cam, jet, vel } = scene(4, 10, 30, 0, 0);
    const nose = new THREE.Vector3(0, 0, -1).applyQuaternion(jet.root.quaternion).multiplyScalar(1e4).add(cam.position);
    const s = project(cam, nose);
    const b = hudBoxToScreen(g, { x: 0, y: 0 }, g.boreX, g.boreY);
    expect(Math.hypot(b.x - s.x, b.y - s.y)).toBeLessThan(0.5);
    const f = project(cam, vel.clone().normalize().multiplyScalar(1e4).add(cam.position));
    const fp = hudBoxToScreen(g, { x: 0, y: 0 }, g.fpmX, g.fpmY);
    expect(g.fpmOk).toBe(true);
    expect(Math.hypot(fp.x - f.x, fp.y - f.y)).toBeLessThan(0.5);
    jet.dispose();
  });

  it('head look moves the glass with the view; looking back hides it', () => {
    const a = scene(0, 0, 0, 0);
    const b = scene(0, 0, 0, 20);
    expect(b.g.visible).toBe(true);
    // Looking right (+yaw) slides the glass left on screen.
    expect(b.g.quad[0] + b.g.quad[2] + b.g.quad[4] + b.g.quad[6]).toBeLessThan(a.g.quad[0] + a.g.quad[2] + a.g.quad[4] + a.g.quad[6] - 400);
    const c = scene(0, 0, 0, 150);
    expect(c.g.visible).toBe(false);
    a.jet.dispose();
    b.jet.dispose();
    c.jet.dispose();
  });
});

describe('HUD glass (fuzz)', () => {
  it('random attitudes, head look and viewports: never NaN; drawn only under the glass clip; anchors inside; fonts ≥ 11 px', () => {
    const jet = createF16Model();
    const readings = makeReadings({ airspeedKt: 380, altitudeFt: 9000, gear: 'up' });
    fc.assert(
      fc.property(
        fc.double({ min: -80, max: 80, noNaN: true }), fc.double({ min: -180, max: 180, noNaN: true }), fc.double({ min: 0, max: 360, noNaN: true }),
        fc.double({ min: -150, max: 150, noNaN: true }), fc.double({ min: -70, max: 70, noNaN: true }), fc.constantFrom([1440, 900], [1024, 768]),
        (pitch, roll, hdg, yaw, look, [w, h]) => {
          const root = jet.root;
          root.quaternion.setFromEuler(new THREE.Euler(pitch * DEG, -hdg * DEG, -roll * DEG, 'YXZ'));
          root.position.set(0, 500, 0);
          const cam = new THREE.PerspectiveCamera(68, w / h, 0.1, 90000);
          cam.position.copy(new THREE.Vector3(EYE.x, EYE.y, EYE.z).applyQuaternion(root.quaternion).add(root.position));
          const head = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -yaw * DEG).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (look - 7) * DEG));
          cam.quaternion.copy(root.quaternion).multiply(head);
          cam.updateMatrixWorld();
          cam.updateProjectionMatrix();
          const g = projectHudGlassObjects(createHudGlass(), cam, jet.hudCombiner!, root.quaternion, new THREE.Vector3(0, 0, -150).applyQuaternion(root.quaternion), w, h);
          for (const v of [g.w, g.h, g.ppd, g.boreX, g.boreY, g.rotation, g.horizonOffset, ...g.m, ...g.quad]) expect(Number.isFinite(v)).toBe(true);
          if (!g.visible) return;
          const r = { ...readings, pitchDeg: pitch, rollDeg: roll, headingDeg: hdg };
          const ctx = geoCtx();
          ctx.ctx.save();
          const q = g.quad;
          ctx.ctx.beginPath();
          ctx.ctx.moveTo(q[0], q[1]);
          for (let k = 1; k < 4; k++) ctx.ctx.lineTo(q[2 * k], q[2 * k + 1]);
          ctx.ctx.closePath();
          ctx.ctx.clip();
          ctx.ctx.transform(g.m[0], g.m[1], g.m[2], g.m[3], g.m[4], g.m[5]);
          drawJetHud(ctx.ctx, g.w, g.h, r, createJetHudState(), undefined, { geometry: jetHudGeometryOnGlass(g, r), minFont: 11 });
          ctx.ctx.restore();
          for (const n of ctx.numbers) expect(Number.isFinite(n)).toBe(true);
          // Texts on the tapes/corners are laid out inside the glass (ladder numbers may be clipped).
          const scale = Math.sqrt(Math.abs(g.m[0] * g.m[3] - g.m[1] * g.m[2]));
          expect(11 * scale).toBeGreaterThan(8);
          const inside = ctx.texts.filter((t) => insideGlass(g, t.p.x, t.p.y, 2)).length;
          expect(inside).toBeGreaterThan(ctx.texts.length * 0.6);
        },
      ),
      fcParams(60),
    );
    jet.dispose();
  }, 60000);
});

describe('HUD glass (functional): the horizon on the glass is the world horizon', () => {
  for (const [pitch, roll, yaw, look] of [[3, 0, 0, 0], [5, 25, 0, 0], [-4, -30, 8, 3], [2, 10, -12, -4]]) {
    it(`pitch ${pitch}°, bank ${roll}°, head ${yaw}°/${look}°: within 2 px`, () => {
      const { g, cam, jet } = scene(pitch, roll, 40, yaw, look);
      expect(g.visible && g.horizonOk).toBe(true);
      const r = { ...makeReadings({ gear: 'up' }), pitchDeg: pitch, rollDeg: roll, headingDeg: 40 };
      const geo = jetHudGeometryOnGlass(g, r);
      // Horizon line in box px: bore + rotate(rotation) · (x, horizonOffset) → screen.
      const c = Math.cos(geo.rotation);
      const s = Math.sin(geo.rotation);
      for (const x of [-60, 0, 60]) {
        const bx = geo.bore.x + c * x - s * geo.horizonOffset;
        const by = geo.bore.y + s * x + c * geo.horizonOffset;
        const p = hudBoxToScreen(g, { x: 0, y: 0 }, bx, by);
        // A world-horizon point on that screen column: the ray through (p.x, row) with zero elevation.
        const ray = new THREE.Vector3(((p.x / VW) * 2 - 1), 1 - (p.y / VH) * 2, 0.5).unproject(cam).sub(cam.position).normalize();
        expect(Math.abs(Math.asin(ray.y)) / DEG * g.ppd).toBeLessThan(2);
      }
      jet.dispose();
    });
  }
});
