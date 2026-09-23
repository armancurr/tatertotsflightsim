/**
 * A-10C canopy and cockpit: the armoured windscreen (flat front panel, side panels, heavy frame)
 * and the big one-piece bubble canopy hinged at the rear; the glareshield with the HUD and its
 * combiner, the up-front controller (UFC) below it, the two MFCDs, standby and engine instruments
 * on the painted panel; the centre stick, the throttles on the left console, the ACES II seat and
 * the pilot (helmet with visor, olive flight suit, harness). The HUD symbology is drawn by the UI.
 */
import * as THREE from 'three';
import { loftGeometry } from '../loft';
import { tint, merge } from '../materials';
import { box, ellipsoid, tube, V } from '../f16/geom';
import { ANCHOR, CANOPY_FRONT_Z, CANOPY_REAR_Z, WINDSCREEN_BOW_Z, canopyArch, canopyAt } from './shape';

const EYE = ANCHOR.eye;

export interface CockpitBuild {
  canopyGlass: THREE.BufferGeometry;
  canopyFrame: THREE.BufferGeometry;
  interior: THREE.BufferGeometry;
  pilotBody: THREE.BufferGeometry;
  pilotHead: THREE.BufferGeometry;
  hudGlass: THREE.BufferGeometry;
  screens: THREE.BufferGeometry;
  panelFace: THREE.BufferGeometry;
}

/** Screen canvas: the two MFCD pages (top half) and the painted instrument panel (bottom half). */
export const SCREEN_ATLAS = { width: 1024, height: 1024 } as const;

/** Instrument panel plane: centre height, depth, tilt (raked back), size. */
export const PANEL = { cy: 0.56, z: -5.02, tilt: -0.16, w: 0.9, h: 0.46 } as const;
/** The glareshield's aft lip (limits the view over the nose). */
export const GLARESHIELD = { y: 0.875, z: -4.98 } as const;

function quad(w: number, h: number, c: THREE.Vector3, tiltX: number, u0: number, v0: number, u1: number, v1: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + (u1 - u0) * uv.getX(i), v0 + (v1 - v0) * uv.getY(i));
  g.rotateX(tiltX);
  g.translate(c.x, c.y, c.z);
  return g;
}

/** A point on the panel plane (panel coordinates x right, y up from the panel centre). */
export function panelPoint(x: number, y: number, dz = 0): THREE.Vector3 {
  const c = Math.cos(PANEL.tilt);
  const s = Math.sin(PANEL.tilt);
  // rotateX(tilt) of (x, y, dz) then translate.
  return V(x, PANEL.cy + y * c - dz * s, PANEL.z + y * s + dz * c);
}

