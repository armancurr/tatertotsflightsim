/**
 * Systems layered on top of the core loop: HUD/instruments, audio, effects,
 * airport, vegetation, towns and roads. Kept separate from app.ts so each can
 * be wired in (or switched off) without touching the core frame.
 */
import * as THREE from 'three';
import { CONFIG, MS_TO_KT, RAD_TO_DEG } from '../config';
import type { AircraftState, CameraMode, Controls, InstrumentReadings } from '../types';
import type { ControlState, SimAction } from '../input/controlSystem';
import type { WorldEnvironment } from '../world/environment';
import { terrainHeight } from '../world/heightfield';
import { treeDensity } from '../world/landcover';
import { createHud, type PanelDrawerFn } from '../ui/hud';
import { createInstrumentModel, updateInstruments, type HudReadings } from '../ui/instruments';
import { createAudio, createAudioInputTracker } from '../audio';
import { createEffects, cameraShakeFor } from '../fx';
import { createVegetation } from '../world/vegetation';
import { createTowns } from '../world/towns';
import { createRoads } from '../world/roads';
import { createInterimAirport } from '../world/airport/interim';

export interface ExtrasContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  env: WorldEnvironment;
  hudRoot: HTMLElement;
  aircraft: { root: THREE.Group; setPanelDrawer?(fn: PanelDrawerFn): void };
  atmosphere: { sunDirection: THREE.Vector3; timeOfDayName: string };
}

export interface ExtrasFrame {
  state: AircraftState;
  controls: Controls;
  controlState: ControlState;
  camera: THREE.PerspectiveCamera;
  dt: number;
  time: number;
  paused: boolean;
  cameraMode: CameraMode;
  fps: { fps: number; avg: number; min: number; onePercentLow: number; longFrames: number; frames: number };
}

export interface Extras {
  readings?(state: AircraftState, controls: Controls, dt: number): InstrumentReadings | null;
  cameraShake?(state: AircraftState): number;
  update?(f: ExtrasFrame): void;
  onAction?(a: SimAction): void;
  onReset?(which: 'runway' | 'approach'): void;
  onResize?(): void;
  dispose?(): void;
}

/** Feature switches (URL `?no=trees,towns,audio` turns systems off — handy for profiling). */
function disabled(): Set<string> {
  try {
    const v = new URLSearchParams(location.search).get('no');
    return new Set(v ? v.split(',') : []);
  } catch {
    return new Set();
  }
}

