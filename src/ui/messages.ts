/**
 * Text of the HUD's messages — landing toast, crash banner, annunciators,
 * start hint and key labels. Pure (no DOM) so every wording is unit-tested.
 * Vessels (`cfg.aircraft.watercraft` set) get their own annunciators (AGROUND, SHALLOW WATER,
 * MOORED, ENGINES OFF — nothing about stalls or gear), start hint and crash-banner hint.
 */
import { CONFIG, type Config, type WeaponsConfig } from '../config';
import type { TargetKind, WeaponKind } from '../combat/types';
import { gunShortName, missileLongName } from './weaponsHudMath';
import type { CrashRecord, InstrumentReadings, TouchdownRecord } from '../types';
import { gearFlags } from './gearWarning';
import { flapPlacardKt } from '../physics/placards';
import { shallowAlarm } from './marineHud';

export type MessageLevel = 'info' | 'warn' | 'good';

export type AnnunciationId =
  | 'stall' | 'gearUnsafe' | 'overspeed' | 'flapOverspeed' | 'gearOverspeed' | 'gearSquat' | 'engineFailed' | 'engineOff'
  // Helicopters (InstrumentReadings.rotor):
  | 'lowRotor' | 'overTorque' | 'vortexRing' | 'bladeStall'
  // Boats and ships (InstrumentReadings.vessel):
  | 'aground' | 'shallow' | 'moored';

/** Vortex-ring-state intensity above which the VORTEX RING caution lights. */
export const VRS_CAUTION = 0.5;
/** Retreating-blade-stall intensity above which RETREATING BLADE STALL lights. */
export const BLADE_STALL_CAUTION = 0.3;

export interface Annunciation {
  id: AnnunciationId;
  text: string;
  /** 'warning' = red (STALL and GEAR flash), 'caution' = amber, 'advisory' = cyan (status, e.g. MOORED). */
  level: 'warning' | 'caution' | 'advisory';
}

const MINUS = '−';

/** "−180 fpm" / "+42 fpm" / "0 fpm". */
export function formatFpm(fpm: number): string {
  const v = Number.isFinite(fpm) ? Math.round(fpm) : 0;
  if (v === 0) return '0 fpm';
  return `${v < 0 ? MINUS : '+'}${Math.abs(v)} fpm`;
}

/** Landing toast, e.g. "SMOOTH · −180 fpm · 3 m right of centreline". */
export function describeTouchdown(td: TouchdownRecord): { text: string; level: MessageLevel } {
  const parts = [td.rating.toUpperCase(), formatFpm(td.verticalSpeedFpm)];
  if (td.onRunway && td.centerlineOffsetM !== null && Number.isFinite(td.centerlineOffsetM)) {
    const off = td.centerlineOffsetM;
    const m = Math.round(Math.abs(off));
    parts.push(m < 1 ? 'on the centreline' : `${m} m ${off > 0 ? 'right' : 'left'} of centreline`);
  } else if (!td.onRunway) {
    parts.push(`off the runway (${td.surface})`);
  }
  const level: MessageLevel = td.rating === 'butter' || td.rating === 'smooth' ? 'good' : td.rating === 'firm' ? 'info' : 'warn';
  return { text: parts.join(' · '), level };
}

export function crashText(crash: CrashRecord, cfg?: Config): { title: string; hint: string } {
  if (cfg?.aircraft.watercraft) return { title: `WRECKED — ${crash.reason}`, hint: 'R back to the berth · Shift+R open sea · Esc menu' };
  return { title: `CRASHED — ${crash.reason}`, hint: 'R restart · Shift+R approach · Esc menu' };
}

/** Every annunciator the HUD can show, most urgent first (static per config). */
export function annunciationList(cfg: Config = CONFIG): Annunciation[] {
  if (cfg.aircraft.watercraft) {
    const n = cfg.aircraft.watercraft.propulsors.length;
    return [
      { id: 'aground', text: 'AGROUND', level: 'warning' },
      { id: 'engineFailed', text: 'ENGINE FAILURE', level: 'warning' },
      { id: 'shallow', text: 'SHALLOW WATER', level: 'caution' },
      { id: 'engineOff', text: `${n > 1 ? 'ENGINES' : 'ENGINE'} OFF · ${keysOf('engine', cfg)} to start`, level: 'caution' },
      { id: 'moored', text: 'MOORED · lever ahead or astern to cast off', level: 'advisory' },
    ];
  }
  return [
    { id: 'stall', text: 'STALL', level: 'warning' },
    { id: 'gearUnsafe', text: 'GEAR', level: 'warning' },
    { id: 'overspeed', text: 'OVERSPEED', level: 'warning' },
    { id: 'lowRotor', text: 'LOW ROTOR RPM', level: 'warning' },
    { id: 'engineFailed', text: 'ENGINE FAILURE', level: 'warning' },
    { id: 'flapOverspeed', text: 'FLAP OVERSPEED', level: 'caution' },
    { id: 'gearOverspeed', text: 'GEAR OVERSPEED', level: 'caution' },
    { id: 'gearSquat', text: 'GEAR — SQUAT SWITCH', level: 'caution' },
    { id: 'overTorque', text: 'OVERTORQUE', level: 'caution' },
    { id: 'vortexRing', text: 'VORTEX RING', level: 'caution' },
    { id: 'bladeStall', text: 'RETREATING BLADE STALL', level: 'caution' },
    { id: 'engineOff', text: `ENGINE OFF · ${keysOf('engine', cfg)} to start`, level: 'caution' },
  ];
}

