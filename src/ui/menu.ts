/**
 * The pause menu: a glass panel over the paused sim with Resume, Restart on runway, Start on final
 * approach, the aircraft list, time of day, camera, sound and HUD switches, and the Controls page
 * (the same sheet as the H overlay). It talks to the game only through a `MenuHost` (the menu
 * system adapts SimActions to it), so it is tested on its own in happy-dom.
 *
 * Keyboard: focus lands on Resume; ↑/↓/←/→ move between buttons, Tab stays inside, Space/Enter
 * press, Esc or P resume, H shows the controls. Those keys never reach the simulator; the rest do
 * (M mute, C camera… work with the menu up). Only the panel takes the pointer.
 */
import { CONFIG, type Config } from '../config';
import type { CameraMode } from '../types';
import { buildControlsSheet } from './controls';
import { mascotSvg } from './mascot';
import { orderPickerItems, type PickerItem } from './picker';

export interface MenuHost {
  reset(which: 'runway' | 'approach'): void;
  selectAircraft(id: string): void;
  setPaused(paused: boolean): void;
  isPaused(): boolean;
  setCamera(mode: CameraMode): void;
  cameraMode(): CameraMode;
  setTimeOfDay(index: number): void;
  getTimeOfDay(): number;
  timeOfDayNames: readonly string[];
  fleet(): readonly PickerItem[];
  currentAircraft(): string;
  toggleSound(): void;
  soundOn(): boolean;
  toggleHud(): void;
  hudOn(): boolean;
  /** Told whenever the menu opens or closes. */
  onOpenChange?(open: boolean): void;
}

export type MenuView = 'main' | 'controls';

export interface Menu {
  readonly element: HTMLElement;
  isOpen(): boolean;
  open(view?: MenuView): void;
  /** Hide the menu; by default also resume the sim. */
  close(resume?: boolean): void;
  /** Re-read the host's state (sound, HUD, camera, time of day, aircraft). */
  refresh(): void;
  dispose(): void;
}

const CAMERAS: [CameraMode, string][] = [
  ['cockpit', 'Cockpit'],
  ['chase', 'Chase'],
  ['external', 'External'],
  ['orbit', 'Orbit'],
];

const ICON = {
  play: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.8v10.4L13 8z" fill="currentColor"/></svg>',
  restart:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 8a4.8 4.8 0 1 0 1.5-3.5M3 2.2v3h3" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  approach:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 4.5 11 10.5M9 13.5h5.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="m11 10.5-3.2.4 1.9-2.6z" fill="currentColor"/></svg>',
  keys: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="4" width="13" height="8.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M4 7h1M7 7h1M10 7h1.5M4.5 9.8h7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  back: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3 5 8l5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
};