export async function createExtras(ctx: ExtrasContext): Promise<Extras> {
  const off = disabled();
  const { scene, env } = ctx;

  // ── Instruments + HUD (the HUD also plugs the real gauges into the 3D cockpit panel) ──
  const model = createInstrumentModel();
  const hud = off.has('hud') ? null : createHud(ctx.hudRoot, { aircraft: ctx.aircraft.setPanelDrawer ? (ctx.aircraft as { setPanelDrawer(fn: PanelDrawerFn): void }) : undefined });
  let readings: HudReadings | null = null;

  // ── World scenery ─────────────────────────────────────────────────────────
  const airport = off.has('airport') ? null : createInterimAirport(scene);
  const vegetation = off.has('trees')
    ? null
    : createVegetation(scene, { heightAt: terrainHeight, densityAt: treeDensity, seed: CONFIG.world.seed, renderer: ctx.renderer });
  const towns = off.has('towns') ? null : createTowns(scene, { heightAt: terrainHeight });
  const roads = off.has('roads') ? null : createRoads(scene, { heightAt: terrainHeight });
  if (vegetation) env.registerObstacleSource((x, z) => vegetation.obstacleTop(x, z));
  if (towns) env.registerObstacleSource((x, z) => towns.obstacleTop(x, z));

  // ── Audio + effects ───────────────────────────────────────────────────────
  const ground = (x: number, z: number) => {
    const g = env.groundHeight(x, z);
    const w = env.waterLevel(x, z);
    return w === null ? g : Math.max(g, w);
  };
  const audio = off.has('audio') ? null : createAudio();
  const audioIn = createAudioInputTracker();
  const fx = off.has('fx') ? null : createEffects(scene, { groundHeight: ground });
  const unlock = () => void audio?.resume();
  addEventListener('keydown', unlock);
  addEventListener('pointerdown', unlock);

  const P = new THREE.Vector3();
  const V = new THREE.Vector3();
  const Q = new THREE.Quaternion();
  const W = new THREE.Vector3();
  let crashT: number | null = null;
  let tdT = Number.NaN;
  let tdV = Number.NaN;
  let muted = false;

  return {
    readings(state, controls, dt) {
      readings = updateInstruments(model, state, controls, dt);
      return readings;
    },
    cameraShake: (s) =>
      cameraShakeFor({
        onGround: s.onGround,
        groundSpeedKt: s.derived.groundSpeed * MS_TO_KT,
        surface: env.surfaceAt(s.position.x, s.position.z),
        aoaDeg: s.derived.alpha * RAD_TO_DEG,
        stallAoaDeg: CONFIG.aircraft.aero.stallAlphaDeg + (CONFIG.aircraft.aero.stallAlphaFlapsShiftDeg * s.flapsDeg) / 30,
        airspeedKt: s.derived.ias * MS_TO_KT,
        vneKt: CONFIG.aircraft.limits.vneKt,
        crashAge: s.crash ? s.time - s.crash.time : null,
      }),
    update(f) {
      const s = f.state;
      const r = readings ?? updateInstruments(model, s, f.controls, 0);
      hud?.update(r, {
        cameraMode: f.cameraMode, paused: f.paused, fps: f.fps.fps, timeOfDay: ctx.atmosphere.timeOfDayName,
        state: s, controls: f.controls, mouseYoke: f.controlState.mouseYoke,
      }, f.dt);

      const sunElev = (Math.asin(Math.max(-1, Math.min(1, ctx.atmosphere.sunDirection.y))) * 180) / Math.PI;
      airport?.update(f.camera, f.time, sunElev);
      vegetation?.update(f.camera, f.time, ctx.atmosphere.sunDirection);
      towns?.update(f.camera, f.time);
      roads?.update(f.camera, f.time);

      P.set(s.position.x, s.position.y, s.position.z);
      V.set(s.velocity.x, s.velocity.y, s.velocity.z);
      if (fx) {
        if (s.crash && s.crash.time !== crashT) {
          const wl = env.waterLevel(P.x, P.z);
          fx.crash(P, s.crash.speedKt, { velocity: V, water: wl !== null && P.y < wl + 2 });
        }
        const td = s.touchdown;
        if (td && (td.time !== tdT || td.verticalSpeedFpm !== tdV)) {
          fx.touchdown(P, td.verticalSpeedFpm, {
            orientation: Q.set(s.orientation.x, s.orientation.y, s.orientation.z, s.orientation.w),
            velocity: V,
            surface: td.surface,
          });
        }
        fx.setSun(ctx.atmosphere.sunDirection);
        const w = env.wind?.(P.x, P.y, P.z, s.time);
        fx.update(f.camera, f.paused ? 0 : f.dt, w ? W.set(w.x, w.y, w.z) : undefined);
      }
      crashT = s.crash ? s.crash.time : null;
      tdT = s.touchdown ? s.touchdown.time : Number.NaN;
      tdV = s.touchdown ? s.touchdown.verticalSpeedFpm : Number.NaN;

      audio?.update(
        audioIn({
          state: s, controls: f.controls, cameraMode: f.cameraMode, paused: f.paused, dt: f.dt,
          surface: env.surfaceAt(P.x, P.z), cameraPosition: f.camera.position, stallWarning: r.stallWarning,
        }),
        f.dt,
      );
    },
    onAction(a) {
      if (a === 'help') hud?.toggleHelp();
      else if (a === 'toggleHud') hud?.toggleVisible();
      else if (a === 'mute') {
        muted = !muted;
        audio?.setMuted(muted);
        hud?.flash(muted ? 'Sound off' : 'Sound on', 'info', 1.5);
      }
    },
    onReset() {
      fx?.reset();
      crashT = null;
    },
    onResize() {
      hud?.resize();
    },
    dispose() {
      hud?.dispose();
      audio?.dispose();
      fx?.dispose();
      airport?.dispose();
      vegetation?.dispose();
      towns?.dispose();
      roads?.dispose();
      removeEventListener('keydown', unlock);
      removeEventListener('pointerdown', unlock);
    },
  };
}
