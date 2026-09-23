# Build record

The log of what was built, decisions taken, failures met and their causes. Newest at the bottom.

## 2026-09-22 — Wave 0 (orchestrator)

- Project folder `Flight Simulator` (the spec's exact folder name), a git repo on `main`.
- Aircraft: **Cessna 172RG Cutlass RG** — the real 172 variant with retractable gear, so the
  spec's gear control is authentic rather than invented.
- Stack: Three.js r186 + TypeScript + Vite 8 + Vitest 5. `npm start` → 127.0.0.1:8092.
- On the development machine npm's global cache had root-owned files (EACCES, from an old
  `sudo npm`), so installs there used a private cache directory. A machine issue, not a project one.
- Playwright's bundled headless shell for 1.63 isn't downloaded; `scripts/shot.mjs` uses the
  installed Google Chrome (`channel: 'chrome'`) instead, which also gives real Metal GPU WebGL
  (`ANGLE Metal Renderer: Apple M2 Max`).
- Contracts written first: `src/types.ts` (frame conventions), `src/config.ts` (all tunables),
  `src/math/*`, `src/physics/frames.ts` — 19 tests green (math, frames, smoke).

## 2026-09-22 — Wave 1 underway; wave 2 launched in worktrees

- INPUT+CAMERA+LOOP finished (131 tests): control smoothing, DOM adapters, camera rig (cockpit/
  chase/external fly-by/orbit + transitions + shake), FixedStepLoop, FPS meter, interpolation.
- Orchestrator: `window.sim` (buildSimSnapshot/installSimApi, 5 tests), `app.ts` wiring drafted,
  and an **interim flyable build** (`src/game/prototype.ts`) — real physics/controls/cameras with
  stand-in visuals — served at `/` while the renderer modules are built. Opened in JT's Chrome.
- JT asked for more speed and rigor: up to 10 agents in their own worktrees; TDD with unit, fuzz
  (fast-check installed) and functional tests. Six worktree agents launched (hud, audiofx, qatests,
  airport, trees, towns); wave-1 agents told to add fuzz + functional tests.
- The Agent tool's built-in worktree isolation needs the session cwd to be a git repo (it is
  ~/Desktop), so worktrees are created manually: `git worktree add .worktrees/<n> -b wt/<n>`,
  node_modules symlinked; Vite ignores `.worktrees/` and Vitest excludes it.
- **Play-test bug #1** (interim build): full-throttle takeoff, 0.9 s of aft yoke at 56 KIAS →
  pitch 0→13° in < 1 s on the mains → state 'crashed', reason "Tail strike". Causes: ground
  rotation authority too high; a tail strike classified as a crash. Sent to PHYSICS with a
  functional test to add (liftoff < 12° pitch, no crash).

## 2026-09-22 — Stop point (JT asked for a clean handoff)

Wave-1 and wave-2 reports (all agents finished, all branches merged into `main`):

- **PHYSICS** (115 tests incl. fast-check fuzz): calibrated to the POH (table at the top of
  `src/physics/aircraft.ts`). Fixed play-test bug #1 test-first (rotation 5.9°/s, liftoff ~9.5°
  pitch, tail scrape = skid unless > 3 m/s). Fuzz found and fixed: trim state given more power than
  available at altitude; unbounded dive speed (now "Structural failure — overspeed" past 1.3 × Vne).
  Deviations: stall roll-damping reversal only with slip/yaw (coordinated stalls broke into spins),
  Cmα̇ folded into Cmq, windmilling prop drag added (glide was 13:1), P-factor only at +α, approach
  spawn height 236 m (true 3° path). Not modelled: ground effect, torque roll, crosswind side-load.
- **WORLD** (93 tests): layout, heightfield (1.45M samples/s), landcover, fields shared with the
  shader, environment, quadtree LOD terrain built in workers, water. 60 fps in all 5 test views.
  Realism TODOs: dome-like mountains, pastel farmland, checkerboard town ground, dashed far river.
