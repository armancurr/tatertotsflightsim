# Adding an aircraft

<!-- examples: src/aircraft/pa28/ src/aircraft/pa28/index.ts tests/aircraft/pa28 tests/aircraft/pa28/ tests/aircraft/pa28/anchors.test.ts tests/aircraft/pa28/functional.test.ts tests/physics/pa28-accuracy.test.ts createPA28Model PA28_AIRCRAFT PA28_WEAPONS PA28_PART -->

This guide walks through adding a new flyable aircraft. The worked example is a **Piper PA-28-181
Archer** (id `pa28`): a four-seat, low-wing trainer with fixed gear. Every snippet below compiles
against the current code. Use the real aircraft as references while you work: the Cessna
(`src/aircraft/`), the F-16 (`src/aircraft/f16/`), the A-10 (`src/aircraft/a10/`) and the 747
(`src/aircraft/b747/`).

An aircraft is one `AircraftDef` in the fleet registry. It carries four things:

- a **config** with the same shape as `CONFIG`, so the physics, cameras, instruments and weapons
  all read their numbers from it;
- a **3D model** factory that returns an `AircraftModelHandle`;
- a **HUD style** (`'steam'` gauges or a `'jet'` head-up display);
- an **engine sound** (`'piston'`, `'jet'` or `'turbofan'`).

Nothing else needs wiring. The aircraft picker, `?aircraft=<id>`, `window.sim.selectAircraft(id)`,
the reset/teleport code and every system (HUD, audio, weapons, crash) pick it up from the registry.

| Step | File | What you add |
| --- | --- | --- |
| 1 | `src/config.ts` (the "Fleet" section at the bottom) | `PA28_AIRCRAFT: AircraftConfig`, geometry first |
| 2 | `src/config.ts` + `src/physics/` (rarely) | Flight-model numbers, calibrated with tests |
| 3 | `src/config.ts` (optional) | `PA28_WEAPONS: WeaponsConfig` |
| 4 | `src/aircraft/pa28/index.ts` | `createPA28Model(): AircraftModelHandle` |
| 5 | `src/fleet/index.ts` | One `AircraftDef` entry in `FLEET` |
| 6 | (choose) | HUD style and engine sound |
| 7 | `tests/fleet/`, `tests/aircraft/pa28/`, `tests/physics/` | Geometry, anchors, model and accuracy tests |
| 8 | `scripts/qa-pilot.js`, `scripts/shot.mjs` | Fly it, photograph it, tune it |

Read [ARCHITECTURE.md](../ARCHITECTURE.md) §2 (coordinates) and §9b (the fleet) first. Work
test-first ([CONTRIBUTING.md](../CONTRIBUTING.md)).

## Conventions you must follow

- **Body frame:** metres, origin at the **centre of gravity**, `+X` right wing, `+Y` up, **`−Z`
  the nose**. It is the same frame as a three.js object, so the physics' orientation quaternion is
  copied straight onto your model's `root`.
- **One source of truth for geometry.** The physics contact points and the 3D model both read
  `config.aircraft.geometry`. If the model's wheels aren't where the geometry says, the aircraft
  floats or sinks. The tests check this to 2–3 cm.
- **Units.** SI inside the code. Knots, feet and feet per minute only in config keys whose names
  say so (`vrKt`, `hardFpm`, `aglFt`…).
- **Procedural and MIT only.** Build the model, textures and livery in code. Don't download
  models, textures or fonts, and don't copy third-party code.
- **Weapons stay arcade.** Guns fly ballistic rounds; missiles fly the scripted path in
  `src/combat/missile.ts`. Don't add guidance laws or seeker models.

## Step 1: the config, geometry first

Every aircraft section has **exactly the shape of `CONFIG.aircraft`** (the Cessna 172RG). Its
type is `AircraftConfig` (`= Config['aircraft']`, inferred from `CONFIG`). The sections are:

