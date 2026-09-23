# Adding vehicles and targets

The world has three kinds of vehicles, each with its own code:

| What | Where | Example |
| --- | --- | --- |
| **Ground targets**: armour and trucks at the range, shot with the gun and Mavericks | `src/combat/targets/`, system `targets` | T-72B, BMP-2, BTR-80, Ural-4320, ZSU-23-4 |
| **Aircraft targets**: enemy aircraft that fly, evade and are shot down | `src/combat/air/`, system `airTargets` | MiG-29, Su-25, Mi-24 |
| **Road traffic**: cars and trucks driving and parked on the road network | `src/world/cars/`, system `cars` | sedan, SUV, pickup, bus, semi, farm tractor |

Boats and ships are in [ADDING_BOATS.md](ADDING_BOATS.md). The airport's own vehicles (ARFF
trucks, refuelers, tugs, the patrolling pickup) are covered at the end.

Everything is procedural: models are built from boxes, cylinders and extruded profiles in code,
with vertex colours instead of textures. Real vehicles are the reference: use real dimensions and
check the result against photos.

## How targets work

All targets live in one **combat world** per scene: `combatWorld(scene)` in
`src/combat/world.ts`. It is plain data and pure maths, with no three.js, so it's easy to test.

- **One target type.** Every target, on the ground or in the air, is a `GroundTarget`
  (`src/combat/types.ts`): `id`, `kind: TargetKind`, `position`, `headingDeg`, `velocity`,
  `health`, `maxHealth`, `alive`, `destroyedAt`, `group`, and `orientation` (aircraft only).
  `TargetKind = GroundKind | AirKind`, where `GroundKind = 'tank' | 'ifv' | 'apc' | 'truck' | 'aaa'`
  and `AirKind = 'fighter' | 'attack' | 'helo'`.
- **Classes in config.** `CONFIG.combat.targets` has one `TargetClassConfig` per kind: `name`
  (shown in the HUD and the kill message), hull box `length` × `width` × `height` in metres,
  `health`, `armor` and `speed`. Aircraft classes also set `air: true`.
- **Hit box.** A ground vehicle's box stands on the ground: `position` is the centre of its
  footprint, and the box spans `±width/2`, `0…height`, `±length/2` with `−Z` the front. An
  aircraft's box is centred on `position` and turned by `orientation`.
