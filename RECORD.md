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
