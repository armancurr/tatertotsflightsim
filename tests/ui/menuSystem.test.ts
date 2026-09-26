// @vitest-environment happy-dom
/**
 * The menu and hud systems wired together with a fake SystemContext (happy-dom): the pause key
 * opens/closes the menu, Restart calls actions.reset every time, the picker and the menu call
 * actions.selectAircraft and remember it in localStorage, the saved aircraft comes back on the
 * first frame unless the URL names one, the jet HUD switches on with the F-16, sound and HUD
 * switches reach their systems.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { CONFIG } from '../../src/config';
import { FLEET, getAircraftDef } from '../../src/fleet';
import type { AircraftDef } from '../../src/fleet/types';
import type { SimSystem, SystemContext, SystemFrame, SimActions } from '../../src/game/systems/types';
import menuModule from '../../src/game/systems/menu';
import hudModule from '../../src/game/systems/hud';
import { mockCtx, makeState, makeControls, makeReadings } from './fixtures';

const KEY = CONFIG.menu.storageKey;

function fakeActions() {
  let paused = false;
  let def: AircraftDef = getAircraftDef('c172rg');
  let tod = 0;
  const a = {
    reset: vi.fn(),
    selectAircraft: vi.fn((id: string) => {
      def = getAircraftDef(id);
    }),
    setPaused: vi.fn((p: boolean) => {
      paused = p;
    }),
    isPaused: () => paused,
    setCamera: vi.fn(),
    setTimeOfDay: vi.fn((i: number) => {
      tod = i;
    }),
    getTimeOfDay: () => tod,
    fleet: () => FLEET,
    currentAircraft: () => def,
  } satisfies SimActions;
  return a;
}

function frame(over: Partial<SystemFrame> = {}): SystemFrame {
  return {
    state: makeState(), controls: makeControls(),
    controlState: { mouseYoke: false, landingLight: false } as SystemFrame['controlState'],
    camera: {} as SystemFrame['camera'], dt: 1 / 60, time: 1, waveTime: 1, paused: false, cameraMode: 'chase',
    fps: { fps: 60, avg: 60, min: 60, onePercentLow: 60, longFrames: 0, frames: 60 },
    readings: makeReadings(), def: FLEET[0], aircraft: {} as SystemFrame['aircraft'],
    ...over,
  };
}

let systems: SimSystem[] = [];
let actions: ReturnType<typeof fakeActions>;
let hudRoot: HTMLElement;

async function boot(search = '') {
  window.history.replaceState(null, '', `/${search}`);
  actions = fakeActions();
  const ctx = {
    hudRoot, actions, aircraft: { setPanelDrawer: () => undefined },
    atmosphere: { timeOfDayName: 'Morning' },
  } as unknown as SystemContext;
  systems = [await hudModule.create(ctx), await menuModule.create(ctx)];
  const [hud, menu] = systems;
  return { hud, menu };
}
const $ = (sel: string) => document.querySelector(sel) as HTMLElement | null;
const btn = (text: string) => [...document.querySelectorAll('.tfs-panel button')].find((b) => b.textContent!.trim().startsWith(text)) as HTMLButtonElement;

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = function () {
    return mockCtx().ctx;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext;
  document.body.innerHTML = '<div id="hud"></div>';
  hudRoot = document.getElementById('hud')!;
  try {
    window.localStorage.clear();
  } catch {
    /* ignore */
  }
});
afterEach(() => {
  for (const s of systems.reverse()) s.dispose?.();
  systems = [];
});

