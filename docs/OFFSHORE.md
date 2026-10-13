# Offshore scenery

Three places to go out at sea, all in `src/world/offshore/` with two systems in `src/game/systems/`:

| What | Where | Files |
| --- | --- | --- |
| **Tater Alpha**, a fixed steel-jacket production platform with a landable helideck and a burning gas flare | (4700, 12600), 41 m of water, 5 km off the coast | `platform.ts` (pure), `platformModel.ts`, system `offshore.ts` |
| **Tater Bank wind farm**: 16 turbines (150 m hub, 220 m rotor) and an offshore substation | x 9400–11890, z 9800–11840, 20–45 m of water, east of Seal Rock | `windFarm.ts` (pure), `windFarmModel.ts`, system `offshore.ts` |
| **Tater Beach PWC course**: an inflatable-buoy jet-ski course with a lap timer | x −2770…−2030, z 7850…8165, off the beach west of the river mouth | `raceCourse.ts` (pure), `raceModel.ts`, system `raceCourse.ts`, HUD `src/ui/raceHud.ts` |

Every site is a constant in `src/world/offshore/sites.ts`. Frames: world +X east, +Z south. The
platform has its own local frame (`siteFrame(x, z, headingDeg)`: local +X along the compass bearing
`headingDeg`, three.js `rotation.y = (90 − heading)°`); everything else is in world coordinates.

## Tater Alpha

A four-leg jacket (legs battered 1 : 10, X-braced faces, conductors, risers, a boat landing) carries
three decks (+20, +28, +36 m). The long axis lies along the prevailing wind (from 215°): living
quarters and helideck upwind, the drilling derrick and process modules in the middle, two pedestal
cranes on the long sides, lifeboats in davits under the quarters, and a 70 m lattice flare boom
downwind with the flame. Dimensions live in `PLATFORM` (`platform.ts`); the model and the physics
both read them.

- **Obstacles.** `createPlatformPhysics().obstacleTop(x, z)` covers the topside footprint (+4 m for
  walkways and lifeboats), the quarters, modules, derrick, cranes and the flare boom. Obstacles are
  columns (a top height), so for a boat the whole footprint is a wall — flying under the flare boom
  or sailing under the topside is a collision.
- **The helideck** is an octagon 22 m across the flats at +51.5 m (dark green, white perimeter line
  and H, yellow touchdown circle, a safety net, 24 green perimeter lights). It is a **deck**, not an
  obstacle: the system registers `env.registerDeckSource({ top: helideckTop, surface: 'asphalt' })`,
  so `env.groundHeight` over the octagon IS the deck — skids and wheels stand on it, AGL and ground
  effect are measured from it — and `obstacleTop` answers −∞ there. Everything within 5 m of the
  deck edge is lower than the deck (the obstacle-free zone), and the deck lies ≥ 8 m inside the
  solid footprint so a hull meets the wall before it could ever sample the deck as ground.
- **The flare** burns at the boom tip: three crossed, animated additive quads leaning downwind, a
  point-sprite halo (visible for miles at night), an orange glow on the sea under it at night, and
  it lights the platform itself through a fake point light in its material (`materials.ts`: view
  space position, inverse-square fall-off — no three.js light, no extra pass).
