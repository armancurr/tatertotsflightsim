/**
 * The help overlay (H): every control bound in config.controls.keys, grouped,
 * plus the mouse. helpSections() is pure; createHelpOverlay() builds the DOM.
 */
import { CONFIG, type Config } from '../config';
import { keyLabel } from './messages';

type KeyAction = keyof Config['controls']['keys'];

export interface HelpRow {
  /** What it does. */
  action: string;
  /** Key caps to show, in order ("/" separates alternatives). */
  keys: string[];
  /** The config.controls.keys actions this row documents. */
  ids: KeyAction[];
}

export interface HelpSection {
  title: string;
  rows: HelpRow[];
}

type RowSpec = [string, ...(KeyAction | '/' | { text: string })[]];

/** The documented layout of the help sheet (which actions go together, and how they read). */
const LAYOUT: { title: string; rows: RowSpec[] }[] = [
  {
    title: 'Flying',
    rows: [
      ['Pitch — nose down / up', 'pitchDown', '/', 'pitchUp'],
      ['Roll left / right', 'rollLeft', '/', 'rollRight'],
      ['Rudder left / right', 'yawLeft', '/', 'yawRight'],
      ['Throttle up / down', 'throttleUp', '/', 'throttleDown'],
      ['Elevator trim — nose down / up', 'trimNoseDown', '/', 'trimNoseUp'],
      ['Mouse yoke on/off', 'mouseYoke'],
    ],
  },
  {
    title: 'Systems',
    rows: [
      ['Flaps down / up', 'flapsDown', '/', 'flapsUp'],
      ['Landing gear', 'gear'],
      ['Brakes (hold)', 'brake'],
      ['Parking brake', 'parkingBrake'],
      ['Engine start / stop', 'engine'],
      ['Landing light', 'landingLight'],
    ],
  },
  {
    title: 'Views',
    rows: [
      ['Next camera', 'cameraNext'],
      ['Cockpit · chase · external · orbit', 'cameraCockpit', 'cameraChase', 'cameraExternal', 'cameraOrbit'],
      ['Look around / orbit', { text: 'Mouse drag' }],
      ['Zoom', { text: 'Mouse wheel' }],
    ],
  },
  {
    title: 'Simulator',
    rows: [
      ['Reset on the runway / on final approach', 'reset', '/', { text: 'Shift+R' }],
      ['Pause', 'pause'],
      ['Help', 'help'],
      ['Show / hide the HUD', 'hud'],
      ['Mute', 'mute'],
      ['Time of day', 'timeOfDay'],
    ],
  },
];

export function helpSections(cfg: Config = CONFIG): HelpSection[] {
  const keys = cfg.controls.keys as Record<string, readonly string[]>;
  const listed = new Set<string>();
  const sections: HelpSection[] = LAYOUT.map(({ title, rows }) => ({
    title,
    rows: rows.map(([action, ...parts]) => {
      const caps: string[] = [];
      const ids: KeyAction[] = [];
      for (const p of parts) {
        if (p === '/') caps.push('/');
        else if (typeof p === 'object') caps.push(p.text);
        else {
          ids.push(p);
          listed.add(p);
          for (const code of keys[p] ?? []) caps.push(keyLabel(code));
        }
      }
      return { action, keys: caps, ids };
    }),
  }));
  // Anything bound in the config but not in the layout still gets a row, so the sheet never goes stale.
  const extra = Object.keys(keys).filter((k) => !listed.has(k)) as KeyAction[];
  if (extra.length) {
    sections.push({
      title: 'More',
      rows: extra.map((id) => ({ action: id.replace(/([A-Z])/g, ' $1').toLowerCase(), keys: (keys[id] ?? []).map(keyLabel), ids: [id] })),
    });
  }
  return sections;
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
  sub.textContent = `${cfg.aircraft.name} · press ${keyLabel(cfg.controls.keys.help[0])} to close`;
  head.append(h, sub);
  el.appendChild(head);
  const grid = doc.createElement('div');
  grid.className = 'fsh-help-grid';
  for (const s of helpSections(cfg)) {
    const sec = doc.createElement('section');
    const t = doc.createElement('h3');
    t.textContent = s.title;
    sec.appendChild(t);
    for (const row of s.rows) {
      const line = doc.createElement('div');
      line.className = 'fsh-help-row';
      const what = doc.createElement('span');
      what.className = 'fsh-help-action';
      what.textContent = row.action;
      const caps = doc.createElement('span');
      caps.className = 'fsh-help-keys';
      for (const k of row.keys) {
        if (k === '/') {
          const sep = doc.createElement('span');
          sep.className = 'fsh-help-sep';
          sep.textContent = '/';
          caps.appendChild(sep);
        } else {
          const kbd = doc.createElement('kbd');
          kbd.textContent = k;
          caps.appendChild(kbd);
        }
      }
      line.append(what, caps);
      sec.appendChild(line);
    }
    grid.appendChild(sec);
  }
  el.appendChild(grid);
  return el;
}
