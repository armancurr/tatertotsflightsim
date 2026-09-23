# Contributing to Tater's Flight Sim

Thanks for helping! Bug reports, ideas, new aircraft, vehicles, boats and scenery, realism fixes
and performance work are all welcome. This page covers how to set up, the project's principles,
and what a good pull request looks like. [ARCHITECTURE.md](ARCHITECTURE.md) explains how the
code fits together.

**Step-by-step guides:**

- [Adding an aircraft](docs/ADDING_AN_AIRCRAFT.md)
- [Adding vehicles and targets](docs/ADDING_VEHICLES_AND_TARGETS.md) (range targets, enemy aircraft, road traffic)
- [Adding boats](docs/ADDING_BOATS.md)
- [Adding land features](docs/ADDING_LAND_FEATURES.md) (landmarks, new world systems, towns, roads, water, runways)
- [Testing](docs/TESTING.md) (the test layers, fuzzing, the test browser)

## Set up

You need Node.js 22.12 or newer (`nvm use` picks up `.nvmrc`) and git. Any OS works: macOS,
Linux or Windows.

```sh
git clone https://github.com/<owner>/tatertotsflightsim.git
cd tatertotsflightsim
npm install
npx playwright install chromium   # once: the browser the end-to-end tests and screenshots use
npm start                         # http://127.0.0.1:8092, with hot reload
```

On Linux, `npx playwright install --with-deps chromium` also installs the browser's system
libraries.

## Run the tests

```sh
npm test                     # every test: unit, fuzz, functional and browser end-to-end
npx vitest run tests/world   # one area while you work
npx vitest run -t "stall"    # tests whose name matches
npx tsc --noEmit -p .        # typecheck (the same as npm run typecheck)
npm run check                # typecheck + every test + production build: run before you push
```

With a GPU the whole suite takes a few minutes. The heavier tests set their own timeouts, but
timing-sensitive ones can flake when the machine is very busy: re-run a failure on its own before
digging in. A failing fast-check property prints a seed and a path; `FC_SEED=… FC_PATH=…` replays
exactly that case ([docs/TESTING.md](docs/TESTING.md)).

## Principles

These are what keep a big simulator testable and fast. Pull requests are reviewed against them.

1. **Pure physics.** `step(state, controls, dt, env, cfg)` in `src/physics` is deterministic and
   never touches three.js, the DOM or the clock. It returns a new state and never mutates its
   input. The renderer only draws what the physics says, so the flight model can be tested to the
   decimal place without a browser. The same goes for the other simulation code (input, camera
   rig, instruments, world layout, combat world, traffic plans): pure functions, with the
   drawing kept separate.
2. **One config file.** Every tunable number lives in `src/config.ts`, in the section that
   belongs to its module (each section says who owns it). No magic numbers in the code. Tests
   can use `cloneConfig()` to change values without touching the real config.
3. **The systems plug-in layer.** New features are systems: one file in `src/game/systems/`
   exporting `{ name, order, create(ctx) }`, discovered automatically. There's no central wiring
   file to edit, so features don't collide, and a system that throws can't take the game down.
4. **One source of truth for shapes.** The physics and the 3D model read the same geometry
   (wheels, wingtips, gun muzzles, missile stations, obstacles). What you see is what you hit.
5. **Procedural content only.** Every model, texture, sound and font is generated in code. No
   downloaded assets, no fetching anything at runtime, no copied third-party code. That's what
   keeps the licence simple and the game loading from a plain static folder.
6. **MIT only.** Your contribution is released under the project's [MIT licence](LICENSE).
   Runtime dependencies must be MIT too (a test checks the whole bundle); there is exactly one
   today, three.js.
7. **Weapons stay arcade.** Guns fire ballistic rounds; missiles fly a scripted path to a
   locked target (`src/combat/missile.ts`). Real guidance laws and seeker models are out of
   scope and won't be merged.
