/**
 * The Controls page shared by the menu and the H help overlay: every binding in
 * config.controls.keys, grouped Flight · Engine & systems · Weapons · Cameras · Sim, plus the
 * mouse and the jet / A-10 notes. `controlGroups()` is pure (tested: nothing bound is ever missing — an unknown new
 * binding lands in Sim); `buildControlsSheet()` renders it (system fonts, no network).
 */
import { B747_AIRCRAFT, CONFIG, type Config } from '../config';
import { keyLabel } from './messages';

export type KeyAction = keyof Config['controls']['keys'];
export type ControlGroupId = 'flight' | 'engine' | 'weapons' | 'cameras' | 'sim';

export interface ControlRow {
  /** What it does. */
  action: string;
  /** Key caps in order ("/" separates alternatives). */
  keys: string[];
  /** The config.controls.keys actions this row documents. */
  ids: KeyAction[];
  /** Extra line under the row (e.g. the F-16 afterburner). */
  note?: string;
}

export interface ControlGroup {
  id: ControlGroupId;
  title: string;
  rows: ControlRow[];
}

type Part = KeyAction | '/' | { text: string };
type RowSpec = { action: string; parts: Part[]; note?: (cfg: Config) => string };

const LAYOUT: { id: ControlGroupId; title: string; rows: RowSpec[] }[] = [
  {
    id: 'flight',
    title: 'Flight',
    rows: [
      { action: 'Pitch — nose down / up', parts: ['pitchDown', '/', 'pitchUp'] },
      { action: 'Roll left / right', parts: ['rollLeft', '/', 'rollRight'] },
      { action: 'Rudder left / right', parts: ['yawLeft', '/', 'yawRight'] },
      { action: 'Elevator trim — nose down / up', parts: ['trimNoseDown', '/', 'trimNoseUp'] },
      { action: 'Mouse yoke on / off', parts: ['mouseYoke'] },
    ],
  },
  {
    id: 'engine',
    title: 'Engine & systems',
    rows: [
      {
        action: 'Throttle up / down',
        parts: ['throttleUp', '/', 'throttleDown'],
        note: (cfg) => `F-16: the afterburner lights past ~${cfg.menu.afterburnerFromPct} % throttle`,
      },
      { action: 'Engine start / stop', parts: ['engine'] },
      { action: 'Flaps down / up', parts: ['flapsDown', '/', 'flapsUp'] },
      { action: 'Landing gear up / down', parts: ['gear'] },
      { action: 'Brakes (hold)', parts: ['brake'] },
      { action: 'Parking brake', parts: ['parkingBrake'] },
      { action: 'Speed brake (jets) · spoilers (747)', parts: ['speedBrake'] },
      { action: 'Landing light', parts: ['landingLight'] },
    ],
  },
  {
    id: 'weapons',
    title: 'Weapons',
    rows: [
      {
        action: 'Fire the gun (hold)',
        parts: ['fireGun'],
        note: () => 'A-10: GAU-8/A 30 mm, 1,150 rounds · F-16: M61A1 20 mm',
      },
      {
        action: 'Lock target / next target',
        parts: ['lockTarget'],
        note: () => 'The vehicle or aircraft nearest the nose: Maverick or Sidewinder',
      },
      {
        action: 'Launch a missile (after LOCK)',
        parts: ['fireMissile'],
        note: () => 'AGM-65 Maverick at a vehicle · AIM-9 Sidewinder at an aircraft',
      },
    ],
  },
  {
    id: 'cameras',
    title: 'Cameras',
    rows: [
      { action: 'Next camera', parts: ['cameraNext'] },
      { action: 'Cockpit · chase · external · orbit', parts: ['cameraCockpit', 'cameraChase', 'cameraExternal', 'cameraOrbit'] },
      { action: 'Look around / orbit', parts: [{ text: 'Mouse drag' }] },
      { action: 'Zoom', parts: [{ text: 'Mouse wheel' }] },
    ],
  },
  {
    id: 'sim',
    title: 'Sim',
    rows: [
      { action: 'Restart on the runway / on final approach', parts: ['reset', '/', { text: 'Shift+R' }] },
      { action: 'Pause & menu', parts: ['pause'] },
      { action: 'Controls (this page)', parts: ['help'] },
      { action: 'Show / hide the HUD', parts: ['hud'] },
      { action: 'Sound on / off', parts: ['mute'] },
      { action: 'Time of day', parts: ['timeOfDay'] },
    ],
  },
];

