/**
 * The 172RG instrument panel: where the face sits in the cabin, and where every instrument,
 * radio and control sits on it — all in body-frame metres, at real sizes (3⅛" flight
 * instruments, 2¼" clock/suction, a 6¼"-wide avionics stack). The texture (panelFace.ts) and
 * the 3D controls (cockpit.ts) both read this layout, so the knobs, the gear handle and the
 * yoke shafts always come through the right holes.
 *
 * The canvas maps onto the physical panel face: x 0..width spans body x −widthM/2..+widthM/2
 * (left to right as the pilot sees it), y 0..height spans the panel top (y = topY) down to its
 * bottom, at PX_PER_M in both directions.
 */

/** Texture resolution: pixels per metre of panel (a 3⅛" gauge is ~160 px). */
export const PX_PER_M = 2000;

export const PANEL = {
  /** Physical face (m) and placement in the body frame. */
  widthM: 1.02,
  heightM: 0.3825,
  centerY: 0.25125,
  z: -0.7,
  /** Canvas pixels (PX_PER_M × the face). */
  width: 2040,
  height: 765,
  get topY() {
    return this.centerY + this.heightM / 2;
  },
} as const;

/** Panel bottom edge (body y). */
export const PANEL_BOTTOM_Y = PANEL.centerY - PANEL.heightM / 2;

/** Body-frame (x, y) on the panel face → canvas pixel. */
export function panelPx(x: number, y: number): { x: number; y: number } {
  return {
    x: ((x + PANEL.widthM / 2) / PANEL.widthM) * PANEL.width,
    y: ((PANEL.topY - y) / PANEL.heightM) * PANEL.height,
  };
}

/** A round instrument: centre (body x, y) and case diameter (m). */
export interface GaugeSpot {
  x: number;
  y: number;
  d: number;
}
/** A rectangle on the face: left, top (body y of the top edge), width, height (m). */
export interface RectSpot {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 3⅛" flight instruments (case ≈ 82 mm) and the 2¼" small gauges (≈ 58 mm). */
const G3 = 0.082;
const G2 = 0.058;
const SIX_X = [-0.368, -0.28, -0.192] as const;
const SIX_Y = [0.378, 0.29] as const;

/**
 * Real 1980s Cessna 172RG layout from the left seat: the six-pack centred on the pilot's eye
 * (x = −0.28), clock/suction/ammeter to its left, the two nav heads to its right, the avionics
 * stack left of centre-line, manifold pressure/fuel flow and tachometer right of the stack with
 * the EGT under them, the gear handle and its two lights right of the stack, the push-pull
 * throttle/prop/mixture under the stack, the flap lever low right, circuit breakers and the
 * glovebox on the right, rocker switches and the key low left, the engine cluster under the
 * six-pack.
 */
export const PANEL_LAYOUT = {
  airspeed: { x: SIX_X[0], y: SIX_Y[0], d: G3 },
  attitude: { x: SIX_X[1], y: SIX_Y[0], d: G3 },
  altimeter: { x: SIX_X[2], y: SIX_Y[0], d: G3 },
  turn: { x: SIX_X[0], y: SIX_Y[1], d: G3 },
  heading: { x: SIX_X[1], y: SIX_Y[1], d: G3 },
  vsi: { x: SIX_X[2], y: SIX_Y[1], d: G3 },
  clock: { x: -0.458, y: 0.392, d: G2 },
  suction: { x: -0.458, y: 0.327, d: G2 * 0.9 },
  ammeter: { x: -0.458, y: 0.268, d: G2 * 0.9 },
  nav1: { x: -0.1, y: SIX_Y[0], d: G3 },
  nav2: { x: -0.1, y: SIX_Y[1], d: G3 },
  manifold: { x: 0.172, y: SIX_Y[0], d: G3 },
  tach: { x: 0.262, y: SIX_Y[0], d: G3 },
  egt: { x: 0.172, y: 0.3, d: G2 },
  /** Avionics stack (6¼" wide) from the top: audio panel, GNS 430, NAV/COM, transponder. */
  stack: { x: -0.045, y: 0.43, w: 0.159, h: 0.226 },
  audio: { x: -0.045, y: 0.428, w: 0.159, h: 0.026 },
  gps: { x: -0.045, y: 0.4, w: 0.159, h: 0.117 },
  navcom: { x: -0.045, y: 0.281, w: 0.159, h: 0.035 },
  xpdr: { x: -0.045, y: 0.244, w: 0.159, h: 0.04 },
  /** Engine cluster: five small dual-scale gauges in a row under the six-pack. */
  engineCluster: { x: -0.47, y: 0.243, w: 0.37, h: 0.036 },
  /** Rocker switch row (split master first) and the magneto/start key. */
  switches: { x: -0.492, y: 0.19, w: 0.15, h: 0.05 },
  magneto: { x: -0.2, y: 0.17, d: 0.036 },
  /** Push-pull engine controls under the stack: throttle (black), prop (blue), mixture (red). */
  throttle: { x: -0.012, y: 0.115 },
  prop: { x: 0.04, y: 0.115 },
  mixture: { x: 0.092, y: 0.115 },
  /** Gear handle slot (top y, bottom y) and its two lights (amber GEAR UP above, green GEAR DOWN below). */
  gearHandle: { x: 0.14, top: 0.235, bottom: 0.15 },
  gearLightUp: { x: 0.18, y: 0.224 },
  gearLightDown: { x: 0.18, y: 0.196 },
  /** Flap lever slot (UP at the top … FULL at the bottom) and the little position indicator beside it. */
  flapLever: { x: 0.21, top: 0.15, bottom: 0.085 },
  flapIndicator: { x: 0.226, y: 0.152, w: 0.018, h: 0.07 },
  yokeShafts: [
    { x: -0.28, y: 0.18 },
    { x: 0.28, y: 0.18 },
  ],
  breakers: { x: 0.33, y: 0.262, w: 0.165, h: 0.06 },
  glovebox: { x: 0.325, y: 0.19, w: 0.175, h: 0.115 },
  /** Upper right: hour meter, operating-limitations placard, cabin heat/air knobs. */
  rightUpper: { x: 0.325, y: 0.43, w: 0.175, h: 0.16 },
} as const;

/** Every round instrument drawn on the face (for layout checks). */
export const PANEL_GAUGES: ReadonlyArray<[string, GaugeSpot]> = (
  ['airspeed', 'attitude', 'altimeter', 'turn', 'heading', 'vsi', 'clock', 'suction', 'ammeter', 'nav1', 'nav2', 'manifold', 'tach', 'egt'] as const
).map((k) => [k, PANEL_LAYOUT[k]]);
