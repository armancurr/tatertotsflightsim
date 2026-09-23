# RESUME.md — Tater's Flight Sim: where we are, what's left, how to continue

**Read this first if you are a new agent (or team) picking up this project.**
Last updated: 2026-09-22 (late) · release candidate for open-sourcing · `main` is the only branch.

> **Paste this to start a new orchestrator session:**
> You are the AI orchestrator for Tater's Flight Sim (this repository), a browser 3D flight
> simulator with three aircraft — Cessna 172RG, F-16C, A-10C — built with Three.js r186,
> TypeScript, Vite 8 and Vitest 5. Read `RESUME.md` (this file), `ELEVATOR_PITCH.md`,
> `ARCHITECTURE.md`, `PLAN.md` (agent rules) and skim `RECORD.md` and `REPO_MAP.md`. Run
> `npm test` and `npx tsc --noEmit -p .`, start `npm start` (127.0.0.1:8092) in the background, then
> work through §5 in waves of up to 10 sub-agents, each in its own git worktree on file-disjoint
> modules, test-first (unit + fast-check fuzz + functional), merging each branch into `main` when it
> reports. Fly and photograph the sim yourself in a **Google Chrome for Testing** window — never
> the owner's own browser (§2).

---

## 0. The 60-second version

- **It works end to end, in three aircraft.** Pick the Cessna 172RG, F-16C or A-10C from the
  dropdown at the top right (or `?aircraft=`). Take off, fly, stall, spin, crash (the aircraft
  breaks apart with a fireball), reset with R, and land (rated butter … hard).
- **Combat:** the A-10C's 30 mm GAU-8/A and the F-16's M61A1 fire real ballistic rounds (hold Q);
  both jets carry AGM-65 Mavericks (T picks a target, Z fires — an **arcade** model, deliberately
  not a guidance simulation). A target range north of the airport has 23 vehicles (T-72B, BMP-2,
  BTR-80, Ural, ZSU-23-4) with armour by aspect, turret-toss wrecks, fires and smoke columns.
- **The world:** worker-streamed terrain and farmland, forests of individual trees, towns with
  ~10,600 buildings, roads with moving and parked cars, a coast with surf, a marina, ships with
  wakes, other aircraft with contrails, volumetric clouds with shadows, four times of day.
- **Physics:** a pure 6-DOF model per aircraft, calibrated to published numbers (tables in
  `tests/physics/*accuracy*`, `a10*.test.ts`): stall/spin, ground effect, fly-by-wire for the F-16,
  gun recoil, jet engines with spool lag.
- **Instruments:** steam gauges (Cessna) or a jet HUD (F-16, A-10) with the weapons symbology
  (gun cross, CCIP pipper, lock box, stores, kills), a G meter for every aircraft, sound for all of it.

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
| Contracts | `src/types.ts`, `src/config.ts`, `src/physics/frames.ts` | ✅ World +X east, +Y up, +Z south; body −Z = nose. One config file for every tunable (per-aircraft sections + weapons). |
| Physics | `src/physics` | ✅ 6-DOF per aircraft; C172RG POH-calibrated; F-16 with FBW, afterburner, Mach drag; A-10 with TF34 spool, decelerons; stalls/spins; recoil; crash reasons. |
| Fleet | `src/fleet`, `src/aircraft/{f16,a10}` | ✅ Three aircraft, registry-based (add one = config section + model folder + one entry). |
| Combat | `src/combat`, systems `weapons`, `missiles`, `targets`, `combatfx`, `weaponsHud` | ✅ Gun ballistics, HEI splash, ricochets, CCIP; arcade Mavericks; 23-vehicle range; wrecks; impact/explosion effects and sound. ⚠️ The convoy doesn't drive yet (halted in line). |
| Crash | `src/crash`, system `crash` | ✅ Break-up rigid bodies, fireball, secondaries, debris, smoke, slow-mo camera, exact reset. |
| World | `src/world/**` | ✅ Terrain, water, airport, roads, towns, vegetation, grass, ships, air traffic, cars. |
| Sky & rendering | `src/render` | ✅ Physical sky, HDR, volumetric clouds (default, ~0.3–0.7 ms) with cloud shadows. |
| HUD / UX | `src/ui` | ✅ Steam gauges, jet HUD, weapons HUD, G meter, menu with every control, aircraft picker, help, loading veil. |
| Audio / FX | `src/audio`, `src/fx` | ✅ Piston, jet and turbofan engines; GAU-8 "BRRRT" with speed-of-sound delay; noise-animated fire and smoke. |
| Tests | `tests/**` | ✅ Unit, fast-check fuzz, functional (scripted and keyboard pilots), e2e in headless Chrome for Testing. |
| QA tools | `scripts/shot.mjs`, `scripts/qa-pilot.js`, `preview/*.html` | ✅ Screenshots; a keyboard-only pilot with per-aircraft profiles and a proper flare; preview pages per module (`?ortho=` 3-views for the jets). |

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

