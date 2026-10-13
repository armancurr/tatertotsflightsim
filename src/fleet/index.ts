/**
 * The fleet registry: every aircraft (and vessel) the player can choose. To add an aircraft: give
 * it a config section in `src/config.ts` (same shape as `CONFIG.aircraft`), a model folder under
 * `src/aircraft/` with a factory returning an `AircraftModelHandle`, and one entry below. A vessel
 * is the same with a `watercraft` section, `kind: 'vessel'` and a model under `src/vessels/`
 * (docs/ADDING_A_VESSEL.md).
 */
import { CONFIG, F16_AIRCRAFT, F16_WEAPONS, A10_AIRCRAFT, A10_WEAPONS, B747_AIRCRAFT, B206_AIRCRAFT, V50_AIRCRAFT, IOWA_AIRCRAFT, IOWA_WEAPONS, CRUISE_AIRCRAFT, SEADOO_AIRCRAFT, type Config } from '../config';
import { createAircraft } from '../aircraft';
import { createF16Model } from '../aircraft/f16';
import { createA10Model } from '../aircraft/a10';
import { createB747Model } from '../aircraft/b747';
import { createB206Model } from '../aircraft/b206';
import { createV50Model } from '../vessels/v50';
import { createIowaModel } from '../vessels/iowa';
import { createCruiseModel } from '../vessels/cruise';
import { createSeadooModel } from '../vessels/seadoo';
import type { AircraftDef } from './types';

export type { AircraftDef, AircraftModelHandle, BreakupPart, HudStyle, EngineSound, VehicleKind } from './types';

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

const b747Config: Config = {
  ...CONFIG,
  aircraft: B747_AIRCRAFT,
  camera: {
    ...CONFIG.camera,
    chase: { ...CONFIG.camera.chase, distance: 95, height: 22, lookAhead: 20 },
    orbit: { ...CONFIG.camera.orbit, distance: 120, minDistance: 45, maxDistance: 500 },
  },
};

const B747: AircraftDef = {
  id: 'b747',
  name: 'Boeing 747-400',
  shortName: '747',
  description: 'The Queen of the Skies, flown light for fun — four engines, 64 m of wing, heavy and stately. Just fits the runway.',
  config: b747Config,
  hud: 'glass',
  sound: 'turbofan',
  createModel: () => createB747Model(),
};

const b206Config: Config = {
  ...CONFIG,
  aircraft: B206_AIRCRAFT,
  // The collective wants finer keyboard steps than a throttle: ~5 s from bottom to top.
  controls: { ...CONFIG.controls, throttleRate: 0.2 },
  camera: {
    ...CONFIG.camera,
    chase: { ...CONFIG.camera.chase, distance: 20, height: 5 },
    orbit: { ...CONFIG.camera.orbit, distance: 22 },
  },
};

const B206: AircraftDef = {
  id: 'b206',
  name: 'Bell 206B-3 JetRanger III',
  shortName: 'JetRanger',
  description: 'Light turbine helicopter — collective, cyclic and pedals, a real rotor model. K toggles the stability assist.',
  config: b206Config,
  hud: 'steam',
  sound: 'turboshaft',
  createModel: () => createB206Model(),
};

const v50Config: Config = {
  ...CONFIG,
  aircraft: V50_AIRCRAFT,
  // The helm lever: ~4 s from neutral to full ahead on the keyboard.
  controls: { ...CONFIG.controls, throttleRate: 0.25 },
  camera: {
    ...CONFIG.camera,
    chase: { ...CONFIG.camera.chase, distance: 28, height: 7 },
    orbit: { ...CONFIG.camera.orbit, distance: 30 },
  },
};

const V50: AircraftDef = {
  kind: 'vessel',
  id: 'v50',
  name: 'Princess V50',
  shortName: 'V50',
  description: '50 ft sports yacht on twin Volvo IPS 600 pods — starts moored in the marina; planes at ~15 kt, tops out ~34 kt.',
  config: v50Config,
  hud: 'marine',
  sound: 'marineDiesel',
  createModel: () => createV50Model(),
};