function buildCanopy(): { glass: THREE.BufferGeometry; frame: THREE.BufferGeometry } {
  const rings: number[][] = [];
  const n = 28;
  const zs: number[] = [];
  for (let i = 0; i <= 8; i++) zs.push(CANOPY_FRONT_Z + ((WINDSCREEN_BOW_Z - CANOPY_FRONT_Z) * i) / 8);
  for (let i = 1; i <= 26; i++) zs.push(WINDSCREEN_BOW_Z + ((CANOPY_REAR_Z - WINDSCREEN_BOW_Z) * i) / 26);
  for (const z of zs) rings.push(canopyArch(z, n));
  const glass = loftGeometry(rings, { closed: false });

  const f: THREE.BufferGeometry[] = [];
  const FRAME = 0x3a3e41;
  // Sill rails along both sides.
  for (const s of [-1, 1]) {
    let prev: THREE.Vector3 | null = null;
    for (let i = 0; i <= 18; i++) {
      const z = CANOPY_FRONT_Z + ((CANOPY_REAR_Z - CANOPY_FRONT_Z) * i) / 18;
      const c = canopyAt(z);
      const p = V(s * (c.w + 0.006), c.sill + 0.012, z);
      if (prev) f.push(tint(tube(prev, p, 0.028, 0.028, 6), FRAME, 0.55, 0.3));
      prev = p;
    }
  }
  // Windscreen: heavy bow at the canopy joint, A-pillars at the front panel's corners, base frame.
  const band = (z: number, width: number, depth: number, outset: number) => {
    const a = canopyArch(z - width / 2, 24, -outset);
    const b = canopyArch(z + width / 2, 24, -outset);
    const c2 = canopyArch(z + width / 2, 24, depth);
    const d = canopyArch(z - width / 2, 24, depth);
    f.push(tint(loftGeometry([a, b, c2, d, a.slice()], { closed: false }), FRAME, 0.5, 0.3));
  };
  band(WINDSCREEN_BOW_Z, 0.1, 0.05, 0.012);
  band(CANOPY_REAR_Z + 0.05, 0.1, 0.05, 0.008);
  // A-pillars: follow the front panel's corners (where the arch turns from the flat front to the side).
  for (const s of [-1, 1]) {
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 6; i++) {
      const z = CANOPY_FRONT_Z + 0.03 + ((WINDSCREEN_BOW_Z - CANOPY_FRONT_Z - 0.03) * i) / 6;
      const c = canopyAt(z);
      const t = 0.3; // arch parameter of the corner (0 = sill, 0.5 = top)
      const cs = Math.cos(t * Math.PI);
      const sn = Math.sin(t * Math.PI);
      pts.push(V(s * c.w * Math.abs(cs) ** (2 / c.n) * 1.01, c.sill + (c.top - c.sill) * Math.abs(sn) ** (2 / c.n) + 0.008, z));
    }
    for (let i = 0; i < pts.length - 1; i++) f.push(tint(tube(pts[i], pts[i + 1], 0.024, 0.024, 6), FRAME, 0.5, 0.3));
  }
  // Base of the windscreen.
  {
    const a = canopyArch(CANOPY_FRONT_Z + 0.02, 16, -0.01);
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k < a.length; k += 3) pts.push(V(a[k], a[k + 1], a[k + 2]));
    for (let i = 0; i < pts.length - 1; i++) f.push(tint(tube(pts[i], pts[i + 1], 0.025, 0.025, 6), FRAME, 0.5, 0.3));
  }
  // Canopy hinge fairing and the rear actuator housing behind the head.
  f.push(tint(box(0.16, 0.08, 0.3, V(0, canopyAt(CANOPY_REAR_Z).top - 0.06, CANOPY_REAR_Z + 0.12)), FRAME, 0.55, 0.2));
  return { glass, frame: merge(f) };
}

