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

Nothing else needs wiring: the app starts a vessel at the berth for its size (`vesselBerth()` in
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
| `propulsors` | `'pod'` (the thrust line steers) or `'shaft'` (a rudder behind the propeller, in its slipstream); KT/KQ open-water curves; `'jet'` a waterjet (below) | IPS pods → shafts and rudders, or azipods (`'pod'`) on a cruise ship |
| `trimTabs`, `windage`, `mooring`, `contact` | Stern lift, superstructure wind load, lines at the berth, grounding and collisions | a cruise ship's windage is huge; its `contact.crashSpeedMs` is small |

**Calibrate** against published numbers the way `tests/physics/v50.test.ts` does: static draft
and trim; top speed at rated rpm (the propeller curves are matched when `leverCommand(1)` reaches
full rpm at top speed — raise `kq0` if it over-revs, lower it if it lugs); the hump and the running
trim for a planing hull; the crash stop, the turning circle at speed and slow, astern speed, and
stability (it rights itself from a heel). `createVesselState()` with a `speedKt` gives you a
steady running state and the lever that holds it. Add the measured table to the header of
`src/physics/hull.ts`.

### Tunnel thrusters

A ship can have bow and stern **tunnel thrusters**: propulsors with `type: 'thruster'` and a
`thruster: { maxThrustN, fadeKt, ratePerSec }` block (the KT / KQ / foil fields are unused; put
`position` at the tunnel's centre, `diameter` its bore). They push straight across the hull at
their position, driven by the helm's aileron axis (← / →: + turns the bow to starboard, so a bow
thruster pushes to starboard and a stern one to port), fade out with the speed through the water
(`thrusterEffect()` in `src/physics/hull.ts`: full below ~1 kt, nothing from `fadeKt`), follow the
helm at `ratePerSec` (electric, fast) and stop with the engines. On a vessel that has thrusters the
rudders / pods steer from the rudder axis (A / D) only; the helm HUD shows a BOW / STERN thruster
indicator in place of the trim tabs, and the tachs count only the other propulsors. List the shafts
or pods first (the engine readouts use propulsor 0). The MS Tater Star (`makeCruise()`,
`tests/physics/cruise.test.ts`) has six 1.5 MW units, three at each end.

### Waterjets (personal watercraft, jet boats)

The **Sea-Doo RXP-X 325** (id `seadoo`, `makeSeadoo()` at the end of `src/config.ts`, tests
`tests/physics/seadoo*.test.ts`) is the worked example. A waterjet is a propulsor with
`type: 'jet'` and a `jet: WaterjetConfig` block:

- **The pump.** Flow follows the impeller: `Q = pumpFlowPerRev · (n − slipRps)` (nothing much at idle),
  times the intake's immersion (it ventilates off a wave top) and a cavitation factor (the suction head,
  10.3 m + Va²/2g, against `npshAtMaxRpm` × (n / n_max)² — a hard launch spins up before it hooks up).
  The jet leaves at `Vj = Q / nozzleArea`; the pump absorbs `½ ρ Q (Vj² − Va²) / pumpEfficiency`, so
  the engine's torque balance sets the rpm. Set `engine.gearRatio: 1` (direct drive) and leave the
  propeller's `kt0 / kq0` at 0 — they're unused. Calibrate `nozzleArea` and `pumpFlowPerRev` so the
  engine reaches its rated rpm near top speed, then `npshAtMaxRpm` for the launch (0–60 mph).
- **Thrust and steering.** The gross thrust `ρ Q Vj` acts along the nozzle, which the helm swings
  (`maxSteerDeg`; `highSpeedSteerDeg` maps full helm to less nozzle on the plane) and `elevatorTrim`
  tilts (`trimRangeDeg`, the VTS); the inlet swallows `ρ Q Va` (and the water's sideways momentum when
  skidding). No throttle, no flow, no steering — except the off-throttle assist (`otas`).
- **The reverse bucket** (iBR): the lever astern (or the brake, Space) drops it; in the neutral detent it
  sits where the ahead and astern thrusts cancel (`jetNeutralBucket()`). `PropulsorState.jet` carries
  the bucket, trim, flow, jet speed, ventilation and whether the nozzle is clear of the water — what the
  model, the wake (the rooster tail) and the sound read.
- **ECU.** `speedLimitKt` (the GPS limiter) and `ventRpm` (the cut when the pump sucks air).

