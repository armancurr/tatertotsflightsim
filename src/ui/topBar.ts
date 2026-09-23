/**
 * The slim branding bar across the top: Tater the mascot and "Tater's Flight Sim" on the left, the
 * aircraft picker and the ☰ menu button on the right. The bar itself never takes the mouse (the 3D
 * canvas needs its drags); only the buttons do. Its height scales with the viewport width
 * (config.hud.topBar), and the HUD lays out below it (see computeHudLayout).
 */
import { CONFIG, type Config } from '../config';
import { mascotSvg } from './mascot';

/** Top bar height (CSS px) for a viewport width: config height at 1024 and 1440, linear between, clamped. */
export function topBarHeight(width: number, cfg: Config = CONFIG): number {
  const t = cfg.hud.topBar;
  const w = Number.isFinite(width) && width > 0 ? width : 1024;
  const k = Math.min(1.25, Math.max(-0.5, (w - 1024) / (1440 - 1024)));
  return Math.round(Math.max(30, Math.min(48, t.height1024 + (t.height1440 - t.height1024) * k)));
}

export interface TopBarOptions {
  productName: string;
  fullName: string;
  onMenu(): void;
  /** Extra widget(s) placed before the menu button (the aircraft picker). */
  widgets?: HTMLElement[];
}

export interface TopBar {
  readonly element: HTMLElement;
  dispose(): void;
}

const MENU_ICON =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';

export function createTopBar(doc: Document, opts: TopBarOptions): TopBar {
  const el = doc.createElement('header');
  el.className = 'tfs-topbar';
  el.style.pointerEvents = 'none';
  const brand = doc.createElement('div');
  brand.className = 'tfs-brand';
  brand.title = opts.fullName;
  brand.innerHTML = mascotSvg({ title: `${opts.productName} logo` });
  const name = doc.createElement('span');
  name.className = 'tfs-name';
  const sp = opts.productName.indexOf(' ');
  const a = doc.createElement('span');
  a.className = 'tfs-name-a';
  a.textContent = sp > 0 ? opts.productName.slice(0, sp) : opts.productName;
  name.appendChild(a);
  if (sp > 0) name.appendChild(doc.createTextNode(opts.productName.slice(sp)));
  const small = doc.createElement('small');
  small.textContent = opts.fullName;
  name.appendChild(small);
  brand.appendChild(name);
  const actions = doc.createElement('div');
  actions.className = 'tfs-actions';
  for (const w of opts.widgets ?? []) actions.appendChild(w);
  const menu = doc.createElement('button');
  menu.type = 'button';
  menu.className = 'tfs-menu-btn';
  menu.style.pointerEvents = 'auto';
  menu.setAttribute('aria-label', 'Menu');
  menu.title = 'Menu (Esc)';
  menu.innerHTML = MENU_ICON;
  let mouse = false;
  menu.addEventListener('pointerdown', () => {
    mouse = true;
  });
  menu.addEventListener('click', () => {
    opts.onMenu();
    if (mouse) menu.blur();
    mouse = false;
  });
  actions.appendChild(menu);
  el.append(brand, actions);
  return {
    element: el,
    dispose: () => el.remove(),
  };
}