export function createMenu(doc: Document, host: MenuHost, cfg: Config = CONFIG): Menu {
  const mk = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', parent?: HTMLElement): HTMLElementTagNameMap[K] => {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    parent?.appendChild(e);
    return e;
  };
  const button = (cls: string, html: string, text: string, parent: HTMLElement, onClick: () => void): HTMLButtonElement => {
    const b = mk('button', cls, parent);
    b.type = 'button';
    b.innerHTML = html;
    b.appendChild(doc.createTextNode(text));
    b.addEventListener('click', onClick);
    return b;
  };

  const root = mk('div', 'tfs-menu');
  root.hidden = true;
  const backdrop = mk('div', 'tfs-backdrop', root);
  backdrop.style.pointerEvents = 'none';
  const panel = mk('div', 'tfs-panel', root);
  panel.style.pointerEvents = 'auto';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', 'tfs-menu-title');

  // ── Main view ──────────────────────────────────────────────────────────
  const main = mk('div', 'tfs-view', panel);
  main.dataset.view = 'main';
  const head = mk('div', 'tfs-head', main);
  head.innerHTML = mascotSvg({ title: 'Tater' });
  const titles = mk('div', '', head);
  const h2 = mk('h2', '', titles);
  h2.id = 'tfs-menu-title';
  h2.textContent = cfg.menu.productName;
  const sub = mk('p', '', titles);
  sub.textContent = cfg.menu.fullName;
  const pausedTag = mk('span', 'tfs-paused', head);
  pausedTag.textContent = 'PAUSED';
  const closeBtn = button('tfs-close', '', '✕', head, () => close(true));
  closeBtn.setAttribute('aria-label', 'Close menu and resume');

  const primary = mk('div', 'tfs-primary', main);
  const resumeBtn = button('tfs-btn tfs-go', ICON.play, 'Resume', primary, () => close(true));
  // A vessel restarts at its berth or underway on the open sea (same host calls; labels in refresh()).
  const runwayBtn = button('tfs-btn', ICON.restart, 'Restart on runway', primary, () => {
    host.reset('runway');
    close(true);
  });
  const approachBtn = button('tfs-btn', ICON.approach, 'Start on final approach', primary, () => {
    host.reset('approach');
    close(true);
  });

  const acSec = mk('section', 'tfs-section', main);
  mk('h3', '', acSec).textContent = 'Aircraft';
  const cards = mk('div', 'tfs-cards', acSec);
  cards.setAttribute('role', 'radiogroup');
  cards.setAttribute('aria-label', 'Aircraft');
  const cardEls: HTMLButtonElement[] = [];
  for (const it of orderPickerItems(host.fleet())) {
    const c = mk('button', 'tfs-card', cards);
    c.type = 'button';
    c.setAttribute('role', 'radio');
    c.dataset.aircraft = it.id;
    const b = mk('b', '', c);
    b.textContent = it.name;
    if (it.kind === 'vessel') {
      c.dataset.kind = 'vessel';
      mk('em', 'tfs-tag', b).textContent = 'BOAT';
    }
    const d = mk('span', '', c);
    d.textContent = it.description;
    c.addEventListener('click', () => {
      if (it.id !== host.currentAircraft()) host.selectAircraft(it.id);
      close(true);
    });
    cardEls.push(c);
  }

  const setSec = mk('section', 'tfs-section', main);
  mk('h3', '', setSec).textContent = 'Settings';
  const settings = mk('div', 'tfs-settings', setSec);
  const setting = (label: string) => {
    const s = mk('div', 'tfs-setting', settings);
    const l = mk('span', 'tfs-label', s);
    l.textContent = label;
    return s;
  };
  const todBtns: HTMLButtonElement[] = [];
  const todSeg = mk('div', 'tfs-seg', setting('Time of day'));
  todSeg.setAttribute('role', 'group');
  todSeg.setAttribute('aria-label', 'Time of day');
  host.timeOfDayNames.forEach((name, i) => {
    const b = button('', '', name, todSeg, () => {
      host.setTimeOfDay(i);
      refresh();
    });
    b.dataset.tod = String(i);
    todBtns.push(b);
  });
  const camBtns: HTMLButtonElement[] = [];
  const camSeg = mk('div', 'tfs-seg', setting('Camera'));
  camSeg.setAttribute('role', 'group');
  camSeg.setAttribute('aria-label', 'Camera');
  for (const [mode, name] of CAMERAS) {
    const b = button('', '', name, camSeg, () => {
      host.setCamera(mode);
      pendingCamera = mode;
      refresh();
    });
    b.dataset.camera = mode;
    camBtns.push(b);
  }
  const toggle = (label: string, id: string, onClick: () => void) => {
    const b = button('tfs-switch', '<i aria-hidden="true"></i>', '', setting(label), onClick);
    b.setAttribute('role', 'switch');
    b.setAttribute('aria-label', label);
    b.dataset.toggle = id;
    return b;
  };
  const soundBtn = toggle('Sound', 'sound', () => {
    host.toggleSound();
    refresh();
  });
  const hudBtn = toggle('HUD', 'hud', () => {
    host.toggleHud();
    refresh();
  });

  const foot = mk('div', 'tfs-foot', main);
  button('tfs-btn', ICON.keys, 'Controls', foot, () => show('controls'));
  const hint = mk('span', 'tfs-hint', foot);
  hint.innerHTML = '<kbd>Esc</kbd> resume · <kbd>H</kbd> controls · <kbd>R</kbd> restart';

  // ── Controls view ──────────────────────────────────────────────────────
  const ctl = mk('div', 'tfs-view', panel);
  ctl.dataset.view = 'controls';
  ctl.hidden = true;
  const ch = mk('div', 'tfs-view-head', ctl);
  const backBtn = button('tfs-btn', ICON.back, 'Back', ch, () => show('main'));
  mk('h2', '', ch).textContent = 'Controls';
  ctl.appendChild(buildControlsSheet(doc, cfg));

  // ── State ──────────────────────────────────────────────────────────────
  let open = false;
  let view: MenuView = 'main';
  /** The camera the player just picked (the host reports the change a frame later). */
  let pendingCamera: CameraMode | null = null;

  function refresh(): void {
    const cur = host.currentAircraft();
    const vessel = host.fleet().some((i) => i.id === cur && i.kind === 'vessel');
    const setLabel = (b: HTMLButtonElement, t: string) => {
      if (b.lastChild && b.lastChild.textContent !== t) b.lastChild.textContent = t;
    };
    setLabel(runwayBtn, vessel ? 'Back to the berth' : 'Restart on runway');
    setLabel(approachBtn, vessel ? 'Start on the open sea' : 'Start on final approach');
    for (const c of cardEls) c.setAttribute('aria-checked', c.dataset.aircraft === cur ? 'true' : 'false');
    const tod = host.getTimeOfDay();
    todBtns.forEach((b, i) => b.setAttribute('aria-pressed', i === tod ? 'true' : 'false'));
    const cam = pendingCamera ?? host.cameraMode();
    pendingCamera = null;
    camBtns.forEach((b) => b.setAttribute('aria-pressed', b.dataset.camera === cam ? 'true' : 'false'));
    const snd = host.soundOn();
    soundBtn.setAttribute('aria-checked', snd ? 'true' : 'false');
    soundBtn.lastChild!.textContent = snd ? 'On' : 'Off';
    const hud = host.hudOn();
    hudBtn.setAttribute('aria-checked', hud ? 'true' : 'false');
    hudBtn.lastChild!.textContent = hud ? 'On' : 'Off';
  }

  function show(v: MenuView): void {
    view = v;
    main.hidden = v !== 'main';
    ctl.hidden = v !== 'controls';
    (v === 'main' ? resumeBtn : backBtn).focus();
  }

  function focusables(): HTMLElement[] {
    return ([...panel.querySelectorAll('button')] as HTMLElement[]).filter((b) => !b.closest('[hidden]'));
  }

  function openMenu(v: MenuView = 'main'): void {
    const was = open;
    open = true;
    root.hidden = false;
    refresh();
    show(v);
    if (!was) host.onOpenChange?.(true);
  }

  function close(resume = true): void {
    const was = open;
    open = false;
    root.hidden = true;
    const a = doc.activeElement as HTMLElement | null;
    if (a && root.contains(a)) a.blur();
    if (resume) host.setPaused(false);
    if (was) host.onOpenChange?.(false);
  }

  const pauseKeys = new Set<string>(cfg.controls.keys.pause);
  const helpKeys = new Set<string>(cfg.controls.keys.help);
  const onKeyDown = (e: KeyboardEvent) => {
    if (!open || e.metaKey || e.ctrlKey || e.altKey) return;
    const code = e.code;
    let handled = true;
    if (code === 'Escape' || pauseKeys.has(code)) close(true);
    else if (helpKeys.has(code)) show(view === 'controls' ? 'main' : 'controls');
    else if (code === 'Space' || code === 'Enter' || code === 'NumpadEnter') {
      const t = e.target as HTMLElement | null;
      if (t && t.tagName === 'BUTTON' && panel.contains(t)) (t as HTMLButtonElement).click();
    } else if (code === 'ArrowDown' || code === 'ArrowUp' || code === 'ArrowLeft' || code === 'ArrowRight' || code === 'Tab') {
      const list = focusables();
      if (list.length) {
        const i = list.indexOf(doc.activeElement as HTMLElement);
        const back = code === 'ArrowUp' || code === 'ArrowLeft' || (code === 'Tab' && e.shiftKey);
        const n = i < 0 ? 0 : (i + (back ? -1 : 1) + list.length) % list.length;
        list[n].focus();
      }
    } else handled = false;
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  // Key-ups always pass through: the simulator must see every release (a roll key held while the
  // menu opened would otherwise stay "held" after resuming). Space/Enter activation happens on the
  // key-down above (default prevented), so a key-up never double-clicks.
  root.addEventListener('keydown', onKeyDown);

  return {
    element: root,
    isOpen: () => open,
    open: openMenu,
    close,
    refresh,
    dispose() {
      root.removeEventListener('keydown', onKeyDown);
      root.remove();
    },
  };
}
