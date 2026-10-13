/**
 * The marine HUD on a ship with tunnel thrusters (MS Tater Star): the helm readings show one tach
 * per shaft (the thrusters are not engines) and the bow / stern thruster groups' thrust; the engines
 * block draws a THRUSTERS indicator (BOW / STN bars) in place of the trim tabs; a vessel without
 * thrusters (the V50) reads exactly as before.
 */
import { describe, it, expect } from 'vitest';
import { CONFIG, CRUISE_AIRCRAFT, V50_AIRCRAFT, type Config } from '../../src/config';
import type { AircraftState, InstrumentReadings, PropulsorState, VesselState } from '../../src/types';
import { createInstrumentModel, updateInstruments } from '../../src/ui/instruments';
import { drawMarineEngines } from '../../src/ui/marineHud';
import { makeControls, makeReadings, makeState, mockCtx } from './fixtures';

const CRUISE: Config = { ...CONFIG, aircraft: CRUISE_AIRCRAFT };
const V50: Config = { ...CONFIG, aircraft: V50_AIRCRAFT };
const WC = CRUISE_AIRCRAFT.watercraft!;

const prop = (over: Partial<PropulsorState> = {}): PropulsorState => ({ rpm: 0, n: 0, gear: 'neutral', thrust: 0, steerDeg: 0, load: 0, boost: 0, ...over });
function ship(props: PropulsorState[]): AircraftState {
  const s = makeState({ iasKt: 1, groundSpeedKt: 1, headingDeg: 90, altFt: 1, aglFt: 1, onGround: false });
  const vessel: VesselState = {
    seaTime: 0, propulsors: props, tabs: 0, mooring: null, speedMs: 0.5, leewayDeg: 0, trimDeg: 0, planing: 0, wettedLength: 230, wettedArea: 9000,
    displacedVolume: 39000, resistance: 0, depthUnderKeel: 30, aground: false, touching: false, capsizeTime: 0, surfaceY: 0,
  };
  return { ...s, phase: 'afloat', stalled: false, vessel };
}

describe('marine HUD: tunnel thrusters', () => {
  it('reads the shafts as the engines and the bow / stern thruster groups as fractions of full thrust', () => {
    const props = WC.propulsors.map((p) =>
      p.type === 'shaft' ? prop({ rpm: p.position.x < 0 ? 410 : 420, load: 0.5, gear: 'ahead', steerDeg: 12 }) : prop({ thrust: (p.position.z < 0 ? 1 : -0.5) * p.thruster!.maxThrustN }),
    );
    const r = updateInstruments(createInstrumentModel(), ship(props), makeControls({ throttle: 0.4, aileron: 1 }), 0.016, CRUISE);
    const v = r.vessel!;
    expect(v.rpm).toEqual([410, 420]);
    expect(v.loadPct.length).toBe(2);
    expect(v.gear).toBe('ahead');
    expect(v.steerDeg).toBe(12);
    expect(v.thrusters!.bow).toBeCloseTo(1, 9);
    expect(v.thrusters!.stern).toBeCloseTo(-0.5, 9);
  });

  it('a vessel without thrusters has no thruster block', () => {
    const r = updateInstruments(createInstrumentModel(), ship([prop({ rpm: 2000 }), prop({ rpm: 2100 })]), makeControls({ throttle: 0.4 }), 0.016, V50);
    expect(r.vessel!.thrusters).toBeUndefined();
    expect(r.vessel!.rpm).toEqual([2000, 2100]);
  });

  it('draws THRUSTERS (BOW / STN) in place of the tabs, never a NaN, whatever the numbers', () => {
    for (const t of [{ bow: 1, stern: -1 }, { bow: 0, stern: 0 }, { bow: NaN, stern: Infinity }]) {
      const readings: InstrumentReadings = {
        ...makeReadings({ airspeedKt: 1, state: 'afloat', gear: 'down', gearLight: 'off' }),
        vessel: { speedKt: 1, sogKt: 1, rpm: [410, 420], loadPct: [50, 50], leverPct: 40, gear: 'ahead', steerDeg: 3, tabsPct: 0, trimDeg: 0, heelDeg: 0, depthM: 30, planingPct: 0, moored: false, aground: false, thrusters: t },
      };
      const m = mockCtx(560, 200);
      drawMarineEngines(m.ctx, 560, 200, readings, 600, 0.08);
      const texts = m.texts();
      for (const s of ['THRUSTERS', 'BOW', 'STN', 'PORT', 'STBD']) expect(texts, s).toContain(s);
      expect(texts).not.toContain('TABS');
      expect(m.bad()).toEqual([]);
    }
  });
});