A small, light, fast hull wants `hull.planingModel: 'strips'` (strip-theory planing instead of
Savitsky's prismatic fit — Savitsky's wetted length jumps with a degree of trim on a 3 m hull and
porpoises it off the water), with `stripDamping` and `stripYawDamping`. A sit-down craft gets a
`rider` (their lean is a moment of their weight; they balance toward the coordinated bank plus the
carve asked for; a hard nose-in spills them; the tether cord stops the engine until they climb back on)
and `righting` (a capsize is rolled back upright by the rider instead of ending as a wreck). The sound
is the `'pwc'` voice (`src/audio/pwc.ts`); the marine HUD labels a jet's helm THROTTLE / NOZZLE / iBR.

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

Every vessel starts moored at a berth chosen by its size (`vesselBerth(def)` in
`src/world/port.ts`, used by the app for R and the menu's "Back to the berth"). Shift+R starts it
underway at `seaStart()`, which is deep enough for anything up to a battleship. There are three
berths (`BerthId`, the limits are `BERTH_LIMITS` in `src/world/harbour/layout.ts`):

| Berth | Where | Takes | Pose |
| --- | --- | --- | --- |
| `'visitor'` | The visitors' pontoon in the Port Chateau marina | up to 20 m × 4.6 m, 2 m draft (the V50, a jet ski) | bow toward the harbour entrance, starboard side to |
| `'cruise'` | The cruise terminal east of the marina (x ≈ −3,420): a 40 m wide berthing pier on piles, 360–735 m out, with the terminal building, two jet bridges and the car park ashore | up to 300 m × 40 m, 9 m draft | along the pier's west face, **port side to**, bow out to sea (heading 175°) |
| `'naval'` | The naval pier west of the marina (x ≈ −5,720): an 800 m trestle and a 340 m T-head with fender camels, a portal crane and a brow | up to 290 m × 36 m, 11.5 m draft | along the T-head's seaward face, **starboard side to**, bow west along the coast (≈ 271°) |

`berthFor(def)` picks the berth: first by fleet id (`BERTH_BY_ID`: `v50` and `seadoo` go to the
visitors' pontoon, `cruise` to the cruise terminal, `iowa` to the naval pier). Otherwise any
vessel with a naval gun battery (`config.weapons.naval`) goes to the naval pier, and anything else
goes to the smallest berth its hull fits (`fitsBerth`, from `vesselSize(config)`: length, beam and
draft measured from the station table, the draft down to the propeller tips). The pose puts the
hull's widest point `face.gap` off the quay face (0.45 m of fenders at the pontoon, 2 m at the
cruise pier, 3 m of camels at the naval pier) and the middle of the hull on the berth's centre.
The V50, which the visitors' pontoon was laid out for, gets `playerBerth()` exactly.

Both ship berths were placed from the heightfield: the piers run out until the largest ship's
whole footprint has `maxDraft + 2 m` of water (`SHIP_UNDER_KEEL`). The water isn't dredged, so the
ground the physics floats on and the seabed the renderer draws stay the same. Traffic routes keep
150 m clear of the piers and of each berth's `reserved` water.

For a big ship:

- **Mooring lines.** `watercraft.mooring` has to hold the ship. Scale the V50's springs by the
  mass ratio (and the yaw springs by mass × length²) and it lies within a metre of its pose without
  touching the pier. `tests/physics/shipBerths.test.ts` does this with 260 m and 270 m stand-ins.
- **When the player isn't driving it**, the ship lies at its berth anyway, but only if its fleet id
  is in `BERTHED_SHIP_IDS` (`src/world/harbour/berthedShips.ts`; `cruise` and `iowa` today). The
  berthed-ships system (`src/game/systems/berthedShips.ts`) builds its model with `createModel()`
  the first time the camera comes within 7 km, and draws a cheap impostor lofted from the station
  table out to 35 km. It floats the model at the static waterline and trim, turns on deck lights at
  night, and registers it as an obstacle: the deck outline at deck height from the stations, plus
  the model's drawn superstructure, rasterised from its triangles. Its clear deck is a *landable
  deck* (`Environment.deckTop`), so the helicopter can land on a helipad. It disappears while the
  player drives that ship. The model's `setVisualState` gets a moored `VesselState` (engines
  stopped, `lights.landing` / `lights.taxi` on at night), so make the model accept that.
