/**
 * PURE naval gunnery range (no three.js): the layout at sea (`CONFIG.combat.gunnery`) and its
 * runtime. North-west of Long Key, in 30–50 m of water between the island and the tanker lane:
 *
 *   - target rafts (a pontoon platform with a radar-reflector frame and a flag mast) and two hulked
 *     freighters, anchored (they swing a little on their moorings) and riding the drawn sea
 *     (heave / pitch / roll from `hullWaveMotion`, the same Gerstner trains the water shader draws);
 *   - a target sled towed round a racetrack by a tug (the tug is not a target);
 *   - yellow special-mark buoys at the corners and mid-sides of the range box.
 *
 * Every target is a combat-world target (`SeaKind`: raft / hulk / sled): the ship's guns, the F-16's
 * and A-10's guns and Mavericks can all hit them. A destroyed target burns, lists and sinks
 * (`sinkS`), its hull box is removed from play when it is under, and a fresh one is in place
 * `respawnS` later. `gunneryStart()` is the `?spawn=gunnery` start.
 */
import { CONFIG, type Config } from '../config';
import type { Vec3 } from '../types';
import type { GroundTarget, SeaKind } from './types';
import type { CombatWorld } from './world';

export const GUNNERY_GROUP = 'gunnery';

export interface RangeTargetPlan {
  kind: SeaKind;
  /** Anchor position (world x, z) and the heading it lies to, deg. */
  x: number;
  z: number;
  headingDeg: number;
  /** Draft (keel below the waterline), m. */
  draft: number;
  /** A per-target seed (model variation, motion phase). */
  seed: number;
}

export interface BuoyPlan {
  x: number;
  z: number;
}

export interface GunneryRangePlan {
  center: { x: number; z: number };
  targets: RangeTargetPlan[];
  buoys: BuoyPlan[];
  /** The towed sled's racetrack (centre, half length along x, half width along z, speed m/s, tow-line length m). */
  tow: { x: number; z: number; halfLength: number; halfWidth: number; speed: number; line: number };
  /** Range box (world x/z extents) — the buoys mark its corners and sides. */
  box: { x0: number; x1: number; z0: number; z1: number };
}

/** Drafts (m): how much of each target's hull box lies under the still waterline. */
export const DRAFT: Record<SeaKind, number> = { raft: 1.2, hulk: 5.2, sled: 0.8 };

/** The range layout (pure; a function of the config). */
export function planGunneryRange(cfg: Config = CONFIG): GunneryRangePlan {
  const g = cfg.combat.gunnery;
  const cx = g.center.x;
  const cz = g.center.z;
  const T = (kind: SeaKind, dx: number, dz: number, headingDeg: number, seed: number): RangeTargetPlan => ({ kind, x: cx + dx, z: cz + dz, headingDeg, draft: DRAFT[kind], seed });
  const targets: RangeTargetPlan[] = [
    T('hulk', -420, 260, 68, 11),
    T('hulk', 660, -300, 116, 23),
    T('raft', 0, 0, 20, 31),
    T('raft', -900, -360, 200, 43),
    T('raft', 320, 480, 95, 57),
    T('raft', 1150, 330, 310, 61),
    T('sled', 0, -560, 90, 73),
  ];
  const hx = 1650;
  const hz = 700;
  const box = { x0: cx - hx, x1: cx + hx, z0: cz - hz, z1: cz + hz };
  const buoys: BuoyPlan[] = [
    { x: box.x0, z: box.z0 }, { x: cx, z: box.z0 }, { x: box.x1, z: box.z0 },
    { x: box.x1, z: cz }, { x: box.x1, z: box.z1 }, { x: cx, z: box.z1 },
    { x: box.x0, z: box.z1 }, { x: box.x0, z: cz },
  ];
  return {
    center: { x: cx, z: cz },
    targets,
    buoys,
    tow: { x: cx - 150, z: cz - 90, halfLength: g.tow.length / 2, halfWidth: g.tow.width / 2, speed: g.tow.speed, line: g.tow.line },
    box,
  };
}

/** `?spawn=gunnery`: a ship stands off south of the range steaming east (the range on its port beam); an aircraft 6 km south heading north. */
export function gunneryStart(vessel: boolean, cfg: Config = CONFIG): { x: number; z: number; headingDeg: number; speedKt: number; aglFt: number } {
  const g = cfg.combat.gunnery;
  if (vessel) return { x: g.center.x, z: g.center.z + g.shipStandoffM, headingDeg: 90, speedKt: g.startKt, aglFt: 0 };
  return { x: g.center.x, z: g.center.z + 6000, headingDeg: 0, speedKt: 250, aglFt: 1500 };
}

// ─── Towing ──────────────────────────────────────────────────────────────────

