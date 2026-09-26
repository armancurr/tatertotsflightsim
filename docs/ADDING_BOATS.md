# Adding boats and ships

The sea, the bay and Tater Lake carry sailing yachts that tack and gybe with the wind, motor
yachts, fishing boats (trawling slowly with their outriggers down), a harbour launch, a
double-ended ferry across the bay, a container ship, a tanker, and a marina full of moored boats
at Port Chateau. This guide shows how to add another boat on a new route, and how to add a new
kind of vessel.

This is the **traffic** — boats that follow routes. To add a boat the player **drives** (physics,
helm, berth), see [ADDING_A_VESSEL.md](ADDING_A_VESSEL.md). The marina's structures (and the moored
traffic boats) are solid for the player's hull: `src/world/traffic/harbourObstacles.ts` builds them
from the same dimensions the model draws.

## How it fits together

| Layer | File | What it does |
| --- | --- | --- |
| Plan (pure) | `src/world/traffic/sea.ts` | The vessel kinds and sizes, the marina layout, every route, route validation, and each vessel's pose at time `t` |
| Paths (pure) | `src/world/traffic/path.ts` | `createPath`, `smoothLoop`, `smoothLine`, `filletPath`: waypoints → an arc-length path with speeds |
| Models | `src/world/traffic/models/vessels.ts` | `buildVesselPart(kind, part, lod)`: procedural hulls, superstructures and sails |
| Wakes (pure) | `src/world/traffic/wake.ts` | Foam trail from the stern plus two Kelvin arms from the bow |
| Wave motion (pure) | `src/world/traffic/buoyancy.ts` | Heave, pitch and roll from the same wave trains the water shader draws |
| Renderer | `src/world/traffic/ships.ts` | `createShips()`: every hull, sail and the marina in **one** `THREE.BatchedMesh`, plus one wake mesh and one point buffer for lights and spray (3 draw calls in total) |
| System | `src/game/systems/ships.ts` | Builds the plan time-sliced, runs the traffic clock, updates the ships every frame |

Everything is deterministic: a vessel's position is a pure function of its route and the
**traffic clock** (`CONFIG.world.traffic.seed`, `startTime`, or `?tt=<seconds>` in the URL for QA
photos). Nothing is simulated step by step, so ships never drift, and a route that validates once
is valid forever.

Frames: world `+X` east, `+Z` south (the sea is south of `z ≈ 7,600`). A vessel model's local
frame is bow `−Z`, starboard `+X`, waterline at `y = 0`.

### The vessel kinds

`VesselKind` in `src/world/traffic/sea.ts`, with sizes in `VESSEL_DIMS` (metres):

| Kind | What | Length | Beam | Draft |
| --- | --- | --- | --- | --- |
| `sail` | Sailing yacht (sails trim, heel and tack with the wind) | 12 | 3.9 | 2.0 |
| `motor` | Motor yacht at planing speed | 18 | 5.0 | 1.3 |
| `fish` | Fishing boat (outriggers down when trawling) | 20 | 6.2 | 2.6 |
| `launch` | Harbour launch | 7.5 | 2.6 | 0.5 |
| `ferry` | Double-ended bay ferry | 92 | 20 | 4.2 |
| `container` | Container ship | 294 | 32.3 | 12 |
| `tanker` | Tanker | 250 | 44 | 14 |

### Routes

