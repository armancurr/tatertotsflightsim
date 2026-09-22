/**
 * The airport plan: everything the airport renderer needs beyond layout.ts,
 * derived deterministically from `layout.airport` in RUNWAY coordinates
 * (a = metres along runway 36 from its threshold, c = metres right of the
 * centreline facing 36, i.e. east for a north-pointing runway). PURE.
 *
 * - pavement pieces that never overlap (the layout rectangles overlap by a
 *   metre where they join; overlapping coplanar surfaces would z-fight), plus
 *   curved fillets at every junction;
 * - hold-short line positions, apron taxilanes, the car park and its stalls;
 * - hangar styles, parked aircraft (subset of the parking spots + livery),
 *   parked cars, the perimeter fence and its gate for the access road.
 */
import { getLayout, type AirportLayout, type BuildingSpot, type OrientedRect, type Road, type Spot, type XZ } from '../layout';
import { fromRunwayCoords, toRunwayCoords, type RunwayFrame } from '../runway';
import { mulberry32 } from '../noise';

export interface RC {
  a: number;
  c: number;
}
export interface ABox {
  a0: number;
  a1: number;
  c0: number;
  c1: number;
}
export type PaveKind = 'runway' | 'taxiway' | 'apron' | 'carpark';
export interface PaveRect extends ABox {
  kind: PaveKind;
  name: string;
}
/** A concave-cornered fillet: triangle fan from `corner` over the `arc` points. */
export interface PaveFillet {
  kind: PaveKind;
  corner: RC;
  arc: RC[];
}
export interface Connector {
  name: string;
  /** Centreline along-runway position. */
  a: number;
  halfWidth: number;
  /** Across coordinate at the runway edge and at the parallel taxiway edge. */
  c0: number;
  c1: number;
}
export interface HoldLine {
  name: string;
  a: number;
  /** Across position of the hold line (centre of the 4-line marking). */
  c: number;
  halfWidth: number;
  /** +1 if the taxiway (holding) side is toward +c. */
  side: 1 | -1;
}
export type RoofStyle = 'arched' | 'gabled';
export interface HangarPlan {
  spot: BuildingSpot;
  roof: RoofStyle;
  wall: number;
  door: number;
  roofColor: number;
  /** 0 = closed, 1 = fully open. */
  doorOpen: number;
}
export interface ParkedAircraft {
  x: number;
  z: number;
  headingDeg: number;
  livery: number;
}
export interface ParkedCar {
  x: number;
  z: number;
  headingDeg: number;
  color: number;
}
export interface Stall {
  a: number;
  c0: number;
  c1: number;
  /** +1 if the car noses toward +c. */
  facing: 1 | -1;
}
export interface FencePlan extends ABox {
  /** Openings. `from`/`to` run along the side (a for east/west, c for north/south). */
  gates: { side: 'north' | 'south' | 'east' | 'west'; from: number; to: number }[];
}
export interface AirportPlan {
  layout: AirportLayout;
  rw: RunwayFrame;
  elevation: number;
  pavement: PaveRect[];
  fillets: PaveFillet[];
  runway: ABox;
  taxiway: { name: string; c: number; halfWidth: number; a0: number; a1: number };
  connectors: Connector[];
  apron: ABox;
  carpark: ABox;
  stalls: Stall[];
  holdLines: HoldLine[];
  /** Apron taxilane centrelines (across position, along extent). */
  taxilanes: { c: number; a0: number; a1: number }[];
  hangars: HangarPlan[];
  tower: BuildingSpot;
  terminal: BuildingSpot;
  fuel: Spot;
  /** Fuel installation: self-serve pump island and the above-ground tank behind it. */
  fuelPump: XZ;
  fuelTank: XZ;
  parked: ParkedAircraft[];
  cars: ParkedCar[];
  windsock: XZ;
  fence: FencePlan;
  /** Radius of the filleted junction corners, m. */
  filletRadius: number;
}

export const LIVERY_COUNT = 5;
export const CAR_COLOR_COUNT = 8;
/** Hold-short lines 250 ft from the runway centreline (precision runway, small aircraft). */
export const HOLD_LINE_DISTANCE = 250 * 0.3048;
const FILLET_R = 12;

/** A layout.ts oriented rectangle as an along/across box (it is aligned with the runway). */
export function rectOfLayout(r: OrientedRect, rw: RunwayFrame): ABox {
  const c = toRunwayCoords(r.center.x, r.center.z, rw);
  const rel = (((r.headingDeg - rw.headingDeg) % 180) + 180) % 180;
  const alongIsLong = rel < 45 || rel > 135;
  const ha = alongIsLong ? r.halfLength : r.halfWidth;
  const hc = alongIsLong ? r.halfWidth : r.halfLength;
  return { a0: c.along - ha, a1: c.along + ha, c0: c.across - hc, c1: c.across + hc };
}

