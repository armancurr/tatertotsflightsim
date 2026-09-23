/**
 * F-16 canopy and cockpit: the one-piece bubble canopy (frameless in front, sill rails and an aft
 * bow), the glareshield with the HUD and its glass combiner, the upfront controls (UFC) and two
 * MFDs, side consoles with the side-stick (right) and throttle (left), the ACES II seat reclined
 * 30°, and the pilot (helmet with dark visor and mask, sage flight suit, harness, G-suit).
 * The HUD symbology is drawn by the UI as a screen overlay; the combiner here is just glass.
 */
import * as THREE from 'three';
import { loftGeometry } from '../loft';
import { tint, merge } from '../materials';
import { box, ellipsoid, tube, V } from './geom';
import { ANCHOR, CANOPY_FRONT_Z, CANOPY_REAR_Z, canopyArch, canopyAt } from './shape';

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

/** Screen canvas: left and right MFD pages (top half), the painted instrument panel (bottom half). */
export const SCREEN_ATLAS = { width: 1024, height: 1024 } as const;

function quad(w: number, h: number, c: THREE.Vector3, tiltX: number, u0: number, v0: number, u1: number, v1: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.getAttribute('uv') as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, u0 + (u1 - u0) * uv.getX(i), v0 + (v1 - v0) * uv.getY(i));
  g.rotateX(tiltX);
  g.translate(c.x, c.y, c.z);
  return g;
}

function buildCanopy(): { glass: THREE.BufferGeometry; frame: THREE.BufferGeometry } {
  const rings: number[][] = [];
  const n = 28;
  const steps = 34;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Denser at the rounded front.
    const z = CANOPY_FRONT_Z + (CANOPY_REAR_Z - CANOPY_FRONT_Z) * (1 - Math.cos((t * Math.PI) / 2)) ** 0.85;
    rings.push(canopyArch(z, n));
  }
  const glass = loftGeometry(rings, { closed: false });

  const f: THREE.BufferGeometry[] = [];
  const FRAME = 0x2c2f31;
  // Sill rails along both sides.
  for (const s of [-1, 1]) {
    let prev: THREE.Vector3 | null = null;
    for (let i = 0; i <= 16; i++) {
      const z = -6.0 + ((CANOPY_REAR_Z + 0.02 - -6.0) * i) / 16;
      const c = canopyAt(z);
      const p = V(s * (c.w - 0.004), c.sill + 0.004, z);
      if (prev) f.push(tint(tube(prev, p, 0.016, 0.016, 6), FRAME, 0.5, 0.4));
      prev = p;
    }
  }
  // Aft bow: a flat band following the arch just inside the glass, and the aft end frame.
  const bow = (z: number, width: number, inset: number) => {
    const a = canopyArch(z - width / 2, 20, inset, 0);
    const b = canopyArch(z + width / 2, 20, inset, 0);
    const c2 = canopyArch(z + width / 2, 20, inset + 0.03, 0);
    const d = canopyArch(z - width / 2, 20, inset + 0.03, 0);
    const g = loftGeometry([a, b, c2, d, a.slice()], { closed: false });
    f.push(tint(g, FRAME, 0.5, 0.3));
  };
  bow(-3.55, 0.07, 0.006);
  bow(CANOPY_REAR_Z + 0.04, 0.1, -0.004);
  return { glass, frame: merge(f) };
}

