import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { getAircraftDef } from '../../src/fleet';
import { createTrimmedState } from '../../src/physics';
import { ParticlePool } from '../../src/fx/pool';
import { RotorWashEmitter, WASH, newRotorWash, rotorWashAt, washQuality, washStyle, type WashInput, type WashSampler } from '../../src/fx/rotorWash';
import fxModule from '../../src/game/systems/fx';
import rotorWashModule from '../../src/game/systems/rotorWash';
import { fxHub } from '../../src/fx';
import type { AircraftState, SurfaceType } from '../../src/types';
import type { SystemContext, SystemFrame } from '../../src/game/systems/types';
import type { AircraftDef } from '../../src/fleet/types';

const HELI = getAircraftDef('b206');
const RC = HELI.config.aircraft.rotorcraft!;
const R = RC.rotor.radius;
const D = 2 * R;
const FT = 0.3048;

/** Flat ground at y = 0 of one surface (water: a lake surface at y = 0 over a bed at −3 m). */
function flat(surface: SurfaceType): WashSampler & { wind?: () => { x: number; y: number; z: number } } {
  const water = surface === 'water';
  return {
    groundHeight: () => (water ? -3 : 0),
    waterLevel: () => (water ? 0 : null),
    surfaceAt: () => surface,
  };
}

/** A trimmed JetRanger at `aglFt` (hub ≈ 1.5 m higher) and `kt` on flat grass. */
function heli(aglFt: number, kt = 0, headingDeg = 0): AircraftState {
  return createTrimmedState({ altitudeM: aglFt * FT, iasKt: kt, headingDeg, x: 0, z: 0, gearDown: true, flapsNotch: 0 }, { ...flat('grass'), groundNormal: () => ({ x: 0, y: 1, z: 0 }) }, HELI.config).state;
}

const inputOf = (s: AircraftState, over: Partial<WashInput> = {}): WashInput => ({
  position: s.position,
  velocity: s.velocity,
  orientation: s.orientation,
  rotor: s.rotor,
  rotorcraft: RC,
  ...over,
});

/** The hover's rotor, held fixed, at a hub height (to isolate the height fall-off). */
function atHubHeight(hubY: number, rotor = heli(15).rotor!): WashInput {
  return { position: { x: 0, y: hubY - RC.rotor.hub.y, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 }, rotor, rotorcraft: RC };
}

