// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { createGTrack, stepGTrack, resetGTrack, gMeterModel, G_DIAL } from '../../src/ui/gMeter';
import gmeterModule from '../../src/game/systems/gmeter';
import { getAircraftDef } from '../../src/fleet';
import { uiBusFor } from '../../src/ui/uiBus';
import type { SystemContext, SystemFrame } from '../../src/game/systems/types';

const limits = (id: string) => getAircraftDef(id).config.aircraft.limits;

describe('G meter: tracking', () => {
  it('eases toward the load factor and remembers the max and min until reset', () => {
    const t = createGTrack();
    for (let i = 0; i < 60; i++) stepGTrack(t, 6.5, 1 / 60);
    expect(t.g).toBeCloseTo(6.5, 1);
    for (let i = 0; i < 60; i++) stepGTrack(t, -1.2, 1 / 60);
    expect(t.max).toBeCloseTo(6.5, 1);
    expect(t.min).toBeCloseTo(-1.2, 1);
    resetGTrack(t);
    expect(t).toMatchObject({ g: 1, max: 1, min: 1 });
  });

  it('a one-frame spike does not jump the needle all the way (it is smoothed)', () => {
    const t = createGTrack();
    stepGTrack(t, 12, 1 / 60);
    expect(t.g).toBeLessThan(6);
  });
});

describe('G meter: dial model per aircraft', () => {
  it('maps +1 g and the limits onto the dial and marks each aircraft its own limits', () => {
    const f16 = gMeterModel({ g: 1, max: 1, min: 1 }, limits('f16'));
    const c172 = gMeterModel({ g: 1, max: 1, min: 1 }, limits('c172rg'));
    expect(f16.limitPos).toBe(9);
    expect(c172.limitPos).toBeCloseTo(limits('c172rg').gLimitPos, 6);
    expect(f16.angle).toBeCloseTo(c172.angle, 9); // same dial
    // The needle turns clockwise with more g.
    expect(gMeterModel({ g: 5, max: 5, min: 1 }, limits('f16')).angle).toBeGreaterThan(f16.angle);
  });

  it('colour: normal → caution near the limit → over the limit', () => {
    const L = limits('c172rg');
    expect(gMeterModel({ g: 1, max: 1, min: 1 }, L).zone).toBe('normal');
    expect(gMeterModel({ g: L.gLimitPos * 0.9, max: 3, min: 1 }, L).zone).toBe('caution');
    expect(gMeterModel({ g: L.gLimitPos + 0.3, max: 5, min: 1 }, L).zone).toBe('over');
    expect(gMeterModel({ g: L.gLimitNeg - 0.3, max: 1, min: -2 }, L).zone).toBe('over');
    // 7 g is fine in an F-16 but over the Cessna's limit.
    expect(gMeterModel({ g: 7, max: 7, min: 1 }, limits('f16')).zone).not.toBe('over');
    expect(gMeterModel({ g: 7, max: 7, min: 1 }, L).zone).toBe('over');
  });

  it('text reads like a real g meter', () => {
    expect(gMeterModel({ g: 3.44, max: 5.06, min: -0.52 }, limits('f16'))).toMatchObject({ text: '+3.4', maxText: '+5.1', minText: '−0.5' });
  });

  it('fuzz: any input stays on the dial with finite numbers and max ≥ g ≥ min', () => {
    fc.assert(
      fc.property(fc.array(fc.double({ noNaN: false }), { minLength: 1, maxLength: 50 }), fc.double({ min: 0, max: 0.2, noNaN: true }), (gs, dt) => {
        const t = createGTrack();
        for (const g of gs) {
          stepGTrack(t, g, dt);
          expect(t.max).toBeGreaterThanOrEqual(t.g - 1e-9);
          expect(t.min).toBeLessThanOrEqual(t.g + 1e-9);
          const m = gMeterModel(t, limits('a10'));
          expect(Number.isFinite(m.angle)).toBe(true);
          expect(m.angle).toBeGreaterThanOrEqual(G_DIAL.startDeg - 1e-9);
          expect(m.angle).toBeLessThanOrEqual(G_DIAL.startDeg + G_DIAL.sweepDeg + 1e-9);
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('G meter: on screen', () => {
  function setup(id = 'f16') {
    document.body.innerHTML = '';
    const hudRoot = document.createElement('div');
    document.body.appendChild(hudRoot);
    const def = getAircraftDef(id);
    const ctx = { hudRoot, actions: { currentAircraft: () => def }, scene: new THREE.Scene() } as unknown as SystemContext;
    return { hudRoot, def, ctx };
  }
  const frame = (def: ReturnType<typeof getAircraftDef>, g: number) =>
    ({ readings: { gLoad: g }, state: { derived: { loadFactor: g } }, dt: 1 / 60, paused: false, def }) as unknown as SystemFrame;

  it('puts a G meter on the HUD for every aircraft, follows the HUD toggle, and clears max/min on reset', async () => {
    for (const id of ['c172rg', 'f16', 'a10']) {
      const { hudRoot, def, ctx } = setup(id);
      const sys = await gmeterModule.create(ctx);
      const el = hudRoot.querySelector('.tfs-gmeter') as HTMLElement;
      expect(el).toBeTruthy();
      for (let i = 0; i < 90; i++) sys.update!(frame(def, 4));
      expect(el.getAttribute('aria-label')).toMatch(/G meter: \+4\.0 g/);
      expect((sys.stats!() as { max: number }).max).toBeCloseTo(4, 1);
      uiBusFor(hudRoot.ownerDocument).emit('hudVisible', false);
      expect(el.style.display).toBe('none');
      uiBusFor(hudRoot.ownerDocument).emit('hudVisible', true);
      expect(el.style.display).not.toBe('none');
      sys.onReset!('runway');
      expect((sys.stats!() as { max: number }).max).toBe(1);
      sys.dispose!();
      expect(hudRoot.querySelector('.tfs-gmeter')).toBeNull();
    }
  });
});