const spotRC = (p: { x: number; z: number }, rw: RunwayFrame): RC => {
  const r = toRunwayCoords(p.x, p.z, rw);
  return { a: r.along, c: r.across };
};

function fillet(corner: RC, da: number, dc: number, R: number, kind: PaveKind): PaveFillet {
  // Region bounded by the two straight edges leaving `corner` along (da,0) and (0,dc), and the
  // concave arc of radius R tangent to both: centre at corner + (da·R, dc·R).
  const cx = corner.a + da * R;
  const cc = corner.c + dc * R;
  const arc: RC[] = [];
  const steps = 8;
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * (Math.PI / 2);
    // from (corner.a + da·R, corner.c) to (corner.a, corner.c + dc·R)
    arc.push({ a: cx - da * R * Math.sin(t), c: cc - dc * R * Math.cos(t) });
  }
  return { kind, corner, arc };
}

export function pointInFillet(f: PaveFillet, a: number, c: number): boolean {
  const p0 = f.corner;
  for (let i = 0; i < f.arc.length - 1; i++) {
    const p1 = f.arc[i];
    const p2 = f.arc[i + 1];
    const d1 = (p1.a - p0.a) * (c - p0.c) - (p1.c - p0.c) * (a - p0.a);
    const d2 = (p2.a - p1.a) * (c - p1.c) - (p2.c - p1.c) * (a - p1.a);
    const d3 = (p0.a - p2.a) * (c - p2.c) - (p0.c - p2.c) * (a - p2.a);
    const neg = d1 < 0 || d2 < 0 || d3 < 0;
    const pos = d1 > 0 || d2 > 0 || d3 > 0;
    if (!(neg && pos)) return true;
  }
  return false;
}

export function pavementAt(plan: AirportPlan, a: number, c: number): PaveKind | null {
  for (const r of plan.pavement) if (a >= r.a0 && a <= r.a1 && c >= r.c0 && c <= r.c1) return r.kind;
  for (const f of plan.fillets) if (pointInFillet(f, a, c)) return f.kind;
  return null;
}

export function toWorld(plan: AirportPlan, a: number, c: number): XZ {
  return fromRunwayCoords(a, c, plan.rw);
}

/** World heading (deg) of a direction given in runway coordinates (da, dc). */
export function headingOfRC(rw: RunwayFrame, da: number, dc: number): number {
  const x = rw.dir.x * da + rw.right.x * dc;
  const z = rw.dir.z * da + rw.right.z * dc;
  return ((((Math.atan2(x, -z) * 180) / Math.PI) % 360) + 360) % 360;
}