| Section | What it holds |
| --- | --- |
| `name`, `registration`, `mass`, `inertia`, `wingArea`, `wingSpan`, `meanChord`, `oswald` | Mass properties and the wing |
| `aero` | Lift, drag and moment coefficients, stall angles, control derivatives, `transonic` (jets) |
| `engine` | `type: 'piston' \| 'jet'`; the piston/propeller numbers; `jet: JetEngineConfig \| null` |
| `flaps` | `notchesDeg`, `rateDegPerSec`, `vfeKt`, flaperon options |
| `gear` | `retractable`, `transitTime`, `vleKt`, `vloKt`, squat switch |
| `surfaces` | Control surface travel, for the model and per-radian derivatives |
| `geometry` | Wheels, prop, pilot's eye, wing, tail and the crash points (below) |
| `model` | Visual-only tuning (the physics ignores it) |
| `ground` | Strut springs and dampers, friction per surface, brakes, steering |
| `fbw` | `FbwConfig` or `null` (direct controls) |
| `limits` | V-speeds (`vs1Kt`, `vrKt`, `vyKt`, `vneKt`…) and g limits |
| `stall`, `landing`, `spawn` | Stall warning, touchdown grades (`butterFpm` … `hardFpm`), reset positions |

The fields you'll look at first in `geometry`:

- `noseWheel`, `leftMainWheel`, `rightMainWheel`: the **tyre contact point** of each wheel with
  the strut fully extended. `mainWheelRadius`, `noseWheelRadius` and `strutTravel` go with them.
- `pilotEye`: the cockpit camera sits here.
- `propHub`, `propRadius`, `spinnerTip`, `wingRootLeadingEdge`, `horizontalTail`,
  `verticalTailTop`: used by the model, and by the crash and camera code.
- `structuralPoints`: named points that must never touch the ground. Touching the ground with one
  is a crash, and the name picks the reason: `propTip` or `cowling` is a prop strike,
  `leftWingtip` or `rightWingtip` a wingtip strike, `tailcone`, `leftStab` or `rightStab` a tail
  strike (a slow scrape only skids), and `finTop` or `cabinRoof` "Flipped over". Points whose names
  start with `belly` only count when the gear isn't down. See `crashReasonFor` in
  `src/physics/ground.ts`.

Put a factory function in the "Fleet: other flyable aircraft" section at the end of
`src/config.ts`, next to `makeF16()`, `makeA10()` and `makeB747()`. Starting from a clone of the
closest existing aircraft keeps the shape right. Here the Cessna is closest:

```ts
/**
 * Piper PA-28-181 Archer: four-seat low-wing trainer, 180 hp, fixed gear.
 * GEOMETRY: real dimensions (7.25 m long, 10.67 m span); the 3D model and the physics both read it.
 */
function makePA28(): AircraftConfig {
  const c172 = structuredClone(CONFIG.aircraft);
  return {
    ...c172,
    name: 'Piper PA-28-181 Archer',
    registration: 'N281TT',
    mass: 1050,
    wingArea: 15.8,
    wingSpan: 10.67,
    meanChord: 1.6,
    engine: { ...c172.engine, maxPowerW: 134000 },
    gear: { ...c172.gear, retractable: false },
    geometry: {
      ...c172.geometry,
      length: 7.25,
      noseWheel: { x: 0, y: -1.2, z: -1.45 },
      leftMainWheel: { x: -1.6, y: -1.2, z: 0.35 },
      rightMainWheel: { x: 1.6, y: -1.2, z: 0.35 },
      structuralPoints: [
        { name: 'propTip', x: 0, y: -0.85, z: -2.0 },
        { name: 'leftWingtip', x: -5.33, y: -0.2, z: 0.2 },
        { name: 'rightWingtip', x: 5.33, y: -0.2, z: 0.2 },
        { name: 'tailcone', x: 0, y: -0.3, z: 4.6 },
        { name: 'finTop', x: 0, y: 1.1, z: 5.0 },
        { name: 'cabinRoof', x: 0, y: 0.9, z: 0.0 },
      ],
    },
    limits: { ...c172.limits, vs1Kt: 50, vrKt: 60, vyKt: 76, vneKt: 154 },
  };
}
export const PA28_AIRCRAFT: AircraftConfig = makePA28();
```

