/**
 * The airfield beyond layout.ts: the crossing runway 03/21 and everything added
 * around the airport — its taxiways (B across 36/18 to the 03 end, C from the
 * north end of A to the 21 end), the hold positions where taxiways and runways
 * cross, a bigger GA ramp, T-hangar rows and their taxilanes, the ARFF station
 * apron, the flight school and its car park, the maintenance hangar, the fuel
 * farm, navaids (VOR/DME, ILS localizer and glideslope for 36), windsocks at
 * every runway end, the perimeter road and fence, and the ground vehicles.
 *
 * Everything is in RUNWAY-36 coordinates (a = metres along 36 from its
 * threshold, c = metres right of its centreline, i.e. east), like plan.ts; the
 * crossing runway's own frame is `cross` (t along from the 03 threshold, s right
 * of its centreline facing 030). PURE — landcover.ts (the physics' surface
 * types, the grass/tree exclusion) reads `fieldPaving()`; the renderer builds on
 * `createAirportField()`.
 */
import { CONFIG, type Config } from '../../config';
import { fromRunwayCoords, runwayFrames, toRunwayCoords, type RunwayFrame } from '../runway';
import { intersectConvex, rectPoly, subtractAll, type P2 } from './geom2d';
import { createLayout, getLayout } from '../layout';

export type FieldKind = 'runway' | 'taxiway' | 'apron' | 'carpark' | 'road';

export interface FieldPave {
  kind: FieldKind;
  name: string;
  /** Convex polygon, runway-36 coordinates. */
  p: P2[];
  /** Frame the pavement shader uses for its patterns: 0 = 36/18, 1 = the crossing runway. */
  frame: 0 | 1;
}

/** A runway holding position whose lines run parallel to a runway (any crossing angle). */
export interface FieldHold {
  /** Taxiway (or runway) the aircraft holds on; the location sign on the back. */
  name: string;
  /** Mandatory sign text, e.g. '3-21', '21', '36-18'. */
  sign: string;
  /** Runway the hold protects: 0 = 36/18, 1 = the crossing runway. */
  runway: 0 | 1;
  /**
   * Hold lines: 4 bands at `along` distances in the frame of `lineFrame` ('cross' = lines run
   * parallel to the crossing runway at s offsets; 'rw' = parallel to 36/18 at c offsets;
   * 'crossT' = across the crossing runway at t positions). `d0` = runway-side edge, `dir` = the
   * holding side (+1 / −1 in that coordinate).
   */
  lineFrame: 'cross' | 'crossT';
  d0: number;
  dir: 1 | -1;
  /** The pavement the lines are painted on (clip polygon, runway-36 coords). */
  clip: P2[];
  /** Where the sign(s) stand (runway-36 coords) and the heading their faces point to (toward the holding pilot). */
  signs: { a: number; c: number; faceDeg: number }[];
}

export interface FieldBuilding {
  kind: 'thangar' | 'flightSchool' | 'fireStation' | 'maintHangar' | 'fuelFarm' | 'vor' | 'localizer' | 'glideslope';
  a: number;
  c: number;
  /** World heading the front faces. */
  headingDeg: number;
  /** Footprint across the front × front-to-back, height (m). */
  width: number;
  depth: number;
  height: number;
  seed?: number;
}

export type FieldVehicleKind = 'kingair' | 'helicopter' | 'arff' | 'fueltruck' | 'tug' | 'baggage' | 'pickup';
export interface FieldVehicle {
  kind: FieldVehicleKind;
  a: number;
  c: number;
  headingDeg: number;
  variant: number;
  /** Brightness (inside a hangar < 1). */
  shade: number;
}

