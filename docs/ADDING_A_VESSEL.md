# Adding a vessel

<!-- examples: src/vessels/tug/ src/vessels/tug/index.ts tests/vessels/tug/ tests/physics/tug.test.ts createTugModel TUG_AIRCRAFT makeTug -->

This guide adds a driveable boat or ship. The first one is the **Princess V50** sports yacht (id
`v50`): read its config (`makeV50()` at the end of `src/config.ts`), its model
(`src/vessels/v50/`) and its tests (`tests/physics/v50.test.ts`, `tests/physics/v50-fuzz.test.ts`)
alongside this page. The worked example here is a **harbour tug** (id `tug`, a displacement hull
with two shaft propellers and rudders); the same steps give you a jet-ski, a ferry, a cruise
ship or a battleship — only the numbers change.

A vessel is an `AircraftDef` in the fleet, like an aircraft, with:

- `kind: 'vessel'` (the picker lists it under "Vessels", the menu offers "Back to the berth" and
  "Start on the open sea");
- a config whose `aircraft.watercraft` section is set (a `WatercraftConfig`) — that is what sends
  it through the hull model in `src/physics/hull.ts` instead of the wing;
- `hud: 'marine'` (the helm display, `src/ui/marineHud.ts`) and `sound: 'marineDiesel'`
  (`src/audio/marineDiesel.ts`);
- a model factory returning an `AircraftModelHandle`, under `src/vessels/<name>/`.

Nothing else needs wiring: the app starts a vessel at its berth (`playerBerth()` in
`src/world/port.ts`) and Shift+R starts it underway at `seaStart()`; the wake and spray
(`src/game/systems/playerWake.ts`), the audio and the HUD all read `state.vessel`.

## Conventions

- **Body frame** as for aircraft (`src/types.ts`): origin at the **centre of gravity**, `+X`
  starboard, `+Y` up, **`−Z` the bow**. The physics' orientation is copied onto the model's root.
- **The hull is a contract.** `watercraft.hull.stations` is a table of `HullStation`s, bow to
  stern: at each `z`, the keel point `(0, keelY)`, a straight V bottom to the chine
  `(±chineHalf, chineY)`, straight topsides to the deck edge `(±deckHalf, deckY)`. The physics
  floats exactly this shape (`hullGeometry()`, `stationAt()`, `hullBottomY()` in
  `src/physics/hull.ts`) and the model lofts exactly this shape (`src/vessels/hullLoft.ts`). A
  round-bilge hull is a small deadrise with the "chine" at the turn of the bilge; a ship's
  parallel midbody is several identical stations.
- **SI units** in the code; knots only in names that say so (`speedKt`, `highSpeedKt`).
- **Procedural and MIT only**, like everything else.

## Step 1: the config

Add a factory next to `makeV50()`. Start from the closest vessel and change the numbers:

```ts
/** Harbour tug: 24 m, 8.5 m beam, 3.2 m draft, ~330 t, 2 × 1,200 kW on fixed shafts + rudders, 12 kt. */
function makeTug(): AircraftConfig {
  const v50 = structuredClone(V50_AIRCRAFT);
  const st = (z: number, half: number, keel: number): HullStation =>
    ({ z, keelY: keel, chineHalf: half * 0.92, chineY: keel + 0.6, deckHalf: half, deckY: 2.2 });
  return {
    ...v50,
    name: 'Harbour tug',
    registration: 'TATER TUG',
    mass: 330000,
    inertia: { pitch: 1.2e7, yaw: 1.3e7, roll: 2.5e6 },
    watercraft: {
      ...v50.watercraft!,
      hull: {
        ...v50.watercraft!.hull,
        kind: 'displacement',
        stations: [st(-12, 0.3, 0), st(-9, 3.4, -2.6), st(-4, 4.25, -3.2), st(4, 4.25, -3.2), st(9, 3.8, -2.9), st(12, 3.2, -1.2)],
        planingLift: 0,
        planingBuoyancyLoss: 0,
        selfWave: 0.4,
        residuary: [[0, 0], [0.2, 0.0006], [0.3, 0.0025], [0.4, 0.008], [0.5, 0.012]],
        gridLong: 32,
        gridTrans: 8,
        waveSamplesLong: 7,
        waveSamplesTrans: 3,
      },
      engine: { ...v50.watercraft!.engine, maxPowerW: 1200000, idleRpm: 600, maxRpm: 1800, gearRatio: 6, shaftInertia: 900 },
      propulsors: [-2.2, 2.2].map((x) => ({
        ...v50.watercraft!.propulsors[0],
        type: 'shaft' as const,
        position: { x, y: -2.4, z: 9.5 },
        thrustAngleDeg: 0,
        diameter: 2.4,
        foilArea: 4.5,
        foilCentre: { x, y: -2.2, z: 11.2 },
        maxSteerDeg: 35,
        highSpeedSteerDeg: 35,
      })),
      trimTabs: null,
    },
  };
}
export const TUG_AIRCRAFT: AircraftConfig = makeTug();
```

What each part of `WatercraftConfig` does:

