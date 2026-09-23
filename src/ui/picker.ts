/**
 * The aircraft picker: a compact dropdown (upper right of the top bar) listing the fleet with a
 * one-line description each, built as an ARIA listbox so it works from the keyboard (Tab to it,
 * Enter/↓ to open, ↑/↓/Home/End, Enter to choose, Esc to close). Keys it handles never reach the
 * simulator; with the list closed it lets flying keys through, and it drops focus after mouse use
 * so arrows and Space go back to flying. Pointer events only on the widget.
 *
 * Also the saved-choice helpers (localStorage, every access guarded — private windows and blocked
 * storage throw): the choice is restored at start-up unless the URL names an aircraft.
 */

export interface PickerItem {
  id: string;
  name: string;
  shortName: string;
  description: string;
}

export interface PickerOptions {
  items: readonly PickerItem[];
  current: string;
  onSelect(id: string): void;
}

export interface AircraftPicker {
  readonly element: HTMLElement;
  isOpen(): boolean;
  open(): void;
  close(): void;
  setCurrent(id: string): void;
  dispose(): void;
}

const PLANE_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true" class="tfs-picker-icon"><path fill="currentColor" d="M21.5 15.2v-1.9l-8-4.7V3.4c0-.9-.7-1.6-1.5-1.6s-1.5.7-1.5 1.6v5.2l-8 4.7v1.9l8-2.4v4.9l-2.1 1.5v1.4l3.6-1 3.6 1v-1.4l-2.1-1.5v-4.9z"/></svg>';
const CHEVRON = '<svg viewBox="0 0 12 12" aria-hidden="true" class="tfs-chevron"><path d="M2.5 4.5 6 8l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

let pickerUid = 0;

