/**
 * A-10 TF34-GE-100A nacelles on the upper rear fuselage: the big round intake with its lip, the
 * fan face (28 blades + spinner, spinning with the engine; a blurred disc once it runs fast), the
 * fan cowl (paint atlas), the fan nozzle, the core cowl and the exhaust plug, and the pylon that
 * carries the nacelle on the fuselage's upper side. Built for the right engine (+x); `side` −1
 * mirrors it.
 */
import * as THREE from 'three';
import { loftGeometry } from '../loft';
import { tint, merge } from '../materials';
import { nacelleUV, SWATCH } from './atlas';
import { airfoilPiece, box, V } from '../f16/geom';
import { CORE_PROFILE, ENGINE, NACELLE_PROFILE, PLUG_PROFILE, SHOULDER_INDEX, bodyHalf, lerp } from './shape';

const SEG = 40;

/** Rings of a lathe about the nacelle axis from a [z, r] profile. */
function latheRings(cx: number, profile: [number, number][], segs = SEG, a0 = 0): number[][] {
  return profile.map(([z, r]) => {
    const ring: number[] = [];
    for (let k = 0; k < segs; k++) {
      const a = a0 + (k / segs) * Math.PI * 2;
      ring.push(cx + Math.sin(a) * r, ENGINE.y + Math.cos(a) * r, z);
    }
    return ring;
  });
}

function colourRamp(g: THREE.BufferGeometry, f: (p: THREE.Vector3) => [number, number, number, number, number]) {
  const pos = g.getAttribute('position');
  const col = new Float32Array(pos.count * 3);
  const rm = new Float32Array(pos.count * 2);
  const p = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    p.fromBufferAttribute(pos, i);
    const [r, gg, b, rough, metal] = f(p);
    col[i * 3] = r;
    col[i * 3 + 1] = gg;
    col[i * 3 + 2] = b;
    rm[i * 2] = rough;
    rm[i * 2 + 1] = metal;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('rm', new THREE.BufferAttribute(rm, 2));
  return g;
}

export interface EngineBuild {
  /** Fan cowl (paint atlas). */
  cowl: THREE.BufferGeometry;
  /** Pylon (paint swatch). */
  pylon: THREE.BufferGeometry;
  /** Intake duct, fan nozzle, core cowl, plug (parts: vertex colours). */
  hot: THREE.BufferGeometry;
  /** Fan blades (rotate about the local z axis; group origin on the nacelle axis at the fan face). */
  blades: THREE.BufferGeometry;
  /** Spinner (rotates with the blades). */
  spinner: THREE.BufferGeometry;
  /** Blurred fan disc (shown when the fan runs fast). */
  disc: THREE.BufferGeometry;
  /** Fan hub centre (body coordinates). */
  fanCentre: THREE.Vector3;
}

