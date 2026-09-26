# RESUME.md — Tater's Flight Sim: where we are, what's left, how to continue

**Read this first if you are a new agent (or team) picking up this project.**
Last updated: 2026-09-23 · release candidate for open-sourcing · `main` is the only branch.

> **Paste this to start a new orchestrator session:**
> You are the AI orchestrator for Tater's Flight Sim (this repository), a browser 3D flight
> simulator with four aircraft — Cessna 172RG, F-16C, A-10C, Boeing 747-400 — built with Three.js r186,
> TypeScript, Vite 8 and Vitest 5. Read `RESUME.md` (this file), `ELEVATOR_PITCH.md`,
> `ARCHITECTURE.md`, `PLAN.md` (agent rules) and skim `RECORD.md` and `REPO_MAP.md`. Run
> `npm test` and `npx tsc --noEmit -p .`, start `npm start` (127.0.0.1:8092) in the background, then
> work through §5 in waves of up to 10 sub-agents, each in its own git worktree on file-disjoint
> modules, test-first (unit + fast-check fuzz + functional), merging each branch into `main` when it
> reports. Fly and photograph the sim yourself in a **Google Chrome for Testing** window — never
> the owner's own browser (§2).

---

## 0. The 60-second version

- **Four aircraft**, picked from the dropdown at the top right (or `?aircraft=c172rg|f16|a10|b747`):
  Cessna 172RG, F-16C, A-10C and a Boeing 747-400 (flown light, ~220 t). Each has its own
  calibrated 6-DOF flight model, 3D model, realistic cockpit (the 747: a glass flight deck with live
  PFD/ND/EICAS) and HUD style (steam gauges, jet HUD drawn on the combiner glass, airliner glass).
  Take off, fly, stall, spin, crash (break-up + fireball), reset with R, land (rated butter … hard).
- **A vessel** (branch `feat/watercraft-princess-v50`): the **Princess V50** motor yacht
  (`?aircraft=v50`) starts moored at a visitors' berth in the Port Chateau marina (R) or underway
  offshore (Shift+R). A hull model for any boat or ship (`src/physics/hull.ts`: buoyancy on the
  drawn Gerstner sea, Savitsky planing, Clarke manoeuvring, propellers and pods), a helm HUD, a
  marine diesel voice, wake and spray. Next: harbour sheltering (shader + physics together), more
  vessels (`docs/ADDING_A_VESSEL.md`), docks for big ships, sinking wrecks.
- **Two runways**: 36/18 and the crosswind 03/21 at 30° (`?rwy=36|18|03|21`), a busy GA airport.
- **Combat** (F-16, A-10): real ballistic guns (hold Q), and **arcade** missiles — T locks what you
  point at, Z fires a Maverick at a vehicle or a Sidewinder at an aircraft (scripted flight, deliberately
  not a guidance simulation). A tank range north of the airport (23 vehicles, a convoy that drives,
  scatters and regroups, armour by aspect, turret-toss wrecks) and 8 enemy aircraft (MiG-29 CAP pairs,
  Su-25 attack passes, low Mi-24s) that evade with flares, burn and fall when shot down.
- **The world:** photographic farmland and mountains, forests of varied trees, towns with ~11,000
  buildings and ~19,000 garden/street trees, roads with moving and parked cars, rivers and lakes that
  reflect the land, a coast with a marina, harbour crane and ships, AI traffic, volumetric clouds,
  auto-exposure and bloom, four times of day, sound for everything.
- **Built to last:** ~3,100 tests (unit, fast-check fuzz, functional, e2e in Chrome for Testing), a
  plug-in systems layer, one config file, MIT license (guarded by a test), docs for contributors
  (`CONTRIBUTING.md`, `docs/ADDING_*.md`).

## 1. The bars (run ALL before calling anything done)

```sh
npm test                    # unit, fuzz, functional, e2e (headless Chrome for Testing)
npx tsc --noEmit -p .       # 0 errors
npm run build               # vite build
npm run repo-map            # regenerate REPO_MAP.md after adding/moving files
```

- No `.skip`, `.only` or `todo` anywhere. Heavy tests set explicit timeouts. **The suite flakes
  under heavy CPU load** (10 parallel agents pushed the load average to ~50 and timing tests in
  `tests/world/**` failed); run the final suite on an idle machine.
- Fast-check failures print a seed: replay with `FC_SEED=… FC_PATH=… npx vitest run <file>`
  (`docs/TESTING.md`).

## 2. Environment gotchas (learned the hard way)