describe('rotorWashAt — where and how strong', () => {
  it('a JetRanger hovering at 15 ft over grass kicks up a strong wash right under the hub', () => {
    const s = heli(15);
    expect(s.rotor!.thrust).toBeGreaterThan(10000);
    const w = rotorWashAt(inputOf(s), flat('grass'));
    expect(w.strength).toBeGreaterThan(0.6);
    expect(w.strength).toBeLessThanOrEqual(WASH.maxStrength);
    expect(w.kind).toBe('grass');
    expect(w.surface).toBe('grass');
    expect(w.water).toBe(false);
    expect(w.y).toBe(0);
    expect(w.offset).toBeLessThan(1.5);
    expect(w.radius).toBe(R);
  });

  it('nothing at cruise height (hovering at 500 ft) or in cruise', () => {
    expect(rotorWashAt(inputOf(heli(500)), flat('dirt')).strength).toBe(0);
    expect(rotorWashAt(inputOf(heli(1500, 100)), flat('dirt')).strength).toBe(0);
  });

  it('nothing with the rotor stopped or making no thrust', () => {
    const s = heli(10);
    expect(rotorWashAt(inputOf(s, { rotor: { ...s.rotor!, omega: 0 } }), flat('dirt')).strength).toBe(0);
    expect(rotorWashAt(inputOf(s, { rotor: { ...s.rotor!, thrust: 0 } }), flat('dirt')).strength).toBe(0);
    expect(rotorWashAt(inputOf(s, { rotor: { ...s.rotor!, vi: 0 } }), flat('dirt')).strength).toBe(0);
  });

  it('nothing for fixed-wing aircraft (no rotor state, no rotorcraft config) or after a crash', () => {
    const cessna = getAircraftDef('c172rg');
    const s = createTrimmedState({ altitudeM: 5, iasKt: 70, headingDeg: 0, x: 0, z: 0, gearDown: true, flapsNotch: 0 }, undefined, cessna.config).state;
    expect(rotorWashAt({ ...inputOf(s), rotorcraft: cessna.config.aircraft.rotorcraft }, flat('dirt')).strength).toBe(0);
    expect(rotorWashAt({ ...inputOf(heli(10)), rotorcraft: null }, flat('dirt')).strength).toBe(0);
    expect(rotorWashAt({ ...inputOf(heli(10)), rotor: undefined }, flat('dirt')).strength).toBe(0);
    expect(rotorWashAt({ ...inputOf(heli(10)), crashed: true }, flat('dirt')).strength).toBe(0);
  });

  it('grows as the hub nears the ground, and is gone beyond ~2.3 rotor diameters', () => {
    let prev = -1;
    for (let hubY = 3 * D; hubY >= 1.5; hubY -= 0.5) {
      const w = rotorWashAt(atHubHeight(hubY), flat('dirt'));
      if (hubY > WASH.maxHeightDiameters * D) expect(w.strength).toBe(0);
      expect(w.strength).toBeGreaterThanOrEqual(prev - 1e-9);
      prev = w.strength;
    }
    expect(prev).toBeGreaterThan(0.8);
    expect(rotorWashAt(atHubHeight(1.5 * D), flat('dirt')).strength).toBeGreaterThan(0);
    expect(rotorWashAt(atHubHeight(1.5 * D), flat('dirt')).strength).toBeLessThan(rotorWashAt(atHubHeight(0.8 * D), flat('dirt')).strength);
  });

  it('is proportional to thrust × wash velocity', () => {
    const base = heli(15).rotor!;
    const w1 = rotorWashAt(atHubHeight(6, base), flat('dirt')).strength;
    const w2 = rotorWashAt(atHubHeight(6, { ...base, thrust: base.thrust * 0.5 }), flat('dirt')).strength;
    const w3 = rotorWashAt(atHubHeight(6, { ...base, vi: base.vi * 0.5 }), flat('dirt')).strength;
    expect(w2 / w1).toBeCloseTo(0.5, 1);
    expect(w3).toBeLessThan(w1);
  });

  it('forward speed displaces the impact point behind the aircraft (wake skew) and weakens the wash', () => {
    const hover = rotorWashAt(inputOf(heli(20)), flat('dirt'));
    const slow = heli(20, 20); // heading north (−Z)
    const moving = rotorWashAt(inputOf(slow), flat('dirt'));
    expect(slow.velocity.z).toBeLessThan(-5);
    expect(moving.offset).toBeGreaterThan(hover.offset + 2);
    expect(moving.z).toBeGreaterThan(slow.position.z + 2); // behind (south of) a northbound helicopter
    expect(moving.strength).toBeLessThan(hover.strength);
    // Same rotor, more speed → further back.
    const fast = rotorWashAt(inputOf(slow, { velocity: { x: 0, y: 0, z: -15 } }), flat('dirt'));
    expect(fast.z).toBeGreaterThan(moving.z);
  });

  it('the wind carries the wash downwind', () => {
    const s = heli(20);
    const calm = rotorWashAt(inputOf(s), flat('dirt'));
    const windy = rotorWashAt(inputOf(s, { wind: { x: 6, y: 0, z: 0 } }), flat('dirt'));
    expect(windy.x).toBeGreaterThan(calm.x + 1);
  });

  it('finds water over a lake (the water surface, not the bed)', () => {
    const w = rotorWashAt(inputOf(heli(15)), flat('water'));
    expect(w.water).toBe(true);
    expect(w.surface).toBe('water');
    expect(w.kind).toBe('spray');
    expect(w.y).toBe(0);
  });

  it('fuzz: any input gives a finite strength in range and never throws', () => {
    const num = fc.oneof(fc.double({ min: -1e6, max: 1e6, noNaN: true }), fc.constantFrom(NaN, Infinity, -Infinity, 0, 1e-12));
    const v3 = fc.record({ x: num, y: num, z: num });
    fc.assert(
      fc.property(v3, v3, fc.record({ x: num, y: num, z: num, w: num }), num, num, num, fc.boolean(), v3, fc.constantFrom<SurfaceType>('grass', 'dirt', 'water', 'runway', 'snow', 'sand'), num, (position, velocity, orientation, thrust, vi, omega, withWind, wind, surface, ground) => {
        const env: WashSampler = { groundHeight: () => ground, waterLevel: () => (surface === 'water' ? ground : null), surfaceAt: () => surface };
        const w = rotorWashAt({ position, velocity, orientation, rotor: { thrust, vi, omega }, rotorcraft: RC, wind: withWind ? wind : null }, env);
        expect(Number.isFinite(w.strength)).toBe(true);
        expect(w.strength).toBeGreaterThanOrEqual(0);
        expect(w.strength).toBeLessThanOrEqual(WASH.maxStrength);
        if (w.strength > 0) {
          expect(Number.isFinite(w.x + w.y + w.z + w.offset + w.heightRatio + w.driftX + w.driftZ + w.wakeSpeed)).toBe(true);
          const pool = new ParticlePool(1200);
          new RotorWashEmitter(3).update(pool, w, 0.1, 1);
          for (let i = 0; i < pool.capacity; i++) if (pool.alive[i]) expect(Number.isFinite(pool.px[i] + pool.py[i] + pool.pz[i] + pool.vx[i] + pool.vy[i] + pool.vz[i])).toBe(true);
        }
      }),
      { numRuns: 400 },
    );
  });

  it('a sampler that throws gives no wash instead of an exception', () => {
    const bad: WashSampler = { groundHeight: () => { throw new Error('x'); }, waterLevel: () => null, surfaceAt: () => 'grass' };
    expect(rotorWashAt(inputOf(heli(10)), bad).strength).toBe(0);
  });
});

