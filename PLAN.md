# Flight Simulator — build plan

> **Orchestrator prompt** (paste this to resume the build with Claude as AI orchestrator):
>
> You are the orchestrator for `/Users/jt/Code/Flight Simulator`, a browser 3D flight
> simulator (Cessna 172RG, Three.js, TypeScript, Vite, Vitest). The spec is
> `/Users/jt/Code/coeus/EX_PROMPT_7_FLIGHT_SIM.md`; this PLAN.md holds the architecture,
> contracts and wave status, RECORD.md holds the build log. Read both, run `npm test`,
> start `npm start` (port 8092) in the background, then continue with the first wave
> that is not ✅. Work in waves of at most 5 Opus sub-agents on file-disjoint tasks,
> test-first; integrate, fly the sim in the on-screen Chrome window (Playwright MCP),
> photograph every done line into `qa/screenshots/`, commit after each wave.

## Stack

- **Three.js r186** on WebGL2, **TypeScript**, **Vite 8** (dev server = `npm start` on
  127.0.0.1:8092), **Vitest 5** (`npm test`), `npm run typecheck` (tsc), `npm run check`
  (typecheck + test + build).
- No runtime network assets: every texture, model and sound is generated procedurally in
  code (canvas / DataTexture / BufferGeometry / WebAudio). Nothing to 404.
- `scripts/shot.mjs` — headless Chrome (real GPU via Metal) screenshot + console check:
  `node scripts/shot.mjs http://127.0.0.1:8092/preview/x.html out.png --size 1440x900 --wait 4000`.

## Architecture

```
src/
  types.ts          shared contracts (no three.js) — READ the frame conventions header
  config.ts         EVERY tunable value (physics, controls, cameras, world, fog, lighting, audio, HUD)
  math/             vec3.ts, quat.ts — tiny pure helpers
  physics/          PURE. frames.ts (conventions), aero.ts, engine.ts, ground.ts, aircraft.ts
                    (createInitialState, createApproachState, step(state, controls, dt, env?))
  input/            PURE control system (key/mouse/gamepad state → smoothed Controls + actions)
                    + keyboard.ts/mouse.ts DOM adapters
  camera/           PURE camera rig (modes, smoothing, transitions → CameraPose) + three adapter
  game/             loop.ts (fixed-step accumulator, pure), simApi.ts (window.sim), app.ts (wiring)
  world/            PURE: noise.ts, heightfield.ts, layout.ts (airport/towns/roads/lakes), landcover.ts,
                    environment.ts (physics Environment). RENDER: terrain LOD, water, airport, trees,
                    buildings, roads
  render/           renderer.ts, atmosphere (sky, sun, fog/aerial perspective, clouds), post
  aircraft/         procedural C172RG exterior model, cockpit interior, animation
  ui/               instruments.ts (PURE readings), gauges.ts (canvas drawing), hud.ts (DOM overlay)
  audio/            WebAudio synthesis (engine, wind, stall horn, tyres, gear/flap motors, crash)
  fx/               particles (crash smoke/fire, tyre smoke), pooled
  preview/          standalone dev pages for each visual module (preview/*.html at repo root)
tests/              mirrors src/, *.test.ts
qa/screenshots/     photographs taken during play testing and visual QA
```

Data flow per frame: DOM events → `input` (pure) → `Controls` → `physics.step` ×N at 120 Hz
(fixed step, accumulator) → `AircraftState` → interpolated pose → aircraft model / camera rig /
instruments → renderer. The renderer never writes physics state.

### Key contracts

- `step(state: AircraftState, controls: Controls, dt: number, env?: Environment): AircraftState`
  — pure, deterministic, never touches the renderer; `env` defaults to flat ground at y=0
  (runway surface everywhere) so tests need no world.
- `Environment` (types.ts) is implemented by `src/world/environment.ts` from the same pure
  heightfield the terrain mesh is built from — what you see is what you hit.
- Frame conventions: world +X east, +Y up, +Z south (north = -Z). Body = three.js object
  frame (+X right wing, +Y up, -Z nose). Use `src/physics/frames.ts` helpers only.
- `window.sim` exposes at least: airspeed (kt), altitude (ft MSL), heading, pitch, roll,
  throttle (%), gear ('down'|'up'|'transit'), flaps (deg), state
  ('ground'|'airborne'|'stalled'|'landed'|'crashed'), fps — plus extras (vs, agl, aoa, rpm,
  engine, camera, perf stats, lastLanding, crash).

### Default controls (config.controls.keys)

| Action | Keys |
| --- | --- |
| Pitch (push / pull) | ↑ / ↓ |
| Roll | ← / → |
| Rudder | A / D |
| Throttle | W / S (also PageUp/PageDown, + / −) |
| Flaps down / up | F / V |
| Gear | G |
| Brakes (hold) / parking brake | Space / B |
| Elevator trim | [ / ] |
| Engine start/stop | E |
| Landing light | L |
| Cameras | C cycle, 1 cockpit, 2 chase, 3 external, 4 orbit; mouse drag look/orbit, wheel zoom |
| Reset: runway / final approach | R / Shift+R |
| Pause, help, HUD, mouse-yoke, mute, time of day | P (Esc), H, I, Y, M, N |

## Waves

| Wave | Agents (≤5, file-disjoint) | Status |
| --- | --- | --- |
| 0 | Orchestrator: scaffold, types, config, math/frames, shot tool, plan | ✅ |
| 1 | PHYSICS · INPUT+CAMERA+LOOP · WORLD-TERRAIN · ATMOSPHERE · AIRCRAFT-MODEL | ⏳ |
| 2 | INSTRUMENTS+HUD · AIRPORT · VEGETATION+TOWNS+ROADS · AUDIO+FX · (orchestrator: integration app.ts) | |
| 3 | Orchestrator play-tests in Chrome → fix agents; performance pass | |
| 4 | Visual QA at 1440 & 1024, docs, final regression | |

## Rules for every sub-agent

1. **Stay in your files.** Only create/edit the files your brief assigns. Other agents are
   editing other files at the same time. `src/config.ts`: only edit your own section.
   `src/types.ts`: do not change existing fields; if you truly need a new shared type, add it
   at the end with a comment naming your module.
2. **Tests first.** Write the test, run it and see it fail, write the code, see it pass.
   `npx vitest run tests/<your-dir>` while working; the whole `npm test` before you finish.
   No `.skip`, no `.only`, no `todo`. If a test fails because of *another* agent's in-progress
   files, say so in your report — don't edit their files.
3. **Typecheck** your files: `npx tsc --noEmit -p .` and fix errors in your files.
4. **Don't start/stop the dev server.** It is already running on http://127.0.0.1:8092
   (Vite, hot reload). Visual modules get a preview page `preview/<name>.html` (root-level
   html, loads `src/preview/<name>.ts`) and are checked with `scripts/shot.mjs`. Look at every
   screenshot you take (Read the png) and judge it honestly against the brief.
5. **Don't commit** — the orchestrator commits after each wave. Don't `npm install` new
   packages without saying why in your report (there is no network asset loading at runtime).
6. **Performance is a feature**: no per-frame allocations in hot paths of render code,
   instancing for repeated objects, dispose what you create, measure.
7. Report at the end: files created, public API (exact exports + signatures), test count,
   screenshots taken (paths), known gaps.
