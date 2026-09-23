/**
 * The A-10C / F-16C weapons HUD — the real A-10C symbology, simplified — drawn on a transparent
 * full-viewport canvas in the jet HUD's phosphor green (with the same faint dark halo):
 *
 *  - gun cross on the gun line (the GAU-8 points 2° below the fuselage datum);
 *  - gun CCIP pipper: circle + centre dot on the projected impact point, with a range arc that is
 *    full at 4,000 ft and unwinds as the slant range closes, and "IN RNG" inside 4,000 ft;
 *    clamped to the HUD's edge (dashed, dimmed) when the impact point is outside it;
 *  - Maverick: the target-selection circle (T picks the vehicle nearest the nose inside it), a
 *    box on the target whose outline fills with the lock progress, then a solid box + flashing
 *    LOCK, the target type, its slant range (NM, feet inside 1 NM) and "IN RNG";
 *  - hollow diamonds over live vehicles within ~6 km (a targeting-pod cue);
 *  - the range cue: a caret on the heading tape toward the target range + "RANGE 7.2 km", and a
 *    steerpoint on the ground there;
 *  - stores block bottom-left of the HUD: "GUN 1150 CM" ("GUN 0" flashes), "65D ×4", "9M ×2", "KILLS 2";
 *  - gun lead pipper on a locked aircraft: where to put the gun cross so the rounds meet it
 *    (constant-velocity lead from the muzzle velocity, drag and drop — src/combat/air/lead.ts);
 *  - short messages ("NO LOCK", "RIFLE", "LOCK LOST").
 *
 * World points are projected with the real camera, so the symbols sit on the ground and on the
 * target in every camera view (in the cockpit they are held inside the jet HUD's box, like the
 * real HUD's field of view). `updateWeaponsHud` fills a preallocated model (no allocations except
 * a text string when its number changes); `drawWeaponsHud` draws it and never throws or emits NaN.
 * The Maverick seeker picture's overlay (crosshair, track gates, LOCK) is `drawSeekerOverlay`.
 */
import { CONFIG, type Config, type TargetClassConfig, type WeaponsConfig } from '../config';
import type { CombatStats, GroundTarget, RangeInfo, TargetKind, WeaponsStatus } from '../combat/types';
import { emptyWeaponsStatus } from '../combat/world';
import type { Vec3 } from '../types';
import { jetHeadingTape, jetHudCompact, jetHudOmitsGunCross } from './jetHud';
import { hudGlassToBox, type HudGlass } from './hudGlass';
import { gunLead, newLead } from '../combat/air/lead';
import { createPlaced, JET_KEEP_OUT_MAX, jetHudKeepOut, lineRect, placeOptions, TextPlacer, type Box, type FixedSpot, type LineSpec, type Placed } from './weaponsHudLayout';
import {
  ammoLabel, bearingDeg, clampToRect, createScreenPt, formatKm, formatSlantRange, gunAmmoText, gunLineDir, lockBox, missileStoresText,
  pipperArcFraction, projectPoint, relativeBearingDeg, weaponsVisibility, type LockBox, type Rect, type WeaponsVisibility,
} from './weaponsHudMath';

export type { Rect } from './weaponsHudMath';

const DEG = Math.PI / 180;
const FONT = '"SF Mono", ui-monospace, Menlo, Consolas, "DejaVu Sans Mono", monospace';
const fonts = new Map<number, string>();
/** "700 13.5px <mono>" — cached, so drawing does not build a string per text. */
function fontOf(weight: number, px: number): string {
  const key = weight * 10000 + Math.round(px * 10);
  let f = fonts.get(key);
  if (f === undefined) {
    f = `${weight} ${(Math.round(px * 10) / 10).toFixed(1)}px ${FONT}`;
    if (fonts.size < 512) fonts.set(key, f);
  }
  return f;
}
const fin = (x: number): boolean => typeof x === 'number' && Number.isFinite(x);
const num = (x: number, d = 0): number => (fin(x) ? x : d);
const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);
const size = (s: number): number => (fin(s) && s > 0 ? Math.min(s, 1e5) : 0);

// ─── Inputs ──────────────────────────────────────────────────────────────────