describe('washStyle — what each surface throws up', () => {
  it('maps surfaces to particle types', () => {
    expect(washStyle('dirt').kind).toBe('dust');
    expect(washStyle('sand').kind).toBe('dust');
    expect(washStyle('field').kind).toBe('dust');
    expect(washStyle('grass').kind).toBe('grass');
    expect(washStyle('forest').kind).toBe('grass');
    expect(washStyle('runway').kind).toBe('haze');
    expect(washStyle('asphalt').kind).toBe('haze');
    expect(washStyle('urban').kind).toBe('haze');
    expect(washStyle('rock').kind).toBe('haze');
    expect(washStyle('snow').kind).toBe('snow');
    expect(washStyle('water').kind).toBe('spray');
    expect(washStyle('lava' as SurfaceType).kind).toBe('none');
    expect(washStyle(null).kind).toBe('none');
  });

  it('dust is tan/brown, grass throws green flecks, snow is white, only water gets the ring', () => {
    const [r, g, b] = washStyle('dirt').puffColor;
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
    const [fr, fg, fb] = washStyle('grass').fleckColor;
    expect(fg).toBeGreaterThan(fr);
    expect(fg).toBeGreaterThan(fb);
    expect(washStyle('grass').fleckRate).toBeGreaterThan(0);
    expect(Math.min(...washStyle('snow').puffColor)).toBeGreaterThan(0.85);
    expect(washStyle('water').ring).toBe(true);
    expect(washStyle('water').fleckRate).toBeGreaterThan(0); // droplets
    for (const s of ['dirt', 'grass', 'runway', 'snow', 'sand'] as SurfaceType[]) expect(washStyle(s).ring).toBe(false);
  });

  it('pavement is almost nothing next to dirt', () => {
    const load = (s: SurfaceType) => washStyle(s).puffRate * washStyle(s).puffAlpha;
    expect(load('runway')).toBeLessThan(0.05 * load('dirt'));
    expect(load('grass')).toBeLessThan(load('dirt'));
  });
});

describe('RotorWashEmitter', () => {
  const hover = () => rotorWashAt(inputOf(heli(12)), flat('dirt'));

  it('emits a ring of dust that spreads outward along the ground to ~2–3 rotor radii', () => {
    const pool = new ParticlePool(1800);
    const em = new RotorWashEmitter(7);
    const w = hover();
    for (let k = 0; k < 60; k++) {
      em.update(pool, w, 1 / 60, 1);
      pool.step(1 / 60, 0, 0, 0);
    }
    expect(pool.count).toBeGreaterThan(30);
    let rMin = Infinity, rMax = 0, rSum = 0, n = 0, yMax = -Infinity;
    for (let i = 0; i < pool.capacity; i++) {
      if (!pool.alive[i]) continue;
      const r = Math.hypot(pool.px[i] - w.x, pool.pz[i] - w.z);
      rMin = Math.min(rMin, r); rMax = Math.max(rMax, r); rSum += r; n++;
      yMax = Math.max(yMax, pool.py[i]);
      expect(pool.py[i]).toBeGreaterThanOrEqual(w.y - 1e-6);
    }
    expect(rMin).toBeGreaterThan(0.4 * R);
    expect(rSum / n).toBeGreaterThan(1.2 * R);
    expect(rMax).toBeGreaterThan(2 * R);
    expect(rMax).toBeLessThan(4 * R);
    expect(yMax).toBeLessThan(w.y + 4); // lifts a little, not a column
  });

  it('emits nothing with no wash, fewer on low quality, and leaves the crash reserve free', () => {
    const pool = new ParticlePool(1800);
    const em = new RotorWashEmitter(1);
    expect(em.update(pool, newRotorWash(), 1 / 60, 1)).toBe(0);
    const count = (q: number) => {
      const p = new ParticlePool(1800);
      const e = new RotorWashEmitter(2);
      let n = 0;
      for (let k = 0; k < 120; k++) n += e.update(p, hover(), 1 / 60, q);
      return n;
    };
    expect(count(washQuality('low'))).toBeLessThan(0.6 * count(washQuality('high')));
    expect(washQuality('medium')).toBeLessThan(1);
    expect(washQuality('auto')).toBe(1);
    const full = new ParticlePool(WASH.reserve + 10);
    const e2 = new RotorWashEmitter(3);
    for (let k = 0; k < 200; k++) e2.update(full, hover(), 1 / 30, 1);
    expect(full.count).toBeLessThanOrEqual(10);
  });

  it('water throws mist and droplets (falling back), snow throws white powder', () => {
    const w = rotorWashAt(inputOf(heli(12)), flat('water'));
    const pool = new ParticlePool(1800);
    const em = new RotorWashEmitter(5);
    for (let k = 0; k < 30; k++) em.update(pool, w, 1 / 60, 1);
    let falling = 0;
    for (let i = 0; i < pool.capacity; i++) if (pool.alive[i] && pool.gravity[i] > 5) falling++;
    expect(falling).toBeGreaterThan(0);
    const ws = rotorWashAt(inputOf(heli(12)), flat('snow'));
    const ps = new ParticlePool(1800);
    for (let k = 0; k < 30; k++) em.update(ps, ws, 1 / 60, 1);
    for (let i = 0; i < ps.capacity; i++) if (ps.alive[i]) expect(ps.b[i]).toBeGreaterThan(0.75);
  });
});