- **Armour by aspect.** `armor: { front, side, rear, top }` are **damage multipliers** for gun
  hits on each face (1 = no armour; the T-72B's front is 0.05). `effectiveDamage()` in
  `src/combat/damage.ts` applies them; a hit on the bottom uses the side value. Missiles ignore
  armour.
- **The API.** `world.addTarget(t: NewTarget)`, `world.raycast(from, to)` (the first hull a round's
  path crosses, and which face), `world.applyHit(id, hit)`, `world.applyBlast(centre, radius,
  damage, weapon, time)`, `world.targetsInCone(...)` (what <kbd>T</kbd> can lock),
  `world.classOf(kind)`, `world.isAir(t)`, `world.centreOf(t)`, `world.toBody(t, d)`, and
  `world.on(listener)` for events (`hit`, `destroyed`, `impact`, `missileLaunch`, `detonation`,
  `lock`, `lockLost`, `gunStart`, `gunStop`, `reload`).

The weapons, missiles, HUD, kill messages and effects all go through `classOf(kind)`. A new
class gets hit boxes, armour, locking, HUD names and kill messages for free; you add its model
and decide where it stands.

## Adding a ground target class

The worked example adds a **BRDM-2** armoured scout car as the kind `scout`: 5.75 m long, 2.35 m
wide, 2.31 m tall, four wheels and a small turret.

### 1. The kind and its class

In `src/combat/types.ts`, add the kind:

```ts
export type GroundKind = 'tank' | 'ifv' | 'apc' | 'truck' | 'aaa' | 'scout';
```

In `src/config.ts`, add its class under `CONFIG.combat.targets`, next to the others:

```ts
scout: { name: 'BRDM-2', length: 5.75, width: 2.35, height: 2.31, health: 40, armor: { front: 0.8, side: 1, rear: 1, top: 1 }, speed: 12 } as TargetClassConfig,
```

`health` is in damage units. For scale, a 30 mm GAU-8 round does 10 before armour (`A10_WEAPONS`)
and a Maverick 400.

### 2. The model

Models are in `src/combat/targets/models.ts`. Each class has a builder `(lod: Lod) => ClassModel`
that returns a `hull` geometry, an optional `turret` geometry (its origin at the turret ring),
the `ring` position on the hull and the turret's `turretCg` (used when a turret is blown off).
There are three levels of detail: `0` near, `1` mid, `2` far; the far one must have under 35 %
of the near one's triangles (a test checks), so keep small details for `lod === 0`. The file's
`Parts` helper merges boxes, cylinders (`cylX`, `cylY`, `barrel`), tapered blocks (`frustum`) and extruded side
profiles (`prism`) into one geometry with vertex colours from `PAINT`. Wrap wheels, tracks and
radar dishes in `tagged(PART.wheel | PART.track | PART.dish, …)` and the shader animates them.

```ts
function brdm2(lod: Lod): ClassModel {
  const H = new Parts();
  const T = new Parts();
  const G = PAINT.green;
  const seg = lod === 0 ? 16 : lod === 1 ? 10 : 6;
  // boat-shaped hull: a side profile (z, y) extruded across the width
  H.prism([[-2.87, 0.9], [-2.4, 0.45], [2.5, 0.45], [2.87, 0.95], [2.8, 1.75], [-1.6, 1.8], [-2.87, 1.3]], 2.2, G);
  H.frustum(2.35, 4.6, 2.0, 3.6, 0.35, G, 0, 1.45, 0.2);
  for (const sx of [-1, 1]) for (const z of [-1.5, 1.6]) {
    // tagged wheels turn with the vehicle's odometer (shader)
    H.tagged(PART.wheel, 0.5, z, 0.5, () => {
      H.cylX(0.5, 0.32, PAINT.rubber, sx * 1.02, 0.5, z, seg);
      if (lod === 0) H.cylX(0.26, 0.34, PAINT.greenDark, sx * 1.03, 0.5, z, 10); // hubs
    });
  }
  if (lod === 0) {
    for (const sx of [-1, 1]) H.box(0.3, 0.25, 0.08, PAINT.glass, sx * 0.5, 1.6, -2.3, -0.5, 0, 0); // vision blocks
    H.box(1.6, 0.04, 1.2, PAINT.greenDark, 0, 1.81, 1.6); // engine grille
  }
  // the small conical BPU-1 turret with its 14.5 mm KPVT
  T.add(new THREE.CylinderGeometry(0.4, 0.55, 0.45, seg), G, 0, 0.22, 0);
  T.barrel(0.05, 0.04, 1.4, G, 0, 0.25, -0.45, lod === 2 ? 5 : 8);
  return { hull: H.merge(), turret: T.merge(), ring: { y: 1.8, z: 0.1 }, turretCg: 0.2 };
}
```

Then register it next to the others in `models.ts`:

```ts
const BUILDERS: Record<TargetKind, (lod: Lod) => ClassModel> = { tank: t72, ifv: bmp2, apc: btr80, truck: ural, aaa: zsu, scout: brdm2 };
export const TARGET_KINDS: readonly TargetKind[] = ['tank', 'ifv', 'apc', 'truck', 'aaa', 'scout'];
```

Add the turret ring to `RINGS` in `src/combat/targets/renderer.ts` (`{ y: 0, z: 0 }` for a
vehicle without a turret, like the truck), and say whether it runs on tracks in `TRACKED` in
`src/combat/targets/convoy.ts` (it sets the convoy's turn rate):

```ts
scout: { y: 1.8, z: 0.1 },          // RINGS, renderer.ts
scout: false,                       // TRACKED, convoy.ts (the BRDM-2 has wheels)
```

The compiler lists every table that still lacks the new kind (`BUILDERS`, `RINGS`, `TRACKED` and
the config). `TARGET_KINDS` it can't check: the renderer only builds meshes for the kinds listed
there, so a missing kind would have a hit box but be invisible.

### 3. Where it stands

The range layout is planned by `planRange()` in `src/combat/targets/plan.ts`. It's pure, runs in
a web worker (`layout.worker.ts`) and places four groups (`VehicleGroup`):

- `convoy`: the kinds in `CONFIG.combat.range.convoy.kinds`, in order, driving the farm lane;
- `platoon`: `platoon.count` tanks behind earth berms;
- `aaa`: `aaa.count` Shilkas in revetments;
- `logistics`: the kinds in `CONFIG.combat.range.logistics.kinds`, parked in rows.

The simplest way in is to put `'scout'` in one of those lists. Here it replaces the BTR-80 that
leads the convoy (the column's length is sized to its lane, and the range tests expect 20–26
vehicles within the range radius, so swap rather than add):

```ts
kinds: ['scout', 'tank', 'tank', 'ifv', 'tank', 'ifv', 'ifv', 'truck', 'truck', 'apc'] as ('tank' | 'ifv' | 'apc' | 'truck' | 'aaa' | 'scout')[],
```

(The two lists are typed with an inline union; extend it as shown.) For a new kind of site, such as
a SAM battery, add a group to `VehicleGroup`, place it in `planRange` with the `placeLine` /
`placeSingles` helpers so it respects `footprintOk()` in `src/combat/targets/ground.ts` (dry,
gentle, open ground; nothing overhead; out of the keep-out zones such as roads), and give it a turret behaviour in `src/combat/targets/runtime.ts`.

### 4. Optional polish

These have sensible defaults, so check them rather than assuming:

- **Explosions.** `KINDS` in `src/combat/fx/sim.ts` and `CONFIG.fx.combat.destroyed.size` /
  `secondaryChance` size the kill fireball and the chance of secondary explosions. Unknown kinds
  explode like a tank.
- **Wreck behaviour.** `src/combat/targets/runtime.ts` has a few kind-specific rules: trucks settle
  more and burn bigger, only tanks can lose their turret, trucks don't slew a turret.
- **Sound.** `src/game/systems/audio.ts` scales the kill explosion by kind.

### 5. Tests

- `tests/combat/targets/runtime.test.ts` builds **every** kind in `TARGET_KINDS` at every LOD and
  checks the hull matches the config size, the far LOD is cheap and the near one stays under 12k
  triangles. It also caps the renderer at 30 meshes: check it still passes.
- `tests/combat/targets/convoy.test.ts` (a fast-check property: the column never overlaps and
  never leaves its lane, whatever happens) sizes its test lanes from the convoy list.
- `tests/combat/targets/range.functional.test.ts` plans the real range and checks what gets
  placed; add your kind to its expected list if you placed it.
- `tests/combat/world.test.ts` has the armour-by-aspect tests ("armour by aspect"); add a case
  if your armour is unusual.
- Fuzz: `tests/combat/targets/plan.test.ts`, `site.test.ts` and `convoy.test.ts` hold the
  fast-check properties to extend if you change placement or driving.

The whole example above (kind, class, model, tables and the convoy swap) passes
`npx tsc --noEmit -p .` and every test in `tests/combat`.

Then look at it in the game. `?aircraft=a10&spawn=range&pause=1` starts you at the range, and
`window.sim.combatDebug` helps: `convoy()` lists the column, `look(x, y, z, tx, ty, tz)` parks a
QA camera, `kill(id)` and `killAll(kind)` test the wrecks. With `scripts/shot.mjs`:

```sh
node scripts/shot.mjs "http://127.0.0.1:8092/?veil=0&aircraft=a10&spawn=range&pause=1&no=airTargets" qa/tmp/scout.png \
  --wait 15000 --eval-after-ms 1500 \
  --eval "const t = sim.combat.list().find((v) => v.kind === 'scout'); sim.combatDebug.look(t.x + 9, t.y + 4, t.z + 7, t.x, t.y + 1, t.z); return t"
```

## Adding an enemy aircraft

Enemy aircraft are the same `GroundTarget`s with `air: true` classes. The pure squadron in
`src/combat/air/squadron.ts` creates them from a plan, registers them with the combat world,
flies them every step, makes them break and pop flares when threatened, and plays the
shoot-down. `src/combat/air/renderer.ts` draws them; `src/game/systems/airTargets.ts` connects
the two. They never shoot back.

| File | What it holds for each `AirKind` |
| --- | --- |
| `src/combat/types.ts` | the `AirKind` union |
| `src/config.ts` | `CONFIG.combat.targets.<kind>` (with `air: true`) and `CONFIG.combat.air.flight.<kind>`: cruise/min/max speed, g, bank, roll rate, climb and dive limits, minimum height, `heloPitch` |
| `src/combat/air/plan.ts` | `planAir()`: where each pair flies (the MiG-29 patrols, the Su-25 attack passes, the Mi-24 orbit) as `SlotPlan`s, driven by `CONFIG.combat.air.caps`, `.attack` and `.helo` |
| `src/combat/air/models.ts` | the builder (`buildFighter`, `buildAttack`, `buildHelo`), its case in `buildAirModel()`, and `airFixtures()` (nav lights, beacons, nozzles, rotors, flare origin) |
| `src/combat/air/renderer.ts` | `KINDS`, `PARTS`, `SCHEME`, `PALETTES` (and the size of the `uPal` palette array in the shader) |
| `src/combat/air/wreck.ts` | `PART_PIVOT` and `REST_HEIGHT` for the fall and the wreck |

To add, say, a Su-27 as `interceptor`:

1. Add `'interceptor'` to `AirKind`, a class in `CONFIG.combat.targets` with `air: true`, and a
   flight spec in `CONFIG.combat.air.flight` (start from `fighter`). The compiler then points you
   at `PARTS`, `SCHEME`, `PART_PIVOT` and `REST_HEIGHT`.
2. Write its model builder in `src/combat/air/models.ts` (the parts are `body`, `wingL`, `wingR`,
   `tail`, plus `tailRotor` and `blades` for helicopters: the wings and tail come off in a
   shoot-down), and route the kind to it in `buildAirModel()` and `airFixtures()`. Both fall back
   to the helicopter for unknown kinds, so the compiler won't catch a miss there.
3. Add it to `KINDS` in `src/combat/air/renderer.ts` with a palette.
4. Give it somewhere to fly: a new block in `planAir()` with its own config section, or reuse a
   pattern.
5. Tests: `tests/combat/air/squadron.test.ts` counts the aircraft (it expects exactly 8 today)
   and checks flight, evasion and shoot-downs; `tests/combat/air/flight.test.ts` holds the flight
   envelope (coordinated turns, bank, roll-rate, speed and climb limits);
   `tests/combat/air/functional.test.ts` flies whole engagements.

`window.sim.airTargets` helps while you work: `list()`, `kill(id)`, `threat(id)` and
`watch(id)` (a chase camera on one aircraft).

**Keep it arcade.** The player's Sidewinders (`AIM9M` in `src/config.ts`, carried as
`weapons.airMissiles`) fly the scripted path in `src/combat/missile.ts`, and the enemy's flares
are a visual reaction, not a seeker model. Don't add guidance laws or seeker simulations.

## Adding a road vehicle type

Road traffic is a pure simulation (`src/world/cars/sim.ts`, an intelligent-driver model in
`idm.ts` on the lane graph from `lanes.ts`) drawn by `src/world/cars/index.ts`. Vehicle types are
numbered: `VT = { sedan: 0, hatch: 1, suv: 2, pickup: 3, van: 4, box: 5, semi: 6, bus: 7,
tractor: 8 }` in `src/world/cars/specs.ts`, with model id `MODEL_TRAILER = 9` for the semi's
trailer and `MODEL_COUNT = 10`.

To add a type (say a delivery `panel` van, id 9):

1. **`src/world/cars/specs.ts`**: add `panel: 9` to `VT`, move `MODEL_TRAILER` to 10 and
   `MODEL_COUNT` to 11, add `'panel van'` to `TYPE_NAMES` and a `VehicleSpec` row to `SPECS`
   (`length`, `width`, `height`, `wheelbase`, `frontOverhang`, `wheelR`, `wheelRRear`, `accel`,
   `decel`, `vmax`; real dimensions).
2. **`src/world/cars/vehicles.ts`**: the near model. Either add a body profile case to
   `carProfile()` or a builder called from `buildVehicleGeometry()` (see `boxTruck`, `bus`), and
   a case in `lampAnchors()` for the head- and tail-lights. The model frame: `+X` right, `+Y` up,
   `−Z` the front, origin on the ground midway between the axles.
3. **`src/world/cars/farcar.ts`**: a `FAR_SHAPES` case, the simple shape drawn far away.
4. **`src/world/cars/paint.ts`**: `paintFor()` if it needs its own colours (fleet white, say).
5. **Where it drives**: add a weight column to every row of `MIX` in `src/world/cars/sim.ts`
   (one row per road kind: highway, road, access, lane, street, drive), and to `PARK_MIX` in
   `src/world/cars/parking.ts` if it parks at the kerb. `admissible()` and `routeWeight()` in
   `sim.ts` hold rules like "semis only on highways".
6. **`src/preview/cars.ts`** hard-codes the trailer's model id; update it.

`CONFIG.world.cars` holds the traffic density per road kind, the number of moving and parked cars,
view distances and the IDM parameters. The tests in `tests/world/cars/` loop over every model id:
`vehicles.test.ts` checks each model's triangle budget, real dimensions, wheels and lamps, and
`traffic.functional.test.ts` and `traffic.stress.test.ts` run the traffic for minutes checking
nobody overlaps or gets stuck. `preview/cars.html` shows every model side by side.

## Airport vehicles

The airport's parked and service vehicles are static decoration, merged into the airport mesh:

- `src/world/airport/fleet.ts`: `ExtraVehicle` (`kingair`, `helicopter`, `arff`, `fueltruck`,
  `tug`, `baggage`, `pickup`), sizes in `EXTRA_VEHICLE_SIZE`, builders in its `BUILDERS` table,
  and variants in `EXTRA_VEHICLE_VARIANTS`.
- `src/world/airport/field.ts`: where each one stands (the ramp, the ARFF station, the fuel farm).
- `src/world/airport/vehicles.ts`: the car-park sedans and SUVs.

`tests/world/airport/fleet.test.ts` runs over every `EXTRA_VEHICLE_KINDS` entry, and
`tests/world/airport/crossing.test.ts` checks nothing stands on a runway or taxiway.