export function createAirportPlan(ap: AirportLayout = getLayout().airport, roads: Road[] = ap === getLayout().airport ? getLayout().roads : []): AirportPlan {
  const rw = ap.runway;
  const L = rw.length;
  const hwR = rw.halfWidth;
  const rnd = mulberry32(0xa1_2f07);

  // ── taxiways ──────────────────────────────────────────────────────────────
  const par = ap.taxiways.find((t) => t.kind === 'parallel');
  if (!par) throw new Error('airport layout has no parallel taxiway');
  const pb = rectOfLayout(par.rect, rw);
  const side = (pb.c0 + pb.c1) / 2 >= 0 ? 1 : -1;
  const twNear = side > 0 ? pb.c0 : pb.c1; // edge facing the runway
  const twFar = side > 0 ? pb.c1 : pb.c0;
  const taxiway = { name: par.name, c: (pb.c0 + pb.c1) / 2, halfWidth: (pb.c1 - pb.c0) / 2, a0: pb.a0, a1: pb.a1 };

  const connectors: Connector[] = ap.taxiways
    .filter((t) => t.kind === 'connector')
    .map((t) => {
      const b = rectOfLayout(t.rect, rw);
      return { name: t.name, a: (b.a0 + b.a1) / 2, halfWidth: (b.a1 - b.a0) / 2, c0: side * hwR, c1: twNear };
    });

  const ab = rectOfLayout(ap.apron, rw);
  const apron: ABox = side > 0 ? { ...ab, c0: Math.max(ab.c0, twFar) } : { ...ab, c1: Math.min(ab.c1, twFar) };

  // ── car park behind the terminal, around the access road start ────────────
  const term = spotRC(ap.terminal.center, rw);
  const acc = spotRC(ap.accessRoadStart, rw);
  const termBack = term.c + side * (ap.terminal.depth / 2);
  const cpC0 = termBack + side * 4;
  const cpC1 = termBack + side * 38;
  let carpark: ABox = { a0: acc.a - 18, a1: acc.a + 42, c0: Math.min(cpC0, cpC1), c1: Math.max(cpC0, cpC1) };
  // keep clear of the tower
  const tw = spotRC(ap.tower.center, rw);
  const tHalf = Math.max(ap.tower.width, ap.tower.depth) / 2 + 3;
  if (tw.c + tHalf > carpark.c0 && tw.c - tHalf < carpark.c1 && tw.a + tHalf > carpark.a0 && tw.a - tHalf < carpark.a1) {
    if (tw.a > acc.a) carpark = { ...carpark, a1: tw.a - tHalf };
    else carpark = { ...carpark, a0: tw.a + tHalf };
  }

  const pavement: PaveRect[] = [
    { kind: 'runway', name: 'runway', a0: 0, a1: L, c0: -hwR, c1: hwR },
    { kind: 'taxiway', name: taxiway.name, a0: pb.a0, a1: pb.a1, c0: pb.c0, c1: pb.c1 },
    ...connectors.map((k) => ({
      kind: 'taxiway' as const,
      name: k.name,
      a0: k.a - k.halfWidth,
      a1: k.a + k.halfWidth,
      c0: Math.min(k.c0, k.c1),
      c1: Math.max(k.c0, k.c1),
    })),
    { kind: 'apron', name: 'apron', ...apron },
    { kind: 'carpark', name: 'carpark', ...carpark },
  ];

  // ── fillets ───────────────────────────────────────────────────────────────
  const fillets: PaveFillet[] = [];
  const R = FILLET_R;
  for (const k of connectors) {
    for (const s of [-1, 1] as const) {
      const ea = k.a + s * k.halfWidth;
      // runway junction (runway exists from 0 to L)
      if (ea + s * R >= 0 && ea + s * R <= L) fillets.push(fillet({ a: ea, c: side * hwR }, s, side, R, 'taxiway'));
      // parallel taxiway junction
      if (ea + s * R >= taxiway.a0 && ea + s * R <= taxiway.a1) fillets.push(fillet({ a: ea, c: twNear }, s, -side as 1 | -1, R, 'taxiway'));
    }
  }
  for (const s of [-1, 1] as const) {
    const ea = s < 0 ? apron.a0 : apron.a1;
    if (ea + s * R >= taxiway.a0 && ea + s * R <= taxiway.a1) fillets.push(fillet({ a: ea, c: twFar }, s, side, R, 'taxiway'));
  }

  // ── hold lines ────────────────────────────────────────────────────────────
  const holdLines: HoldLine[] = connectors.map((k) => ({
    name: k.name,
    a: k.a,
    c: side * HOLD_LINE_DISTANCE,
    halfWidth: k.halfWidth,
    side,
  }));

  // ── apron taxilanes ──────────────────────────────────────────────────────
  const rows = [...new Set(ap.parkingSpots.map((p) => Math.round(spotRC(p, rw).c * 10) / 10))].sort((x, y) => side * (x - y));
  const lanes: number[] = [];
  if (rows.length) {
    lanes.push((twFar + rows[0] - side * 4) / 2);
    for (let i = 1; i < rows.length; i++) lanes.push((rows[i - 1] + rows[i]) / 2);
    const hangarFront = Math.min(...ap.hangars.map((h) => Math.abs(spotRC(h.center, rw).c) - h.depth / 2));
    lanes.push(side * ((Math.abs(rows[rows.length - 1]) + 5 + hangarFront) / 2));
  }
  const taxilanes = lanes.map((c) => ({ c, a0: apron.a0 + 10, a1: apron.a1 - 10 }));

  // ── hangars ─────────────────────────────────────────────────────────────
  const roofs: RoofStyle[] = ['gabled', 'arched', 'arched', 'gabled', 'arched'];
  const walls = [0xc9cdcf, 0xd9d2c0, 0xe4e6e6, 0xa9b3b8, 0xcfc9bb];
  const doors = [0x6f7f8c, 0x8a8f94, 0xb8bcbf, 0x7a4a3a, 0x5d6e7a];
  const roofCols = [0x9aa0a4, 0x8e9396, 0xa6abad, 0x6a6f72, 0x949a9c];
  const biggest = ap.hangars.reduce((bi, h, i, arr) => (h.width * h.depth > arr[bi].width * arr[bi].depth ? i : bi), 0);
  const hangars: HangarPlan[] = ap.hangars.map((spot, i) => ({
    spot,
    roof: i === biggest ? 'arched' : roofs[i % roofs.length],
    wall: walls[i % walls.length],
    door: doors[i % doors.length],
    roofColor: roofCols[i % roofCols.length],
    doorOpen: i === biggest ? 0.42 : i === 3 ? 0.25 : 0,
  }));

  // ── parked aircraft ───────────────────────────────────────────────────────
  const spots = ap.parkingSpots.map((s, i) => ({ s, i, r: rnd() }));
  const chosen = spots.filter((p) => p.r < 0.45).slice(0, 14);
  if (chosen.length < 6) for (const p of spots) if (chosen.length < 8 && !chosen.includes(p)) chosen.push(p);
  const parked: ParkedAircraft[] = chosen.map((p, k) => ({
    x: p.s.x,
    z: p.s.z,
    headingDeg: p.s.headingDeg + (rnd() - 0.5) * 4,
    livery: k % LIVERY_COUNT,
  }));

  // ── car park stalls and cars ─────────────────────────────────────────────
  const stalls: Stall[] = [];
  const cpw = carpark.c1 - carpark.c0;
  const depth = 5.0;
  const rowsC: { c0: number; facing: 1 | -1 }[] = [
    { c0: carpark.c0 + 0.3, facing: -1 },
    { c0: carpark.c0 + cpw / 2 - depth, facing: -1 },
    { c0: carpark.c0 + cpw / 2, facing: 1 },
    { c0: carpark.c1 - 0.3 - depth, facing: 1 },
  ];
  const stallW = 2.7;
  const nStall = Math.floor((carpark.a1 - carpark.a0 - 2) / stallW);
  for (const r of rowsC)
    for (let i = 0; i < nStall; i++) stalls.push({ a: carpark.a0 + 1 + (i + 0.5) * stallW, c0: r.c0, c1: r.c0 + depth, facing: r.facing });
  const cars: ParkedCar[] = [];
  for (const st of stalls) {
    if (rnd() > 0.24) continue;
    const c = (st.c0 + st.c1) / 2 + (rnd() - 0.5) * 0.3;
    const p = fromRunwayCoords(st.a + (rnd() - 0.5) * 0.25, c, rw);
    const faceC = st.facing * side; // nose toward −c/+c in runway coords
    cars.push({ x: p.x, z: p.z, headingDeg: headingOfRC(rw, (rnd() - 0.5) * 0.06, faceC), color: Math.floor(rnd() * CAR_COLOR_COUNT) });
  }
  if (cars.length < 4)
    for (let i = 0; cars.length < 4 && i < stalls.length; i += 3) {
      const st = stalls[i];
      const p = fromRunwayCoords(st.a, (st.c0 + st.c1) / 2, rw);
      if (!cars.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 1)) cars.push({ x: p.x, z: p.z, headingDeg: headingOfRC(rw, 0, st.facing * side), color: i % CAR_COLOR_COUNT });
    }

  const fuelRC = spotRC(ap.fuel, rw);

  // ── fence ────────────────────────────────────────────────────────────────
  const buildings = [ap.tower, ap.terminal, ...ap.hangars].map((b) => ({ ...spotRC(b.center, rw), r: Math.max(b.width, b.depth) / 2 }));
  const eastMost = Math.max(carpark.c1, ...buildings.map((b) => b.c + b.r));
  const westMost = Math.min(-hwR, spotRC(ap.windsock, rw).c - 20, ...buildings.map((b) => b.c - b.r));
  const fence: FencePlan = {
    a0: -(2400 * 0.3048 + 25),
    a1: L + 250,
    c0: westMost - 70,
    c1: eastMost + 28,
    gates: [],
  };
  // gate where the access road leaves the field
  const accessRoad = roads.find((r) => r.kind === 'access' && Math.hypot(r.points[0].x - ap.accessRoadStart.x, r.points[0].z - ap.accessRoadStart.z) < 50);
  let gateA = acc.a;
  if (accessRoad) {
    const fc = side > 0 ? fence.c1 : fence.c0;
    for (let i = 1; i < accessRoad.points.length; i++) {
      const p = spotRC(accessRoad.points[i - 1], rw);
      const q = spotRC(accessRoad.points[i], rw);
      if ((p.c - fc) * (q.c - fc) <= 0 && q.c !== p.c) {
        gateA = p.a + ((fc - p.c) / (q.c - p.c)) * (q.a - p.a);
        break;
      }
    }
  }
  fence.gates.push({ side: side > 0 ? 'east' : 'west', from: gateA - 8, to: gateA + 8 });

  return {
    layout: ap,
    rw,
    elevation: ap.elevation,
    pavement,
    fillets,
    runway: { a0: 0, a1: L, c0: -hwR, c1: hwR },
    taxiway,
    connectors,
    apron,
    carpark,
    stalls,
    holdLines,
    taxilanes,
    hangars,
    tower: ap.tower,
    terminal: ap.terminal,
    fuel: ap.fuel,
    fuelPump: fromRunwayCoords(fuelRC.a, fuelRC.c + side * 4, rw),
    fuelTank: fromRunwayCoords(fuelRC.a, fuelRC.c + side * 11, rw),
    parked,
    cars,
    windsock: ap.windsock,
    fence,
    filletRadius: R,
  };
}
