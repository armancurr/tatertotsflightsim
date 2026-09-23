# Testing

Everything runs through Vitest: `npm test` (= `npx vitest run`) runs every layer, including the
browser end-to-end tests. `npx tsc --noEmit -p .` typechecks the tests along with `src/`.
`npm run check` does both and the production build. There are about 280 test files; with a GPU the
whole suite takes a few minutes.

## Layers

| Layer | Where | What it proves |
| --- | --- | --- |
| Unit | `tests/<module>/` (mirrors `src/`) | Each module's contract, written test-first |
| Property (fuzz) | `tests/fuzz/*.fuzz.test.ts`, and `fc.assert` properties inside the module folders (about 170 files use fast-check) | Invariants over thousands of random inputs |
| Functional | `tests/functional/*.test.ts` and `*.functional.test.ts` in the module folders | Whole behaviours: missions flown by a scripted pilot against the real `step()`, geometry built in Node and measured, minutes of road traffic, the target range planned on the real world, whole air engagements |
| End-to-end | `*.e2e.test.ts` (`tests/e2e/`, `tests/ui/`, `tests/world/…`, `tests/audio/`) | The real page in headless Chrome for Testing (GPU where there is one): keyboard in, `window.sim` out |
| Repository | `tests/repo/*.test.ts` | Open-source readiness and docs that match the code (below) |

Shared helpers live in `tests/support/`:

- `pilot.ts`: `ScriptedPilot`, cascaded PID loops that turn targets (pitch, bank, IAS, vertical
  speed, altitude, heading, glide path, flare, runway centreline) into `Controls`. `flyPhase()`
  steps the physics at 120 Hz until a condition holds and returns per-phase stats.
- `envs.ts`: test worlds. `RUNWAY_FLAT_ENV` is flat, with the real runway rectangle and grass
  elsewhere. `HILLY_ENV` has the airport plateau at field elevation, sine hills, a ridge to the
  west (x < −2.5 km) and a lake to the east (centre 4.5 km, −1.5 km).
- `arbitraries.ts`: fast-check generators (unit quaternions, attitudes, controls, control segments,
  hostile numbers).
- `invariants.ts`: `stateViolation()`, `controlsViolation()`, `firstNonFinite()`, `deepFreeze()`.
- `e2e.ts`: a private Vite server (free port, 127.0.0.1, dependency cache in the OS temp dir),
  the browser launcher (`launchChrome()`, `testBrowserPath()`; the choice itself lives in
  `scripts/test-browser.mjs`, shared with `scripts/shot.mjs`), `detectGpu()`, `waitForSim()`
  polling with a time scale for slow renderers, and a recorder for console, page and request errors.
- `fc.ts`: `fcParams(numRuns)` applies the environment knobs below to every property.

### Fuzz coverage
math (quaternion length/inverse/composition, integration norm, slerp, wrap/clamp/moveToward/
expApproach); frames (euler↔quat, sign conventions, α/β ranges and reconstruction, pqr/LMN
bijections); runway coordinates (real and random runways); the control system (random held/pressed
keys, Shift, mouse, gamepad, hostile numbers, dt 0 to 0.25 s, determinism, release returns the
yoke to 0); the camera rig (±50 km trajectories, teleports, mode switches, ground clearance,
transitions finish); the loop, fps and interpolation; `window.sim` snapshots; physics for every
aircraft (random control sequences and a randomly commanded pilot for 60 to 300 s from the runway,
from the approach and from random airborne states, over flat, runway and hilly worlds, with every
invariant checked after every step; also determinism, hostile controls, dt edge cases, energy with
the engine off, and dive overspeed). The module folders add properties for the gauges and HUD, the
weapons and missiles, the target range layout and convoy, the enemy aircraft, the world (terrain,
landcover, towns, roads, airport, water, traffic, cars), the crash and the effects.

