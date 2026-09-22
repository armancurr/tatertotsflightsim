/**
 * Systems layered on top of the core loop: HUD/instruments, audio, airport,
 * vegetation, towns, roads and effects. Kept separate from app.ts so each can
 * be wired in (or switched off) without touching the core frame.
 */
import type * as THREE from 'three';
import type { AircraftState, CameraMode, Controls, Environment, InstrumentReadings } from '../types';
import type { ControlState, SimAction } from '../input/controlSystem';

export interface ExtrasContext {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  env: Environment;
  hudRoot: HTMLElement;
  aircraft: { root: THREE.Group; setPanelDrawer?: unknown };
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

export async function createExtras(_ctx: ExtrasContext): Promise<Extras> {
  return {};
}
