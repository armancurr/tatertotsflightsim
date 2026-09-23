/**
 * A tiny typed event bus between the UI's systems (hud, menu, weaponsHud), which the systems layer
 * keeps apart: the menu asks the HUD to show/hide and tells it when the menu is up (the HUD then
 * drops its PAUSED pill); the HUD reports whether it is visible; the weapons HUD asks the HUD for
 * kill toasts. One bus per document.
 */
export interface UiEvents {
  /** Menu → HUD: toggle the instruments (same as the I key). */
  toggleHud: undefined;
  /** HUD → menu: the instruments are now shown / hidden. */
  hudVisible: boolean;
  /** Menu → HUD: the pause menu opened / closed. */
  menuOpen: boolean;
  /** Menu → HUD: show the help overlay's Controls page. */
  showHelp: undefined;
  /** Any system → HUD: a toast in the HUD's message stack (e.g. the weapons HUD's kill toasts). */
  toast: { text: string; level?: 'info' | 'warn' | 'good'; seconds?: number };
}

type Handler<K extends keyof UiEvents> = (v: UiEvents[K]) => void;

export interface UiBus {
  on<K extends keyof UiEvents>(type: K, fn: Handler<K>): () => void;
  emit<K extends keyof UiEvents>(type: K, value: UiEvents[K]): void;
}

export function createUiBus(): UiBus {
  const handlers = new Map<keyof UiEvents, Set<(v: unknown) => void>>();
  return {
    on(type, fn) {
      let set = handlers.get(type);
      if (!set) handlers.set(type, (set = new Set()));
      set.add(fn as (v: unknown) => void);
      return () => set!.delete(fn as (v: unknown) => void);
    },
    emit(type, value) {
      for (const fn of [...(handlers.get(type) ?? [])]) fn(value);
    },
  };
}

const buses = new WeakMap<object, UiBus>();

/** The bus shared by everything on this document. */
export function uiBusFor(doc: object): UiBus {
  let b = buses.get(doc);
  if (!b) buses.set(doc, (b = createUiBus()));
  return b;
}