export function buildEngine(side: 1 | -1): EngineBuild {
  const cx = side * ENGINE.x;
  // ── Fan cowl: from inside the lip, round the lip, along the outer profile to the fan nozzle. ──
  const lip: [number, number][] = [];
  const rIn = ENGINE.intakeRadius;
  const rOut = NACELLE_PROFILE[1][1];
  const zl = ENGINE.lipZ;
  const lipR = (rOut - rIn) / 2;
  const lipC = rIn + lipR;
  for (let i = 0; i <= 8; i++) {
    const t = -Math.PI / 2 + (i / 8) * Math.PI; // inner (−π/2) → front → outer (+π/2)
    lip.push([zl + lipR * 1.4 - Math.cos(t) * lipR * 1.4, lipC + Math.sin(t) * lipR]);
  }
  const outer = NACELLE_PROFILE.slice(2);
  const cowlProfile: [number, number][] = [[zl + 0.12, rIn - 0.004], ...lip, ...outer];
  // Inside the fan nozzle (the bypass duct's outer wall) — keeps the cowl a closed shell from behind.
  const last = outer[outer.length - 1];
  cowlProfile.push([last[0] + 0.004, last[1] - 0.018], [last[0] - 0.25, last[1] - 0.03]);
  const cowl = loftGeometry(latheRings(cx, cowlProfile), { closed: true, orient: 'keep' });
  fixOutward(cowl, cx);
  {
    const p = cowl.getAttribute('position');
    const uv = cowl.getAttribute('uv') as THREE.BufferAttribute;
    const t: [number, number] = [0, 0];
    for (let i = 0; i < p.count; i++) {
      // Angle measured from the top, clockwise seen from behind, mirrored on the left engine.
      const a = Math.atan2(side * (p.getX(i) - cx), p.getY(i) - ENGINE.y);
      nacelleUV(p.getZ(i), a, t);
      uv.setXY(i, t[0], t[1]);
    }
  }

  // ── Hot / dark parts (vertex coloured) ──
  const parts: THREE.BufferGeometry[] = [];
  // Intake duct: lip inside → fan face (grey paint near the lip, darkening inside).
  const duct = loftGeometry(latheRings(cx, [[zl + 0.1, rIn - 0.002], [zl + 0.22, rIn - 0.012], [ENGINE.fanZ + 0.02, ENGINE.fanRadius + 0.012]]), { closed: true, orient: 'keep' });
  fixInward(duct, cx);
  parts.push(colourRamp(duct, (p) => {
    const k = Math.max(0, Math.min(1, (p.z - zl - 0.08) / 0.3));
    const c = lerp(0.2, 0.05, k);
    return [c, c, c * 1.02, 0.6, 0.2];
  }));
  // Fan-duct inner wall and core cowl (dull metal), core nozzle and plug (heat-stained).
  const core = loftGeometry(latheRings(cx, CORE_PROFILE), { closed: true, capStart: true });
  parts.push(colourRamp(core, (p) => {
    const k = Math.max(0, Math.min(1, (p.z - 5.6) / 0.55));
    return [lerp(0.2, 0.14, k), lerp(0.2, 0.12, k), lerp(0.21, 0.11, k), 0.55, 0.6];
  }));
  // Core nozzle lip (dark hole) and the plug.
  const holeRing = latheRings(cx, [[6.14, 0.345], [6.13, 0.33], [6.02, 0.3]]);
  const hole = loftGeometry(holeRing, { closed: true, orient: 'keep' });
  fixInward(hole, cx);
  parts.push(colourRamp(hole, () => [0.02, 0.018, 0.017, 0.8, 0.3]));
  const plug = loftGeometry(latheRings(cx, PLUG_PROFILE), { closed: true });
  parts.push(colourRamp(plug, (p) => {
    const k = Math.max(0, Math.min(1, (p.z - 6.0) / 0.4));
    return [lerp(0.09, 0.2, k), lerp(0.08, 0.17, k), lerp(0.075, 0.14, k), 0.5, 0.7];
  }));
  // Bypass duct floor between the core cowl and the fan nozzle (dark annulus seen from behind).
  const annulus = loftGeometry(latheRings(cx, [[5.55, 0.505], [5.55, 0.43]]), { closed: true, orient: 'keep' });
  faceAft(annulus);
  parts.push(colourRamp(annulus, () => [0.015, 0.015, 0.016, 0.8, 0.2]));
  // Fan case ring round the blades.
  parts.push(tint(new THREE.CylinderGeometry(ENGINE.fanRadius + 0.012, ENGINE.fanRadius + 0.012, 0.08, SEG, 1, true).rotateX(Math.PI / 2).translate(cx, ENGINE.y, ENGINE.fanZ + 0.02), 0x2a2c2e, 0.6, 0.5));
  // Fan-face backing (hub to case) behind the blades: dark, and it gives the nacelle a solid shadow.
  const back = new THREE.CircleGeometry(ENGINE.fanRadius + 0.012, SEG);
  back.rotateY(Math.PI);
  back.translate(cx, ENGINE.y, ENGINE.fanZ + 0.07);
  parts.push(tint(back, 0x141516, 0.7, 0.3));
  const hot = merge(parts);

  // ── Pylon: from the nacelle's lower inboard quarter to the fuselage top side. ──
  const pylon = buildPylon(side);

  // ── Fan (local frame: origin on the axis at the fan face, +z aft). ──
  const bl: THREE.BufferGeometry[] = [];
  const n = ENGINE.fanBlades;
  const hub = 0.16;
  for (let k = 0; k < n; k++) {
    const a = (k / n) * Math.PI * 2;
    const len = ENGINE.fanRadius - hub - 0.005;
    const b = box(0.075, len, 0.012, V(0, hub + len / 2, 0), 0, 0, 0);
    // Twist (pitch) the blade: steeper at the root.
    b.rotateY(0.55);
    b.rotateZ(-a);
    bl.push(tint(b, 0x7a7e82, 0.35, 0.85));
  }
  const blades = merge(bl);
  const sp = new THREE.ConeGeometry(hub, 0.3, 24, 1, false);
  sp.rotateX(-Math.PI / 2);
  sp.translate(0, 0, -0.15);
  const spinner = merge([
    tint(sp, 0x3a3d40, 0.4, 0.3),
    // A white index stripe so the rotation reads.
    tint(box(0.012, 0.004, 0.2, V(0, 0.07, -0.12), -0.47, 0, 0), 0xe8e8e2, 0.5, 0),
  ]);
  // Blurred disc: concentric shades (hub dark → blade tips lighter), a hair in front of the blades.
  const discGeo = new THREE.RingGeometry(hub, ENGINE.fanRadius, 48, 4);
  discGeo.rotateY(Math.PI);
  const dp = discGeo.getAttribute('position');
  const dcol = new Float32Array(dp.count * 3);
  const drm = new Float32Array(dp.count * 2);
  for (let i = 0; i < dp.count; i++) {
    const r = Math.hypot(dp.getX(i), dp.getY(i));
    const k = (r - hub) / (ENGINE.fanRadius - hub);
    const c = 0.16 + 0.1 * k + 0.05 * Math.sin(k * 9);
    dcol[i * 3] = c;
    dcol[i * 3 + 1] = c;
    dcol[i * 3 + 2] = c * 1.03;
    drm[i * 2] = 0.45;
    drm[i * 2 + 1] = 0.7;
  }
  discGeo.setAttribute('color', new THREE.BufferAttribute(dcol, 3));
  discGeo.setAttribute('rm', new THREE.BufferAttribute(drm, 2));
  discGeo.translate(0, 0, -0.004);
  return { cowl, pylon, hot, blades, spinner, disc: discGeo, fanCentre: V(cx, ENGINE.y, ENGINE.fanZ) };
}

