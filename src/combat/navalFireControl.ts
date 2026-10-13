/**
 * PURE fire control of a ship's main battery (no three.js), driven by src/game/systems/navalGuns.ts
 * and by the headless tests. Each update:
 *
 *   1. every turret's fire-control solution to the aim point from its centre gun's muzzle
 *      (src/combat/naval.ts — drag, the ship's velocity, a moving target's lead), re-solved every
 *      `SOLVE_EVERY_S` (staggered) or at once when the aim jumps;
 *   2. the solution's world bore → DECK angles on the ship as it rolls and pitches right now
 *      (`deckAngles`), ordered to the turret (it trains / elevates at its real rates inside its arc);
 *   3. ON TARGET = the guns' predicted miss at the aim point (from their actual train / elevation)
 *      under `onTargetMissM`, the order in the arc and the solution in range;
 *   4. the guns the battery says are due fire: a shell from each muzzle along its actual bore, with
 *      the round-to-round dispersion (`dispersionMrad` both ways, `muzzleVelocitySpread`) and the
 *      ship's velocity;
 *   5. the shells fly (src/combat/navalShells.ts) and burst on targets, land or water.
 *
 * `fire()` asks for a salvo: every loaded gun of every turret on target, rippled `rippleS` apart.
 */
import type { NavalGunsConfig } from '../config';
import type { Environment, Quat, Vec3 } from '../types';
import type { CombatWorld } from './world';
import { armedCount, createBattery, dueShots, orderTurret, pollArmed, requestSalvo, resetBattery, stepBattery, nextReadyS, roundsLeft, type Battery, type Shot } from './navalBattery';
import { deckAngles, gunDirection, missComponents, muzzlePosition, newFireSolution, rotateByQuat, solveFireControl, toArc, worldBore, type FireSolution } from './naval';
import { createNavalShells, type NavalShells, type ShellImpact } from './navalShells';
import { createRng, type Rng } from './rng';

export interface ShipPose {
  position: Vec3;
  /** Body → world. */
  orientation: Quat;
  velocity: Vec3;
}

export interface FiredShot {
  turret: number;
  gun: number;
  muzzle: Vec3;
  /** Bore direction (unit, world) and the shell's launch velocity (world, the ship's included). */
  dir: Vec3;
  velocity: Vec3;
  time: number;
}

export type SalvoRefusal = 'no-aim' | 'out-of-range' | 'no-bearing' | 'training' | 'reloading' | 'empty' | null;

export interface NavalController {
  readonly guns: NavalGunsConfig;
  readonly battery: Battery;
  readonly shells: NavalShells;
  readonly solutions: FireSolution[];
  /** The aim this update: point (world), its velocity, a locked target id. */
  readonly aim: { valid: boolean; point: Vec3; velocity: Vec3; targetId: number | null };
  /** Aim at a point (world; the sea: y = sea level) moving at `velocity`, or null for none (the turrets stow). */
  setAim(point: Vec3 | null, velocity?: Vec3 | null, targetId?: number | null): void;
  /**
   * Ask for a salvo: the guns scheduled now, the turrets armed to fire the moment they come on target
   * (within `SALVO_WAIT_S`), and why nothing could fire.
   */
  fire(): { scheduled: number; armed: number; refusal: SalvoRefusal };
  update(pose: ShipPose, dt: number, time: number, onShot?: (s: FiredShot) => void, onImpact?: (i: ShellImpact) => void): void;
  reset(): void;
  /** Index of the turret whose solution the HUD quotes (range / time of flight): the first with one. */
  referenceTurret(): number;
  stats(): { solves: number; flights: number; nextReadyS: number; rounds: number };
}

/** Seconds between re-solves of one turret while the aim holds still. */
export const SOLVE_EVERY_S = 0.12;
/** A salvo called while a turret is still coming onto the line waits this long for it (s). */
export const SALVO_WAIT_S = 4;

const DEG = Math.PI / 180;

