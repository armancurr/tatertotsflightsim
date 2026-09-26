import { describe, it, expect } from 'vitest';
import { HullTrack, hullSize, sprayRates, bowSprayOrigin } from '../../../src/world/traffic/hullTrack';
import { wakeAges, writeWake, WAKE_VERTS_PER_SAMPLE, type WakeSample } from '../../../src/world/traffic/wake';
import { CONFIG, V50_AIRCRAFT } from '../../../src/config';
import { watercraftOf } from '../../../src/game/systems/playerWake';
import type { AircraftDef } from '../../../src/fleet/types';

const newSample = (): WakeSample => ({ x: 0, z: 0, course: 0, speed: 0, travelled: 0, age: 0 });

describe('player wake: hull track', () => {
  it('hull size from the V50 station table: 14.2 m stem to transom, 4.11 m beam', () => {
    const s = hullSize(V50_AIRCRAFT.watercraft!.hull.stations);
    expect(s.length).toBeCloseTo(14.2, 5);
    expect(s.beam).toBeCloseTo(4.11, 5);
    expect(s.midZ).toBeCloseTo(-1.6, 5);
    const o = bowSprayOrigin(s, 0, 1, { x: 0, y: 0, z: 0 });
    const p = bowSprayOrigin(s, 1, 1, { x: 0, y: 0, z: 0 });
    expect(o.z).toBeGreaterThan(s.stemZ);
    expect(p.z).toBeGreaterThan(o.z); // the spray root moves aft on the plane
    expect(o.x).toBeGreaterThan(0);
  });

  it('records a straight run and interpolates poses back in time', () => {
    const tr = new HullTrack(100, 0.1);
    // 10 m/s due east from (0, 0), sampled at 60 Hz
    for (let i = 0; i <= 1200; i++) tr.push(i / 60, (i / 60) * 10, 0, 90, 10);
    expect(tr.length).toBe(100);
    expect(tr.span).toBeCloseTo(9.9, 1); // 100 entries × 0.1 s
    const out = newSample();
    tr.sample(20, 2, out);
    expect(out.x).toBeCloseTo(180, 0);
    expect(out.z).toBeCloseTo(0, 6);
    expect(out.course).toBeCloseTo(90, 6);
    expect(out.speed).toBeCloseTo(10, 6);
    expect(tr.travelled - out.travelled).toBeCloseTo(20, 0);
    // beyond the history: the oldest pose, with the speed faded out
    tr.sample(20, 60, out);
    expect(out.speed).toBe(0);
  });

  it('interpolates headings across north, clears on a reset / time step back / teleport', () => {
    const tr = new HullTrack(50, 0.1);
    tr.push(0, 0, 0, 350, 5);
    tr.push(0.2, 0, -1, 10, 5);
    const out = newSample();
    tr.sample(0.2, 0.1, out);
    expect(Math.min(out.course, 360 - out.course)).toBeLessThan(0.5);
    tr.push(0.1, 0, 0, 0, 0); // time went back (a reset)
    expect(tr.length).toBe(1);
    expect(tr.travelled).toBe(0);
    tr.push(0.3, 500, 0, 0, 0); // teleport
    expect(tr.length).toBe(1);
    tr.reset();
    expect(tr.length).toBe(0);
    expect(tr.sample(1, 0.5, out).speed).toBe(0);
  });

  it('feeds the traffic wake writer: a trail behind the hull, fading with age, none at rest', () => {
    const N = 24;
    const ages = new Float32Array(N);
    wakeAges(N, 55, ages);
    const tr = new HullTrack(600, 0.1);
    for (let i = 0; i <= 60 * 30; i++) tr.push(i / 60, 0, -(i / 60) * 12, 0, 12); // north at 12 m/s
    const samples = Array.from({ length: N }, newSample);
    for (let j = 0; j < N; j++) tr.sample(30, ages[j], samples[j]);
    const buf = { position: new Float32Array(N * WAKE_VERTS_PER_SAMPLE * 3), data: new Float32Array(N * WAKE_VERTS_PER_SAMPLE * 4), type: new Float32Array(N * WAKE_VERTS_PER_SAMPLE) };
    writeWake(buf, 0, samples, N, { length: 14.2, beam: 4.11, maxAge: 55, fullSpeed: 10, kelvin: 0.55, foam: 1, level: 0 });
    // foam vertices trail south (+z) of the hull, strength decreasing
    const zNow = -30 * 12;
    expect(buf.position[2]).toBeGreaterThan(zNow);
    expect(buf.position[(2 * (N - 2)) * 3 + 2]).toBeGreaterThan(buf.position[2] + 200);
    expect(buf.data[3]).toBeGreaterThan(buf.data[(2 * (N - 2)) * 4 + 3]);
    // at rest: nothing
    const still = new HullTrack(600, 0.1);
    for (let i = 0; i < 100; i++) still.push(i / 10, 5, 5, 0, 0);
    for (let j = 0; j < N; j++) expect(still.sample(10, ages[j], samples[j]).speed).toBe(0);
  });
});

describe('player wake: spray and who gets it', () => {
  it('spray grows with speed and planing, bursts on a slam, none at rest', () => {
    expect(sprayRates(0, 0, 0)).toEqual({ bow: 0, quarter: 0, slam: 0 });
    const slow = sprayRates(3, 0, 0);
    expect(slow.bow + slow.quarter + slow.slam).toBe(0);
    const fast = sprayRates(15, 0.9, 0);
    expect(fast.bow).toBeGreaterThan(50);
    expect(fast.quarter).toBeGreaterThan(30);
    expect(fast.slam).toBe(0);
    expect(sprayRates(15, 0.9, 4).slam).toBeGreaterThan(100);
    expect(sprayRates(15, 0.9, 1).slam).toBe(0);
  });

  it('only vessels have a wake', () => {
    const def = (aircraft: typeof CONFIG.aircraft, kind?: 'vessel' | 'aircraft') => ({ id: 'x', kind, config: { ...CONFIG, aircraft } }) as unknown as AircraftDef;
    expect(watercraftOf(def(CONFIG.aircraft))).toBeNull();
    expect(watercraftOf(def(V50_AIRCRAFT as typeof CONFIG.aircraft, 'vessel'))).toBe(V50_AIRCRAFT.watercraft);
    expect(watercraftOf(def(V50_AIRCRAFT as typeof CONFIG.aircraft))).toBe(V50_AIRCRAFT.watercraft);
    expect(watercraftOf(null)).toBeNull();
  });
});
