/**
 * Headless harness for scripts/qa-pilot.js: runs the SAME in-page QA pilot against the real physics
 * in node, through the real keyboard pipeline (held keys + key-down edges → updateControls →
 * step at 120 Hz), with a virtual clock. The pilot sees `buildSimSnapshot()` — exactly what
 * `window.sim` shows in the browser — so what it does here is what it does in Chrome.
 *
 *   const run = createHeadlessRun({ aircraft: 'c172rg', start: 'approach', wind: { fromDeg: 360, kt: 10 } });
 *   await run.pilot.approachAndLand();
 *   run.state.touchdown?.rating
 */
import '../../scripts/qa-pilot.js';
import type { AircraftState, Controls, Environment, Vec3 } from '../../src/types';
import { type Config } from '../../src/config';
import { approachControls, createApproachState, createInitialState, createTrimmedState, step } from '../../src/physics';
import { createEnvironment } from '../../src/world/environment';
import { createControlState, emptyInputFrame, resetControls, updateControls, type ControlState, type KeyPress } from '../../src/input/controlSystem';
import { buildSimSnapshot } from '../../src/game/simApi';
import { getAircraftDef } from '../../src/fleet/index';
import { createCombatWorld, type CombatWorld } from '../../src/combat/world';
import { createGunnery, type Gunnery } from '../../src/combat/gunnery';
import type { NewTarget, RangeInfo } from '../../src/combat/types';

/** What scripts/qa-pilot.js puts on globalThis (typed loosely: it is plain JS). */
export interface QaPilotLib {
  profileFor(id: string, ac?: unknown, weapons?: unknown): QaProfile;
  flareHeightFt(sinkFpm: number, p: QaProfile): number;
  flareSinkFpm(wheelFt: number, sinkAtEntryFpm: number, p: QaProfile): number;
  flarePitch(wheelFt: number, vsFpm: number, aoaDeg: number, groundKt: number, pitchDeg: number, sinkAtEntryFpm: number, p: QaProfile): number;
  landingPitchTarget(wheelFt: number, vsFpm: number, aoaDeg: number, groundKt: number, pitchDeg: number, approachPitchDeg: number, entrySinkFpm: number | null, p: QaProfile): { mode: 'approach' | 'flare'; pitch: number };
  machFrom(iasKt: number, altFt: number): number;
  glidePathTargets(s: Record<string, unknown>, p: QaProfile, rw: unknown): { vsFpm: number; rollDeg: number; aboveFt: number; distM: number };
  createPilot(driver: QaDriver, opts?: { profile?: QaProfile; runway?: unknown }): QaPilot;
  [k: string]: unknown;
}
export interface QaProfile {
  id: string;
  vrKt: number;
  approachKt: number;
  gearOffsetFt: number;
  flareMinFt: number;
  flareMaxFt: number;
  flareLeadS: number;
  touchdownSinkFpm: number;
  maxFlarePitchDeg: number;
  firmFpm: number;
  [k: string]: unknown;
}
export interface QaDriver {
  read(): Record<string, unknown>;
  key(code: string, down: boolean, shift?: boolean): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}
export type QaPilot = Record<string, unknown> & {
  phase: string;
  profile: QaProfile;
  stats: Record<string, unknown>;
  log: Record<string, unknown>[];
  init(): Promise<QaProfile>;
  takeoff(): Promise<string>;
  climbTo(aglFt: number, o?: Record<string, unknown>): Promise<string>;
  turn(deg: number, bank?: number): Promise<string>;
  approachAndLand(): Promise<string>;
  circuit(opts?: Record<string, unknown>): Promise<string>;
  gTurn(g: number, deg: number): Promise<string>;
  dash(opts?: Record<string, unknown>): Promise<Record<string, number>>;
  gotoPoint(x: number, z: number, opts?: Record<string, unknown>): Promise<string>;
  rtbAndLand(): Promise<string>;
};

export const qa = (globalThis as unknown as { qaPilotLib: QaPilotLib }).qaPilotLib;

export interface Wind {
  /** Direction the wind blows FROM, deg true. */
  fromDeg: number;
  kt: number;
  /** Gust amplitude, kt (a slow sine on top). */
  gustKt?: number;
}

