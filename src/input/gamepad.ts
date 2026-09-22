/**
 * Gamepad adapter (optional). Polls navigator.getGamepads() each frame; never throws when the
 * API is missing, blocked or empty.
 *
 * Standard mapping: left stick x → roll, left stick y → pitch (pull back = +1 = nose up),
 * right stick x → yaw, right trigger → throttle, left trigger → brake.
 * Deadzones are applied by the control system (config.controls.gamepadDeadzone).
 *
 * The trigger throttle is reported only while the trigger is in use (pressed, or still moving),
 * so a resting trigger doesn't pin the throttle at idle and the keyboard W/S keep working.
 * Releasing the trigger reports its travel back to 0 (idle), then null again.
 */
import type { GamepadFrame } from './controlSystem';

export interface GamepadLike {
  readonly axes: readonly number[];
  readonly buttons: readonly { readonly value: number; readonly pressed?: boolean }[];
  readonly connected?: boolean;
  readonly mapping?: string;
}

export interface GamepadPoller {
  poll(): GamepadFrame | null;
}

/** Trigger values above this count as "in use". */
const TRIGGER_ACTIVE = 0.05;
/** A trigger change larger than this counts as "moving". */
const TRIGGER_MOVE = 0.005;

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** Pure mapping of one pad's raw axes/buttons (throttle = raw right trigger, never null). */
export function readGamepad(pad: GamepadLike): GamepadFrame & { throttle: number } {
  const axes = pad.axes ?? [];
  const buttons = pad.buttons ?? [];
  const standard = pad.mapping === 'standard';
  return {
    roll: num(axes[0]),
    pitch: num(axes[1]),
    yaw: num(axes[2]),
    throttle: standard ? num(buttons[7]?.value) : 0,
    brake: standard ? num(buttons[6]?.value) : 0,
  };
}

export function createGamepadPoller(nav: Navigator | undefined): GamepadPoller {
  let lastTrigger: number | null = null;
  return {
    poll(): GamepadFrame | null {
      let pads: readonly (GamepadLike | null)[] | undefined;
      try {
        const get = (nav as { getGamepads?: () => readonly (GamepadLike | null)[] } | undefined)?.getGamepads;
        if (typeof get !== 'function') return null;
        pads = get.call(nav);
      } catch {
        return null;
      }
      if (!pads) return null;
      let pad: GamepadLike | null = null;
      for (let i = 0; i < pads.length; i++) {
        const p = pads[i];
        if (p && p.connected !== false) { pad = p; break; }
      }
      if (!pad) {
        lastTrigger = null;
        return null;
      }
      const raw = readGamepad(pad);
      const t = raw.throttle;
      const prev = lastTrigger;
      lastTrigger = t;
      const inUse = t > TRIGGER_ACTIVE || (prev !== null && Math.abs(t - prev) > TRIGGER_MOVE);
      return { ...raw, throttle: inUse ? t : null };
    },
  };
}