/** Every binding, grouped. Bindings not in the layout (added to the config later) are appended to Sim. */
export function controlGroups(cfg: Config = CONFIG): ControlGroup[] {
  const keys = cfg.controls.keys as Record<string, readonly string[]>;
  const listed = new Set<string>();
  const groups: ControlGroup[] = LAYOUT.map(({ id, title, rows }) => ({
    id,
    title,
    rows: rows.map(({ action, parts, note }) => {
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
      return note ? { action, keys: caps, ids, note: note(cfg) } : { action, keys: caps, ids };
    }),
  }));
  const extra = Object.keys(keys).filter((k) => !listed.has(k)) as KeyAction[];
  const sim = groups[groups.length - 1];
  for (const id of extra) {
    const words = String(id).replace(/([A-Z])/g, ' $1').toLowerCase();
    sim.rows.push({ action: words.charAt(0).toUpperCase() + words.slice(1), keys: (keys[id] ?? []).map(keyLabel), ids: [id] });
  }
  return groups;
}

/** Short notes under the sheet. */
export function controlNotes(cfg: Config = CONFIG): string[] {
  return [
    `F-16: push the throttle past ~${cfg.menu.afterburnerFromPct} % for afterburner; ${keyLabel(cfg.controls.keys.speedBrake[0])} opens and closes the speed brake.`,
    `Cessna: full throttle, rotate at about ${CONFIG.aircraft.limits.vrKt} kt, gear up once climbing. Esc opens this menu at any time.`,
    `A-10: the tank range is north of the airport — follow the RANGE caret. ${keyLabel(cfg.controls.keys.lockTarget[0])} locks a Maverick on the vehicle nearest the nose, ${keyLabel(cfg.controls.keys.fireMissile[0])} launches it at LOCK; hold ${keyLabel(cfg.controls.keys.fireGun[0])} to fire the gun at the pipper (hit tanks from above or behind).`,
    `F-16 and A-10: point the nose at an enemy aircraft, ${keyLabel(cfg.controls.keys.lockTarget[0])} locks a Sidewinder on it, ${keyLabel(cfg.controls.keys.fireMissile[0])} launches it.`,
    `747: flaps 10 for take-off, rotate at about ${B747_AIRCRAFT.limits.vrKt} kt and ease it off; ${keyLabel(cfg.controls.keys.speedBrake[0])} works the spoilers. Heavy and slow to answer — small inputs, early.`,
  ];
}

/** Styles of the sheet (added to both the HUD's and the menu's stylesheets; scoped by class). */
export const CONTROLS_CSS = `
.tfs-controls-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 28px; }
.tfs-controls h3 { margin: 0 0 4px; font-size: 11px; font-weight: 800; letter-spacing: 0.16em; text-transform: uppercase; color: #ffc15c; }
.tfs-controls-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 4px 0; border-top: 1px solid rgba(255,255,255,0.06); font-size: 13px; }
.tfs-controls-action { opacity: 0.9; }
.tfs-controls-action small { display: block; margin-top: 2px; font-size: 11px; color: #ffb35c; opacity: 0.85; }
.tfs-controls-keys { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 3px; align-items: center; flex: none; max-width: 55%; }
.tfs-controls-sep { opacity: 0.45; margin: 0 2px; }
.tfs-controls kbd {
  display: inline-block; min-width: 1.7em; padding: 0.16em 0.45em; border-radius: 5px; text-align: center;
  font: 700 11px/1.25 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.2); border-bottom-width: 2px; color: #fff;
}
.tfs-controls-notes { margin: 12px 0 0; padding: 0 0 0 18px; font-size: 12px; color: rgba(230,236,245,0.7); line-height: 1.5; }
@media (max-width: 720px) { .tfs-controls-grid { grid-template-columns: 1fr; } }
`;

/** The grouped sheet as DOM: <div class="tfs-controls"> with a <section> per group. */
export function buildControlsSheet(doc: Document, cfg: Config = CONFIG): HTMLElement {
  const el = doc.createElement('div');
  el.className = 'tfs-controls';
  const grid = doc.createElement('div');
  grid.className = 'tfs-controls-grid';
  for (const g of controlGroups(cfg)) {
    const sec = doc.createElement('section');
    sec.setAttribute('data-group', g.id);
    const t = doc.createElement('h3');
    t.textContent = g.title;
    sec.appendChild(t);
    for (const row of g.rows) {
      const line = doc.createElement('div');
      line.className = 'tfs-controls-row';
      const what = doc.createElement('span');
      what.className = 'tfs-controls-action';
      what.textContent = row.action;
      if (row.note) {
        const n = doc.createElement('small');
        n.textContent = row.note;
        what.appendChild(n);
      }
      const caps = doc.createElement('span');
      caps.className = 'tfs-controls-keys';
      for (const k of row.keys) {
        if (k === '/') {
          const sep = doc.createElement('span');
          sep.className = 'tfs-controls-sep';
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
  const notes = doc.createElement('ul');
  notes.className = 'tfs-controls-notes';
  for (const n of controlNotes(cfg)) {
    const li = doc.createElement('li');
    li.textContent = n;
    notes.appendChild(li);
  }
  el.appendChild(notes);
  return el;
}