/** Is this annunciator lit for these readings? (Nothing is lit once crashed — the crash banner says it all.) */
export function annunciationActive(id: AnnunciationId, r: InstrumentReadings, cfg: Config = CONFIG): boolean {
  if (r.state === 'crashed') return false;
  const v = r.vessel;
  if (v) {
    // A boat: only the helm's flags (and the engine ones) — nothing about stalls, flaps or gear.
    switch (id) {
      case 'aground': return v.aground === true;
      case 'shallow': return !v.aground && shallowAlarm(v);
      case 'moored': return v.moored === true;
      case 'engineFailed': return r.engineStatus === 'FAILED';
      case 'engineOff': return r.engineStatus === 'OFF';
      default: return false;
    }
  }
  const ias = Number.isFinite(r.airspeedKt) ? r.airspeedKt : 0;
  switch (id) {
    case 'stall': return r.stallWarning;
    case 'overspeed': return r.overspeed;
    case 'engineFailed': return r.engineStatus === 'FAILED';
    case 'flapOverspeed': return !r.rotor && ias > flapPlacardKt(r.flapsDeg, cfg);
    case 'gearUnsafe': return gearFlags(r, cfg).gearUnsafe;
    case 'gearOverspeed': return gearFlags(r, cfg).overspeed;
    case 'gearSquat': return gearFlags(r, cfg).squatSwitch;
    case 'engineOff': return r.engineStatus === 'OFF';
    case 'lowRotor': return r.rotor?.lowRotorRpm === true;
    case 'overTorque': return r.rotor?.overTorque === true;
    case 'vortexRing': return (r.rotor?.vrs ?? 0) > VRS_CAUTION;
    case 'bladeStall': return (r.rotor?.bladeStall ?? 0) > BLADE_STALL_CAUTION;
    case 'aground':
    case 'shallow':
    case 'moored':
      return false;
  }
}

/** Warnings and cautions currently lit, most urgent first. */
export function annunciations(r: InstrumentReadings, cfg: Config = CONFIG): Annunciation[] {
  return annunciationList(cfg).filter((a) => annunciationActive(a.id, r, cfg));
}

const NAMED: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  Space: 'Space',
  Escape: 'Esc',
  PageUp: 'PgUp',
  PageDown: 'PgDn',
  Equal: '+',
  Minus: MINUS,
  NumpadAdd: 'Num +',
  NumpadSubtract: `Num ${MINUS}`,
  BracketLeft: '[',
  BracketRight: ']',
  Enter: 'Enter',
  Tab: 'Tab',
  Backquote: '`',
  Comma: ',',
  Period: '.',
  Slash: '/',
  Semicolon: ';',
  Quote: "'",
  Backslash: '\\',
  ShiftLeft: 'Shift',
  ShiftRight: 'Shift',
};

/** KeyboardEvent.code → what is printed on the key. */
export function keyLabel(code: string): string {
  if (code in NAMED) return NAMED[code];
  const m = /^(?:Key|Digit)([A-Z0-9])$/.exec(code);
  if (m) return m[1];
  const n = /^Numpad([0-9])$/.exec(code);
  if (n) return `Num ${n[1]}`;
  return code;
}

type KeyAction = keyof Config['controls']['keys'];

/** First bound key of an action, as printed ("W"). */
export function keysOf(action: KeyAction, cfg: Config = CONFIG): string {
  const codes = cfg.controls.keys[action] as readonly string[] | undefined;
  return codes && codes.length ? keyLabel(codes[0]) : '?';
}

/** One-line hint shown for the first seconds of a session (a helicopter gets its own). */
export function startHint(cfg: Config = CONFIG): string {
  const k = (a: KeyAction) => keysOf(a, cfg);
  if (cfg.aircraft.watercraft) {
    const menu = keyLabel(cfg.controls.keys.pause[cfg.controls.keys.pause.length - 1] ?? 'Escape');
    return `${k('engine')} engines · ${k('throttleUp')}/${k('throttleDown')} lever ahead / astern · ${k('yawLeft')}/${k('yawRight')} steer · ${k('trimNoseDown')}/${k('trimNoseUp')} trim tabs · ${k('help')} controls · ${menu} menu`;
  }
  if (cfg.aircraft.rotorcraft) {
    const menu = keyLabel(cfg.controls.keys.pause[cfg.controls.keys.pause.length - 1] ?? 'Escape');
    return `${k('engine')} engine · ${k('throttleUp')}/${k('throttleDown')} collective · arrows cyclic · ${k('yawLeft')}/${k('yawRight')} pedals · ${k('stabilityAssist')} stability assist · ${k('help')} controls · ${menu} menu`;
  }
  const vr = Math.round(cfg.aircraft.limits.vrKt);
  const menu = keyLabel(cfg.controls.keys.pause[cfg.controls.keys.pause.length - 1] ?? 'Escape');
  return `${k('throttleUp')} throttle up · ${k('pitchUp')} pull up at ${vr} kt · ${k('gear')} gear · ${k('flapsDown')}/${k('flapsUp')} flaps · ${k('help')} controls · ${menu} menu`;
}

/** Kill toast: "T-72B destroyed — GAU-8" / "BMP-2 destroyed — AGM-65D" (the weapon named from what the aircraft carries). */
export function killToastText(kind: TargetKind, weapon: WeaponKind, weapons: WeaponsConfig | null | undefined, cfg: Config = CONFIG): string {
  const name = cfg.combat.targets[kind]?.name ?? String(kind);
  let by: string;
  if (weapon === 'gun') by = weapons?.gun ? gunShortName(weapons.gun.name) : 'gun';
  else if (weapon === 'missile' && cfg.combat.targets[kind]?.air && weapons?.airMissiles) by = missileLongName(weapons.airMissiles.name);
  else if (weapon === 'missile') by = weapons?.missiles ? missileLongName(weapons.missiles.name) : 'Maverick';
  else by = String(weapon) || 'gun';
  return `${name} destroyed — ${by}`;
}