function buildInterior(): THREE.BufferGeometry {
  const g: THREE.BufferGeometry[] = [];
  const DARK = 0x2b2e30;
  const PANEL_GREY = 0x3a3e42;
  const BLACK = 0x111213;
  const CONSOLE = 0x3c4044;
  // Glareshield: an arch over the panel, its aft lip ~20° below the eye straight ahead.
  const hoodRing = (z: number, top: number, hw: number) => {
    const out: number[] = [];
    const n = 16;
    for (let k = 0; k <= n; k++) {
      const t = -1 + (2 * k) / n;
      out.push(t * hw, top - 0.05 * t * t - 0.06 * t ** 8, z);
    }
    for (let k = n; k >= 0; k--) {
      const t = -1 + (2 * k) / n;
      out.push(t * (hw - 0.01), top - 0.03 - 0.05 * t * t - 0.06 * t ** 8, z);
    }
    return out;
  };
  const G = GLARESHIELD;
  g.push(tint(loftGeometry([hoodRing(-5.3, 0.8, 0.44), hoodRing(-5.15, 0.855, 0.44), hoodRing(G.z - 0.02, G.y, 0.43), hoodRing(G.z, G.y - 0.015, 0.43)], { closed: true, capStart: true, capEnd: true }), BLACK, 0.85, 0));
  // Instrument panel box (its face is the painted quad), with side extensions to the consoles.
  const pc = panelPoint(0, 0, -0.025);
  g.push(tint(box(PANEL.w, PANEL.h, 0.04, pc, PANEL.tilt, 0, 0), PANEL_GREY, 0.7, 0.1));
  // HUD: projector body under the combiner (on the glareshield), combiner frame.
  const hudZ = G.z + 0.02;
  g.push(tint(box(0.2, 0.09, 0.24, V(0, G.y - 0.01, hudZ - 0.12)), BLACK, 0.6, 0.2));
  const hudBot = G.y + 0.03;
  const hudTop = G.y + 0.2;
  for (const s of [-1, 1]) g.push(tint(box(0.012, hudTop - hudBot + 0.02, 0.02, V(s * 0.08, (hudTop + hudBot) / 2, hudZ), 0.22, 0, 0), BLACK, 0.5, 0.3));
  g.push(tint(box(0.17, 0.02, 0.03, V(0, hudBot - 0.01, hudZ - 0.02)), BLACK, 0.5, 0.3));
  // UFC housing under the HUD (the keys are painted on the panel face).
  g.push(tint(box(0.24, 0.12, 0.05, panelPoint(0, 0.15, 0.015), PANEL.tilt, 0, 0), DARK, 0.65, 0.1));
  // MFCD bezels (the screens are separate quads).
  for (const s of [-1, 1]) g.push(tint(box(0.21, 0.21, 0.03, panelPoint(s * 0.215, -0.02, 0.006), PANEL.tilt, 0, 0), DARK, 0.6, 0.1));
  // Side consoles, cockpit sidewalls up to the sills.
  for (const s of [-1, 1]) {
    g.push(tint(box(0.17, 0.12, 1.25, V(s * 0.39, 0.5, -4.35)), CONSOLE, 0.75, 0.05));
    g.push(tint(box(0.03, 0.2, 2.0, V(s * 0.5, 0.58, -4.25)), DARK, 0.85, 0));
    for (let k = 0; k < 9; k++) {
      const x = s * (0.34 + (k % 3) * 0.045);
      const z = -4.9 + k * 0.12;
      g.push(tint(tube(V(x, 0.56, z), V(x, 0.578, z), 0.011, 0.011, 8), 0x1a1a1a, 0.6, 0.2));
    }
    for (let k = 0; k < 6; k++) g.push(tint(box(0.13, 0.004, 0.1, V(s * 0.39, 0.5615, -4.0 - k * 0.12)), 0x2e3134, 0.7, 0.05));
  }
  // Centre stick.
  g.push(tint(box(0.12, 0.05, 0.12, V(0, 0.3, -4.62)), DARK, 0.7, 0.1));
  g.push(tint(tube(V(0, 0.32, -4.62), V(0, 0.62, -4.66), 0.018, 0.016, 10), BLACK, 0.55, 0.2));
  g.push(tint(ellipsoid(V(0, 0.67, -4.67), 0.026, 0.06, 0.032, 12, 8), 0x161616, 0.55, 0.05));
  // Throttles (two grips) on the left console.
  for (const dx of [-0.02, 0.035]) {
    g.push(tint(box(0.03, 0.1, 0.03, V(-0.37 + dx, 0.61, -4.44), 0.25, 0, 0), 0x222324, 0.6, 0.2));
    g.push(tint(box(0.045, 0.05, 0.08, V(-0.37 + dx, 0.67, -4.46), 0.25, 0, 0), 0x161616, 0.55, 0.05));
  }
  // ACES II seat (upright ~13°): bucket, back, headrest, parachute pack, ejection handles.
  const rec = -13 * (Math.PI / 180);
  g.push(tint(box(0.44, 0.08, 0.46, V(0, 0.28, -4.28)), 0x2c2f2a, 0.8, 0));
  for (const s of [-1, 1]) g.push(tint(box(0.05, 0.36, 0.52, V(s * 0.26, 0.36, -4.22)), 0x2c2f2a, 0.8, 0));
  g.push(tint(box(0.44, 0.8, 0.12, V(0, 0.72, -3.94), rec, 0, 0), 0x2a2e26, 0.85, 0));
  g.push(tint(box(0.34, 0.28, 0.18, V(0, 1.24, -3.86), rec, 0, 0), 0x2e3229, 0.8, 0));
  g.push(tint(box(0.24, 0.04, 0.17, V(0, 1.39, -3.89), rec, 0, 0), 0xb8962a, 0.6, 0));
  for (const s of [-1, 1]) g.push(tint(tube(V(s * 0.2, 0.34, -4.52), V(s * 0.2, 0.42, -4.5), 0.014, 0.014, 6), 0xd8b020, 0.5, 0));
  // Rudder pedals, floor.
  for (const s of [-1, 1]) g.push(tint(box(0.1, 0.16, 0.03, V(s * 0.15, 0.22, -5.2), -0.5, 0, 0), 0x3a3a3a, 0.6, 0.3));
  g.push(tint(box(0.84, 0.03, 2.1, V(0, 0.09, -4.2)), 0x25282a, 0.85, 0));
  // Aft bulkhead / avionics behind the seat.
  g.push(tint(box(0.9, 0.7, 0.05, V(0, 0.8, -3.1)), DARK, 0.8, 0));
  return merge(g);
}

