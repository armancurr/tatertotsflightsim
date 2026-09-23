/**
 * The fleet registry: every aircraft the player can choose. To add an aircraft: give it a config
 * section in `src/config.ts` (same shape as `CONFIG.aircraft`), a model folder under
 * `src/aircraft/` with a factory returning an `AircraftModelHandle`, and one entry below.
 */
import { CONFIG, F16_AIRCRAFT, F16_WEAPONS, A10_AIRCRAFT, A10_WEAPONS, type Config } from '../config';
import { createAircraft } from '../aircraft';
import { createF16Model } from '../aircraft/f16';
import { createA10Model } from '../aircraft/a10';
import type { AircraftDef } from './types';

export type { AircraftDef, AircraftModelHandle, BreakupPart, HudStyle, EngineSound } from './types';

const C172: AircraftDef = {
  id: 'c172rg',
  name: 'Cessna 172RG Cutlass',
  shortName: 'Cessna 172',
  description: 'Four-seat piston trainer with retractable gear — forgiving, 180 hp, ~125 kt.',
  config: CONFIG,
  hud: 'steam',
  sound: 'piston',
  createModel: () => createAircraft({ quality: 'high' }),
};

const f16Config: Config = {
  ...CONFIG,
  aircraft: F16_AIRCRAFT,
  weapons: F16_WEAPONS,
  camera: {
    ...CONFIG.camera,
    chase: { ...CONFIG.camera.chase, distance: 26, height: 5.5 },
    orbit: { ...CONFIG.camera.orbit, distance: 30 },
  },
};

const F16: AircraftDef = {
  id: 'f16',
  name: 'F-16C Fighting Falcon',
  shortName: 'F-16',
  description: 'Single-engine supersonic fighter with afterburner and fly-by-wire — fast, agile, unforgiving.',
  config: f16Config,
  hud: 'jet',
  sound: 'jet',
  createModel: () => createF16Model(),
};

const a10Config: Config = {
  ...CONFIG,
  aircraft: A10_AIRCRAFT,
  weapons: A10_WEAPONS,
  camera: {
    ...CONFIG.camera,
    chase: { ...CONFIG.camera.chase, distance: 30, height: 6 },
    orbit: { ...CONFIG.camera.orbit, distance: 34 },
  },
};

const A10: AircraftDef = {
  id: 'a10',
  name: 'A-10C Thunderbolt II',
  shortName: 'A-10',
  description: 'Twin-engine tank killer built around the 30 mm GAU-8/A Avenger, with four AGM-65 Mavericks — slow, tough, deadly.',
  config: a10Config,
  hud: 'jet',
  sound: 'turbofan',
  createModel: () => createA10Model(),
};

/** In menu order. */
export const FLEET: readonly AircraftDef[] = [C172, F16, A10];

export const DEFAULT_AIRCRAFT_ID = C172.id;

/** The aircraft with this id, or the default one. */
export function getAircraftDef(id: string | null | undefined): AircraftDef {
  return FLEET.find((d) => d.id === id) ?? C172;
}