/** The nacelle pylon: a thick airfoil strut from the nacelle to the fuselage's upper side. */
function buildPylon(side: 1 | -1): THREE.BufferGeometry {
  const cx = side * ENGINE.x;
  const ang = (side > 0 ? -1 : 1) * (Math.PI * 0.72); // lower inboard quarter
  const rings: number[][] = [];
  const steps = 5;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps; // 0 = inside the nacelle … 1 = inside the fuselage
    const z0 = lerp(3.7, 3.45, t);
    const z1 = lerp(5.55, 6.05, t);
    const zc = (z0 + z1) / 2;
    // Nacelle attach point → fuselage shoulder at this station.
    const nx = cx + Math.sin(ang) * (ENGINE.radius - 0.1);
    const ny = ENGINE.y + Math.cos(ang) * (ENGINE.radius - 0.1);
    const half = bodyHalf(zc);
    const fx = side * half[SHOULDER_INDEX - 1][0];
    const fy = half[SHOULDER_INDEX - 1][1] - 0.06;
    const x = lerp(nx, fx, t);
    const y = lerp(ny, fy, t);
    const r = airfoilPiece(0.16, 0, 0.4, 0, 1, 14);
    const ring: number[] = [];
    const c = z1 - z0;
    // Section plane: the strut's thickness is vertical-ish (perpendicular to its run).
    const dx = fx - nx;
    const dy = fy - ny;
    const l = Math.hypot(dx, dy);
    const px = -dy / l;
    const py = dx / l;
    for (let k = 0; k < r.length; k += 2) ring.push(x + px * r[k + 1] * c, y + py * r[k + 1] * c, z0 + r[k] * c);
    rings.push(ring);
  }
  const g = loftGeometry(rings, { capStart: true, capEnd: true });
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, SWATCH.dark[0], SWATCH.dark[1]);
  return g;
}

/** Make a flat annulus face aft (+z). */
function faceAft(g: THREE.BufferGeometry) {
  const nor = g.getAttribute('normal');
  let s = 0;
  for (let i = 0; i < nor.count; i++) s += nor.getZ(i);
  if (s > 0) return;
  flip(g);
}

function flip(g: THREE.BufferGeometry) {
  const nor = g.getAttribute('normal');
  for (let k = 0; k < nor.count; k++) nor.setXYZ(k, -nor.getX(k), -nor.getY(k), -nor.getZ(k));
  const idx = g.getIndex()!;
  const a = idx.array as Uint16Array | Uint32Array;
  for (let t = 0; t < a.length; t += 3) {
    const tmp = a[t + 1];
    a[t + 1] = a[t + 2];
    a[t + 2] = tmp;
  }
  idx.needsUpdate = true;
}

/** Flip a lathe so its normals face away from the nacelle axis (checked at the widest point). */
function fixOutward(g: THREE.BufferGeometry, cx: number) {
  orient(g, cx, true);
}
function fixInward(g: THREE.BufferGeometry, cx: number) {
  orient(g, cx, false);
}
function orient(g: THREE.BufferGeometry, cx: number, outward: boolean) {
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  let s = 0;
  for (let i = 0; i < pos.count; i++) {
    const rx = pos.getX(i) - cx;
    const ry = pos.getY(i) - ENGINE.y;
    s += nor.getX(i) * rx + nor.getY(i) * ry;
  }
  if (s > 0 === outward) return;
  flip(g);
}