| Section | What it is | Planing yacht → ship |
| --- | --- | --- |
| `hull.kind`, `planingLift`, `planingBuoyancyLoss` | Savitsky dynamic lift and how much of the buoyancy turns into it at speed | `'planing'`, ~1, ~0.85 → `'displacement'`, 0, 0 |
| `hull.residuary` | Wave-making resistance coefficient Cr vs Froude number (on the static wetted surface) | a hump near Fn 0.5 falling away as it planes → rising steeply toward Fn 0.3–0.4 (Holtrop-style) |
| `hull.selfWave`, `selfWaveFadeFn` | The hull's own Kelvin wave (hump trim, squat) | 0.75 → 0.3–0.5 |
| `hull.gridLong`, `gridTrans`, `waveSamplesLong` | Buoyancy columns and wave samples | more for long hulls, so the sea's short waves average out and its long swell rocks the ship |
| `hull.dampingLinear`, `dampingQuadratic`, `rollDamping` | Heave / pitch / roll damping | bilge keels → more `rollDamping` |
| `hull.crossFlowCd`, `clarkeScale`, `addedMass` | Sway / yaw (Clarke's derivatives, cross-flow drag) and added mass | usually unchanged |
| `engine` | One marine diesel per propulsor: power, rpm, gearbox, inertia, governor, turbo | slow-speed engines: low rpm, big gear ratio, big inertia |
| `propulsors` | `'pod'` (the thrust line steers) or `'shaft'` (a rudder behind the propeller, in its slipstream); KT/KQ open-water curves | IPS pods → shafts and rudders, or azipods (`'pod'`) on a cruise ship |
| `trimTabs`, `windage`, `mooring`, `contact` | Stern lift, superstructure wind load, lines at the berth, grounding and collisions | a cruise ship's windage is huge; its `contact.crashSpeedMs` is small |

**Calibrate** against published numbers the way `tests/physics/v50.test.ts` does: static draft
and trim; top speed at rated rpm (the propeller curves are matched when `leverCommand(1)` reaches
full rpm at top speed — raise `kq0` if it over-revs, lower it if it lugs); the hump and the running
trim for a planing hull; the crash stop, the turning circle at speed and slow, astern speed, and
stability (it rights itself from a heel). `createVesselState()` with a `speedKt` gives you a
steady running state and the lever that holds it. Add the measured table to the header of
`src/physics/hull.ts`.

## Step 2: the model

Build `src/vessels/tug/index.ts` exporting `createTugModel(): AircraftModelHandle`. Loft the hull
from the station table with `src/vessels/hullLoft.ts` (it is generic), then add the deckhouse,
the propellers at `propulsors[i].position` (spun by `vessel.propulsors[i].n`), the rudders or pods
turned by `vessel.propulsors[i].steerDeg` (+ turns the bow to starboard), trim tabs if any
(`vessel.tabs`), and nav lights (`lights.nav`). The helm camera sits at `geometry.pilotEye`.
`AircraftVisualState.vessel` carries everything the model animates; see `src/vessels/v50/` for a
complete one, including the breakup parts the crash uses.

## Step 3: the fleet entry

```ts
const tugConfig: Config = { ...CONFIG, aircraft: TUG_AIRCRAFT, camera: { ...CONFIG.camera, chase: { ...CONFIG.camera.chase, distance: 60, height: 14 } } };
const TUG: AircraftDef = {
  kind: 'vessel',
  id: 'tug',
  name: 'Harbour tug',
  shortName: 'Tug',
  description: 'A 24 m twin-screw harbour tug — slow, stubborn and very strong.',
  config: tugConfig,
  hud: 'marine',
  sound: 'marineDiesel',
  createModel: () => createTugModel(),
};
```

and add `TUG` to `FLEET`. Add it to the README's vessel table (a test checks the README names
every fleet entry).

## Step 4: where it starts

`playerBerth()` in `src/world/port.ts` reserves the visitors' berth in the Port Chateau marina,
sized for the V50 (`BERTH_YACHT`: 15.5 m × 4.1 m, 1.2 m draft). A small boat fits it as it is. A
bigger vessel needs its own dock: add a berth for it (the ferry terminals and the container quay
in `src/world/traffic/sea.ts` are the obvious places for a ship), reserve it so the traffic keeps
out of it, register its structures as obstacles the way `src/world/traffic/harbourObstacles.ts`
does, and choose it from the app by the vessel's size. `seaStart()` works for anything.

## Step 5: tests

- **Physics** (`tests/physics/tug.test.ts`, after `tests/physics/v50.test.ts`, with the helpers
  in `tests/physics/v50-helpers.ts`): the calibration table, plus grounding, a pontoon bump and a
  ram, mooring, determinism and cost.
- **Fuzz** (after `tests/physics/v50-fuzz.test.ts`): random helm scripts in the open sea, on a
  beach and against a pontoon never produce NaN or a wreck that moves.
- **Model** (`tests/vessels/tug/`, after `tests/vessels/v50/`): the lofted hull matches the
  station table to a few centimetres, the propellers sit on the propulsor positions, rudders and
  props move the right way, the helm eye sees ahead, the draw-call budget.

Run `npx vitest run tests/physics tests/vessels tests/fleet tests/repo`, then the whole suite and
`npx tsc --noEmit -p .`. Then drive it: `npm start` and open
`http://127.0.0.1:8092/?aircraft=tug`.
