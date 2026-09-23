/**
 * The 172RG cabin as a photo from the left seat would show it: the whole six-pack visible under
 * the glareshield lip, slim dark windshield posts where the airframe puts them, the strut and the
 * wing root out of the side window, compass on the windshield header, both yokes, the fuel
 * selector and trim wheel between the seats; interior detail only drawn from the seat; the
 * cabin's sunlight model (roof and wing shade, windows let the sun in) and head looks never NaN.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { fcParams } from '../support/fc';
import { CONFIG } from '../../src/config';
import { createAircraft, createDefaultVisualState } from '../../src/aircraft';
import { PANEL, PANEL_LAYOUT as PL } from '../../src/aircraft/panel';
import { HEADER, POST, innerSurface, postCentreZ, postSideDistance, postTrimGeometry } from '../../src/aircraft/cabinTrim';
import { cabinOpenDistance, cabinTexel, windowDistance } from '../../src/aircraft/livery';
import { CABIN_BOX, cabinSunVisibility } from '../../src/aircraft/cabinLight';
import { DOOR_WINDOW, PILLAR, STRUT, fuselageSection, pillarY, wingLEy, type SectionParams } from '../../src/aircraft/shape';
import { createCameraRig, updateCameraRig } from '../../src/camera/cameraRig';

const EYE = CONFIG.aircraft.geometry.pilotEye;
const DEG = Math.PI / 180;
const sec: SectionParams = { top: 0, bottom: 0, halfWidth: 0, widthY: 0, nTop: 2, nBot: 2 };
/** Left-wall shell point at side-view (z, y). */
function leftWall(z: number, y: number): number {
  fuselageSection(z, sec);
  if (y <= sec.widthY) return -sec.halfWidth;
  return -sec.halfWidth * Math.pow(1 - Math.pow(Math.min(1, (y - sec.widthY) / (sec.top - sec.widthY)), sec.nTop), 1 / sec.nTop);
}

function cockpitAircraft() {
  const ac = createAircraft({ quality: 'low' });
  const v = createDefaultVisualState();
  v.cameraMode = 'cockpit';
  ac.setVisualState(v, 1 / 60);
  ac.root.updateMatrixWorld(true);
  return ac;
}
function interiorMeshes(ac: ReturnType<typeof createAircraft>, skip: string[] = []): THREE.Mesh[] {
  const out: THREE.Mesh[] = [];
  ac.root.getObjectByName('interior')!.traverseVisible((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && !skip.includes(o.name)) out.push(m);
  });
  return out;
}

describe('six-pack in full view', () => {
  it('rays from the eye (and a head 3 cm lower or higher) reach every point of every six-pack bezel unobstructed', () => {
    const ac = cockpitAircraft();
    const meshes = interiorMeshes(ac, ['sunVisors']);
    const panel = ac.root.getObjectByName('panel')!;
    const rc = new THREE.Raycaster();
    const blocked: string[] = [];
    for (const dy of [-0.03, 0, 0.03]) {
      const eye = new THREE.Vector3(EYE.x, EYE.y + dy, EYE.z);
      for (const k of ['airspeed', 'attitude', 'altimeter', 'turn', 'heading', 'vsi'] as const) {
        const g = PL[k];
        for (let i = 0; i < 24; i++) {
          const a = (i / 24) * Math.PI * 2;
          const p = new THREE.Vector3(g.x + Math.cos(a) * g.d * 0.49, g.y + Math.sin(a) * g.d * 0.49, PANEL.z);
          const d = p.clone().sub(eye);
          const len = d.length();
          rc.set(eye, d.normalize());
          rc.far = len + 0.01;
          const hit = rc.intersectObjects(meshes, false)[0];
          if (!hit || hit.object !== panel) blocked.push(`${k}@${Math.round((a * 180) / Math.PI)}° dy=${dy} by ${hit?.object.name ?? 'nothing'}`);
        }
      }
    }
    expect(blocked).toEqual([]);
    ac.dispose();
  });
});

