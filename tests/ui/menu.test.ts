// @vitest-environment happy-dom
/**
 * The pause menu (DOM): resume, restart on the runway / on final (every time), the aircraft list,
 * time of day, sound, camera, HUD, the Controls page, and keyboard use without leaking keys to the sim.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fc from 'fast-check';
import type { CameraMode } from '../../src/types';
import { createMenu, type MenuHost, type Menu } from '../../src/ui/menu';
import { createTopBar } from '../../src/ui/topBar';

function host(over: Partial<MenuHost> = {}) {
  let paused = false;
  let tod = 0;
  let cam: CameraMode = 'chase';
  let sound = true;
  let hud = true;
  let aircraft = 'c172rg';
  const h: MenuHost = {
    reset: vi.fn(),
    selectAircraft: vi.fn((id: string) => {
      aircraft = id;
    }),
    setPaused: vi.fn((p: boolean) => {
      paused = p;
    }),
    isPaused: () => paused,
    setCamera: vi.fn((m: CameraMode) => {
      cam = m;
    }),
    cameraMode: () => cam,
    setTimeOfDay: vi.fn((i: number) => {
      tod = i;
    }),
    getTimeOfDay: () => tod,
    timeOfDayNames: ['Morning', 'Noon', 'Evening', 'Night'],
    fleet: () => [
      { id: 'c172rg', name: 'Cessna 172RG Cutlass', shortName: 'Cessna 172', description: 'Piston trainer.' },
      { id: 'f16', name: 'F-16C Fighting Falcon', shortName: 'F-16', description: 'Fighter.' },
    ],
    currentAircraft: () => aircraft,
    toggleSound: vi.fn(() => {
      sound = !sound;
    }),
    soundOn: () => sound,
    toggleHud: vi.fn(() => {
      hud = !hud;
    }),
    hudOn: () => hud,
    ...over,
  };
  return h;
}

let menu: Menu | null = null;
afterEach(() => {
  menu?.dispose();
  menu = null;
  document.body.innerHTML = '';
});

function make(over: Partial<MenuHost> = {}) {
  const h = host(over);
  menu = createMenu(document, h);
  document.body.appendChild(menu.element);
  const $ = (sel: string) => menu!.element.querySelector(sel) as HTMLElement;
  const btn = (text: string) => [...menu!.element.querySelectorAll('button')].find((b) => b.textContent!.trim().startsWith(text)) as HTMLButtonElement;
  return { h, m: menu, $, btn };
}
const key = (el: Element, code: string, k = code, opts: KeyboardEventInit = {}) => {
  const e = new KeyboardEvent('keydown', { code, key: k, bubbles: true, cancelable: true, ...opts });
  el.dispatchEvent(e);
  return e;
};

describe('menu: open and close', () => {
  it('starts hidden; open() shows a modal dialog with Resume focused', () => {
    const { m, $ } = make();
    expect(m.isOpen()).toBe(false);
    expect(m.element.hidden).toBe(true);
    m.open();
    expect(m.isOpen()).toBe(true);
    expect(m.element.hidden).toBe(false);
    expect($('[role="dialog"]').getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement?.textContent).toContain('Resume');
  });

  it('Resume closes it and un-pauses; focus goes back to the page (keys fly the aircraft again)', () => {
    const { h, m, btn } = make();
    m.open();
    btn('Resume').click();
    expect(m.isOpen()).toBe(false);
    expect(h.setPaused).toHaveBeenLastCalledWith(false);
    expect(m.element.contains(document.activeElement)).toBe(false);
  });

  it('the panel takes the pointer; the dim backdrop does not (the canvas keeps its drags)', () => {
    const { m, $ } = make();
    m.open();
    expect($('.tfs-panel').style.pointerEvents || getComputedStyle($('.tfs-panel')).pointerEvents).toBe('auto');
    expect($('.tfs-backdrop').style.pointerEvents).toBe('none');
  });
});

describe('menu: actions', () => {
  it('Restart on runway resets to the runway and resumes — every time', () => {
    const { h, m, btn } = make();
    for (let i = 0; i < 5; i++) {
      m.open();
      btn('Restart on runway').click();
      expect(m.isOpen()).toBe(false);
    }
    expect(h.reset).toHaveBeenCalledTimes(5);
    expect(h.reset).toHaveBeenLastCalledWith('runway');
    expect(h.setPaused).toHaveBeenLastCalledWith(false);
  });

  it('Start on final approach resets to the approach', () => {
    const { h, m, btn } = make();
    m.open();
    btn('Start on final approach').click();
    expect(h.reset).toHaveBeenCalledWith('approach');
    expect(m.isOpen()).toBe(false);
  });

  it('lists the fleet; choosing another aircraft selects it and closes; the current one is checked', () => {
    const { h, m, $ } = make();
    m.open();
    const cards = [...m.element.querySelectorAll('[role="radio"][data-aircraft]')] as HTMLElement[];
    expect(cards.map((c) => c.dataset.aircraft)).toEqual(['c172rg', 'f16']);
    expect(cards[0].getAttribute('aria-checked')).toBe('true');
    expect($('[data-aircraft="f16"]').textContent).toContain('Fighter.');
    cards[1].click();
    expect(h.selectAircraft).toHaveBeenCalledWith('f16');
    expect(m.isOpen()).toBe(false);
    m.open();
    expect($('[data-aircraft="f16"]').getAttribute('aria-checked')).toBe('true');
  });

  it('time of day, camera, sound and HUD controls call the host and show the current state', () => {
    const { h, m, $ } = make();
    m.open();
    ($('[data-tod="3"]') as HTMLButtonElement).click();
    expect(h.setTimeOfDay).toHaveBeenCalledWith(3);
    expect($('[data-tod="3"]').getAttribute('aria-pressed')).toBe('true');
    ($('[data-camera="cockpit"]') as HTMLButtonElement).click();
    expect(h.setCamera).toHaveBeenCalledWith('cockpit');
    expect($('[data-camera="cockpit"]').getAttribute('aria-pressed')).toBe('true');
    const sound = $('[data-toggle="sound"]') as HTMLButtonElement;
    expect(sound.getAttribute('aria-checked')).toBe('true');
    sound.click();
    expect(h.toggleSound).toHaveBeenCalled();
    expect(sound.getAttribute('aria-checked')).toBe('false');
    const hud = $('[data-toggle="hud"]') as HTMLButtonElement;
    hud.click();
    expect(h.toggleHud).toHaveBeenCalled();
    expect(hud.getAttribute('aria-checked')).toBe('false');
    expect(m.isOpen()).toBe(true);
  });

  it('refresh() picks up changes made elsewhere (keys M, I, N, C while the menu is up)', () => {
    let sound = true;
    const { m, $ } = make({ soundOn: () => sound });
    m.open();
    sound = false;
    m.refresh();
    expect($('[data-toggle="sound"]').getAttribute('aria-checked')).toBe('false');
  });
});

describe('menu: Controls page', () => {
  it('lists every group; Back returns to the menu', () => {
    const { m, btn, $ } = make();
    m.open();
    btn('Controls').click();
    const sheet = $('.tfs-controls');
    expect(sheet).not.toBeNull();
    expect($('[data-view="controls"]').hidden).toBe(false);
    expect($('[data-view="main"]').hidden).toBe(true);
    expect([...sheet.querySelectorAll('h3')].map((x) => x.textContent)).toEqual(['Flight', 'Engine & systems', 'Cameras', 'Sim']);
    expect(sheet.textContent).toContain('Speed brake');
    btn('Back').click();
    expect($('[data-view="main"]').hidden).toBe(false);
  });

  it('open("controls") goes straight to it', () => {
    const { m, $ } = make();
    m.open('controls');
    expect($('[data-view="controls"]').hidden).toBe(false);
  });
});

describe('menu: keyboard', () => {
  it('Esc or P inside the menu closes it and resumes, without the key reaching the sim', () => {
    const { h, m } = make();
    const leaked: string[] = [];
    const spy = (e: KeyboardEvent) => leaked.push(e.code);
    window.addEventListener('keydown', spy);
    for (const code of ['Escape', 'KeyP']) {
      m.open();
      key(document.activeElement!, code);
      expect(m.isOpen()).toBe(false);
    }
    window.removeEventListener('keydown', spy);
    expect(leaked).toEqual([]);
    expect(h.setPaused).toHaveBeenLastCalledWith(false);
  });

  it('H inside the menu shows the Controls page', () => {
    const { m, $ } = make();
    m.open();
    key(document.activeElement!, 'KeyH', 'h');
    expect($('[data-view="controls"]').hidden).toBe(false);
  });

  it('Space and Enter activate the focused button and do not leak (Space is the brake key)', () => {
    const { h, m, btn } = make();
    const leaked: string[] = [];
    const spy = (e: KeyboardEvent) => leaked.push(e.code);
    window.addEventListener('keydown', spy);
    m.open();
    const r = btn('Restart on runway');
    r.focus();
    key(r, 'Space', ' ');
    expect(h.reset).toHaveBeenCalledTimes(1);
    m.open();
    const f = btn('Start on final approach');
    f.focus();
    key(f, 'Enter', 'Enter');
    expect(h.reset).toHaveBeenLastCalledWith('approach');
    window.removeEventListener('keydown', spy);
    expect(leaked).toEqual([]);
  });

  it('arrow keys move focus through the menu and never reach the sim; Tab stays inside', () => {
    const { m } = make();
    const leaked: string[] = [];
    const spy = (e: KeyboardEvent) => leaked.push(e.code);
    window.addEventListener('keydown', spy);
    m.open();
    const first = document.activeElement;
    key(document.activeElement!, 'ArrowDown');
    expect(document.activeElement).not.toBe(first);
    expect(m.element.contains(document.activeElement)).toBe(true);
    key(document.activeElement!, 'ArrowUp');
    expect(document.activeElement).toBe(first);
    key(document.activeElement!, 'Tab', 'Tab', { shiftKey: true });
    expect(m.element.contains(document.activeElement)).toBe(true);
    window.removeEventListener('keydown', spy);
    expect(leaked).toEqual([]);
  });

  it('other keys (M mute, C camera…) still reach the sim while the menu is open', () => {
    const { m } = make();
    const seen: string[] = [];
    const spy = (e: KeyboardEvent) => seen.push(e.code);
    window.addEventListener('keydown', spy);
    m.open();
    key(document.activeElement!, 'KeyM', 'm');
    key(document.activeElement!, 'KeyC', 'c');
    window.removeEventListener('keydown', spy);
    expect(seen).toEqual(['KeyM', 'KeyC']);
  });

  it('property: any sequence of opens, closes and restarts leaves open state and pause consistent', () => {
    fc.assert(
      fc.property(fc.array(fc.constantFrom('open', 'resume', 'restart', 'approach', 'esc', 'close'), { maxLength: 20 }), (ops) => {
        const { h, m, btn } = make();
        for (const op of ops) {
          if (op === 'open') {
            h.setPaused(true);
            m.open();
          } else if (!m.isOpen()) continue;
          else if (op === 'resume') btn('Resume').click();
          else if (op === 'restart') btn('Restart on runway').click();
          else if (op === 'approach') btn('Start on final approach').click();
          else if (op === 'esc') key(document.activeElement ?? m.element, 'Escape');
          else m.close();
          if (!m.isOpen()) expect(h.isPaused()).toBe(false);
        }
        m.dispose();
        menu = null;
      }),
      { numRuns: 40 },
    );
  });
});

describe('top bar', () => {
  it('shows the mascot and the name, and a ☰ button that opens the menu', () => {
    const onMenu = vi.fn();
    const bar = createTopBar(document, { productName: "Tater's Flight Sim", fullName: 'Tater Tots Flight Simulator', onMenu });
    document.body.appendChild(bar.element);
    expect(bar.element.textContent).toContain("Tater's");
    expect(bar.element.textContent).toContain('Flight Sim');
    expect(bar.element.querySelector('.tfs-brand svg')).not.toBeNull();
    const b = bar.element.querySelector('button.tfs-menu-btn') as HTMLButtonElement;
    expect(b.getAttribute('aria-label')).toBe('Menu');
    b.click();
    expect(onMenu).toHaveBeenCalled();
    expect(bar.element.style.pointerEvents).toBe('none');
    expect(b.style.pointerEvents).toBe('auto');
    bar.dispose();
    expect(bar.element.isConnected).toBe(false);
  });
});
