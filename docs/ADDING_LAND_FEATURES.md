# Adding land features

<!-- examples: src/game/systems/lighthouse.ts tests/game/lighthouse.test.ts -->

This guide explains how the world is built and how to add to it: a landmark, a new world system,
a town, a road, water, or a runway. The worked example, a lighthouse on Seal Rock, was compiled,
tested and photographed in the game. Everything else is described with the files and tests you'll
touch.

## How the world is built

The world is generated from `CONFIG.world.seed` (17221) every time the page loads, the same way
every time. It's built in layers. The first four are **pure** (no three.js, no DOM), so they run
the same in Node, in the tests and in the web workers:

| Layer | File | What it decides |
| --- | --- | --- |
| Regional shape | `src/world/regional.ts` | The coastline (`coastZ(x)`), the bay, the islands (Gull Island, Seal Rock, Long Key), rolling hills and the mountain range in the north |
| Layout | `src/world/layout.ts` | `createLayout()` / `getLayout()` → `WorldLayout`: the airport, lakes, the river, 26 towns, the road network's main roads and the bridges |
| Height | `src/world/heightfield.ts` | `terrainHeight(x, z)`: the regional shape, plus river valleys and channels, lake basins, road beds, and the airport plateau, exactly flat at 30 m |
| Ground cover | `src/world/landcover.ts`, `src/world/fields.ts` | What covers each point (forest, field, grass, rock, snow, sand, urban, water), the surface type the physics feels, tree density, and the farm-field pattern (shared bit-for-bit with the terrain shader through `FIELD_GLSL`) |
| Physics view | `src/world/environment.ts` | `WorldEnvironment`: ground height and normal, surface, water level, and `obstacleTop()` from every registered obstacle source |
| Drawing | `src/world/terrain`, `water`, `roads`, `towns`, `vegetation`, `grass`, `airport`, `cars`, `traffic` | Renderers. The heavy ones build in web workers (`*.worker.ts`), which call `getLayout()` and `getHeightfield()` themselves |
| Systems | `src/game/systems/*.ts` | One plug-in per feature: creates the renderer, adds it to the scene, updates it every frame |

Two rules hold everything together:

- **What you see is what you hit.** The renderers and the physics read the same pure functions.
  Anything solid that sticks up (buildings, trees, the tower, hangars) registers an **obstacle
  source** with `ctx.env.registerObstacleSource((x, z) => topHeightOrMinusInfinity)`, and flying
  into it is a crash.
- **Protected ground.** `tests/world/protected.test.ts` samples the height, landcover, surface and
  tree density within 1.5 km of every town, road, the river, the lakes and the airport, and
  compares them with a stored snapshot. Other modules (towns, roads, the airport, the range)
  are built on that ground, so it must not move by accident.

Frames and units: metres, `+X` east, `+Y` up, `+Z` **south**. Runway 36/18 is centred at (0, 0),
the sea is to the south (the coast runs at `z ≈ 7,600–7,900`), the mountains are 12–31 km north.

## The systems layer

Every feature is a **system**: one file in `src/game/systems/` that default-exports a
`SystemModule`:

```ts
export interface SystemModule {
  name: string;   // unique; used by ?no=<name> and window.sim.debug()
  order: number;  // update order: world 10–40, scenery 50–70, fx/audio 80–90, HUD 100
  create(ctx: SystemContext): SimSystem | Promise<SimSystem>;
}
```

`src/game/systems/index.ts` finds every file in the folder (`import.meta.glob`), creates them in
`order` and calls their hooks. **No wiring file to edit.** `SystemContext` (in
`src/game/systems/types.ts`) gives you `renderer`, `scene`, `camera`, `env`, `hudRoot`,
`aircraft`, `atmosphere` and `actions`. Every hook on `SimSystem` is optional: `ready(camera)`
(awaited before the first frame, with a timeout), `update(frame)`, `postRender(frame)`,
`adjustControls`, `cameraShake`, `readings`, `onAction`, `onReset`, `onAircraftChange`,
`onResize`, `stats`, `dispose`.

A system that throws is caught and logged, and the rest keep running. `?no=<name>` switches a
system off (for profiling, or to check a bug is yours), and `window.sim.perf.systems` shows each
system's CPU time per frame.