function buildPilot(): { body: THREE.BufferGeometry; head: THREE.BufferGeometry } {
  const SUIT = 0x59604a;
  const VEST = 0x3b3e30;
  const GSUIT = 0x6a6249;
  const GLOVE = 0x2e2d2a;
  const b: THREE.BufferGeometry[] = [];
  const hip = V(0, 0.4, -4.25);
  const neck = V(0, 0.93, -4.12);
  b.push(tint(tube(hip, neck, 0.16, 0.15, 14), SUIT, 0.9, 0));
  b.push(tint(tube(V(0, 0.58, -4.21), V(0, 0.9, -4.13), 0.178, 0.162, 14), VEST, 0.85, 0));
  for (const s of [-1, 1]) {
    const sh = V(s * 0.19, 0.86, -4.13);
    const el = V(s * 0.25, 0.62, -4.3);
    const hand = s > 0 ? V(0.03, 0.66, -4.64) : V(-0.35, 0.68, -4.44);
    b.push(tint(ellipsoid(sh, 0.075, 0.07, 0.075, 10, 8), VEST, 0.85, 0));
    b.push(tint(tube(sh, el, 0.055, 0.048, 10), SUIT, 0.9, 0));
    b.push(tint(tube(el, hand, 0.046, 0.04, 10), SUIT, 0.9, 0));
    b.push(tint(ellipsoid(hand, 0.042, 0.035, 0.05, 10, 8), GLOVE, 0.7, 0));
    b.push(tint(tube(V(s * 0.1, 0.9, -4.14), V(s * 0.08, 0.5, -4.3), 0.022, 0.022, 6), 0x2f2f28, 0.8, 0));
    const hipS = V(s * 0.11, 0.38, -4.3);
    const knee = V(s * 0.14, 0.5, -4.78);
    const foot = V(s * 0.15, 0.2, -5.15);
    b.push(tint(tube(hipS, knee, 0.085, 0.07, 10), GSUIT, 0.9, 0));
    b.push(tint(tube(knee, foot, 0.06, 0.05, 10), SUIT, 0.9, 0));
  }
  b.push(tint(tube(V(0.03, 0.99, -4.36), V(0.1, 0.78, -4.26), 0.018, 0.018, 8), 0x202020, 0.7, 0));

  const h: THREE.BufferGeometry[] = [];
  const hc = V(0, EYE.y + 0.06, EYE.z + 0.095);
  h.push(tint(ellipsoid(hc, 0.135, 0.145, 0.155, 20, 14), 0x7f8386, 0.45, 0.05));
  const visor = new THREE.SphereGeometry(1, 20, 12, Math.PI * 0.62, Math.PI * 0.76, Math.PI * 0.28, Math.PI * 0.3);
  visor.scale(0.142, 0.152, 0.164);
  visor.translate(hc.x, hc.y, hc.z);
  h.push(tint(visor, 0x0c0c0e, 0.06, 0.4));
  h.push(tint(ellipsoid(V(0, EYE.y - 0.07, EYE.z - 0.04), 0.06, 0.065, 0.06, 12, 8), 0x2a2e25, 0.7, 0));
  h.push(tint(tube(V(0, hc.y + 0.12, hc.z - 0.1), V(0, hc.y + 0.15, hc.z + 0.02), 0.03, 0.03, 8), 0x55585a, 0.5, 0.1));
  return { body: merge(b), head: merge(h) };
}