export interface HeadlessOpts {
  aircraft: 'c172rg' | 'f16' | 'a10' | 'b747';
  start: 'runway' | 'approach' | { x: number; z: number; aglFt: number; headingDeg: number; speedKt: number; gearDown?: boolean; flapsNotch?: number };
  wind?: Wind;
  /** Multiply the aircraft mass (weights). */
  massFactor?: number;
  env?: Environment;
  /** Give up after this much sim time, s (the pilot's `sleep` then throws). */
  maxSimS?: number;
  /**
   * A combat world with these vehicles on the ground (y from the terrain) and the aircraft's gun
   * (the pure gun core, src/combat/gunnery.ts, as the weapons system runs it): `window.sim.combat`
   * then shows the weapons status, the CCIP, the stats and list() exactly as in the browser.
   */
  combat?: { targets: NewTarget[]; range?: RangeInfo | null };
}

export interface HeadlessRun {
  pilot: QaPilot;
  cfg: Config;
  readonly state: AircraftState;
  readonly controls: Controls;
  /** Sim time, s. */
  readonly t: number;
  /** Every touchdown record seen (bounces included), in order. */
  touchdowns: NonNullable<AircraftState['touchdown']>[];
  /** The combat world and the gun (with `combat`). */
  world: CombatWorld | null;
  gunnery: Gunnery | null;
  /** Max |vs| (fpm) sampled in the 0.3 s before each wheel contact. */
  trace: { t: number; agl: number; vs: number; pitch: number; ias: number; el: number; thr: number; roll: number; x: number; z: number; hdg: number }[];
}

const KT_MS = 1 / 1.943844;

export function windField(w: Wind | undefined): Environment['wind'] | undefined {
  if (!w || (w.kt === 0 && !w.gustKt)) return undefined;
  const from = (w.fromDeg * Math.PI) / 180;
  // The wind blows FROM `from`: the air moves toward from + 180°. World +X east, +Z south.
  const dirX = -Math.sin(from);
  const dirZ = Math.cos(from);
  return (_x: number, _y: number, _z: number, t: number): Vec3 => {
    const kt = w.kt + (w.gustKt ?? 0) * Math.sin(t * 0.7) * Math.sin(t * 0.23 + 1);
    const v = kt * KT_MS;
    return { x: dirX * v, y: 0, z: dirZ * v };
  };
}

let sharedEnv: Environment | null = null;
function worldEnv(): Environment {
  sharedEnv ??= createEnvironment();
  return sharedEnv;
}