The world systems today, in order: `terrain` (10), `water` (20), `airport` (30), `roads` (40),
`ships` (44), `cars` (45), `airTraffic` (46), `towns` (50), `vegetation` (60), `grass` (61).

## Worked example: a lighthouse on Seal Rock

A landmark that's visible from the coast, solid to the physics, and flashes at night. One new
file, `src/game/systems/lighthouse.ts`:

```ts
/** A lighthouse on Seal Rock: a landmark you can see from the coast and hit, its lamp flashing at night. */
import * as THREE from 'three';
import { getLayout } from '../../world/layout';
import { terrainHeight } from '../../world/heightfield';
import { nightFactor, sunElevationDeg } from '../../world/traffic/daylight';
import type { SystemModule } from './types';

const TOWER_H = 24;
const RADIUS = 2.6;

const mod: SystemModule = {
  name: 'lighthouse',
  order: 52,
  create(ctx) {
    const rock = getLayout().islands.find((i) => i.name === 'Seal Rock')!;
    const base = terrainHeight(rock.x, rock.z);
    const group = new THREE.Group();
    group.name = 'lighthouse';
    group.position.set(rock.x, base, rock.z);

    const white = new THREE.MeshStandardMaterial({ color: 0xe8e6e0, roughness: 0.7 });
    const red = new THREE.MeshStandardMaterial({ color: 0x8a1c14, roughness: 0.6 });
    const lamp = new THREE.MeshStandardMaterial({ color: 0x303030, emissive: 0xfff0c0, emissiveIntensity: 0 });
    const geos: THREE.BufferGeometry[] = [];
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, y: number) => {
      geos.push(geo);
      const m = new THREE.Mesh(geo, mat);
      m.position.y = y;
      m.castShadow = true;
      m.receiveShadow = true;
      group.add(m);
    };
    add(new THREE.CylinderGeometry(RADIUS * 0.7, RADIUS, TOWER_H, 24), white, TOWER_H / 2);
    add(new THREE.CylinderGeometry(RADIUS * 0.86, RADIUS * 0.9, 4, 24), red, TOWER_H * 0.55);
    add(new THREE.CylinderGeometry(1.3, 1.3, 2.2, 16), lamp, TOWER_H + 1.1);
    add(new THREE.ConeGeometry(1.7, 1.6, 16), red, TOWER_H + 3);
    ctx.scene.add(group);

    // What you see is what you hit: the tower is an obstacle for the physics.
    const top = base + TOWER_H + 3.8;
    ctx.env.registerObstacleSource((x, z) => (Math.hypot(x - rock.x, z - rock.z) <= RADIUS ? top : -Infinity));

    return {
      update(f) {
        const night = nightFactor(sunElevationDeg(ctx.atmosphere.sunDirection.y));
        const flash = Math.sin(f.time * Math.PI * 0.4) > 0.8 ? 1 : 0; // one flash every 5 s
        lamp.emissiveIntensity = 60 * night * flash;
      },
      stats: () => ({ lamp: lamp.emissiveIntensity }),
      dispose() {
        ctx.scene.remove(group);
        for (const g of geos) g.dispose();
        for (const m of [white, red, lamp]) m.dispose();
      },
    };
  },
};
export default mod;
```

Notes on the choices:

- **Position from the layout, height from the heightfield.** Never hard-code a height: ask
  `terrainHeight(x, z)`. Named places come from `getLayout()` (`islands`, `towns`, `lakes`,
  `rivers`, `roads`, `airport`).
- **`MeshStandardMaterial`** gets the global aerial perspective and moving cloud shadows through
  `fog: true` (its default). A custom `ShaderMaterial` must call `ensureAtmosphericFogUniforms`
  from `src/render/fog.ts`. Lighting is HDR with an exposure of about 2.2, so judge colours on
  screenshots, not hex values.
- **Night.** `nightFactor(sunElevationDeg(...))` from `src/world/traffic/daylight.ts` is 0 in
  daylight and 1 once the sun is 2° below the horizon; the dawn preset (`?tod=3`) gives about 0.7.
- **The obstacle** is a cylinder as tall as the tower; flying into it is a crash.
- **Cheap.** Four meshes. Anything repeated (a row of pylons, a wind farm) should be one
  `InstancedMesh` or merged geometry; heavy generation belongs in a worker or time-sliced over
  frames, and hot paths must not allocate per frame.