- **Never automate the owner's everyday Google Chrome.** Automation that launched the regular
  Chrome app (Playwright `channel: 'chrome'`, the Playwright MCP browser) hijacked the owner's Dock
  icon and profile. All automation uses **Google Chrome for Testing** from Playwright's cache
  (`scripts/test-browser.mjs`; `scripts/shot.mjs` and `tests/support/e2e.ts` refuse to fall back;
  override with `TEST_BROWSER=/path`).
- **npm cache permissions:** if `npm install` fails with EACCES on the cache, point
  `npm_config_cache` at a writable folder.
- **Worktrees:** create them by hand when the session isn't started inside the repo:
  `git worktree add ".worktrees/<n>" -b "wt/<n>" && ln -s "$PWD/node_modules" ".worktrees/<n>/node_modules"`.
  `.worktrees/` is git-ignored. Give each agent its own Vite port (81xx; never 8092).
- **Restart the main dev server after big merges** that add, delete or rename files.
- **HMR full-reloads reset the sim**: don't play-test on `main` while someone edits it.
- **Safety stop on weapons realism:** a sub-agent was stopped by a safety classifier while writing
  real-world missile guidance (proportional navigation with real seeker parameters). The project
  replaced it with an arcade scripted flight (`src/combat/missile.ts`). **Do not reintroduce
  real guidance laws or seeker models**; keep weapons game-level.

## 3. What exists (all merged on `main`)

| Area | Where | State |
| --- | --- | --- |
| Contracts | `src/types.ts`, `src/config.ts`, `src/physics/frames.ts` | ✅ World +X east, +Y up, +Z south; body −Z = nose. One config file (per-aircraft sections + weapons + combat). |
| Physics | `src/physics` | ✅ 6-DOF per aircraft; C172RG POH-calibrated; F-16 FBW/afterburner/Mach drag; A-10 TF34 spool + decelerons + recoil; 747 spoilers/ground spoilers, per-notch flap placards, tail-strike scrape; stalls/spins; crash reasons. |
| Fleet | `src/fleet`, `src/aircraft/{f16,a10,b747}` + the Cessna at `src/aircraft` | ✅ Four aircraft, registry-based (see `docs/ADDING_AN_AIRCRAFT.md`). Realistic cockpits for all four. |
| Combat | `src/combat`, systems `weapons`, `missiles`, `targets`, `airTargets`, `combatfx`, `weaponsHud` | ✅ Guns, arcade Mavericks + Sidewinders, tank range with a driving convoy, 8 enemy aircraft, effects and sound. |
| Crash | `src/crash` | ✅ Break-up, fireball, debris, smoke, slow-mo camera, exact reset. |
| World | `src/world/**` | ✅ Terrain (photographic crops/mountains), water (reflective rivers/lakes, reeds), airport (two runways), roads, towns, vegetation, grass, ships, air traffic, cars. |
| Rendering | `src/render` | ✅ HDR, volumetric clouds, auto exposure + metering + white balance + bloom, quality presets (`?quality=`), log-depth fallback for Firefox/Safari, context-loss handling. |
| HUD / UX | `src/ui` | ✅ Steam gauges, jet HUD (on the glass in the cockpit), airliner glass HUD, weapons HUD with a no-overlap text placer, G meter, menu, picker, help, loading veil + error cards. |
| Audio / FX | `src/audio`, `src/fx` | ✅ Piston, jet and turbofan engines, GAU-8 with speed-of-sound delay, enemy aircraft with Doppler, noise-animated fire/smoke. |
| Tests | `tests/**`, `docs/TESTING.md` | ✅ ~3,100: unit, fuzz, functional (scripted + keyboard pilots), e2e; docs/links/license guards. |
| Docs | `README.md`, `CONTRIBUTING.md`, `docs/*.md`, `ARCHITECTURE.md`, `ELEVATOR_PITCH.md`, `REPO_MAP.md` | ✅ Newcomer README with a gallery (`docs/screenshots/`), contributor guides with verified examples. |

## 4. Done lines of the original spec — status

| # | Done line | Status |
| --- | --- | --- |
| 1 | Every test passes, none skipped | ✅ on an idle machine (timing tests flake under heavy load) |
| 2 | Loads at http://127.0.0.1:8092 with the aircraft on the runway | ✅ |
| 3 | Full flight flown and photographed | ✅ flown by the orchestrator and the QA pilot (RECORD.md) |
| 4 | Every camera view + smooth transitions | ✅ |
| 5 | Instruments readable at 1440 and 1024 | ✅ |
| 6 | `window.sim` fields, smooth fps, clean console | ✅ |
| 7 | Suite green after the last change | ✅ at the release commit |

## 5. What's left — prioritized

