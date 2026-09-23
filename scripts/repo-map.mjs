#!/usr/bin/env node
/**
 * Generates REPO_MAP.md — a map of every file in the repository with a one-line
 * description taken from the file's own leading doc comment (so the map stays
 * true as the code changes). Run: `npm run repo-map`.
 *
 * Skips dependencies, build output, git internals, agent worktrees and QA image
 * folders. Folder descriptions live in FOLDERS below — add one when you add a folder.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const SKIP = new Set(['node_modules', 'dist', '.git', '.worktrees', '.vite', 'coverage', '.DS_Store', 'tmp']);
const SKIP_PATHS = ['qa/screenshots', 'qa/tmp'];

/** Plain-English description of each folder (keep these short and simple). */
const FOLDERS = {
  '.': 'Project root: the page (`index.html`), build/test config, the licence and the project documents.',
  '.github': 'GitHub settings: pull-request template.',
  '.github/ISSUE_TEMPLATE': 'Templates for new GitHub issues (bug report, feature request).',
  '.github/workflows': 'GitHub Actions: CI (typecheck, every test, build on Linux) and a manual GitHub Pages deploy.',
  docs: 'Extra documentation (how the tests are organised) and shelved work waiting to be finished.',
  'docs/pending': 'Work that was started but not finished — kept here (not in `tests/`) so the test suite stays green.',
  public: 'Static files served as-is (the browser-tab icon).',
  preview: 'Developer preview pages — each one shows a single part of the sim (terrain, sky, aircraft, HUD…) on its own for quick visual checks.',
  qa: 'Photos taken while play-testing (`qa/screenshots/`) and scratch screenshots (`qa/tmp/`, not committed).',
  scripts: 'Helper scripts: headless screenshots, the test-browser picker, the keyboard-only QA pilot, and this repo-map generator.',
  src: 'All of the simulator’s source code (TypeScript).',
  'src/aircraft': 'The 3D Cessna 172RG: fuselage, wings, tail, retractable gear, propeller, paint, lights and the cockpit with its live instrument panel.',
  'src/audio': 'All sound, made live in the browser with the Web Audio API — engine, wind, stall horn, tyres, gear and flap motors, crash.',
  'src/camera': 'The four camera views (cockpit, chase, fly-by, orbit), their smooth transitions and camera shake. Pure maths, no drawing.',
  'src/fx': 'Visual effects made of particles: crash fireball, smoke and debris, and tyre smoke on touchdown.',
  'src/game': 'The game loop that ties everything together, the fixed-step timer, the FPS meter and `window.sim`.',
  'src/game/systems': 'Plug-ins added on top of the core loop (terrain, water, airport, roads, towns, trees, traffic, effects, audio, HUD). Each file is found automatically.',
  'src/input': 'Keyboard, mouse and gamepad handling, turned into smooth pilot controls.',
  'src/math': 'Tiny vector and quaternion helpers used everywhere.',
  'src/physics': 'The flight model of the Cessna 172RG. Pure and deterministic — it never touches the screen.',
  'src/preview': 'The code behind the developer preview pages in `preview/`.',
  'src/render': 'The renderer and the atmosphere: sky, sun, shadows, haze (fog), clouds, lens flare, tone mapping.',
  'src/ui': 'The instruments and the on-screen HUD: steam gauges, compass, warnings, messages and the help screen.',
  'src/world': 'The world: its geography (layout), terrain height and ground cover, the runway, and the physics view of the world.',
  'src/world/airport': 'The airport: pavement, FAA runway markings, lights and PAPI, buildings, and obstacles.',
  'src/world/roads': 'The road network and the road surfaces drawn on the terrain.',
  'src/world/terrain': 'Drawing the ground: level-of-detail terrain tiles built in background workers, and the terrain shader.',
  'src/world/towns': 'Towns, the coastal city, villages and farms: where buildings go and how they are drawn.',
  'src/world/vegetation': 'Trees and forests: where each tree goes, the tree models, far-away tree images, and streaming them around the camera.',
  'src/world/grass': 'Grass tufts and wildflowers drawn close to the camera when flying low.',
  'src/world/traffic': 'Other traffic: boats, ships, the marina and wakes; circuit aircraft, crossing aircraft, a helicopter and airliners. Simulated and modelled — not drawn yet.',
  'src/world/traffic/models': 'Procedural 3D models for traffic: boats, sails, ferry, container ship, tanker, marina, C172, PA-28, helicopter, airliner.',
  'src/world/water': 'The sea, lakes and river: waves, ripples, water depth and shore foam, the river ribbon.',
  tests: 'The automated tests (Vitest). Folders mirror `src/`; plus cross-cutting fuzz, functional-flight and browser end-to-end tests.',
  'tests/e2e': 'End-to-end tests: start the real game in a headless test browser and drive it with the keyboard.',
  'tests/repo': 'Open-source readiness checks: package metadata, licence, CI, README key bindings, no personal paths or secrets, test-browser choice.',
  'tests/functional': 'Whole flights flown by a scripted pilot against the real physics: take-off, turns, stall, landing, crashes.',
  'tests/fuzz': 'Property ("fuzz") tests with fast-check: thousands of random inputs must never break the rules.',
  'tests/support': 'Shared test helpers: the scripted pilot, test worlds, the e2e browser/server harness.',
  'tests/aircraft': 'Tests for the 3D aircraft: gear kinematics, prop disc, wreck, geometry anchors.',
  'tests/audio': 'Tests for the sound system (with a fake Web Audio context).',
  'tests/camera': 'Tests for the camera rig: modes, transitions, ground clearance, shake.',
  'tests/fx': 'Tests for the particle effects: pooling, fire/smoke simulation, shake.',
  'tests/game': 'Tests for the loop, FPS meter, interpolation, `window.sim` and the systems layer.',
  'tests/input': 'Tests for control smoothing, key bindings and the DOM input adapters.',
  'tests/math': 'Tests for the vector and quaternion helpers.',
  'tests/physics': 'Tests for every rule of the flight model: lift, drag, thrust, stall, ground, landing, crash, reset.',
  'tests/render': 'Tests for the renderer and atmosphere maths: sky, fog, clouds, shadows, budget controllers.',
  'tests/ui': 'Tests for the instruments, gauges, HUD layout, gear warning, messages and loading veil.',
  'tests/world': 'Tests for the world: noise, layout, heightfield, landcover, runway, environment, plus a whole-flight LOD test.',
  'tests/world/airport': 'Tests for the airport plan, markings, lights/PAPI, obstacles and renderer.',
  'tests/world/fixtures': 'Saved reference data for tests (the protected-ground snapshot).',
  'tests/world/grass': 'Tests for grass placement and geometry.',
  'tests/world/roads': 'Tests for the road plan, ribbons, markings and depth pull.',
  'tests/world/terrain': 'Tests for terrain tiles, the quadtree, blending and detail textures.',
  'tests/world/towns': 'Tests for building placement, archetypes, obstacles, LOD and the road network used by towns.',
  'tests/world/traffic': 'Tests for traffic paths, sea routes, wakes, air circuits and models.',
  'tests/world/vegetation': 'Tests for tree placement, species, obstacles, LOD, pooling and streaming.',
  'tests/world/water': 'Tests for waves, bathymetry, river and the water system.',
};

