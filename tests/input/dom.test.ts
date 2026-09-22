// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createInputManager, type InputManager } from '../../src/input/inputManager';
import { createKeyboard } from '../../src/input/keyboard';
import { createMouse } from '../../src/input/mouse';
import { createGamepadPoller, readGamepad, type GamepadLike } from '../../src/input/gamepad';
import { boundKeyCodes } from '../../src/input/controlSystem';

function key(type: 'keydown' | 'keyup', code: string, opts: KeyboardEventInit = {}): KeyboardEvent {
  const e = new KeyboardEvent(type, { code, key: code, bubbles: true, cancelable: true, ...opts });
  window.dispatchEvent(e);
  return e;
}

function makeCanvas(): HTMLElement {
  const c = document.createElement('canvas');
  document.body.appendChild(c);
  c.getBoundingClientRect = () => ({ left: 100, top: 50, width: 800, height: 600, right: 900, bottom: 650, x: 100, y: 50, toJSON() { return {}; } }) as DOMRect;
  return c;
}

function pointer(el: HTMLElement, type: string, clientX: number, clientY: number, opts: PointerEventInit = {}): PointerEvent {
  const e = new PointerEvent(type, { clientX, clientY, pointerId: 1, button: 0, bubbles: true, cancelable: true, isPrimary: true, ...opts });
  el.dispatchEvent(e);
  return e;
}

function pad(axes: number[], buttons: number[] = [], mapping = 'standard'): GamepadLike {
  return { axes, buttons: buttons.map((value) => ({ value, pressed: value > 0.5 })), connected: true, mapping };
}

describe('keyboard adapter', () => {
  let kb: ReturnType<typeof createKeyboard>;
  beforeEach(() => { kb = createKeyboard(window, boundKeyCodes()); });
  afterEach(() => kb.dispose());

  it('tracks held keys and records key-down edges once', () => {
    key('keydown', 'ArrowUp');
    expect(kb.held.has('ArrowUp')).toBe(true);
    expect(kb.consumePressed()).toEqual([{ code: 'ArrowUp', shift: false }]);
    expect(kb.consumePressed()).toEqual([]);
    expect(kb.held.has('ArrowUp')).toBe(true);
    key('keyup', 'ArrowUp');
    expect(kb.held.has('ArrowUp')).toBe(false);
  });
  it('ignores auto-repeat for edges', () => {
    key('keydown', 'KeyG');
    key('keydown', 'KeyG', { repeat: true });
    key('keydown', 'KeyG', { repeat: true });
    expect(kb.consumePressed()).toEqual([{ code: 'KeyG', shift: false }]);
  });
  it('records Shift with the press (Shift+R)', () => {
    key('keydown', 'ShiftLeft', { shiftKey: true });
    key('keydown', 'KeyR', { shiftKey: true });
    expect(kb.shift()).toBe(true);
    expect(kb.consumePressed()).toEqual([{ code: 'ShiftLeft', shift: true }, { code: 'KeyR', shift: true }]);
    key('keyup', 'ShiftLeft');
    expect(kb.shift()).toBe(false);
  });
  it('preventDefaults every bound key so arrows/Space/PageUp never scroll the page', () => {
    for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'PageUp', 'PageDown', 'KeyW', 'Digit1', 'BracketLeft']) {
      expect(key('keydown', code).defaultPrevented).toBe(true);
      expect(key('keyup', code).defaultPrevented).toBe(true);
    }
    expect(key('keydown', 'KeyQ').defaultPrevented).toBe(false);
    expect(key('keydown', 'F5').defaultPrevented).toBe(false);
  });
  it('leaves browser shortcuts alone (Cmd/Ctrl + key is not a control input)', () => {
    const e = key('keydown', 'KeyR', { metaKey: true });
    expect(e.defaultPrevented).toBe(false);
    expect(kb.consumePressed()).toEqual([]);
    expect(kb.held.has('KeyR')).toBe(false);
    expect(key('keydown', 'Minus', { ctrlKey: true }).defaultPrevented).toBe(false);
  });
  it('clears held keys on window blur (no stuck keys)', () => {
    key('keydown', 'KeyW');
    key('keydown', 'Space');
    window.dispatchEvent(new Event('blur'));
    expect(kb.held.size).toBe(0);
    expect(kb.shift()).toBe(false);
  });
  it('clears held keys when the tab is hidden', () => {
    key('keydown', 'ArrowLeft');
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    expect(kb.held.size).toBe(0);
  });
  it('clears held keys when Meta is released (macOS swallows keyups while Cmd is down)', () => {
    key('keydown', 'KeyW');
    key('keydown', 'MetaLeft', { metaKey: true });
    key('keyup', 'MetaLeft');
    expect(kb.held.has('KeyW')).toBe(false);
  });
  it('ignores typing in text fields', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    const e = new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true, cancelable: true });
    input.dispatchEvent(e);
    expect(kb.held.has('KeyW')).toBe(false);
    expect(e.defaultPrevented).toBe(false);
    input.remove();
  });
  it('stops listening after dispose', () => {
    kb.dispose();
    key('keydown', 'KeyW');
    expect(kb.held.has('KeyW')).toBe(false);
  });
});

