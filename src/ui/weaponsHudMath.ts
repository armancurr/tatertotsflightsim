/**
 * Pure maths and wording for the weapons HUD (no DOM, no three.js): projecting world points with a
 * camera's matrices, clamping off-screen symbols to the display edge, the gun line, bearings to the
 * target range, the CCIP pipper's range arc, the Maverick lock-box states, the stores texts and
 * which symbols an aircraft gets. Everything is NaN-safe; the per-frame helpers write into an `out`
 * object so the HUD never allocates in its frame loop.
 */
import { CONFIG, type Config, type WeaponsConfig } from '../config';
import type { WeaponsStatus } from '../combat/types';
import type { Vec3 } from '../types';

const DEG = Math.PI / 180;
const BIG = 1e6;

const fin = (x: number): boolean => typeof x === 'number' && Number.isFinite(x);
const size = (s: number): number => (fin(s) && s > 0 ? Math.min(s, 1e5) : 0);
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

/** A projected point in CSS px (y down). */
export interface ScreenPt {
  x: number;
  y: number;
  /** In front of the camera. */
  inFront: boolean;
  /** In front and inside the viewport. */
  onScreen: boolean;
  /** Distance along the view direction, m (0 when behind). */
  depth: number;
  /** Set by clampToRect: the point was moved onto the edge. */
  clamped: boolean;
}

export function createScreenPt(): ScreenPt {
  return { x: 0, y: 0, inFront: false, onScreen: false, depth: 0, clamped: false };
}

/**
 * Project world (x, y, z) with a camera's view (matrixWorldInverse) and projection matrices
 * (column-major, three.js `elements`) onto a w×h viewport. Only the x, y and w rows of the
 * projection are used, so reversed-depth matrices work. A point behind the camera is placed far
 * off-screen in the direction the viewer would have to turn (for edge arrows / clamping).
 */