export interface AirportField {
  rw: RunwayFrame;
  /** The crossing runway (03/21). */
  cross: RunwayFrame;
  /** Where the two centrelines cross (runway-36 coords) and at which t of the crossing runway. */
  crossing: P2;
  crossingT: number;
  /** Pavement added by the field (convex, runway-36 coords). Runway pieces never overlap 36/18. */
  paving: FieldPave[];
  /** Taxiway A extended north to meet taxiway C (new along-end). */
  taxiwayA1: number;
  /** Apron extended south (new along-start): the GA "south ramp". */
  apronA0: number;
  holds: FieldHold[];
  /** New axis-aligned connector across 36/18 on the taxiway side (B east) and its west leg. */
  connectorB: { a: number; halfWidth: number };
  bWest: { a0: number; a1: number; c0: number; c1: number };
  /** Oblique taxiway C centreline (from taxiway A to the 21 threshold). */
  cLine: [P2, P2];
  /** T-hangar taxilanes (a ranges, c from taxiway A to the cross lane) and the cross lane. */
  tLanes: { a0: number; a1: number; c0: number; c1: number }[];
  buildings: FieldBuilding[];
  /** Extra tie-down spots on the south ramp (world x, z, nose heading). */
  parking: { x: number; z: number; headingDeg: number }[];
  helipad: { a: number; c: number; r: number };
  windsocks: { x: number; z: number }[];
  vehicles: FieldVehicle[];
  /** Flight-school car park and its cars. */
  carpark2: { a0: number; a1: number; c0: number; c1: number };
  /** Perimeter road centreline loop (closed, runway-36 coords) and its half width. */
  roadLoop: P2[];
  roadHalfWidth: number;
  /** Fence rectangle and gates (along the fence side). */
  fence: { a0: number; a1: number; c0: number; c1: number };
  gates: { side: 'north' | 'south' | 'east' | 'west'; from: number; to: number }[];
  /** PAPI placement per crossing-runway end: t of the units' line, s of the inner unit, side sign. */
  papi: { end: string; t: number; s: number; side: 1 | -1 }[];
}

const HOLD = 250 * 0.3048; // hold lines 250 ft from a runway centreline
/** Taxiway A (layout.ts): centreline 110 m east, 12 m wide. */
const TWY_C = 110;
const TWY_HW = 6;

const cache = new WeakMap<Config, AirportField>();

