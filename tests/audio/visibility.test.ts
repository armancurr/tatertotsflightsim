// @vitest-environment happy-dom
/**
 * The audio system and page visibility: a hidden tab stops the frame loop, so the engine must not keep
 * droning at its last level — the context is suspended while hidden and resumed (only if we suspended
 * it) when the tab is shown again. Also: the first pointerup/touchend unlocks audio (iOS Safari does
 * not treat a touch pointerdown as a user activation).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import mod from '../../src/game/systems/audio';
import type { SimSystem, SystemContext } from '../../src/game/systems/types';
import type { AircraftDef } from '../../src/fleet/types';
import { MockAudioContext, violations } from './mockAudio';

type G = Record<string, unknown>;
const g = globalThis as unknown as G;
let savedCtx: unknown;
let sys: SimSystem | null = null;
const piston = { id: 'c172rg', sound: 'piston' } as unknown as AircraftDef;
const ctxStub = () => ({ env: { surfaceAt: () => 'runway' }, actions: { currentAircraft: () => piston } }) as unknown as SystemContext;

let hidden = false;
function setHidden(h: boolean) {
  hidden = h;
  document.dispatchEvent(new Event('visibilitychange'));
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const ctx = () => MockAudioContext.instances.at(-1) as unknown as { state: string; resumeCalls: number };

beforeEach(() => {
  violations.length = 0;
  savedCtx = g.AudioContext;
  g.AudioContext = MockAudioContext;
  MockAudioContext.instances.length = 0;
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
  hidden = false;
});
afterEach(() => {
  sys?.dispose?.();
  sys = null;
  g.AudioContext = savedCtx;
  delete (document as unknown as G).hidden;
  expect(violations).toEqual([]);
});

describe('audio and page visibility', () => {
  it('suspends the running context while the tab is hidden and resumes it when shown', async () => {
    sys = await mod.create(ctxStub());
    window.dispatchEvent(new Event('keydown'));
    await tick();
    expect(ctx().state).toBe('running');
    setHidden(true);
    await tick();
    expect(ctx().state).toBe('suspended');
    setHidden(false);
    await tick();
    expect(ctx().state).toBe('running');
  });

  it('does not resume a context it did not suspend (audio never unlocked stays locked)', async () => {
    sys = await mod.create(ctxStub());
    setHidden(true);
    setHidden(false);
    await tick();
    expect(MockAudioContext.instances.length).toBe(0);
  });

  it('a touch (pointerup / touchend) unlocks audio', async () => {
    sys = await mod.create(ctxStub());
    window.dispatchEvent(new Event('touchend'));
    await tick();
    expect(ctx().state).toBe('running');
  });

  it('dispose removes the listeners (no unlock, no visibility handling afterwards)', async () => {
    sys = await mod.create(ctxStub());
    sys.dispose?.();
    sys = null;
    window.dispatchEvent(new Event('pointerup'));
    setHidden(true);
    await tick();
    expect(MockAudioContext.instances.length).toBe(0);
  });
});