8. **Test first.** Write the test, watch it fail, make it pass. Most changes need three layers:
   - **unit** tests in `tests/<module>/`, mirroring `src/`;
   - **property (fuzz)** tests with [fast-check](https://fast-check.dev) for invariants over
     random inputs (`import fc from 'fast-check'`, with `fcParams()` from `tests/support/fc.ts`);
   - **functional** tests for whole behaviours: a take-off flown by the scripted pilot, geometry
     built in Node and measured, ten minutes of traffic, a whole engagement.
   No `.only`, `.skip` or `todo`: every committed test runs, and a stray `.only` fails the run.
9. **Keep it fast.** The target is 60 fps at 1440×900 on an Apple M2 Max, and no frame over
   50 ms, so budget for slower machines: instancing and merged geometry for repeated objects,
   levels of detail, no per-frame allocations in hot paths, heavy work in web workers or
   time-sliced across frames. `window.sim.perf.systems` shows each system's CPU time and
   `window.sim.render` the draw calls.

## Code style

- TypeScript in strict mode; `npx tsc --noEmit -p .` must report no errors.
- Two-space indentation, LF line endings, a final newline (`.editorconfig`).
- Frame conventions are in `src/types.ts`: world `+X` east, `+Y` up, `+Z` south; body `−Z` is the
  nose. Convert aircraft quantities (angle of attack, sideslip, rates, moments) only with the
  helpers in `src/physics/frames.ts`.
- SI units inside the code. Knots, feet and feet per minute only at the edges, in names that say
  so (`vrKt`, `aglFt`, `hardFpm`).
- A short doc comment on every module and exported function that says what it does and, where it
  matters, the units and frame. Explain *why* in comments, not *what*.
- Rendering: materials keep `fog: true` (it carries the aerial perspective and cloud shadows);
  a custom `ShaderMaterial` calls `ensureAtmosphericFogUniforms` from `src/render/fog.ts`.
  Lighting is HDR with an exposure of about 2.2: judge colours on screenshots.

## Visual QA

Tests prove the numbers; your eyes prove the look. For any visual change, fly it and photograph
it like a player would:

- **Screenshots.** `scripts/shot.mjs` loads a URL in a headless browser, waits, optionally runs
  some JavaScript in the page, saves a PNG and prints console errors and failed requests:
  ```sh
  node scripts/shot.mjs "http://127.0.0.1:8092/?veil=0&aircraft=f16&cam=cockpit&tod=2" qa/tmp/f16-cockpit.png \
    --size 1440x900 --wait 12000 --eval "JSON.stringify({ fps: sim.fps, render: sim.render })"
  ```
  It uses **Google Chrome for Testing** (from Playwright's cache) or Playwright's Chromium, never
  your everyday Google Chrome (`scripts/test-browser.mjs` chooses). `qa/tmp/` is git-ignored;
  photos worth keeping go in `qa/screenshots/` (keep them small).
- **The QA pilot.** `scripts/qa-pilot.js` flies the sim through keyboard events only, like a
  person: `takeoff()`, `climbTo(ft)`, `turn(deg, bank)`, `stallAndRecover()`,
  `approachAndLand()`, `flyToRange()`, `gunRun(id)`, `mavShot(id)`. Inject it into a page with
  Playwright's `page.addScriptTag()` from a script in `qa/tmp/`, using `launchOptions()` from
  `scripts/test-browser.mjs`.
- **Look around.** Check every camera (<kbd>1</kbd>–<kbd>4</kbd>), drag the mouse to look around,
  try the four times of day (`?tod=0` to `3`) and both 1440×900 and 1024×768.
- **Compare with the real thing.** Put your screenshot next to photos of the real aircraft,
  vehicle or place and fix what a pilot would notice first.
- **Preview pages.** `preview/*.html` (served by the dev server, e.g.
  `http://127.0.0.1:8092/preview/f16.html`) show one part of the world on its own: an aircraft
  with three-view drawings (`?ortho=side`), the terrain, the towns, the HUD.

## Pull requests

- One topic per pull request, with a short description of what and why. Open an issue first for
  anything bigger than a small fix, so we can agree on the approach.
- Tests for the change (written first), and `npm run check` passing.
- For visual changes, before/after screenshots.
- No downloaded assets, no runtime network requests, no per-frame allocations in render code.
- Update the docs when you change what they describe: the README's controls table and URL
  options, the guides, and `ARCHITECTURE.md`. `tests/repo/` checks that the README lists every key
  binding and every aircraft, and that every link, path, `CONFIG` path and code name in the docs
  exists. Run `npm run repo-map` after adding, moving or deleting files.
- Commit messages: a short summary line, then what changed and why.

By contributing you agree that your work is released under the project's [MIT licence](LICENSE).
Please follow the [Code of Conduct](CODE_OF_CONDUCT.md). Security problems: see
[SECURITY.md](SECURITY.md).