Write the geometry down from real published dimensions (length, span, height, wheelbase, track)
and state them in the doc comment, as `makeF16()` and `makeB747()` do. Once the model exists, the
geometry is a contract: change it only together with the model and its tests.

`config.ts` is shared by every module, and each section has an owner (see the comments on each
section). Only add your own constants; don't reformat or reorder the others.

## Step 2: the flight model

`step(state, controls, dt, env, cfg)` in `src/physics/aircraft.ts` flies **every** aircraft. The
config you pass selects the airframe, so a new aircraft usually needs **no physics code at all**,
only numbers.

- **Engine.** `engine.type: 'piston'` uses the propeller model in `src/physics/engine.ts`
  (`maxPowerW`, `staticThrustN`, `propEfficiency`…). `engine.type: 'jet'` needs
  `engine.jet: JetEngineConfig` (`milThrustN`, `maxThrustN`, `abDetent`, spool times, thrust lapse,
  `thrustPoint`), stepped by `src/physics/jet.ts`. With no afterburner, set `maxThrustN` equal to
  `milThrustN` and `abDetent: 1`, as the A-10 does.
- **Fly-by-wire.** Set `fbw` to an `FbwConfig` (g command, angle-of-attack limiter, roll-rate
  command, yaw damper; see `src/physics/fbw.ts`) or leave it `null` for direct controls.
- **Transonic drag.** Jets set `aero.transonic` (`TransonicConfig`).
- **Gun recoil.** Automatic: if `weapons.gun.recoilN > 0`, `src/physics/recoil.ts` pushes the
  aircraft back while the trigger is held.

Calibrate against published numbers: stall speeds, take-off roll, climb rate, cruise and top
speed, roll rate, glide ratio and landing roll. The calibration tables for the existing aircraft
are in the comment at the top of `src/physics/aircraft.ts`, and the tests that hold them are
`tests/physics/realism.test.ts` (Cessna), `tests/physics/f16-accuracy.test.ts` and
`tests/physics/a10-flight.test.ts`. Write yours the same way, with a band around each real value:

```ts
import { describe, it, expect } from 'vitest';
import { createInitialState, step, defaultControls, FLAT_ENV } from '../../src/physics';
import { getAircraftDef } from '../../src/fleet';

describe('PA-28 accuracy', () => {
  const cfg = getAircraftDef('pa28').config;
  it('lifts off within 250–450 m at full power, rotating at Vr', () => {
    let s = createInitialState(FLAT_ENV, cfg);
    const z0 = s.position.z;
    while (s.onGround && s.time < 60) {
      const kt = s.derived.ias * 1.943844;
      s = step(s, { ...defaultControls(), throttle: 1, elevator: kt > cfg.aircraft.limits.vrKt ? 0.4 : 0 }, 1 / 120, FLAT_ENV, cfg);
    }
    expect(Math.abs(s.position.z - z0)).toBeGreaterThan(250);   // the example PA-28 lifts off in ~350 m
    expect(Math.abs(s.position.z - z0)).toBeLessThan(450);
  });
});
```

If the aircraft really needs new physics (a new engine type, a tailwheel), add it to
`src/physics/` behind a new, optional config field, so the existing aircraft are untouched and
their tests stay green. The physics must stay **pure**: no three.js, no DOM, no clock.

## Step 3: weapons (optional)

An unarmed aircraft needs nothing here: `CONFIG.weapons` is
`{ gun: null, missiles: null, airMissiles: null }` and the fleet entry inherits it.

An armed one gets a `WeaponsConfig` next to `A10_WEAPONS` and `F16_WEAPONS`:

- `gun: GunConfig | null`: the cannon (`rateRps`, `rounds`, `muzzleVelocity`, `dragK`,
  `dispersionMrad`, `recoilN`, `damage`, `muzzle` position…);
- `missiles: MissileConfig | null`: air-to-ground Mavericks, one per entry in `stations`;
- `airMissiles: MissileConfig | null`: air-to-air Sidewinders. Spread the shared `AIM9M` and set
  your own `stations`, as `F16_WEAPONS` does.