1. **Convoy movement** (`src/combat/targets`): the column halts in line because the track-loop
   search fails in hedgerow country; drive it along the lanes/road graph instead, halt after a
   kill, scatter. Also draw the earth berms, animate wheels/tracks and the ZSU radar dish.
2. **F-16 performance gaps:** sustained turn at M 0.8 (17.3 °/s vs 18–20) and sea-level climb
   (~40,000 vs 50–60,000 fpm) — add an inlet thrust-loss term at high Mach in `src/physics/jet.ts`,
   then raise afterburner thrust around M 0.8–0.9 (tests in `tests/physics/f16-accuracy.test.ts`
   pin today's values with notes).
3. **F-16 landing:** at 13° AoA the pitch sits at the tail-strike protection (12°), leaving no
   flare margin; the stopping distance from 155 kt (~1,700 m) is too long for the 1,600 m runway —
   review the F-16 brakes and the ground-pitch limit.
4. **Cessna final-approach trim** (~53 % nose-down with flaps 20) — review `cmFlapsFull`.
5. **Vehicle looks:** paint too flat/bright up close; the fireball of a vehicle kill is blobby;
   dusk ground glow from explosions is weak.
6. **Performance on a quiet machine:** re-measure fps in combat (target ≥ 55 at 1440×900 on an
   M2 Max), the Maverick picture-in-picture GPU cost, and the full suite.
7. **F-16 cockpit interior:** only the HUD combiner is new — the glareshield, MFD bezels,
   up-front controls, side-stick/throttle and canopy sills still need the realism pass the Cessna
   and A-10 cockpits got. The Cessna's windshield posts are still wide flat beige bands, and its
   rebuilt glareshield touches the sightline to the cowling for a head 3 cm below the eye point
   (the property test in `tests/aircraft/cockpitView.test.ts` covers ±2 cm); the A-10's
   HUD glass sits a little low (the horizon rides its top edge in level cruise).
8. **Vehicle visibility from altitude:** at 700 m+ the tanks are tiny and low-contrast (the HUD
   diamonds find them). Add soft contact shadows — a transparent ground blob was painted over by
   the terrain pass and a hashed-alpha one looked speckled; try a decal in the terrain shader.
9. **Keyboard gunnery:** the A-10 needs ~10° nose-down trim at 280–300 kt; the QA pilot's
   `gunRun()` doesn't converge the pipper yet; T can jump between neighbouring tanks in a tight
   platoon (every press restarts the lock timer).
10. **Known rare bugs:** a car-car overlap at unusual junction shapes (the cars property test is
    pinned to a seed until it's fixed); a WebGL "feedback loop formed between Framebuffer and active
    Texture" warning on the A-10 range pages (suspect the Maverick picture-in-picture render).
11. **Publishing:** replace `<owner>` in `README.md`, `package.json`, `CONTRIBUTING.md`; CI on
    CPU-only runners is slow (the e2e tests take 25–45 min); Windows is untested. The long A-10
    sortie e2e is opt-in: `npx vitest run -c tests/e2e/sortie.vitest.config.ts`.

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
