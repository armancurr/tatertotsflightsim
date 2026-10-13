/**
 * PURE state of a ship's main battery (no three.js): each turret trains and elevates at its real
 * rates toward the deck angles the fire control asks for (inside its training arc — it never swings
 * through the blind sector), every gun reloads on its own (`reloadS`) from a finite magazine
 * (`roundsPerGun`), and a salvo is rippled gun after gun (`rippleS`) from the guns that are LOADED
 * and whose turret is ON TARGET. Writes `TurretStatus[]` (the ship's 3D model and the HUD read it):
 * train, elevation, per-gun recoil (1 = just fired, back to 0 over `recoilReturnS`), muzzle flash and
 * ready flags. Allocation-free per step.
 */
import type { NavalGunsConfig, NavalTurretConfig } from '../config';
import type { TurretStatus } from './types';
import { nearestArcLimit, toArc } from './naval';

const fin = (v: number, d = 0) => (Number.isFinite(v) ? v : d);
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

/** 1/s: how hard a turret closes on its ordered angle (on top of the feed-forward of the order's rate). */
export const TRACK_GAIN = 5;
/** Flash decay time constant, s. */
const FLASH_TAU = 0.09;

export interface GunRuntime {
  loaded: boolean;
  /** Seconds until loaded (0 when loaded or empty). */
  reloadLeft: number;
  rounds: number;
  recoil: number;
  flash: number;
  /** Scheduled to fire at this time (s), or −1. */
  fireAt: number;
}

export interface TurretRuntime {
  readonly cfg: NavalTurretConfig;
  trainDeg: number;
  elevDeg: number;
  /** The ordered deck angles (null = stow), and whether the order lies in the training arc. */
  orderTrain: number | null;
  orderElev: number | null;
  inArc: boolean;
  /** Ordered-angle rates (feed-forward), deg/s, smoothed. */
  orderTrainRate: number;
  orderElevRate: number;
  /** Set by the fire control each frame: the guns' predicted miss at the aim point (m) and whether that is ON TARGET. */
  missM: number;
  onTarget: boolean;
  /** No valid solution for the order: beyond the guns' reach, closer than the lowest elevation reaches, or unsolved (set by the fire control). */
  tooFar: boolean;
  /** A salvo was called while this turret was not yet on target: it fires the moment it is, until this time (s); −1 = not armed. */
  armedUntil: number;
  guns: GunRuntime[];
}

export interface Battery {
  readonly cfg: NavalGunsConfig;
  readonly turrets: TurretRuntime[];
  /** Mirrors the turrets for the model / HUD (same arrays every frame). */
  readonly status: TurretStatus[];
  /** Seconds since creation (the salvo schedule's clock). */
  time: number;
  /** Salvos fired, guns fired, and when the last gun fired (s). */
  salvos: number;
  shots: number;
  lastShotAt: number;
}

export interface Shot {
  turret: number;
  gun: number;
}

export function createBattery(cfg: NavalGunsConfig): Battery {
  const turrets: TurretRuntime[] = cfg.turrets.map((t) => ({
    cfg: t,
    trainDeg: t.stowDeg,
    elevDeg: 0,
    orderTrain: null,
    orderElev: null,
    inArc: true,
    orderTrainRate: 0,
    orderElevRate: 0,
    missM: Infinity,
    onTarget: false,
    tooFar: false,
    armedUntil: -1,
    guns: Array.from({ length: t.barrels }, () => ({ loaded: true, reloadLeft: 0, rounds: cfg.roundsPerGun, recoil: 0, flash: 0, fireAt: -1 })),
  }));
  const status: TurretStatus[] = turrets.map((t) => ({
    trainDeg: t.trainDeg,
    elevDeg: t.elevDeg,
    recoil: t.guns.map(() => 0),
    flash: t.guns.map(() => 0),
    ready: t.guns.map(() => true),
  }));
  const b: Battery = { cfg, turrets, status, time: 0, salvos: 0, shots: 0, lastShotAt: -1e9 };
  writeStatus(b);
  return b;
}

/** Full magazines, every gun loaded, turrets stowed, nothing scheduled. */
export function resetBattery(b: Battery): void {
  for (const t of b.turrets) {
    t.trainDeg = t.cfg.stowDeg;
    t.elevDeg = 0;
    t.orderTrain = null;
    t.orderElev = null;
    t.orderTrainRate = 0;
    t.orderElevRate = 0;
    t.inArc = true;
    t.missM = Infinity;
    t.onTarget = false;
    t.tooFar = false;
    t.armedUntil = -1;
    for (const g of t.guns) {
      g.loaded = true;
      g.reloadLeft = 0;
      g.rounds = b.cfg.roundsPerGun;
      g.recoil = 0;
      g.flash = 0;
      g.fireAt = -1;
    }
  }
  b.salvos = 0;
  b.shots = 0;
  b.lastShotAt = -1e9;
  writeStatus(b);
}

