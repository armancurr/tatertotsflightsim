/**
 * The plug-in contract for everything layered on the core loop (terrain, water,
 * airport, roads, towns, vegetation, traffic, effects, audio, HUD…).
 *
 * Each system lives in its own file `src/game/systems/<name>.ts` and default-
 * exports a `SystemModule`. `systems/index.ts` discovers them automatically
 * (Vite `import.meta.glob`), so adding or changing a system never touches a
 * shared wiring file. URL `?no=<name>,<name>` switches systems off.
 */
import type * as THREE from 'three';
import type { AircraftState, CameraMode, Controls, InstrumentReadings } from '../../types';
import type { ControlState, SimAction } from '../../input/controlSystem';
import type { WorldEnvironment } from '../../world/environment';
import type { Atmosphere } from '../../render/atmosphere';
import type { PanelDrawerFn } from '../../ui/hud';

export interface SystemContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  env: WorldEnvironment;
  hudRoot: HTMLElement;
  aircraft: { root: THREE.Group; setPanelDrawer?(fn: PanelDrawerFn): void };
  atmosphere: Atmosphere;
}

export interface SystemFrame {
  state: AircraftState;
  controls: Controls;
  controlState: ControlState;
  camera: THREE.PerspectiveCamera;
  /** Frame time, s (not zeroed while paused — check `paused`). */
  dt: number;
  /** Seconds since start (keeps running while paused). */
  time: number;
  paused: boolean;
  cameraMode: CameraMode;
  fps: { fps: number; avg: number; min: number; onePercentLow: number; longFrames: number; frames: number };
  /** This frame's instrument readings (from the system that provides them), if any. */
  readings: InstrumentReadings | null;
}

export interface SimSystem {
  /** Resolves when the system has what it needs around the camera (awaited before the first frame, with a timeout). */
  ready?(camera: THREE.PerspectiveCamera): Promise<void>;
  /** Instrument readings (one system provides them: the HUD). */
  readings?(state: AircraftState, controls: Controls, dt: number): InstrumentReadings | null;
  /** Camera shake intensity 0..1 (the max over systems is used). */
  cameraShake?(state: AircraftState): number;
  update?(f: SystemFrame): void;
  onAction?(a: SimAction): void;
  onReset?(which: 'runway' | 'approach' | 'teleport'): void;
  onResize?(): void;
  /** Extra numbers for window.sim.debug[name]. */
  stats?(): Record<string, unknown>;
  dispose?(): void;
}

export interface SystemModule {
  /** Unique name (used by `?no=` and window.sim.debug). */
  name: string;
  /** Update order, ascending (world 10–40, scenery 50–70, fx/audio 80–90, HUD 100). */
  order: number;
  create(ctx: SystemContext): SimSystem | Promise<SimSystem>;
}