The test, `tests/game/lighthouse.test.ts`, runs in Node with a fake context:

```ts
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import lighthouse from '../../src/game/systems/lighthouse';
import type { SystemContext, SystemFrame } from '../../src/game/systems/types';
import type { ObstacleSource } from '../../src/world/environment';
import { getLayout } from '../../src/world/layout';
import { terrainHeight } from '../../src/world/heightfield';

function fakeContext(sunY: number) {
  const sources: ObstacleSource[] = [];
  const ctx = {
    scene: new THREE.Scene(),
    env: { registerObstacleSource: (fn: ObstacleSource) => sources.push(fn) },
    atmosphere: { sunDirection: new THREE.Vector3(0, sunY, Math.sqrt(1 - sunY * sunY)) },
  } as unknown as SystemContext;
  return { ctx, sources };
}

describe('lighthouse system', () => {
  const rock = getLayout().islands.find((i) => i.name === 'Seal Rock')!;

  it('stands on Seal Rock and is an obstacle there, nowhere else', async () => {
    const { ctx, sources } = fakeContext(0.8);
    const sys = await lighthouse.create(ctx);
    expect(ctx.scene.getObjectByName('lighthouse')).toBeTruthy();
    expect(sources).toHaveLength(1);
    expect(sources[0](rock.x, rock.z)).toBeGreaterThan(terrainHeight(rock.x, rock.z) + 20);
    expect(sources[0](rock.x + 50, rock.z)).toBe(-Infinity);
    sys.dispose?.();
    expect(ctx.scene.getObjectByName('lighthouse')).toBeUndefined();
  });

  it('the lamp is dark by day and flashes at night', async () => {
    for (const [sunY, lit] of [[0.8, false], [-0.2, true]] as const) {
      const { ctx } = fakeContext(sunY);
      const sys = await lighthouse.create(ctx);
      let max = 0;
      for (let t = 0; t < 10; t += 0.1) {
        sys.update?.({ time: t } as SystemFrame);
        max = Math.max(max, Number(sys.stats?.().lamp));
      }
      expect(max > 0).toBe(lit);
      sys.dispose?.();
    }
  });
});
```

Then look at it: start the dev server and point the QA camera at it (the range's
`sim.combatDebug.look(x, y, z, targetX, targetY, targetZ, fov)` works anywhere in the world):

```sh
node scripts/shot.mjs "http://127.0.0.1:8092/?veil=0&pause=1&tod=3&spawn=7800,9000,1500,180,120" qa/tmp/lighthouse.png \
  --wait 15000 --eval-after-ms 1000 \
  --eval "const { getLayout } = await import('/src/world/layout.ts'); const { terrainHeight } = await import('/src/world/heightfield.ts');
          const r = getLayout().islands.find((i) => i.name === 'Seal Rock'); const y = terrainHeight(r.x, r.z);
          sim.combatDebug.look(r.x - 60, y + 20, r.z - 70, r.x, y + 14, r.z, 40); return sim.debug().systems.lighthouse"
```

Fly past it too (`?spawn=7000,9500,500,90,110`), at every time of day, and check
`window.sim.perf.systems.lighthouse` stays tiny.

## Adding a town

Towns are declared in code in `createLayout()` (`src/world/layout.ts`), not in config:

```ts
addTown('Taterville', 'town', 2100, 2100, 850, 0.75);
addTown('Millbrook', 'village', -7400, -1600, 320, 0.55);
```

A `Town` is `{ name, kind, x, z, radius, density, gridAngleDeg, blockSize }` with `kind` one of
`'city' | 'town' | 'village' | 'hamlet'`. Everything else follows from that one entry: the
streets (`buildRoadNetwork()` in `src/world/roads/network.ts` lays grid streets in the city and
town, winding ones in villages), the buildings (`placeBuildings()` in
`src/world/towns/placement.ts`), gardens and street trees, the urban ground texture, the
landcover, parked cars and traffic, and a lane to the nearest connected town if it has no road.

It's still a big change, because a lot of the world is seeded from one random stream. Know these
before you start:

- **Don't shift the random stream.** `addTown()` draws one random number for the street grid
  angle, and the 16 hamlets and some lanes are placed with the same stream afterwards. Adding a
  town before them moves every hamlet. Add yours **after** the hamlet loop and push it directly
  with a fixed `gridAngleDeg` and `blockSize`, so it draws nothing:
  ```ts
  towns.push({ name: 'Brookmere', kind: 'village', x: -10000, z: 0, radius: 300, density: 0.5, gridAngleDeg: 20, blockSize: 60 });
  ```
- **Pick flat, open ground** away from the river valley, lakes, the coast, the airport's approach
  corridors and the target range. Steep ground shows up in the tests as a road ribbon standing on
  its edge or a swimming pool on a plinth.
- **Order and names matter.** `towns[0]` is "the town" and `towns[1]` "the city" when the main
  roads are built; code elsewhere looks up `'Port Chateau'` and `'Tater Lake'` by name.
- **At most 32 towns.** The terrain shader holds `MAX_TOWNS = 32` town entries
  (`src/world/terrain/terrainShader.ts`); there are 26 today.
- **Expect to re-baseline.** A new town changes the ground near it, so the protected-ground
  snapshot must be regenerated, deliberately, in the same commit:
  `UPDATE_PROTECTED_SNAPSHOT=1 npx vitest run tests/world/protected.test.ts`. It also adds roads,
  which re-rolls the seeded traffic everywhere, and some statistical tests (the farm-field mix,
  the car traffic soak) sample the whole map. Run `npx vitest run tests/world` and look at every
  failure; they're usually real. When this guide was written, adding Brookmere as above broke
  the protected snapshot (expected), both car-traffic soaks (cars meeting at a Taterville junction
  under the new random sequence), the farm-field crop mix, a garage-and-pool check and a
  road-ribbon normal on a steep stretch of the new lane. Each needs a real fix or a
  deliberate re-baseline, not a looser test.

The towns tests check every building stays clear of roads, water, the airport and other
buildings, on the ground and facing its street (`tests/world/towns/placement.test.ts`, with a
fuzz test), and that streets stay in their town, out of the water and off the airport
(`tests/world/towns/network.test.ts`).

## Adding a road

Main roads are declared in `createLayout()` with `addRoad(name, kind, controlPoints, wiggle)`,
where `kind` is `'highway'` (11 m wide), `'road'` (7 m), `'access'` (7 m) or `'lane'` (5 m). The
control points are smoothed and resampled every 25 m. From there it's automatic: the heightfield
cuts a road bed with shoulders, the landcover keeps trees back, the road network adds junctions,
`src/world/roads` draws the surface, markings, verges and street lights, bridges are added where
it crosses the river, and cars drive on it.

Checks: `tests/world/layout.test.ts` keeps roads off the runway and segments shorter than 60 m;
`tests/world/water/river.test.ts` expects exactly two river bridges today (update it if your road
crosses the river); `tests/world/roads/` checks the ribbons, markings and junctions. Adding a road
also changes the protected snapshot and the seeded traffic, as for a town.

## Water: lakes, the river, the coast and islands

- **Lakes** are `lakeDefs` in `createLayout()` (Tater Lake and Crown Tarn): centre, radii,
  rotation and depth. The level is set from the lowest point of the shoreline.
- **The river** ("Tater River") is the control-point list `riverCtrl` in `createLayout()`,
  meandered and resampled every 40 m. Its level only falls downstream and reaches 0 at the mouth.
  `src/world/water/river.ts` draws the ribbon and the bridge piers.
- **The coast and the islands** are constants and `islandDefs` in `src/world/regional.ts`.
- **Sea level** is `CONFIG.world.seaLevel` (0). The wave look (wind, choppiness, surf, river flow
  speed) is `CONFIG.world.water`; the water renderer is `src/world/water/index.ts`.

Everything that sails, drives or stands near water depends on these, so treat them like a town:
boat routes must still validate ([ADDING_BOATS.md](ADDING_BOATS.md)), and the protected snapshot
changes.

## Runways and the airport

The runways are data: `CONFIG.world.airport.runways` in `src/config.ts`, each
`{ center: { x, z }, headingDeg, length, width, name }`:

```ts
runways: [
  { center: { x: 0, z: 0 }, headingDeg: 360, length: 1600, width: 30, name: '36/18' },
  { center: { x: -100, z: -227 }, headingDeg: 30, length: 1200, width: 25, name: '03/21' },
],
```

