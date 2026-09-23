# Contributing to Tater's Flight Sim

Thanks for helping! Bug reports, ideas, new aircraft, realism fixes and performance work are all
welcome. This page covers the essentials; [ARCHITECTURE.md](ARCHITECTURE.md) explains how the code
fits together and [docs/TESTING.md](docs/TESTING.md) covers the test suite in depth.

## Set up

```sh
git clone https://github.com/<owner>/taters-flight-sim.git
cd taters-flight-sim
npm install
npx playwright install chromium   # the browser the end-to-end tests drive
npm start                         # http://127.0.0.1:8092, hot reload
```

Node.js 22.12 or newer (`nvm use` picks up `.nvmrc`). Any OS works: macOS, Linux or Windows.

## The workflow

1. **Open an issue first** for anything bigger than a small fix, so we can agree on the approach.
2. **Write the test first.** Watch it fail, then make it pass. Most modules have three layers:
   - **unit** tests in `tests/<module>/`, mirroring `src/`;
   - **property / fuzz** tests with [fast-check](https://fast-check.dev) for invariants over
     random inputs;
   - **functional** tests for whole behaviours (e.g. a scripted take-off, a stall and recovery,
     geometry built in Node).
   UI and rendering changes are also checked in the real page (`window.sim`, `scripts/shot.mjs`).
3. **Run everything** before you push:
   ```sh
   npm test           # every test (npx vitest run tests/<dir> for one area while you work)
   npm run check      # typecheck + every test + production build
   ```
   No `.only`, `.skip` or `todo`: every committed test runs (a stray `.only` fails the run).
4. **Keep it procedural.** No downloaded models, textures, sounds or fonts, and nothing fetched at
   runtime: everything is generated in code, so the licence stays simple.
5. **Keep it fast.** The target is 60 fps at 1440×900 on an Apple M2 Max, so budget for slower
   machines. No per-frame allocations in render code, instancing for repeated objects, heavy work
   in workers or time-sliced; `window.sim.perf` shows per-system CPU time.

## Where things go

- Every tunable number lives in `src/config.ts`, in the section that belongs to its module.
- Frame conventions (world +X east, +Y up, +Z south; body −Z is the nose) are in `src/types.ts`.
  Use the helpers in `src/physics/frames.ts` instead of rolling your own.
- New world features are plug-ins in `src/game/systems/` (they are discovered automatically).
- New aircraft: a config section, a model under `src/aircraft/`, and one entry in
  `src/fleet/index.ts`.

## Screenshots

`npm run shot -- "http://127.0.0.1:8092/?veil=0" qa/tmp/my-shot.png --size 1440x900 --wait 8000`
takes a headless screenshot and prints console errors. It uses Chrome for Testing or Playwright's
Chromium, never your everyday Chrome. `qa/tmp/` is git-ignored; put photos worth keeping in
`qa/screenshots/` (keep them small).

## Pull requests

- One topic per pull request, with a short description of what and why.
- Tests for the change, and `npm run check` passing.
- For visual changes, a before/after screenshot.
- By contributing you agree that your work is released under the project's [MIT licence](LICENSE).

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
