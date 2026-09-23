# Testing

Everything runs through Vitest: `npm test` (= `npx vitest run`) runs every layer, including the
browser e2e tests. `npx tsc --noEmit -p .` typechecks the tests along with `src/`.

## Layers

| Layer | Where | What it proves | Speed |
| --- | --- | --- | --- |
| Unit | `tests/<module>/` (mirrors `src/`) | Each module's contract, written by the module's owner test-first | ms |
| Fuzz / property | `tests/fuzz/*.fuzz.test.ts` | Invariants over thousands of random inputs (fast-check) | ~15 s total |
| Functional | `tests/functional/*.test.ts` | Whole missions flown by a scripted pilot against the real `step()` | < 1 s |
| End-to-end | `tests/e2e/*.e2e.test.ts` | The real page in headless Chromium (GPU where there is one), keyboard in, `window.sim` out | ~15 s with a GPU |
| Repository | `tests/repo/*.test.ts` | Open-source readiness: package metadata, LICENSE, CI, a README that documents every key binding, no personal paths or secrets, the test-browser resolution order | < 1 s |

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
transitions finish); the loop, fps and interpolation; `window.sim` snapshots; physics (random
control sequences and a randomly commanded pilot for 60 to 300 s from the runway, from the
approach and from random airborne states, over flat, runway and hilly worlds, with every invariant
checked after every step; also determinism, hostile controls, dt edge cases, energy with the engine
off, and dive overspeed).

### Functional missions
take-off and climb to 1,500 ft at Vy (flat and hilly worlds) · 90° left and right turns within
±150 ft · power-off stall and recovery (loses less than 500 ft) · flight into the western ridge
("Hit terrain"), then a reset gives a clean runway state · approach, flare, landing and braking to
a stop (three worlds) · gear-up landing ("Gear-up landing") · ditching in the lake ("Ditched in
water").

### E2E
title · no console, page or request errors during load and 5 s of running · types and initial
values of `window.sim` · W throttle and acceleration · R reset · P pause/resume · 1 to 4 and C
cameras · F/V flaps · Shift+R approach · G gear in the air · resize from 1440×900 to 1024×768 ·
fps > 20 (on a GPU). The e2e tests use only `window.sim`, the keyboard, the title and the size of the largest
canvas, so they keep working when the interim build is swapped for the full app.

## Running one layer

```sh
npx vitest run tests/fuzz            # property tests
npx vitest run tests/functional      # missions
npx vitest run tests/e2e             # browser (run `npx playwright install chromium` once)
npx vitest run tests/repo            # open-source readiness checks
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

- every `waitForSim` timeout is multiplied by 60;
- the fps floor drops from 20 to "renders at all";
- the take-off run only needs to gain 2 knots instead of 10.

Every test still runs, and the suite takes minutes instead of seconds.

| Variable | Effect |
| --- | --- |
| `TEST_BROWSER` | Chromium binary to launch |
| `TEST_SOFTWARE_GL=1` | Force SwiftShader on any machine, to reproduce a CI run locally |
| `E2E_TIME_SCALE=<n>` | Multiply every `waitForSim` timeout by at least `n` (a very slow machine) |

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
- A bug-finding test that fails because of someone else's module is not committed. Its minimal
  counterexample goes to the owner, then it comes back as a regression test after the fix.