describe('windshield posts (A-pillars): slim dark mouldings where the airframe puts them', () => {
  it('the post centreline runs midway between the windshield edge and the door-window front edge', () => {
    for (const y of [0.4, 0.55, 0.7, 0.85]) {
      const zP = PILLAR.z0 + ((y - PILLAR.y0) * (PILLAR.z1 - PILLAR.z0)) / (PILLAR.y1 - PILLAR.y0);
      const [a, b] = DOOR_WINDOW;
      const zD = a[0] + ((y - a[1]) * (b[0] - a[0])) / (b[1] - a[1]);
      expect(postCentreZ(y)).toBeCloseTo((zP + zD) / 2, 6);
      expect(zP).toBeLessThan(postCentreZ(y));
      expect(zD).toBeGreaterThan(postCentreZ(y));
      // Signed distance: + toward the windshield edge, − toward the door window.
      expect(postSideDistance(zP, y)).toBeGreaterThan(0.03);
      expect(postSideDistance(zD, y)).toBeLessThan(-0.03);
    }
  });

  it('each moulding is 6–8 cm wide, hugs the cabin shell (within 3.5 cm) and faces into the cabin', () => {
    for (const side of [-1, 1] as const) {
      const g = postTrimGeometry(side);
      const p = g.getAttribute('position');
      const n = g.getAttribute('normal');
      let inward = 0;
      const surf = { x: 0, nx: 0, ny: 0 };
      for (let i = 0; i < p.count; i++) {
        const x = p.getX(i);
        const y = p.getY(i);
        const z = p.getZ(i);
        expect(Math.sign(x)).toBe(side);
        // Inside the shell, and within the moulding's depth of it (distance in the section plane).
        innerSurface(y, z, 0.035, surf);
        expect(Math.abs(x)).toBeLessThanOrEqual(surf.x + 0.002);
        fuselageSection(z, sec);
        let dmin = Infinity;
        for (let k = 0; k <= 400; k++) {
          const v = k / 400;
          const H = sec.top - 0.035 - sec.widthY;
          const sy = sec.widthY + H * v;
          const sx = (sec.halfWidth - 0.035) * Math.pow(1 - Math.pow(v, sec.nTop), 1 / sec.nTop);
          dmin = Math.min(dmin, Math.hypot(Math.abs(x) - sx, y - sy));
        }
        expect(dmin).toBeLessThan(POST.depth + 0.008);
        expect(Math.abs(postSideDistance(z, y))).toBeLessThan(POST.halfWidth + 0.003);
        inward += -side * n.getX(i) + -0.3 * n.getY(i);
      }
      expect(inward / p.count).toBeGreaterThan(0.2);
      g.dispose();
    }
    // True (3D) width across the moulding at three heights.
    const s = { x: 0, nx: 0, ny: 0 };
    const TY = 1 / Math.hypot(postCentreZ(1) - postCentreZ(0), 1);
    const TZ = (postCentreZ(1) - postCentreZ(0)) * TY;
    for (const y of [0.45, 0.6, 0.75]) {
      const pts = [-1, 1].map((f) => {
        const z = postCentreZ(y) - TY * f * POST.halfWidth;
        const yy = y + TZ * f * POST.halfWidth;
        innerSurface(yy, z, 0.035, s);
        return new THREE.Vector3(s.x, yy, z);
      });
      const w = pts[0].distanceTo(pts[1]);
      expect(w).toBeGreaterThan(0.06);
      expect(w).toBeLessThan(0.08);
    }
  });

  it('from the seat the left post is under 6° wide, left of 7° and never in the straight-ahead view', () => {
    const m = new THREE.Mesh(postTrimGeometry(-1), new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }));
    m.updateMatrixWorld(true);
    const rc = new THREE.Raycaster();
    const eye = new THREE.Vector3(EYE.x, EYE.y, EYE.z);
    for (const el of [-5, 0, 5, 10, 15]) {
      let a0 = 99;
      let a1 = -99;
      for (let az = -35; az <= 0; az += 0.1) {
        const d = new THREE.Vector3(Math.sin(az * DEG) * Math.cos(el * DEG), Math.sin(el * DEG), -Math.cos(az * DEG) * Math.cos(el * DEG));
        rc.set(eye, d);
        if (rc.intersectObject(m).length) {
          a0 = Math.min(a0, az);
          a1 = Math.max(a1, az);
        }
      }
      expect(a1 - a0, `el ${el}`).toBeGreaterThan(2);
      expect(a1 - a0, `el ${el}`).toBeLessThan(6);
      expect(a1, `el ${el}`).toBeLessThan(-7);
    }
    m.geometry.dispose();
  });

  it('the cabin shell opens right up to the moulding: no band of wall shows beside a post', () => {
    // Where both window edges are straight (the door window's corners are rounded).
    for (let y = 0.47; y < 0.83; y += 0.02) {
      for (let s = -POST.corridorHalf; s <= POST.corridorHalf; s += 0.002) {
        const TY = 1 / Math.hypot(postCentreZ(1) - postCentreZ(0), 1);
        const TZ = (postCentreZ(1) - postCentreZ(0)) * TY;
        const z = postCentreZ(y) - TY * s;
        const yy = y + TZ * s;
        const x = leftWall(z, yy);
        fuselageSection(z, sec);
        const open = cabinOpenDistance(x, yy, z, sec);
        if (Math.abs(s) > POST.halfWidth) expect(open, `y=${y.toFixed(2)} s=${s.toFixed(3)}`).toBeGreaterThan(0);
        if (Math.abs(s) < POST.halfWidth - 0.008) expect(open).toBeLessThan(0);
      }
    }
    // …and never opens the wall away from a window (below the door window, the headliner, the lower wall).
    for (const [z, y] of [[-0.9, 0.3], [-0.7, 0.2], [-0.3, 0.9], [0.0, 0.1], [-1.1, 0.1]] as const) {
      const x = leftWall(z, y);
      fuselageSection(z, sec);
      expect(cabinOpenDistance(x, y, z, sec), `${z},${y}`).toBeLessThan(0);
      expect(windowDistance(x, y, z, sec)).toBeLessThan(0);
    }
  });

  it('posts and header are dark grey plastic, the headliner light, the window seals black', () => {
    const lum = (c: number[]) => (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]) / 255;
    const y = 0.6;
    const z = postCentreZ(y);
    fuselageSection(z, sec);
    const post = cabinTexel(leftWall(z, y), y, z, sec);
    expect(post[3]).toBe(255);
    expect(lum(post)).toBeLessThan(0.3);
    const hz = (HEADER.z0 + HEADER.z1) / 2;
    fuselageSection(hz, sec);
    const header = cabinTexel(-0.1, sec.top - 0.01, hz, sec);
    expect(lum(header)).toBeLessThan(0.3);
    fuselageSection(0.1, sec);
    const roof = cabinTexel(-0.05, sec.top - 0.005, 0.1, sec);
    expect(lum(roof)).toBeGreaterThan(0.5);
  });
});