describe('rotorWash system', () => {
  function setup(surface: SurfaceType, start: AircraftDef = HELI) {
    let def = start;
    const env = { ...flat(surface), groundNormal: () => ({ x: 0, y: 1, z: 0 }), obstacleTop: () => -Infinity, registerObstacleSource: () => {} };
    const ctx = { scene: new THREE.Scene(), env, actions: { currentAircraft: () => def } } as unknown as SystemContext;
    return { ctx, setDef: (d: AircraftDef) => (def = d) };
  }
  const frame = (state: AircraftState, def: AircraftDef, dt = 1 / 60): SystemFrame => ({ state, def, dt, paused: false, time: state.time } as unknown as SystemFrame);

  it('drives the shared effects pool under a hovering helicopter (no extra particle draw call), and cleans up', async () => {
    const { ctx } = setup('dirt');
    const fx = await fxModule.create(ctx);
    const sys = await rotorWashModule.create(ctx);
    const pool = fxHub(ctx.scene).effects!.sim.smoke;
    const s = heli(12);
    for (let k = 0; k < 30; k++) sys.update!(frame(s, HELI));
    expect(pool.count).toBeGreaterThan(10);
    const st = sys.stats!();
    expect(st.kind).toBe('dust');
    expect(Number(st.strength)).toBeGreaterThan(0.5);
    expect(ctx.scene.getObjectByName('fx-rotor-wash-ring')!.visible).toBe(false); // not over water
    sys.onReset?.('teleport');
    expect(sys.stats!().strength).toBe(0);
    sys.dispose?.();
    expect(ctx.scene.getObjectByName('rotor-wash')).toBeUndefined();
    fx.dispose?.();
  });

  it('shows the ripple ring over water; switching to a fixed-wing aircraft clears it and does nothing', async () => {
    const { ctx, setDef } = setup('water');
    const fx = await fxModule.create(ctx);
    const sys = await rotorWashModule.create(ctx);
    const s = heli(12);
    for (let k = 0; k < 60; k++) sys.update!(frame(s, HELI));
    const ring = ctx.scene.getObjectByName('fx-rotor-wash-ring')!;
    expect(ring.visible).toBe(true);
    expect(Number(sys.stats!().ring)).toBeGreaterThan(0.3);
    const cessna = getAircraftDef('c172rg');
    setDef(cessna);
    sys.onAircraftChange?.(cessna, {} as never);
    expect(ring.visible).toBe(false);
    fxHub(ctx.scene).effects!.reset();
    const pool = fxHub(ctx.scene).effects!.sim.smoke;
    const plane = createTrimmedState({ altitudeM: 3, iasKt: 70, headingDeg: 0, x: 0, z: 0, gearDown: true, flapsNotch: 0 }, undefined, cessna.config).state;
    for (let k = 0; k < 30; k++) sys.update!(frame(plane, cessna));
    expect(pool.count).toBe(0);
    expect(ring.visible).toBe(false);
    sys.dispose?.();
    fx.dispose?.();
  });

  it('survives without the fx system (?no=fx) and with a bare frame', async () => {
    const { ctx } = setup('grass');
    const sys = await rotorWashModule.create(ctx);
    expect(() => sys.update!(frame(heli(12), HELI))).not.toThrow();
    expect(() => sys.update!({ state: heli(12) } as unknown as SystemFrame)).not.toThrow();
    sys.dispose?.();
    sys.dispose?.();
  });
});
