/**
 * Keyboard DOM adapter: tracks held keys (KeyboardEvent.code) and key-down edges.
 *
 * - Auto-repeat keydowns are not edges.
 * - Every bound key is preventDefault-ed (arrows, Space, PageUp/Down must not scroll the page).
 * - Cmd/Ctrl/Alt combinations are left to the browser (reload, zoom, tab switching…).
 * - Held keys are cleared on window blur, when the tab is hidden and when Meta is released
 *   (macOS does not send keyups for keys released while Cmd is down) — no stuck keys.
 * - Typing in a text field is ignored.
 */
import type { KeyPress } from './controlSystem';

export interface KeyboardTracker {
  /** Codes currently held (live set; copy it if you need a snapshot). */
  readonly held: ReadonlySet<string>;
  /** Shift is currently held. */
  shift(): boolean;
  /** Key-down edges since the last call, in order. */
  consumePressed(): KeyPress[];
  /** Forget every held key and pending edge. */
  clear(): void;
  dispose(): void;
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as (HTMLElement & { isContentEditable?: boolean }) | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true;
}

const SHIFT_CODES = ['ShiftLeft', 'ShiftRight'];

export function createKeyboard(win: Window, boundCodes: ReadonlySet<string>): KeyboardTracker {
  const held = new Set<string>();
  let pressed: KeyPress[] = [];

  const clear = () => {
    held.clear();
    pressed = [];
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (isEditable(e.target)) return;
    if (e.metaKey || e.ctrlKey || e.altKey) {
      // Browser/OS shortcut: not a control input. Still remember modifiers so Meta-up can clear.
      return;
    }
    const code = e.code;
    if (!code) return;
    if (boundCodes.has(code)) e.preventDefault();
    held.add(code);
    if (!e.repeat) pressed.push({ code, shift: e.shiftKey });
  };

  const onKeyUp = (e: KeyboardEvent) => {
    const code = e.code;
    if (code === 'MetaLeft' || code === 'MetaRight' || code === 'OSLeft' || code === 'OSRight') {
      held.clear();
      return;
    }
    if (boundCodes.has(code) && !isEditable(e.target)) e.preventDefault();
    held.delete(code);
  };

  const onBlur = () => clear();
  const doc = win.document;
  const onVisibility = () => {
    if (doc.hidden) clear();
  };

  win.addEventListener('keydown', onKeyDown);
  win.addEventListener('keyup', onKeyUp);
  win.addEventListener('blur', onBlur);
  doc?.addEventListener('visibilitychange', onVisibility);

  return {
    held,
    shift: () => SHIFT_CODES.some((c) => held.has(c)),
    consumePressed() {
      const out = pressed;
      pressed = [];
      return out;
    },
    clear,
    dispose() {
      win.removeEventListener('keydown', onKeyDown);
      win.removeEventListener('keyup', onKeyUp);
      win.removeEventListener('blur', onBlur);
      doc?.removeEventListener('visibilitychange', onVisibility);
      clear();
    },
  };
}