const iowaConfig: Config = {
  ...CONFIG,
  aircraft: IOWA_AIRCRAFT,
  weapons: IOWA_WEAPONS,
  // The engine-order telegraph: ~4 s from stop to full ahead on the keyboard (the turbines take far longer).
  controls: { ...CONFIG.controls, throttleRate: 0.25 },
  camera: {
    ...CONFIG.camera,
    chase: { ...CONFIG.camera.chase, distance: 380, height: 80, lookAhead: 60 },
    orbit: { ...CONFIG.camera.orbit, distance: 420, minDistance: 60, maxDistance: 3000 },
    external: { ...CONFIG.camera.external, leadDistance: 900, sideOffset: 150, heightOffset: 30, maxDistance: 2000, framingSize: 320, minLead: 300, spotterDistance: 320, spotterEyeHeight: 8 },
  },
};

const IOWA: AircraftDef = {
  kind: 'vessel',
  id: 'iowa',
  name: 'USS Iowa (BB-61)',
  shortName: 'Iowa',
  description: 'The 1943 fast battleship as modernised in 1984 — 270 m, 58,000 t, 212,000 shp on four shafts, nine 16-inch guns; 33 kt, and kilometres to stop.',
  config: iowaConfig,
  hud: 'marine',
  sound: 'marineDiesel',
  createModel: () => createIowaModel(),
};

const cruiseConfig: Config = {
  ...CONFIG,
  aircraft: CRUISE_AIRCRAFT,
  // The engine-order telegraph: ~8 s from stop to full ahead on the keyboard.
  controls: { ...CONFIG.controls, throttleRate: 0.12 },
  camera: {
    ...CONFIG.camera,
    chase: { ...CONFIG.camera.chase, distance: 290, height: 62, lookAhead: 60 },
    orbit: { ...CONFIG.camera.orbit, distance: 380, minDistance: 150, maxDistance: 2000 },
    external: { ...CONFIG.camera.external, framingSize: 320, sideOffset: 160, heightOffset: 30, maxDistance: 2400, spotterDistance: 260 },
  },
};

const CRUISE: AircraftDef = {
  kind: 'vessel',
  id: 'cruise',
  name: 'MS Tater Star',
  shortName: 'Cruise ship',
  description: '260 m Tater Line cruise ship (70,000 GT), twin screws and six tunnel thrusters — ← / → turn her on the spot; ~21 kt service, ~22 kt flat out.',
  config: cruiseConfig,
  hud: 'marine',
  sound: 'marineDiesel',
  createModel: () => createCruiseModel(),
};


// ── Sea-Doo RXP-X 325 (personal watercraft) ──
const seadooConfig: Config = {
  ...CONFIG,
  aircraft: SEADOO_AIRCRAFT,
  // A finger throttle: ~1 s from idle to wide open on the keyboard.
  controls: { ...CONFIG.controls, throttleRate: 1 },
  camera: {
    ...CONFIG.camera,
    chase: { ...CONFIG.camera.chase, distance: 8, height: 2.4 },
    orbit: { ...CONFIG.camera.orbit, distance: 9, minDistance: 3 },
  },
};

const SEADOO: AircraftDef = {
  kind: 'vessel',
  id: 'seadoo',
  name: 'Sea-Doo RXP-X 325',
  shortName: 'Sea-Doo',
  description: 'Supercharged 325 hp jet ski — 0–60 mph in ~3.4 s, governed at ~58 kt; lean into the carves, Space is the iBR brake.',
  config: seadooConfig,
  hud: 'marine',
  sound: 'pwc',
  createModel: () => createSeadooModel(),
};
// ── end Sea-Doo ──

/** In menu order (the picker lists vessels after the aircraft). */
export const FLEET: readonly AircraftDef[] = [C172, F16, A10, B747, B206, V50, SEADOO, CRUISE, IOWA];

export const DEFAULT_AIRCRAFT_ID = C172.id;

/** The aircraft with this id, or the default one. */
export function getAircraftDef(id: string | null | undefined): AircraftDef {
  return FLEET.find((d) => d.id === id) ?? C172;
}