- **Lights.** Steady red aviation obstruction lights (derrick crown and mid-height, flare tip, crane
  booms, quarters' corners), the green helideck perimeter, floods, warm deck lights on every level
  and lit windows in the quarters at night (`platformLights()`).
- **LOD.** One merged vertex-coloured mesh (~10k triangles) near, a few hundred triangles of blocks
  beyond 2.6 km (`PLATFORM_LOD_DISTANCE`), one draw call either way.

Land on it with the JetRanger: `?aircraft=b206&spawn=4688,12617,8,215,0` starts in an 8 ft hover
over the deck (the spawn's AGL is measured from the deck); lower the collective (S) to touch down.
`sim.debug().systems.offshore.helideck` gives the deck centre.

## The wind farm

`WIND_FARM_SITE` lists the grid's columns and rows and the substation. Each turbine is a monopile,
a yellow transition piece with its access platform and boat landing, a white tapered tower, a
nacelle (with a hoist platform) and a three-blade rotor (red tips) 12 m upwind of the tower, tilted
6°. All 16 draw in two instanced meshes (static parts, rotors) plus the substation.

- **Wind.** `offshoreWind(env)`: `env.wind` at hub height when the environment has one (and it isn't
  calm), otherwise the sea's surface wind (`CONFIG.world.water.windFromDeg` / `windKt`, what the waves
  are drawn with), raised to hub height by the offshore power law (α 0.11). The system looks again
  every 5 s and re-aims everything (model and obstacles) if it veers.
- **Yaw and speed.** The rotors face the wind's source (`turbineYawDeg`). `rotorRpm(v)`: 0 below
  cut-in (3 m/s), tip-speed ratio 8 up to rated (7.6 rpm), feathered above cut-out (25 m/s). The
  default 12 kt breeze turns them at ~5.8 rpm.
- **Obstacles.** Tower, nacelle and the swept rotor disc (a 12 m thick slab across the wind whose top
  is the disc's rim), and the substation block — for aircraft and boats.
- **Lights.** Red flashers on every nacelle, all in sync (on 1 s of every 2), mid-tower reds, yellow
  marine lanterns (Fl Y 5 s) on the corner turbines, substation lights.

## The race course

A lap of ~2.3 km, clockwise, in 3–16 m of water: through the start/finish arch heading east, round
T1 and T2 to starboard, a left-hand hairpin (T3 → M to port → T4) pushed into the course, a
three-buoy slalom (S1 port, S2 starboard, S3 port) along the offshore leg, then T5 and T6 back to
the arch. Turn buoys are tall orange inflatables, slalom buoys yellow; they bob on the drawn waves
(`buoyancy.ts`, the same trains as the water shader) and are **soft obstacles**
(`env.registerSoftObstacleSource`): a hull bumps off them (a capped push in `src/physics/hull.ts`),
nothing crashes; aircraft ignore them.

**Checkpoint logic** (`raceCourse.ts`, pure): every mark has a *check line* from the buoy outward on
the side the craft must pass, across the direction of travel there, and a *foul line* on the wrong
side; the gate's check line runs between the arch's feet. A mark counts when the craft crosses its
check line going the right way, in order. Crossing a mark's foul line, or reaching a later mark's
check line first, misses it: a penalty, and the lap doesn't count (it is shown as INVALID and never
becomes the best). Skipping the finish arch voids the lap too. Crossings are timed where they
happened along the move, a point exactly on a line belongs to one side (a path through it crosses
once), and nothing allocates per update. The tests fuzz it with fast-check: random paths never
count a lap that didn't cross every check line in order; the racing line with noise and any step
size always counts.

**The lap timer** (`src/ui/raceHud.ts`) shows while a vessel is driven within 700 m of the course:
top-left under the FPS chip, in the marine HUD's dark glass — lap number, current lap, last and best,
the split against the best lap at the last mark, a dot per mark (rounded / missed / next) and the
next mark with its side, distance and an arrow relative to the bow. A green chevron floats over the
next mark in the world. Lap and missed-mark toasts go through the HUD's message stack. The best lap
and its splits are saved in localStorage per course and vessel id (`tfs.race.best.<course>.<vessel>`).
Leaving the area (1.5 km) abandons the lap; a reset or a crash does too.

Try it with the V50: `?aircraft=v50&spawn=-2440,7851,0,92,28` starts underway just short of the arch.

## Moving or adding things

- **Move a site**: change its constant in `sites.ts`, then run `npx vitest run tests/world/offshore`.
  The placement tests check water depth (platform ≥ 40 m, turbines 15–45 m, the course ≥ 1.5 m
  for a jet ski and ≥ 3 m on the racing line), clearance from every route of the sea plan
  (`createSeaPlan`: platform ≥ 1.35 km, turbines ≥ 1.5 km, course ≥ 150 m), from the islands and
  Seal Rock, and the marina. Near (5200, 12800) the tanker lane (z 14,000) and the fishing circle round
  (2600, 12700) leave no spot with ≥ 40 m of water 1.5 km from both; Tater Alpha sits 1.4 km from each.
- **Another turbine row**: add to `columnsX` / `rowsZ` (instances follow; keep ≥ 3 rotor diameters).
- **Another course or a different layout**: `buildRaceCourse(specs, id, name)` takes the mark list
  (id, kind, x, z, side, check / foul line lengths, racing-line offset). The tests require the racing
  line to cross every check line exactly once per lap and no foul line — keep check lines from
  reaching other legs of the course (the hairpin's are short for that reason).
- **Another landable deck** (a ship's helipad, a rooftop): `env.registerDeckSource({ top, surface })`
  with `top(x, z)` the deck height or −∞, and make sure no obstacle source answers above the deck over
  its footprint. A moving deck can read its ship's pose inside `top`.

## Tests

`tests/world/offshore/` — `platform.test.ts` (placement, obstacles, the helideck cut-out, deck sources
in the environment), `helideck.test.ts` (the JetRanger hovers, lands rated on the deck, stays put,
departs; landing on the topside beside it is a crash), `windFarm.test.ts` (placement, wind, yaw,
rpm curve, disc obstacles), `raceCourse.test.ts` (placement, course shape, check/foul lines, lap logic
and its fuzzing, persistence), `hull.test.ts` (soft buoys vs hard structures for the V50),
`models.test.ts` (geometry, LOD, instancing, rotor speed, bobbing buoys, draw-call budget).
`tests/game/offshore.test.ts` runs both systems on a fake context; `tests/ui/raceHud.test.ts` the panel.

Preview: `preview/offshore.html` (URL parameters `view=platform`, `helideck`, `flare`, `jacket`, `turbine` or `race`, and `night=1`).