- **ATMOSPHERE** (92 tests): own single-scattering sky, HDR pipeline with reversed 32-bit depth +
  4× MSAA, custom "Filmic Neutral" tone map (ACES bleached golden hour, AgX flat, Neutral crushed
  shadows), global fog-chunk override sharing one uniform array (no recompiles on time-of-day),
  cumulus (1 draw), cirrus, own lens flare (three's Lensflare can't read the MSAA HDR target).
  ~4.1 ms/frame. TODOs: penumbra hatching, env re-bake hitch every 600 m, cloud billboard edges.
- **AIRCRAFT** (50 tests): full 172RG model, ≤60 draws, ~128k tris. Flags: pilotEye.y 0.52 looks
  0.1–0.15 m low; verticalTailTop.z 5.95 vs model fin ~5.45; ~1.8 s build (textures) on main thread.
- **INPUT/CAMERA/LOOP** (131 tests) — done earlier.
- **HUD** (95 tests): steam gauges, compass tape, systems strip, messages, help, drawPanel for the
  cockpit. TODO: simplified faces below ~112 px for 1024 legibility; mute/light flashes.
- **AUDIO/FX** (135 tests): synthesised engine/wind/horn/tyres/motors/crash; pooled fire/smoke/
  debris/touchdown smoke; shake + speed FOV. Never heard/seen in a browser at the stop point.
- **QA TESTS** (79): 56 fuzz properties, 12 scripted-pilot missions, 11 e2e (headless Chrome, ~15 s).
  Found the dive-overspeed bug (already fixed on main). Minor: `setCameraMode` resets chase from the
  global CONFIG; `fpsStats` gives Infinity for sub-resolution frame times.
- **AIRPORT** (60 tests): data layer only — plan (pavement pieces, fillets), FAA markings, stroke
  font, ~290 lights with PAPI/rabbit/beacon logic, obstacles, materials (uncompiled). The renderer
  was not reached; the orchestrator wrote `src/world/airport/interim.ts` (paint mesh from the
  markings data, box massing, light points) so the runway has its markings now.
- **TREES** (87 tests): deterministic placement, 4 species, impostors, pooled streaming, LOD,
  obstacle hash. Never visually QA'd.
- **TOWNS/ROADS** (62 tests): 13,136 buildings, 1,246 farmsteads, street network, draped ribbons,
  obstacles; interim box/ribbon renderers; ~1.3 s synchronous startup.

Merge: six `wt/*` branches merged; one conflict in `src/config.ts` (vegetation vs towns sections —
kept both). Integration: `extras.ts` wires HUD (+ live cockpit panel), audio, fx, interim airport,
vegetation, towns, roads and registers tree/building obstacles; `main.ts` now boots the full app and
the interim prototype was removed. **1017/1017 tests green** (e2e now runs against the full app);
tsc 0 errors.

Handoff flight in Chrome (qa/screenshots/01–05): take-off roll, climb in chase/cockpit/orbit/
external at a steady 60 fps, console clean. Findings for the next team: prop blur disc shows a bright
pink tip ring (esp. from the cockpit); pilot eye low and left door post dominant; fly-by camera too
high; startup hitch ~1.7 s (perf.min 0.6 fps, 3 long frames); short 0.7 s pull at Vr didn't lift off
(it rotated later ~70–80 kt); initial zoom climb 1,300–1,600 fpm while trading speed.

Everything remaining is in RESUME.md.

## 2026-09-22 — Wave 3 launched; play-test bug #2 (orchestrator)

- Infrastructure: `src/game/systems/*.ts` auto-discovered plug-ins replace `extras.ts` (no shared
  wiring file for 10 parallel branches); per-system CPU timings in `window.sim.perf.systems`;
  `window.sim.teleport/setTimeOfDay/debug/render`; URL `?spawn=x,z,aglFt,hdg,kt&cam=&tod=&pause=1&no=`;
  Vite watch-ignores anchored to the checkout root so worktree dev servers hot-reload.
- Wave 3: 10 Opus agents in worktrees (aircraft, airport, buildings, roads+cars, traffic, terrain,
  water, sky, trees, ux) — each with a written brief (kept outside the repository).