function buildInterior(): THREE.BufferGeometry {
  const g: THREE.BufferGeometry[] = [];
  const DARK = 0x2a2c2e;
  const PANEL = 0x33363a;
  const BLACK = 0x0e0f10;
  const CONSOLE = 0x3a3d40;
  // Glareshield hood over the instrument panel: an arch following the canopy, its aft lip at
  // ~14° below the eye (the F-16's over-the-nose view).
  const hoodRing = (z: number, top: number) => {
    const out: number[] = [];
    const n = 16;
    for (let k = 0; k <= n; k++) {
      const t = -1 + (2 * k) / n;
      out.push(t * 0.445, top - 0.03 * t * t - 0.05 * t ** 8, z);
    }
    for (let k = n; k >= 0; k--) {
      const t = -1 + (2 * k) / n;
      out.push(t * 0.43, top - 0.018 - 0.03 * t * t - 0.05 * t ** 8, z);
    }
    return out;
  };
  // Sloping down toward the nose so nothing rises above the ~14° sight line.
  const hood = loftGeometry([hoodRing(-5.47, 0.7), hoodRing(-5.25, 0.765), hoodRing(-5.07, 0.806), hoodRing(-5.045, 0.79)], { closed: true, capStart: true, capEnd: true });
  g.push(tint(hood, BLACK, 0.85, 0));
  // Instrument panel (slightly raked back) spanning the cockpit; its face is the painted panel quad.
  g.push(tint(box(0.9, 0.46, 0.04, V(0, 0.56, -5.13), -0.12, 0, 0), PANEL, 0.7, 0.1));
  // HUD housing on the glareshield and the thin combiner frame (glass is separate).
  g.push(tint(box(0.2, 0.08, 0.2, V(0, 0.775, -5.17)), BLACK, 0.6, 0.2));
  const hudTop = 1.0;
  const hudBot = 0.84;
  const hz = -5.03;
  for (const s of [-1, 1]) g.push(tint(box(0.008, hudTop - hudBot, 0.016, V(s * 0.086, (hudTop + hudBot) / 2, hz), 0.28, 0, 0), BLACK, 0.5, 0.3));
  g.push(tint(box(0.18, 0.012, 0.025, V(0, hudBot, hz - 0.03)), BLACK, 0.5, 0.3));
  // MFD bezels (the screens and buttons are painted / separate quads).
  for (const s of [-1, 1]) g.push(tint(box(0.17, 0.17, 0.02, V(s * 0.205, 0.55, -5.1), -0.12, 0, 0), DARK, 0.6, 0.1));
  // Side consoles running from the panel back past the seat, and the cockpit sidewalls to the sills.
  for (const s of [-1, 1]) {
    g.push(tint(box(0.19, 0.1, 1.3, V(s * 0.365, 0.385, -4.44)), CONSOLE, 0.75, 0.05));
    g.push(tint(box(0.02, 0.09, 1.9, V(s * 0.462, 0.42, -4.2)), DARK, 0.85, 0));
    // Console panel knobs and switches.
    for (let k = 0; k < 8; k++) {
      const x = s * (0.31 + (k % 3) * 0.05);
      const z = -5.0 + k * 0.13;
      g.push(tint(tube(V(x, 0.435, z), V(x, 0.452, z), 0.011, 0.011, 8), 0x1a1a1a, 0.6, 0.2));
    }
    for (let k = 0; k < 5; k++) g.push(tint(box(0.07, 0.004, 0.09, V(s * 0.37, 0.4365, -3.95 - k * 0.11 + 0.0)), 0x303336, 0.7, 0.05));
  }
  // Side-stick (right console) and throttle (left console).
  g.push(tint(box(0.07, 0.04, 0.12, V(0.34, 0.45, -4.56)), DARK, 0.6, 0.2));
  g.push(tint(tube(V(0.34, 0.465, -4.56), V(0.34, 0.53, -4.585), 0.018, 0.02, 10), BLACK, 0.6, 0.1));
  g.push(tint(ellipsoid(V(0.34, 0.57, -4.595), 0.024, 0.055, 0.03, 12, 8), 0x161616, 0.55, 0.05));
  g.push(tint(box(0.06, 0.04, 0.22, V(-0.345, 0.455, -4.46)), DARK, 0.6, 0.2));
  g.push(tint(box(0.05, 0.075, 0.08, V(-0.335, 0.505, -4.52), 0.2, 0, 0), 0x181818, 0.55, 0.05));
  // ACES II seat, reclined 30°: bucket, back, headrest / parachute container, ejection handle.
  const recline = -30 * (Math.PI / 180);
  const seatBackC = V(0, 0.72, -3.98);
  g.push(tint(box(0.4, 0.72, 0.1, seatBackC, recline, 0, 0), 0x2a2e26, 0.85, 0));
  g.push(tint(box(0.32, 0.3, 0.17, V(0, 1.05, -3.87), recline, 0, 0), 0x2e3229, 0.8, 0));
  g.push(tint(box(0.22, 0.03, 0.16, V(0, 1.155, -3.92), recline, 0, 0), 0xb8962a, 0.6, 0));
  for (const s of [-1, 1]) g.push(tint(box(0.05, 0.5, 0.5, V(s * 0.25, 0.38, -4.32)), 0x2c2f2a, 0.8, 0));
  g.push(tint(box(0.46, 0.08, 0.48, V(0, 0.3, -4.42)), 0x2c2f2a, 0.8, 0));
  g.push(tint(tube(V(-0.06, 0.36, -4.66), V(0.06, 0.36, -4.66), 0.012, 0.012, 6), 0xd8b020, 0.5, 0));
  // Rudder pedals under the panel.
  for (const s of [-1, 1]) g.push(tint(box(0.08, 0.14, 0.03, V(s * 0.13, 0.28, -5.36), -0.5, 0, 0), 0x3a3a3a, 0.6, 0.3));
  // Avionics shelf behind the seat.
  g.push(tint(box(0.62, 0.05, 1.0, V(0, 0.41, -3.25)), DARK, 0.8, 0));
  return merge(g);
}