export function projectPoint(out: ScreenPt, x: number, y: number, z: number, view: ArrayLike<number>, proj: ArrayLike<number>, w: number, h: number): ScreenPt {
  const W = size(w);
  const H = size(h);
  out.clamped = false;
  const e = view;
  const vx = e[0] * x + e[4] * y + e[8] * z + e[12];
  const vy = e[1] * x + e[5] * y + e[9] * z + e[13];
  const vz = e[2] * x + e[6] * y + e[10] * z + e[14];
  const p = proj;
  const cx = p[0] * vx + p[4] * vy + p[8] * vz + p[12];
  const cy = p[1] * vx + p[5] * vy + p[9] * vz + p[13];
  const cw = p[3] * vx + p[7] * vy + p[11] * vz + p[15];
  if (!(fin(cx) && fin(cy) && fin(cw)) || !W || !H) {
    out.x = W / 2;
    out.y = H / 2;
    out.inFront = false;
    out.onScreen = false;
    out.depth = 0;
    return out;
  }
  let nx: number;
  let ny: number;
  if (cw > 1e-6) {
    nx = clamp(cx / cw, -BIG, BIG);
    ny = clamp(cy / cw, -BIG, BIG);
    out.inFront = true;
    out.depth = fin(vz) ? Math.max(0, -vz) : 0;
  } else {
    // Behind (or in the camera plane): push it far out along its view-space direction.
    const len = Math.hypot(cx, cy);
    if (len > 1e-9) {
      nx = (cx / len) * 1e4;
      ny = (cy / len) * 1e4;
    } else {
      nx = 0;
      ny = -1e4;
    }
    out.inFront = false;
    out.depth = 0;
  }
  out.x = ((nx + 1) / 2) * W;
  out.y = ((1 - ny) / 2) * H;
  out.onScreen = out.inFront && out.x >= 0 && out.x <= W && out.y >= 0 && out.y <= H;
  return out;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Keep (x, y) inside `rect` shrunk by `inset`: an outside point moves onto the edge along the line
 * from the rect's centre (so it still points the right way); `out.clamped` says so.
 */
export function clampToRect(out: ScreenPt, x: number, y: number, rect: Rect, inset = 0): ScreenPt {
  const rw = size(rect.w);
  const rh = size(rect.h);
  const rx = fin(rect.x) ? rect.x : 0;
  const ry = fin(rect.y) ? rect.y : 0;
  const cx = rx + rw / 2;
  const cy = ry + rh / 2;
  const hw = Math.max(0, rw / 2 - Math.max(0, fin(inset) ? inset : 0));
  const hh = Math.max(0, rh / 2 - Math.max(0, fin(inset) ? inset : 0));
  if (!fin(x) || !fin(y)) {
    out.x = cx;
    out.y = cy;
    out.clamped = true;
    return out;
  }
  const dx = x - cx;
  const dy = y - cy;
  if (Math.abs(dx) <= hw && Math.abs(dy) <= hh) {
    out.x = x;
    out.y = y;
    out.clamped = false;
    return out;
  }
  const tx = Math.abs(dx) > 1e-12 ? hw / Math.abs(dx) : Infinity;
  const ty = Math.abs(dy) > 1e-12 ? hh / Math.abs(dy) : Infinity;
  const t = Math.min(tx, ty, 1);
  out.x = cx + dx * t;
  out.y = cy + dy * t;
  out.clamped = true;
  return out;
}

/** Gun line in the world: body −Z depressed `downDeg` below the datum, rotated by the aircraft (body → world). */
export function gunLineDir(out: Vec3, qx: number, qy: number, qz: number, qw: number, downDeg: number): Vec3 {
  const d = (fin(downDeg) ? downDeg : 0) * DEG;
  const vx = 0;
  const vy = -Math.sin(d);
  const vz = -Math.cos(d);
  // v' = v + 2w(q × v) + 2 q × (q × v)
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  out.x = vx + qw * tx + (qy * tz - qz * ty);
  out.y = vy + qw * ty + (qz * tx - qx * tz);
  out.z = vz + qw * tz + (qx * ty - qy * tx);
  if (!(fin(out.x) && fin(out.y) && fin(out.z))) {
    out.x = 0;
    out.y = vy;
    out.z = vz;
  }
  return out;
}

const wrap360 = (d: number): number => {
  const r = ((d % 360) + 360) % 360;
  return r >= 360 ? 0 : r;
};

/** Bearing from (fx, fz) to (tx, tz), deg clockwise from north (world −Z), 0..360. */
export function bearingDeg(fx: number, fz: number, tx: number, tz: number): number {
  const b = Math.atan2(tx - fx, -(tz - fz)) / DEG;
  return fin(b) ? wrap360(b) : 0;
}

/** Bearing relative to the heading, −180..180 (+ = to the right). */
export function relativeBearingDeg(bearing: number, heading: number): number {
  const d = (fin(bearing) ? bearing : 0) - (fin(heading) ? heading : 0);
  const a = wrap360(d);
  return a > 180 ? a - 360 : a;
}

/** Share of the pipper's range arc that is drawn: slant range / full-arc range, 0..1. */
export function pipperArcFraction(rangeM: number, fullM: number): number {
  if (!fin(rangeM) || !fin(fullM) || fullM <= 0 || rangeM <= 0) return 0;
  return Math.min(1, rangeM / fullM);
}

export interface LockBox {
  show: boolean;
  /** LOCK: a solid box (tracking: gates + a partial outline). */
  solid: boolean;
  /** 0..1 of the outline drawn (the lock progress). */
  fill: number;
}

/** How the Maverick's box on the target looks for this lock state. */
export function lockBox(lock: WeaponsStatus['lock'], out: LockBox = { show: false, solid: false, fill: 0 }): LockBox {
  const has = lock.targetId !== null && lock.targetId !== undefined;
  if (lock.state === 'locked' && has) {
    out.show = true;
    out.solid = true;
    out.fill = 1;
  } else if (lock.state === 'tracking' && has) {
    out.show = true;
    out.solid = false;
    out.fill = fin(lock.progress) ? clamp(lock.progress, 0, 1) : 0;
  } else {
    out.show = false;
    out.solid = false;
    out.fill = 0;
  }
  return out;
}

const NM = 1852;
const FT = 0.3048;

/** Slant range as the A-10C HUD shows it: "2.4 NM" from 1 NM, else feet to 10 ft ("3280 FT"). */
export function formatSlantRange(m: number): string {
  if (!fin(m) || m < 0) return '---';
  if (m >= NM) return `${(m / NM).toFixed(1)} NM`;
  return `${Math.round(m / FT / 10) * 10} FT`;
}

/** "7.2 km". */
export function formatKm(m: number): string {
  if (!fin(m) || m < 0) return '--- km';
  return `${(m / 1000).toFixed(1)} km`;
}

type HudWeaponsConfig = Config['hud']['weapons'];

/** Ammunition label for a gun ("CM" = combat mix for the GAU-8), by name prefix. */
export function ammoLabel(gunName: string, hud: HudWeaponsConfig = CONFIG.hud.weapons): string {
  for (const [prefix, label] of Object.entries(hud.ammoLabels)) if (String(gunName).startsWith(prefix)) return label;
  return '';
}

/** "GUN 1150 CM". */
export function gunAmmoText(rounds: number, label: string): string {
  const n = fin(rounds) ? Math.max(0, Math.round(rounds)) : 0;
  return label ? `GUN ${n} ${label}` : `GUN ${n}`;
}

/** "AGM-65D Maverick" → "65D". */
export function missileShortName(name: string): string {
  const m = /AGM-(\d+[A-Z]?)/.exec(String(name));
  return m ? m[1] : String(name).split(' ')[0] || 'MSL';
}

/** "65D ×4". */
export function missileStoresText(name: string, count: number): string {
  return `${missileShortName(name)} ×${fin(count) ? Math.max(0, Math.round(count)) : 0}`;
}

/** "GAU-8/A Avenger" → "GAU-8", "M61A1 Vulcan" → "M61A1" (kill toasts). */
export function gunShortName(name: string): string {
  return String(name).split(/[\s/]/)[0] || 'GUN';
}

/** "AGM-65D Maverick" → "AGM-65D" (kill toasts). */
export function missileLongName(name: string): string {
  return String(name).split(' ')[0] || 'MISSILE';
}

export interface WeaponsVisibility {
  /** The aircraft carries anything: the weapons HUD is up. */
  any: boolean;
  gun: boolean;
  missiles: boolean;
  rangeCue: boolean;
  markers: boolean;
}

/** Which weapon symbols an aircraft gets (the Cessna: none). */
export function weaponsVisibility(weapons: WeaponsConfig | null | undefined, hud: HudWeaponsConfig = CONFIG.hud.weapons, out?: WeaponsVisibility): WeaponsVisibility {
  const o = out ?? { any: false, gun: false, missiles: false, rangeCue: false, markers: false };
  o.gun = !!weapons?.gun;
  o.missiles = !!weapons?.missiles;
  o.any = o.gun || o.missiles;
  o.rangeCue = o.any;
  o.markers = o.any && !!hud.targetMarkers;
  return o;
}
