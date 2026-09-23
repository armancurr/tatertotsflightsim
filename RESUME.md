# RESUME.md — Flight Simulator: where we are, what's left, how to continue

**Read this first if you are a new agent (or team) picking up this project.**
Last updated: 2026-09-22 (evening) · stop point requested by the owner (JT) · `main` is the only
branch, the tree is clean, no worktrees, **1,432 / 1,432 tests green**, typecheck clean, build OK.

> **Paste this to start a new orchestrator session:**
> You are the AI orchestrator for `/Users/jt/Code/Flight Simulator` (note the space in the path),
> a browser 3D flight simulator (Cessna 172RG, Three.js r186, TypeScript, Vite 8, Vitest 5). The
> spec is `/Users/jt/Code/coeus/EX_PROMPT_7_FLIGHT_SIM.md`. Read `RESUME.md` (this file),
> `ELEVATOR_PITCH.md`, `ARCHITECTURE.md`, `PLAN.md` (agent rules) and skim `RECORD.md` and
> `REPO_MAP.md`. Run `npm test` and `npx tsc --noEmit -p .`, start `npm start` (127.0.0.1:8092) in
> the background, then work through §5 below in waves of up to 10 Opus sub-agents, each in its own
> git worktree on file-disjoint modules, test-first (unit + fast-check fuzz + functional), merging
> each branch into `main` when it reports. Fly and photograph the sim yourself in a **Google Chrome
> for Testing** window — never the owner's own Chrome (§2).

---

## 0. The 60-second version

- **It works end to end.** Load the page → the 172RG sits on runway 36 → take off, climb, turn,
  stall and recover, crash (wreck + fire + smoke) and reset, fly the approach and land (rated
  butter…hard). A keyboard-only QA flight in RECORD.md averaged **59.9 fps** with a clean console.
- **The world is real-looking:** worker-streamed terrain with realistic farmland, forests of
  individual trees (7 species + impostors), hedgerows, grass near the ground, a coastline with
  turquoise shallows and surf, a flowing river, lakes, ~10,600 detailed buildings, a road network
  with markings and bridges, a full airport with a working PAPI, a physically based sky with
  cumulus, cloud shadows on everything, aerial haze, four times of day.
- **Physics** is a pure 6-DOF Cessna 172RG model calibrated to the POH (stall 48/42 kt, Vy climb
  ~700 fpm, glide ~9:1), with ground effect and a squat-switch gear interlock.
- **Not finished** (§5): ships/boats/AI aircraft are simulated but **not drawn**; **no cars** yet;
  volumetric clouds exist but are **off** (too slow); mountains not reshaped; cockpit eye point;
  a GPU-budget pass (the terrain shader was ~4.8 ms before its rewrite and is unmeasured since);
  final visual QA photos at 1440 and 1024; audio never listened to in a browser.

## 1. The bars (run ALL before calling anything done)

```sh
cd "/Users/jt/Code/Flight Simulator"
npm test                    # 142 files, 1,432 tests, ~30 s — unit, fuzz, functional, e2e (headless Chrome for Testing)
npx tsc --noEmit -p .       # 0 errors
npm run build               # vite build OK (one ~1.4 MB main chunk — known, fine)
npm run repo-map            # regenerate REPO_MAP.md after adding/moving files
```

- No `.skip`, `.only` or `todo` anywhere. Heavy functional tests set their own timeouts
  (`vi.setConfig({ testTimeout: … })`) — the suite flakes if many test runs share the CPU (10
  parallel agents pushed the load average to ~90 and dozens of 5 s timeouts appeared; every one
  passed on a quiet machine). Run the final suite with the machine idle.
- Fast-check failures print a seed: replay with `FC_SEED=… FC_PATH=… npx vitest run <file>`
  (`docs/TESTING.md`).

## 2. Environment gotchas (learned the hard way)

- **Never automate the owner's Google Chrome.** On 2026-09-22 automation instances of
  `/Applications/Google Chrome.app` (the Playwright MCP window, and agents' headless screenshots
  with `channel: 'chrome'`) hijacked JT's Dock icon — his normal profile wouldn't open. All
  automation now uses **Google Chrome for Testing** from `~/Library/Caches/ms-playwright/chromium-*`
  (`scripts/shot.mjs` and `tests/support/e2e.ts` refuse to fall back; override with
  `TEST_BROWSER=/path`). **Do not use the Playwright MCP browser tools** (they launch Google Chrome).
  To show JT the sim, open a headed Chrome for Testing window with its own `--user-data-dir`.
- **npm cache is root-owned** (`~/.npm` EACCES): install with
  `npm_config_cache=<scratch>/npm-cache npm install -D <pkg>`.
