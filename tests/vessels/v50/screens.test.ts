/**
 * The V50's live helm displays (src/vessels/v50/screens.ts): the screen data follows the helm
 * readings (quantised to what is shown), the static idle look without instruments, and the
 * throttled repaint — a change in a shown value repaints (at most 5 Hz), unchanged readings
 * never do — both on the pure updater and through the model.
 */
import { describe, it, expect } from 'vitest';
import { createScreenUpdater, createV50Model, screenData, screenKey, SCREEN_HZ, V50_PART } from '../../../src/vessels/v50';
import { createDefaultVisualState, createRestReadings, type AircraftVisualState } from '../../../src/aircraft/types';
import type { InstrumentReadings, VesselReadings } from '../../../src/types';

function readings(patch: Partial<VesselReadings> = {}, headingDeg = 90): InstrumentReadings {
  const vessel: VesselReadings = {
    speedKt: 28, sogKt: 28.4, rpm: [3230, 3230], loadPct: [82, 81], leverPct: 90, gear: 'ahead', steerDeg: 0, tabsPct: 20,
    trimDeg: 3.1, heelDeg: 0, depthM: null, planingPct: 95, moored: false, aground: false,
    ...patch,
  };
  return { ...createRestReadings(), headingDeg, vessel };
}
const state = (instruments: InstrumentReadings | null): AircraftVisualState => ({ ...createDefaultVisualState(), instruments });

describe('V50 helm screens: data', () => {
  it('is null (static idle look) without instruments or without vessel readings', () => {
    expect(screenData(state(null))).toBeNull();
    expect(screenData(state(createRestReadings()))).toBeNull();
    expect(screenKey(null)).toBe('static');
  });

  it('follows the readings, quantised to what the screens show', () => {
    const d = screenData(state(readings({ sogKt: 28.437, rpm: [3234, 3226] }, 361.4)))!;
    expect(d.sogKt).toBeCloseTo(28.4, 9);
    expect(d.rpm).toEqual([3230, 3230]);
    expect(d.headingDeg).toBe(1);
    expect(d.gear).toBe('ahead');
    expect(d.depthM).toBeNull();
    // Sub-resolution jitter doesn't change the key; a shown change does.
    const k = screenKey(d);
    expect(screenKey(screenData(state(readings({ sogKt: 28.44, rpm: [3232, 3228] }, 361.2))))).toBe(k);
    expect(screenKey(screenData(state(readings({ sogKt: 28.6 }, 1))))).not.toBe(k);
    expect(screenKey(screenData(state(readings({ gear: 'neutral' }, 1))))).not.toBe(k);
    expect(screenKey(screenData(state(readings({ depthM: 4.2 }, 1))))).not.toBe(k);
  });

  it('tolerates garbage (NaN, missing arrays)', () => {
    const d = screenData(state(readings({ sogKt: NaN, rpm: undefined as unknown as number[], depthM: NaN }, NaN)))!;
    expect(d.sogKt).toBe(0);
    expect(d.rpm).toEqual([]);
    expect(d.depthM).toBeNull();
    expect(d.headingDeg).toBe(0);
  });
});

describe('V50 helm screens: throttled repaint', () => {
  it('repaints on a change, never when unchanged, and at most SCREEN_HZ times a second', () => {
    const drawn: unknown[] = [];
    const u = createScreenUpdater((d) => drawn.push(d), SCREEN_HZ);
    expect(u.update(state(readings()), 1 / 60)).toBe(true);
    expect(drawn.length).toBe(1);
    // Same readings for two seconds: nothing.
    for (let i = 0; i < 120; i++) u.update(state(readings()), 1 / 60);
    expect(u.redraws).toBe(1);
    // A change shows up (within one period).
    let got = false;
    for (let i = 0; i < 15 && !got; i++) got = u.update(state(readings({ sogKt: 30 })), 1 / 60);
    expect(got).toBe(true);
    expect(u.redraws).toBe(2);
    // Changing every frame for a second: capped at the rate.
    const before = u.redraws;
    for (let i = 0; i < 60; i++) u.update(state(readings({ sogKt: 10 + i * 0.3 })), 1 / 60);
    expect(u.redraws - before).toBeLessThanOrEqual(SCREEN_HZ + 1);
    expect(u.redraws - before).toBeGreaterThanOrEqual(SCREEN_HZ - 1);
    // Losing the instruments goes back to the static look (one repaint), then quiet.
    const n = u.redraws;
    for (let i = 0; i < 30; i++) u.update(state(null), 1 / 60);
    expect(u.redraws).toBe(n + 1);
    expect(drawn[drawn.length - 1]).toBeNull();
  });

  it('the model repaints its displays from v.instruments only when a shown value changes', () => {
    const m = createV50Model();
    const screens = m.root.getObjectByName(V50_PART.screens)!;
    const count = () => (screens.userData.redraws as number) ?? 0;
    const v = { ...state(readings()), vessel: null };
    // The first readings replace the idle look within one repaint period.
    const idle = count();
    for (let i = 0; i < 10; i++) m.setVisualState(v, 1 / 30);
    const a = count();
    expect(a).toBe(idle + 1);
    for (let i = 0; i < 30; i++) m.setVisualState(v, 1 / 30);
    expect(count()).toBe(a);
    for (let i = 0; i < 10; i++) m.setVisualState({ ...v, instruments: readings({ rpm: [2000, 2000] }) }, 1 / 30);
    expect(count()).toBe(a + 1);
    for (let i = 0; i < 10; i++) m.setVisualState({ ...v, instruments: readings({ rpm: [2000, 2000] }, 180) }, 1 / 30);
    expect(count()).toBe(a + 2);
    m.dispose();
  });
});