`src/world/runway.ts` turns them into `RunwayFrame`s (`runwayFrames()`), runway ends
(`runwayEnds()`, `runwayEndFrame('03')` for `?rwy=03`) and helpers like `runwayAt(x, z)` and
`runwayCrossing(a, b)`. The airport's full layout beyond the runways (taxiways, holds, aprons,
hangars, lights, signs, vehicles) is `createAirportField()` in `src/world/airport/field.ts`, drawn
by `src/world/airport/index.ts`.

A **third runway** in that list works right away for the physics (it's a `'runway'` surface),
the landcover (no trees on it, cleared approach corridors) and `?rwy=` for its two ends. It
needs code before it looks right:

- the airport renderer (`field.ts`, `plan.ts`, `markings.ts`, `lights.ts`, `signs.ts` and the
  pavement shader in `materials.ts`) draws exactly two runways today;
- the flat airport plateau is a 1,300 m circle around 36/18 (`flatRadius`), and the runway must
  fit inside it (`tests/world/runways.test.ts`);
- `inAirport()` in `src/world/towns/constraints.ts` only keeps houses out of 36/18's approach;
- circuit traffic flies runway 36 only.

The airport tests (`tests/world/runways.test.ts`, `tests/world/airport/crossing.test.ts`) expect
two runways and four ends, and check that every aircraft in the fleet sits on the centreline of
every runway end and that nothing stands on a runway or taxiway.

## Changing the terrain or the ground cover

- **Height.** `createHeightfield()` in `src/world/heightfield.ts` builds `terrainHeight()` in
  stages: the regional shape, river valleys, lake basins, the airport plateau blend, road beds,
  the river channel, and last of all the airport plateau set exactly to the field elevation.
  Keep the function continuous (`tests/world/heightfield.test.ts` checks at a fine scale) and
  cheap: the terrain workers call it millions of times.
- **Ground cover.** `src/world/landcover.ts` blends weights (`forest`, `field`, `grass`, `rock`,
  `snow`, `sand`, `urban`, `water`) and derives the `SurfaceType` the physics feels and the tree
  density. `treeDensity()` must stay 0 on water, pavement, roads and the approach paths
  (`tests/world/landcover.test.ts`, `tests/world/fuzz.test.ts`).
- **Fields.** `src/world/fields.ts` is the farm-field pattern, written once in TypeScript and once
  in GLSL (`FIELD_GLSL`) for the terrain shader. Change both together: `tests/world/fields.test.ts`
  pins the hash to the GLSL arithmetic and checks the shared constants.
- **Trees and grass** follow the landcover automatically (`src/world/vegetation`,
  `src/world/grass`); their settings are `CONFIG.world.vegetation` and `CONFIG.world.grass`.

## Tests that guard the ground

| Test | What it protects |
| --- | --- |
| `tests/world/protected.test.ts` | Height, landcover, surface and trees near every town, road, the river, the lakes and the airport, against a snapshot |
| `tests/world/heightfield.test.ts`, `tests/world/fuzz.test.ts` | The plateau is exactly flat at the field elevation; every paved airport surface too; continuity |
| `tests/world/landcover.test.ts` | No trees on pavement, roads, water, fields or in the approach paths |
| `tests/world/layout.test.ts` | Towns where they should be, roads off the runway, bridges recorded |
| `tests/world/towns/placement.test.ts`, `network.test.ts`, `obstacles.test.ts` | Buildings and streets clear of roads, water and the airport; no building obstacles over the runway |
| `tests/world/airport/crossing.test.ts`, `obstacles.test.ts`, `tests/world/runways.test.ts` | Nothing on the runways and taxiways; 03/21 inside the plateau; every aircraft sits on every runway end |
| `tests/world/grass/grass.test.ts`, `tests/world/vegetation/placement.test.ts` | No grass on pavement, roads or water; no trees where the density is 0 |
| `tests/world/water/river.test.ts` | The river ribbon, its levels and the bridges |

Run the world suite with `npx vitest run tests/world`, then the whole suite and
`npx tsc --noEmit -p .`, then fly over your change at dawn, midday and golden hour and compare it
with photos of the real thing.