Positions (`muzzle`, `stations`) are in the **body frame**, and your model must put the gun port
and one missile at each station exactly there. The weapons system, the missiles system, the
weapons HUD and the recoil all read `config.weapons`, so the keys (<kbd>Q</kbd>, <kbd>T</kbd>,
<kbd>Z</kbd>) and the HUD symbology switch on by themselves.

## Step 4: the 3D model

Create `src/aircraft/pa28/index.ts` exporting a factory that returns an `AircraftModelHandle`
(defined in `src/fleet/types.ts`):

| Member | Required | What it does |
| --- | --- | --- |
| `root: THREE.Group` | yes | The whole aircraft. The game loop copies the physics position and orientation onto it. |
| `setVisualState(v, dt)` | yes | Called every frame with an `AircraftVisualState` (`src/aircraft/types.ts`): control positions, `flapsDeg`, `gearPos`, `wheelCompression`, `wheelRollSpeed`, `nosewheelSteer`, `propRpm`, `lights`, `cameraMode`, `instruments`, and, when present, `crashed`, `afterburner`, `speedBrake`, `gunSpin`, `gunFiring`, `stores` and `airStores`. |
| `setPanelDrawer?(fn)` | no | Steam-gauge aircraft: the HUD hands you a `PanelDrawer` that paints the six-pack onto your panel's canvas texture. |
| `landingLight?` | no | A `THREE.SpotLight` the <kbd>L</kbd> key switches. |
| `hudCombiner?` | jets | The HUD glass mesh. In the cockpit view the jet HUD is drawn inside its outline, so the symbols sit on the glass. |
| `getBreakupParts?()` | no | `BreakupPart[]` (`name`, `object`, `mass`, `burning?`) for the crash. Without it, the crash director splits the root's children. |
| `restoreBreakupParts?()` | with the above | Re-attaches every part to its parent with its original local transform on reset. |
| `dispose()` | yes | Frees geometries, materials and textures. |

A minimal model, with its wheels exactly on the physics contact points:

```ts
import * as THREE from 'three';
import { PA28_AIRCRAFT } from '../../config';
import type { AircraftModelHandle, BreakupPart } from '../../fleet/types';
import type { AircraftVisualState } from '../types';

/** Named parts the tests look up. */
export const PA28_PART = { axleNose: 'pa28.axle.nose', axleLeft: 'pa28.axle.left', axleRight: 'pa28.axle.right' } as const;

export function createPA28Model(): AircraftModelHandle {
  const g = PA28_AIRCRAFT.geometry;
  const root = new THREE.Group();
  root.name = 'pa28';
  const paint = new THREE.MeshStandardMaterial({ color: 0xf2f2ee, roughness: 0.5 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x151515, roughness: 0.9 });
  const geos: THREE.BufferGeometry[] = [];
  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, name: string, parent: THREE.Object3D = root) => {
    geos.push(geo);
    const m = new THREE.Mesh(geo, mat);
    m.name = name;
    m.castShadow = true;
    parent.add(m);
    return m;
  };

  const fuselage = mesh(new THREE.BoxGeometry(1.1, 1.2, g.length), paint, 'pa28.fuselage');
  fuselage.position.set(0, 0.1, g.spinnerTip.z + g.length / 2);
  const leftWing = mesh(new THREE.BoxGeometry(PA28_AIRCRAFT.wingSpan / 2, 0.15, 1.6), paint, 'pa28.wing.left');
  leftWing.position.set(-PA28_AIRCRAFT.wingSpan / 4, -0.25, 0.2);
  const rightWing = mesh(new THREE.BoxGeometry(PA28_AIRCRAFT.wingSpan / 2, 0.15, 1.6), paint, 'pa28.wing.right');
  rightWing.position.set(PA28_AIRCRAFT.wingSpan / 4, -0.25, 0.2);

  // Wheels: axle = contact point + radius (the tyre's lowest point sits on the contact point).
  const wheel = (name: string, p: { x: number; y: number; z: number }, r: number) => {
    const w = mesh(new THREE.CylinderGeometry(r, r, 0.15, 20).rotateZ(Math.PI / 2), rubber, name);
    w.position.set(p.x, p.y + r, p.z);
    return w;
  };
  const wheels = [
    wheel(PA28_PART.axleNose, g.noseWheel, g.noseWheelRadius),
    wheel(PA28_PART.axleLeft, g.leftMainWheel, g.mainWheelRadius),
    wheel(PA28_PART.axleRight, g.rightMainWheel, g.mainWheelRadius),
  ];

  const breakup: BreakupPart[] = [
    { name: 'fuselage', object: fuselage, mass: 600, burning: true },
    { name: 'leftWing', object: leftWing, mass: 120, burning: true },
    { name: 'rightWing', object: rightWing, mass: 120 },
  ];
  const home = breakup.map((p) => ({
    obj: p.object, parent: p.object.parent!,
    pos: p.object.position.clone(), quat: p.object.quaternion.clone(), scale: p.object.scale.clone(),
  }));

  return {
    root,
    setVisualState(v: AircraftVisualState, dt: number) {
      for (let i = 0; i < 3; i++) {
        const r = i === 0 ? g.noseWheelRadius : g.mainWheelRadius;
        // Strut compression pushes the wheel up; roll speed spins it.
        wheels[i].position.y = [g.noseWheel, g.leftMainWheel, g.rightMainWheel][i].y + r + v.wheelCompression[i];
        wheels[i].rotation.x -= (v.wheelRollSpeed[i] / r) * dt;
      }
    },
    getBreakupParts: () => breakup,
    restoreBreakupParts() {
      for (const h of home) {
        h.parent.add(h.obj);
        h.obj.position.copy(h.pos);
        h.obj.quaternion.copy(h.quat);
        h.obj.scale.copy(h.scale);
      }
    },
    dispose() {
      for (const x of geos) x.dispose();
      paint.dispose();
      rubber.dispose();
    },
  };
}
```