function buildPilot(): { body: THREE.BufferGeometry; head: THREE.BufferGeometry } {
  const SUIT = 0x55594a;
  const VEST = 0x3a3c30;
  const GSUIT = 0x6a6249;
  const GLOVE = 0x2e2d2a;
  const b: THREE.BufferGeometry[] = [];
  // Torso (reclined with the seat), survival vest, shoulders.
  const hip = V(0, 0.4, -4.47);
  const neck = V(0, 0.87, -4.2);
  b.push(tint(tube(hip, neck, 0.16, 0.15, 14), SUIT, 0.9, 0));
  b.push(tint(tube(V(0, 0.56, -4.37), V(0, 0.84, -4.22), 0.175, 0.16, 14), VEST, 0.85, 0));
  for (const s of [-1, 1]) {
    const sh = V(s * 0.19, 0.8, -4.21);
    const el = V(s * 0.27, 0.57, -4.3);
    const hand = s > 0 ? V(0.34, 0.56, -4.6) : V(-0.34, 0.52, -4.53);
    b.push(tint(ellipsoid(sh, 0.075, 0.07, 0.075, 10, 8), VEST, 0.85, 0));
    b.push(tint(tube(sh, el, 0.055, 0.048, 10), SUIT, 0.9, 0));
    b.push(tint(tube(el, hand, 0.046, 0.04, 10), SUIT, 0.9, 0));
    b.push(tint(ellipsoid(hand, 0.042, 0.035, 0.05, 10, 8), GLOVE, 0.7, 0));
    // Harness straps.
    b.push(tint(tube(V(s * 0.1, 0.84, -4.23), V(s * 0.08, 0.5, -4.42), 0.022, 0.022, 6), 0x2f2f28, 0.8, 0));
    // Legs: G-suit thighs to the knees, shins to the pedals.
    const hipS = V(s * 0.1, 0.38, -4.5);
    const knee = V(s * 0.13, 0.46, -4.95);
    const foot = V(s * 0.13, 0.28, -5.33);
    b.push(tint(tube(hipS, knee, 0.085, 0.07, 10), GSUIT, 0.9, 0));
    b.push(tint(tube(knee, foot, 0.06, 0.05, 10), SUIT, 0.9, 0));
  }
  // Oxygen hose from the mask to the chest.
  b.push(tint(tube(V(0.03, 0.93, -4.43), V(0.1, 0.72, -4.36), 0.018, 0.018, 8), 0x202020, 0.7, 0));

  const h: THREE.BufferGeometry[] = [];
  // Helmet (HGU-55 grey), dark visor down, oxygen mask; the eye point is inside, behind the visor.
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
  // HUD combiner glass (two panes like the F-16's wide-angle HUD).
  const hud = merge([
    tint(quad(0.165, 0.15, V(0, 0.925, -5.03), 0.28, 0, 0, 1, 1), 0xffffff, 0.05, 0),
    tint(quad(0.15, 0.05, V(0, 1.005, -5.008), 0.28, 0, 0, 1, 1), 0xffffff, 0.05, 0),
  ]);
  // Screens (unlit): the two MFD faces, from the top half of the screen canvas.
  const screens = merge([
    quad(0.118, 0.118, V(-0.205, 0.551, -5.087), -0.12, 0, 0.5, 0.5, 1),
    quad(0.118, 0.118, V(0.205, 0.551, -5.087), -0.12, 0.5, 0.5, 1, 1),
  ].map((g) => tint(g, 0xffffff, 0.2, 0)));
  // Painted panel face (lit): bezels, UFC + DED, standby instruments, gear handle, engine gauges.
  const panelFace = tint(quad(PANEL_FACE.w, PANEL_FACE.h, V(0, PANEL_FACE.cy, -5.1085), -0.12, 0, 0, 1, 0.5), 0xffffff, 0.75, 0);
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

/** The painted instrument panel face (metres; centre height), mapped to the canvas' bottom half. */
export const PANEL_FACE = { w: 0.88, h: 0.44, cy: 0.56 } as const;

/** Paint the panel face into the bottom half of the screen canvas (w × h/2 px). */
function drawPanel(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  const y0 = h / 2;
  const ph = h / 2;
  const sx = w / PANEL_FACE.w;
  const sy = ph / PANEL_FACE.h;
  // Panel coordinates (x right, y up, metres, origin at the panel centre) → canvas px.
  const P = (x: number, y: number): [number, number] => [(x + PANEL_FACE.w / 2) * sx, y0 + (PANEL_FACE.h / 2 - y) * sy];
  ctx.fillStyle = '#26292c';
  ctx.fillRect(0, y0, w, ph);
  // Sub-panels with lighter borders and screws.
  const sub = (x: number, y: number, ww: number, hh: number) => {
    const [a, b] = P(x - ww / 2, y + hh / 2);
    ctx.fillStyle = '#2c2f33';
    ctx.fillRect(a, b, ww * sx, hh * sy);
    ctx.strokeStyle = '#3d4145';
    ctx.lineWidth = 2;
    ctx.strokeRect(a + 1, b + 1, ww * sx - 2, hh * sy - 2);
    ctx.fillStyle = '#50545a';
    for (const [dx, dy] of [[4, 4], [ww * sx - 6, 4], [4, hh * sy - 6], [ww * sx - 6, hh * sy - 6]]) ctx.fillRect(a + dx, b + dy, 2.5, 2.5);
  };
  const label = (t: string, x: number, y: number, size = 9, color = '#d8d8d0') => {
    const [a, b] = P(x, y);
    ctx.fillStyle = color;
    ctx.font = `bold ${size}px Arial, Helvetica, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(t, a, b);
  };
  const gauge = (x: number, y: number, r: number, face: string, needle: number, marks = 12) => {
    const [a, b] = P(x, y);
    const R = r * sx;
    ctx.fillStyle = '#0c0c0d';
    ctx.beginPath();
    ctx.arc(a, b, R * 1.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = face;
    ctx.beginPath();
    ctx.arc(a, b, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#e8e8e0';
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
  sub(-0.36, 0.08, 0.15, 0.3);
  sub(0.36, 0.08, 0.15, 0.3);
  sub(0, -0.05, 0.22, 0.2);
  // MFD bezels with their 20 option-select buttons.
  for (const s of [-1, 1]) {
    const [a, b] = P(s * 0.205 - 0.085, -0.01 + 0.085);
    ctx.fillStyle = '#1c1e20';
    ctx.fillRect(a, b, 0.17 * sx, 0.17 * sy);
    ctx.fillStyle = '#5d6166';
    for (let k = 0; k < 5; k++) {
      const off = -0.056 + k * 0.028;
      for (const [bx, by] of [[off, 0.074], [off, -0.074], [0.074, off], [-0.074, off]]) {
        const [c, d] = P(s * 0.205 + bx - 0.007, -0.01 + by + 0.005);
        ctx.fillRect(c, d, 0.014 * sx, 0.01 * sy);
      }
    }
  }
  // UFC: DED window (green text), keypad, ICP buttons.
  {
    const [a, b] = P(-0.1, 0.17);
    ctx.fillStyle = '#1a1c1e';
    ctx.fillRect(a, b, 0.2 * sx, 0.13 * sy);
    const [da, db] = P(-0.065, 0.165);
    ctx.fillStyle = '#020502';
    ctx.fillRect(da, db, 0.13 * sx, 0.036 * sy);
    ctx.fillStyle = '#46e06a';
    ctx.font = 'bold 9px monospace';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ['UHF 305.00   STPT  1', 'VHF  1     14:32:07', '  M3 4000  C MS   L'].forEach((t, k) => ctx.fillText(t, da + 4, db + 3 + k * 12));
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'RCL', '0', 'ENTR'];
    keys.forEach((t, k) => {
      const [ka, kb] = P(-0.085 + (k % 3) * 0.03, 0.12 - Math.floor(k / 3) * 0.02);
      ctx.fillStyle = '#6a6e72';
      ctx.fillRect(ka, kb, 0.024 * sx, 0.016 * sy);
      ctx.fillStyle = '#101010';
      ctx.font = 'bold 8px Arial, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(t, ka + 0.012 * sx, kb + 0.008 * sy);
    });
    ['COM1', 'COM2', 'IFF', 'LIST', 'A-A', 'A-G'].forEach((t, k) => {
      const [ka, kb] = P(0.012 + (k % 2) * 0.04, 0.12 - Math.floor(k / 2) * 0.025);
      ctx.fillStyle = '#6a6e72';
      ctx.fillRect(ka, kb, 0.034 * sx, 0.018 * sy);
      ctx.fillStyle = '#101010';
      ctx.fillText(t, ka + 0.017 * sx, kb + 0.009 * sy);
    });
  }
  // Standby instruments below the UFC: ADI (sky/ground ball), airspeed, altimeter, VVI.
  {
    const [a, b] = P(0, -0.02);
    const R = 0.038 * sx;
    ctx.save();
    ctx.beginPath();
    ctx.arc(a, b, R, 0, Math.PI * 2);
    ctx.clip();
    ctx.fillStyle = '#3a6ea8';
    ctx.fillRect(a - R, b - R, 2 * R, R);
    ctx.fillStyle = '#6b4a2c';
    ctx.fillRect(a - R, b, 2 * R, R);
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(a - R, b);
    ctx.lineTo(a + R, b);
    ctx.stroke();
    ctx.restore();
    ctx.strokeStyle = '#f0c020';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(a - R * 0.5, b);
    ctx.lineTo(a - R * 0.15, b);
    ctx.moveTo(a + R * 0.15, b);
    ctx.lineTo(a + R * 0.5, b);
    ctx.stroke();
  }
  gauge(-0.06, -0.115, 0.025, '#111214', -1.2);
  gauge(0.06, -0.115, 0.025, '#111214', 0.4, 10);
  gauge(0, -0.18, 0.02, '#111214', Math.PI);
  label('STBY', 0, 0.028, 8);
  // Left: MASTER CAUTION, landing-gear handle with its three green lights, master arm.
  {
    const [a, b] = P(-0.4, 0.19);
    ctx.fillStyle = '#e0a020';
    ctx.fillRect(a, b, 0.06 * sx, 0.025 * sy);
    label('MASTER', -0.37, 0.18, 7, '#1a1a1a');
    label('CAUTION', -0.37, 0.171, 7, '#1a1a1a');
    const [ga, gb] = P(-0.37, 0.0);
    ctx.fillStyle = '#e9e9e2';
    ctx.beginPath();
    ctx.arc(ga, gb, 0.022 * sx, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#b8231c';
    ctx.beginPath();
    ctx.arc(ga, gb, 0.008 * sx, 0, Math.PI * 2);
    ctx.fill();
    label('LG', -0.37, -0.04, 9);
    for (let k = 0; k < 3; k++) {
      const [la, lb] = P(-0.4 + k * 0.03, 0.07);
      ctx.fillStyle = '#2ee060';
      ctx.fillRect(la, lb, 0.018 * sx, 0.014 * sy);
    }
    label('MASTER ARM', -0.37, -0.1, 7);
    const [sa, sb] = P(-0.375, -0.12);
    ctx.fillStyle = '#9a9ea2';
    ctx.fillRect(sa, sb, 0.01 * sx, 0.03 * sy);
  }
  // Right: engine instruments (RPM, FTIT, nozzle position, oil) and fuel quantity.
  const eng: [string, number, number][] = [['RPM', 0.16, 0.6], ['FTIT', 0.1, 1.4], ['NOZ POS', 0.04, -0.6], ['OIL', -0.02, 2.4]];
  eng.forEach(([t, y, n], k) => {
    gauge(0.345 + (k % 2) * 0.05, y, 0.021, '#101113', n, 10);
    label(t, 0.345 + (k % 2) * 0.05, y - 0.03, 7);
  });
  gauge(0.37, -0.12, 0.034, '#101113', -2.2, 12);
  label('FUEL QTY', 0.37, -0.165, 7);
  // Warning-light strip across the bottom.
  for (let k = 0; k < 10; k++) {
    const [a, b] = P(-0.25 + k * 0.05, -0.2);
    ctx.fillStyle = k === 3 ? '#704010' : '#1e2124';
    ctx.fillRect(a, b, 0.04 * sx, 0.014 * sy);
  }
}

/** Paint the screen canvas: MFD pages (FCR and HSD, green monochrome) on top, the panel below. */
export function drawScreens(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#020402';
  ctx.fillRect(0, 0, w, h / 2);
  drawPanel(ctx, w, h);
  const g = (a: number) => `rgba(60, 235, 110, ${a})`;
  const mfd = (x0: number, page: 'FCR' | 'HSD') => {
    const s = h / 2;
    ctx.save();
    ctx.translate(x0, 0);
    ctx.fillStyle = '#031006';
    ctx.fillRect(0, 0, s, s);
    ctx.strokeStyle = g(0.8);
    ctx.fillStyle = g(0.9);
    ctx.lineWidth = 3;
    ctx.font = 'bold 26px monospace';
    ctx.textAlign = 'center';
    const labels = page === 'FCR' ? ['CRM', 'RWS', 'NORM', 'OVRD', 'CNTL'] : ['DEP', 'DCPL', 'NORM', '', 'CNTL'];
    labels.forEach((t, k) => ctx.fillText(t, 70 + k * 93, 36));
    ['SWAP', 'FCR', 'HSD', 'SMS', 'DCLT'].forEach((t, k) => ctx.fillText(t, 70 + k * 93, s - 16));
    if (page === 'FCR') {
      // B-scope: range ticks, cursor, a couple of contacts.
      ctx.strokeRect(60, 60, s - 120, s - 130);
      for (let k = 1; k < 4; k++) {
        ctx.beginPath();
        ctx.moveTo(60, 60 + ((s - 130) * k) / 4);
        ctx.lineTo(80, 60 + ((s - 130) * k) / 4);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(s / 2 - 16, 250);
      ctx.lineTo(s / 2 - 16, 280);
      ctx.moveTo(s / 2 + 16, 250);
      ctx.lineTo(s / 2 + 16, 280);
      ctx.stroke();
      ctx.fillRect(170, 160, 16, 10);
      ctx.fillRect(330, 210, 16, 10);
      ctx.font = 'bold 24px monospace';
      ctx.fillText('40', 40, 72);
    } else {
      // HSD: ownship at the bottom centre, range rings, steerpoint route.
      ctx.beginPath();
      ctx.arc(s / 2, s - 110, 150, Math.PI, 2 * Math.PI);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(s / 2, s - 110, 300, Math.PI * 1.15, Math.PI * 1.85);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(s / 2, s - 110);
      ctx.lineTo(s / 2 + 60, s - 250);
      ctx.lineTo(s / 2 - 40, s - 360);
      ctx.lineTo(s / 2 + 90, s - 420);
      ctx.stroke();
      for (const [x, y] of [[s / 2 + 60, s - 250], [s / 2 - 40, s - 360], [s / 2 + 90, s - 420]]) ctx.strokeRect(x - 8, y - 8, 16, 16);
      ctx.fillStyle = g(1);
      ctx.beginPath();
      ctx.moveTo(s / 2, s - 125);
      ctx.lineTo(s / 2 - 12, s - 95);
      ctx.lineTo(s / 2 + 12, s - 95);
      ctx.fill();
    }
    ctx.restore();
  };
  mfd(0, 'FCR');
  mfd(w / 2, 'HSD');
}
