// @vitest-environment happy-dom
/**
 * The marine helm HUD for a waterjet (the Sea-Doo RXP-X 325): one ENGINE tach reading to 9,500 rpm
 * with the red arc from the 8,000 rpm limiter, THROTTLE instead of LEVER, the NOZZLE fan instead of
 * DRIVES and the iBR bucket (UP / NEUTRAL / DOWN) instead of the trim tabs — the V50's labels unchanged.
 */
import { describe, it, expect } from 'vitest';
import { CONFIG, SEADOO_AIRCRAFT, type Config } from '../../src/config';
import type { InstrumentReadings, MarineGear } from '../../src/types';
import { drawMarineEngines, ibrText, tachRange } from '../../src/ui/marineHud';
import { makeReadings, mockCtx } from './fixtures';

const SD: Config = { ...CONFIG, aircraft: SEADOO_AIRCRAFT };

function skiReadings(gear: MarineGear, leverPct: number, rpm = 6400): InstrumentReadings {
  return {
    ...makeReadings(),
    engineStatus: 'RUNNING',
    vessel: {
      speedKt: 52, sogKt: 52, rpm: [rpm], loadPct: [96], leverPct, gear, steerDeg: 12, tabsPct: 0, trimDeg: 1, heelDeg: 14,
      depthM: null, planingPct: 90, moored: false, aground: false,
    },
  };
}

describe('marine HUD: waterjet (Sea-Doo)', () => {
  it('the tach reads to 9,500 with the red arc from the 8,000 rpm limiter', () => {
    expect(tachRange(SD.aircraft.watercraft!.engine.maxRpm)).toEqual({ max: 9500, redline: 8000 });
  });

  it('the iBR bucket reads UP / NEUTRAL / DOWN from the gear it selects', () => {
    expect(ibrText('ahead')).toBe('UP');
    expect(ibrText('neutral')).toBe('NEUTRAL');
    expect(ibrText('astern')).toBe('DOWN');
  });

  it('engines block: ENGINE tach, THROTTLE, NOZZLE and the iBR row — no DRIVES / TABS', () => {
    for (const [gear, lever, word] of [['ahead', 80, 'UP'], ['neutral', 0, 'NEUTRAL'], ['astern', -60, 'DOWN']] as const) {
      const m = mockCtx(560, 200);
      drawMarineEngines(m.ctx, 560, 200, skiReadings(gear, lever), 8000, 0.06, true);
      const t = m.texts();
      for (const s of ['ENGINE', 'THROTTLE', 'NOZZLE', 'iBR', word, '12° S', '6400']) expect(t, s).toContain(s);
      for (const s of ['DRIVES', 'TABS', 'LEVER', 'PORT']) expect(t, s).not.toContain(s);
      expect(m.bad()).toEqual([]);
    }
  });

  it('a propeller boat keeps its DRIVES / TABS labels', () => {
    const m = mockCtx(560, 200);
    drawMarineEngines(m.ctx, 560, 200, skiReadings('ahead', 50), 3500, 0.08);
    expect(m.texts()).toContain('DRIVES');
    expect(m.texts()).toContain('TABS');
  });
});

describe('helm readings and hint: waterjet (Sea-Doo)', () => {
  it('the tach reading goes past 5,000 rpm (to the 8,000 limiter)', async () => {
    const { createVesselState } = await import('../../src/physics');
    const { createInstrumentModel, vesselReadings } = await import('../../src/ui/instruments');
    const env = { groundHeight: () => -40, surfaceAt: () => 'water' as const, waterLevel: () => 0 };
    const s = createVesselState(env, SD, { x: 0, z: 0, headingDeg: 0 }).state;
    const v = { ...s.vessel!, propulsors: s.vessel!.propulsors.map((p) => ({ ...p, rpm: 7800 })) };
    const { defaultControls } = await import('../../src/physics');
    const r = vesselReadings(createInstrumentModel(), { ...s, vessel: v }, { ...defaultControls(), throttle: 1 }, SD);
    expect(r.rpm[0]).toBeCloseTo(7800, 0);
  });

  it('the start hint names the throttle, the iBR and the lean', async () => {
    const { startHint } = await import('../../src/ui/messages');
    const h = startHint(SD);
    expect(h).toMatch(/throttle/);
    expect(h).toMatch(/iBR/);
    expect(h).toMatch(/lean/);
    expect(startHint({ ...CONFIG, aircraft: (await import('../../src/config')).V50_AIRCRAFT })).toMatch(/trim tabs/);
  });
});