export function buildCockpit(): CockpitBuild {
  const canopy = buildCanopy();
  const pilot = buildPilot();
  const G = GLARESHIELD;
  // HUD combiner: one glass, leaning back.
  const hud = tint(quad(0.15, 0.17, V(0, G.y + 0.115, G.z + 0.02), 0.22, 0, 0, 1, 1), 0xffffff, 0.05, 0);
  // Screens (unlit): the two MFCD faces from the top half of the screen canvas.
  const screens = merge(
    [
      quad(0.13, 0.13, panelPoint(-0.215, -0.02, 0.023), PANEL.tilt, 0, 0.5, 0.5, 1),
      quad(0.13, 0.13, panelPoint(0.215, -0.02, 0.023), PANEL.tilt, 0.5, 0.5, 1, 1),
    ].map((q) => tint(q, 0xffffff, 0.2, 0)),
  );
  // Painted panel face (lit): UFC keys, standby instruments, engine gauges, gear handle, armament panel.
  const panelFace = tint(quad(PANEL.w, PANEL.h, panelPoint(0, 0, 0.0015), PANEL.tilt, 0, 0, 1, 0.5), 0xffffff, 0.75, 0);
  return {
    canopyGlass: canopy.glass,
    canopyFrame: canopy.frame,
    interior: buildInterior(),
    pilotBody: pilot.body,
    pilotHead: pilot.head,
    hudGlass: hud,
    screens,
    panelFace,
  };
}