- **Play-test bug #2** (flying the real app in Chrome): a 1.5 s ↓ at Vr lifted off, the elevator
  snapped back to neutral in 0.3 s, the nose fell toward the 76-kt trim, the aircraft settled back
  on the runway; G pressed during that hop retracted the gear → "Gear-up landing" crash.
  Causes: (1) keyboard elevator return 3.5/s — nothing like a pilot easing off back pressure;
  (2) no wing ground effect on lift/drag (only on pitch moment); (3) squat switch released the gear
  the instant the wheels unloaded. Probing showed the physics itself is right (neutral trim = hands-off
  Vy climb at full power: 76 kt, 675 fpm, 8.8° pitch; phugoid damps ~37 %/cycle like a real 172).
  Fixes (test-first): `controls.pitchReturnRate` 0.8/s (yoke relaxes over ~1.25 s; reversal still
  fast); McCormick wing ground effect (induced drag × φ, lift +25 %·(1−φ), attached flow);
  `aircraft.gear.retractDelay` 1.5 s continuous airborne before the gear retracts. Regression:
  `tests/functional/keyboard-takeoff.test.ts` flies the real input path with a human-like pulse pilot
  (rotate, hold ~9° to 70 kt, hands off → climbs to > 500 ft at ~77 kt; gear up 0.3 s after liftoff
  → no belly landing). Note: at full power the aircraft drifts left hands-off (P-factor/torque),
  like a real 172 — pilots hold right rudder/aileron.

## 2026-09-22 — Full-flight play test #1 on main (orchestrator, keyboard-only QA pilot)

`scripts/qa-pilot.js` (new): injected into the page, flies ONLY by dispatching keydown/keyup (the
same input path as a person), reading `window.sim` like instruments, pulse-tapping keys.
Flight (live app, 1520×870, M2 Max): take-off roll → Vr 55 kt → positive climb 71 kt / 61 ft →
gear up → 765 fpm at 78 kt → level 2,500 ft AGL → left turn 90° at 30° bank (7.4°/s, ±1 ft) →
right turn 90° → power-off stall at 51 KIAS clean (nose broke 19°→7°, −713 fpm) → recovery at
75 kt, −160 ft → teleport near the mountains → dive into a forested slope: crash "Hit an obstacle"
(trees) with fireball/smoke → R reset to runway 36 → Shift+R approach from 4 km/800 ft → glide
path + centreline tracking → touchdown on the runway 1.4 m left of centre at 62 kt (rated HARD,
−859 fpm: the QA pilot flares late) → braked to a stop 356 m past the threshold.
Perf over 36,707 frames: avg 59.9 fps, 1 % low 47, min 35, 2 long frames. Console: no errors.
Findings → agents: cockpit prop ring / door post / panel gear text (aircraft, ux); intact aircraft
after a crash → wreck state (aircraft); cartoonish flames (ux); cobblestone town-ground texture
(terrain). Open question: approach trim solves to 53 % nose-down with flaps 20 at 72 kt and pitch
−3…−4° on the glide path — plausible with the flap model but unusual for a 172; revisit.

## 2026-09-22 — Automation hijacked JT's Chrome (fixed)

JT: clicking Chrome in the Dock didn't open his normal profile. Cause: every automated browser —
the Playwright MCP window, `scripts/shot.mjs` and the e2e harness (`channel: 'chrome'`) — launched
`/Applications/Google Chrome.app` itself (with separate throwaway profiles); with 10 agents taking
screenshots, an automation instance of Chrome was almost always running, so the Dock icon
activated it instead of starting JT's profile. Fix: all automation now uses **Google Chrome for
Testing** (separate app bundle in `~/Library/Caches/ms-playwright/chromium-*`, or `TEST_BROWSER`);
`shot.mjs` and `tests/support/e2e.ts` refuse to fall back to the user's Chrome; the Playwright MCP
browser (which launches Google Chrome) is no longer used; automation instances were killed.
(The shared node_modules copy of playwright-core also maps channel 'chrome' to Chrome for Testing
as a stop-gap for agent worktrees still on the old scripts — it reverts on `npm install`.)

