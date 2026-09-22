/**
 * Wires the keyboard, mouse and gamepad adapters to a canvas and produces one `InputFrame`
 * per rendered frame for the pure control system and camera rig.
 *
 *   const input = createInputManager(renderer.domElement);
 *   // each frame:
 *   const f = input.frame();                       // consumes key edges + mouse deltas
 *   ({ state: controlState, actions } = updateControls(controlState, f, frameDt));
 *   camInput = { dx: f.mouse.dx, dy: f.mouse.dy, wheel: f.mouse.wheel, dragging: f.mouse.dragging, shake };
 */
import { CONFIG, type Config } from '../config';
import { boundKeyCodes, type InputFrame } from './controlSystem';
import { createKeyboard } from './keyboard';
import { createMouse } from './mouse';
import { createGamepadPoller } from './gamepad';

export interface InputManager {
  /** Snapshot of the current input; consumes key-down edges and mouse deltas. Call once per frame. */
  frame(): InputFrame;
  dispose(): void;
}

export function createInputManager(canvas: HTMLElement, win: Window = globalThis.window, cfg: Config = CONFIG): InputManager {
  const keyboard = createKeyboard(win, boundKeyCodes(cfg));
  const mouse = createMouse(canvas);
  const gamepad = createGamepadPoller(win.navigator);
  let disposed = false;

  return {
    frame(): InputFrame {
      return {
        held: new Set(keyboard.held),
        pressed: keyboard.consumePressed(),
        shift: keyboard.shift(),
        mouse: mouse.frame(),
        gamepad: disposed ? null : gamepad.poll(),
      };
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      keyboard.dispose();
      mouse.dispose();
    },
  };
}