From there, grow it into a real aircraft the way the others were built:

- **Shape.** `src/aircraft/loft.ts` lofts a smooth skin through cross-sections (the Cessna's
  fuselage), `src/aircraft/airfoil.ts` and `src/aircraft/wing.ts` build real wing sections, and
  `src/aircraft/f16/shape.ts` shows a jet's shape tables. Keep every dimension tied to
  `geometry`.
- **Moving parts.** Pivot the elevator, ailerons, rudder and flaps about their hinge lines and
  drive them from `v.elevator`, `v.aileron`, `v.rudder` and `v.flapsDeg` (+elevator = nose up,
  +aileron = roll right, +rudder = yaw right). Animate the gear from `v.gearPos` (0 up, 1 down) if
  it retracts, and spin the propeller from `v.propRpm`.
- **Lights.** Nav lights, strobes and the beacon from `v.lights` and `v.time`.
- **Paint.** Draw the livery onto canvas textures in code (see `src/aircraft/livery.ts` and
  `src/aircraft/f16/livery.ts`).
- **Cockpit.** When `v.cameraMode === 'cockpit'`, show the interior and hide whatever would sit in
  front of the pilot's eye (the pilot's own head, for instance). `src/aircraft/cockpit.ts` (Cessna)
  and `src/aircraft/f16/cockpit.ts` are the references; the tests in
  `tests/aircraft/cockpitView.test.ts` check the view over the nose.
- **Crash.** When `v.crashed` is set, show the wreck (see `src/aircraft/wreck.ts`); reset clears it.
- **Materials.** Use `MeshStandardMaterial` / `MeshPhysicalMaterial` (they get the global aerial
  perspective and cloud shadows through `fog: true`, which is their default). A custom
  `ShaderMaterial` must call `ensureAtmosphericFogUniforms` from `src/render/fog.ts`. Calibrate
  colours under the HDR lighting (exposure ≈ 2.2) by looking at screenshots.
- **Budget.** The F-16 stays within 60 draw calls and the A-10, with its detailed cockpit, within
  75 (their functional tests hold them to it). Merge static parts and share materials.