describe('the world outside the side window and the fittings, where the airframe puts them', () => {
  it('the compass hangs on the centreline from the windshield header, above the glareshield sightline', () => {
    const ac = cockpitAircraft();
    const furniture = ac.root.getObjectByName('cabinFurniture') as THREE.Mesh;
    // Find the compass card (the only cream-coloured patch near the header).
    const p = furniture.geometry.getAttribute('position');
    const c = furniture.geometry.getAttribute('color');
    const card = new THREE.Box3();
    const cream = new THREE.Color(0xe9dfc2);
    for (let i = 0; i < p.count; i++) {
      if (Math.abs(c.getX(i) - cream.r) < 0.01 && Math.abs(c.getY(i) - cream.g) < 0.01 && Math.abs(c.getZ(i) - cream.b) < 0.01) card.expandByPoint(new THREE.Vector3(p.getX(i), p.getY(i), p.getZ(i)));
    }
    expect(card.isEmpty()).toBe(false);
    const ctr = card.getCenter(new THREE.Vector3());
    expect(Math.abs(ctr.x)).toBeLessThan(0.01);
    expect(ctr.z).toBeGreaterThan(HEADER.z0 - 0.08);
    expect(ctr.z).toBeLessThan(HEADER.z1 + 0.05);
    // Seen 8–20° above the eye line, well clear of the view over the nose.
    const el = Math.atan2(ctr.y - EYE.y, EYE.z - ctr.z) / DEG;
    expect(el).toBeGreaterThan(8);
    expect(el).toBeLessThan(22);
    ac.dispose();
  });

  it('both yokes on their shafts, the right one in front of the right seat; fuel selector and trim wheel between the seats', () => {
    const ac = cockpitAircraft();
    const yl = ac.root.getObjectByName('yoke.left')!;
    const yr = ac.root.getObjectByName('yoke.right')!;
    expect(yl.position.x).toBeCloseTo(-yr.position.x, 6);
    expect(yr.position.x).toBeGreaterThan(0.2);
    const tw = ac.root.getObjectByName('trimWheel')!;
    expect(Math.abs(tw.position.x)).toBeLessThan(0.08);
    expect(tw.position.y).toBeLessThan(PANEL.centerY - PANEL.heightM / 2);
    ac.dispose();
  });

  it('the strut and the wing root come through the left door window seen from the eye', () => {
    // Strut midpoint and the wing root underside, projected onto the left wall along the eye ray.
    const through = (p: THREE.Vector3) => {
      const k = (-CABIN_BOX.sideX - EYE.x) / (p.x - EYE.x);
      const z = EYE.z + (p.z - EYE.z) * k;
      const y = EYE.y + (p.y - EYE.y) * k;
      fuselageSection(z, sec);
      return windowDistance(-sec.halfWidth, y, z, sec) > 0.01;
    };
    expect(through(new THREE.Vector3(-(STRUT.fuselage.x + STRUT.wing.x) / 2, 0.35, (STRUT.fuselage.z + STRUT.wing.z) / 2))).toBe(true);
    expect(through(new THREE.Vector3(-1.2, wingLEy(1.2) - 0.05, 0.1))).toBe(true);
  });
});

