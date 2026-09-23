/**
 * Text of the HUD's messages — landing toast, crash banner, annunciators,
 * start hint and key labels. Pure (no DOM) so every wording is unit-tested.
 */
import { CONFIG, type Config } from '../config';
import type { CrashRecord, InstrumentReadings, TouchdownRecord } from '../types';
import { gearFlags } from './gearWarning';

export type MessageLevel = 'info' | 'warn' | 'good';

export type AnnunciationId = 'stall' | 'gearUnsafe' | 'overspeed' | 'flapOverspeed' | 'gearOverspeed' | 'gearSquat' | 'engineFailed' | 'engineOff';

export interface Annunciation {
  id: AnnunciationId;
  text: string;
  /** 'warning' = red (STALL and GEAR flash), 'caution' = amber. */
  level: 'warning' | 'caution';
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

export function crashText(crash: CrashRecord): { title: string; hint: string } {
  return { title: `CRASHED — ${crash.reason}`, hint: 'R restart · Shift+R approach · Esc menu' };
}

/** Every annunciator the HUD can show, most urgent first (static per config). */
export function annunciationList(cfg: Config = CONFIG): Annunciation[] {
  return [
    { id: 'stall', text: 'STALL', level: 'warning' },
    { id: 'gearUnsafe', text: 'GEAR', level: 'warning' },
    { id: 'overspeed', text: 'OVERSPEED', level: 'warning' },
    { id: 'engineFailed', text: 'ENGINE FAILURE', level: 'warning' },
    { id: 'flapOverspeed', text: 'FLAP OVERSPEED', level: 'caution' },
    { id: 'gearOverspeed', text: 'GEAR OVERSPEED', level: 'caution' },
    { id: 'gearSquat', text: 'GEAR — SQUAT SWITCH', level: 'caution' },
    { id: 'engineOff', text: `ENGINE OFF · ${keysOf('engine', cfg)} to start`, level: 'caution' },
  ];
}

/** Is this annunciator lit for these readings? (Nothing is lit once crashed — the crash banner says it all.) */
export function annunciationActive(id: AnnunciationId, r: InstrumentReadings, cfg: Config = CONFIG): boolean {
  if (r.state === 'crashed') return false;
  const ias = Number.isFinite(r.airspeedKt) ? r.airspeedKt : 0;
  switch (id) {
    case 'stall': return r.stallWarning;
    case 'overspeed': return r.overspeed;
    case 'engineFailed': return r.engineStatus === 'FAILED';
    case 'flapOverspeed': return r.flapsDeg > 0.5 && ias > cfg.aircraft.flaps.vfeKt;
    case 'gearUnsafe': return gearFlags(r, cfg).gearUnsafe;
    case 'gearOverspeed': return gearFlags(r, cfg).overspeed;
    case 'gearSquat': return gearFlags(r, cfg).squatSwitch;
    case 'engineOff': return r.engineStatus === 'OFF';
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

/** One-line hint shown for the first seconds of a session. */
export function startHint(cfg: Config = CONFIG): string {
  const k = (a: KeyAction) => keysOf(a, cfg);
  const vr = Math.round(cfg.aircraft.limits.vrKt);
  const menu = keyLabel(cfg.controls.keys.pause[cfg.controls.keys.pause.length - 1] ?? 'Escape');
  return `${k('throttleUp')} throttle up · ${k('pitchUp')} pull up at ${vr} kt · ${k('gear')} gear · ${k('flapsDown')}/${k('flapsUp')} flaps · ${k('help')} controls · ${menu} menu`;
}