**P1**
1. **Performance at full quality** (M2 Max, Chrome for Testing, 1440×900, load ~5). The terrain pass
   (class ranking from plain vectors instead of a dynamically indexed array; auto quality steps MSAA
   4 → 2 → 0 below 85 % of the resolution cap) brought default `auto` quality to runway ~65 fps,
   Taterville 900 ft ~59 fps (was 41), farmland 1,500 ft ~60–68, mountains 75–93, Port Chateau
   60–69 — same picture (mean pixel difference 0.02–0.04/255). Still open: at `quality=high`
   (4× MSAA fixed) the terrain costs ~9–10 ms over towns (Taterville ~42 fps); p95 frame 20–25 ms with
   occasional 60–65 ms streaming spikes. Next levers: shade terrain colour once per pixel (deferred
   albedo pass, removes the MSAA multiplier), coarser distant lowland meshes (+3–7 fps, softer
   distant forest edges), less branching in the field shader. `?dyn=0&msaa=N` pins both for A/B runs.
2. **QA pilot script** (`scripts/qa-pilot.js`, tooling only — the sim is fine): `stallAndRecover()`
   pushes to −2 g and over-stresses the A-10/747; `mavShot()` can fail to lock from `?spawn=range`;
   `gunRun()` in the F-16 can descend too low on the outbound leg; `turn()`/`climbTo()` don't avoid
   terrain (jets heading north at 2,500 ft AGL hit the mountains).

**P2**
3. F-16 landing: stops only ~6 m before the end of runway 36 after a butter landing (brakes /
   ground-pitch limit, `tests/physics/f16-accuracy.test.ts` notes); sustained turn (17.3 vs 18–20 °/s)
   and sea-level climb (~40k vs 50–60k fpm) slightly low — needs an inlet thrust-loss term.
4. The 747 on runway 03 (1,200 m) needs the whole runway (lift-off at ~1,200 m) — use 36.
5. Hedgerow trees run onto the beach sand at the coast; the terrain's golden-hour ground is dark.
6. Combat tuning: an A-10 burst can hit a Mi-24 7 times without a kill (80 health, 30 mm ≈ 9/hit from behind).
7. Cars: the airport car park still uses its own simple models (`src/world/airport/vehicles.ts`); a
   harbour car park sits on the beach; ship superstructures are stacked blocks.

**P3**
8. Jet HUD shows AOA 180 / M 0.00 after a crash; the crash banner says "Hit an obstacle" for
   buildings as well as trees; "IN RNG" shows under the gun cross while parked; convoy trucks pivot
   180° on the spot at the lane end; no flaps-1 gate on the 747 lever; help header says "Cutlass RG".
9. Close-up realism: trees at 50–150 ft still read stylised; F-16 armrest/thighs blocky; 747 flight
   deck furniture boxy; upper-deck window count; tractor tyres without lugs.
10. Publishing: replace `<owner>` in `README.md`, `package.json`, `CONTRIBUTING.md`; CI runs fast
    tests on push and the browser e2e nightly (CPU runners are slow); WebKit/Firefox were reviewed
    and emulated (log depth) but not run; Windows untested.

## 6. Where everything lives

- Entry `index.html` → `src/main.ts` → `src/game/app.ts` (`startApp`: renderer, scene,
  atmosphere, aircraft, physics loop, input, cameras, systems, `window.sim`).
- Plug-ins: `src/game/systems/<name>.ts` (`{ name, order, create(ctx) }`; hooks in
  `src/game/systems/types.ts`, including `adjustControls` and `postRender`).
- Combat: `src/combat/world.ts` (targets, hits, events, status) — see ARCHITECTURE.md §9c.
- Every tunable: `src/config.ts`. Full file list: `REPO_MAP.md`. History and bugs: `RECORD.md`.

## 7. How the team worked (repeat what worked)

- **Waves of up to 10 sub-agents** on file-disjoint modules, each in its own git worktree
  (`.worktrees/<name>`, branch `wt/<name>`, own Vite port), with a self-contained brief: role,
  files owned, exact contracts, realism targets, tests required (unit + fast-check fuzz +
  functional), screenshots to take and **read**, a performance budget, a deadline, and a report
  format with merge notes.
- **The orchestrator writes the shared contracts first** (types, config sections, the combat
  world, system hooks), tested and committed, so agents can build in parallel against them.
- Agents commit on their branch; the orchestrator merges into `main`, keeps both sides of
  `src/config.ts` section conflicts, runs the suites and commits.
- The orchestrator flies the sim itself between waves and forwards bugs to the owning agent with
  measured numbers.
