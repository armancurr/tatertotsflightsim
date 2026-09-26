/**
 * The fleet: every flyable aircraft is an `AircraftDef` — its full physics config (same shape as
 * CONFIG, with its own `aircraft` section), a 3D-model factory, and which HUD and engine sound it
 * uses. Adding an aircraft = one config section + one model folder + one entry in
 * `src/fleet/index.ts`. See ARCHITECTURE.md "The fleet".
 */
import type * as THREE from 'three';
import type { Config } from '../config';
import type { AircraftVisualState, PanelDrawer } from '../aircraft/types';

/**
 * A piece of the airframe that separates in a crash (wing, tail, fuselage, engine…). The crash
 * system detaches `object` into the scene (keeping its world transform), simulates it as a rigid
 * body, and gives it back via `restoreBreakupParts()` on reset.
 */
export interface BreakupPart {
  /** 'fuselage' | 'leftWing' | 'rightWing' | 'tail' | 'engine' | 'prop' | 'canopy' | 'gear…' … */
  name: string;
  object: THREE.Object3D;
  /** Approximate mass, kg (drives how far it flies and how it tumbles). */
  mass: number;
  /** Carries fuel / catches fire. */
  burning?: boolean;
}

/** What the game loop needs from any aircraft's 3D model. */
export interface AircraftModelHandle {
  /** Put in the scene; the loop copies the physics position/orientation onto it. */
  root: THREE.Group;
  setVisualState(v: AircraftVisualState, dt: number): void;
  /** Cockpit panel drawer hook (steam-gauge aircraft); jets may ignore it. */
  setPanelDrawer?(fn: PanelDrawer): void;
  landingLight?: THREE.SpotLight;
  /**
   * Jets: the HUD combiner glass (a mesh on the model). In the cockpit view the HUD symbology is
   * drawn inside its projected outline, so it sits on the glass and moves with it as you look around.
   */
  hudCombiner?: THREE.Object3D;
  /** Major parts for the crash break-up. Default when absent: the root's direct children. */
  getBreakupParts?(): BreakupPart[];
  /** Re-attach every part to its original parent with its original local transform (on reset). */
  restoreBreakupParts?(): void;
  dispose(): void;
}

/** 'steam' six-pack (Cessna), 'jet' head-up display (F-16, A-10), 'glass' airliner PFD + EICAS overlay (747), 'marine' helm display (boats and ships). */
export type HudStyle = 'steam' | 'jet' | 'glass' | 'marine';
/** Engine voice: Cessna O-360 + prop, F-16 F110 afterburning jet, A-10 TF34 high-bypass turbofans, JetRanger turboshaft + rotors, marine diesels + props + hull. */
export type EngineSound = 'piston' | 'jet' | 'turbofan' | 'turboshaft' | 'marineDiesel';

/** What the player drives: an aircraft (starts on the runway) or a vessel (starts at the marina; `config.aircraft.watercraft` set). */
export type VehicleKind = 'aircraft' | 'vessel';

export interface AircraftDef {
  /** 'vessel' for boats and ships (absent = 'aircraft'). Must agree with `config.aircraft.watercraft`. */
  kind?: VehicleKind;
  /** Stable id used in URLs (`?aircraft=f16`) and saved settings. */
  id: string;
  /** Full display name, e.g. "Cessna 172RG Cutlass". */
  name: string;
  /** Short name for menus, e.g. "Cessna 172". */
  shortName: string;
  /** One line for the aircraft picker. */
  description: string;
  /** Full config with this aircraft's `aircraft` (and optional camera) section — pass to physics and cameras. */
  config: Config;
  hud: HudStyle;
  sound: EngineSound;
  createModel(): AircraftModelHandle;
}
