/**
 * The 172RG landing-gear warning system, PURE (no DOM, no audio): what the gear
 * position lights show, when the intermittent gear horn sounds, and the
 * squat-switch and gear-speed cautions. Shared by the HUD annunciators, the
 * cockpit panel (drawPanel) and the audio horn so they never disagree.
 *
 *   • In flight with the gear not down and locked, the horn sounds and the red
 *     GEAR annunciator flashes when the throttle is pulled back below
 *     hud.gearWarning.throttleBelowPct, or the flaps reach flapsAtOrAboveDeg.
 *     Lowering the gear (down and locked) cancels it.
 *   • On the ground with the handle UP, the squat switch keeps the gear down and
 *     the horn sounds: amber "GEAR — SQUAT SWITCH".
 *   • Gear overspeed: gear down above VLE, or in transit above VLO.
 *   • Lights: three greens down and locked, red in transit, off when up.
 *
 * Total: NaN/±Infinity inputs give a defined answer (fuzz-tested).
 */
import { CONFIG, type Config } from '../config';
import type { GearState, InstrumentReadings } from '../types';

export interface GearWarningInput {
  /** Weight on wheels (the squat switch). */
  onGround: boolean;
  crashed: boolean;
  gear: GearState;
  /** Gear handle position: true = DOWN. */
  handleDown: boolean;
  /** Throttle lever, 0..100 %. */
  throttlePct: number;
  flapsDeg: number;
  /** Indicated airspeed, kt. */
  iasKt: number;
}

export interface GearWarning {
  /** The intermittent gear warning horn is sounding. */
  horn: boolean;
  /** Red GEAR: airborne, gear not down and locked, low power or landing flaps. */
  gearUnsafe: boolean;
  /** Amber: gear handle UP on the ground (the squat switch is holding the gear down). */
  squatSwitch: boolean;
  /** Amber: gear speed limit exceeded (VLE with the gear down, VLO in transit). */
  overspeed: boolean;
  /** Gear position lights. */
  lights: 'green' | 'red' | 'off';
}

const num = (v: number, nanAs: number) => (Number.isNaN(v) ? nanAs : v);

export function gearWarning(inp: GearWarningInput, cfg: Config = CONFIG): GearWarning {
  const gw = cfg.hud.gearWarning;
  const lights: GearWarning['lights'] = inp.gear === 'down' ? 'green' : inp.gear === 'transit' ? 'red' : 'off';
  if (inp.crashed) return { horn: false, gearUnsafe: false, squatSwitch: false, overspeed: false, lights };
  const onGround = !!inp.onGround;
  const downLocked = inp.gear === 'down';
  // NaN throttle reads as full power and NaN flaps as up: never a false alarm from garbage.
  const lowPower = num(inp.throttlePct, 100) < gw.throttleBelowPct;
  const landingFlaps = num(inp.flapsDeg, 0) >= gw.flapsAtOrAboveDeg - 0.25;
  const gearUnsafe = !onGround && !downLocked && (lowPower || landingFlaps);
  const squatSwitch = onGround && !inp.handleDown;
  const ias = num(inp.iasKt, 0);
  // Each aircraft's own gear limits (VLE extended, VLO operating); the HUD section's vloKt is a fallback.
  const vlo = cfg.aircraft.gear.vloKt ?? gw.vloKt;
  const overspeed = (downLocked && ias > cfg.aircraft.gear.vleKt) || (inp.gear === 'transit' && ias > vlo);
  return { horn: gearUnsafe || squatSwitch, gearUnsafe, squatSwitch, overspeed, lights };
}

/** Readings that may carry the extra HUD fields (see HudReadings). */
type MaybeHudReadings = InstrumentReadings & { gearHandleDown?: boolean; onGround?: boolean };

/**
 * The gear warning from instrument readings alone (HUD preview, tests, any
 * reader without the full state): the handle is taken from `gearHandleDown`
 * when present, else inferred from the gear (anything but up = handle down).
 */
export function gearWarningFromReadings(r: MaybeHudReadings, cfg: Config = CONFIG): GearWarning {
  const onGround = typeof r.onGround === 'boolean' ? r.onGround : r.state === 'ground' || r.state === 'landed';
  return gearWarning(
    {
      onGround,
      crashed: r.state === 'crashed',
      gear: r.gear,
      handleDown: typeof r.gearHandleDown === 'boolean' ? r.gearHandleDown : r.gear !== 'up',
      throttlePct: r.throttlePct,
      flapsDeg: r.flapsDeg,
      iasKt: r.airspeedKt,
    },
    cfg,
  );
}

const scratch: GearWarning = { horn: false, gearUnsafe: false, squatSwitch: false, overspeed: false, lights: 'off' };

/**
 * The gear warning for any readings, allocation-free: HudReadings already carry
 * the flags (gearHorn/gearUnsafe/gearSquat/gearOverspeed) and are used as they
 * are; plain InstrumentReadings are evaluated with gearWarningFromReadings.
 * The returned object is shared — read it, don't keep it.
 */
export function gearFlags(r: InstrumentReadings, cfg: Config = CONFIG): Readonly<GearWarning> {
  const h = r as InstrumentReadings & Partial<Record<'gearHorn' | 'gearUnsafe' | 'gearSquat' | 'gearOverspeed', boolean>>;
  if (typeof h.gearUnsafe === 'boolean' && typeof h.gearSquat === 'boolean' && typeof h.gearOverspeed === 'boolean') {
    scratch.gearUnsafe = h.gearUnsafe;
    scratch.squatSwitch = h.gearSquat;
    scratch.overspeed = h.gearOverspeed;
    scratch.horn = typeof h.gearHorn === 'boolean' ? h.gearHorn : h.gearUnsafe || h.gearSquat;
    scratch.lights = r.gearLight;
    return scratch;
  }
  return gearWarningFromReadings(r, cfg);
}
