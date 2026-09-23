/**
 * The view from the left seat: a real C172 sight picture. Eye height over the seat, headroom,
 * distance to the panel, the cowling just visible over the glareshield (panel top 12–16° below the
 * eye line, horizon about a third of the way down the default view), slim door posts, and the wing root and strut out of the left
 * side window.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { fcParams } from '../support/fc';
import { CONFIG } from '../../src/config';
import { COCKPIT, LIP_Y, glareshieldTopY } from '../../src/aircraft/cockpit';
import { PANEL, PANEL_LAYOUT } from '../../src/aircraft/panel';
import { CABIN_INSET, windowDistance } from '../../src/aircraft/livery';
import { DOOR_WINDOW, FUSE_Z0, STRUT, fuselageSection, wingLEy, type SectionParams } from '../../src/aircraft/shape';

const EYE = CONFIG.aircraft.geometry.pilotEye;
const CAM = CONFIG.camera.cockpit;
const DEG = Math.PI / 180;
const sec: SectionParams = { top: 0, bottom: 0, halfWidth: 0, widthY: 0, nTop: 2, nBot: 2 };

/** Depression angle (deg, + = below the eye's horizontal) from the eye to a body point (y, z) straight ahead. */
const depression = (y: number, z: number) => Math.atan2(EYE.y - y, EYE.z - z) / DEG;

/** Screen row (0 top … 1 bottom) of a direction `deg` below the horizon in the default cockpit view. */
function screenRow(degBelow: number): number {
  const half = (CAM.fov / 2) * DEG;
  return 0.5 + (0.5 * Math.tan((degBelow - CAM.lookDownDeg) * DEG)) / Math.tan(half);
}