To look at the model on its own, copy a preview page: `preview/f16.html` loads
`src/preview/f16.ts`, which has orbit controls, control-surface sliders in the URL and
`?ortho=side|top|front` three-views with a 1 m grid for checking dimensions against drawings.

## Step 5: the fleet entry

Add the aircraft to `src/fleet/index.ts`. The config is the whole `CONFIG` with your sections
swapped in, and optional camera overrides for a bigger or smaller aircraft:

```ts
import { CONFIG, PA28_AIRCRAFT, type Config } from '../config';
import { createPA28Model } from '../aircraft/pa28';

const pa28Config: Config = {
  ...CONFIG,
  aircraft: PA28_AIRCRAFT,
  // weapons: PA28_WEAPONS,   // only if it's armed
  camera: { ...CONFIG.camera, chase: { ...CONFIG.camera.chase, distance: 14 } },
};

const PA28: AircraftDef = {
  id: 'pa28',                                 // URLs (?aircraft=pa28), saved choice, tests
  name: 'Piper PA-28-181 Archer',
  shortName: 'Archer',                        // the picker and menus
  description: 'Four-seat low-wing trainer with fixed gear — docile and honest.',
  config: pa28Config,
  hud: 'steam',
  sound: 'piston',
  createModel: () => createPA28Model(),
};

export const FLEET: readonly AircraftDef[] = [C172, F16, A10, B747, PA28];  // menu order
```

The id must be unique and stable, because players' saved choices and URLs use it.

## Step 6: HUD style and sound

- **`hud: 'steam'`** shows the six-pack gauges, tachometer and system strip in the screen corners
  (the Cessna and the 747), and hands your model a panel drawer if it has `setPanelDrawer`.
  **`hud: 'jet'`** draws a head-up display (pitch ladder, speed and altitude tapes, heading, AoA,
  g) and, for an armed aircraft, the weapons symbology. For the cockpit view, give the model a
  `hudCombiner` mesh, or the HUD has no glass to sit on.
- **`sound`** picks the engine voice in `src/audio`: `'piston'` (an O-360 and propeller, pitched
  by RPM), `'jet'` (the F-16's afterburning F110) or `'turbofan'` (the A-10's high-bypass TF34s,
  also used by the 747). A new voice means a new synthesiser next to `src/audio/piston.ts`,
  `src/audio/jet.ts` and `src/audio/turbofan.ts`, a new `EngineSound` member in
  `src/fleet/types.ts`, and a case in `makeVoice` in `src/audio/audio.ts`.

## Step 7: tests

Some tests cover every fleet entry automatically:

- `tests/fleet/fleet.test.ts`: "every aircraft spawns resting on its gear on the runway and stays
  put at idle".
- `tests/world/airport/crossing.test.ts`: every aircraft rests on its gear on the centreline of
  every runway end (36, 18, 03, 21).

Add your own:

1. **Geometry** (`tests/fleet/fleet.test.ts`): the real dimensions, like "the F-16 geometry
   matches the real jet": span from the structural points, length, height, wheelbase, track.
2. **Anchors** (`tests/aircraft/pa28/anchors.test.ts`): the model agrees with the geometry within
   2–3 cm. Copy `tests/aircraft/f16/anchors.test.ts`: tyre bottoms on the contact points, strut
   compression lifts each wheel, wingtips, tail and fin top where the crash points are, overall
   dimensions, the pilot's eye inside the cockpit, the gun muzzle and missile stations if armed,
   and each control surface moving the right way. A first test:

   ```ts
   import { describe, it, expect } from 'vitest';
   import * as THREE from 'three';
   import { createPA28Model, PA28_PART } from '../../../src/aircraft/pa28';
   import { createDefaultVisualState } from '../../../src/aircraft/types';
   import { PA28_AIRCRAFT } from '../../../src/config';

   describe('PA-28 model anchors match PA28_AIRCRAFT.geometry', () => {
     it('the left main tyre sits on the physics contact point (uncompressed)', () => {
       const m = createPA28Model();
       m.setVisualState({ ...createDefaultVisualState(), wheelCompression: [0, 0, 0] }, 1 / 60);
       m.root.updateMatrixWorld(true);
       const g = PA28_AIRCRAFT.geometry.leftMainWheel;
       const box = new THREE.Box3().setFromObject(m.root.getObjectByName(PA28_PART.axleLeft)!);
       const c = box.getCenter(new THREE.Vector3());
       expect(box.min.y).toBeCloseTo(g.y, 2);
       expect(c.x).toBeCloseTo(g.x, 2);
       expect(c.z).toBeCloseTo(g.z, 2);
       m.dispose();
     });
   });
   ```
