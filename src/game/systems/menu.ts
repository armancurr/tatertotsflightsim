/**
 * The app chrome (owned by src/ui): the branding top bar with Tater the mascot, the aircraft picker
 * (upper right) and the ☰ button, and the pause menu (Esc / P / ☰). Everything the UI triggers goes
 * through `ctx.actions`; HUD visibility goes over the UI bus to the hud system.
 *
 *  - Esc/P: the app toggles pause, then this system opens the menu (or closes it when unpaused).
 *  - The chosen aircraft is remembered in localStorage and restored on the first frame when the URL
 *    has no ?aircraft= (fresh browser profiles — tests, screenshots — never see a saved choice).
 *  - Sound: SimActions has no mute, so the menu presses the mute key (config.controls.keys.mute)
 *    for the audio system, unless the app provides `actions.toggleMute()`.
 */
import { CONFIG } from '../../config';
import type { CameraMode } from '../../types';
import { createAircraftPicker, safeLocalStorage, saveAircraftChoice, aircraftToRestore, type PickerItem } from '../../ui/picker';
import { createMenu, type MenuHost } from '../../ui/menu';
import { createTopBar, topBarHeight } from '../../ui/topBar';
import { installUiStyle, removeUiStyle } from '../../ui/uiStyle';
import { uiBusFor } from '../../ui/uiBus';
import type { SimActions, SystemModule } from './types';

type ActionsPlus = SimActions & { toggleMute?(): void };

const mod: SystemModule = {
  name: 'menu',
  order: 105,
  create(ctx) {
    const cfg = CONFIG;
    const actions = ctx.actions as ActionsPlus;
    const doc = ctx.hudRoot.ownerDocument;
    const win = doc.defaultView ?? (globalThis as unknown as Window);
    const bus = uiBusFor(doc);
    const store = safeLocalStorage(win);
    installUiStyle(doc);

    let soundOn = true;
    let hudOn = true;
    let camera: CameraMode = 'chase';
    let tod = -1;

    const fleetItems = (): PickerItem[] =>
      actions.fleet().map((d) => ({ id: d.id, name: d.name, shortName: d.shortName, description: d.description }));
    const currentId = () => actions.currentAircraft().id;
    const select = (id: string) => {
      saveAircraftChoice(store, cfg.menu.storageKey, id);
      if (id !== currentId()) actions.selectAircraft(id);
    };
    const pressKey = (code: string) => {
      for (const type of ['keydown', 'keyup'] as const) win.dispatchEvent(new KeyboardEvent(type, { code, key: code.replace(/^Key/, '').toLowerCase(), bubbles: true }));
    };
    const toggleSound = () => {
      if (typeof actions.toggleMute === 'function') actions.toggleMute();
      else pressKey(cfg.controls.keys.mute[0]);
    };

    const host: MenuHost = {
      reset: (which) => actions.reset(which),
      selectAircraft: select,
      setPaused: (p) => actions.setPaused(p),
      isPaused: () => actions.isPaused(),
      setCamera: (m) => {
        actions.setCamera(m);
        camera = m;
      },
      cameraMode: () => camera,
      setTimeOfDay: (i) => actions.setTimeOfDay(i),
      getTimeOfDay: () => actions.getTimeOfDay(),
      timeOfDayNames: cfg.atmosphere.timeOfDay.map((t) => t.name),
      fleet: fleetItems,
      currentAircraft: currentId,
      toggleSound,
      soundOn: () => soundOn,
      toggleHud: () => bus.emit('toggleHud', undefined),
      hudOn: () => hudOn,
      onOpenChange: (open) => bus.emit('menuOpen', open),
    };

    const root = doc.createElement('div');
    root.className = 'tfs-root';
    const picker = createAircraftPicker(doc, { items: fleetItems(), current: currentId(), onSelect: select });
    const menu = createMenu(doc, host, cfg);
    const openMenu = () => {
      picker.close();
      actions.setPaused(true);
      menu.open();
    };
    const bar = createTopBar(doc, {
      productName: cfg.menu.productName,
      fullName: cfg.menu.fullName,
      widgets: [picker.element],
      onMenu: () => (menu.isOpen() ? menu.close(true) : openMenu()),
    });
    root.append(bar.element, menu.element);
    ctx.hudRoot.appendChild(root);
    const sizeBar = () => root.style.setProperty('--tfs-bar-h', `${topBarHeight(win.innerWidth || 1024)}px`);
    sizeBar();

    const offVisible = bus.on('hudVisible', (v) => {
      hudOn = v;
      if (menu.isOpen()) menu.refresh();
    });

    let restored = false;
    const restore = () => {
      let search = '';
      try {
        search = win.location?.search ?? '';
      } catch {
        search = '';
      }
      const want = aircraftToRestore(search, store, cfg.menu.storageKey, actions.fleet().map((d) => d.id), currentId());
      if (want) actions.selectAircraft(want);
    };

    return {
      update(f) {
        if (!restored) {
          restored = true;
          restore();
        }
        if (menu.isOpen()) {
          // Resumed some other way (window.sim.resume(), a key with the focus outside the menu).
          if (!f.paused) menu.close(false);
          else {
            const t = actions.getTimeOfDay();
            if (f.cameraMode !== camera || t !== tod) {
              camera = f.cameraMode;
              tod = t;
              menu.refresh();
            }
          }
        } else camera = f.cameraMode;
      },
      onAction(a) {
        if (a === 'pause') {
          if (actions.isPaused()) {
            if (!menu.isOpen()) {
              picker.close();
              menu.open();
            }
          } else if (menu.isOpen()) menu.close(false);
        } else if (a === 'mute') {
          soundOn = !soundOn;
          if (menu.isOpen()) menu.refresh();
        } else if (a === 'help' && menu.isOpen()) menu.open('controls');
      },
      onAircraftChange(def) {
        picker.setCurrent(def.id);
        if (menu.isOpen()) menu.refresh();
      },
      onResize: sizeBar,
      stats: () => ({ menuOpen: menu.isOpen(), pickerOpen: picker.isOpen(), aircraft: currentId() }),
      dispose() {
        offVisible();
        menu.dispose();
        picker.dispose();
        bar.dispose();
        root.remove();
        removeUiStyle(doc);
      },
    };
  },
};
export default mod;
