/**
 * The naval guns' sound (src/audio/naval.ts) on the mock WebAudio: each report / splash / burst is
 * scheduled at its own distance / 343 m/s (a salvo 10 km away is heard ~29 s after the flash), far
 * sounds are quieter and duller (air absorption), reset silences sounds still on their way, no
 * automation ever gets a non-finite value; the pure mappings; the audio system hands its master bus
 * over (AudioSystem.masterInput) and the navalAudio system plays the combat world's naval events.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { createNavalSound, navalCutoffHz, navalDelayS, navalGain, shareAudio, sharedAudio } from '../../src/audio/naval';
import { createAudio } from '../../src/audio';
import { combatWorld } from '../../src/combat/world';
import navalAudioModule from '../../src/game/systems/navalAudio';
import type { SystemContext } from '../../src/game/systems/types';
import { MockAudioContext, MockScheduled, violations } from './mockAudio';

beforeEach(() => {
  violations.length = 0;
});

const starts = (ctx: MockAudioContext) => ctx.nodes.filter((n) => n instanceof MockScheduled).map((n) => (n as MockScheduled).started as number);

describe('naval sound mappings', () => {
  it('delay d / 343 (capped), gain falls with distance, cut-off falls with distance', () => {
    expect(navalDelayS(10000)).toBeCloseTo(29.15, 1);
    expect(navalDelayS(-5)).toBe(0);
    expect(navalDelayS(1e9)).toBe(90);
    expect(navalGain(50)).toBe(1);
    expect(navalGain(1000)).toBeLessThan(navalGain(300));
    expect(navalGain(10000)).toBeGreaterThan(0);
    expect(navalCutoffHz(0)).toBe(9000);
    expect(navalCutoffHz(10000)).toBeLessThan(400);
    fc.assert(fc.property(fc.double(), (d) => {
      for (const v of [navalDelayS(d), navalGain(d), navalCutoffHz(d)]) expect(Number.isFinite(v)).toBe(true);
    }));
  });
});

describe('naval sound (mock WebAudio)', () => {
  it('a report 40 m away starts in 0.12 s; from 10 km it starts ~29 s later; reset silences both', () => {
    const ctx = new MockAudioContext();
    const out = ctx.createGain();
    const s = createNavalSound(ctx as unknown as BaseAudioContext, out as unknown as AudioNode);
    s.report({ distanceM: 40 });
    const near = starts(ctx);
    expect(near.length).toBeGreaterThan(4);
    expect(Math.min(...near)).toBeCloseTo(40 / 343, 3);
    const n0 = near.length;
    s.report({ distanceM: 10000 });
    const far = starts(ctx).slice(n0);
    expect(Math.min(...far)).toBeCloseTo(29.15, 1);
    expect(s.played.reports).toBe(2);
    s.reset();
    for (const n of ctx.nodes) if (n instanceof MockScheduled && n.started !== null) expect(n.stopped).not.toBeNull();
    expect(violations).toEqual([]);
  });

  it('splash and burst schedule at their distance; garbage inputs never violate the API', () => {
    const ctx = new MockAudioContext();
    const s = createNavalSound(ctx as unknown as BaseAudioContext, ctx.createGain() as unknown as AudioNode);
    s.splash({ distanceM: 3430 });
    expect(Math.min(...starts(ctx))).toBeCloseTo(10, 2);
    s.burst({ distanceM: 686, size: 1.2 });
    fc.assert(fc.property(fc.double(), fc.double(), (d, k) => {
      s.report({ distanceM: d, size: k });
      s.splash({ distanceM: d, size: k });
      s.burst({ distanceM: d, size: k });
    }), { numRuns: 40 });
    expect(violations).toEqual([]);
    s.dispose();
  });
});

describe('naval audio wiring', () => {
  it('the audio system exposes its master bus; the navalAudio system plays navalFire / shell detonations', async () => {
    let ctx: MockAudioContext | null = null;
    const audio = createAudio({ createContext: () => ((ctx = new MockAudioContext()), ctx as unknown as AudioContext) });
    expect(audio.masterInput).toBeNull();
    await audio.resume();
    expect(audio.masterInput).not.toBeNull();
    const scene = new THREE.Scene();
    shareAudio(scene, audio);
    expect(sharedAudio(scene)).toBe(audio);
    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 20, 0);
    const sys = await navalAudioModule.create({ scene, camera } as unknown as SystemContext);
    const world = combatWorld(scene);
    world.emit({ type: 'navalFire', time: 0, turret: 0, gun: 1, position: { x: 0, y: 20, z: -60 }, direction: { x: 0, y: 0.1, z: -1 }, caliberMm: 406 });
    world.emit({ type: 'detonation', time: 0, weapon: 'shell', position: { x: 0, y: 0, z: -9000 }, targetId: null, blastRadiusM: 30, surface: 'water' });
    world.emit({ type: 'detonation', time: 0, weapon: 'shell', position: { x: 0, y: 3, z: -9000 }, targetId: 4, blastRadiusM: 30, surface: 'target' });
    world.emit({ type: 'detonation', time: 0, weapon: 'missile', position: { x: 0, y: 3, z: -900 }, targetId: 4, blastRadiusM: 18, surface: 'grass' });
    expect(sys.stats!()).toEqual({ reports: 1, splashes: 1, bursts: 1 });
    sys.onReset!('runway');
    sys.dispose!();
    audio.dispose();
    expect(violations).toEqual([]);
  });

  it('stays silent (no throw) before the audio context exists', async () => {
    const scene = new THREE.Scene();
    const sys = await navalAudioModule.create({ scene, camera: new THREE.PerspectiveCamera() } as unknown as SystemContext);
    combatWorld(scene).emit({ type: 'navalFire', time: 0, turret: 0, gun: 0, position: { x: 0, y: 0, z: 0 }, direction: { x: 0, y: 0, z: -1 }, caliberMm: 406 });
    expect(sys.stats!()).toEqual({ reports: 0, splashes: 0, bursts: 0 });
  });
});