/** A point `s` metres along a racetrack (two straights along x joined by semicircles), and the heading there. */
export function racetrackAt(tow: GunneryRangePlan['tow'], sIn: number, out: { x: number; z: number; headingDeg: number } = { x: 0, z: 0, headingDeg: 0 }): { x: number; z: number; headingDeg: number } {
  const r = tow.halfWidth;
  const L = 2 * Math.max(0, tow.halfLength - r); // straight length
  const per = 2 * L + 2 * Math.PI * r;
  let s = ((Number.isFinite(sIn) ? sIn : 0) % per + per) % per;
  const x0 = tow.x - L / 2;
  const x1 = tow.x + L / 2;
  if (s < L) {
    // south straight, heading east (+x)
    out.x = x0 + s;
    out.z = tow.z + r;
    out.headingDeg = 90;
    return out;
  }
  s -= L;
  if (s < Math.PI * r) {
    // east turn, anticlockwise seen from above… north-going: centre (x1, tow.z)
    const a = s / r; // 0..π
    out.x = x1 + r * Math.sin(a);
    out.z = tow.z + r * Math.cos(a);
    out.headingDeg = 90 - (a * 180) / Math.PI;
    return out;
  }
  s -= Math.PI * r;
  if (s < L) {
    out.x = x1 - s;
    out.z = tow.z - r;
    out.headingDeg = 270;
    return out;
  }
  s -= L;
  const a = s / r;
  out.x = x0 - r * Math.sin(a);
  out.z = tow.z - r * Math.cos(a);
  out.headingDeg = 270 - (a * 180) / Math.PI;
  return out;
}

export const racetrackLength = (tow: GunneryRangePlan['tow']): number => {
  const r = tow.halfWidth;
  const L = 2 * Math.max(0, tow.halfLength - r);
  return 2 * L + 2 * Math.PI * r;
};

// ─── Runtime ─────────────────────────────────────────────────────────────────

export type RangeTargetPhase = 'afloat' | 'sinking' | 'sunk';

export interface RangeTargetRuntime {
  readonly plan: RangeTargetPlan;
  target: GroundTarget;
  phase: RangeTargetPhase;
  /** Seconds since it was destroyed. */
  since: number;
  /** Visual pose: waterline centre (world), heading, pitch (bow up +), roll (starboard down +), deg; sink depth (m, ≥ 0). */
  x: number;
  y: number;
  z: number;
  headingDeg: number;
  pitchDeg: number;
  rollDeg: number;
  sink: number;
  /** Damage 0..1 (1 - health / max): scorch marks, fires. */
  damage: number;
}

export interface WaveSampler {
  /** Heave (m) and the slope pitch / roll (deg) of a hull L × B heading h at x, z. */
  motion(x: number, z: number, headingDeg: number, L: number, B: number, out: { heave: number; pitch: number; roll: number }): void;
}

export interface GunneryRange {
  readonly plan: GunneryRangePlan;
  readonly targets: RangeTargetRuntime[];
  /** The tug towing the sled: pose (world) and heading. */
  readonly tug: { x: number; z: number; headingDeg: number; y: number; pitchDeg: number; rollDeg: number };
  /** Register the targets with the world (idempotent). */
  install(): void;
  update(dt: number, time: number, waves?: WaveSampler | null): void;
  /** Everything afloat and whole again, at its start. */
  reset(): void;
  /** Destroy a target by id (QA). */
  kill(id: number, time?: number): boolean;
  dispose(): void;
}

const flat: WaveSampler = { motion: (_x, _z, _h, _L, _B, o) => ((o.heave = 0), (o.pitch = 0), (o.roll = 0), undefined) };

