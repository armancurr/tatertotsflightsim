# Flight Simulator

A browser-based 3D flight simulator: fly a **Cessna 172RG** over a large procedural world —
farmland, forests, rivers, a coastline, towns and snow-capped mountains — with real flight physics,
a physically based sky and a steam-gauge cockpit. Built with **Three.js (WebGL2) + TypeScript +
Vite**, everything generated in code (no downloaded assets).

- What it is, in one page: [`ELEVATOR_PITCH.md`](ELEVATOR_PITCH.md)
- How it works: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Every file and folder: [`REPO_MAP.md`](REPO_MAP.md)
- Where the work stopped / what's next: [`RESUME.md`](RESUME.md) · build log: [`RECORD.md`](RECORD.md)

## Run it

Requires Node 20+ (tested with Node 24).

```sh
npm install
npm start            # http://127.0.0.1:8092
```

Open http://127.0.0.1:8092 in Chrome (or any WebGL2 browser). A loading screen appears while the
terrain streams in; press any key or click to start (that also turns the sound on).

Other scripts:

| Command | What it does |
| --- | --- |
| `npm test` | The whole test suite (~1,400 tests, ~30 s): unit, fuzz, scripted-flight and browser end-to-end tests |
| `npm run typecheck` | TypeScript type check (`tsc --noEmit`) |
| `npm run build` | Production build into `dist/` (`npm run preview` serves it on 8092) |
| `npm run check` | typecheck + test + build |
| `npm run repo-map` | Regenerate `REPO_MAP.md` |
| `npm run shot -- <url> <out.png>` | Headless screenshot (uses *Google Chrome for Testing*, never your own Chrome) |

The end-to-end tests and `scripts/shot.mjs` need **Google Chrome for Testing**, which Playwright
installs into `~/Library/Caches/ms-playwright` (`npx playwright install chromium`), or point
`TEST_BROWSER` at a Chromium binary.

## Fly it

You start on runway 36 with the engine idling. Push the throttle up (**W**), let the speed build,
and at about **55 knots** hold **↓** to lift the nose to about 9°; keep it there until ~70 knots,
then relax. Raise the gear with **G** once you're climbing.

| Action | Keys |
| --- | --- |
| Pitch — push / pull | ↑ / ↓ |
| Roll | ← / → |
| Rudder (and nosewheel steering) | A / D |
| Throttle | W / S (also PageUp/PageDown, + / −) |
| Flaps down / up (0-10-20-30°) | F / V |
| Landing gear | G |
| Brakes (hold) / parking brake | Space / B |
| Elevator trim — nose down / up | [ / ] |
| Engine start / stop | E |
| Landing light | L |
| Cameras | C cycles · 1 cockpit · 2 chase · 3 fly-by · 4 orbit · mouse drag to look/orbit · wheel to zoom |
| Reset to the runway / start on final approach | R / Shift+R |
| Pause · help · hide HUD · mouse-yoke · mute · time of day | P (or Esc) · H · I · Y · M · N |

Tips: a real 172 needs a little **right rudder** at full power (P-factor); the aircraft stalls
around 48 knots clean (the STALL horn warns you first); landings are rated from *butter* to *hard*
— anything over ~900 feet per minute collapses the gear. With the gear up and the power back, the
**GEAR** warning horn sounds.

### Dev options (URL parameters)

`?spawn=x,z,aglFt,headingDeg,speedKt` start airborne anywhere · `&cam=cockpit|chase|external|orbit`
· `&tod=0..3` (morning, midday, golden hour, dawn) · `&pause=1` · `&veil=0` (skip the loading
screen) · `&no=terrain,water,airport,roads,towns,vegetation,grass,fx,audio,hud` (switch systems
off) · `&clouds=volumetric&cloudbudget=0` (experimental volumetric clouds) · `&cloudshadows=0`.
In the browser console, `window.sim` shows the live state (airspeed, altitude, heading, pitch, roll,
throttle, gear, flaps, state, fps, …) and has `reset()`, `resetApproach()`, `teleport({…})`,
`setCamera()`, `setTimeOfDay()`, `pause()`, `resume()`, `debug()`.

## How the parts fit (short version)

Keyboard → **input** (smoothed controls) → **physics** at a fixed 120 steps per second (a pure,
tested Cessna 172RG model) → **aircraft state** → the renderer draws it: **aircraft model**,
**cameras**, **sky & atmosphere**, and the **world systems** (terrain, water, airport, roads,
towns, trees, grass, effects, audio, HUD), each a plug-in under `src/game/systems/`. Every tunable
number is in `src/config.ts`. Details in [`ARCHITECTURE.md`](ARCHITECTURE.md).
