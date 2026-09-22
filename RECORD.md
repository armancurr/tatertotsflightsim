# Build record

The log of what was built, decisions taken, failures met and their causes. Newest at the bottom.

## 2026-09-22 — Wave 0 (orchestrator)

- Project lives at `/Users/jt/Code/Flight Simulator` (the spec's exact folder name, placed in
  the Code folder per JT's instruction), a git repo on `main`.
- Aircraft: **Cessna 172RG Cutlass RG** — the real 172 variant with retractable gear, so the
  spec's gear control is authentic rather than invented.
- Stack: Three.js r186 + TypeScript + Vite 8 + Vitest 5. `npm start` → 127.0.0.1:8092.
- npm's global cache (`~/.npm`) has root-owned files (EACCES); installs use
  `npm_config_cache=<scratchpad>/npm-cache`. Cause: an old `sudo npm`. Not fixed (outside the project).
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