/**
 * Order a turret to deck angles (train any representation, deg; elevation deg), or null to stow.
 * A train in the blind sector is clamped to the nearest arc limit (`inArc` = false: never on target).
 * `dt` (s) since the last order feeds the rate estimate (0 = don't update it).
 */
export function orderTurret(b: Battery, i: number, trainDeg: number | null, elevDeg: number | null, dt = 0): void {
  const t = b.turrets[i];
  if (!t) return;
  if (trainDeg === null || elevDeg === null || !Number.isFinite(trainDeg) || !Number.isFinite(elevDeg)) {
    t.orderTrain = null;
    t.orderElev = null;
    t.inArc = true;
    t.orderTrainRate = 0;
    t.orderElevRate = 0;
    return;
  }
  const inArc = toArc(t.cfg, trainDeg);
  const tr = inArc ?? nearestArcLimit(t.cfg, trainDeg);
  const el = clamp(elevDeg, t.cfg.elevMinDeg, t.cfg.elevMaxDeg);
  if (dt > 1e-4 && t.orderTrain !== null && t.orderElev !== null && inArc !== null && t.inArc) {
    const k = Math.min(1, dt / 0.1);
    const rt = clamp((tr - t.orderTrain) / dt, -30, 30);
    const re = clamp((el - t.orderElev) / dt, -30, 30);
    t.orderTrainRate += (rt - t.orderTrainRate) * k;
    t.orderElevRate += (re - t.orderElevRate) * k;
  } else if (inArc === null || !t.inArc) {
    t.orderTrainRate = 0;
    t.orderElevRate = 0;
  }
  t.orderTrain = tr;
  t.orderElev = el;
  t.inArc = inArc !== null;
}

/** Move one angle toward its order: feed-forward of the order's rate + a first-order close, rate-limited. */
function drive(cur: number, order: number, ffRate: number, maxRate: number, dt: number): number {
  const err = order - cur;
  const step = ffRate * dt + err * (1 - Math.exp(-TRACK_GAIN * dt));
  const lim = maxRate * dt;
  return cur + clamp(step, -lim, lim);
}

/** Advance the battery by dt s: turrets move, guns reload, recoil and flash decay; writes `status`. */
export function stepBattery(b: Battery, dtIn: number): void {
  const dt = Number.isFinite(dtIn) && dtIn > 0 ? Math.min(dtIn, 1) : 0;
  b.time += dt;
  const cfg = b.cfg;
  for (const t of b.turrets) {
    const c = t.cfg;
    const trOrder = t.orderTrain ?? c.stowDeg;
    const elOrder = t.orderElev ?? 0;
    const ffT = t.orderTrain === null ? 0 : t.orderTrainRate;
    const ffE = t.orderElev === null ? 0 : t.orderElevRate;
    t.trainDeg = clamp(drive(t.trainDeg, trOrder, ffT, c.trainRateDegPerSec, dt), c.trainMinDeg, c.trainMaxDeg);
    t.elevDeg = clamp(drive(t.elevDeg, elOrder, ffE, c.elevRateDegPerSec, dt), c.elevMinDeg, c.elevMaxDeg);
    for (const g of t.guns) {
      if (!g.loaded && g.rounds > 0) {
        g.reloadLeft = Math.max(0, g.reloadLeft - dt);
        if (g.reloadLeft <= 0) g.loaded = true;
      }
      g.recoil = Math.max(0, g.recoil - dt / Math.max(0.05, fin(cfg.recoilReturnS, 1.5)));
      g.flash *= Math.exp(-dt / FLASH_TAU);
      if (g.flash < 5e-3) g.flash = 0;
    }
  }
  writeStatus(b);
}

/** A gun that can join a salvo now: loaded, has rounds, not already scheduled. */
const gunReady = (g: GunRuntime) => g.loaded && g.rounds > 0 && g.fireAt < 0;

/**
 * Schedule a salvo: every ready gun of every turret that is ON TARGET (and in its arc), rippled
 * `rippleS` apart turret by turret (centre gun, then the wings). A turret in its arc with a loaded gun
 * that is not on target yet is ARMED for `waitS` s: it fires the moment it comes on target
 * (`pollArmed`) — the firing key held closed until the roll brings the guns onto the line, as the
 * real director did. Returns the number of guns scheduled now.
 */
export function requestSalvo(b: Battery, only?: readonly boolean[], waitS = 0): number {
  let n = 0;
  for (let i = 0; i < b.turrets.length; i++) {
    const t = b.turrets[i];
    if (only && !only[i]) continue;
    if (!t.inArc || !t.guns.some(gunReady)) continue;
    if (!t.onTarget) {
      if (waitS > 0 && !t.tooFar) t.armedUntil = b.time + waitS;
      continue;
    }
    n += scheduleTurret(b, t);
  }
  if (n > 0) b.salvos++;
  return n;
}