describe('pilot eye point (left seat)', () => {
  it('sits at a realistic seated eye height over the cushion with headroom under the roof', () => {
    expect(EYE.x).toBeLessThan(-0.2);
    expect(EYE.x).toBeGreaterThan(-0.36);
    const overCushion = EYE.y - COCKPIT.cushionTopY;
    expect(overCushion).toBeGreaterThan(0.74);
    expect(overCushion).toBeLessThan(0.88);
    fuselageSection(EYE.z, sec);
    const innerRoof = sec.top - 0.035;
    expect(innerRoof - EYE.y).toBeGreaterThan(0.2);
  });

  it('is 0.65–0.8 m from the panel face, ahead of the reclined seat back', () => {
    const d = EYE.z - PANEL.z;
    expect(d).toBeGreaterThan(0.65);
    expect(d).toBeLessThan(0.8);
    expect(EYE.z).toBeLessThan(COCKPIT.seatBackFrontZ(EYE.y) - 0.08);
  });

  it('sees the cowling over the glareshield (the glareshield never hides the nose)', () => {
    fuselageSection(FUSE_Z0 + 0.02, sec);
    const cowlFront = depression(sec.top, FUSE_Z0 + 0.02);
    // Every glareshield point in front of the pilot is lower in the view than the cowling's front.
    for (let z = -1.2; z <= PANEL.z; z += 0.02) {
      expect(depression(glareshieldTopY(EYE.x, z), z)).toBeGreaterThan(cowlFront + 1.5);
    }
    expect(cowlFront).toBeGreaterThan(6);
    expect(cowlFront).toBeLessThan(16);
  });

  it('frames the default view like a real 172: horizon about a third down, glareshield 12–16° below the eye line', () => {
    expect(screenRow(0)).toBeGreaterThan(0.3);
    expect(screenRow(0)).toBeLessThan(0.4);
    const lip = depression(LIP_Y, PANEL.z + 0.02);
    expect(lip).toBeGreaterThan(12);
    expect(lip).toBeLessThan(16);
    expect(screenRow(lip)).toBeGreaterThan(0.5);
    expect(screenRow(lip)).toBeLessThan(0.62);
    // The whole six-pack is on screen above the bottom edge.
    expect(screenRow(depression(PANEL_LAYOUT.turn.y - PANEL_LAYOUT.turn.d / 2, PANEL.z))).toBeLessThan(0.95);
  });

  it('the left door post (A-pillar trim) is slim: under 8° wide seen from the seat', () => {
    // Scan the cabin side at several heights; the solid run between the windshield opening and
    // the door-window opening is the post. Measure its angular width from the eye.
    for (const y of [0.45, 0.6, 0.75]) {
      const solid: number[] = [];
      for (let z = -1.3; z <= -0.3; z += 0.002) {
        fuselageSection(z, sec);
        if (y > sec.top - 0.05) continue;
        const x = -sec.halfWidth * Math.pow(1 - Math.pow(Math.max(0, (y - sec.widthY) / (sec.top - sec.widthY)), sec.nTop), 1 / sec.nTop);
        const open = windowDistance(x, y, z, sec) > CABIN_INSET;
        if (!open) solid.push(z);
      }
      // The post is the solid run just behind the windshield's side edge.
      const runs: Array<[number, number]> = [];
      for (const z of solid) {
        const last = runs[runs.length - 1];
        if (last && z - last[1] < 0.003) last[1] = z;
        else runs.push([z, z]);
      }
      const post = runs.find((r) => r[0] > -1.25 && r[1] < -0.35 && r[1] - r[0] < 0.4);
      expect(post, `post at y=${y}`).toBeDefined();
      const [z0, z1] = post!;
      fuselageSection((z0 + z1) / 2, sec);
      const px = -sec.halfWidth + 0.035;
      const a0 = Math.atan2(px - EYE.x, EYE.z - z0);
      const a1 = Math.atan2(px - EYE.x, EYE.z - z1);
      expect(Math.abs(a1 - a0) / DEG).toBeLessThan(8);
    }
  });

  it('looking left, the strut and the wing root are seen through the door window', () => {
    const through = (p: { x: number; y: number; z: number }) => {
      // Where the ray from the eye crosses the cabin side (x ≈ inner wall) in side view.
      fuselageSection(EYE.z, sec);
      const wall = -sec.halfWidth;
      const k = (wall - EYE.x) / (p.x - EYE.x);
      const z = EYE.z + (p.z - EYE.z) * k;
      const y = EYE.y + (p.y - EYE.y) * k;
      // Inside the door-window polygon (convex): same side of every edge.
      let pos = 0;
      let neg = 0;
      for (let i = 0; i < DOOR_WINDOW.length; i++) {
        const a = DOOR_WINDOW[i];
        const b = DOOR_WINDOW[(i + 1) % DOOR_WINDOW.length];
        const c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (z - a[0]);
        if (c > 0) pos++;
        else if (c < 0) neg++;
      }
      return pos === 0 || neg === 0;
    };
    const strutMid = { x: -(STRUT.fuselage.x + STRUT.wing.x) / 2, y: (STRUT.fuselage.y + 0.9) / 2 + 0.1, z: (STRUT.fuselage.z + STRUT.wing.z) / 2 };
    expect(through(strutMid)).toBe(true);
    const wingRootUnder = { x: -1.3, y: wingLEy(1.3) - 0.04, z: -0.1 };
    expect(through(wingRootUnder)).toBe(true);
    // …and the head can turn that far.
    expect(CAM.headLookMaxYawDeg).toBeGreaterThanOrEqual(90);
  });
});

describe('property: glareshield profile', () => {
  it('is finite, below the cabin roof and never rises into the pilot\'s sightline to the cowling', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -0.5, max: 0.5, noNaN: true }),
        fc.double({ min: -1.24, max: PANEL.z, noNaN: true }),
        // Head within ±2 cm up/down and ±4 cm fore/aft of the eye point (the rebuilt 172RG panel sits at
        // the edge of the sightline for a head 3 cm low — see RESUME.md §5).
        fc.double({ min: -0.02, max: 0.02, noNaN: true }),
        fc.double({ min: -0.04, max: 0.04, noNaN: true }),
        (x, z, dy, dz) => {
          const y = glareshieldTopY(x, z);
          expect(Number.isFinite(y)).toBe(true);
          fuselageSection(z, sec);
          expect(y).toBeLessThan(sec.top);
          // With the head anywhere in that box, the glareshield stays below
          // the line of sight to the cowling's front.
          const ey = EYE.y + dy;
          const ez = EYE.z + dz;
          fuselageSection(FUSE_Z0 + 0.02, sec);
          const cowl = Math.atan2(ey - sec.top, ez - FUSE_Z0 - 0.02);
          expect(Math.atan2(ey - y, ez - z)).toBeGreaterThanOrEqual(cowl + 0.25 * (Math.PI / 180));
        },
      ),
      fcParams(300),
    );
  });
});