/** Everything the HUD reads in a frame (one persistent object, mutated by the system). */
export interface WeaponsHudFrame {
  /** Viewport, CSS px. */
  w: number;
  h: number;
  /** Camera matrixWorldInverse and projectionMatrix elements (column-major). */
  view: ArrayLike<number>;
  proj: ArrayLike<number>;
  /** Not the cockpit view (chase, fly-by, orbit). */
  exterior: boolean;
  /** The jet HUD's box (viewport px), or null. */
  hudBox: Rect | null;
  gearUp: boolean;
  /** Aircraft position (CG) and orientation (body → world), true heading. */
  ax: number;
  ay: number;
  az: number;
  qx: number;
  qy: number;
  qz: number;
  qw: number;
  headingDeg: number;
  /** The jet HUD's conditional cues (SPD BRK; AB or ENG OFF), when known — the text layout keeps their room otherwise. */
  speedBrake?: boolean;
  abOrEngine?: boolean;
  /** Aircraft velocity, world m/s (the gun lead). */
  vx?: number;
  vy?: number;
  vz?: number;
  /** What the aircraft carries (its fleet config). */
  weapons: WeaponsConfig | null;
  status: WeaponsStatus;
  kills: number;
  targets: readonly GroundTarget[];
  classOf(kind: TargetKind): TargetClassConfig;
  range: RangeInfo | null;
  /** Ground height at the range centre, m. */
  rangeGroundY: number;
  /** Clock, s (flashing). */
  time: number;
  /** The Maverick seeker is up (tracking/locked, or just after T): draw its circle. */
  seekerActive: boolean;
  /** A short message and when it goes, s ('' = none). */
  message: string;
  messageUntil: number;
  /**
   * Cockpit view with a HUD combiner: the glass' projection (src/ui/hudGlass.ts). Everything is
   * then laid out in the glass' HUD box and drawn clipped to the glass; not visible → nothing drawn.
   */
  glass?: HudGlass | null;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

export function createWeaponsHudFrame(): WeaponsHudFrame {
  return {
    w: 0, h: 0, view: IDENTITY, proj: IDENTITY, exterior: true, hudBox: null, gearUp: true,
    ax: 0, ay: 0, az: 0, qx: 0, qy: 0, qz: 0, qw: 1, headingDeg: 0,
    weapons: null, status: emptyWeaponsStatus(), kills: 0, targets: [],
    classOf: (k) => CONFIG.combat.targets[k], range: null, rangeGroundY: 0, time: 0, seekerActive: false,
    message: '', messageUntil: 0, glass: null,
  };
}

// ─── Model ───────────────────────────────────────────────────────────────────

export interface WeaponsHudModel {
  show: boolean;
  w: number;
  h: number;
  vis: WeaponsVisibility;
  /** Where clamped symbols are held (the HUD box in the cockpit, else the viewport less a margin). */
  display: Rect;
  /** Text size and line width, px. */
  font: number;
  lw: number;
  gunCross: { show: boolean; x: number; y: number };
  pipper: { show: boolean; x: number; y: number; r: number; clamped: boolean; arc: number; inRange: boolean };
  /** Gun lead pipper on a locked aircraft. */
  lead: { show: boolean; x: number; y: number; r: number; clamped: boolean; inRange: boolean; rangeM: number };
  seekerCircle: { show: boolean; x: number; y: number; r: number };
  lock: {
    show: boolean; solid: boolean; fill: number; x: number; y: number; half: number; clamped: boolean; flashOn: boolean;
    type: string; range: string; inRange: boolean;
  };
  /** x, y pairs of the target markers. */
  markers: Float32Array;
  markerCount: number;
  rangeCue: {
    show: boolean; text: string; distanceM: number;
    tapeShow: boolean; tapeX: number; tapeY: number; tapeDir: -1 | 0 | 1; tapeUp: boolean;
    steerShow: boolean; steerX: number; steerY: number;
  };
  /** Stores block (left, bottom row at y) and the right edge of that row (range text). */
  stores: { x: number; y: number; right: number; gun: string; gunShow: boolean; gunEmpty: boolean; msl: string; mslShow: boolean; aam: string; aamShow: boolean; kills: string };
  msg: { show: boolean; text: string; x: number; y: number };
  flashOn: boolean;
  /** On the combiner glass: positions are HUD-box px, drawn through `xform` and clipped to `quad` (viewport px). */
  glassOn: boolean;
  xform: Float64Array;
  quad: Float64Array;
  glassBox: Rect;
  /** Text caches (a string is rebuilt only when its number changes). */
  cache: { rounds: number; label: string; gunName: string; msl: number; mslName: string; aam: number; aamName: string; kills: number; rangeKey: number; lockKey: number };
  /**
   * Every text, laid out so none overlaps another, the heading tape or the jet HUD's own text
   * (src/ui/weaponsHudLayout.ts); indexed by the TX_* slots. `rects` holds each shown one's box.
   */
  texts: HudText[];
  rects: Float64Array;
  /** The jet HUD's text/scale areas this frame (x0, y0, x1, y1 each; the last JET_TAPE_RECTS are the heading tape). */
  keepOut: Float64Array;
  nKeepOut: number;
  /** Layout memory (last frame's spots) per block. */
  layout: { stores: Placed; stores2: Placed; range: Placed; msg: Placed; lock: Placed; pipper: Placed; lead: Placed };
}

/** One HUD text: string, centre-line position (x by `align`), size, weight; `blink` = drawn only on the flash. */
export interface HudText {
  show: boolean;
  blink: boolean;
  s: string;
  x: number;
  y: number;
  px: number;
  weight: number;
  align: 'left' | 'right' | 'center';
}

/** Text slots in WeaponsHudModel.texts. */
export const TX_LOCK = 0;
export const TX_TYPE = 1;
export const TX_RANGE = 2;
export const TX_LOCK_IN_RNG = 3;
export const TX_PIPPER_IN_RNG = 4;
export const TX_LEAD_IN_RNG = 5;
export const TX_RANGE_CUE = 6;
export const TX_GUN = 7;
export const TX_AAM = 8;
export const TX_MSL = 9;
export const TX_KILLS = 10;
export const TX_MSG = 11;
export const TX_COUNT = 12;

export function createWeaponsHudModel(cfg: Config = CONFIG): WeaponsHudModel {
  return {
    show: false, w: 0, h: 0,
    vis: { any: false, gun: false, missiles: false, rangeCue: false, markers: false },
    display: { x: 0, y: 0, w: 0, h: 0 },
    font: 12, lw: 1.5,
    gunCross: { show: false, x: 0, y: 0 },
    pipper: { show: false, x: 0, y: 0, r: 0, clamped: false, arc: 0, inRange: false },
    lead: { show: false, x: 0, y: 0, r: 0, clamped: false, inRange: false, rangeM: 0 },
    seekerCircle: { show: false, x: 0, y: 0, r: 0 },
    lock: { show: false, solid: false, fill: 0, x: 0, y: 0, half: 0, clamped: false, flashOn: false, type: '', range: '', inRange: false },
    markers: new Float32Array(Math.max(1, cfg.hud.weapons.maxTargetMarkers) * 2),
    markerCount: 0,
    rangeCue: { show: false, text: '', distanceM: 0, tapeShow: false, tapeX: 0, tapeY: 0, tapeDir: 0, tapeUp: true, steerShow: false, steerX: 0, steerY: 0 },
    stores: { x: 0, y: 0, right: 0, gun: '', gunShow: false, gunEmpty: false, msl: '', mslShow: false, aam: '', aamShow: false, kills: 'KILLS 0' },
    msg: { show: false, text: '', x: 0, y: 0 },
    flashOn: true,
    glassOn: false,
    xform: new Float64Array([1, 0, 0, 1, 0, 0]),
    quad: new Float64Array(8),
    glassBox: { x: 0, y: 0, w: 0, h: 0 },
    cache: { rounds: NaN, label: '', gunName: '', msl: NaN, mslName: '', aam: NaN, aamName: '', kills: 0, rangeKey: NaN, lockKey: NaN },
    texts: Array.from({ length: TX_COUNT }, () => ({ show: false, blink: false, s: '', x: 0, y: 0, px: 12, weight: 700, align: 'center' as const })),
    rects: new Float64Array(TX_COUNT * 4),
    keepOut: new Float64Array(JET_KEEP_OUT_MAX * 4),
    nKeepOut: 0,
    layout: { stores: createPlaced(), stores2: createPlaced(), range: createPlaced(), msg: createPlaced(), lock: createPlaced(), pipper: createPlaced(), lead: createPlaced() },
  };
}

// Scratch (module-level, reused every frame).
const sp = createScreenPt();
const cl = createScreenPt();
const dir: Vec3 = { x: 0, y: 0, z: 0 };
const muz: Vec3 = { x: 0, y: 0, z: 0 };
const box: LockBox = { show: false, solid: false, fill: 0 };
const leadSol = newLead();
const leadMuzzle: Vec3 = { x: 0, y: 0, z: 0 };
const leadVel: Vec3 = { x: 0, y: 0, z: 0 };

/** Rotate a body-frame vector by the aircraft quaternion into `out`. */
function rotate(out: Vec3, f: WeaponsHudFrame, x: number, y: number, z: number): Vec3 {
  const { qx, qy, qz, qw } = f;
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out.x = x + qw * tx + (qy * tz - qz * ty);
  out.y = y + qw * ty + (qz * tx - qx * tz);
  out.z = z + qw * tz + (qx * ty - qy * tx);
  if (!(fin(out.x) && fin(out.y) && fin(out.z))) {
    out.x = x;
    out.y = y;
    out.z = z;
  }
  return out;
}

/** A projected point → HUD-box px on the glass (unchanged without one). */
function toBox(gl: HudGlass | null, p: { x: number; y: number }): void {
  if (gl) hudGlassToBox(gl, p, p.x, p.y);
}

function findTarget(f: WeaponsHudFrame, id: number | null): GroundTarget | null {
  if (id === null || id === undefined) return null;
  const ts = f.targets;
  for (let i = 0; i < ts.length; i++) if (ts[i].id === id) return ts[i];
  return null;
}

/** Fill the model for this frame. */
export function updateWeaponsHud(m: WeaponsHudModel, f: WeaponsHudFrame, cfg: Config = CONFIG): WeaponsHudModel {
  const hw = cfg.hud.weapons;
  const vis = weaponsVisibility(f.weapons, hw, m.vis);
  const W = size(f.w);
  const H = size(f.h);
  m.w = W;
  m.h = H;
  m.show = vis.any && W > 0 && H > 0;
  m.gunCross.show = false;
  m.pipper.show = false;
  m.lead.show = false;
  m.seekerCircle.show = false;
  m.lock.show = false;
  m.markerCount = 0;
  m.rangeCue.show = false;
  m.rangeCue.tapeShow = false;
  m.rangeCue.steerShow = false;
  m.stores.gunShow = false;
  m.stores.mslShow = false;
  m.stores.aamShow = false;
  m.msg.show = false;
  m.glassOn = false;
  if (!m.show) return m;
  // On the glass (cockpit): looking away from it hides the whole HUD.
  const gl = !f.exterior && f.glass ? f.glass : null;
  if (gl && !(gl.visible && size(gl.w) > 0 && size(gl.h) > 0)) {
    m.show = false;
    return m;
  }
  if (gl) {
    m.glassOn = true;
    m.xform.set(gl.m);
    m.quad.set(gl.quad);
    m.glassBox.x = 0;
    m.glassBox.y = 0;
    m.glassBox.w = gl.w;
    m.glassBox.h = gl.h;
  }

  const time = num(f.time);
  m.flashOn = Math.floor(time * hw.flashHz * 2) % 2 === 0;
  const hb = gl ? m.glassBox : f.hudBox && size(f.hudBox.w) > 0 && size(f.hudBox.h) > 0 && fin(f.hudBox.x) && fin(f.hudBox.y) ? f.hudBox : null;
  m.font = clamp((hb ? hb.h : H * 0.5) * 0.036, 11, 17);
  m.lw = clamp(H * 0.0019, 1.3, 2.4);
  const d = m.display;
  if (!f.exterior && hb) {
    d.x = hb.x;
    d.y = hb.y;
    d.w = hb.w;
    d.h = hb.h;
  } else {
    const mg = Math.min(10, W / 4, H / 4);
    d.x = mg;
    d.y = mg;
    d.w = Math.max(0, W - 2 * mg);
    d.h = Math.max(0, H - 2 * mg);
  }
  const focal = clamp(Math.abs(num(f.proj[5], 1)) * (H / 2), 1, 1e6);
  const ax = num(f.ax);
  const ay = num(f.ay);
  const az = num(f.az);
  const st = f.status ?? emptyWeaponsStatus();
  const gun = vis.gun ? f.weapons!.gun! : null;
  const msl = vis.missiles ? f.weapons!.missiles! : null;
  const aam = vis.airMissiles ? f.weapons!.airMissiles! : null;

  // ── Gun cross: a point far out on the gun line (from the muzzle) ──
  if (gun) {
    const own = f.exterior || jetHudOmitsGunCross(cfg);
    rotate(muz, f, num(gun.muzzle.x), num(gun.muzzle.y), num(gun.muzzle.z));
    gunLineDir(dir, f.qx, f.qy, f.qz, f.qw, gun.boresightDownDeg);
    const R = hw.gunCrossRangeM;
    projectPoint(sp, ax + muz.x + dir.x * R, ay + muz.y + dir.y * R, az + muz.z + dir.z * R, f.view, f.proj, W, H);
    toBox(gl, sp);
    m.gunCross.show = own && sp.onScreen;
    m.gunCross.x = sp.x;
    m.gunCross.y = sp.y;
  }

  // ── CCIP pipper ──
  const pr = clamp(hw.pipperRadiusPx * (H / 900), 12, 40);
  m.pipper.r = pr;
  if (gun && st.ccip && fin(st.ccip.x) && fin(st.ccip.y) && fin(st.ccip.z)) {
    projectPoint(sp, st.ccip.x, st.ccip.y, st.ccip.z, f.view, f.proj, W, H);
    toBox(gl, sp);
    if (sp.inFront) {
      clampToRect(cl, sp.x, sp.y, d, pr + 2);
      m.pipper.show = true;
      m.pipper.x = cl.x;
      m.pipper.y = cl.y;
      m.pipper.clamped = cl.clamped;
      const rng = fin(st.ccipRangeM as number) ? (st.ccipRangeM as number) : Math.hypot(st.ccip.x - ax, st.ccip.y - ay, st.ccip.z - az);
      m.pipper.arc = cl.clamped ? 0 : pipperArcFraction(rng, hw.gunInRangeM);
      if (!cl.clamped && fin(rng) && rng > hw.gunInRangeM) m.pipper.arc = 1;
      m.pipper.inRange = !cl.clamped && fin(rng) && rng > 0 && rng <= hw.gunInRangeM;
    }
  }

  // ── Maverick circle: the selection cone around the nose (where T picks targets) ──
  if (msl && f.seekerActive) {
    gunLineDir(dir, f.qx, f.qy, f.qz, f.qw, 0);
    projectPoint(sp, ax + dir.x * 2000, ay + dir.y * 2000, az + dir.z * 2000, f.view, f.proj, W, H);
    toBox(gl, sp);
    if (sp.onScreen) {
      m.seekerCircle.show = true;
      m.seekerCircle.x = sp.x;
      m.seekerCircle.y = sp.y;
      m.seekerCircle.r = clamp(Math.tan(clamp(num(msl.selectConeDeg, 10), 0.5, 40) * DEG) * focal, 8, Math.max(8, H * 0.45));
    }
  }

  // ── Lock box on the target ──
  const lk = st.lock ?? emptyWeaponsStatus().lock;
  lockBox(lk, box);
  const lockTarget = box.show && (msl || aam) ? findTarget(f, lk.targetId) : null;
  if (lockTarget) {
    const cls = f.classOf(lockTarget.kind);
    const p = lockTarget.position;
    // aircraft: `position` is the centre of the box; vehicles: the footprint on the ground
    projectPoint(sp, num(p.x), num(p.y) + (cls?.air ? 0 : num(cls?.height, 2) / 2), num(p.z), f.view, f.proj, W, H);
    toBox(gl, sp);
    const depth = sp.inFront ? sp.depth : 1e4;
    const half = clamp((num(cls?.length, 7) / 2 / Math.max(1, depth)) * focal * 1.25, 9, 60);
    clampToRect(cl, sp.x, sp.y, d, half + 2);
    const L = m.lock;
    L.show = true;
    L.solid = box.solid;
    L.fill = box.fill;
    L.x = cl.x;
    L.y = cl.y;
    L.half = half;
    L.clamped = cl.clamped || !sp.inFront;
    L.flashOn = m.flashOn;
    L.type = cls?.name ?? String(lockTarget.kind);
    const rng = fin(lk.rangeM as number) && (lk.rangeM as number) >= 0 ? (lk.rangeM as number) : Math.hypot(num(p.x) - ax, num(p.y) - ay, num(p.z) - az);
    const key = rng >= 1852 ? 1e7 + Math.round(rng / 185.2) : Math.round(rng / 3.048);
    if (key !== m.cache.lockKey) {
      m.cache.lockKey = key;
      L.range = formatSlantRange(rng);
    }
    L.inRange = !!lk.inRange;

    // ── Gun lead pipper on a locked aircraft ──
    const la = cfg.combat.air.hud;
    if (gun && cls?.air && lockTarget.alive) {
      rotate(muz, f, num(gun.muzzle.x), num(gun.muzzle.y), num(gun.muzzle.z));
      leadMuzzle.x = ax + muz.x;
      leadMuzzle.y = ay + muz.y;
      leadMuzzle.z = az + muz.z;
      leadVel.x = num(f.vx ?? 0);
      leadVel.y = num(f.vy ?? 0);
      leadVel.z = num(f.vz ?? 0);
      gunLead(leadSol, leadMuzzle, leadVel, lockTarget.position, lockTarget.velocity, gun.muzzleVelocity, gun.dragK);
      if (leadSol.ok && leadSol.rangeM <= la.leadMaxRangeM) {
        projectPoint(sp, leadSol.x, leadSol.y, leadSol.z, f.view, f.proj, W, H);
        toBox(gl, sp);
        if (sp.inFront) {
          const r = clamp(la.leadRadiusPx * (H / 900), 10, 30);
          clampToRect(cl, sp.x, sp.y, d, r + 2);
          const ld = m.lead;
          ld.show = true;
          ld.x = cl.x;
          ld.y = cl.y;
          ld.r = r;
          ld.clamped = cl.clamped;
          ld.rangeM = leadSol.rangeM;
          ld.inRange = !cl.clamped && leadSol.rangeM <= la.leadInRangeM;
        }
      }
    }
  }

  // ── Target markers (hollow diamonds over live vehicles nearby) ──
  if (vis.markers) {
    const maxN = Math.min(hw.maxTargetMarkers, m.markers.length / 2);
    const r2 = hw.targetMarkerRangeM * hw.targetMarkerRangeM;
    const ts = f.targets;
    for (let i = 0; i < ts.length && m.markerCount < maxN; i++) {
      const t = ts[i];
      if (!t.alive || (lockTarget && t.id === lockTarget.id)) continue;
      const p = t.position;
      const dx = num(p.x, 1e9) - ax;
      const dy = num(p.y) - ay;
      const dz = num(p.z, 1e9) - az;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      const cls = f.classOf(t.kind);
      projectPoint(sp, num(p.x), num(p.y) + (cls?.air ? 0 : num(cls?.height, 2) / 2), num(p.z), f.view, f.proj, W, H);
      if (!sp.onScreen) continue;
      toBox(gl, sp);
      m.markers[2 * m.markerCount] = sp.x;
      m.markers[2 * m.markerCount + 1] = sp.y;
      m.markerCount++;
    }
  }

  // ── Range cue ──
  const rg = f.range;
  if (vis.rangeCue && rg && fin(rg.x) && fin(rg.z)) {
    const dist = Math.hypot(rg.x - ax, rg.z - az);
    if (dist > hw.rangeCueBeyondM) {
      const rc = m.rangeCue;
      rc.show = true;
      rc.distanceM = dist;
      const key = Math.round(dist / 100);
      if (key !== m.cache.rangeKey) {
        m.cache.rangeKey = key;
        rc.text = `RANGE ${formatKm(dist)}`;
      }
      const rel = relativeBearingDeg(bearingDeg(ax, az, rg.x, rg.z), num(f.headingDeg));
      if (hb) {
        const compact = jetHudCompact(hb.w, hb.h, !!gl);
        const tape = jetHeadingTape(hb.w, hb.h, f.gearUp, compact);
        rc.tapeShow = true;
        rc.tapeUp = f.gearUp && !compact;
        rc.tapeDir = rel > 20 ? 1 : rel < -20 ? -1 : 0;
        rc.tapeX = hb.x + hb.w / 2 + clamp(rel, -20, 20) * tape.ppd;
        rc.tapeY = hb.y + tape.y;
      }
      projectPoint(sp, rg.x, num(f.rangeGroundY), rg.z, f.view, f.proj, W, H);
      toBox(gl, sp);
      rc.steerShow = sp.onScreen && sp.x >= d.x && sp.x <= d.x + d.w && sp.y >= d.y && sp.y <= d.y + d.h;
      rc.steerX = sp.x;
      rc.steerY = sp.y;
    }
  }

  // ── Stores block (bottom-left of the HUD) ──
  const S = m.stores;
  const anchor = hb ?? { x: d.x, y: H * 0.55, w: Math.min(W * 0.4, 520), h: H * 0.4 };
  S.x = anchor.x + anchor.w * 0.03;
  S.right = hb ? anchor.x + anchor.w * 0.97 : W - 14;
  S.y = anchor.y + anchor.h * 0.94;
  if (gun) {
    const rounds = st.hasGun ? num(st.rounds) : gun.rounds;
    if (rounds !== m.cache.rounds || gun.name !== m.cache.gunName) {
      m.cache.rounds = rounds;
      m.cache.gunName = gun.name;
      m.cache.label = ammoLabel(gun.name, hw);
      S.gun = gunAmmoText(rounds, m.cache.label);
    }
    S.gunEmpty = !(rounds > 0);
    S.gunShow = !S.gunEmpty || m.flashOn;
  }
  if (msl) {
    const n = st.hasMissiles ? num(st.missiles) : msl.stations.length;
    if (n !== m.cache.msl || msl.name !== m.cache.mslName) {
      m.cache.msl = n;
      m.cache.mslName = msl.name;
      S.msl = missileStoresText(msl.name, n);
    }
    S.mslShow = true;
  }
  if (aam) {
    const n = st.hasAirMissiles ? num(st.airMissiles) : aam.stations.length;
    if (n !== m.cache.aam || aam.name !== m.cache.aamName) {
      m.cache.aam = n;
      m.cache.aamName = aam.name;
      S.aam = missileStoresText(aam.name, n);
    }
    S.aamShow = true;
  }
  const kills = Math.max(0, Math.round(num(f.kills)));
  if (kills !== m.cache.kills) {
    m.cache.kills = kills;
    S.kills = `KILLS ${kills}`;
  }

  // ── Message ──
  if (f.message && time < num(f.messageUntil)) {
    m.msg.show = true;
    m.msg.text = f.message;
    m.msg.x = hb ? hb.x + hb.w / 2 : W / 2;
    m.msg.y = hb ? hb.y + hb.h * 0.7 : H * 0.62;
  }

  layoutTexts(m, f, hb, gl, cfg);
  return m;
}

// ─── Text layout ─────────────────────────────────────────────────────────────

const placer = new TextPlacer();
const specs: LineSpec[] = Array.from({ length: 6 }, () => ({ chars: 0, px: 12 }));
const slots: number[] = [];
const symBox: Box = { x0: 0, y0: 0, x1: 0, y1: 0 };
const spots: FixedSpot[] = Array.from({ length: 24 }, () => ({ x: 0, y: 0, align: 'left' as const }));
const NO_DROP: readonly number[] = [];
const storesDrop: number[] = [];
const optsStores = placeOptions({ fixed: spots, dropOrder: [] });
const optsRange = placeOptions({ fixed: spots });
const optsMsg = placeOptions({ fixed: spots });
const optsLock = placeOptions({ prefer: 'below', split: true, fixed: spots, far: 12 });
const optsSmall = placeOptions({ prefer: 'below', far: 8 });
const lockDrop: number[] = [];

function hideTexts(m: WeaponsHudModel): void {
  for (const t of m.texts) t.show = false;
}

/** Queue a line for the next block: slot, string, size. */
function queue(n: number, slot: number, s: string, px: number): number {
  specs[n].chars = s.length;
  specs[n].px = px;
  slots[n] = slot;
  return n + 1;
}

/** Copy a placed block into the text slots. */
function commitBlock(m: WeaponsHudModel, p: Placed, n: number, texts: readonly string[], weights: readonly number[], blinks: readonly boolean[]): void {
  for (let k = 0; k < n; k++) {
    const t = m.texts[slots[k]];
    t.show = p.ok && p.shown[k] === 1;
    if (!t.show) continue;
    t.s = texts[k];
    t.x = p.x[k];
    t.y = p.y[k];
    t.px = specs[k].px;
    t.weight = weights[k];
    t.blink = blinks[k];
    t.align = p.align;
  }
}

const bTexts: string[] = ['', '', '', '', '', ''];
const bWeights: number[] = [700, 700, 700, 700, 700, 700];
const bBlinks: boolean[] = [false, false, false, false, false, false];
function line(n: number, s: string, weight: number, blink = false): void {
  bTexts[n] = s;
  bWeights[n] = weight;
  bBlinks[n] = blink;
}

/**
 * Lay out every text of the weapons HUD (stores, range cue, message, lock data, IN RNG cues) so no
 * two overlap and none touches the heading tape or the jet HUD's own text: fixed blocks first,
 * then the ones that follow a symbol, most important first (src/ui/weaponsHudLayout.ts).
 */
function layoutTexts(m: WeaponsHudModel, f: WeaponsHudFrame, hb: Rect | null, gl: HudGlass | null, cfg: Config): void {
  hideTexts(m);
  const F = m.font;
  const lw = m.lw;
  const d = m.display;
  placer.reset(d.x, d.y, d.x + d.w, d.y + d.h);
  m.nKeepOut = 0;
  if (hb) {
    m.nKeepOut = jetHudKeepOut(m.keepOut, {
      x: hb.x, y: hb.y, w: hb.w, h: hb.h, glass: !!gl,
      boreY: gl ? gl.boreY : hb.h * cfg.hud.jet.boresightY, gearUp: f.gearUp, font: F, speedBrake: f.speedBrake, abOrEngine: f.abOrEngine, caret: m.rangeCue.show && m.rangeCue.tapeShow,
    }, cfg);
    placer.addHardRects(m.keepOut, m.nKeepOut);
    // the jet HUD's boresight cross and (on the glass) flight-path marker: avoided when possible
    const bx = gl ? gl.boreX : hb.x + hb.w / 2;
    const by = gl ? gl.boreY : hb.y + hb.h * cfg.hud.jet.boresightY;
    const c = Math.max(hb.h * 0.02, F * 0.7) + lw;
    placer.addSoft(bx - c, by - c, bx + c, by + c);
    if (gl && gl.fpmOk) {
      const r = Math.max(hb.h * 0.017, 4.4) * 2.7 + lw;
      placer.addSoft(gl.fpmX - r, gl.fpmY - r * 0.8, gl.fpmX + r, gl.fpmY + r * 0.5);
    }
  }
  // Soft obstacles: the conformal symbols (text avoids them when it can).
  if (m.gunCross.show) {
    const c = Math.max(8, F * 0.95) + lw;
    placer.addSoft(m.gunCross.x - c, m.gunCross.y - c, m.gunCross.x + c, m.gunCross.y + c);
  }
  const pp = m.pipper;
  if (pp.show) {
    const r = pp.r + lw * 3.5;
    placer.addSoft(pp.x - r, pp.y - r, pp.x + r, pp.y + r);
  }
  const ld = m.lead;
  if (ld.show) {
    const r = ld.r + lw * 4.5;
    placer.addSoft(ld.x - r, ld.y - r, ld.x + r, ld.y + r);
  }
  const L = m.lock;
  if (L.show) placer.addSoft(L.x - L.half - lw, L.y - L.half - lw, L.x + L.half + lw, L.y + L.half + lw);
  const rc = m.rangeCue;
  if (rc.show && rc.steerShow) placer.addSoft(rc.steerX - F * 0.7, rc.steerY - F, rc.steerX + F * 0.7, rc.steerY + lw);

  const S = m.stores;
  // (the fixed blocks stay by the HUD: its box bottom, not the viewport's)
  const boxBottom = Math.min(d.y + d.h, hb ? hb.y + hb.h : d.y + d.h);
  // ── Stores block: bottom-left, stacked upward (GUN, 9M, 65D, KILLS from the top) ──
  {
    let n = 0;
    if (S.gun) {
      n = queue(n, TX_GUN, S.gun, F);
      line(n - 1, S.gun, 800, S.gunEmpty);
    }
    if (S.aamShow) {
      n = queue(n, TX_AAM, S.aam, F);
      line(n - 1, S.aam, 800);
    }
    if (S.mslShow) {
      n = queue(n, TX_MSL, S.msl, F);
      line(n - 1, S.msl, 800);
    }
    n = queue(n, TX_KILLS, S.kills, F * 0.95);
    line(n - 1, S.kills, 700);
    // spots: the usual corner, a little higher, as low as the HUD box goes, then higher and higher
    let k = 0;
    for (let j = -1; j < 12; j++) {
      const sp = spots[k++];
      sp.x = S.x;
      sp.y = j < 0 ? S.y : j === 0 ? S.y - F * 0.5 : j === 1 ? boxBottom - F * 0.6 : S.y - (j - 0.5) * F * 0.5 - F * 0.5;
      sp.align = 'left';
    }
    optsStores.nFixed = k;
    optsStores.dropOrder = NO_DROP;
    let p = placer.placeBlock(m.layout.stores, specs, n, F * 1.3, null, optsStores);
    if (!p.ok) {
      // tighter lines, then drop the least important ones (KILLS first)
      storesDrop.length = 0;
      for (let i = n - 1; i >= 1; i--) storesDrop.push(i);
      optsStores.dropOrder = storesDrop;
      p = placer.placeBlock(m.layout.stores, specs, n, F * 1.15, null, optsStores);
    }
    commitBlock(m, p, n, bTexts, bWeights, bBlinks);
    // Lines that didn't fit on the left (a small combiner) go bottom-right, right-aligned.
    let r = 0;
    for (let i = 0; i < n; i++) {
      if (m.texts[slots[i]].show) continue;
      specs[r].chars = specs[i].chars;
      specs[r].px = specs[i].px;
      slots[r] = slots[i];
      bTexts[r] = bTexts[i];
      bWeights[r] = bWeights[i];
      bBlinks[r] = bBlinks[i];
      r++;
    }
    if (r > 0) {
      k = 0;
      for (let j = -1; j < 12; j++) {
        const sp = spots[k++];
        sp.x = S.right;
        sp.y = j < 0 ? S.y : j === 0 ? boxBottom - F * 0.6 : S.y - j * F * 0.5;
        sp.align = 'right';
      }
      optsStores.nFixed = k;
      storesDrop.length = 0;
      for (let i = r - 1; i >= 0; i--) storesDrop.push(i);
      optsStores.dropOrder = storesDrop;
      commitBlock(m, placer.placeBlock(m.layout.stores2, specs, r, F * 1.15, null, optsStores), r, bTexts, bWeights, bBlinks);
    }
  }
  // ── Range cue: bottom-right ──
  if (rc.show && rc.text) {
    const n = queue(0, TX_RANGE_CUE, rc.text, F);
    line(0, rc.text, 700);
    let k = 0;
    for (let j = -1; j < 14; j++) {
      const sp = spots[k++];
      sp.x = S.right;
      sp.y = j < 0 ? S.y : j === 0 ? boxBottom - F * 0.6 : S.y - j * F * 0.5;
      sp.align = 'right';
    }
    optsRange.nFixed = k;
    commitBlock(m, placer.placeBlock(m.layout.range, specs, n, F, null, optsRange), n, bTexts, bWeights, bBlinks);
  }
  // ── Message: centred low in the HUD, moved up/down to a clear line ──
  if (m.msg.show) {
    const n = queue(0, TX_MSG, m.msg.text, F * 1.2);
    line(0, m.msg.text, 800);
    let k = 0;
    for (let j = 0; j < 23 && k < spots.length; j++) {
      const sp = spots[k++];
      const off = j === 0 ? 0 : (j % 2 === 1 ? -1 : 1) * Math.ceil(j / 2) * 0.6 * F;
      sp.x = m.msg.x;
      sp.y = m.msg.y + off;
      sp.align = 'center';
    }
    optsMsg.nFixed = k;
    commitBlock(m, placer.placeBlock(m.layout.msg, specs, n, F, null, optsMsg), n, bTexts, bWeights, bBlinks);
  }
  // ── Lock data: LOCK over the box, type / range / IN RNG under it — or wherever is clear ──
  if (L.show) {
    let n = 0;
    lockDrop.length = 0;
    if (L.solid) {
      n = queue(n, TX_LOCK, 'LOCK', F * 1.05);
      line(n - 1, 'LOCK', 800, true);
    }
    const iType = n;
    n = queue(n, TX_TYPE, L.type, F * 0.95);
    line(n - 1, L.type, 700);
    n = queue(n, TX_RANGE, L.range, F * 0.95);
    line(n - 1, L.range, 700);
    let iRng = -1;
    if (L.inRange) {
      iRng = n;
      n = queue(n, TX_LOCK_IN_RNG, 'IN RNG', F * 0.95);
      line(n - 1, 'IN RNG', 700);
    }
    // dropped when there is no room: the type, then LOCK (the solid box says it), then IN RNG
    lockDrop.push(iType);
    if (L.solid) lockDrop.push(0);
    if (iRng >= 0) lockDrop.push(iRng);
    optsLock.dropOrder = lockDrop;
    optsLock.split = L.solid;
    symBox.x0 = L.x - L.half - lw;
    symBox.y0 = L.y - L.half - lw;
    symBox.x1 = L.x + L.half + lw;
    symBox.y1 = L.y + L.half + lw;
    optsLock.gap = F * 0.35;
    // last resort: a data block over the range cue, bottom-right of the HUD
    let k = 0;
    if (hb) {
      for (let j = 1; j <= 6; j++) {
        const sp = spots[k++];
        sp.x = S.right;
        sp.y = S.y - j * F * 1.3;
        sp.align = 'right';
      }
    }
    optsLock.nFixed = k;
    commitBlock(m, placer.placeBlock(m.layout.lock, specs, n, F * 1.15, symBox, optsLock), n, bTexts, bWeights, bBlinks);
  } else m.layout.lock.spot = -1;
  // ── IN RNG under the CCIP pipper ──
  if (pp.show && pp.inRange && !pp.clamped) {
    const n = queue(0, TX_PIPPER_IN_RNG, 'IN RNG', F);
    line(0, 'IN RNG', 700);
    const r = pp.r + lw * 3.5;
    symBox.x0 = pp.x - r;
    symBox.y0 = pp.y - r;
    symBox.x1 = pp.x + r;
    symBox.y1 = pp.y + r;
    optsSmall.gap = F * 0.3;
    commitBlock(m, placer.placeBlock(m.layout.pipper, specs, n, F, symBox, optsSmall), n, bTexts, bWeights, bBlinks);
  }
  // ── IN RNG by the gun lead pipper (not when the lock box right there already says it) ──
  if (ld.show && ld.inRange && !ld.clamped) {
    const nearBox = L.show && Math.abs(L.x - ld.x) < L.half + F * 4 && Math.abs(L.y - ld.y) < L.half + F * 4;
    if (!nearBox) {
      const n = queue(0, TX_LEAD_IN_RNG, 'IN RNG', F * 0.95);
      line(0, 'IN RNG', 700);
      const r = ld.r + lw * 4.5;
      symBox.x0 = ld.x - r;
      symBox.y0 = ld.y - r;
      symBox.x1 = ld.x + r;
      symBox.y1 = ld.y + r;
      optsSmall.gap = F * 0.3;
      commitBlock(m, placer.placeBlock(m.layout.lead, specs, n, F, symBox, optsSmall), n, bTexts, bWeights, bBlinks);
    }
  }
  // Boxes of the shown texts (for tests / QA).
  const one: LineSpec = lineSpecScratch;
  for (let i = 0; i < TX_COUNT; i++) {
    const t = m.texts[i];
    if (!t.show) {
      m.rects[4 * i] = m.rects[4 * i + 1] = m.rects[4 * i + 2] = m.rects[4 * i + 3] = NaN;
      continue;
    }
    one.chars = t.s.length;
    one.px = t.px;
    lineRect(m.rects, i, one, t.x, t.y, t.align);
  }
}
const lineSpecScratch: LineSpec = { chars: 0, px: 12 };

/** Quantised snapshot of what is drawn — redraw only when it changes. Returns true if it did. */
export function weaponsHudChanged(m: WeaponsHudModel, key: Float64Array): boolean {
  let i = 0;
  let changed = false;
  const put = (v: number) => {
    const q = fin(v) ? Math.round(v * 2) / 2 : -1;
    if (key[i] !== q) {
      key[i] = q;
      changed = true;
    }
    i++;
  };
  put(m.show ? 1 : 0);
  put(m.w);
  put(m.h);
  put(m.flashOn ? 1 : 0);
  put(m.gunCross.show ? m.gunCross.x : -9);
  put(m.gunCross.y);
  put(m.pipper.show ? m.pipper.x : -9);
  put(m.pipper.y);
  put(m.pipper.arc * 200);
  put((m.pipper.clamped ? 1 : 0) + (m.pipper.inRange ? 2 : 0));
  put(m.seekerCircle.show ? m.seekerCircle.x : -9);
  put(m.seekerCircle.y + m.seekerCircle.r * 1000);
  put(m.lock.show ? m.lock.x : -9);
  put(m.lock.y);
  put(m.lock.half + m.lock.fill * 1000 + (m.lock.solid ? 1e5 : 0) + (m.lock.inRange ? 2e5 : 0) + (m.lock.clamped ? 4e5 : 0));
  put(m.cache.lockKey);
  let sx = 0;
  let sy = 0;
  for (let k = 0; k < m.markerCount; k++) {
    sx += m.markers[2 * k] * (k + 1);
    sy += m.markers[2 * k + 1] * (k + 1);
  }
  put(m.markerCount);
  put(sx);
  put(sy);
  put(m.rangeCue.show ? m.cache.rangeKey : -9);
  put(m.rangeCue.tapeShow ? m.rangeCue.tapeX : -9);
  put(m.rangeCue.tapeY + m.rangeCue.tapeDir * 1e4);
  put(m.rangeCue.steerShow ? m.rangeCue.steerX : -9);
  put(m.rangeCue.steerY);
  put(m.cache.rounds + (m.stores.gunShow ? 1e5 : 0));
  put(m.cache.msl);
  put(m.cache.kills);
  put(m.msg.show ? m.msg.text.length + m.msg.text.charCodeAt(0) * 100 : -9);
  put(m.stores.x + m.stores.y * 1e4);
  put(m.glassOn ? 1 : 0);
  put(m.glassOn ? m.xform[4] : 0);
  put(m.glassOn ? m.xform[5] : 0);
  put(m.glassOn ? m.xform[0] * 1000 : 0);
  put(m.glassOn ? m.xform[1] * 1000 : 0);
  put(m.glassOn ? m.xform[2] * 1000 : 0);
  put(m.glassOn ? m.xform[3] * 1000 + m.glassBox.w * 1e4 + m.glassBox.h * 1e7 : 0);
  put(m.lead.show ? m.lead.x : -9);
  put(m.lead.y + (m.lead.inRange ? 1e4 : 0) + (m.lead.clamped ? 2e4 : 0) + m.lead.r * 1e5);
  put(m.stores.aamShow ? m.cache.aam : -9);
  // where the texts went
  let tx = 0;
  let ty = 0;
  let bits = 0;
  for (let k = 0; k < m.texts.length; k++) {
    const t = m.texts[k];
    if (!t.show) continue;
    bits += 1 << k;
    tx += t.x * (k + 1);
    ty += t.y * (k + 1);
  }
  put(bits);
  put(tx);
  put(ty);
  return changed;
}

/** Length of the key array for weaponsHudChanged. */
export const WEAPONS_HUD_KEY_LENGTH = 45;

// ─── Drawing ─────────────────────────────────────────────────────────────────

/** Draw the model into the context (CSS px at the origin; the caller clears). */
export function drawWeaponsHud(ctx: CanvasRenderingContext2D, m: WeaponsHudModel, cfg: Config = CONFIG): void {
  if (!m.show || !(m.w > 0 && m.h > 0)) return;
  const green = cfg.hud.jet.color;
  const halo = cfg.hud.jet.halo;
  const lw = num(m.lw, 1.5);
  const F = num(m.font, 12);

  const stroke = (width = lw) => {
    ctx.strokeStyle = halo;
    ctx.lineWidth = width * 2.6;
    ctx.stroke();
    ctx.strokeStyle = green;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  const text = (s: string, x: number, y: number, px: number, align: CanvasTextAlign = 'center', weight = 700) => {
    if (!s || !fin(x) || !fin(y)) return;
    ctx.font = fontOf(weight, px);
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, px * 0.22);
    ctx.strokeStyle = halo;
    ctx.strokeText(s, x, y);
    ctx.fillStyle = green;
    ctx.fillText(s, x, y);
  };

  ctx.save();
  if (m.glassOn) {
    // On the combiner: clip to the glass (viewport px), then draw in its HUD box.
    const q = m.quad;
    ctx.beginPath();
    ctx.moveTo(q[0], q[1]);
    ctx.lineTo(q[2], q[3]);
    ctx.lineTo(q[4], q[5]);
    ctx.lineTo(q[6], q[7]);
    ctx.closePath();
    ctx.clip();
    const x = m.xform;
    ctx.transform(x[0], x[1], x[2], x[3], x[4], x[5]);
  }
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.globalAlpha = 1;
  ctx.setLineDash([]);

  // Target markers (under everything else).
  if (m.markerCount > 0) {
    const s = Math.max(4.5, F * 0.42);
    ctx.beginPath();
    for (let i = 0; i < m.markerCount; i++) {
      const x = m.markers[2 * i];
      const y = m.markers[2 * i + 1];
      if (!fin(x) || !fin(y)) continue;
      ctx.moveTo(x, y - s);
      ctx.lineTo(x + s, y);
      ctx.lineTo(x, y + s);
      ctx.lineTo(x - s, y);
      ctx.closePath();
    }
    stroke(lw * 0.85);
  }

  // Range steerpoint: ▽ on the ground at the range centre.
  const rc = m.rangeCue;
  if (rc.show && rc.steerShow && fin(rc.steerX) && fin(rc.steerY)) {
    const s = F * 0.6;
    ctx.beginPath();
    ctx.moveTo(rc.steerX - s, rc.steerY - s * 1.6);
    ctx.lineTo(rc.steerX + s, rc.steerY - s * 1.6);
    ctx.lineTo(rc.steerX, rc.steerY);
    ctx.closePath();
    stroke();
  }

  // Gun cross.
  const gc = m.gunCross;
  if (gc.show && fin(gc.x) && fin(gc.y)) {
    const c = Math.max(8, F * 0.95);
    const gap = c * 0.3;
    ctx.beginPath();
    ctx.moveTo(gc.x - c, gc.y);
    ctx.lineTo(gc.x - gap, gc.y);
    ctx.moveTo(gc.x + gap, gc.y);
    ctx.lineTo(gc.x + c, gc.y);
    ctx.moveTo(gc.x, gc.y - c);
    ctx.lineTo(gc.x, gc.y - gap);
    ctx.moveTo(gc.x, gc.y + gap);
    ctx.lineTo(gc.x, gc.y + c);
    stroke();
  }

  // CCIP pipper with its range arc.
  const pp = m.pipper;
  if (pp.show && fin(pp.x) && fin(pp.y)) {
    const r = num(pp.r, 16);
    if (pp.clamped) {
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([r * 0.35, r * 0.3]);
    }
    ctx.beginPath();
    ctx.arc(pp.x, pp.y, r, 0, Math.PI * 2);
    stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(pp.x, pp.y, Math.max(1.6, lw * 1.2), 0, Math.PI * 2);
    ctx.fillStyle = green;
    ctx.fill();
    if (!pp.clamped) {
      // 12 o'clock index tick, and the arc clockwise from it: full = 4,000 ft.
      ctx.beginPath();
      ctx.moveTo(pp.x, pp.y - r - lw * 3.2);
      ctx.lineTo(pp.x, pp.y - r - lw * 0.8);
      stroke();
      const a = clamp(num(pp.arc), 0, 1);
      if (a > 0.005) {
        ctx.beginPath();
        ctx.arc(pp.x, pp.y, r + lw * 2, -Math.PI / 2, -Math.PI / 2 + a * Math.PI * 2);
        stroke(lw * 1.9);
      }
    }
    ctx.globalAlpha = 1;
  }

  // Gun lead pipper (a locked aircraft): circle + dot with four diagonal ticks.
  const ld = m.lead;
  if (ld.show && fin(ld.x) && fin(ld.y)) {
    const r = num(ld.r, 15);
    if (ld.clamped) {
      ctx.globalAlpha = 0.55;
      ctx.setLineDash([r * 0.35, r * 0.3]);
    }
    ctx.beginPath();
    ctx.arc(ld.x, ld.y, r, 0, Math.PI * 2);
    stroke();
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(ld.x, ld.y, Math.max(1.6, lw * 1.2), 0, Math.PI * 2);
    ctx.fillStyle = green;
    ctx.fill();
    if (!ld.clamped) {
      ctx.beginPath();
      for (let k = 0; k < 4; k++) {
        const a = Math.PI / 4 + (k * Math.PI) / 2;
        const c = Math.cos(a), sn = Math.sin(a);
        ctx.moveTo(ld.x + c * (r + lw), ld.y + sn * (r + lw));
        ctx.lineTo(ld.x + c * (r + lw * 4.5), ld.y + sn * (r + lw * 4.5));
      }
      stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Maverick seeker circle.
  const sc = m.seekerCircle;
  if (sc.show && fin(sc.x) && fin(sc.y) && fin(sc.r)) {
    ctx.setLineDash([sc.r * 0.12, sc.r * 0.09]);
    ctx.beginPath();
    ctx.arc(sc.x, sc.y, sc.r, 0, Math.PI * 2);
    stroke(lw * 0.9);
    ctx.setLineDash([]);
  }

  // Lock box.
  const L = m.lock;
  if (L.show && fin(L.x) && fin(L.y) && fin(L.half)) {
    const s = L.half;
    const x0 = L.x - s;
    const y0 = L.y - s;
    if (L.clamped) ctx.setLineDash([s * 0.3, s * 0.25]);
    if (L.solid) {
      ctx.beginPath();
      ctx.rect(x0, y0, 2 * s, 2 * s);
      stroke(lw * 1.35);
      ctx.beginPath();
      ctx.arc(L.x, L.y, Math.max(1.5, lw), 0, Math.PI * 2);
      ctx.fillStyle = green;
      ctx.fill();
    } else {
      // Track gates (corner brackets) + the outline traced clockwise from the top-left with the progress.
      const g = s * 0.42;
      ctx.beginPath();
      ctx.moveTo(x0, y0 + g);
      ctx.lineTo(x0, y0);
      ctx.lineTo(x0 + g, y0);
      ctx.moveTo(x0 + 2 * s - g, y0);
      ctx.lineTo(x0 + 2 * s, y0);
      ctx.lineTo(x0 + 2 * s, y0 + g);
      ctx.moveTo(x0 + 2 * s, y0 + 2 * s - g);
      ctx.lineTo(x0 + 2 * s, y0 + 2 * s);
      ctx.lineTo(x0 + 2 * s - g, y0 + 2 * s);
      ctx.moveTo(x0 + g, y0 + 2 * s);
      ctx.lineTo(x0, y0 + 2 * s);
      ctx.lineTo(x0, y0 + 2 * s - g);
      stroke();
      let left = clamp(num(L.fill), 0, 1) * 8 * s;
      if (left > 0.5) {
        ctx.beginPath();
        ctx.moveTo(x0, y0);
        const side = 2 * s;
        let px = x0;
        let py = y0;
        for (let k = 0; k < 4 && left > 0; k++) {
          // Corners clockwise: top-right, bottom-right, bottom-left, top-left.
          const nx = k === 0 || k === 1 ? x0 + side : x0;
          const ny = k === 0 || k === 3 ? y0 : y0 + side;
          const t = Math.min(1, left / side);
          ctx.lineTo(px + (nx - px) * t, py + (ny - py) * t);
          left -= side;
          px = nx;
          py = ny;
        }
        stroke(lw * 0.9);
      }
    }
    ctx.setLineDash([]);
  }

  // Range cue: caret on the heading tape + the distance.
  if (rc.show) {
    if (rc.tapeShow && fin(rc.tapeX) && fin(rc.tapeY)) {
      const s = F * 0.55;
      const x = rc.tapeX;
      const y = rc.tapeY;
      ctx.beginPath();
      if (rc.tapeDir === 0) {
        // Hollow diamond straddling the tape baseline.
        ctx.moveTo(x, y - s);
        ctx.lineTo(x + s * 0.8, y);
        ctx.lineTo(x, y + s);
        ctx.lineTo(x - s * 0.8, y);
        ctx.closePath();
        stroke();
      } else {
        // Arrow at the tape's end, pointing the way to turn.
        const k = rc.tapeDir;
        ctx.moveTo(x - k * s * 0.4, y - s);
        ctx.lineTo(x + k * s * 1.1, y);
        ctx.lineTo(x - k * s * 0.4, y + s);
        ctx.closePath();
        ctx.fillStyle = green;
        ctx.strokeStyle = halo;
        ctx.lineWidth = lw * 2;
        ctx.stroke();
        ctx.fill();
      }
    }
  }

  // Every text — stores, range cue, message, lock data, IN RNG — where the layout put it
  // (nothing overlaps: layoutTexts). Blinking ones (LOCK, "GUN 0") show on the flash.
  for (let i = 0; i < m.texts.length; i++) {
    const t = m.texts[i];
    if (!t.show || (t.blink && !m.flashOn)) continue;
    text(t.s, t.x, t.y, num(t.px, F), t.align, t.weight);
  }

  ctx.restore();
}

// ─── Seeker picture: corner rect and overlay ─────────────────────────────────

/** The seeker picture's rect (viewport CSS px, bottom right, 4:3), lifted above the systems strip if they'd overlap. */
export function seekerRect(vw: number, vh: number, cfg: Config = CONFIG, strip?: Rect | null): Rect {
  const W = size(vw) || 1024;
  const H = size(vh) || 768;
  const sc = cfg.hud.weapons.seeker;
  const w = Math.round(Math.min(clamp(W * sc.widthFrac, sc.minW, sc.maxW), W * 0.45));
  const h = Math.round(w * 0.75);
  const margin = Math.round(clamp(W * 0.012, 10, 20));
  const x = W - margin - w;
  let y = H - margin - h;
  if (strip && fin(strip.x) && fin(strip.y) && x < strip.x + strip.w && strip.x < x + w && y < strip.y + strip.h && strip.y < y + h) {
    y = Math.round(strip.y - margin - h);
  }
  return { x, y: Math.max(0, y), w, h };
}

export interface SeekerOverlay {
  state: 'off' | 'tracking' | 'locked';
  /** Target in the picture (px from its top-left) and the gate half-size; NaN = none. */
  tx: number;
  ty: number;
  half: number;
  progress: number;
  missiles: number;
  /** Optional top-left label ('' = none). */
  fovLabel: string;
  range: string;
  inRange: boolean;
  flashOn: boolean;
}

export function createSeekerOverlay(): SeekerOverlay {
  return { state: 'off', tx: NaN, ty: NaN, half: 12, progress: 0, missiles: 0, fovLabel: '', range: '', inRange: false, flashOn: true };
}

const SEEKER_INK = '#f4f7f4';
const SEEKER_HALO = 'rgba(0,0,0,0.65)';
const missilesText: string[] = [];
const trackText: string[] = [];

/** The Maverick video symbology over the picture: gapped crosshair, track gates, LOCK, stores, range. */
export function drawSeekerOverlay(ctx: CanvasRenderingContext2D, w: number, h: number, s: SeekerOverlay, cfg: Config = CONFIG): void {
  const W = size(w);
  const H = size(h);
  if (!W || !H) return;
  void cfg;
  const lw = Math.max(1.2, H * 0.006);
  const F = clamp(H * 0.062, 10, 16);
  const stroke = (width = lw) => {
    ctx.strokeStyle = SEEKER_HALO;
    ctx.lineWidth = width * 2.6;
    ctx.stroke();
    ctx.strokeStyle = SEEKER_INK;
    ctx.lineWidth = width;
    ctx.stroke();
  };
  const text = (t: string, x: number, y: number, align: CanvasTextAlign, weight = 700) => {
    if (!t) return;
    ctx.font = fontOf(weight, F);
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = Math.max(2, F * 0.24);
    ctx.strokeStyle = SEEKER_HALO;
    ctx.strokeText(t, x, y);
    ctx.fillStyle = SEEKER_INK;
    ctx.fillText(t, x, y);
  };
  ctx.save();
  ctx.lineCap = 'butt';
  ctx.setLineDash([]);
  // Frame.
  ctx.beginPath();
  ctx.rect(0.5, 0.5, W - 1, H - 1);
  ctx.strokeStyle = 'rgba(160,255,190,0.55)';
  ctx.lineWidth = 1;
  ctx.stroke();

  // Gapped crosshair through the centre, with ticks.
  const cx = W / 2;
  const cy = H / 2;
  const gap = H * 0.11;
  ctx.beginPath();
  ctx.moveTo(W * 0.04, cy);
  ctx.lineTo(cx - gap, cy);
  ctx.moveTo(cx + gap, cy);
  ctx.lineTo(W * 0.96, cy);
  ctx.moveTo(cx, H * 0.05);
  ctx.lineTo(cx, cy - gap);
  ctx.moveTo(cx, cy + gap);
  ctx.lineTo(cx, H * 0.95);
  for (let k = 1; k <= 3; k++) {
    const dx = gap + (k * (W * 0.46 - gap)) / 4;
    ctx.moveTo(cx - dx, cy - H * 0.018);
    ctx.lineTo(cx - dx, cy + H * 0.018);
    ctx.moveTo(cx + dx, cy - H * 0.018);
    ctx.lineTo(cx + dx, cy + H * 0.018);
  }
  stroke(lw * 0.8);

  // Track gates on the target.
  if (s.state !== 'off' && fin(s.tx) && fin(s.ty)) {
    const half = clamp(num(s.half, 12), 6, H * 0.4);
    const x = clamp(s.tx, half, W - half);
    const y = clamp(s.ty, half, H - half);
    const g = half * 0.45;
    const x0 = x - half;
    const y0 = y - half;
    const x1 = x + half;
    const y1 = y + half;
    ctx.beginPath();
    ctx.moveTo(x0, y0 + g);
    ctx.lineTo(x0, y0);
    ctx.lineTo(x0 + g, y0);
    ctx.moveTo(x1 - g, y0);
    ctx.lineTo(x1, y0);
    ctx.lineTo(x1, y0 + g);
    ctx.moveTo(x1, y1 - g);
    ctx.lineTo(x1, y1);
    ctx.lineTo(x1 - g, y1);
    ctx.moveTo(x0 + g, y1);
    ctx.lineTo(x0, y1);
    ctx.lineTo(x0, y1 - g);
    if (s.state === 'locked') {
      // Locked: gates close into a full box with a pointing cross.
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y0);
      ctx.lineTo(x1, y1);
      ctx.lineTo(x0, y1);
      ctx.closePath();
    }
    stroke(s.state === 'locked' ? lw * 1.2 : lw);
  }

  // Texts: polarity + FOV top-left, stores top-right, state bottom-left, range bottom-right.
  const pad = F * 0.7;
  // (No sensor-mode labels: the missiles are arcade — this is a game camera with the Maverick look.)
  text(s.fovLabel, pad, pad + F * 0.2, 'left', 700);
  const n = fin(s.missiles) ? clamp(Math.round(s.missiles), 0, 99) : 0;
  let mt = missilesText[n];
  if (mt === undefined) mt = missilesText[n] = `MAV ×${n}`;
  text(mt, W - pad, pad + F * 0.2, 'right', 800);
  if (s.state === 'locked') {
    if (s.flashOn) text('LOCK', pad, H - pad - F * 0.2, 'left', 800);
  } else if (s.state === 'tracking') {
    const pct = Math.round(clamp(num(s.progress), 0, 1) * 100);
    let tt = trackText[pct];
    if (tt === undefined) tt = trackText[pct] = `TRK ${pct}%`;
    text(tt, pad, H - pad - F * 0.2, 'left', 700);
  } else {
    text('SRCH', pad, H - pad - F * 0.2, 'left', 700);
  }
  if (s.range) text(s.range, W - pad, H - pad - F * 0.2, 'right', 700);
  if (s.inRange && s.state === 'locked') text('IN RNG', W - pad, H - pad - F * 1.4, 'right', 800);
  ctx.restore();
}