- **A new berth.** Add a site to `portWorks()` in `src/world/harbour/layout.ts` (its frame, deck,
  and face from `makeFace`), its primitives to `src/world/harbour/obstacles.ts`, its geometry to
  `models.ts` (tested against the obstacles by `tests/world/harbour/obstacles.test.ts`), its limits
  to `BERTH_LIMITS`, and its id to `BerthId` / `portBerths()` in `src/world/port.ts`.

## The wake and spray (nothing to do — but know what it reads)

The wake is drawn for any vessel from what the physics already knows; there is no per-vessel wake
config. `src/game/systems/playerWake.ts` records the hull's track every 0.1 s — position, heading,
speed through the water, `vessel.planing` and the **propulsors' load** (the mean `load` of every
propulsor that isn't a `'thruster'`, 0 in neutral: how hard the propellers or the jet churn the
water) — and renders it into the **wake map** (`src/world/water/wakeMap.ts`), a texture following
the boat that the sea shader reads. So the wake is part of the sea surface: the same lighting,
reflections and fog as the water around it.

What sets the look, all from `watercraft.hull.stations` (`hullSize()`: stem-to-transom length L,
beam B) and the state:

| Quantity | From | Effect |
| --- | --- | --- |
| `wakeScale(L, B)` | √(L·B) ÷ the V50's | lifetimes (white water, lace, aerated lane, slick, waves) grow with it; a 265 m ship's turquoise propwash lane lasts ~3½ min (≈ 2 km at 20 kt), a jet ski's foam is gone in seconds |
| `wakeMapExtent(L)` | 520 m, 9 L for hulls over ~58 m (≤ 2.6 km) | the map (and the history kept) scale with the hull |
| length Froude number U/√(gL) | speed, L | Kelvin wave height (a crawling ship makes none); at high Fr the visible wedge narrows from 19.5° toward ~0.18/Fr (a planing V50 ≈ 7°, a jet ski ≈ 4°) |
| `planing` | the hull model | the wave source moves aft, quarter waves and the rooster hump rise behind the transom, white water streams off the chines; a displacement hull instead gets a stern-wave system and (big hulls) a breaking bow wave |
| propulsor load | the drives | the churned white propwash and the aeration under it (a boat coasting with the drives in neutral leaves much less) |
| a `'jet'` propulsor | the config | the rooster-tail spray is a tall narrow plume right behind the transom |

The foam itself is drawn per pixel by the sea shader from the map's foam density: a lace between
the domes of upwelling "boils" (animated cellular noise, stretched along the track), solid white
with dark holes when fresh, lace and threads as it decays; aerated water under it glows pale
turquoise; the slick behind flattens the ripples; the wake's steep crests break white. Spray
(bow sheets, quarter-wave droplets, the rooster tail, slams, a big ship's bow wave, mist) is one
point draw, scaled with the hull.

To look at your vessel's wake before its model exists, drive the V50 with
`?wakeHull=<L>,<B>[,jet]` (hulls over 60 m are drawn as displacement hulls), and photograph it
with `node scripts/wake-shots.mjs <outDir> --only chase22,aerial800,shipAerial,ski` (chase, helm,
turn, aerial, golden-hour and dawn views; `--perf` measures uncapped fps). The field's physics
is tested in `tests/world/water/wakeField.test.ts` and `tests/world/water/wakeVessels.test.ts`
(the measured wedge angle, sizes, decay, fuzz over sizes / speeds / turns); the shaders compile in
`tests/world/water/wake.e2e.test.ts`.

## Step 5: tests

- **Physics** (`tests/physics/tug.test.ts`, after `tests/physics/v50.test.ts`, with the helpers
  in `tests/physics/v50-helpers.ts`): the calibration table, plus grounding, a pontoon bump and a
  ram, mooring, determinism and cost. `tests/fleet/vessels.test.ts` moors every fleet vessel at its
  own berth and idles it out; `tests/physics/shipBerths.test.ts` shows how to do the same for a big
  ship at its pier.
- **Fuzz** (after `tests/physics/v50-fuzz.test.ts`): random helm scripts in the open sea, on a
  beach and against a pontoon never produce NaN or a wreck that moves.
- **Model** (`tests/vessels/tug/`, after `tests/vessels/v50/`): the lofted hull matches the
  station table to a few centimetres, the propellers sit on the propulsor positions, rudders and
  props move the right way, the helm eye sees ahead, the draw-call budget.

Run `npx vitest run tests/physics tests/vessels tests/fleet tests/repo`, then the whole suite and
`npx tsc --noEmit -p .`. Then drive it: `npm start` and open
`http://127.0.0.1:8092/?aircraft=tug`.