export function createGunneryRange(world: CombatWorld, cfg: Config = CONFIG): GunneryRange {
  const plan = planGunneryRange(cfg);
  const g = cfg.combat.gunnery;
  const targets: RangeTargetRuntime[] = [];
  const tug = { x: 0, z: 0, headingDeg: 0, y: 0, pitchDeg: 0, rollDeg: 0 };
  const trackLen = racetrackLength(plan.tow);
  let towS = 0;
  let installed = false;
  const wm = { heave: 0, pitch: 0, roll: 0 };
  const P = { x: 0, z: 0, headingDeg: 0 };

  const place = (r: RangeTargetRuntime) => {
    const t = r.target;
    t.position.x = r.x;
    t.position.z = r.z;
    t.position.y = r.y - r.plan.draft - r.sink;
    if (r.phase === 'sunk') t.position.y = -1e4; // out of play until it respawns
    t.headingDeg = r.headingDeg;
  };

  const spawn = (r: RangeTargetRuntime) => {
    const t = r.target;
    t.alive = true;
    t.health = t.maxHealth;
    t.destroyedAt = null;
    r.phase = 'afloat';
    r.since = 0;
    r.sink = 0;
    r.damage = 0;
    r.x = r.plan.x;
    r.z = r.plan.z;
    r.headingDeg = r.plan.headingDeg;
  };

  const range: GunneryRange = {
    plan,
    targets,
    tug,

    install() {
      if (installed) return;
      installed = true;
      for (const p of plan.targets) {
        const t = world.addTarget({ kind: p.kind, position: { x: p.x, y: -p.draft, z: p.z }, headingDeg: p.headingDeg, group: GUNNERY_GROUP });
        targets.push({ plan: p, target: t, phase: 'afloat', since: 0, x: p.x, y: 0, z: p.z, headingDeg: p.headingDeg, pitchDeg: 0, rollDeg: 0, sink: 0, damage: 0 });
      }
      range.update(0, 0, null);
    },

    update(dtIn, time, waves) {
      if (!installed) return;
      const dt = Number.isFinite(dtIn) && dtIn > 0 ? Math.min(dtIn, 0.5) : 0;
      const W = waves ?? flat;
      towS = (towS + plan.tow.speed * dt) % trackLen;
      for (const r of targets) {
        const t = r.target;
        const cls = world.classOf(t.kind);
        // the world is the truth for alive / destroyed (any weapon)
        if (!t.alive && r.phase === 'afloat') {
          r.phase = 'sinking';
          r.since = 0;
        }
        // a target someone else revived (world.reviveAll on a reset): back afloat
        if (t.alive && r.phase !== 'afloat') spawn(r);
        r.damage = t.maxHealth > 0 ? 1 - Math.max(0, t.health) / t.maxHealth : 0;
        if (r.phase !== 'afloat') {
          r.since += dt;
          const sinkS = Math.max(1, (g.sinkS as Record<SeaKind, number>)[r.plan.kind] ?? 20);
          const f = Math.min(1, r.since / sinkS);
          // slow at first (flooding), then going: sink below the keel + height
          r.sink = (cls.height + 4) * f * f;
          if (r.phase === 'sinking' && f >= 1) r.phase = 'sunk';
          if (r.since >= sinkS + g.respawnS) spawn(r);
        }
        if (r.plan.kind === 'sled') {
          // the tug leads on the racetrack; the sled follows `line` metres behind it
          racetrackAt(plan.tow, towS, P);
          tug.x = P.x;
          tug.z = P.z;
          tug.headingDeg = P.headingDeg;
          if (r.phase === 'afloat') {
            racetrackAt(plan.tow, towS - plan.tow.line, P);
            r.x = P.x;
            r.z = P.z;
            r.headingDeg = P.headingDeg;
            const h = (P.headingDeg * Math.PI) / 180;
            t.velocity.x = Math.sin(h) * plan.tow.speed;
            t.velocity.z = -Math.cos(h) * plan.tow.speed;
          } else {
            t.velocity.x = 0;
            t.velocity.z = 0;
          }
        } else {
          // swinging gently on the anchor
          const sw = 6 * Math.sin(time * 0.021 + r.plan.seed);
          r.headingDeg = r.plan.headingDeg + sw;
          t.velocity.x = 0;
          t.velocity.z = 0;
        }
        W.motion(r.x, r.z, r.headingDeg, cls.length, cls.width, wm);
        r.y = wm.heave;
        r.pitchDeg = wm.pitch;
        r.rollDeg = wm.roll;
        if (r.phase !== 'afloat') {
          // a wreck lists and goes down by the head (hulk) or turns turtle (raft)
          const f = Math.min(1, r.since / Math.max(1, (g.sinkS as Record<SeaKind, number>)[r.plan.kind] ?? 20));
          const s = r.plan.seed % 2 ? 1 : -1;
          r.rollDeg += s * (r.plan.kind === 'hulk' ? 14 : 35) * f;
          r.pitchDeg += (r.plan.kind === 'hulk' ? -9 : 6) * f;
        }
        place(r);
      }
      W.motion(tug.x, tug.z, tug.headingDeg, 28, 8.5, wm);
      tug.y = wm.heave;
      tug.pitchDeg = wm.pitch;
      tug.rollDeg = wm.roll;
    },

    reset() {
      towS = 0;
      for (const r of targets) spawn(r);
      range.update(0, 0, null);
    },

    kill(id, time = 0) {
      const r = targets.find((x) => x.target.id === id);
      if (!r || !r.target.alive) return false;
      return world.applyHit(id, { weapon: 'shell', damage: 1e6, point: { ...r.target.position }, direction: { x: 0, y: -1, z: 0 }, time, face: 'top' }).destroyed;
    },

    dispose() {
      for (const r of targets) {
        const i = world.targets.indexOf(r.target);
        if (i >= 0) (world.targets as GroundTarget[]).splice(i, 1);
      }
      targets.length = 0;
      installed = false;
    },
  };
  return range;
}

/** Points the range occupies (targets, buoys, the tow's racetrack) — for keep-out tests. */
export function rangeFootprint(plan: GunneryRangePlan): Vec3[] {
  const pts: Vec3[] = plan.targets.map((t) => ({ x: t.x, y: 0, z: t.z }));
  for (const b of plan.buoys) pts.push({ x: b.x, y: 0, z: b.z });
  const n = 24;
  for (let i = 0; i < n; i++) {
    const p = racetrackAt(plan.tow, (racetrackLength(plan.tow) * i) / n);
    pts.push({ x: p.x, y: 0, z: p.z });
  }
  return pts;
}