function scheduleTurret(b: Battery, t: TurretRuntime): number {
  const ripple = Math.max(0, fin(b.cfg.rippleS, 0.15));
  // after the guns already queued, so turrets never fire on top of each other
  let start = b.time;
  for (const u of b.turrets) for (const g of u.guns) if (g.fireAt >= 0) start = Math.max(start, g.fireAt + ripple);
  let n = 0;
  for (const k of gunOrder(t.guns.length)) {
    const g = t.guns[k];
    if (!gunReady(g)) continue;
    g.fireAt = start + n * ripple;
    n++;
  }
  t.armedUntil = -1;
  return n;
}

/** Armed turrets that have come on target fire now; lapsed arms are dropped. Returns the guns scheduled. */
export function pollArmed(b: Battery): number {
  let n = 0;
  for (const t of b.turrets) {
    if (t.armedUntil < 0) continue;
    if (b.time > t.armedUntil || !t.inArc || t.tooFar) {
      t.armedUntil = -1;
      continue;
    }
    if (t.onTarget) n += scheduleTurret(b, t);
  }
  return n;
}

/** Turrets armed and waiting to come on target. */
export function armedCount(b: Battery): number {
  let n = 0;
  for (const t of b.turrets) if (t.armedUntil >= 0) n++;
  return n;
}

/** Firing order inside a turret: the centre gun first, then alternately the wings. */
function gunOrder(n: number): number[] {
  const out: number[] = [];
  const mid = (n - 1) / 2;
  const idx = Array.from({ length: n }, (_, k) => k).sort((a, c) => Math.abs(a - mid) - Math.abs(c - mid) || a - c);
  for (const k of idx) out.push(k);
  return out;
}

/** A scheduled gun whose turret is off the line waits for it this long before the shot is dropped (s). */
export const HOLD_FIRE_S = 4;

/**
 * The guns due to fire now: marks each one fired (unloaded, a round gone, reload started, recoil
 * and flash at 1) and appends it to `out` (cleared first). Returns the count. A due gun only fires
 * while its turret is ON TARGET (the firing key closes on the line: a ship rolling fast fires in
 * bursts at the moments its guns come onto the target), at most one gun per `rippleS`; a gun held
 * off the line for `HOLD_FIRE_S` is stood down (still loaded).
 */
export function dueShots(b: Battery, out: Shot[]): number {
  out.length = 0;
  const ripple = Math.max(0, fin(b.cfg.rippleS, 0.15));
  for (let i = 0; i < b.turrets.length; i++) {
    const t = b.turrets[i];
    for (let k = 0; k < t.guns.length; k++) {
      const g = t.guns[k];
      if (g.fireAt < 0 || g.fireAt > b.time + 1e-9) continue;
      // the order swung into the blind sector since the salvo was called, or the gun has nothing to fire
      if (!t.inArc || !g.loaded || g.rounds <= 0) {
        g.fireAt = -1;
        continue;
      }
      if (!t.onTarget) {
        if (b.time - g.fireAt > HOLD_FIRE_S) g.fireAt = -1;
        continue;
      }
      if (b.time - b.lastShotAt < ripple * 0.9) continue;
      g.fireAt = -1;
      g.loaded = false;
      g.rounds--;
      g.reloadLeft = g.rounds > 0 ? b.cfg.reloadS : 0;
      g.recoil = 1;
      g.flash = 1;
      b.shots++;
      b.lastShotAt = b.time;
      out.push({ turret: i, gun: k });
    }
  }
  if (out.length) writeStatus(b);
  return out.length;
}

/** Cancel every scheduled shot (e.g. the turret lost its solution). */
export function cancelSalvo(b: Battery): void {
  for (const t of b.turrets) {
    t.armedUntil = -1;
    for (const g of t.guns) g.fireAt = -1;
  }
}

/** Seconds until the next gun is loaded (0 if one is ready now; Infinity when all are empty). */
export function nextReadyS(b: Battery): number {
  let best = Infinity;
  for (const t of b.turrets) {
    for (const g of t.guns) {
      if (g.rounds <= 0) continue;
      if (g.loaded) return 0;
      best = Math.min(best, g.reloadLeft);
    }
  }
  return best;
}

export function roundsLeft(b: Battery): number {
  let n = 0;
  for (const t of b.turrets) for (const g of t.guns) n += g.rounds;
  return n;
}

function writeStatus(b: Battery): void {
  for (let i = 0; i < b.turrets.length; i++) {
    const t = b.turrets[i];
    const s = b.status[i];
    s.trainDeg = t.trainDeg;
    s.elevDeg = t.elevDeg;
    for (let k = 0; k < t.guns.length; k++) {
      const g = t.guns[k];
      s.recoil[k] = g.recoil;
      s.flash[k] = g.flash;
      s.ready[k] = g.loaded && g.rounds > 0;
    }
  }
}
