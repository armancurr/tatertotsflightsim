// @vitest-environment happy-dom
/**
 * The Controls page (menu + H help overlay): every binding in config.controls.keys, grouped
 * flight / engine & systems / cameras / sim, with the jet notes.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { CONFIG, cloneConfig } from '../../src/config';
import { controlGroups, buildControlsSheet, controlNotes } from '../../src/ui/controls';
import { keyLabel } from '../../src/ui/messages';

describe('control groups', () => {
  it('five groups in order: Flight, Engine & systems, Weapons, Cameras, Sim', () => {
    expect(controlGroups().map((g) => [g.id, g.title])).toEqual([
      ['flight', 'Flight'],
      ['engine', 'Engine & systems'],
      ['weapons', 'Weapons'],
      ['cameras', 'Cameras'],
      ['sim', 'Sim'],
    ]);
  });

  it('Weapons: fire the gun (Q / Enter, hold), lock / next target (T), launch a Maverick (Z), with the A-10 note', () => {
    const w = controlGroups().find((g) => g.id === 'weapons')!;
    const row = (id: string) => w.rows.find((r) => r.ids.includes(id as never))!;
    expect(row('fireGun').keys).toEqual(['Q', 'Enter']);
    expect(row('fireGun').action).toMatch(/gun.*hold/i);
    expect(row('lockTarget').keys).toEqual(['T']);
    expect(row('lockTarget').action).toMatch(/lock/i);
    expect(row('fireMissile').keys).toEqual(['Z']);
    expect(row('fireMissile').action).toMatch(/maverick/i);
    expect(JSON.stringify(w)).toMatch(/A-10/);
    // Nothing weapons-related is left over in Sim.
    const sim = controlGroups().find((g) => g.id === 'sim')!;
    expect(sim.rows.some((r) => r.ids.some((id) => ['fireGun', 'fireMissile', 'lockTarget'].includes(id)))).toBe(false);
    expect(controlNotes().join(' ')).toMatch(/A-10.*T.*Z/);
  });

  it('covers EVERY binding in config.controls.keys, with every key cap', () => {
    const rows = controlGroups().flatMap((g) => g.rows);
    const ids = new Set(rows.flatMap((r) => r.ids));
    for (const action of Object.keys(CONFIG.controls.keys)) expect(ids.has(action as never), action).toBe(true);
    const caps = rows.flatMap((r) => r.keys).join(' ');
    for (const codes of Object.values(CONFIG.controls.keys)) for (const code of codes) expect(caps).toContain(keyLabel(code));
  });

  it('has the speed brake (X), the reset variants, the mouse, and the F-16 afterburner note', () => {
    const all = controlGroups();
    const find = (id: string) => all.flatMap((g) => g.rows.map((r) => ({ g: g.id, r }))).find((x) => x.r.ids.includes(id as never))!;
    expect(find('speedBrake').g).toBe('engine');
    expect(find('speedBrake').r.keys).toContain('X');
    expect(find('speedBrake').r.action.toLowerCase()).toContain('speed brake');
    expect(find('throttleUp').r.note ?? '').toMatch(/afterburner.*90/i);
    expect(find('pitchUp').g).toBe('flight');
    expect(find('cameraCockpit').g).toBe('cameras');
    expect(find('reset').g).toBe('sim');
    expect(find('reset').r.keys).toContain('Shift+R');
    expect(find('pause').r.keys).toContain('Esc');
    const cams = JSON.stringify(all.find((g) => g.id === 'cameras'));
    expect(cams).toMatch(/drag/i);
    expect(cams).toMatch(/wheel/i);
    expect(controlNotes().join(' ')).toMatch(/afterburner/i);
  });

  it('property: any extra binding added to the config shows up somewhere (the sheet never goes stale)', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z][a-zA-Z]{2,12}$/), fc.constantFrom('KeyQ', 'KeyZ', 'Digit9', 'F5'), (name, code) => {
        const cfg = cloneConfig();
        if (name in cfg.controls.keys) return;
        (cfg.controls.keys as Record<string, string[]>)[name] = [code];
        const rows = controlGroups(cfg).flatMap((g) => g.rows);
        expect(rows.some((r) => (r.ids as string[]).includes(name))).toBe(true);
        expect(rows.flatMap((r) => r.keys)).toContain(keyLabel(code));
      }),
      { numRuns: 60 },
    );
  });
});

describe('controls sheet (DOM)', () => {
  it('renders one section per group with kbd key caps and the notes', () => {
    const el = buildControlsSheet(document);
    const heads = [...el.querySelectorAll('h3')].map((h) => h.textContent);
    expect(heads).toEqual(['Flight', 'Engine & systems', 'Weapons', 'Cameras', 'Sim']);
    expect(el.querySelectorAll('kbd').length).toBeGreaterThan(30);
    expect(el.textContent).toContain('Speed brake');
    expect(el.textContent).toMatch(/afterburner/i);
  });
});
