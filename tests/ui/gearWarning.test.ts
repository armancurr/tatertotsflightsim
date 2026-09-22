import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CONFIG, cloneConfig } from '../../src/config';
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