## 2026-09-22 — Wave 3 merged; stop point #2

JT asked for a stop point, full merge and clean-up. All ten wave-3 agents wrapped up and committed;
every branch was merged into `main` (one conflict: `tests/world/towns/ribbon.test.ts` moved to
`tests/world/roads/` by the roads agent — kept the move). Worktrees and `wt/*` branches deleted;
the agents' working screenshots archived locally in `qa/tmp/wave3/` (git-ignored).

- **aircraft** — retractable gear finished (the black belly slabs were the cabin floor poking
  through the skin; now real well openings, recessed liners, flush stow, door sequence, drag
  brace); faint photographic prop disc (no pink ring); wreck state (wired as `visual.crashed` /
  `crashAge`); fin-top collision point 5.95 → 5.45. Not done: eye point, interior, build time.
- **airport** — full renderer replaced the interim one (12 draw calls + 7 shadow casters).
- **buildings** — archetype meshes + facade shader, ~10,650 buildings, worker placement.
- **roads** — junction network, markings, bridges, street lights, worker streaming. No cars.
- **traffic** — ships/boats/air traffic simulated and modelled; not rendered.
- **terrain** — detail textures, realistic farmland, town lots, rock/snow shading; fixed the
  "cobblestone" town ground (it was a shader-painted woodlot inside the airport clearance).
- **water** — wave trains, FFT detail, worker bathymetry, continuous river, calm lakes.
- **sky** — cloud shadows on every material, sliced env re-bake, smooth shadow filter; volumetric
  clouds built but off by default (3–5 ms).
- **trees** — worker-generated forests, 7 species, impostors, grass; CPU 5.4 → ~0.03 ms/frame.
- **ux** — 172RG gear warning, simplified small gauges, loading veil, speed FOV, fire rework.

Under ten parallel agents the machine hit a load average of ~90 and many 5 s test timeouts
appeared; on the quiet merged `main` the whole suite passed: **142 files, 1,432 tests, 27 s**
(one heavy terrain functional test got an explicit 60 s timeout). Typecheck clean, build OK.
Headless check of the merged build (Chrome for Testing): clean console, 227 draw calls, ~2 M
triangles, every system < 0.03 ms CPU. The main dev server had to be restarted after the merge
(Vite cached the deleted `src/world/water.ts`). New docs: `README.md`, `ELEVATOR_PITCH.md`,
`ARCHITECTURE.md`, generated `REPO_MAP.md` (`npm run repo-map`), rewritten `RESUME.md`.

## 2026-09-22 — Wave 4: Tater's Flight Sim (open-source prep, F-16, crash, spins)

JT: rename to **Tater's Flight Sim** ("Tater Tots Flight Simulator"), open-source it, make the
crash spectacular (fluid, break-apart, fireball), real spins and correct stalls, an F-16 selectable
from a top-right dropdown (keep the Cessna; built for more aircraft later), a potato-with-goggles-
and-cape livery, a controls menu, working restart, finish other aircraft, clouds, cars, fix the
cockpit view — and later: the attitude indicator turns the wrong way; every gauge must work with
unit, functional and fuzz tests.

Orchestrator contracts first (commits 4a71946…): `src/fleet` (AircraftDef, AircraftModelHandle,
BreakupPart, FLEET with the Cessna and an F-16 placeholder), live aircraft switching in `app.ts`
(`?aircraft=`, `sim.selectAircraft`, `SystemContext.actions` for the menu, `onAircraftChange`),
`F16_AIRCRAFT` with the final real-world geometry (15.06 m, 9.96 m span, 4.88 m tall, 4.00 m
wheelbase, 2.36 m track) shared by the physics and the model, jet fields (afterburner, speed brake
on X), page title "Tater's Flight Sim · Tater Tots Flight Simulator", package `taters-flight-sim` (renamed `tatertotsflightsim` with the repository folder).
Suite 1,438/1,438. Then 10 worktree agents: physics, f16, cessna, crash, traffic, cars, clouds, ui,
audio, oss.
