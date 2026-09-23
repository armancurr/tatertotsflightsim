import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CONFIG, cloneConfig, F16_AIRCRAFT, A10_AIRCRAFT, B747_AIRCRAFT, type Config } from '../../src/config';
import { gearWarning, gearWarningFromReadings, type GearWarningInput } from '../../src/ui/gearWarning';
import { updateInstruments, createInstrumentModel } from '../../src/ui/instruments';
import { annunciations } from '../../src/ui/messages';
import { makeReadings, makeState, makeControls } from './fixtures';

const GW = CONFIG.hud.gearWarning;
const VLE = CONFIG.aircraft.gear.vleKt;

/** Cruising with the gear up: nothing to warn about. */
const base = (over: Partial<GearWarningInput> = {}): GearWarningInput => ({
  onGround: false,
  crashed: false,
  gear: 'up',
  handleDown: false,
  throttlePct: 65,
  flapsDeg: 0,
  iasKt: 110,
  ...over,
});

describe('gear warning (172RG logic)', () => {
  it('silent in cruise with the gear up and power set', () => {
    const w = gearWarning(base());
    expect(w).toMatchObject({ horn: false, gearUnsafe: false, squatSwitch: false, overspeed: false, lights: 'off' });
  });

  it('horn + red GEAR when the throttle is pulled back below the threshold with the gear up', () => {
    const w = gearWarning(base({ throttlePct: GW.throttleBelowPct - 1 }));
    expect(w.gearUnsafe).toBe(true);
    expect(w.horn).toBe(true);
    expect(gearWarning(base({ throttlePct: GW.throttleBelowPct + 1 })).horn).toBe(false);
  });

  it('horn + red GEAR with landing flaps (≥ 20°) and the gear up, even at high power', () => {
    expect(gearWarning(base({ flapsDeg: GW.flapsAtOrAboveDeg, throttlePct: 100 })).gearUnsafe).toBe(true);
    expect(gearWarning(base({ flapsDeg: 30, throttlePct: 80 })).horn).toBe(true);
    expect(gearWarning(base({ flapsDeg: 10, throttlePct: 80 })).horn).toBe(false);
  });

  it('warns while the gear is in transit (not down and locked) and cancels once it is down', () => {
    const slow = { throttlePct: 5 };
    expect(gearWarning(base({ ...slow, gear: 'transit', handleDown: true })).horn).toBe(true);
    const down = gearWarning(base({ ...slow, gear: 'down', handleDown: true }));
    expect(down.horn).toBe(false);
    expect(down.gearUnsafe).toBe(false);
    expect(down.lights).toBe('green');
  });

  it('lights: three greens down, red in transit, off when up', () => {
    expect(gearWarning(base({ gear: 'down', handleDown: true })).lights).toBe('green');
    expect(gearWarning(base({ gear: 'transit' })).lights).toBe('red');
    expect(gearWarning(base({ gear: 'up' })).lights).toBe('off');
  });

  it('on the ground with the handle UP the squat switch holds the gear down: amber caution + horn', () => {
    const w = gearWarning(base({ onGround: true, gear: 'down', handleDown: false, throttlePct: 0, iasKt: 0 }));
    expect(w.squatSwitch).toBe(true);
    expect(w.horn).toBe(true);
    expect(w.gearUnsafe).toBe(false);
    expect(w.lights).toBe('green');
    // Handle down on the ground: all quiet (idle power on the ground is normal).
    expect(gearWarning(base({ onGround: true, gear: 'down', handleDown: true, throttlePct: 0 })).horn).toBe(false);
  });

  it('gear overspeed: down above VLE, in transit above VLO; never with the gear up', () => {
    expect(gearWarning(base({ gear: 'down', handleDown: true, iasKt: VLE + 3 })).overspeed).toBe(true);
    expect(gearWarning(base({ gear: 'down', handleDown: true, iasKt: VLE - 3 })).overspeed).toBe(false);
    expect(gearWarning(base({ gear: 'transit', iasKt: GW.vloKt + 3 })).overspeed).toBe(true);
    expect(gearWarning(base({ gear: 'transit', iasKt: GW.vloKt - 3 })).overspeed).toBe(false);
    expect(gearWarning(base({ gear: 'up', iasKt: 200 })).overspeed).toBe(false);
  });

  it('a wreck is silent', () => {
    const w = gearWarning(base({ crashed: true, throttlePct: 0, onGround: true }));
    expect(w.horn || w.gearUnsafe || w.squatSwitch || w.overspeed).toBe(false);
  });

  it('thresholds come from the config', () => {
    const cfg = cloneConfig();
    cfg.hud.gearWarning.throttleBelowPct = 40;
    expect(gearWarning(base({ throttlePct: 30 }), cfg).horn).toBe(true);
    expect(gearWarning(base({ throttlePct: 30 })).horn).toBe(false);
  });

  it('from readings: uses the handle when the readings carry it, else infers it from the gear', () => {
    const r = makeReadings({ gear: 'up', throttlePct: 5, state: 'airborne' });
    expect(gearWarningFromReadings(r).gearUnsafe).toBe(true);
    const squat = { ...makeReadings({ gear: 'down', state: 'ground', throttlePct: 0, airspeedKt: 0 }), gearHandleDown: false };
    expect(gearWarningFromReadings(squat).squatSwitch).toBe(true);
    expect(gearWarningFromReadings(makeReadings({ gear: 'down', state: 'ground' })).squatSwitch).toBe(false);
  });

  it('fuzz: total — any input gives booleans and a valid light; horn ⇔ (unsafe ∨ squat); crashed ⇒ silent', () => {
    const arbNum = fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity, 0, 15, 20, 140));
    fc.assert(
      fc.property(
        fc.record({
          onGround: fc.boolean(),
          crashed: fc.boolean(),
          gear: fc.constantFrom('up', 'down', 'transit') as fc.Arbitrary<'up' | 'down' | 'transit'>,
          handleDown: fc.boolean(),
          throttlePct: arbNum,
          flapsDeg: arbNum,
          iasKt: arbNum,
        }),
        (inp) => {
          const w = gearWarning(inp);
          for (const k of ['horn', 'gearUnsafe', 'squatSwitch', 'overspeed'] as const) expect(typeof w[k]).toBe('boolean');
          expect(['green', 'red', 'off']).toContain(w.lights);
          expect(w.horn).toBe(w.gearUnsafe || w.squatSwitch);
          if (inp.crashed) expect(w.horn || w.overspeed).toBe(false);
          if (inp.gear === 'down') expect(w.gearUnsafe).toBe(false);
          if (inp.onGround) expect(w.gearUnsafe).toBe(false);
          if (!inp.onGround) expect(w.squatSwitch).toBe(false);
        },
      ),
    );
  });

  it('fuzz: monotone in the throttle — pulling power back never silences the horn', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 100, noNaN: true }), fc.double({ min: 0, max: 100, noNaN: true }), fc.double({ min: 0, max: 30, noNaN: true }), (a, b, flaps) => {
        const lo = Math.min(a, b);
        const hi = Math.max(a, b);
        if (gearWarning(base({ throttlePct: hi, flapsDeg: flaps })).horn) expect(gearWarning(base({ throttlePct: lo, flapsDeg: flaps })).horn).toBe(true);
      }),
    );
  });
});