/** Paint the panel face into the bottom half of the screen canvas. */
function drawPanel(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const y0 = h / 2;
  const ph = h / 2;
  const sx = w / PANEL.w;
  const sy = ph / PANEL.h;
  const P = (x: number, y: number): [number, number] => [(x + PANEL.w / 2) * sx, y0 + (PANEL.h / 2 - y) * sy];
  ctx.fillStyle = '#2c3135';
  ctx.fillRect(0, y0, w, ph);
  const label = (t: string, x: number, y: number, size = 9, color = '#e4e4dc') => {
    const [a, b] = P(x, y);
    ctx.fillStyle = color;
    ctx.font = `bold ${size}px Arial, Helvetica, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t, a, b);
  };
  const rect = (x: number, y: number, ww: number, hh: number, fill: string, stroke?: string) => {
    const [a, b] = P(x - ww / 2, y + hh / 2);
    ctx.fillStyle = fill;
    ctx.fillRect(a, b, ww * sx, hh * sy);
    if (stroke) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = 2;
      ctx.strokeRect(a + 1, b + 1, ww * sx - 2, hh * sy - 2);
    }
  };
  const gauge = (x: number, y: number, r: number, needle: number, marks = 12, face = '#101113') => {
    const [a, b] = P(x, y);
    const R = r * sx;
    ctx.fillStyle = '#0a0a0b';
    ctx.beginPath();
    ctx.arc(a, b, R * 1.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = face;
    ctx.beginPath();
    ctx.arc(a, b, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#ecece4';
    ctx.lineWidth = 1.5;
    for (let k = 0; k < marks; k++) {
      const t = (k / marks) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(a + Math.cos(t) * R * 0.78, b + Math.sin(t) * R * 0.78);
      ctx.lineTo(a + Math.cos(t) * R * 0.95, b + Math.sin(t) * R * 0.95);
      ctx.stroke();
    }
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.moveTo(a, b);
    ctx.lineTo(a + Math.cos(needle) * R * 0.8, b + Math.sin(needle) * R * 0.8);
    ctx.stroke();
  };
  // Sub-panels.
  rect(-0.36, 0.02, 0.17, 0.4, '#30363a', '#454b50');
  rect(0.36, 0.02, 0.17, 0.4, '#30363a', '#454b50');
  rect(0, -0.12, 0.2, 0.2, '#30363a', '#454b50');
  // MFCD bezels with option buttons (screens are separate quads).
  for (const s of [-1, 1]) {
    rect(s * 0.215, -0.02, 0.21, 0.21, '#1c1f21');
    for (let k = 0; k < 5; k++) {
      const off = -0.06 + k * 0.03;
      for (const [bx, by] of [[off, 0.093], [off, -0.093], [0.093, off], [-0.093, off]]) rect(s * 0.215 + bx, -0.02 + by, 0.016, 0.012, '#6a6f74');
    }
  }
  // UFC: entry display window and keypad.
  rect(0, 0.15, 0.24, 0.12, '#1a1d1f');
  rect(0, 0.19, 0.16, 0.025, '#030603');
  label('UFC  STEER 3  N31 43.2', 0, 0.19, 9, '#58ec7a');
  for (let k = 0; k < 12; k++) rect(-0.075 + (k % 4) * 0.05, 0.155 - Math.floor(k / 4) * 0.025, 0.036, 0.018, '#6c7176');
  // Standby instruments (right of the UFC stack): ADI, airspeed, altimeter.
  {
    const [a, b] = P(0.03, -0.12);
    const R = 0.04 * sx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(a, b, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#3a6ea8';
    ctx.fillRect(a - R, b - R, 2 * R, R);
    ctx.fillStyle = '#6b4a2c';
    ctx.fillRect(a - R, b, 2 * R, R);
    ctx.restore();
    ctx.strokeStyle = '#f0c020';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(a - R * 0.5, b);
    ctx.lineTo(a + R * 0.5, b);
    ctx.stroke();
  }
  gauge(-0.055, -0.08, 0.026, -1.1);
  gauge(-0.055, -0.17, 0.026, 0.5, 10);
  label('STBY', 0.03, -0.065, 8);
  // Left: armament control panel strip, gear handle with the three greens, flap indicator.
  label('MASTER ARM', -0.36, 0.2, 8);
  for (let k = 0; k < 3; k++) rect(-0.4 + k * 0.04, 0.17, 0.016, 0.03, '#a8acb0');
  label('GUN/PAC', -0.36, 0.13, 8);
  rect(-0.39, -0.08, 0.05, 0.05, '#e9e9e2');
  label('LG', -0.39, -0.12, 9);
  for (let k = 0; k < 3; k++) rect(-0.34, -0.03 - k * 0.03, 0.02, 0.018, '#2ee060');
  gauge(-0.37, 0.04, 0.026, -0.6, 8);
  label('FLAPS', -0.37, 0.005, 7);
  // Right: engine instruments (ITT, core rpm, fan rpm, fuel flow — left and right engines).
  const eng = ['ITT', 'CORE', 'FAN', 'FF'];
  eng.forEach((t, k) => {
    for (const s of [0, 1]) gauge(0.335 + s * 0.052, 0.18 - k * 0.07, 0.022, 0.3 + k * 0.7 + s * 0.05, 10);
    label(t, 0.36, 0.148 - k * 0.07, 7);
  });
  gauge(0.36, -0.15, 0.032, -2.0, 12);
  label('FUEL', 0.36, -0.19, 7);
  // Caution light strip.
  for (let k = 0; k < 8; k++) rect(-0.2 + k * 0.055, -0.205, 0.045, 0.016, k === 5 ? '#6a4212' : '#1e2124');
}

/** Paint the screen canvas: MFCD pages (TAD and DSMS, colour) on top, the panel below. */
export function drawScreens(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#020402';
  ctx.fillRect(0, 0, w, h / 2);
  drawPanel(ctx, w, h);
  const s = h / 2;
  const mfcd = (x0: number, page: 'TAD' | 'DSMS') => {
    ctx.save();
    ctx.translate(x0, 0);
    ctx.fillStyle = page === 'TAD' ? '#0d1a12' : '#050805';
    ctx.fillRect(0, 0, s, s);
    ctx.font = 'bold 22px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = '#5ce07a';
    const top = page === 'TAD' ? ['CNTL', 'FILE', 'COM', 'SYS', 'TAD'] : ['INV', 'PROF', 'STAT', 'LOAD', 'DSMS'];
    top.forEach((t, k) => ctx.fillText(t, 60 + k * 98, 34));
    ['TAD', 'TGP', 'DSMS', 'MSG', 'STAT'].forEach((t, k) => ctx.fillText(t, 60 + k * 98, s - 14));
    if (page === 'TAD') {
      // Moving map: terrain tint, range rings, ownship, route, a hostile marker.
      const g = ctx.createRadialGradient(s / 2, s / 2, 20, s / 2, s / 2, s / 2);
      g.addColorStop(0, '#2f4a2c');
      g.addColorStop(1, '#1c2b1c');
      ctx.fillStyle = g;
      ctx.fillRect(40, 50, s - 80, s - 110);
      ctx.strokeStyle = 'rgba(200, 220, 200, 0.6)';
      ctx.lineWidth = 2;
      for (const r of [80, 160]) {
        ctx.beginPath();
        ctx.arc(s / 2, s - 150, r, Math.PI, 2 * Math.PI);
        ctx.stroke();
      }
      ctx.strokeStyle = '#6ad0ff';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(s / 2, s - 150);
      ctx.lineTo(s / 2 + 50, s - 280);
      ctx.lineTo(s / 2 - 30, s - 380);
      ctx.stroke();
      ctx.fillStyle = '#ff4a3a';
      ctx.beginPath();
      ctx.moveTo(s / 2 + 90, s - 330);
      ctx.lineTo(s / 2 + 104, s - 310);
      ctx.lineTo(s / 2 + 76, s - 310);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(s / 2, s - 168);
      ctx.lineTo(s / 2 - 12, s - 138);
      ctx.lineTo(s / 2 + 12, s - 138);
      ctx.fill();
    } else {
      // Stores page: a planform with the stations and the load.
      ctx.strokeStyle = '#5ce07a';
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(40, 220);
      ctx.lineTo(s - 40, 220);
      ctx.moveTo(s / 2, 120);
      ctx.lineTo(s / 2, 380);
      ctx.stroke();
      ctx.font = 'bold 20px monospace';
      ctx.fillStyle = '#e8f0e8';
      const st = ['ECM', 'TGP', '2M65', 'G12', '', '', '', 'G12', '2M65', '', '2A9'];
      st.forEach((t, k) => ctx.fillText(t, 40 + k * ((s - 80) / 10), 260 + (k % 2) * 26));
      ctx.fillStyle = '#5ce07a';
      ctx.fillText('GUN  1150  PAC', s / 2, s - 70);
    }
    ctx.restore();
  };
  mfcd(0, 'TAD');
  mfcd(w / 2, 'DSMS');
}