### Functional missions
take-off and climb to 1,500 ft at Vy (flat and hilly worlds) · 90° left and right turns within
±150 ft · power-off stall and recovery (loses less than 500 ft) · flight into the western ridge
("Hit terrain"), then a reset gives a clean runway state · approach, flare, landing and braking to
a stop (three worlds) · gear-up landing ("Gear-up landing") · ditching in the lake ("Ditched in
water") · a keyboard take-off through the real input path · the QA pilot's flare. Per aircraft:
the F-16 and A-10 accuracy tables and missions in `tests/physics/`, and their model tests (budget,
break-up, crash and reset) in `tests/aircraft/f16/` and `tests/aircraft/a10/`.

### End-to-end
`tests/e2e/app.e2e.test.ts`: title · no console, page or request errors during load and 5 s of
running · types and initial values of `window.sim` · W throttle and acceleration · R reset ·
P pause/resume · 1 to 4 and C cameras · F/V flaps · Shift+R approach · G gear in the air · resize
from 1440×900 to 1024×768 · fps > 20 (on a GPU). `tests/e2e/robustness.e2e.test.ts` runs the
**production build** under the GitHub Pages sub-path: a clean boot, no leaks across aircraft
switches and resets, resizes and pixel ratios, a hidden tab resuming cleanly. The others check the
menu, the weapons HUD, the towns, the water and traffic shaders, and the audio self-test in the
real browser. The long A-10 sortie is opt-in:
`npx vitest run -c tests/e2e/sortie.vitest.config.ts`.

The e2e tests use only `window.sim`, the keyboard, the title and the size of the largest canvas,
so they keep working as the game changes underneath them.

### Repository
`tests/repo/meta.test.ts`: package metadata, LICENSE, community files, the CI workflows, and a
README that tells a newcomer how to start and **lists every key binding** in
`CONFIG.controls.keys`. `tests/repo/license.test.ts`: MIT end to end, including every runtime
dependency. `tests/repo/hygiene.test.ts`: no personal paths, credentials or e-mail addresses in
tracked files, small screenshots. `tests/repo/browser.test.ts`: the test-browser resolution order.
`tests/repo/docs.test.ts`: in the README, CONTRIBUTING, ARCHITECTURE, ELEVATOR_PITCH and every
guide in `docs/`, every relative link resolves, every repository path in a code span exists,
every `CONFIG.…` path is real, and every function, type and constant named in a code span exists
in the source; the README names every aircraft in the fleet and links every guide. A guide
declares the files and names its worked example asks you to create in an
`<!-- examples: … -->` comment.

## Running one layer

```sh
npx vitest run tests/fuzz            # property tests
npx vitest run tests/functional      # missions
npx vitest run tests/e2e             # browser (run `npx playwright install chromium` once)
npx vitest run tests/repo            # open-source readiness and docs checks
npx vitest run tests/physics         # one module's unit tests
npx vitest run -t "stall"            # by test name
```

## The test browser, GPUs and CPU-only machines

The e2e tests and `scripts/shot.mjs` pick their browser in `scripts/test-browser.mjs`. They never
use your everyday Google Chrome, because an automation instance of it takes over the Dock icon
until it quits. The order is:

1. `TEST_BROWSER=/path/to/chromium` if it is set. A path to Google Chrome itself is refused.
2. On macOS, the newest *Google Chrome for Testing* in the Playwright cache
   (`~/Library/Caches/ms-playwright`, or `PLAYWRIGHT_BROWSERS_PATH`). It runs WebGL on the Metal
   GPU (`--use-angle=metal`).
3. Otherwise, Playwright's own Chromium (`npx playwright install chromium`; on Linux add
   `--with-deps` for the system libraries). It uses a GPU if there is one and SwiftShader (CPU
   WebGL) if not.

On a CPU-only machine, such as a GitHub Actions runner, SwiftShader draws this game at well under
1 fps. The sim advances at most 1/12 s of flight per rendered frame, so it runs much slower than
real time. The e2e suite detects a software renderer (`detectGpu()`) and adapts:

- every `waitForSim` timeout is multiplied by 120;
- the fps floor drops from 20 to "renders at all";
- the take-off run only needs to gain 2 knots instead of 10.

Every test still runs, but the e2e file takes minutes instead of seconds: about 13 minutes on an
M2 Max forced to SwiftShader (`TEST_SOFTWARE_GL=1`), and longer on a 4-core CI runner.

| Variable | Effect |
| --- | --- |
| `TEST_BROWSER` | Chromium binary to launch |
| `TEST_SOFTWARE_GL=1` | Force SwiftShader on any machine, to reproduce a CI run locally |
| `E2E_TIME_SCALE=<n>` | Multiply every `waitForSim` timeout by at least `n` (a very slow machine) |

## Continuous integration

`.github/workflows/ci.yml` runs on every push and pull request, on Linux with two Node versions:
the typecheck, every test except the browser ones
(`npx vitest run --exclude "**/*.e2e.test.ts"`), the production build, and a build under the
GitHub Pages sub-path that checks every URL carries the `--base` prefix. GitHub's runners have no
GPU, so the browser end-to-end tests run in a separate job, nightly and on demand (*Actions → CI →
Run workflow*); there they take 30–60 minutes.

## fast-check knobs and reproducing a failure

A failing property prints a report like this:

```
Error: Property failed after 47 tests
{ seed: 2110012652, path: "46:0:12:2:…", endOnFailure: true }
Counterexample: [-20, 0.85, false]
```

To replay exactly that counterexample, already shrunk:

```sh
FC_SEED=2110012652 FC_PATH="46:0:12:2:…" npx vitest run tests/fuzz/physics.fuzz.test.ts -t "held dive"
```

- `FC_SEED` replays the same random stream. `FC_PATH` jumps straight to the shrunk case.
  `FC_VERBOSE=1` prints each shrink step.
- `FC_RUNS_SCALE=10` runs every property 10 times as often, for a soak run. Add `--testTimeout=0`,
  because the default 5 s timeout of the cheap properties is sized for scale 1.
- Put the counterexample into a plain `it()` as a regression test once the owner fixes the bug.

## Rules

- No `.skip`, `.only` or `todo` (`allowOnly: false`). Every committed test passes.
- Heavy tests (building a whole town, minutes of traffic, a long flight) set an explicit timeout.
  Timing-sensitive tests can still flake on a very busy machine: re-run a failure on its own
  before investigating, and run the final suite on an idle machine.
- A bug-finding test that fails because of someone else's module is not committed. Its minimal
  counterexample goes to the owner, then it comes back as a regression test after the fix.