/** The fleet's configs as the app builds them (the aircraft section swapped in). */
const withAircraft = (aircraft: Config['aircraft']): Config => ({ ...CONFIG, aircraft });

describe('gear warning — the jets and the 747 (each aircraft\'s own logic)', () => {
  const F16 = withAircraft(F16_AIRCRAFT);
  const A10 = withAircraft(A10_AIRCRAFT);
  const B747 = withAircraft(B747_AIRCRAFT);

  it('F-16: idle power in a fast descent is not a gear warning; slowing below 190 kt with the gear up is', () => {
    // ?spawn=range: 250 kt at 1,500 ft, trimmed at 11 % throttle — used to flash GEAR and sound the horn at once.
    expect(gearWarning(base({ throttlePct: 11, iasKt: 250, aglFt: 1500 }), F16).horn).toBe(false);
    expect(gearWarning(base({ throttlePct: 0, iasKt: 420, aglFt: 800 }), F16).gearUnsafe).toBe(false);
    expect(gearWarning(base({ throttlePct: 5, iasKt: 170, aglFt: 800 }), F16).horn).toBe(true);
  });

  it('A-10: no warning above its gear-operating speed (a dive at idle), a warning below it', () => {
    expect(gearWarning(base({ throttlePct: 0, iasKt: 300, aglFt: 2000 }), A10).horn).toBe(false);
    expect(gearWarning(base({ throttlePct: 0, iasKt: 180, aglFt: 2000 }), A10).horn).toBe(true);
  });

  it('747: thrust levers closed warn only low (< 800 ft); landing flaps (25/30) warn at any height', () => {
    expect(gearWarning(base({ throttlePct: 10, iasKt: 180, aglFt: 5000 }), B747).horn).toBe(false);
    expect(gearWarning(base({ throttlePct: 10, iasKt: 180, aglFt: 600 }), B747).horn).toBe(true);
    expect(gearWarning(base({ throttlePct: 60, flapsDeg: 25, iasKt: 170, aglFt: 5000 }), B747).horn).toBe(true);
  });

  it('the Cessna keeps the 172RG throttle switch: low power warns at any speed and height', () => {
    expect(gearWarning(base({ throttlePct: 10, iasKt: 135, aglFt: 5000 })).horn).toBe(true);
  });

  it('property: the speed/height gates only ever silence the LOW-POWER warning — landing flaps, the squat switch and overspeed are untouched; total on garbage', () => {
    const arbNum = fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity, 0, 15, 20, 140, 190, 800));
    fc.assert(
      fc.property(
        fc.constantFrom(CONFIG, F16, A10, B747),
        fc.record({
          onGround: fc.boolean(),
          crashed: fc.boolean(),
          gear: fc.constantFrom('up', 'down', 'transit') as fc.Arbitrary<'up' | 'down' | 'transit'>,
          handleDown: fc.boolean(),
          throttlePct: arbNum,
          flapsDeg: arbNum,
          iasKt: arbNum,
          aglFt: arbNum,
        }),
        (cfg, inp) => {
          const w = gearWarning(inp, cfg);
          const ungated = gearWarning(inp, withAircraft({ ...cfg.aircraft, gear: { ...cfg.aircraft.gear, warnBelowKt: null, warnBelowAglFt: null } }));
          expect(w.squatSwitch).toBe(ungated.squatSwitch);
          expect(w.overspeed).toBe(ungated.overspeed);
          expect(w.lights).toBe(ungated.lights);
          if (w.gearUnsafe) expect(ungated.gearUnsafe).toBe(true);
          const landingFlaps = !Number.isNaN(inp.flapsDeg) && inp.flapsDeg >= cfg.hud.gearWarning.flapsAtOrAboveDeg - 0.25;
          if (landingFlaps) expect(w.gearUnsafe).toBe(ungated.gearUnsafe);
          expect(w.horn).toBe(w.gearUnsafe || w.squatSwitch);
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe('gear warning in the instrument readings and annunciators', () => {
  it('updateInstruments: gear up at idle in flight → gearHorn and gearUnsafe', () => {
    const m = createInstrumentModel();
    const r = updateInstruments(m, makeState({ gearPos: 0, onGround: false }), makeControls({ throttle: 0.05, gearDown: false }), 0.016);
    expect(r.gearHorn).toBe(true);
    expect(r.gearUnsafe).toBe(true);
    expect(r.gearSquat).toBe(false);
  });

  it('updateInstruments: handle up on the ground → squat caution, gear still down with three greens', () => {
    const m = createInstrumentModel();
    const r = updateInstruments(m, makeState({ gearPos: 1, onGround: true, iasKt: 0 }), makeControls({ throttle: 0, gearDown: false }), 0.016);
    expect(r.gearSquat).toBe(true);
    expect(r.gearHorn).toBe(true);
    expect(r.gearLight).toBe('green');
  });

  it('annunciators: red GEAR (warning) and amber GEAR — SQUAT SWITCH (caution)', () => {
    const unsafeR = { ...makeReadings({ gear: 'up', throttlePct: 5 }), gearHandleDown: false };
    const unsafe = annunciations(unsafeR);
    const g = unsafe.find((a) => a.id === 'gearUnsafe');
    expect(g?.text).toBe('GEAR');
    expect(g?.level).toBe('warning');
    const squatR = { ...makeReadings({ gear: 'down', gearLight: 'green', state: 'ground', throttlePct: 0, airspeedKt: 0 }), gearHandleDown: false };
    const squat = annunciations(squatR);
    const s = squat.find((a) => a.id === 'gearSquat');
    expect(s?.text).toBe('GEAR — SQUAT SWITCH');
    expect(s?.level).toBe('caution');
    expect(annunciations(makeReadings()).map((a) => a.id)).toEqual([]);
  });

  it('annunciators: gear overspeed uses VLO while the gear is in transit', () => {
    const ids = annunciations(makeReadings({ gear: 'transit', airspeedKt: GW.vloKt + 5 })).map((a) => a.id);
    expect(ids).toContain('gearOverspeed');
  });
});

describe('gear speed limits are per aircraft (orchestrator: F-16 showed Cessna gear overspeeds)', () => {
  it('the F-16 cycles its gear at 250 kt without a warning; the Cessna at 150 kt gets one', async () => {
    const { getAircraftDef } = await import('../../src/fleet');
    const f16 = getAircraftDef('f16').config;
    const c172 = getAircraftDef('c172rg').config;
    const base = { onGround: false, handleDown: false, throttlePct: 80, flapsDeg: 0, crashed: false } as const;
    expect(gearWarning({ ...base, gear: 'transit', iasKt: 250 }, f16).overspeed).toBe(false);
    expect(gearWarning({ ...base, gear: 'down', handleDown: true, iasKt: 280 }, f16).overspeed).toBe(false);
    expect(gearWarning({ ...base, gear: 'transit', iasKt: 150 }, c172).overspeed).toBe(true);
    expect(gearWarning({ ...base, gear: 'transit', iasKt: 330 }, f16).overspeed).toBe(true);
  });
});