describe('menu system', () => {
  it('builds the top bar (mascot, name, picker, ☰) in the HUD root without taking the pointer', async () => {
    await boot();
    const bar = $('.tfs-topbar')!;
    expect(bar.textContent).toContain("Tater's");
    expect($('.tfs-picker-button')!.textContent).toContain('Cessna 172');
    expect($('.tfs-menu-btn')).not.toBeNull();
    expect(($('.tfs-root') as HTMLElement).parentElement).toBe(hudRoot);
    expect(bar.style.pointerEvents).toBe('none');
  });

  it('the pause key opens the menu once the app has paused; un-pausing closes it', async () => {
    const { menu } = await boot();
    actions.setPaused(true);
    menu.onAction!('pause');
    expect($('.tfs-menu')!.hidden).toBe(false);
    actions.setPaused(false);
    menu.onAction!('pause');
    expect($('.tfs-menu')!.hidden).toBe(true);
  });

  it('Esc inside the menu resumes; window.sim.resume() (a frame with paused=false) closes it too', async () => {
    const { menu } = await boot();
    actions.setPaused(true);
    menu.onAction!('pause');
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { code: 'Escape', key: 'Escape', bubbles: true }));
    expect(actions.isPaused()).toBe(false);
    expect($('.tfs-menu')!.hidden).toBe(true);
    actions.setPaused(true);
    menu.onAction!('pause');
    menu.update!(frame({ paused: false }));
    expect($('.tfs-menu')!.hidden).toBe(true);
  });

  it('☰ pauses and opens; Restart on runway calls actions.reset every time and resumes', async () => {
    await boot();
    for (let i = 0; i < 4; i++) {
      ($('.tfs-menu-btn') as HTMLButtonElement).click();
      expect(actions.isPaused()).toBe(true);
      btn('Restart on runway').click();
      expect(actions.isPaused()).toBe(false);
    }
    expect(actions.reset).toHaveBeenCalledTimes(4);
    expect(actions.reset).toHaveBeenCalledWith('runway');
    ($('.tfs-menu-btn') as HTMLButtonElement).click();
    btn('Start on final approach').click();
    expect(actions.reset).toHaveBeenLastCalledWith('approach');
  });

  it('the picker calls actions.selectAircraft and remembers the choice; onAircraftChange updates the label', async () => {
    const { menu, hud } = await boot();
    ($('.tfs-picker-button') as HTMLButtonElement).click();
    ([...document.querySelectorAll('.tfs-picker-list [role="option"]')][1] as HTMLElement).click();
    expect(actions.selectAircraft).toHaveBeenCalledWith('f16');
    expect(window.localStorage.getItem(KEY)).toBe('f16');
    const f16 = getAircraftDef('f16');
    hud.onAircraftChange!(f16, { setPanelDrawer: () => undefined } as never);
    menu.onAircraftChange!(f16, {} as never);
    expect($('.tfs-picker-button')!.textContent).toContain('F-16');
  });

  it('restores the saved aircraft on the first frame when the URL has no ?aircraft=', async () => {
    window.localStorage.setItem(KEY, 'f16');
    const { menu } = await boot('?veil=0');
    expect(actions.selectAircraft).not.toHaveBeenCalled();
    menu.update!(frame());
    expect(actions.selectAircraft).toHaveBeenCalledWith('f16');
    menu.update!(frame());
    expect(actions.selectAircraft).toHaveBeenCalledTimes(1);
  });

  it('the URL wins over the saved choice', async () => {
    window.localStorage.setItem(KEY, 'f16');
    const { menu } = await boot('?aircraft=c172rg');
    menu.update!(frame());
    expect(actions.selectAircraft).not.toHaveBeenCalled();
  });

  it('broken storage (throws) never breaks start-up or picking', async () => {
    const spy = vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    const { menu } = await boot();
    menu.update!(frame());
    ($('.tfs-picker-button') as HTMLButtonElement).click();
    ([...document.querySelectorAll('.tfs-picker-list [role="option"]')][1] as HTMLElement).click();
    expect(actions.selectAircraft).toHaveBeenCalledWith('f16');
    spy.mockRestore();
  });

  it('the Sound switch presses the mute key for the audio system; the mute action flips the switch', async () => {
    const { menu } = await boot();
    const codes: string[] = [];
    const spy = (e: KeyboardEvent) => codes.push(e.code);
    window.addEventListener('keydown', spy);
    ($('.tfs-menu-btn') as HTMLButtonElement).click();
    const sw = $('[data-toggle="sound"]') as HTMLButtonElement;
    sw.click();
    window.removeEventListener('keydown', spy);
    expect(codes).toEqual([CONFIG.controls.keys.mute[0]]);
    menu.onAction!('mute');
    expect(sw.getAttribute('aria-checked')).toBe('false');
  });

  it('the HUD switch hides the instruments (via the hud system) and shows it', async () => {
    await boot();
    ($('.tfs-menu-btn') as HTMLButtonElement).click();
    const sw = $('[data-toggle="hud"]') as HTMLButtonElement;
    sw.click();
    expect(($('.fsh-instruments') as HTMLElement).hidden).toBe(true);
    expect(sw.getAttribute('aria-checked')).toBe('false');
    sw.click();
    expect(($('.fsh-instruments') as HTMLElement).hidden).toBe(false);
  });
});

describe('hud system', () => {
  it('switches to the jet HUD for the F-16 and back to steam gauges for the Cessna', async () => {
    const { hud } = await boot();
    expect($('.fsh-left')!.hidden).toBe(false);
    hud.onAircraftChange!(getAircraftDef('f16'), { setPanelDrawer: () => undefined } as never);
    hud.update!(frame());
    expect($('.fsh-left')!.hidden).toBe(true);
    expect($('.fsh-jet')!.hidden).toBe(false);
    hud.onAircraftChange!(getAircraftDef('c172rg'), { setPanelDrawer: () => undefined } as never);
    expect($('.fsh-left')!.hidden).toBe(false);
    expect($('.fsh-jet')!.hidden).toBe(true);
  });

  it('reads the instruments with the flown aircraft\'s config (F-16: no 250 kt peg) and tags the aircraft id', async () => {
    const { hud } = await boot();
    hud.onAircraftChange!(getAircraftDef('f16'), { setPanelDrawer: () => undefined } as never);
    const r = hud.readings!(makeState({ iasKt: 480 }), makeControls(), 1 / 60)!;
    expect(r.airspeedKt).toBeCloseTo(480, 0);
    expect(r.aircraftId).toBe('f16');
  });

  it('H toggles the help overlay, except while the pause menu is up (the menu shows its Controls page)', async () => {
    const { hud, menu } = await boot();
    hud.onAction!('help');
    expect($('.fsh-help')!.hidden).toBe(false);
    hud.onAction!('help');
    actions.setPaused(true);
    menu.onAction!('pause');
    hud.onAction!('help');
    menu.onAction!('help');
    expect($('.fsh-help')!.hidden).toBe(true);
    expect(($('[data-view="controls"]') as HTMLElement).hidden).toBe(false);
  });
});