const summaries = {
  'index.html': 'The one web page. Holds the canvas container and the HUD layer and loads `src/main.ts`.',
  'package.json': 'npm scripts (`start`, `test`, `typecheck`, `build`, `repo-map`) and dependencies.',
  'package-lock.json': 'Exact dependency versions (generated by npm).',
  'tsconfig.json': 'TypeScript settings (strict mode).',
  'vite.config.ts': 'Dev server on 127.0.0.1:8092, build settings, and the Vitest test settings.',
  '.gitignore': 'Files git ignores (dependencies, build output, agent worktrees, scratch screenshots).',
  '.gitattributes': 'Line-ending rules (LF in the repository) and binary file types.',
  '.editorconfig': 'Editor settings: UTF-8, LF, 2-space indent.',
  '.nvmrc': 'The Node.js version for `nvm use`.',
  'LICENSE': 'MIT licence.',
  'CONTRIBUTING.md': 'How to set up, the test-first workflow and what a good pull request looks like.',
  'CODE_OF_CONDUCT.md': 'Contributor Covenant 2.1.',
  'SECURITY.md': 'How to report a security problem privately.',
  '.github/PULL_REQUEST_TEMPLATE.md': 'Checklist shown when opening a pull request.',
  '.github/ISSUE_TEMPLATE/bug_report.md': 'Bug report form.',
  '.github/ISSUE_TEMPLATE/feature_request.md': 'Feature request form.',
  '.github/workflows/ci.yml': 'CI on Linux, Node 22 and 24: npm ci, Playwright Chromium, typecheck, npm test, build, upload the build.',
  '.github/workflows/pages.yml': 'Manual deploy to GitHub Pages, built with --base=/<repository>/.',
  'scripts/test-browser.d.mts': 'Types for scripts/test-browser.mjs.',
  'README.md': 'How to run it, fly it and test it.',
  'ARCHITECTURE.md': 'How the simulator is built, explained in plain English.',
  'REPO_MAP.md': 'This file: every folder and file and what it is for.',
  'ELEVATOR_PITCH.md': 'What this project is, in one page.',
  'RESUME.md': 'Hand-off notes: exactly where the work stopped and what to do next.',
  'PLAN.md': 'The build plan: architecture contracts, agent rules and the wave history.',
  'RECORD.md': 'The build log: what was done, decisions, bugs found and their causes.',
  'public/favicon.svg': 'The browser-tab icon (a small aircraft).',
  'src/math/quat.ts': 'Quaternion helpers: multiply, rotate vectors, integrate angular velocity, slerp.',
  'src/math/vec3.ts': 'Vector helpers plus clamp, lerp, smoothstep, moveToward and angle wrapping.',
  'tests/world/fixtures/protected-snapshot.json': 'Terrain heights/landcover near towns, roads, river, lakes and the airport, frozen so realism work can never move them.',
};