- **Worktrees:** the Agent tool's `isolation: "worktree"` needs the session cwd to be a git repo
  (it isn't if the session starts in `~/Desktop`) — create them by hand:
  `git worktree add ".worktrees/<n>" -b "wt/<n>" && ln -s "$PWD/node_modules" ".worktrees/<n>/node_modules"`.
  `.worktrees/` is git-ignored; Vite's watch-ignores are anchored to each checkout's root, so a Vite
  server inside a worktree hot-reloads (give each agent its own port 81xx; never 8092).
- **Restart the main dev server after big merges** that delete/rename files — Vite's module graph
  cached `src/world/water.ts` after it became a folder and 404'd.
- **HMR full-reloads reset the sim**: don't play-test on `main` while someone edits it.
- Foreground `sleep` is blocked in the harness: end the turn to wait for agents (you're notified),
  or run `sleep N` with `run_in_background: true` as a fallback timer.

## 3. What exists (all merged on `main`)

| Area | Where | State at the stop point |
| --- | --- | --- |
| Contracts | `src/types.ts`, `src/config.ts`, `src/math`, `src/physics/frames.ts`, `src/world/runway.ts` | ✅ World +X east, +Y up, +Z south; body −Z = nose. One config file for every tunable. |
| Physics | `src/physics` | ✅ 6-DOF C172RG; POH-calibrated; ground effect; gear interlock (1.5 s airborne); crash reasons; trim solver. |
| Input / cameras / loop / `window.sim` | `src/input`, `src/camera`, `src/game` | ✅ Smoothed keys (elevator relaxes slowly), mouse-yoke, gamepad; 4 cameras + transitions; 120 Hz fixed step; `window.sim` with teleport/debug/perf/render. |
| Systems layer | `src/game/systems/*.ts` | ✅ Auto-discovered plug-ins: loading, camerafx, terrain, water, airport, roads, towns, vegetation, grass, fx, audio, hud. `?no=` switches. |
| Terrain | `src/world/terrain`, `fields.ts`, `landcover.ts`, `heightfield.ts` | ✅ Worker quadtree; farmland/towns/rock/snow shader; 8 detail textures; colour geomorph. ⚠️ GPU cost unmeasured after rewrite; mountains not reshaped. |
| Water | `src/world/water/` | ✅ Wave trains, FFT ripples, worker bathymetry (shallows/surf/foam), river ribbon, calm lakes, `waterSurfaceAt()`. ⚠️ River too dark; GPU unmeasured. |
| Sky & rendering | `src/render` | ✅ Physical sky, HDR + reversed depth, filmic tone map, aerial fog, billboard cumulus, **cloud shadows on every material**, smooth shadow filter, sliced env re-bake. ⚠️ Volumetric clouds built but off (3–5 ms). |
| Airport | `src/world/airport` | ✅ Full renderer: pavement, worn FAA paint, tower, hangars, FBO, fuel, windsock, fence, 15 parked aircraft, cars, signs, ~290 lights, 2 working PAPIs, obstacles. |
| Roads | `src/world/roads` | ✅ Junction network, surfaces + markings, farm tracks, bridges + guard rails, ~4,100 street lights, worker streaming, depth pull. ❌ **No cars.** |
| Towns | `src/world/towns` | ✅ ~10,600 buildings: roof archetypes, facade shader, glass towers, churches, farms, dusk windows, worker placement, far LOD. ⚠️ No building shadows from altitude. |
| Trees & grass | `src/world/vegetation`, `src/world/grass` | ✅ 7 leaf-card species, back-lit leaves, impostors, hedgerows/orchards/riparian, grass + flowers near the ground; CPU 5.4 → 0.03 ms. ⚠️ Grass barely visible; some species polish. |
| Traffic | `src/world/traffic` | ⚠️ **Simulated, not drawn**: marina + 214 moored boats, yachts that tack, ferry, container ship, tanker, lake boats, wakes; runway-36 circuits, crossers, helicopter, airliners + contrails; models built. No renderers, no system files. |
| Aircraft | `src/aircraft` | ✅ Finished retractable gear (belly wells, flush stow, door sequence), faint prop disc, wreck state, live panel. ⚠️ Eye point too low, build 1.85 s, no exterior panel lines. |
| HUD / UX | `src/ui` | ✅ Steam gauges (simplified faces < 112 px), compass tape, systems strip, 172RG gear warning (horn + GEAR + squat caution), messages, help, loading veil. |
| Audio / FX | `src/audio`, `src/fx` | ⚠️ Synthesised engine/wind/horns/tyres/crash — **never listened to in a browser**. Fire/smoke reworked (blackbody fire) but sprites still look like discs/icons. |
| Tests | `tests/**`, `docs/TESTING.md` | ✅ 1,432: unit, fast-check fuzz, scripted-pilot missions, keyboard take-off regression, e2e in headless Chrome for Testing. |
| QA tools | `scripts/shot.mjs`, `scripts/qa-pilot.js`, `preview/*.html` | ✅ Headless screenshots; an in-page keyboard-only pilot (`takeoff`, `climbTo`, `turn`, `stallAndRecover`, `flyInto`, `approachAndLand`); per-module preview pages. |

Latest photos: `qa/screenshots/stop-01…04-*.png` (runway chase, cockpit, coast at 1,200 ft, forested
mountains) and `qa/screenshots/airport-*.png`. The wave-3 agents' working screenshots are archived
locally (git-ignored) in `qa/tmp/wave3/<area>/`.

## 4. Done lines of the spec — honest status

| # | Done line | Status |
| --- | --- | --- |
| 1 | Every test passes, none skipped (`npm test`) | ✅ 1,432/1,432 at the stop point |
| 2 | Loads at http://127.0.0.1:8092 ("Flight Simulator") with the aircraft on the runway | ✅ |
| 3 | Full flight flown in Chrome and photographed (take-off roll, climb, left & right turn, stall + recovery, crash + reset, approach, landing) | ⏳ Flown end to end on 2026-09-22 before the wave-3 merges (RECORD.md "Full-flight play test #1"; photos in the git-ignored `qa/tmp/fl-*.png`). **Re-fly and re-photograph with the final visuals into `qa/screenshots/`.** The QA pilot's flare is late (landing rated HARD) — improve `approachAndLand()`. |
| 4 | Every camera view + smooth transitions, photographed | ⏳ All four work; photograph each + a mid-transition frame. |
| 5 | Instruments readable at 1440 and 1024 without covering the view | ⏳ Built for both; 1440 checked live; **1024 live photo still owed**. |
| 6 | `window.sim` fields; smooth fps after a full flight; clean console, no failed requests | ⏳ API ✅; clean console ✅; record `window.sim.perf` after the final full flight. |
| 7 | Suite green after the last change of play testing, perf pass and visual QA | ⏳ Final step. |

## 5. What's left — prioritized

**A. Finish what's half-built (biggest visible gains)**
1. **Traffic renderers** (`src/world/traffic/ships.ts`, `airTraffic.ts` → `createShips`,
   `createAirTraffic`) and system files `src/game/systems/ships.ts`, `airTraffic.ts`: one batched
   mesh for vessels + marina, dynamic wake mesh, spray points, lights; one batched mesh for
   aircraft, prop/rotor discs, lights/far dots, contrail ribbons (~10 draw calls). Traffic clock
   pauses with the sim, `?tt=` override, re-anchor on teleport. Time-slice the 160 ms sea-plan
   validation. The API and plan are in the traffic commit messages (`git log -- src/world/traffic`).
2. **Cars** (`src/world/cars/**`, `src/game/systems/cars.ts`, `world.cars` config): use the roads'
   `activeRoads()` lane graph (pieces, nodes, speed limits) and `RoadSurface.height(piece, s,
   across, hw)`; apply the same lift + depth pull (`DEPTH_GLSL`) in the car shader. Instanced
   sedans/SUVs/pickups/vans/trucks/buses, right-hand traffic, parked cars, dusk headlights.
3. **Volumetric clouds under ~2 ms**, then make them the default: quarter-pixel temporal updates,
   fewer light samples, coarser steps inside clouds, distance LOD on detail noise; tune lighting
   (darker bases, stronger cauliflower detail). Remove or fix `?clouddebug=1`.

**B. Performance (done line 6)**
4. Measure GPU per system (terrain was 4.8 ms at 300–1,500 ft *before* its rewrite — budget 3 ms;
   water budget 1.5 ms; towns 2.5 ms) with the GPU timer queries the sky agent added
   (`?gpu=1`, `?waterGpu=1`). Optimise the worst offenders.
5. **Start-up:** first frame took ~12 s headless because the terrain system's `ready()` runs into
   the 8 s timeout; aircraft build is 1.85 s on the main thread (move livery painting to a worker
   / OffscreenCanvas); airport build 60–68 ms; sea plan 160 ms. The loading veil hides it, but make
   it fast.

**C. Realism polish (owner priority: "as realistic as possible")**
6. **Cockpit:** raise `aircraft.geometry.pilotEye.y` by 0.10–0.15 m; slimmer left door post;
   interior detail (seat fabric, headliner, sun visors, fuel selector, breakers, placards, glass
   reflections); check panel legibility at 1024.
7. **Mountains:** sharper eroded ridges > 10 km north only (the protected-ground snapshot test
   guards everything within 1.5 km of towns/roads/river/lakes/airport); rock texture still looks
   like crazy paving; tri-planar rock on steep faces.
8. **Buildings:** ground shadows for the city seen from altitude (projected footprint pass);
   shadow-caster selection along the sun ray; harbour cranes and container stacks; rooftop masts
   as obstacles; tune `world.towns.chunkSize` (~400) and add a near/far crossfade.
9. **Water:** lighter, more reflective river; shoreline/mountain reflections in lakes; photos of
   the river mouth, lakes, golden hour.
10. **Trees & grass:** taller airfield tufts (0.15–0.3 m) so the grass reads from the chase
    camera; pine pads, birch/poplar shapes, spruce gaps; octahedral impostors; keep trees out of
    town building footprints.
11. **Effects & audio:** regenerate soft, ragged smoke and flame sprites (`smokeTile`,
    `flameTile` in `src/fx/sprites.ts` — two tests for this were removed, restore them first);
    lengthen fireball `heatTau`; run `runAudioSelfTest()` in the live page and tune the mix
    (engine, prop, wind, cabin filter, stall + gear horns, tyres, crash).
12. **Airport:** larger daytime PAPI dots; terminal facade detail; runway overruns with chevrons;
    registrations on parked aircraft; ground vehicles.
13. **Aircraft exterior:** panel-line/rivet normal map, exhaust and oil streaks, wing walkway.
14. **Physics feel:** the final-approach trim solves to ~53 % nose-down trim with flaps 20 at
    72 kt and −3…−4° pitch — plausible with the flap model but unusual for a 172; review
    `cmFlapsFull`/flap pitching. Full-power P-factor drift is realistic but strong for keyboard
    pilots.

**D. Close the spec (done lines 3–7)**
15. Re-fly the full flight with `scripts/qa-pilot.js` in a **Chrome for Testing** window
    (take-off → climb → left/right turns → stall/recover → crash into terrain → reset → Shift+R
    approach → landing, several landings), photograph each at 1440 into `qa/screenshots/`, record
    `window.sim.perf` in RECORD.md.
16. Visual QA at **1440 and 1024**: aircraft, cockpit, terrain, horizon, sky, clouds, lighting and
    shadows, runway/airport, water, HUD — and each camera plus a mid-transition frame; console
    clean. Fix only what a done line names; `npm test` once more; commit.
17. Keep `README.md`, `ARCHITECTURE.md`, `REPO_MAP.md` (`npm run repo-map`), `PLAN.md` and
    `RECORD.md` current.

## 6. Where everything lives

- Entry `index.html` → `src/main.ts` → `src/game/app.ts` (`startApp`: renderer, scene, atmosphere,
  aircraft, physics loop, input, cameras, systems, `window.sim`).
- Plug-ins: `src/game/systems/<name>.ts` (`{ name, order, create(ctx) }`, see
  `src/game/systems/types.ts`).
- Every tunable: `src/config.ts` (sections owned by modules — `aircraft`, `controls`, `camera`,
  `world.*`, `atmosphere`, `render`, `audio`, `hud`, `fx`).
- Full file list with one-line descriptions: `REPO_MAP.md`.
- History, decisions, bugs and their causes: `RECORD.md` (play-test bugs #1 tail-strike crash and
  #2 keyboard take-off settle-back/gear-up, the Chrome hijack, the agent waves).

## 7. How the team worked (repeat what worked)

- **Waves of up to 10 Opus sub-agents** on file-disjoint modules, each in its own git worktree
  (`.worktrees/<name>`, branch `wt/<name>`, own Vite port), with a self-contained brief: role,
  files owned, exact API, realism targets, tests required (unit + fast-check fuzz + functional),
  screenshots to take and **read**, a performance budget, and a report format with the exact merge
  steps.
- Agents commit on their branch; the orchestrator merges into `main`, resolves `src/config.ts`
  section conflicts by keeping both sides, runs the full suite on a quiet machine, and commits.
- The systems layer means agents never edit the same wiring file; `window.sim.teleport` + URL
  `?spawn=` let each agent photograph its subject in the live game.
- The orchestrator flies the sim itself between waves (QA pilot) and forwards bugs to the owning
  agent as failing-test-first requests with concrete numbers.
- Ask agents to wrap up with: finish the step cleanly, suite green, typecheck, stop Vite, commit,
  report (branch, hashes, done, NOT done, config sections touched, known bugs).