export function createNavalController(world: CombatWorld, env: Environment, guns: NavalGunsConfig, seed = 0x16a7): NavalController {
  const battery = createBattery(guns);
  const shells = createNavalShells(world, env);
  const n = guns.turrets.length;
  const solutions = guns.turrets.map(() => newFireSolution());
  const solved = new Array<boolean>(n).fill(false);
  const lastSolve = new Float64Array(n).fill(-1e9);
  const lastAim = guns.turrets.map(() => ({ x: NaN, y: NaN, z: NaN }));
  const aim = { valid: false, point: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, targetId: null as number | null };
  const rng: Rng = createRng(seed);
  const shots: Shot[] = [];
  const M = { x: 0, y: 0, z: 0 };
  const W = { x: 0, y: 0, z: 0 };
  const D = { x: 0, y: 0, z: 0 };
  const deck = { trainDeg: 0, elevDeg: 0 };
  const MC = { along: 0, across: 0 };
  /** Each turret's signed along-the-line miss at the last update (m), to catch the bore sweeping through the line. */
  const prevAlong = new Float64Array(n);
  let solves = 0;
  let flights = 0;
  let stagger = 0;

  const muzzleWorld = (pose: ShipPose, i: number, k: number, out: Vec3) => {
    const t = battery.turrets[i];
    muzzlePosition(t.cfg, t.trainDeg, t.elevDeg, k, M);
    rotateByQuat(pose.orientation, M.x, M.y, M.z, out);
    out.x += pose.position.x;
    out.y += pose.position.y;
    out.z += pose.position.z;
    return out;
  };

  const ctl: NavalController = {
    guns,
    battery,
    shells,
    solutions,
    aim,

    setAim(point, velocity, targetId) {
      if (!point || !Number.isFinite(point.x + point.y + point.z)) {
        aim.valid = false;
        aim.targetId = null;
        return;
      }
      aim.valid = true;
      aim.point.x = point.x;
      aim.point.y = point.y;
      aim.point.z = point.z;
      aim.velocity.x = velocity && Number.isFinite(velocity.x) ? velocity.x : 0;
      aim.velocity.y = velocity && Number.isFinite(velocity.y) ? velocity.y : 0;
      aim.velocity.z = velocity && Number.isFinite(velocity.z) ? velocity.z : 0;
      aim.targetId = targetId ?? null;
    },

    fire() {
      if (!aim.valid) return { scheduled: 0, armed: 0, refusal: 'no-aim' };
      const n0 = requestSalvo(battery, undefined, SALVO_WAIT_S);
      const armed = armedCount(battery);
      if (n0 > 0 || armed > 0) return { scheduled: n0, armed, refusal: null };
      if (roundsLeft(battery) === 0) return { scheduled: 0, armed: 0, refusal: 'empty' };
      const any = (f: (i: number) => boolean) => battery.turrets.some((_, i) => f(i));
      if (!any((i) => battery.turrets[i].inArc)) return { scheduled: 0, armed: 0, refusal: 'no-bearing' };
      if (!any((i) => solved[i] && solutions[i].ok)) return { scheduled: 0, armed: 0, refusal: 'out-of-range' };
      if (any((i) => battery.turrets[i].inArc && !battery.turrets[i].guns.some((g) => g.loaded && g.rounds > 0))) return { scheduled: 0, armed: 0, refusal: 'reloading' };
      return { scheduled: 0, armed: 0, refusal: 'training' };
    },

    update(pose, dtIn, time, onShot, onImpact) {
      const dt = Number.isFinite(dtIn) && dtIn > 0 ? Math.min(dtIn, 0.5) : 0;
      const q = pose.orientation;
      // 1–2. solutions → deck-angle orders
      stagger = (stagger + 1) % Math.max(1, n);
      for (let i = 0; i < n; i++) {
        const t = battery.turrets[i];
        if (!aim.valid) {
          orderTurret(battery, i, null, null);
          solved[i] = false;
          continue;
        }
        const la = lastAim[i];
        const jump = Math.hypot(aim.point.x - la.x, aim.point.z - la.z);
        const rng0 = solved[i] ? Math.max(500, solutions[i].rangeM) : 1;
        const due = !solved[i] || jump > 0.004 * rng0 + 3 || (time - lastSolve[i] >= SOLVE_EVERY_S && (i === stagger || time - lastSolve[i] >= SOLVE_EVERY_S * n));
        if (due) {
          muzzleWorld(pose, i, (t.cfg.barrels - 1) / 2, W);
          const s = solveFireControl(guns, {
            muzzle: W, shipVelocity: pose.velocity, target: aim.point, targetVelocity: aim.velocity,
            elevMinDeg: t.cfg.elevMinDeg, elevMaxDeg: t.cfg.elevMaxDeg, guessElevDeg: solved[i] ? solutions[i].elevDeg : undefined,
          }, solutions[i]);
          solves++;
          flights += s.flights;
          solved[i] = true;
          lastSolve[i] = time;
          la.x = aim.point.x; la.y = aim.point.y; la.z = aim.point.z;
        }
        deckAngles(q, solutions[i].dir, deck);
        orderTurret(battery, i, deck.trainDeg, deck.elevDeg, dt);
      }
      // the turrets move, the guns reload
      stepBattery(battery, dt);
      // 3. on target?
      for (let i = 0; i < n; i++) {
        const t = battery.turrets[i];
        const s = solutions[i];
        if (!aim.valid || !solved[i]) {
          t.onTarget = false;
          t.missM = Infinity;
          t.tooFar = aim.valid;
          continue;
        }
        worldBore(q, t.trainDeg, t.elevDeg, D);
        missComponents(s, D, MC);
        t.missM = Number.isFinite(MC.along + MC.across) ? Math.hypot(MC.along, MC.across) : Infinity;
        t.tooFar = s.tooFar || s.tooClose || !s.ok;
        deckAngles(q, s.dir, deck);
        const elevOk = deck.elevDeg >= t.cfg.elevMinDeg - 0.05 && deck.elevDeg <= t.cfg.elevMaxDeg + 0.05;
        const tol = Math.max(guns.onTargetMissM, guns.onTargetRangeFraction * s.rangeM);
        // on the line now — or the bore swept across it since the last update (a ship rolling faster than
        // the guns can follow crosses the line between frames: the director fires as it comes through)
        const swept = prevAlong[i] * MC.along < 0 && Math.abs(MC.along) <= 3 * tol && Math.abs(prevAlong[i]) <= 6 * tol;
        prevAlong[i] = MC.along;
        t.onTarget = s.ok && t.inArc && elevOk && toArc(t.cfg, deck.trainDeg) !== null && Math.abs(MC.across) <= tol && (t.missM <= tol || swept);
      }
      // armed turrets fire as they come onto the line
      pollArmed(battery);
      // 4. shots due
      if (dueShots(battery, shots) > 0) {
        for (const sh of shots) {
          const t = battery.turrets[sh.turret];
          const muzzle = muzzleWorld(pose, sh.turret, sh.gun, { x: 0, y: 0, z: 0 });
          // bore with dispersion: two small angles about the bore (elevation, train), deck frame
          const sig = guns.dispersionMrad * 1e-3 / DEG;
          const b = gunDirection(t.trainDeg + rng.gauss() * sig, t.elevDeg + rng.gauss() * sig, { x: 0, y: 0, z: 0 });
          const dir = rotateByQuat(q, b.x, b.y, b.z, { x: 0, y: 0, z: 0 });
          const v0 = guns.muzzleVelocity * (1 + rng.gauss() * guns.muzzleVelocitySpread);
          const velocity = { x: dir.x * v0 + pose.velocity.x, y: dir.y * v0 + pose.velocity.y, z: dir.z * v0 + pose.velocity.z };
          shells.fire(guns, muzzle, velocity, time, sh.turret, sh.gun);
          world.emit({ type: 'navalFire', time, turret: sh.turret, gun: sh.gun, position: { ...muzzle }, direction: { ...dir }, caliberMm: guns.caliberMm });
          onShot?.({ turret: sh.turret, gun: sh.gun, muzzle, dir, velocity, time });
        }
      }
      // 5. shells
      shells.update(guns, dt, time, onImpact);
    },

    reset() {
      resetBattery(battery);
      shells.clear();
      solved.fill(false);
      prevAlong.fill(0);
      lastSolve.fill(-1e9);
      for (const a of lastAim) a.x = a.y = a.z = NaN;
      aim.valid = false;
      aim.targetId = null;
    },

    referenceTurret() {
      let best = -1;
      for (let i = 0; i < n; i++) {
        if (!solved[i]) continue;
        if (best < 0) best = i;
        if (battery.turrets[i].inArc && !battery.turrets[best].inArc) best = i;
      }
      return best;
    },

    stats: () => ({ solves, flights, nextReadyS: nextReadyS(battery), rounds: roundsLeft(battery) }),
  };
  return ctl;
}