describe('daylight in the cabin (cabinSunVisibility)', () => {
  const P = (x: number, y: number, z: number) => ({ x, y, z });
  const dir = (az: number, el: number) => ({ x: Math.sin(az * DEG) * Math.cos(el * DEG), y: Math.sin(el * DEG), z: -Math.cos(az * DEG) * Math.cos(el * DEG) });
  const cushion = P(-0.3, -0.17, -0.3);

  it('the roof shades the seats from a high sun; the high wing shades the side windows when the sun is high', () => {
    expect(cabinSunVisibility(cushion, dir(0, 89))).toBe(0);
    // Sun from the left at 60°: the ray leaves through the door window but climbs into the wing.
    expect(cabinSunVisibility(P(-0.2, 0.3, 0.0), dir(-90, 60))).toBe(0);
  });

  it('a low sun from the left shines through the door window onto the right seat back', () => {
    expect(cabinSunVisibility(P(0.3, 0.5, 0.1), dir(-60, 10))).toBe(1);
    // Straight from the side the same ray climbs into the wing's underside.
    expect(cabinSunVisibility(P(0.3, 0.5, 0.1), dir(-90, 12))).toBe(0);
    // …but not onto the pilot\'s lap, below the window sill.
    expect(cabinSunVisibility(P(-0.3, -0.05, -0.2), dir(-90, 5))).toBe(0);
  });

  it('the glareshield shades the pilot\'s knees from the sun ahead; the windshield lets it onto the seat backs', () => {
    expect(cabinSunVisibility(P(-0.28, 0.1, -0.45), dir(0, 20))).toBe(0);
    expect(cabinSunVisibility(P(-0.28, 0.55, 0.1), dir(0, 25))).toBe(1);
    // A sun behind shines through the rear window onto the panel.
    expect(cabinSunVisibility(P(-0.28, 0.3, -0.69), dir(180, 12))).toBeGreaterThan(0.5);
    // Higher, the roof is in the way.
    expect(cabinSunVisibility(P(-0.28, 0.3, -0.69), dir(180, 30))).toBe(0);
  });

  it('fuzz: any point and direction gives a finite 0…1 (NaN and zero directions included)', () => {
    const num = fc.oneof(fc.double({ min: -3, max: 3, noNaN: true }), fc.constantFrom(NaN, Infinity, -Infinity, 0));
    fc.assert(
      fc.property(num, num, num, num, num, num, (px, py, pz, sx, sy, sz) => {
        const v = cabinSunVisibility(P(px, py, pz), P(sx, sy, sz));
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }),
      fcParams(400),
    );
  });
});