function firstDocSentence(text) {
  // Leading /** … */ or // block comment.
  const m = text.match(/^\s*(?:#![^\n]*\n)?\s*\/\*\*?([\s\S]*?)\*\//);
  let body = '';
  if (m) body = m[1];
  else {
    const lines = text.split('\n');
    const c = [];
    for (const l of lines) {
      if (/^\s*\/\//.test(l)) c.push(l.replace(/^\s*\/\/\s?/, ''));
      else if (l.trim() === '' && c.length === 0) continue;
      else break;
    }
    body = c.join(' ');
  }
  const clean = body
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, '').trim())
    .filter((l) => l && !l.startsWith('@') && !/^[─━=-]{3,}/.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return '';
  const s = clean.match(/^(.+?[.!?])(\s|$)/);
  const out = (s ? s[1] : clean).replace(/\|/g, '\\|');
  return out.length > 220 ? out.slice(0, 217) + '…' : out;
}

function describe(rel, full) {
  if (summaries[rel]) return summaries[rel];
  const ext = extname(rel);
  if (['.ts', '.mjs', '.js'].includes(ext)) {
    const d = firstDocSentence(readFileSync(full, 'utf8'));
    if (d) return d;
    if (rel.endsWith('.test.ts')) return 'Tests.';
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (base === 'index.ts') return 'Public entry point of this folder (re-exports its API).';
    if (base === 'types.ts') return 'Shared type definitions for this folder.';
  }
  if (ext === '.html') return 'Developer preview page.';
  if (ext === '.md') return 'Documentation.';
  if (ext === '.txt') return 'Shelved file (see its header).';
  return '';
}

const byDir = new Map();
function walk(dir) {
  for (const name of readdirSync(dir).sort()) {
    if (SKIP.has(name)) continue;
    const full = join(dir, name);
    const rel = relative(root, full).split('\\').join('/');
    if (SKIP_PATHS.some((p) => rel === p || rel.startsWith(p + '/'))) continue;
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else {
      const d = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '.';
      if (!byDir.has(d)) byDir.set(d, []);
      const lines = readFileSync(full, 'utf8').split('\n').length;
      byDir.get(d).push({ rel, name, lines, desc: describe(rel, full) });
    }
  }
}
walk(root);

const dirs = [...byDir.keys()].sort((a, b) => (a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b)));
let totalFiles = 0;
let totalLines = 0;
for (const f of byDir.values()) for (const x of f) { totalFiles++; totalLines += x.lines; }

let md = `# Repository Map

<!-- generated by scripts/repo-map.mjs — do not edit by hand; run \`npm run repo-map\` -->

Every folder and file in the Tater's Flight Sim repository, with a one-line description. File
descriptions come from each file's own opening comment, so this map stays accurate: run
\`npm run repo-map\` after adding, moving or renaming files.

Not listed: \`node_modules/\` (dependencies), \`dist/\` (build output), \`.git/\`, \`.worktrees/\`
(temporary agent workspaces) and the QA image folders. ${totalFiles} files, ${totalLines.toLocaleString('en-US')} lines.

## Start here

- **Run it:** \`npm install\`, then \`npm start\` → http://127.0.0.1:8092 (see \`README.md\`).
- **Understand it:** \`ELEVATOR_PITCH.md\` (one page) → \`ARCHITECTURE.md\` (how it works) → this map.
- **Continue the work:** \`RESUME.md\` (where it stopped, what's next) and \`RECORD.md\` (history).
- **The heart of the code:** \`src/game/app.ts\` (the frame loop), \`src/physics/aircraft.ts\` (the flight
  model), \`src/config.ts\` (every tunable number), \`src/types.ts\` (shared shapes and the axis conventions).

## Folders

| Folder | What it is |
| --- | --- |
${dirs.map((d) => `| \`${d === '.' ? './' : d + '/'}\` | ${FOLDERS[d] ?? ''} |`).join('\n')}

## Files by folder
`;
for (const d of dirs) {
  md += `\n### \`${d === '.' ? './' : d + '/'}\`\n\n`;
  if (FOLDERS[d]) md += `${FOLDERS[d]}\n\n`;
  md += '| File | Lines | What it is |\n| --- | ---: | --- |\n';
  for (const f of byDir.get(d)) md += `| \`${f.name}\` | ${f.lines} | ${f.desc} |\n`;
}
writeFileSync(join(root, 'REPO_MAP.md'), md);
console.log(`REPO_MAP.md: ${dirs.length} folders, ${totalFiles} files, ${totalLines} lines`);