export function createAirportField(cfg: Config = CONFIG): AirportField {
  const hit = cache.get(cfg);
  if (hit) return hit;
  const frames = runwayFrames(cfg);
  const rw = frames[0];
  const cross = frames[1] ?? frames[0];
  const L = rw.length;
  const rc = (x: number, z: number): P2 => {
    const q = toRunwayCoords(x, z, rw);
    return { a: q.along, c: q.across };
  };
  /** Crossing-runway frame (t, s) → runway-36 coords. */
  const X = (t: number, s: number): P2 => {
    const w = fromRunwayCoords(t, s, cross);
    return rc(w.x, w.z);
  };
  const xRect = (t0: number, t1: number, s0: number, s1: number): P2[] => [X(t0, s0), X(t1, s0), X(t1, s1), X(t0, s1)];
  const worldOf = (p: P2) => fromRunwayCoords(p.a, p.c, rw);
  const heading = (da: number, dc: number) => {
    const x = rw.dir.x * da + rw.right.x * dc;
    const z = rw.dir.z * da + rw.right.z * dc;
    return ((((Math.atan2(x, -z) * 180) / Math.PI) % 360) + 360) % 360;
  };
  const west = heading(0, -1);
  const east = heading(0, 1);
  const north = heading(1, 0);
  const south = heading(-1, 0);

  // ── the crossing ────────────────────────────────────────────────────────────
  // centreline of the crossing runway: X(t, 0); solve c = 0
  const p0 = X(0, 0);
  const p1 = X(1, 0);
  const crossingT = -p0.c / (p1.c - p0.c);
  const crossing = X(crossingT, 0);
  const hwX = cross.halfWidth;
  const LX = cross.length;
  const rw36 = rectPoly(0, L, -rw.halfWidth, rw.halfWidth);
  const crossPieces = subtractAll(xRect(0, LX, -hwX, hwX), [rw36]);
  const paving: FieldPave[] = crossPieces.map((p, i) => ({ kind: 'runway', name: `rwy-${cross.name}-${i}`, p, frame: 1 }));

  // ── taxiway A north extension and taxiway C to the 21 threshold ─────────────
  const taxiwayA1 = L + 15;
  paving.push({ kind: 'taxiway', name: 'A-north', p: rectPoly(L - 19, taxiwayA1, TWY_C - TWY_HW, TWY_C + TWY_HW), frame: 0 });
  // C: perpendicular to the crossing runway at its far (21) threshold, from the runway to taxiway A
  const sSide = X(LX, -1).c < X(LX, 0).c ? -1 : 1; // side of the crossing runway toward taxiway A (−c)
  const cHalf = 6;
  const cRaw = xRect(LX - cHalf, LX + cHalf, sSide * hwX, sSide * 140);
  const cClip = intersectConvex(cRaw, rectPoly(-1e4, 1e4, TWY_C + TWY_HW, 1e4));
  paving.push({ kind: 'taxiway', name: 'C', p: cClip, frame: 1 });
  const sAtA = (TWY_C - X(LX, 0).c) / (X(LX, sSide).c - X(LX, 0).c); // s·sSide where C's centreline meets A's
  const cLine: [P2, P2] = [X(LX, sSide * sAtA), X(LX, 0)];

  // ── taxiway B: across 36/18 (connector) and west to the 03 threshold ───────
  const thr03 = X(0, 0);
  const bA = thr03.a;
  const bWest = { a0: bA - 6, a1: bA + 6, c0: thr03.c + 8, c1: -rw.halfWidth };
  paving.push({ kind: 'taxiway', name: 'B', p: rectPoly(bWest.a0, bWest.a1, bWest.c0, bWest.c1), frame: 0 });
  paving.push({ kind: 'taxiway', name: 'B-east', p: rectPoly(bA - 6, bA + 6, rw.halfWidth, TWY_C - TWY_HW), frame: 0 });

  // ── the GA south ramp (apron extended toward 36), T-hangars, ARFF ───────────
  const apronA0 = 396;
  const apronLayoutA0 = L / 2 - 190;
  paving.push({ kind: 'apron', name: 'south-ramp', p: rectPoly(apronA0, apronLayoutA0, TWY_C + TWY_HW, 246), frame: 0 });
  const tLanes: AirportField['tLanes'] = [];
  const laneW = 22;
  const rowD = 18;
  for (let i = 0; i < 4; i++) {
    const a0 = 140 + i * (laneW + rowD);
    tLanes.push({ a0, a1: a0 + laneW, c0: TWY_C + TWY_HW, c1: 264 });
  }
  const tCross = { a0: 140, a1: tLanes[3].a1, c0: 264, c1: 282 };
  for (const [i, l] of tLanes.entries()) paving.push({ kind: 'taxiway', name: `T${i + 1}`, p: rectPoly(l.a0, l.a1, l.c0, l.c1), frame: 0 });
  paving.push({ kind: 'taxiway', name: 'T-cross', p: rectPoly(tCross.a0, tCross.a1, tCross.c0, tCross.c1), frame: 0 });
  const arff = { a0: 318, a1: 366, c0: TWY_C + TWY_HW, c1: 168 };
  paving.push({ kind: 'apron', name: 'arff', p: rectPoly(arff.a0, arff.a1, arff.c0, arff.c1), frame: 0 });
  // the terminal's car park (plan.ts derives it the same way from the layout) — for landcover
  {
    const ap = (cfg === CONFIG ? getLayout() : createLayout(cfg)).airport;
    const term = rc(ap.terminal.center.x, ap.terminal.center.z);
    const acc = rc(ap.accessRoadStart.x, ap.accessRoadStart.z);
    const back = term.c + ap.terminal.depth / 2;
    let cp = { a0: acc.a - 18, a1: acc.a + 42, c0: back + 4, c1: back + 38 };
    const tw = rc(ap.tower.center.x, ap.tower.center.z);
    const tHalf = Math.max(ap.tower.width, ap.tower.depth) / 2 + 3;
    if (tw.c + tHalf > cp.c0 && tw.c - tHalf < cp.c1 && tw.a + tHalf > cp.a0 && tw.a - tHalf < cp.a1) cp = tw.a > acc.a ? { ...cp, a1: tw.a - tHalf } : { ...cp, a0: tw.a + tHalf };
    paving.push({ kind: 'carpark', name: 'terminal-carpark', p: rectPoly(cp.a0, cp.a1, cp.c0, cp.c1), frame: 0 });
  }
  const carpark2 = { a0: 522, a1: 572, c0: 268, c1: 300 };
  paving.push({ kind: 'carpark', name: 'school-carpark', p: rectPoly(carpark2.a0, carpark2.a1, carpark2.c0, carpark2.c1), frame: 0 });

  // ── fence and perimeter road ────────────────────────────────────────────────
  const fence = { a0: -(2400 * 0.3048 + 25), a1: L + 365, c0: -490, c1: 355 };
  const inset = 11;
  const roadHalfWidth = 2.5;
  const R = { a0: fence.a0 + inset, a1: fence.a1 - inset, c0: fence.c0 + inset, c1: fence.c1 - inset };
  const roadLoop: P2[] = [
    { a: R.a0, c: R.c0 },
    { a: R.a0, c: R.c1 },
    { a: R.a1, c: R.c1 },
    { a: R.a1, c: R.c0 },
  ];
  const hw = roadHalfWidth;
  // four straight pieces that meet without overlapping (north/south own the corners)
  const roadRects = [
    rectPoly(R.a0 - hw, R.a0 + hw, R.c0 - hw, R.c1 + hw),
    rectPoly(R.a1 - hw, R.a1 + hw, R.c0 - hw, R.c1 + hw),
    rectPoly(R.a0 + hw, R.a1 - hw, R.c0 - hw, R.c0 + hw),
  ];
  // the east side is split where the access road leaves the field (the roads system draws that crossing)
  const accA = L / 2 - 10 - 20;
  roadRects.push(rectPoly(R.a0 + hw, accA - 12, R.c1 - hw, R.c1 + hw), rectPoly(accA + 8, R.a1 - hw, R.c1 - hw, R.c1 + hw));
  // a service road from the flight-school car park to the perimeter road
  roadRects.push(rectPoly(540, 552, carpark2.c1, R.c1 - hw));
  for (const [i, p] of roadRects.entries()) paving.push({ kind: 'road', name: `road-${i}`, p, frame: 0 });
  const gates: AirportField['gates'] = [
    { side: 'east', from: 196, to: 212 }, // fuel farm deliveries
    { side: 'west', from: 890, to: 904 },
    { side: 'north', from: 40, to: 54 },
  ];

  // ── hold positions ──────────────────────────────────────────────────────────
  const holds: FieldHold[] = [];
  const aRect = rectPoly(19, taxiwayA1, TWY_C - TWY_HW, TWY_C + TWY_HW);
  const sOf = (p: P2) => {
    const w = worldOf(p);
    return toRunwayCoords(w.x, w.z, cross).across;
  };
  /**
   * A mandatory sign on the holding pilot's left, `dist` off the taxiway centreline, just behind the
   * hold lines: p0 = a point on the centreline, dir = the pilot's direction (unit, toward the runway),
   * sOf = the runway-distance function the hold uses, target = its value at the sign.
   */
  const holdSign = (p0: P2, dir: P2, dist: number, dOf: (p: P2) => number, target: number) => {
    const left = { a: dir.c, c: -dir.a };
    const q = (u: number): P2 => ({ a: p0.a + dir.a * u + left.a * dist, c: p0.c + dir.c * u + left.c * dist });
    const d0 = dOf(q(0));
    const d1 = dOf(q(1));
    const u = (target - d0) / (d1 - d0);
    const p = q(u);
    return { a: p.a, c: p.c, faceDeg: (heading(dir.a, dir.c) + 180) % 360 };
  };
  const behind = HOLD + 3;
  // taxiway A crosses the crossing runway: hold both sides (lines parallel to that runway)
  const aCross = (() => {
    const s0 = sOf({ a: 0, c: TWY_C });
    const s1 = sOf({ a: 1, c: TWY_C });
    return -s0 / (s1 - s0);
  })();
  for (const sd of [1, -1] as const) {
    const s0 = sOf({ a: 0, c: TWY_C });
    const s1 = sOf({ a: 1, c: TWY_C });
    const a = (sd * HOLD - s0) / (s1 - s0);
    const northbound = a < aCross;
    const dir = { a: northbound ? 1 : -1, c: 0 };
    holds.push({
      name: 'A',
      sign: northbound ? '3-21' : '21-3',
      runway: 1,
      lineFrame: 'cross',
      d0: sd * HOLD,
      dir: sd,
      clip: aRect,
      signs: [holdSign({ a, c: TWY_C }, dir, TWY_HW + 4.5, sOf, sd * behind)],
    });
  }
  // B at the 03 threshold (holding side toward 36/18), C at the 21 threshold
  {
    const bRect = rectPoly(bWest.a0, bWest.a1, bWest.c0, bWest.c1);
    const sEast = (sOf({ a: bA, c: -rw.halfWidth }) > 0 ? 1 : -1) as 1 | -1;
    holds.push({ name: 'B', sign: '3', runway: 1, lineFrame: 'cross', d0: sEast * HOLD, dir: sEast, clip: bRect, signs: [holdSign({ a: bA, c: -rw.halfWidth - 20 }, { a: 0, c: -1 }, TWY_HW + 4.5, sOf, sEast * behind)] });
    const [cA, cR] = cLine;
    const len = Math.hypot(cR.a - cA.a, cR.c - cA.c);
    const dirC = { a: (cR.a - cA.a) / len, c: (cR.c - cA.c) / len };
    holds.push({ name: 'C', sign: '21', runway: 1, lineFrame: 'cross', d0: sSide * HOLD, dir: sSide as 1 | -1, clip: cClip, signs: [holdSign(cA, dirC, cHalf + 4.5, sOf, sSide * behind)] });
  }
  // on the crossing runway itself, clear of 36/18 (both sides of the intersection)
  {
    const cosA = Math.abs(X(1, 0).c - X(0, 0).c); // |dc/dt| along the crossing centreline
    const halfSpan = Math.abs(X(0, hwX).c - X(0, 0).c); // c spread of half the runway width
    const tSW = crossingT - (HOLD + halfSpan) / cosA;
    const tNE = crossingT + (HOLD + halfSpan) / cosA;
    const strip = xRect(0, LX, -hwX, hwX);
    const cHdg = cross.headingDeg;
    const runwayName = cross.name.split('/').map((d) => String(Number(d))).join('-');
    for (const [t, dir, sign] of [
      [tSW, -1, '18-36'],
      [tNE, 1, '36-18'],
    ] as const) {
      const pilotHdg = dir < 0 ? cHdg : (cHdg + 180) % 360;
      const face = (pilotHdg + 180) % 360;
      const signs = [-1, 1].map((sd) => {
        const p = X(t + dir * 4, sd * (hwX + 6));
        return { a: p.a, c: p.c, faceDeg: face };
      });
      holds.push({ name: runwayName, sign, runway: 0, lineFrame: 'crossT', d0: t, dir: dir as 1 | -1, clip: strip, signs });
    }
  }

  // ── buildings ───────────────────────────────────────────────────────────────
  const buildings: FieldBuilding[] = [];
  for (let i = 0; i < 3; i++) {
    const a = tLanes[i].a1 + rowD / 2;
    buildings.push({ kind: 'thangar', a, c: 200, headingDeg: south, width: 116, depth: 16, height: 4.6, seed: i });
  }
  buildings.push({ kind: 'fireStation', a: (arff.a0 + arff.a1) / 2, c: arff.c1 + 12, headingDeg: west, width: 36, depth: 22, height: 13 });
  buildings.push({ kind: 'maintHangar', a: 446, c: 267, headingDeg: west, width: 46, depth: 34, height: 12 });
  buildings.push({ kind: 'flightSchool', a: 548, c: 256, headingDeg: west, width: 26, depth: 14, height: 7.6 });
  buildings.push({ kind: 'fuelFarm', a: 205, c: 322, headingDeg: west, width: 32, depth: 20, height: 5 });
  buildings.push({ kind: 'vor', a: 905, c: -405, headingDeg: north, width: 18, depth: 18, height: 6.5 });
  buildings.push({ kind: 'localizer', a: L + 300, c: 0, headingDeg: south, width: 34, depth: 4, height: 3 });
  buildings.push({ kind: 'glideslope', a: 300, c: -150, headingDeg: south, width: 7, depth: 7, height: 12.5 });

  // ── parking on the south ramp, helipad, vehicles, windsocks ─────────────────
  const parking: AirportField['parking'] = [];
  for (const c of [TWY_C + TWY_HW + 29, TWY_C + TWY_HW + 71])
    for (let a = apronA0 + 44; a <= apronLayoutA0 - 20; a += 24) {
      const w = worldOf({ a, c });
      parking.push({ x: w.x, z: w.z, headingDeg: west });
    }
  const helipad = { a: apronA0 + 20, c: 226, r: 9 };
  const V = (kind: FieldVehicleKind, a: number, c: number, headingDeg: number, variant = 0, shade = 1): FieldVehicle => ({ kind, a, c, headingDeg, variant, shade });
  const vehicles: FieldVehicle[] = [
    V('kingair', 590, 224, west, 0),
    V('kingair', 446 + 2, 267 + 3, west, 1, 0.32), // in the maintenance hangar
    V('helicopter', helipad.a, helipad.c, north, 0),
    V('arff', arff.a0 + 12, arff.c0 + 24, west, 0),
    V('arff', arff.a1 - 12, arff.c0 + 24, west, 1),
    V('fueltruck', 206, 300, north, 0),
    V('fueltruck', 702, 236, north, 1),
    V('baggage', 790, 236, north, 0),
    V('tug', 432, 242, north, 0),
    V('pickup', 372, 138, south, 0),
  ];
  const endSock = (fr: RunwayFrame, t: number, s: number) => {
    const w = fromRunwayCoords(t, s, fr);
    return { x: w.x, z: w.z };
  };
  const windsocks = [
    endSock(rw, 150, -60),
    endSock(rw, L - 150, 60),
    endSock(cross, 150, -60),
    endSock(cross, LX - 150, 60),
  ];
  const papi: AirportField['papi'] = [
    { end: '3', t: 286, s: -(hwX + 15), side: -1 },
    { end: '21', t: LX - 250, s: -(hwX + 15), side: -1 },
  ];

  const field: AirportField = {
    rw,
    cross,
    crossing,
    crossingT,
    paving,
    taxiwayA1,
    apronA0,
    holds,
    connectorB: { a: bA, halfWidth: 6 },
    bWest,
    cLine,
    tLanes: [...tLanes, tCross],
    buildings,
    parking,
    helipad,
    windsocks,
    vehicles,
    carpark2,
    roadLoop,
    roadHalfWidth,
    fence,
    gates,
    papi,
  };
  cache.set(cfg, field);
  return field;
}

export interface WorldPave {
  kind: FieldKind;
  /** Convex polygon in world x, z. */
  poly: { x: number; z: number }[];
  x0: number;
  x1: number;
  z0: number;
  z1: number;
}

/** The field's pavement in world coordinates (for landcover: surface types, no grass/trees on it). */
export function fieldPaving(cfg: Config = CONFIG): WorldPave[] {
  const f = createAirportField(cfg);
  return f.paving.map((p) => {
    const poly = p.p.map((q) => fromRunwayCoords(q.a, q.c, f.rw));
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const q of poly) {
      x0 = Math.min(x0, q.x);
      x1 = Math.max(x1, q.x);
      z0 = Math.min(z0, q.z);
      z1 = Math.max(z1, q.z);
    }
    return { kind: p.kind, poly, x0, x1, z0, z1 };
  });
}