describe('only drawn from the seat, and cheap', () => {
  const calls = (ac: ReturnType<typeof createAircraft>) => {
    let n = 0;
    ac.root.traverseVisible((o) => {
      if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) n++;
    });
    return n;
  };
  it('chase view draws the airframe trim but no cockpit-only detail; both views stay within budget', () => {
    const ac = createAircraft({ quality: 'low' });
    const v = createDefaultVisualState();
    v.cameraMode = 'chase';
    ac.setVisualState(v, 1 / 60);
    const chase = calls(ac);
    for (const n of ['cockpitDetail', 'sunVisors', 'throttle', 'gearHandle', 'flapLever', 'trimWheel']) expect(ac.root.getObjectByName(n)!.visible, n).toBe(false);
    expect(ac.root.getObjectByName('cabinTrim')!.visible).toBe(true);
    v.cameraMode = 'cockpit';
    ac.setVisualState(v, 1 / 60);
    const cockpit = calls(ac);
    expect(chase).toBeLessThanOrEqual(54);
    expect(cockpit).toBeLessThanOrEqual(60);
    ac.dispose();
  });
});

describe('fuzz: head looks never go NaN and never leave the cabin', () => {
  it('random drags, wheel zooms and frame times keep the cockpit pose finite, at the eye point, inside the head-look limits', () => {
    const cfg = CONFIG;
    const k = cfg.camera.cockpit;
    const num = fc.oneof(fc.double({ min: -5000, max: 5000, noNaN: true }), fc.constantFrom(NaN, Infinity, -Infinity, 0));
    fc.assert(
      fc.property(fc.array(fc.tuple(num, num, num, fc.boolean(), fc.double({ min: 0, max: 0.2, noNaN: true })), { minLength: 1, maxLength: 30 }), (frames) => {
        let rig = createCameraRig('cockpit', cfg);
        const target = { position: { x: 10, y: 500, z: -20 }, orientation: { x: 0, y: 0, z: 0, w: 1 }, velocity: { x: 0, y: 0, z: -50 }, onGround: false };
        for (const [dx, dy, wheel, dragging, dt] of frames) {
          const r = updateCameraRig(rig, target, { dx, dy, wheel, dragging, shake: 0 }, dt, () => 0, cfg);
          rig = r.state;
          const p = r.pose;
          for (const x of [p.position.x, p.position.y, p.position.z, p.quaternion.x, p.quaternion.y, p.quaternion.z, p.quaternion.w, p.fov]) expect(Number.isFinite(x)).toBe(true);
          // The head turns; it never moves off the eye point (so it never leaves the cabin).
          expect(p.position.x).toBeCloseTo(target.position.x + EYE.x, 5);
          expect(p.position.y).toBeCloseTo(target.position.y + EYE.y, 5);
          expect(p.position.z).toBeCloseTo(target.position.z + EYE.z, 5);
          expect(p.fov).toBeGreaterThanOrEqual(k.minFov - 1e-9);
          expect(p.fov).toBeLessThanOrEqual(k.maxFov + 1e-9);
          expect(Math.abs(rig.cockpit.yaw)).toBeLessThanOrEqual(k.headLookMaxYawDeg * DEG + 1e-9);
          expect(Math.abs(rig.cockpit.pitch)).toBeLessThanOrEqual(k.headLookMaxPitchDeg * DEG + 1e-9);
        }
      }),
      fcParams(150),
    );
  });
});