describe('mouse adapter', () => {
  it('normalises the pointer position to -1..1 from the canvas centre (+y down)', () => {
    const c = makeCanvas();
    const m = createMouse(c);
    pointer(c, 'pointermove', 500, 350); // centre
    let f = m.frame();
    expect(f.x).toBeCloseTo(0, 6);
    expect(f.y).toBeCloseTo(0, 6);
    expect(f.inside).toBe(true);
    pointer(c, 'pointermove', 900, 650); // bottom-right corner
    f = m.frame();
    expect(f.x).toBeCloseTo(1, 6);
    expect(f.y).toBeCloseTo(1, 6);
    pointer(c, 'pointermove', 300, 200);
    f = m.frame();
    expect(f.x).toBeCloseTo(-0.5, 6);
    expect(f.y).toBeCloseTo(-0.5, 6);
    c.dispatchEvent(new PointerEvent('pointerleave', { bubbles: false }));
    expect(m.frame().inside).toBe(false);
    m.dispose();
  });
  it('accumulates drag deltas only while a button is down, and consumes them per frame', () => {
    const c = makeCanvas();
    const m = createMouse(c);
    pointer(c, 'pointermove', 400, 300);
    pointer(c, 'pointermove', 420, 310); // hover: no drag
    expect(m.frame().dx).toBe(0);
    pointer(c, 'pointerdown', 420, 310);
    pointer(c, 'pointermove', 430, 305);
    pointer(c, 'pointermove', 450, 300);
    let f = m.frame();
    expect(f.dragging).toBe(true);
    expect(f.dx).toBe(30);
    expect(f.dy).toBe(-10);
    f = m.frame();
    expect(f.dx).toBe(0);
    expect(f.dy).toBe(0);
    expect(f.dragging).toBe(true);
    pointer(c, 'pointerup', 450, 300);
    pointer(c, 'pointermove', 470, 300);
    f = m.frame();
    expect(f.dragging).toBe(false);
    expect(f.dx).toBe(0);
    m.dispose();
  });
  it('turns wheel events into notches and stops the page from scrolling', () => {
    const c = makeCanvas();
    const m = createMouse(c);
    const w = new WheelEvent('wheel', { deltaY: 200, deltaMode: 0, bubbles: true, cancelable: true });
    c.dispatchEvent(w);
    expect(w.defaultPrevented).toBe(true);
    c.dispatchEvent(new WheelEvent('wheel', { deltaY: -3, deltaMode: 1, bubbles: true, cancelable: true }));
    expect(m.frame().wheel).toBeCloseTo(1, 6);
    expect(m.frame().wheel).toBe(0);
    m.dispose();
  });
  it('suppresses the context menu on the canvas (right-drag)', () => {
    const c = makeCanvas();
    const m = createMouse(c);
    const e = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    c.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    m.dispose();
  });
});

describe('gamepad adapter', () => {
  it('maps the standard layout: left stick roll/pitch, right stick x yaw, RT throttle, LT brake', () => {
    const buttons = new Array(17).fill(0);
    buttons[6] = 0.4; // LT
    buttons[7] = 0.9; // RT
    const r = readGamepad(pad([0.5, 0.25, -0.3, 0], buttons));
    expect(r.roll).toBe(0.5);
    expect(r.pitch).toBe(0.25); // stick pulled back (+y) = pull
    expect(r.yaw).toBe(-0.3);
    expect(r.throttle).toBe(0.9);
    expect(r.brake).toBe(0.4);
  });
  it('never throws when gamepads are unsupported or fail', () => {
    expect(createGamepadPoller(undefined).poll()).toBeNull();
    expect(createGamepadPoller({} as Navigator).poll()).toBeNull();
    expect(createGamepadPoller({ getGamepads: () => { throw new Error('denied'); } } as unknown as Navigator).poll()).toBeNull();
    expect(createGamepadPoller({ getGamepads: () => [null, null] } as unknown as Navigator).poll()).toBeNull();
  });
  it('reports the trigger throttle only while it is being used, so the keyboard keeps working', () => {
    const buttons = new Array(17).fill(0);
    let current = pad([0, 0, 0, 0], buttons);
    const poller = createGamepadPoller({ getGamepads: () => [current] } as unknown as Navigator);
    expect(poller.poll()!.throttle).toBeNull(); // resting trigger
    const b2 = buttons.slice(); b2[7] = 0.6;
    current = pad([0, 0, 0, 0], b2);
    expect(poller.poll()!.throttle).toBe(0.6);
    expect(poller.poll()!.throttle).toBe(0.6); // held steady
    const b3 = buttons.slice(); b3[7] = 0;
    current = pad([0, 0, 0, 0], b3);
    expect(poller.poll()!.throttle).toBe(0); // released → idle once
    expect(poller.poll()!.throttle).toBeNull(); // then hands back to the keyboard
  });
});

describe('input manager', () => {
  let mgr: InputManager;
  let canvas: HTMLElement;
  beforeEach(() => { canvas = makeCanvas(); mgr = createInputManager(canvas, window); });
  afterEach(() => { mgr.dispose(); canvas.remove(); });

  it('builds an InputFrame and consumes edges and mouse deltas', () => {
    key('keydown', 'KeyW');
    key('keydown', 'KeyR', { shiftKey: true });
    pointer(canvas, 'pointerdown', 500, 350);
    pointer(canvas, 'pointermove', 510, 360);
    const f = mgr.frame();
    expect(f.held.has('KeyW')).toBe(true);
    expect(f.pressed).toEqual([{ code: 'KeyW', shift: false }, { code: 'KeyR', shift: true }]);
    expect(f.mouse.dx).toBe(10);
    expect(f.mouse.dragging).toBe(true);
    expect(f.gamepad).toBeNull();
    const g = mgr.frame();
    expect(g.pressed).toEqual([]);
    expect(g.mouse.dx).toBe(0);
    expect(g.held.has('KeyW')).toBe(true);
  });
  it('the frame is a snapshot: later key events do not change it', () => {
    key('keydown', 'KeyA');
    const f = mgr.frame();
    key('keyup', 'KeyA');
    expect(f.held.has('KeyA')).toBe(true);
  });
  it('dispose removes all listeners', () => {
    mgr.dispose();
    key('keydown', 'KeyW');
    expect(mgr.frame().held.size).toBe(0);
  });
});