3. **Model functional tests** (`tests/aircraft/pa28/functional.test.ts`, after
   `tests/aircraft/f16/functional.test.ts`): the fleet entry builds this model; the draw-call and
   triangle budget in every view; break-up parts are disjoint with sensible masses; a detached part
   restores exactly; a crash chars the model and a reset brings it back.
4. **Physics accuracy** (`tests/physics/pa28-accuracy.test.ts`): the calibration table, as in
   step 2. Add the table to the comment at the top of `src/physics/aircraft.ts`.
5. **Fuzz** (fast-check): random control sequences never produce NaN, the state stays valid and a
   crash stays final. `tests/physics/a10-fuzz.test.ts` is the pattern, with the shared
   arbitraries in `tests/support/arbitraries.ts` and `fcParams()` from `tests/support/fc.ts`.

Run them with `npx vitest run tests/fleet tests/aircraft/pa28 tests/physics`, then the whole suite
and `npx tsc --noEmit -p .`.

## Step 8: fly it and tune it

Start the dev server (`npm start`) and open `http://127.0.0.1:8092/?aircraft=pa28`. Try every
camera (<kbd>1</kbd>–<kbd>4</kbd>), look around the cockpit with the mouse, and fly a circuit.
Then compare what you see and feel with videos and photos of the real aircraft.

- **Screenshots.** `node scripts/shot.mjs "http://127.0.0.1:8092/?veil=0&aircraft=pa28&cam=orbit&tod=2" qa/tmp/pa28-orbit.png --size 1440x900 --wait 12000`
  photographs the page in Chrome for Testing (never your everyday Chrome) and prints console
  errors. `qa/tmp/` is git-ignored.
- **The QA pilot.** `scripts/qa-pilot.js` flies the sim through keyboard events only, like a
  person: `takeoff()`, `climbTo(ft)`, `turn(deg, bank)`, `stallAndRecover()`,
  `approachAndLand()`, `circuit()`. It keeps a profile per aircraft in its `BASE` table (keyed by
  fleet id: rotation pitch, climb and approach speeds, flare heights, control gains) and refines
  it from your config (`limits.vrKt`, `vyKt`, flap notches, jet or piston). Add a `pa28` entry;
  unknown ids fall back to the Cessna's. Inject it with Playwright's `page.addScriptTag()` in a
  script under `qa/tmp/`, using `launchOptions()` from `scripts/test-browser.mjs`.
- **Numbers.** `window.sim` shows `airspeed`, `altitude`, `aoa`, `gLoad`, `verticalSpeed`,
  `lastLanding` (rating, fpm) and `crash`. `window.sim.render` has draw calls and triangles.

When the take-off, climb, stall, approach and landing all match the real numbers and the model
looks right at every time of day (`?tod=0` to `3`), open a pull request with before/after
screenshots.

## Checklist

- [ ] `PA28_AIRCRAFT` in `src/config.ts` with real, commented geometry
- [ ] Calibration table in `src/physics/aircraft.ts` and accuracy tests in `tests/physics/`
- [ ] `PA28_WEAPONS` (armed aircraft only), with the muzzle and stations on the model
- [ ] `src/aircraft/pa28/` implementing `AircraftModelHandle`, within the draw-call budget
- [ ] `FLEET` entry in `src/fleet/index.ts`
- [ ] Geometry, anchors, model functional and fuzz tests; the whole suite and `tsc` green
- [ ] A `pa28` profile in `scripts/qa-pilot.js`, flown and photographed
- [ ] README: a row in "The aircraft" table and `aircraft=pa28` in the URL options (a test
      checks that the README names every aircraft in the fleet)
