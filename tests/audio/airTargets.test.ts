/**
 * The enemy aircraft's sound (src/audio/airTargetsMapping.ts, src/audio/airTargets.ts and the audio
 * system's feed from the combat world):
 *
 *  - unit: distance law + fade to silence at ~3 km, air absorption, closing speed, Doppler (up
 *    approaching, down receding), aspect, pan; the voice assignment (nearest 3 in range, a voice
 *    stays on its aircraft);
 *  - fuzz: any sources and listener — finite, bounded, at most 3 heard, each once, all in range;
 *  - functional (WebAudio mock): a MiG-29 flyby past the chase camera is heard coming (pitch up),
 *    loudest at the pass, then going (pitch down) and fades out by 3 km; a Mi-24 plays the rotor
 *    layer; killed aircraft fall silent; pause and mute zero the master; reset drops every voice.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { CONFIG } from '../../src/config';
import {
  airDoppler, airVoiceCutoffHz, airVoiceGain, aspectOf, assignAirVoices, closingSpeedMs, createAirVoiceTarget, panOf,
  type AirListener, type AirSoundSource,
} from '../../src/audio/airTargetsMapping';
import { bladePulse, createAirAudio } from '../../src/audio/airTargets';
import mod from '../../src/game/systems/audio';
import { combatWorld } from '../../src/combat/world';
import type { SimSystem, SystemContext, SystemFrame } from '../../src/game/systems/types';
import type { AircraftDef } from '../../src/fleet/types';
import { FLEET } from '../../src/fleet';
import { makeControls, makeState } from '../ui/fixtures';
import { MockAudioContext, MockGain, MockParam, violations } from './mockAudio';
import { fcParams } from '../support/fc';

const C = CONFIG.audio.airTargets;
const listener = (o: Partial<AirListener> = {}): AirListener => ({ x: 0, y: 500, z: 0, vx: 0, vy: 0, vz: 0, rx: 1, ry: 0, rz: 0, cockpit: false, ...o });
const src = (id: number, x: number, y: number, z: number, vx = 0, vy = 0, vz = 0, kind: AirSoundSource['kind'] = 'fighter'): AirSoundSource => ({ id, kind, x, y, z, vx, vy, vz });

describe('air target sound: the maths', () => {
  it('level: full close in, falling with distance, silent from ~3 km', () => {
    expect(airVoiceGain(10)).toBe(1);
    expect(airVoiceGain(C.refDistanceM)).toBe(1);
    let prev = 1;
    for (let d = C.refDistanceM + 1; d < C.maxRangeM + 200; d += 37) {
      const g = airVoiceGain(d);
      expect(g).toBeLessThanOrEqual(prev + 1e-12);
      prev = g;
    }
    expect(airVoiceGain(C.maxRangeM)).toBe(0);
    expect(airVoiceGain(5000)).toBe(0);
    expect(airVoiceGain(1000)).toBeGreaterThan(0.05); // a jet 1 km away is clearly heard
    expect(airVoiceGain(NaN)).toBe(0);
    // no step at the start of the fade
    expect(Math.abs(airVoiceGain(C.fadeFromM + 0.5) - airVoiceGain(C.fadeFromM - 0.5))).toBeLessThan(0.002);
  });

  it('air absorption: duller with distance', () => {
    expect(airVoiceCutoffHz(0)).toBe(C.maxCutoffHz);
    expect(airVoiceCutoffHz(C.absorptionHalfM)).toBeCloseTo(C.maxCutoffHz / 2, 6);
    expect(airVoiceCutoffHz(2800)).toBeLessThan(airVoiceCutoffHz(600));
    expect(airVoiceCutoffHz(1e6)).toBe(C.minCutoffHz);
  });

  it('closing speed, Doppler, aspect and pan', () => {
    const l = listener();
    // 1 km north, flying south at 200 m/s straight at us: closing +200, pitch up, we are ahead of it
    const inbound = src(1, 0, 500, -1000, 0, 0, 200);
    expect(closingSpeedMs(inbound, l)).toBeCloseTo(200, 6);
    const c = CONFIG.audio.speedOfSoundMs;
    expect(airDoppler(150)).toBeCloseTo(c / (c - 150), 6);
    expect(airDoppler(200)).toBe(C.dopplerMax); // (343 / 143 = 2.4: clamped)
    expect(aspectOf(inbound, l)).toBeCloseTo(1, 6);
    // past us and going away: pitch down, we are behind it
    const outbound = src(1, 0, 500, 1000, 0, 0, 200);
    expect(closingSpeedMs(outbound, l)).toBeCloseTo(-200, 6);
    expect(airDoppler(-200)).toBeLessThan(1);
    expect(aspectOf(outbound, l)).toBeCloseTo(-1, 6);
    // our own speed counts too (listener flying north at 100 m/s toward it)
    expect(closingSpeedMs(inbound, listener({ vz: -100 }))).toBeCloseTo(300, 6);
    // Doppler clamped
    expect(airDoppler(1e6)).toBe(C.dopplerMax);
    expect(airDoppler(-1e6)).toBeGreaterThanOrEqual(C.dopplerMin);
    expect(airDoppler(-1e6)).toBeLessThan(0.6);
    // pan: east of a listener whose right is +X → right
    expect(panOf(src(1, 300, 500, 0), l, 1)).toBeCloseTo(1, 6);
    expect(panOf(src(1, -300, 500, -300), l, 0.75)).toBeLessThan(0);
    // abeam, or hovering: aspect 0
    expect(aspectOf(src(1, 500, 500, 0, 0, 0, 200), l)).toBeCloseTo(0, 6);
    expect(aspectOf(src(1, 500, 500, 0), l)).toBe(0);
  });

  it('assignment: the nearest 3 in range; a voice keeps its aircraft; out of range is silent', () => {
    const voices = Array.from({ length: 3 }, createAirVoiceTarget);
    const l = listener();
    const ss = [src(1, 0, 500, -2000), src(2, 0, 500, -500), src(3, 0, 500, -2900), src(4, 0, 500, -1500), src(5, 0, 500, -4000)];
    expect(assignAirVoices(voices, ss, ss.length, l)).toBe(3);
    const ids = voices.map((v) => v.id).sort();
    expect(ids).toEqual([1, 2, 4]);
    const slotOf = (id: number) => voices.findIndex((v) => v.id === id);
    const s1 = slotOf(1);
    const s2 = slotOf(2);
    // aircraft 3 comes closer than 1 → 4 drops out; 1 and 2 keep their voices
    ss[2].z = -800;
    ss[3].z = -2600;
    assignAirVoices(voices, ss, ss.length, l);
    expect(slotOf(1)).toBe(s1);
    expect(slotOf(2)).toBe(s2);
    expect(slotOf(3)).toBeGreaterThanOrEqual(0);
    expect(slotOf(4)).toBe(-1);
    // everyone beyond 3 km: silence
    for (const s of ss) s.z = -5000;
    expect(assignAirVoices(voices, ss, ss.length, l)).toBe(0);
    expect(voices.every((v) => v.id === -1 && v.gain === 0)).toBe(true);
  });

  it('fuzz: finite, bounded, at most the voice count, each aircraft once, all in range', () => {
    const coord = fc.double({ min: -6000, max: 6000, noNaN: true });
    const vel = fc.double({ min: -350, max: 350, noNaN: true });
    fc.assert(
      fc.property(
        fc.array(fc.record({ x: coord, y: fc.double({ min: 0, max: 4000, noNaN: true }), z: coord, vx: vel, vy: vel, vz: vel, kind: fc.constantFrom('fighter', 'attack', 'helo') }), { maxLength: 12 }),
        fc.record({ x: coord, y: fc.double({ min: 0, max: 4000, noNaN: true }), z: coord, vx: vel, vy: vel, vz: vel, cockpit: fc.boolean() }),
        fc.integer({ min: 1, max: 4 }),
        (list, lo, frames) => {
          const voices = Array.from({ length: 3 }, createAirVoiceTarget);
          const ss = list.map((s, i) => src(i + 1, s.x, s.y, s.z, s.vx, s.vy, s.vz, s.kind as AirSoundSource['kind']));
          const l = listener(lo);
          for (let k = 0; k < frames; k++) {
            for (const s of ss) {
              s.x += s.vx * 0.5;
              s.z += s.vz * 0.5;
            }
            const heard = assignAirVoices(voices, ss, ss.length, l);
            expect(heard).toBeLessThanOrEqual(3);
            const seen = new Set<number>();
            for (const v of voices) {
              if (v.id < 0) continue;
              expect(seen.has(v.id)).toBe(false);
              seen.add(v.id);
              expect(v.distanceM).toBeLessThan(C.maxRangeM);
              for (const x of [v.gain, v.doppler, v.cutoffHz, v.pan, v.aspect, v.closingMs]) expect(Number.isFinite(x)).toBe(true);
              expect(v.gain).toBeGreaterThanOrEqual(0);
              expect(v.gain).toBeLessThanOrEqual(1.0001);
              expect(v.doppler).toBeGreaterThanOrEqual(C.dopplerMin);
              expect(v.doppler).toBeLessThanOrEqual(C.dopplerMax);
              expect(Math.abs(v.pan)).toBeLessThanOrEqual(1);
            }
          }
        },
      ),
      fcParams(300),
    );
  });

  it('the rotor gate is a short pulse per blade, 0..1', () => {
    const p = bladePulse(256);
    expect(Math.max(...p)).toBeCloseTo(1, 2);
    expect(Math.min(...p)).toBe(0);
    const on = p.filter((x) => x > 0.01).length / p.length;
    expect(on).toBeGreaterThan(0.15);
    expect(on).toBeLessThan(0.35);
  });
});

describe('air target sound: the voices (WebAudio mock)', () => {
  beforeEach(() => {
    violations.length = 0;
  });

  it('builds a small fixed pool, follows the targets and goes silent on reset', () => {
    const ctx = new MockAudioContext();
    const out = ctx.createGain();
    const air = createAirAudio(ctx as unknown as BaseAudioContext, out as unknown as AudioNode);
    const nodesAfterBuild = ctx.nodes.length;
    const frame = { listener: listener(), sources: [src(7, 0, 500, -400, 0, 0, 180), src(8, 300, 450, -200, 0, 0, 0, 'helo')], count: 2, dt: 1 / 60 };
    for (let i = 0; i < 30; i++) {
      ctx.advance(1 / 60);
      air.update(frame);
    }
    expect(ctx.nodes.length).toBe(nodesAfterBuild); // no nodes per frame
    expect(air.voices.filter((v) => v.id >= 0).length).toBe(2);
    const L = { airVoices: 0, airLevel: 0, airDoppler: 1 } as never as import('../../src/audio/types').AudioLevels;
    air.levels(L);
    expect(L.airVoices).toBe(2);
    expect(L.airLevel).toBeGreaterThan(0.1);
    // the level gains (the last gain of each voice before the bus) are up
    const levelTargets = () => ctx.nodes.filter((n): n is MockGain => n instanceof MockGain).map((g) => (g.gain as MockParam).value);
    expect(levelTargets().some((v) => v > 0.1)).toBe(true);
    air.reset();
    air.levels(L);
    expect(L.airVoices).toBe(0);
    expect(air.voices.every((v) => v.id === -1)).toBe(true);
    air.dispose();
    expect(violations).toEqual([]);
  });
});

// ─── The system: combat world → sound ────────────────────────────────────────

type G = Record<string, unknown>;
const g = globalThis as unknown as G;
const KEYS = ['AudioContext', 'addEventListener', 'removeEventListener', 'dispatchEvent', 'runAudioSelfTest', 'simAudio'];
const saved: G = {};
const a10 = FLEET.find((d) => d.id === 'a10') as AircraftDef;

describe('audio system × enemy aircraft', () => {
  let sys: SimSystem | null = null;
  beforeEach(() => {
    violations.length = 0;
    for (const k of KEYS) saved[k] = g[k];
    const target = new EventTarget();
    g.addEventListener = target.addEventListener.bind(target);
    g.removeEventListener = target.removeEventListener.bind(target);
    g.dispatchEvent = target.dispatchEvent.bind(target);
    g.AudioContext = MockAudioContext;
  });
  afterEach(() => {
    sys?.dispose?.();
    sys = null;
    for (const k of KEYS) {
      if (saved[k] === undefined) delete g[k];
      else g[k] = saved[k];
    }
    expect(violations).toEqual([]);
  });

  async function setup() {
    const scene = new THREE.Scene();
    const ctx = { scene, env: { surfaceAt: () => 'field', groundHeight: () => 0 }, actions: { currentAircraft: () => a10 } } as unknown as SystemContext;
    sys = (await mod.create(ctx)) as SimSystem;
    (g.dispatchEvent as (e: Event) => boolean)(new Event('keydown'));
    await new Promise((r) => setTimeout(r, 0));
    const world = combatWorld(scene);
    const camera = new THREE.PerspectiveCamera(60, 1.6, 0.1, 1e5);
    camera.position.set(0, 506, 25);
    camera.lookAt(0, 500, -100);
    camera.updateMatrixWorld();
    const state = makeState({ iasKt: 250 });
    state.position = { x: 0, y: 500, z: 0 };
    let time = 0;
    const frame = (o: { paused?: boolean; cameraMode?: string; dt?: number } = {}) => {
      const dt = o.dt ?? 1 / 30;
      time += dt;
      const ac = (MockAudioContext.instances[MockAudioContext.instances.length - 1] as MockAudioContext);
      ac.advance(dt);
      sys!.update!({ state, controls: makeControls(), controlState: {}, camera, dt, time, paused: !!o.paused, cameraMode: o.cameraMode ?? 'chase', fps: {}, readings: null, def: a10, aircraft: {} } as unknown as SystemFrame);
      return sys!.stats!() as Record<string, number>;
    };
    return { world, frame, camera };
  }

  it('a MiG-29 flyby: heard coming (pitch up), loudest at the pass, going (pitch down), gone by 3 km', async () => {
    const { world, frame } = await setup();
    // passing 150 m to the east of us, flying south (toward +Z) at 220 m/s, starting 4 km north
    const mig = world.addTarget({ kind: 'fighter', position: { x: 150, y: 520, z: -4000 }, headingDeg: 180, velocity: { x: 0, y: 0, z: 220 }, orientation: { x: 0, y: 1, z: 0, w: 0 }, group: 'air' });
    const log: { z: number; level: number; doppler: number; voices: number }[] = [];
    for (let i = 0; i < 30 * 36; i++) {
      mig.position.z += 220 / 30;
      const L = frame();
      log.push({ z: mig.position.z, level: L.airLevel, doppler: L.airDoppler, voices: L.airVoices });
    }
    const at = (z: number) => log.reduce((a, b) => (Math.abs(b.z - z) < Math.abs(a.z - z) ? b : a));
    expect(at(-3500).voices).toBe(0); // too far yet
    expect(at(-2000).voices).toBe(1);
    expect(at(-2000).doppler).toBeGreaterThan(1.3);
    expect(at(2000).doppler).toBeLessThan(0.8);
    const peak = log.reduce((a, b) => (b.level > a.level ? b : a));
    expect(Math.abs(peak.z)).toBeLessThan(300);
    expect(peak.level).toBeGreaterThan(at(-1500).level * 3);
    expect(at(1500).level).toBeGreaterThan(0.02);
    expect(at(3600).voices).toBe(0);
  });

  it('a Mi-24 plays the rotor; a killed aircraft is silent; pause, mute and reset cut it', async () => {
    const { world, frame } = await setup();
    const hind = world.addTarget({ kind: 'helo', position: { x: 200, y: 480, z: -300 }, headingDeg: 0, velocity: { x: 0, y: 0, z: -40 }, orientation: { x: 0, y: 0, z: 0, w: 1 }, group: 'air' });
    world.addTarget({ kind: 'tank', position: { x: 0, y: 0, z: -200 }, headingDeg: 0, group: 'g' }); // vehicles make no engine sound here
    let L = frame();
    L = frame();
    expect(L.airVoices).toBe(1);
    expect(L.airLevel).toBeGreaterThan(0.1);
    // the voice runs the rotor layer: its blade-pass gate oscillator is at ~20 Hz × Doppler
    const ac = MockAudioContext.instances[MockAudioContext.instances.length - 1] as MockAudioContext;
    const oscHz = ac.nodes.filter((n) => n.kind === 'oscillator').map((n) => ((n as unknown as { frequency: MockParam }).frequency).value);
    expect(oscHz.some((f) => Math.abs(f - C.helo.bladeHz) < 3)).toBe(true);
    // pause → master 0
    L = frame({ paused: true, dt: 0 });
    expect(L.master).toBe(0);
    L = frame();
    expect(L.master).toBeGreaterThan(0);
    // mute → master 0
    sys!.onAction!('mute' as never);
    L = frame();
    expect(L.master).toBe(0);
    sys!.onAction!('mute' as never);
    // reset → dropped at once (then picked up again next frame, as it is still flying there)
    sys!.onReset!('runway' as never);
    expect((sys!.stats!() as Record<string, number>).airVoices).toBe(0);
    // killed → silent
    world.applyHit(hind.id, { weapon: 'gun', damage: 1e6, point: { ...hind.position }, direction: { x: 0, y: -1, z: 0 }, time: 1, face: 'top' });
    expect(hind.alive).toBe(false);
    L = frame();
    expect(L.airVoices).toBe(0);
    // in the cockpit the canopy muffles it
    const h2 = world.addTarget({ kind: 'helo', position: { x: 200, y: 480, z: -300 }, headingDeg: 0, velocity: { x: 0, y: 0, z: 0 }, orientation: { x: 0, y: 0, z: 0, w: 1 }, group: 'air' });
    const outside = frame().airLevel;
    const inside = frame({ cameraMode: 'cockpit' }).airLevel;
    expect(inside).toBeCloseTo(outside * CONFIG.audio.combat.canopyGain, 3);
    void h2;
  });
});
