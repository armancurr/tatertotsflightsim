/**
 * Weapons HUD maths (unit + fast-check fuzz): camera projection of world points (three.js cameras
 * built in node), clamping off-screen points to the display edge, the gun line, bearings to the
 * range, the pipper range arc, the lock box states, text formatting and per-aircraft visibility.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { A10_WEAPONS, CONFIG, F16_WEAPONS } from '../../src/config';
import { emptyWeaponsStatus } from '../../src/combat/world';
import {
  ammoLabel, bearingDeg, clampToRect, createScreenPt, formatKm, formatSlantRange, gunAmmoText, gunLineDir, lockBox,
  missileShortName, missileStoresText, pipperArcFraction, projectPoint, relativeBearingDeg, weaponsVisibility, gunShortName,
} from '../../src/ui/weaponsHudMath';
import { fcParams } from '../support/fc';

const W = 1440;
const H = 900;

function camera(pos: [number, number, number], look: [number, number, number], fov = 60, aspect = W / H): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(fov, aspect, 0.1, 50000);
  c.position.set(...pos);
  c.lookAt(...look);
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
}

const proj = (c: THREE.PerspectiveCamera, p: [number, number, number]) =>
  projectPoint(createScreenPt(), p[0], p[1], p[2], c.matrixWorldInverse.elements, c.projectionMatrix.elements, W, H);

describe('projectPoint', () => {
  it('a point straight ahead lands in the centre, in front, on screen', () => {
    const c = camera([0, 100, 0], [0, 100, -1000]);
    const s = proj(c, [0, 100, -500]);
    expect(s.x).toBeCloseTo(W / 2, 6);
    expect(s.y).toBeCloseTo(H / 2, 6);
    expect(s.inFront).toBe(true);
    expect(s.onScreen).toBe(true);
    expect(s.depth).toBeCloseTo(500, 6);
  });

  it('matches three.js Vector3.project for points in front (right is +x, up is −y)', () => {
    const c = camera([10, 50, 30], [200, 0, -900], 55);
    for (const p of [[40, 20, -300], [-100, 60, -800], [300, -10, -1200]] as [number, number, number][]) {
      const v = new THREE.Vector3(...p).project(c);
      const s = proj(c, p);
      expect(s.x).toBeCloseTo(((v.x + 1) / 2) * W, 4);
      expect(s.y).toBeCloseTo(((1 - v.y) / 2) * H, 4);
    }
    const right = proj(c, [60, 20, -300]);
    const left = proj(c, [20, 20, -300]);
    expect(right.x).toBeGreaterThan(left.x);
    const up = proj(c, [40, 60, -300]);
    expect(up.y).toBeLessThan(proj(c, [40, 20, -300]).y);
  });

  it('works with a reversed-depth projection matrix (only x/y/w rows are used)', () => {
    const c = camera([0, 0, 0], [0, 0, -1], 60);
    const m = c.projectionMatrix.clone();
    m.elements[10] = 0.001;
    m.elements[14] = 0.1; // what reversed depth does to the z row
    const s = projectPoint(createScreenPt(), 100, 50, -1000, c.matrixWorldInverse.elements, m.elements, W, H);
    const v = new THREE.Vector3(100, 50, -1000).project(c);
    expect(s.x).toBeCloseTo(((v.x + 1) / 2) * W, 4);
  });

  it('points behind the camera are not in front and point the way to look (to the right → far right)', () => {
    const c = camera([0, 0, 0], [0, 0, -1]);
    const s = proj(c, [50, 0, 100]); // behind, to the right
    expect(s.inFront).toBe(false);
    expect(s.onScreen).toBe(false);
    expect(s.x).toBeGreaterThan(W);
    const l = proj(c, [-50, 0, 100]);
    expect(l.x).toBeLessThan(0);
  });

  it('property: any finite camera and point → finite numbers', () => {
    fc.assert(
      fc.property(
        fc.tuple(fc.double({ min: -1e4, max: 1e4, noNaN: true }), fc.double({ min: -1e3, max: 1e4, noNaN: true }), fc.double({ min: -1e4, max: 1e4, noNaN: true })),
        fc.tuple(fc.double({ min: -1e5, max: 1e5, noNaN: true }), fc.double({ min: -1e5, max: 1e5, noNaN: true }), fc.double({ min: -1e5, max: 1e5, noNaN: true })),
        fc.double({ min: 1, max: 120, noNaN: true }),
        (cp, p, fov) => {
          const c = camera(cp, [cp[0] + 1, cp[1] - 0.2, cp[2] - 3], fov);
          const s = proj(c, p);
          expect(Number.isFinite(s.x) && Number.isFinite(s.y) && Number.isFinite(s.depth)).toBe(true);
          if (s.onScreen) {
            expect(s.x).toBeGreaterThanOrEqual(0);
            expect(s.x).toBeLessThanOrEqual(W);
          }
        },
      ),
      fcParams(300),
    );
  });

  it('garbage matrices or sizes never produce NaN', () => {
    const s = projectPoint(createScreenPt(), NaN, 1, 2, new Array(16).fill(NaN), new Array(16).fill(0), NaN, -5);
    expect(Number.isFinite(s.x) && Number.isFinite(s.y)).toBe(true);
    expect(s.onScreen).toBe(false);
  });
});

describe('clampToRect', () => {
  const rect = { x: 100, y: 50, w: 800, h: 600 };
  it('leaves an inside point alone', () => {
    const o = clampToRect(createScreenPt(), 400, 300, rect, 10);
    expect(o.x).toBe(400);
    expect(o.y).toBe(300);
    expect(o.clamped).toBe(false);
  });

  it('moves an outside point to the inset edge along the line from the centre', () => {
    const o = clampToRect(createScreenPt(), 500 + 2000, 350, rect, 10);
    expect(o.clamped).toBe(true);
    expect(o.x).toBeCloseTo(100 + 800 - 10, 6);
    expect(o.y).toBeCloseTo(350, 6);
    const d = clampToRect(createScreenPt(), 500 + 1000, 350 + 1000, rect, 0);
    // Direction kept: 45° down-right from the centre, stops at the bottom edge (h/2 = 300 < w/2 = 400).
    expect(d.y).toBeCloseTo(650, 6);
    expect(d.x).toBeCloseTo(800, 6);
  });

  it('property: result always inside the inset rect, never NaN, direction from the centre preserved', () => {
    fc.assert(
      fc.property(fc.double({ min: -1e7, max: 1e7, noNaN: true }), fc.double({ min: -1e7, max: 1e7, noNaN: true }), fc.double({ min: 0, max: 60, noNaN: true }), (x, y, inset) => {
        const o = clampToRect(createScreenPt(), x, y, rect, inset);
        expect(o.x).toBeGreaterThanOrEqual(rect.x + inset - 1e-6);
        expect(o.x).toBeLessThanOrEqual(rect.x + rect.w - inset + 1e-6);
        expect(o.y).toBeGreaterThanOrEqual(rect.y + inset - 1e-6);
        expect(o.y).toBeLessThanOrEqual(rect.y + rect.h - inset + 1e-6);
        const cx = rect.x + rect.w / 2;
        const cy = rect.y + rect.h / 2;
        if (o.clamped && Math.hypot(x - cx, y - cy) > 1) {
          // Same direction from the centre.
          const a = Math.atan2(y - cy, x - cx);
          const b = Math.atan2(o.y - cy, o.x - cx);
          expect(Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)))).toBeLessThan(1e-3);
        }
      }),
      fcParams(400),
    );
    const bad = clampToRect(createScreenPt(), NaN, Infinity, rect, 5);
    expect(Number.isFinite(bad.x) && Number.isFinite(bad.y)).toBe(true);
  });
});

describe('gun line', () => {
  it('level aircraft: body −Z pointing north, depressed by boresightDownDeg', () => {
    const d = gunLineDir({ x: 0, y: 0, z: 0 }, 0, 0, 0, 1, 2);
    expect(d.z).toBeCloseTo(-Math.cos(2 * Math.PI / 180), 9);
    expect(d.y).toBeCloseTo(-Math.sin(2 * Math.PI / 180), 9);
    expect(d.x).toBeCloseTo(0, 9);
  });

  it('follows the aircraft heading (90° right = east, +X)', () => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -Math.PI / 2);
    const d = gunLineDir({ x: 0, y: 0, z: 0 }, q.x, q.y, q.z, q.w, 0);
    expect(d.x).toBeCloseTo(1, 9);
    expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 9);
  });
});

describe('bearings', () => {
  it('north is 0, east 90, south 180, west 270 (world −Z is north)', () => {
    expect(bearingDeg(0, 0, 0, -100)).toBeCloseTo(0, 9);
    expect(bearingDeg(0, 0, 100, 0)).toBeCloseTo(90, 9);
    expect(bearingDeg(0, 0, 0, 100)).toBeCloseTo(180, 9);
    expect(bearingDeg(0, 0, -100, 0)).toBeCloseTo(270, 9);
  });

  it('relative bearing is −180..180, positive to the right', () => {
    expect(relativeBearingDeg(10, 350)).toBeCloseTo(20, 9);
    expect(relativeBearingDeg(350, 10)).toBeCloseTo(-20, 9);
    expect(relativeBearingDeg(180, 0)).toBeCloseTo(180, 9);
    fc.assert(fc.property(fc.double({ min: -1e4, max: 1e4, noNaN: true }), fc.double({ min: -1e4, max: 1e4, noNaN: true }), (a, b) => {
      const r = relativeBearingDeg(a, b);
      expect(r).toBeGreaterThan(-180 - 1e-9);
      expect(r).toBeLessThanOrEqual(180 + 1e-9);
    }), fcParams(200));
    expect(Number.isFinite(relativeBearingDeg(NaN, 3))).toBe(true);
  });
});

describe('pipper range arc', () => {
  const full = CONFIG.hud.weapons.gunInRangeM;
  it('is full at 4,000 ft, half at 2,000 ft, empty at 0 and clamped beyond', () => {
    expect(pipperArcFraction(full, full)).toBeCloseTo(1, 9);
    expect(pipperArcFraction(full / 2, full)).toBeCloseTo(0.5, 9);
    expect(pipperArcFraction(0, full)).toBe(0);
    expect(pipperArcFraction(9000, full)).toBe(1);
    expect(pipperArcFraction(NaN, full)).toBe(0);
    expect(pipperArcFraction(-5, full)).toBe(0);
    expect(pipperArcFraction(100, 0)).toBe(0);
  });
  it('4,000 ft is 1,219 m', () => {
    expect(full).toBeCloseTo(4000 * 0.3048, 0);
  });
});

describe('lock box', () => {
  const s = () => emptyWeaponsStatus().lock;
  it('off → nothing; tracking → gates that fill with progress; locked → solid', () => {
    expect(lockBox(s()).show).toBe(false);
    const t = { ...s(), state: 'tracking' as const, targetId: 3, progress: 0.4 };
    const b = lockBox(t);
    expect(b.show).toBe(true);
    expect(b.solid).toBe(false);
    expect(b.fill).toBeCloseTo(0.4, 9);
    const l = lockBox({ ...t, state: 'locked', progress: 1 });
    expect(l.solid).toBe(true);
    expect(l.fill).toBe(1);
  });
  it('tracking without a target id shows nothing; progress is clamped 0..1 and NaN-safe', () => {
    expect(lockBox({ ...s(), state: 'tracking', targetId: null, progress: 0.5 }).show).toBe(false);
    expect(lockBox({ ...s(), state: 'tracking', targetId: 1, progress: 7 }).fill).toBe(1);
    expect(lockBox({ ...s(), state: 'tracking', targetId: 1, progress: NaN }).fill).toBe(0);
  });
});

describe('text', () => {
  it('slant range: NM with one decimal from 1 NM, feet (to 10 ft) inside', () => {
    expect(formatSlantRange(1852 * 2.44)).toBe('2.4 NM');
    expect(formatSlantRange(1852)).toBe('1.0 NM');
    expect(formatSlantRange(1000)).toBe('3280 FT');
    expect(formatSlantRange(1851)).toBe('6070 FT');
    expect(formatSlantRange(0)).toBe('0 FT');
    expect(formatSlantRange(NaN)).toBe('---');
    expect(formatSlantRange(-3)).toBe('---');
  });
  it('km with one decimal', () => {
    expect(formatKm(7234)).toBe('7.2 km');
    expect(formatKm(NaN)).toBe('--- km');
  });
  it('stores: "GUN 1150 CM", "65D ×4", short weapon names', () => {
    expect(ammoLabel(A10_WEAPONS.gun!.name)).toBe('CM');
    expect(ammoLabel(F16_WEAPONS.gun!.name)).toBe('PGU');
    expect(ammoLabel('Mystery gun')).toBe('');
    expect(gunAmmoText(1150, 'CM')).toBe('GUN 1150 CM');
    expect(gunAmmoText(0, '')).toBe('GUN 0');
    expect(gunAmmoText(NaN, 'CM')).toBe('GUN 0 CM');
    expect(missileShortName(A10_WEAPONS.missiles!.name)).toBe('65D');
    expect(missileStoresText(A10_WEAPONS.missiles!.name, 4)).toBe('65D ×4');
    expect(gunShortName(A10_WEAPONS.gun!.name)).toBe('GAU-8');
    expect(gunShortName(F16_WEAPONS.gun!.name)).toBe('M61A1');
    expect(missileShortName('AGM-65D Maverick')).toBe('65D');
  });
});

describe('visibility per aircraft', () => {
  it('Cessna: nothing; F-16: gun only; A-10: gun + Maverick + range cue + markers', () => {
    const c = weaponsVisibility(CONFIG.weapons);
    expect(c.any).toBe(false);
    expect(c.gun || c.missiles || c.rangeCue || c.markers).toBe(false);
    const f = weaponsVisibility(F16_WEAPONS);
    expect(f.any && f.gun && !f.missiles && f.rangeCue).toBe(true);
    const a = weaponsVisibility(A10_WEAPONS);
    expect(a.any && a.gun && a.missiles && a.rangeCue && a.markers).toBe(true);
    expect(weaponsVisibility(null as never).any).toBe(false);
    expect(weaponsVisibility(A10_WEAPONS, { ...CONFIG.hud.weapons, targetMarkers: false }).markers).toBe(false);
  });
});
