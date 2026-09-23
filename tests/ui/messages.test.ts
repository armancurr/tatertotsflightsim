import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CONFIG } from '../../src/config';
import { describeTouchdown, crashText, annunciations, keyLabel, formatFpm, startHint } from '../../src/ui/messages';
import { helpSections } from '../../src/ui/help';
import { makeReadings, makeTouchdown, arbReadings } from './fixtures';

describe('messages', () => {
  it('landing toast: rating · fpm with a real minus · centreline offset', () => {
    const m = describeTouchdown(makeTouchdown({ rating: 'smooth', verticalSpeedFpm: -180.4, centerlineOffsetM: 3.2 }));
    expect(m.text).toBe('SMOOTH · −180 fpm · 3 m right of centreline');
    expect(m.level).toBe('good');
  });

  it('landing toast: left of centreline, on centreline, off the runway', () => {
    expect(describeTouchdown(makeTouchdown({ centerlineOffsetM: -7.6 })).text).toContain('8 m left of centreline');
    expect(describeTouchdown(makeTouchdown({ centerlineOffsetM: 0.2 })).text).toContain('on the centreline');
    const grass = describeTouchdown(makeTouchdown({ onRunway: false, surface: 'grass', centerlineOffsetM: null }));
    expect(grass.text).toContain('off the runway (grass)');
  });

  it('landing levels follow the rating', () => {
    expect(describeTouchdown(makeTouchdown({ rating: 'butter' })).level).toBe('good');
    expect(describeTouchdown(makeTouchdown({ rating: 'firm' })).level).toBe('info');
    expect(describeTouchdown(makeTouchdown({ rating: 'hard' })).level).toBe('warn');
  });

  it('formatFpm uses a typographic minus and rounds', () => {
    expect(formatFpm(-179.6)).toBe('−180 fpm');
    expect(formatFpm(42.2)).toBe('+42 fpm');
    expect(formatFpm(0)).toBe('0 fpm');
    expect(formatFpm(Number.NaN)).toBe('0 fpm');
  });

  it('crash banner text', () => {
    const c = crashText({ time: 3, reason: 'Hit terrain', speedKt: 80, verticalSpeedFpm: -2000, position: { x: 0, y: 0, z: 0 } });
    expect(c.title).toBe('CRASHED — Hit terrain');
    expect(c.hint).toBe('R restart · Shift+R approach · Esc menu');
  });

  it('annunciations: stall, overspeed, flap and gear overspeed, engine', () => {
    const lim = CONFIG.aircraft;
    const ids = (r: Parameters<typeof annunciations>[0]) => annunciations(r).map((a) => a.id);
    expect(ids(makeReadings())).toEqual([]);
    expect(ids(makeReadings({ stallWarning: true }))).toContain('stall');
    expect(ids(makeReadings({ overspeed: true, airspeedKt: 170 }))).toContain('overspeed');
    expect(ids(makeReadings({ flapsDeg: 20, airspeedKt: lim.flaps.vfeKt + 5 }))).toContain('flapOverspeed');
    expect(ids(makeReadings({ flapsDeg: 20, airspeedKt: lim.flaps.vfeKt - 5 }))).not.toContain('flapOverspeed');
    expect(ids(makeReadings({ gear: 'down', airspeedKt: lim.gear.vleKt + 5 }))).toContain('gearOverspeed');
    expect(ids(makeReadings({ gear: 'up', airspeedKt: lim.gear.vleKt + 5 }))).not.toContain('gearOverspeed');
    expect(ids(makeReadings({ engineStatus: 'FAILED' }))).toContain('engineFailed');
    expect(ids(makeReadings({ engineStatus: 'OFF' }))).toContain('engineOff');
    expect(ids(makeReadings({ engineStatus: 'OFF', state: 'crashed' }))).not.toContain('engineOff');
    const stall = annunciations(makeReadings({ stallWarning: true }))[0];
    expect(stall.text).toBe('STALL');
    expect(stall.level).toBe('warning');
  });

  it('annunciations never repeat an id, for any readings', () => {
    fc.assert(
      fc.property(arbReadings, (r) => {
        const ids = annunciations(r).map((a) => a.id);
        expect(new Set(ids).size).toBe(ids.length);
      }),
      { numRuns: 200 },
    );
  });

  it('key labels are short and human', () => {
    expect(keyLabel('KeyW')).toBe('W');
    expect(keyLabel('ArrowUp')).toBe('↑');
    expect(keyLabel('ArrowLeft')).toBe('←');
    expect(keyLabel('Digit1')).toBe('1');
    expect(keyLabel('BracketLeft')).toBe('[');
    expect(keyLabel('Space')).toBe('Space');
    expect(keyLabel('Escape')).toBe('Esc');
    expect(keyLabel('PageUp')).toBe('PgUp');
    expect(keyLabel('Equal')).toBe('+');
    expect(keyLabel('Minus')).toBe('−');
    expect(keyLabel('NumpadAdd')).toBe('Num +');
    expect(keyLabel('SomethingNew')).toBe('SomethingNew');
  });

  it('the start hint names the keys from the config', () => {
    const h = startHint();
    expect(h).toContain('W');
    expect(h).toContain('H');
    expect(h).toContain('Esc menu');
    expect(h).toContain(`${CONFIG.aircraft.limits.vrKt} kt`);
  });
});

describe('help', () => {
  it('lists every action bound in config.controls.keys, with its keys', () => {
    const sections = helpSections();
    const rows = sections.flatMap((s) => s.rows);
    const covered = new Set<string>(rows.flatMap((r) => r.ids));
    for (const action of Object.keys(CONFIG.controls.keys)) expect(covered.has(action), action).toBe(true);
    const all = rows.map((r) => r.keys.join(' ')).join(' ');
    for (const codes of Object.values(CONFIG.controls.keys)) for (const code of codes) expect(all).toContain(keyLabel(code));
    expect(all).toContain('Shift+R');
  });

  it('includes the mouse controls', () => {
    const text = JSON.stringify(helpSections());
    expect(text).toMatch(/drag/i);
    expect(text).toMatch(/wheel/i);
  });
});
