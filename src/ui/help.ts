/**
 * The help overlay (H): the same grouped Controls page as the menu (src/ui/controls.ts) in a
 * glass sheet over the view. helpSections() is the pure data; createHelpOverlay() builds the DOM.
 */
import { CONFIG, type Config } from '../config';
import { keyLabel } from './messages';
import { buildControlsSheet, controlGroups, type ControlRow, type KeyAction } from './controls';

export interface HelpRow {
  /** What it does. */
  action: string;
  /** Key caps to show, in order ("/" separates alternatives). */
  keys: string[];
  /** The config.controls.keys actions this row documents. */
  ids: KeyAction[];
  note?: string;
}

export interface HelpSection {
  title: string;
  rows: HelpRow[];
}

/** The help sheet's sections: exactly the menu's Controls groups. */
export function helpSections(cfg: Config = CONFIG): HelpSection[] {
  return controlGroups(cfg).map((g) => ({ title: g.title, rows: g.rows.map((r: ControlRow) => ({ ...r })) }));
}

/** The help sheet as a DOM element (hidden until toggled). */
export function createHelpOverlay(doc: Document, cfg: Config = CONFIG): HTMLElement {
  const el = doc.createElement('div');
  el.className = 'fsh-help fsh-glass';
  el.hidden = true;
  const head = doc.createElement('div');
  head.className = 'fsh-help-head';
  const h = doc.createElement('h2');
  h.textContent = 'Controls';
  const sub = doc.createElement('span');
  sub.textContent = `${cfg.aircraft.name} · ${keyLabel(cfg.controls.keys.help[0])} to close · ${keyLabel(cfg.controls.keys.pause[cfg.controls.keys.pause.length - 1])} for the menu`;
  head.append(h, sub);
  el.append(head, buildControlsSheet(doc, cfg));
  return el;
}
