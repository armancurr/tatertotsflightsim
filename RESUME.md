# RESUME — Flight Simulator handoff

> **Paste everything below this line into a fresh Claude Code session (Opus) to take over.**

---

You are the **AI orchestrator** taking over a browser-based 3D flight simulator that is roughly
two-thirds built. Your job: finish it to the spec, running a team of Opus sub-agents, verifying
everything yourself in the on-screen Chrome window, TDD throughout. Work exactly from where the
previous team stopped — do not restart or rewrite working modules.

## 0. Orient yourself (first 10 minutes)

1. The project: **`/Users/jt/Code/Flight Simulator`** (note the space — quote paths in shell). A git
   repo on `main`, clean at the handoff commit. Owner: JT (jared@jaredtate.com).
2. The spec (read it fully — it defines "done"): **`/Users/jt/Code/coeus/EX_PROMPT_7_FLIGHT_SIM.md`**.
   JT's extra requirements on top of the spec:
   - the aircraft must look like a **real Cessna 172** (we model the **172RG Cutlass RG** — the real
     retractable-gear 172 — so the spec's gear control is authentic);
   - everything in the world "as vivid and real as possible";
   - code lives in the Code folder (not the Desktop folder the spec names) as a real git repo;
   - **TDD with unit + fuzz (fast-check) + functional tests** for everything;
   - act as orchestrator: parallel **Opus** sub-agents (JT allowed up to 10 at a time, each in its own
     git worktree), and **visually QA and play it like a human** in the Chrome window.
3. Read, in order: `PLAN.md` (architecture, contracts, agent rules), `RECORD.md` (build log, bugs and
   causes), `docs/TESTING.md` (test layers), `src/types.ts` (contracts + **frame conventions**),
   `src/config.ts` (every tunable; sections are owned by modules).
4. Run: `cd "/Users/jt/Code/Flight Simulator" && npm test` → expect **99 files / 1017 tests green in
   ~20–35 s** (includes e2e in headless Chrome). `npx tsc --noEmit -p .` → 0 errors.
5. Start the dev server in the background: `npm start` → http://127.0.0.1:8092 (Vite, HMR).
6. Open it in the Playwright MCP Chrome window (the "Chrome window on the screen" of the spec), resize
   to 1440×900, wait until `window.sim.fps > 0`, and look. You should see the 172RG on runway 36 with
   FAA markings, mountains north, cumulus, and the steam-gauge HUD, at 60 fps with no console errors.
   Reference photos from the handoff flight: `qa/screenshots/01..05-*.png`.

## 1. Environment gotchas (learned the hard way)

- **npm cache is root-owned** (`~/.npm` EACCES). Install with
  `npm_config_cache=<your scratchpad>/npm-cache npm install -D <pkg>`. Everything needed is installed
  (three 0.186, vite 8, vitest 5, typescript 5.9, fast-check, playwright 1.63, happy-dom).
- **Playwright's bundled browsers are not downloaded**; `scripts/shot.mjs` and the e2e tests launch the
  installed **Google Chrome** (`channel: 'chrome'`, `--use-angle=metal`) → real M2 Max GPU WebGL in
  headless mode. `node scripts/shot.mjs <url> <png> --size 1440x900 --wait 8000 --eval "<js>"` prints
  console errors/failed requests and exits 1 on any.
- **Worktrees**: the Agent tool's built-in `isolation: "worktree"` needs the session cwd to be a git
  repo; if your session starts in `~/Desktop` it won't work. Create them manually:
  `git worktree add ".worktrees/<name>" -b "wt/<name>" && ln -s "$PWD/node_modules" ".worktrees/<name>/node_modules"`.
  `.worktrees/` is git-ignored, Vite ignores it and Vitest excludes it. **Gotcha:** because
  `vite.config.ts` ignores `**/.worktrees/**` for file watching, a Vite server started *inside* a
  worktree doesn't hot-reload; worktree agents should run Vite with a scratch config
  (`--config <scratch>/vite.wt.config.mjs` that omits `server.watch.ignored`) on their own port 81xx.
  Also: in a worktree, imports of files missing from the snapshot can resolve to the main checkout via
  the symlinked node_modules — test results there may mix trees.
- **HMR full-reloads reset the sim.** Any edit to `src/config.ts` or a module imported by `main.ts`
  reloads the page. Don't play-test in the main tree while agents are editing it; use worktrees for
  agents and keep `main` stable while you fly.
- **Playwright MCP**: `browser_run_code_unsafe` is the way to fly (hold keys with
  `page.keyboard.down/up` + `waitForTimeout`, read `window.sim` between). Save photos with absolute
  paths into `qa/screenshots/`. The MCP writes snapshot/console logs to `~/Desktop/.playwright-mcp/`
  (outside the project — delete that folder at the end).
- Foreground `sleep` is blocked in this harness; to wait for agents, end the turn (you are notified
  when each finishes) or run `sleep N` with `run_in_background: true` as a fallback timer.

## 2. What exists (state at handoff)

~29.7k lines of TypeScript in `src/`, ~15.9k lines of tests, 1017 tests (unit, fast-check fuzz,
scripted-flight functional, headless-Chrome e2e). Every module below is merged on `main`.

| Module | Path | State |
| --- | --- | --- |
| Contracts | `src/types.ts`, `src/config.ts`, `src/math/*`, `src/physics/frames.ts`, `src/world/runway.ts` | ✅ final. World +X east, +Y up, +Z south (north = −Z); body = three.js object frame (−Z nose). |
| Physics (pure) | `src/physics/*` — `step(state, controls, dt, env?)`, `createInitialState`, `createApproachState`, `approachControls`, `createTrimmedState`, `solveTrim`, `liftCoefficient`, `dragCoefficient`, `stallAlphaRad`, `classifyTouchdown`, `simStateLabel` | ✅ 6-DOF C172RG, calibrated to POH (Vs1 49.5, Vs0 42.4 KIAS, roll 230 m, Vy 679 fpm, cruise 127 KTAS, glide 9.6:1, roll rate 44°/s). Gear spring-dampers, friction, stall + wing drop, touchdown rating, crash reasons, over-G/overspeed failure. 115 tests. `step` ≈ 1–3 µs. |
| Input (pure + DOM) | `src/input/*` — `createControlState`, `updateControls`, `resetControls`, `createInputManager` | ✅ smoothed keyboard/mouse-yoke/gamepad, actions (R, Shift+R, P, H, I, M, N, C, 1–4). |
| Cameras (pure) | `src/camera/*` — `createCameraRig`, `setCameraMode`, `nextCameraMode`, `snapCamera`, `updateCameraRig`, `shakeTarget`, `applyCameraPose` | ✅ cockpit / chase / external fly-by / orbit, eased transitions, ground clearance, shake. |
| Loop | `src/game/loop.ts` (FixedStepLoop 120 Hz), `fps.ts`, `interpolate.ts` | ✅ |
| `window.sim` | `src/game/simApi.ts` | ✅ airspeed, altitude, heading, pitch, roll, throttle, gear, flaps, state, fps + verticalSpeed, altitudeAGL, aoa, rpm, engine, camera, paused, crash, lastLanding, perf{fps,avg,min,onePercentLow,longFrames,frames}, position, time; actions reset(), resetApproach(), setCamera(m), pause(), resume(). |
| App wiring | `src/game/app.ts` (core frame), `src/game/extras.ts` (HUD, audio, fx, airport, trees, towns, roads; `?no=trees,towns,roads,audio,fx,hud,airport` disables systems for profiling), `src/main.ts` | ✅ integrated and running on `/`. |
| World (pure) | `src/world/{noise,regional,polyline,layout,fields,heightfield,landcover,environment}.ts` — `getLayout()`, `terrainHeight`, `terrainNormal`, `landcoverAt`, `surfaceAt`, `treeDensity`, `createEnvironment()` (+ `registerObstacleSource`) | ✅ airport plateau at 30 m, mountains to 2.6 km north, coast/bay/islands south, 2 lakes, river, 26 towns, 27 roads, 2 bridges. |
| Terrain + water | `src/world/terrain/*` (quadtree LOD, worker-built tiles, skirts, pooled), `src/world/water.ts`, entry `src/world/terrainIndex.ts` | ✅ 60 fps all views, ~80–115 draw calls, 0.3–1M tris. Realism TODOs below. |
| Atmosphere / renderer | `src/render/*` — `createRenderer` (HDR, reversed depth, 4× MSAA, custom "Filmic Neutral" tone map, dynamic-resolution controller), `createAtmosphere` (physical sky, sun + shadows following the aircraft, global aerial-perspective fog on every `fog: true` material, PMREM env, ~420 instanced cumulus + cirrus, lens flare, 4 time-of-day presets) | ✅ ~4 ms/frame. |
| Aircraft model | `src/aircraft/*` — `createAircraft()` → `{ root, setVisualState, setPanelDrawer, landingLight, dispose }` | ✅ lofted fuselage, NACA 2412 wing, struts, swept fin, retractable gear anim, prop + blur disc, pivoted surfaces, N172JT livery, glass, nav/strobe/beacon/landing lights, cockpit interior with live panel (HUD's `drawPanel`). ~128k tris, ≤60 draws. |
| Instruments + HUD | `src/ui/*` — `createInstrumentModel`, `updateInstruments`, gauge drawers, `drawPanel`, `createHud` | ✅ six-pack + tach steam gauges (bottom corners), compass tape, systems strip (throttle, flaps, gear lights, trim, brakes, engine), stall/crash/landing/paused messages, help (H). 1440 & 1024 layouts. |
| Audio | `src/audio/*` — `createAudio`, `createAudioInputTracker`, `runAudioSelfTest` | ⚠️ synthesised O-360 engine, wind, horn, tyres, motors, crash — **never listened to in a browser**. |
| Effects | `src/fx/*` — `createEffects` (crash fireball/smoke/debris, touchdown smoke, pooled), `cameraShakeFor`, `speedFovOffset` | ⚠️ wired; **shaders never visually checked**; `speedFovOffset` not applied yet. |
| Airport | `src/world/airport/{plan,markings,font,lights,obstacles,materials}.ts` (tested data layer) + **`interim.ts`** (orchestrator stop-gap: merged FAA paint mesh, box massing for hangars/terminal/tower, lights as screen-sized points) | ⚠️ the full `createAirport()` renderer is **not built** (see §4.1). Airport obstacles are **not registered** yet. |
| Vegetation | `src/world/vegetation/*` — `createVegetation` (deterministic placement, 4 species, impostor atlas, pooled chunk streaming, LOD, obstacle hash) | ⚠️ wired and running, no console errors, but **never visually QA'd**; tree lines visible at distance only. |
| Towns + roads | `src/world/towns/*`, `src/world/roads/*` — `createTowns`, `createRoads` (13k buildings, farmsteads, streets, draped ribbons, obstacles) | ⚠️ **interim renderers** (plain boxes, grey ribbons); no preview/screenshots yet. |
| Tests | `tests/**` — unit per module, `tests/fuzz/*` (56 cross-cutting properties), `tests/functional/*` (12 scripted-pilot missions: takeoff/climb, turns, stall/recovery, terrain crash + reset, approach + landing + rollout, gear-up, ditching), `tests/e2e/app.e2e.test.ts` (11: title, no console errors/failed requests, window.sim fields, throttle, cameras 1–4/C, pause, Shift+R, R, gear/flaps, resize 1440→1024, fps) | ✅ `docs/TESTING.md` explains layers and fast-check seed replay (`FC_SEED`, `FC_PATH`, `FUZZ_RUNS`). |

Previews (dev-only pages, great for focused visual work): `/preview/terrain.html?x=&y=&z=&heading=&pitch=&atmo=1`,
`/preview/atmosphere.html?y=&heading=&pitch=&tod=`, `/preview/aircraft.html?view=front34|side|rear34|top|cockpit|belly&gear=&flaps=&rpm=`,
`/preview/hud.html?ias=&alt=&hdg=&vs=&pitch=&roll=&stall=1&crash=1&landing=smooth&cam=cockpit&help=1`.

## 3. Done lines — honest status

| # | Spec done line | Status |
| --- | --- | --- |
| 1 | Every test passes, none skipped (`npm test`) | ✅ now (1017/1017). Keep it that way after every change. |
| 2 | Loads and shows the aircraft on the runway ("Flight Simulator" at http://127.0.0.1:8092) | ✅ |
| 3 | Full flight flown in Chrome and photographed: take-off roll, climb, left turn, right turn, stall + recovery, crash into terrain + reset, airport approach, landing | ⏳ take-off roll + climb photographed (`qa/screenshots/01–05`). **Turns, stall/recovery, crash/reset, approach, landing still to fly and photograph.** |
| 4 | Every camera view (cockpit, chase, external, orbit) works with smooth transitions, photographed | ⏳ all four work and were photographed once; cockpit needs fixes (§4.2); transitions not yet photographed mid-blend. |
| 5 | Instruments readable at 1440 and 1024 without covering the view | ⏳ HUD built for both; verified in HUD preview; **not yet verified in the live app at 1024**. |
| 6 | `window.sim` exposes the fields; after a full flight fps stayed smooth; console clean, no failed requests | ⏳ API ✅; steady 60 fps ✅; **startup hitch ~1.7 s** (min fps 0.6, 3 long frames) to fix; full-flight perf stats not yet recorded. |
| 7 | Whole suite green after the last change of play testing, perf pass and visual QA | ⏳ (final step). |

## 4. Remaining work, in priority order

### 4.1 Airport renderer (replace `src/world/airport/interim.ts`)
Build `src/world/airport/index.ts` → `createAirport(scene, env, { heightAt })` →
`{ update(camera, time, sunElevationDeg), dispose(), papiState(end) }` per the airport agent's plan
(see RECORD.md §"Wave 2 reports" and the shelved functional test
`docs/pending/airport.functional.test.ts.txt` (move it to `tests/world/airport/airport.functional.test.ts`
first and watch it fail — it expects meshes named `pavement`, `markings`, `parked-aircraft`, `cars`; draw calls ≤ ~40; nothing below
ground). Pavement mesh from `plan` pieces + fillets draped on `heightAt`, paint from `runwayMarkings`/
`taxiMarkings`, 3 m shoulders, merged structures (arched/gabled hangars, terminal with glass, tower
with octagonal cab, fuel station, windsock mast, fence), instanced parked Cessnas + cars, windsock
cloth, lights as one `THREE.Points` with screen-sized sprites and **working PAPIs** (`papiUnitWhiteness`)
and the rabbit. Register `airportObstacles(plan)` with `env.registerObstacleSource`. Shaders in
`materials.ts` have never compiled — expect small GLSL fixes. Then swap it into `extras.ts`.

### 4.2 Cockpit and aircraft polish (seen in `qa/screenshots/03-climb-cockpit.png`)
- The prop **blur disc renders as a bright pink/red ring** (the painted blade-tip stripes smeared) —
  make the disc subtle (low alpha, tip ring barely visible), and nearly invisible from the cockpit.
  Same ring is too visible from the chase camera.
- **Pilot eye too low / too far left**: raise `aircraft.geometry.pilotEye.y` by ~0.1–0.15 m (the
  aircraft agent flagged 0.52 as low) and re-check the view: cowling top + a sliver of spinner over
  the glareshield, panel in the lower third, the left door post not dominating the left third.
- HUD systems strip overlaps the lower 3D panel in cockpit mode — fine, but consider the compact
  cluster option (`CONFIG.hud.cockpitGauges = 'compact'`) if the panel isn't legible at 1024.
- Aircraft build takes ~1.8 s on the main thread (livery/window canvas textures ~1.2 s) → cache or
  generate at lower resolution / in a worker. `verticalTailTop.z` (5.95) vs model fin top (~5.45) —
  align the structural collision point.
- External fly-by camera frames from rather high above — lower `camera.external.heightOffset` /
  bring the anchor closer to the flight path so it looks like a spotter at the runway edge.

### 4.3 Play-test the full flight in Chrome (done line 3) and fix what it shows
Fly like a human with keyboard holds (`page.keyboard.down/up`), reading `window.sim` between inputs;
pause (P) to think. Sequence and photos into `qa/screenshots/` with descriptive names:
take-off roll → rotate at 55 kt → climb at ~75 kt (retract gear with G after positive climb — the squat
switch ignores G on the ground) → 30° left turn → 30° right turn → aggressive manoeuvres → power-off
stall (hold ↓, throttle idle; `sim.state === 'stalled'`) → recovery (↑ + full power) → fly into a
mountainside (crash + smoke/fire fx) → R reset → Shift+R approach → fly the approach (PAPI) → flare →
landing (`sim.lastLanding`) → brake to stop. Attempt several landings. Test every control (F/V flaps,
G gear, [ ] trim, E engine off/on, B parking brake, L light, N time of day, M mute, H help, I HUD,
Y mouse yoke, P pause), resize to 1024×768, watch the console. Observations from the handoff flight:
a 0.7 s tap of ↓ at 56 kt did not lift off (it rotated later near 70–80 kt as speed built) and the
initial zoom climb showed ~1,300–1,600 fpm while trading speed — check the sustained climb at 75 kt is
~700 fpm and that rotation with a normal ~1–1.5 s pull at Vr is natural.

### 4.4 Realism pass on the world (JT: "as vivid and real as possible")
From the world agent: mountains read as smooth domes (add warped strata, scree, snow streaks in gullies,
sharper ridges); farmland colours too pastel/pale with too many near-white stubble fields; forest blobs
on the plains should shrink now that field-shaped woodlots exist; town ground is a saturated
checkerboard (plots, streets, gardens); the river looks dashed at distance (depth-pull the ribbon,
animate flow); confirm turquoise shallows + surf. Towns: real building geometry (gable/hip roofs,
facade shader with window grids, churches, towers, barns, silos), road markings, bridge structures,
optional moving cars. Trees: preview + screenshots at 60/150/600/2000 m, tune; hoist per-frame
allocations. Atmosphere TODOs: shadow penumbra hatching, env-map re-bake hitch every 600 m, cloud
billboard edges, cloud shadows on terrain (the terrain preview has them — check they're on in the app).

### 4.5 Audio + effects verification
Open the app, press a key (audio unlocks on first gesture), listen/measure with `runAudioSelfTest()`;
check engine pitch follows RPM, stall horn, touchdown chirp, crash. Build `preview/fx.html` and
photograph the crash fireball (0.5 s), smoke column (6 s, 15 s) and touchdown smoke; tune. Apply
`speedFovOffset` in app.ts after `applyCameraPose` (skip in external mode).

### 4.6 Performance pass (done line 6)
Fix the startup hitch (move towns placement + road build + tree atlas bake + livery textures off the
first frame: time-slice or worker; show a short loading veil instead of a frozen frame). Profile with
`?no=` switches and `window.sim.perf`; check draw calls (`renderer.info`), triangle counts, per-frame
allocations (Chrome performance panel / heap snapshots over a 5-minute flight), terrain worker
throughput at 150 kt, physics stability. Record before/after fps for every graphics change in RECORD.md.

### 4.7 Visual QA (done lines 4, 5) and docs
Photograph once each at **1440 and 1024 wide**: aircraft, cockpit, terrain, horizon, sky, clouds,
lighting/shadows, runway/airport, water, HUD/instruments, each camera + a mid-transition frame, the
console. Fix only what a done line names. Write `README.md` (how to run, test, the controls table from
PLAN.md, how the parts fit — architecture diagram), finish RECORD.md, update PLAN.md statuses.

### 4.8 Final regression (done line 7)
`npm test` + `npx tsc --noEmit -p .` + `npm run build`, one more flight (take-off, stall, landing,
every camera), console checked, commit. Delete `~/Desktop/.playwright-mcp/` (tool cache outside the
project). (At handoff all `wt/*` branches were merged, their worktrees removed and branches deleted — `main` is the only branch.)

## 5. How to run the team (what worked)

- **Waves of parallel Opus sub-agents on file-disjoint work**, each with a self-contained brief: role,
  files it owns, exact public API to export, what to build, tests required (unit + fast-check fuzz +
  functional), preview page + screenshots to take and READ, performance budget, report format.
  Tell each agent to read `PLAN.md` rules, `src/types.ts`, `src/config.ts` first.
- **Worktree agents** get `WT="/Users/jt/Code/Flight Simulator/.worktrees/<name>"`, must `cd "$WT"` in
  every command, never edit the main tree, run Vite on their own port with a scratch config, and
  **commit on their branch** at the end; you merge (`git merge wt/<name>`), resolve `config.ts`
  section conflicts by keeping both sections, run the full suite, commit.
- Agents in the main tree must not commit; you commit after they report.
- Ask agents for **exact wiring code** in their report; you own `src/game/app.ts` and `extras.ts`.
- Forward play-test bugs to the owning agent as a failing-test-first request with concrete numbers
  (e.g. RECORD.md "Play-test bug #1").
- Keep `PLAN.md`'s wave table and orchestrator prompt current; log every failure + cause in RECORD.md.
- Suggested next waves (≤10 agents, worktrees):
  **W3a** airport renderer · **W3b** cockpit/aircraft polish + prop disc · **W3c** towns geometry +
  road markings + bridges · **W3d** vegetation QA/tuning · **W3e** terrain realism (mountains,
  farmland, towns ground, river) · **W3f** audio/fx verification + fx preview · **W3g** startup hitch +
  perf instrumentation. Meanwhile YOU fly the full-flight sequence (§4.3) on `main` (keep main stable
  while flying), then run perf pass (§4.6), visual QA (§4.7) and final regression (§4.8).

## 6. Definition of finished
All seven done lines met with evidence: photos in `qa/screenshots/` for every item of done lines 3–5
at the required widths, `window.sim.perf` numbers after a full flight recorded in RECORD.md, console
clean, `npm test` green after the last change, everything committed on `main`.