export function createHeadlessRun(o: HeadlessOpts): HeadlessRun {
  const def = getAircraftDef(o.aircraft);
  const base = def.config;
  const cfg: Config = o.massFactor && o.massFactor !== 1 ? { ...base, aircraft: { ...base.aircraft, mass: base.aircraft.mass * o.massFactor } } : base;
  const baseEnv = o.env ?? worldEnv();
  const wind = windField(o.wind);
  const env: Environment = wind ? { ...baseEnv, groundHeight: baseEnv.groundHeight.bind(baseEnv), surfaceAt: baseEnv.surfaceAt.bind(baseEnv), waterLevel: baseEnv.waterLevel.bind(baseEnv), obstacleTop: baseEnv.obstacleTop?.bind(baseEnv), wind } as Environment : baseEnv;

  let state: AircraftState;
  let cs: ControlState = createControlState(cfg);
  if (o.start === 'runway') {
    state = createInitialState(env, cfg);
  } else if (o.start === 'approach') {
    state = createApproachState(env, cfg);
    cs = resetControls(cs, approachControls(cfg));
  } else {
    const st = o.start;
    const g = Math.max(env.groundHeight(st.x, st.z), env.waterLevel(st.x, st.z) ?? -Infinity);
    const tr = createTrimmedState({ altitudeM: g + st.aglFt / 3.280839895, iasKt: st.speedKt, headingDeg: st.headingDeg, x: st.x, z: st.z, gearDown: st.gearDown ?? false, flapsNotch: st.flapsNotch ?? 0 }, env, cfg);
    state = tr.state;
    cs = resetControls(cs, tr.controls);
  }

  // ── Combat: the world, the vehicles, the gun ──
  let world: CombatWorld | null = null;
  let gunnery: Gunnery | null = null;
  if (o.combat) {
    world = createCombatWorld(cfg);
    world.range = o.combat.range ?? null;
    for (const t of o.combat.targets) world.addTarget({ ...t, position: { ...t.position, y: env.groundHeight(t.position.x, t.position.z) } });
    gunnery = createGunnery(world, env, { seed: 0x5eed });
    gunnery.setGun(cfg.weapons?.gun ?? null, 0);
  }
  const combatSnapshot = () => {
    const w = world!;
    return {
      ...w.status,
      stats: { ...w.stats },
      range: w.range,
      targets: w.targets.length,
      alive: w.targets.filter((t) => t.alive).length,
      list: () => w.targets.map((t) => ({ id: t.id, kind: t.kind, alive: t.alive, health: t.health, x: t.position.x, y: t.position.y, z: t.position.z, headingDeg: t.headingDeg, group: t.group })),
    };
  };

  const held = new Set<string>();
  let pressed: KeyPress[] = [];
  let shift = false;
  const frameS = 1 / 60;
  const physDt = cfg.sim.fixedDt;
  let simMs = 0;
  let accMs = 0;
  const maxMs = (o.maxSimS ?? 900) * 1000;
  const fps = { fps: 60, avg: 60, min: 60, onePercentLow: 60, longFrames: 0, frames: 0 };
  const run: HeadlessRun = {
    pilot: null as unknown as QaPilot,
    cfg,
    get state() { return state; },
    get controls() { return cs.controls; },
    get t() { return state.time; },
    touchdowns: [],
    world,
    gunnery,
    trace: [],
  };
  let snap: Record<string, unknown> = {};
  const refresh = () => {
    snap = buildSimSnapshot({ state, controls: cs.controls, fps, cameraMode: 'chase', paused: false }) as unknown as Record<string, unknown>;
    snap.aircraft = def.id;
    if (world) snap.combat = combatSnapshot();
  };
  refresh();
  let lastTd: unknown = null;
  let lastTraceT = -1;
  const frame = () => {
    cs = updateControls(cs, { ...emptyInputFrame(), held, pressed, shift }, frameS, cfg).state;
    pressed = [];
    // The gun (like the weapons system's adjustControls): barrels, ammo, gunFiring → recoil.
    const controls = gunnery ? gunnery.adjustControls(cs.controls, state.phase === 'crashed', frameS) : cs.controls;
    const n = Math.round(frameS / physDt);
    for (let i = 0; i < n; i++) {
      if (state.phase === 'crashed') break;
      state = step(state, controls, physDt, env, cfg);
      if (state.touchdown && state.touchdown !== lastTd) {
        lastTd = state.touchdown;
        run.touchdowns.push(state.touchdown);
      }
    }
    simMs += frameS * 1000;
    fps.frames++;
    // The rounds fly, hit, and the CCIP is solved (like the weapons system's update).
    gunnery?.update({ position: state.position, orientation: state.orientation }, state.velocity, frameS, state.time, false);
    if (state.time - lastTraceT >= 0.25) {
      lastTraceT = state.time;
      const d = state.derived;
      run.trace.push({
        t: +state.time.toFixed(2), agl: +(d.altitudeAGL * 3.2808).toFixed(1), vs: Math.round(d.verticalSpeed * 196.85), pitch: +d.pitchDeg.toFixed(1),
        ias: +(d.ias * 1.943844).toFixed(1), el: +cs.controls.elevator.toFixed(2), thr: +cs.controls.throttle.toFixed(2), roll: +d.rollDeg.toFixed(1),
        x: Math.round(state.position.x), z: Math.round(state.position.z), hdg: Math.round(d.headingDeg),
      });
    }
    refresh();
  };
  const driver: QaDriver = {
    read: () => snap,
    key(code, down, sh = false) {
      if (down) {
        if (!held.has(code)) pressed.push({ code, shift: sh });
        held.add(code);
        shift = sh;
      } else {
        held.delete(code);
        shift = false;
      }
    },
    async sleep(ms) {
      if (simMs > maxMs) throw new Error(`headless run exceeded ${maxMs / 1000} s of sim time`);
      accMs += Math.max(0, ms);
      const fm = frameS * 1000;
      while (accMs >= fm) {
        accMs -= fm;
        frame();
      }
    },
    now: () => simMs,
  };
  run.pilot = qa.createPilot(driver, { profile: qa.profileFor(def.id, cfg.aircraft, cfg.weapons) });
  return run;
}