export function createAircraftPicker(doc: Document, opts: PickerOptions): AircraftPicker {
  const uid = ++pickerUid;
  const items = opts.items.slice();
  let current = opts.current;
  let active = Math.max(0, items.findIndex((i) => i.id === current));
  let open = false;

  const el = doc.createElement('div');
  el.className = 'tfs-picker';
  el.style.pointerEvents = 'auto';
  const button = doc.createElement('button');
  button.type = 'button';
  button.className = 'tfs-picker-button';
  button.setAttribute('aria-haspopup', 'listbox');
  button.setAttribute('aria-expanded', 'false');
  button.title = 'Choose your aircraft';
  const label = doc.createElement('span');
  label.className = 'tfs-picker-label';
  button.innerHTML = PLANE_ICON;
  button.appendChild(label);
  button.insertAdjacentHTML('beforeend', CHEVRON);
  const list = doc.createElement('ul');
  list.className = 'tfs-picker-list';
  list.setAttribute('role', 'listbox');
  list.setAttribute('aria-label', 'Aircraft');
  list.tabIndex = -1;
  list.hidden = true;
  const listId = `tfs-picker-${uid}`;
  list.id = listId;
  button.setAttribute('aria-controls', listId);
  const options: HTMLElement[] = items.map((it) => {
    const li = doc.createElement('li');
    li.setAttribute('role', 'option');
    li.id = `${listId}-${it.id}`;
    li.dataset.id = it.id;
    const name = doc.createElement('span');
    name.className = 'tfs-opt-name';
    name.textContent = it.name;
    const desc = doc.createElement('span');
    desc.className = 'tfs-opt-desc';
    desc.textContent = it.description;
    li.append(name, desc);
    list.appendChild(li);
    return li;
  });
  el.append(button, list);

  const render = () => {
    const cur = items.find((i) => i.id === current);
    label.textContent = cur ? cur.shortName : current;
    options.forEach((li, i) => {
      li.setAttribute('aria-selected', items[i].id === current ? 'true' : 'false');
      li.classList.toggle('tfs-active', open && i === active);
    });
    const a = options[active];
    if (open && a) list.setAttribute('aria-activedescendant', a.id);
    else list.removeAttribute('aria-activedescendant');
  };

  const setOpen = (v: boolean, focusList = true) => {
    if (open === v) return;
    open = v;
    list.hidden = !v;
    button.setAttribute('aria-expanded', v ? 'true' : 'false');
    el.classList.toggle('tfs-open', v);
    if (v) {
      active = Math.max(0, items.findIndex((i) => i.id === current));
      if (focusList) list.focus();
    }
    render();
  };
  const choose = (i: number) => {
    const it = items[i];
    setOpen(false);
    if (!it) return;
    if (it.id !== current) opts.onSelect(it.id);
  };
  /** Give the keyboard back to the simulator. */
  const release = () => {
    const a = doc.activeElement as HTMLElement | null;
    if (a && el.contains(a)) a.blur();
  };

  let pointerUsed = false;
  button.addEventListener('pointerdown', () => {
    pointerUsed = true;
  });
  button.addEventListener('click', () => {
    setOpen(!open, !pointerUsed);
    if (pointerUsed && !open) release();
    pointerUsed = false;
  });
  list.addEventListener('click', (e) => {
    const li = (e.target as HTMLElement | null)?.closest?.('[role="option"]') as HTMLElement | null;
    if (!li) return;
    const i = options.indexOf(li);
    if (i >= 0) {
      choose(i);
      release();
    }
  });
  list.addEventListener('pointermove', (e) => {
    const li = (e.target as HTMLElement | null)?.closest?.('[role="option"]') as HTMLElement | null;
    const i = li ? options.indexOf(li) : -1;
    if (i >= 0 && i !== active) {
      active = i;
      render();
    }
  });

  const onKey = (e: KeyboardEvent) => {
    let handled = true;
    if (!open) {
      if (e.target === button && (e.code === 'ArrowDown' || e.code === 'ArrowUp' || e.code === 'Enter' || e.code === 'NumpadEnter')) setOpen(true);
      else handled = false;
    } else {
      switch (e.code) {
        case 'ArrowDown':
          active = Math.min(items.length - 1, active + 1);
          render();
          break;
        case 'ArrowUp':
          active = Math.max(0, active - 1);
          render();
          break;
        case 'Home':
          active = 0;
          render();
          break;
        case 'End':
          active = items.length - 1;
          render();
          break;
        case 'Enter':
        case 'NumpadEnter':
        case 'Space':
          choose(active);
          // The choice is made: the keyboard goes back to flying (arrows would reopen the list otherwise).
          release();
          break;
        case 'Escape':
          setOpen(false);
          button.focus();
          break;
        case 'Tab':
          setOpen(false);
          handled = false;
          break;
        default:
          handled = false;
      }
    }
    if (handled) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  // Key-ups pass through so the simulator always sees releases (no stuck keys).
  el.addEventListener('keydown', onKey);
  const onOutside = (e: Event) => {
    if (open && !el.contains(e.target as Node)) {
      setOpen(false);
      release();
    }
  };
  doc.addEventListener('pointerdown', onOutside, true);

  render();
  return {
    element: el,
    isOpen: () => open,
    open: () => setOpen(true),
    close: () => setOpen(false),
    setCurrent(id: string) {
      current = id;
      render();
    },
    dispose() {
      doc.removeEventListener('pointerdown', onOutside, true);
      el.remove();
    },
  };
}

// ─── Saved choice (localStorage) ─────────────────────────────────────────────

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** window.localStorage, or null where touching it throws (private windows, blocked storage). */
export function safeLocalStorage(win: Window | undefined = typeof window === 'undefined' ? undefined : window): KeyValueStore | null {
  try {
    return win?.localStorage ?? null;
  } catch {
    return null;
  }
}

export function loadAircraftChoice(store: KeyValueStore | null, key: string): string | null {
  try {
    const v = store?.getItem(key);
    return typeof v === 'string' && v ? v : null;
  } catch {
    return null;
  }
}

export function saveAircraftChoice(store: KeyValueStore | null, key: string, id: string): void {
  try {
    store?.setItem(key, id);
  } catch {
    /* storage full or blocked: the choice just isn't remembered */
  }
}

/**
 * The aircraft to switch to at start-up: the saved choice, if the URL has no ?aircraft=, the id
 * is still in the fleet and it isn't what is already loaded. Otherwise null.
 */
export function aircraftToRestore(search: string, store: KeyValueStore | null, key: string, fleetIds: readonly string[], currentId: string): string | null {
  try {
    if (new URLSearchParams(search).has('aircraft')) return null;
  } catch {
    return null;
  }
  const saved = loadAircraftChoice(store, key);
  if (!saved || saved === currentId || !fleetIds.includes(saved)) return null;
  return saved;
}
