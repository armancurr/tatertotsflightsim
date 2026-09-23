/**
 * The effects shared per scene between the fx system (which owns and draws them, and plays the
 * touchdown smoke) and the crash director (which plays the crash on them and sets the slow-motion
 * time scale). A WeakMap keyed by the scene: no global state, gone with the scene.
 */
import type { Effects } from './effects';

export interface FxHub {
  /** The scene's effects (null until the fx system has started, or when it is switched off). */
  effects: Effects | null;
  /** Effects time scale (slow motion during a crash), set by the crash director; 1 otherwise. */
  timeScale: number;
  /** A crash director is running: the fx system leaves crashes to it. */
  director: boolean;
}

const hubs = new WeakMap<object, FxHub>();

export function fxHub(scene: object): FxHub {
  let h = hubs.get(scene);
  if (!h) {
    h = { effects: null, timeScale: 1, director: false };
    hubs.set(scene, h);
  }
  return h;
}