Every route is written out by hand in `defineRoutesJob()` in `src/world/traffic/sea.ts`, one block
per kind. A route (`SeaRoute`) is a closed loop (`mode: 'loop'`) or a ferry shuttle
(`mode: 'ferry'`) at a water `level` (0 for the sea, the lake's level for lake boats), with a
speed that can depend on heading (sailing yachts read their speed off a polar table for the wind
angle).

`createSeaPlan()` then **validates** every route (`validateRouteJob()`):

- every 20 m along the path, the water under the bow, stern, centre and both sides must be at
  the route's level and at least `MIN_DEPTH[kind]` deep (a tanker needs 16 m, a launch 0.7 m);
- every route except the launch keeps 120 m from the marina's pontoons and breakwaters;
- no route, the launch included, comes within 25 m of the **visitors' berth** — the berth
  reserved for the player's own boat (`playerBerth()` in `src/world/port.ts`), which the moored
  traffic never fills either.

A route that fails is dropped and its id goes into `plan.rejected`, and the tests require that
list to be empty. They also require that no two routes ever come within 60 m of each other
(`tests/world/traffic/sea.test.ts`, "routes never cross each other").

## Adding another boat on a new route

The worked example adds a fourth motor yacht cruising off the east coast. The motor-yacht block
of `defineRoutesJob()` reads its loops from a list, capped by the count in config:

```ts
// src/world/traffic/sea.ts, in defineRoutesJob()
const motorLoops: XZ[][] = [
  [{ x: -3900, z: 8480 }, { x: -1500, z: 8560 }, { x: -350, z: 8880 }, { x: -1600, z: 9180 }, { x: -4100, z: 8980 }],
  [{ x: -500, z: 10650 }, { x: 2500, z: 10500 }, { x: 5600, z: 10250 }, { x: 4600, z: 11050 }, { x: 1000, z: 11250 }],
  [{ x: -7200, z: 8250 }, { x: -9800, z: 8150 }, { x: -12200, z: 8450 }, { x: -11000, z: 8950 }, { x: -8000, z: 8750 }],
  // new: a loop 2 km off the coast east of the river mouth
  [{ x: 7600, z: 9700 }, { x: 9800, z: 9600 }, { x: 11600, z: 9900 }, { x: 10800, z: 10500 }, { x: 8200, z: 10400 }],
];
```

and in `src/config.ts`, `CONFIG.world.traffic.sea.motorYachts` goes from `3` to `4`. That's all:
the loop is smoothed (`smoothLoop`), given a speed of 17–24 kt and a random size and paint, and
drawn, lit at night and given a wake by the renderer. This change passes every test in
`tests/world/traffic`.

Tips for picking waypoints:

- Stay well clear of the coast (`layout.coast.zAt(x)` gives the shoreline's `z`) and in water
  deep enough for the kind (`MIN_DEPTH`).
- Keep 60 m from every other route. The sailing triangles, the other loops and the ferry's line
  across the bay mouth are all in `defineRoutesJob()`; the east coast beyond `x ≈ 7,000` is quiet.
- Raising a count in config does nothing by itself: each block adds at most as many boats as it
  has spots or loops.
- For a lake, copy the Tater Lake block: it finds the lake with
  `layout.lakes.find((l) => l.name === 'Tater Lake')`, builds ellipses inside it and passes
  `lk.level` as the route level. The tests expect lake route ids to start with `lake`.

## Adding a new kind of vessel

The worked example adds a harbour **tug** (`tug`, 24 m). Every step below was compiled and tested
against the current code.

### 1. The kind, its size, depth and wake

In `src/world/traffic/sea.ts`:

```ts
export type VesselKind = 'sail' | 'motor' | 'fish' | 'launch' | 'ferry' | 'container' | 'tanker' | 'tug';

export const VESSEL_DIMS: Record<VesselKind, VesselDims> = {
  // …
  tug: { length: 24, beam: 9, draft: 3.2, freeboard: 1.6 },
};

const MIN_DEPTH: Record<VesselKind, number> = { /* … */ tug: 4 };

export const WAKE_KIND: Record<VesselKind, { maxAge: number; fullSpeed: number; kelvin: number; foam: number; spray: boolean }> = {
  // …
  tug: { maxAge: 60, fullSpeed: 5, kelvin: 0.45, foam: 0.8, spray: false },
};
```

`WAKE_KIND` sets how long the wake lasts (s), the speed at which it's fully formed (m/s), how
strong the Kelvin arms and the stern foam are, and whether the bow throws spray (planing hulls).
The compiler then points at the remaining tables.

### 2. The model

In `src/world/traffic/models/vessels.ts`, write a builder. `buildHull()` lofts a hull from a
`HullSpec` (length `L`, beam `B`, freeboard `F`, depth `D`, sheer, transom, bow fineness, section
shape `n`, stem rake, and materials for the topside, boot stripe, antifouling, deck and rub
rail). `MeshBuilder` (`models/builder.ts`) adds boxes, prisms, cylinders and lofts. Materials
come from the palette at the top of the file (`mat(hex, roughness, metalness, tint)`); `WHITE_T`
is tinted per boat by `HULL_TINTS`. Build two levels of detail (`lod` 0 near, 1 far) with the far
one under 70 % of the triangles.

```ts
function tug(b: MeshBuilder, lod: number): void {
  buildHull(b, {
    L: 24, B: 9, F: 1.6, D: 2.4, sheer: 0.35, transom: 0.75, transomDepth: 0.6, entry: 1.8, n: 2.6, rake: 1.0,
    topside: WHITE_T, boot: BLACK, bottom: ANTIFOUL_RED, deck: DECK_GREY, rub: mat(0x1a1a1a, 0.6), bootTop: 0.3, stations: lod ? 8 : 16,
  });
  b.box(0, 2.9, -2.5, 6.5, 2.6, 8, WHITE); // deckhouse
  b.box(0, 5.0, -4.5, 5.2, 1.6, 3.6, WHITE); // wheelhouse
  b.box(0, 5.1, -6.35, 4.8, 0.7, 0.08, GLASS); // wheelhouse windows
  b.cylinder([0, 4.2, 0.5], [0, 7.2, 0.5], 0.55, 0.5, lod ? 6 : 12, BLACK); // funnel
  if (!lod) b.box(0, 2.0, 7.5, 1.2, 0.8, 1.2, ORANGE); // towing bitt
}
```

Add its case to the `switch` in `buildVesselPart()` and its paint colours to `HULL_TINTS`:

```ts
    case 'tug':
      tug(b, lod);
      break;
```

```ts
export const HULL_TINTS: Record<VesselKind, number[]> = {
  // …
  tug: [0xc23a1c, 0x1d3a6b],
};
```

### 3. Its route

Add a block to `defineRoutesJob()` in `src/world/traffic/sea.ts`, with a count in
`CONFIG.world.traffic.sea` (`tugs: 1`):

```ts
  // ── Harbour tug: a slow loop off the east coast ──
  if (tc.sea.tugs > 0) {
    const pts = [{ x: 9100, z: 9000 }, { x: 9800, z: 8950 }, { x: 10100, z: 9350 }, { x: 9600, z: 9700 }, { x: 9000, z: 9500 }];
    loop('tug-0', 'tug', smoothLoop(pts, 16), 0, kt(8));
    yield;
  }
```

`loop(id, kind, points, level, speed, opts)` is the block helper: `speed` is in m/s (`kt()`
converts knots) or a function of heading and position. Each block ends with `yield` so the plan
builds a little per frame.

### 4. Optional

- **Lights.** `LAMPS` in `src/world/traffic/ships.ts` places navigation, masthead and deck lights
  per kind for dusk and dawn. A kind without an entry simply has no lights.
- **View distance.** `isShip()` in `ships.ts` gives the ferry, container ship and tanker the long
  `shipViewDistance` (42 km); small craft vanish beyond `viewDistance` (7 km).
- **Moored in the marina.** Berths are filled by `createMarina()` in `sea.ts`, with the kinds
  `sail`, `motor`, `launch` and `fish`.

### 5. Tests

- `tests/world/traffic/models.test.ts`: add `['tug', 'hull']` to the parts list and `'tug'` to
  the proportions test. They check finite geometry, outward winding, the triangle budget, that the
  hull is 0.95–1.12 × the `VESSEL_DIMS` length, sits in the water and reaches its freeboard, and
  that LOD 1 is lighter. The tug above passes them.
- `tests/world/traffic/sea.test.ts`: "every route validates" (nothing rejected) and "routes never
  cross each other" cover the new route automatically; the fuzz tests there check poses and the
  distance travelled for every route.
- `tests/world/traffic/ships.test.ts`: the renderer stays at 3 draw calls and soaks for 20
  simulated minutes.

### 6. Look at it

A vessel's position at any time comes from `vesselTrack()`, so a screenshot can aim straight at
it. With the dev server running (`npm start`), pause the traffic clock with `pause=1&tt=0` and
use the QA camera (`sim.combatDebug.look(x, y, z, targetX, targetY, targetZ, fov)`):

```sh
node scripts/shot.mjs "http://127.0.0.1:8092/?veil=0&pause=1&tt=0&spawn=9500,8000,1500,0,120" qa/tmp/tug.png \
  --wait 15000 --eval-after-ms 2500 \
  --eval "const sea = await import('/src/world/traffic/sea.ts'); const { getLayout } = await import('/src/world/layout.ts');
          const r = sea.createSeaPlan(getLayout(), null).routes.find((q) => q.id === 'tug-0');
          const o = { x: 0, z: 0, course: 0, speed: 0, travelled: 0 }; sea.vesselTrack(r, 0, o);
          sim.combatDebug.look(o.x + 40, 14, o.z + 30, o.x, 2, o.z, 40); return o"
```

Check it at every time of day (`&tod=0` to `3`): the paint under the HDR lighting, the lights at
dawn, the wake from above.

## Other traffic

Aircraft traffic (Cessnas and Pipers flying circuits on runway 36, light aircraft crossing the
area, airliners with contrails at cruise height, and a helicopter over Port Chateau) lives in
`src/world/traffic/air.ts` (pure tracks), `airSim.ts` and `airTraffic.ts` (the renderer), with the
system `src/game/systems/airTraffic.ts` and the counts in `CONFIG.world.traffic.air`. It follows
the same pattern: pure, deterministic paths plus a batched renderer.
