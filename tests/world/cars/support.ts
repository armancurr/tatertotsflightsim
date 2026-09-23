/** Invariant checks and collision tests shared by the cars sim tests. */
import { expect } from 'vitest';
import { TrafficSim, type PathPoint, type VehiclePose } from '../../../src/world/cars/sim';
import { SPECS, SEMI, VT } from '../../../src/world/cars/specs';
import type { LaneGraph } from '../../../src/world/cars/lanes';

export const newPose = (): VehiclePose => TrafficSim.newPose();

/** Checks every structural invariant of the simulation state; returns the violations (empty = OK). */
export function invariantErrors(sim: TrafficSim, g: LaneGraph): string[] {
  const err: string[] = [];
  let alive = 0;
  const occ = new Map<number, number>();
  const byLane = new Map<number, number[]>();
  const byConn = new Map<number, number[]>();
  for (let i = 0; i < sim.cap; i++) {
    if (!sim.alive[i]) continue;
    alive++;
    const sp = SPECS[sim.type[i]];
    if (!(Number.isFinite(sim.v[i]) && Number.isFinite(sim.acc[i]) && Number.isFinite(sim.odo[i]))) err.push(`car ${i}: NaN state`);
    if (!(sim.v[i] >= 0 && sim.v[i] <= sp.vmax + 0.5)) err.push(`car ${i}: speed ${sim.v[i]}`);
    if (sim.conn[i] >= 0) {
      const c = g.connectors[sim.conn[i]];
      if (sim.lane[i] !== -1) err.push(`car ${i}: lane and connector`);
      if (!(sim.w[i] >= -1e-6 && sim.w[i] <= c.len + 1e-6)) err.push(`car ${i}: w ${sim.w[i]} / ${c.len}`);
      (byConn.get(c.id) ?? byConn.set(c.id, []).get(c.id)!).push(i);
    } else {
      const l = sim.lane[i];
      if (l < 0) {
        err.push(`car ${i}: nowhere`);
        continue;
      }
      if (!(sim.u[i] >= -1e-6 && sim.u[i] <= g.laneLen[l] + 1e-6)) err.push(`car ${i}: u ${sim.u[i]} / ${g.laneLen[l]}`);
      if (sp.width > g.laneMaxW[l] + 1e-6) err.push(`car ${i}: type ${sim.type[i]} too wide for lane ${l}`);
      if ((g.pKind[l >> 1] === 5) !== (sim.type[i] === VT.tractor)) err.push(`car ${i}: type ${sim.type[i]} on kind ${g.pKind[l >> 1]}`);
      (byLane.get(l) ?? byLane.set(l, []).get(l)!).push(i);
    }
    for (const h of sim.holdsOf(i)) occ.set(h, (occ.get(h) ?? 0) + 1);
  }
  if (alive !== sim.count) err.push(`count ${sim.count} != alive ${alive}`);
  if (alive > sim.cap) err.push('over capacity');
  for (const c of g.connectors) if (sim.occupancy(c.id) !== (occ.get(c.id) ?? 0)) err.push(`connector ${c.id}: occupancy ${sim.occupancy(c.id)} != holders ${occ.get(c.id) ?? 0}`);
  // spacing: bumper gaps on one lane / one connector are never negative
  const gapCheck = (list: number[], pos: (i: number) => number, where: string) => {
    list.sort((a, b) => pos(a) - pos(b));
    for (let k = 1; k < list.length; k++) {
      const a = list[k - 1];
      const b = list[k];
      const gap = pos(b) - pos(a) - (SPECS[sim.type[a]].length + SPECS[sim.type[b]].length) / 2;
      if (gap < -0.05) err.push(`${where}: cars ${a}/${b} gap ${gap.toFixed(2)}`);
    }
  };
  for (const [l, list] of byLane) gapCheck(list, (i) => sim.u[i], `lane ${l}`);
  for (const [c, list] of byConn) gapCheck(list, (i) => sim.w[i], `connector ${c}`);
  return err;
}

export function checkInvariants(sim: TrafficSim, g: LaneGraph): void {
  expect(invariantErrors(sim, g)).toEqual([]);
}

export interface Box {
  x: number;
  z: number;
  hx: number;
  hz: number;
  hl: number;
  hw: number;
  car: number;
}

/** Oriented footprints (body + trailer) of every moving vehicle, from its pose. */
export function footprints(sim: TrafficSim, pose: VehiclePose): Box[] {
  const out: Box[] = [];
  for (let i = 0; i < sim.cap; i++) {
    if (!sim.alive[i]) continue;
    sim.pose(i, 0, pose);
    const sp = SPECS[sim.type[i]];
    if (sim.type[i] === VT.semi) {
      // tractor: front bumper → just behind the rear axle
      const tl = 6.3;
      const cxT = pose.fx + pose.hx * (sp.frontOverhang - tl / 2);
      const czT = pose.fz + pose.hz * (sp.frontOverhang - tl / 2);
      out.push({ x: cxT, z: czT, hx: pose.hx, hz: pose.hz, hl: tl / 2, hw: sp.width / 2, car: i });
      const tlen = SEMI.trailerRear - SEMI.trailerFront;
      const k = SEMI.kingpin - SEMI.trailerFront;
      out.push({ x: pose.kx - pose.thx * (tlen / 2 - k), z: pose.kz - pose.thz * (tlen / 2 - k), hx: pose.thx, hz: pose.thz, hl: tlen / 2, hw: SEMI.trailerWidth / 2, car: i });
    } else {
      // body centre: front axle + overhang ahead
      const front = { x: pose.fx + pose.hx * sp.frontOverhang, z: pose.fz + pose.hz * sp.frontOverhang };
      out.push({ x: front.x - pose.hx * (sp.length / 2), z: front.z - pose.hz * (sp.length / 2), hx: pose.hx, hz: pose.hz, hl: sp.length / 2, hw: sp.width / 2, car: i });
    }
  }
  return out;
}

/** Penetration depth of two oriented rectangles (SAT), ≤ 0 if apart. */
export function overlap(a: Box, b: Box): number {
  const axes = [
    [a.hx, a.hz],
    [-a.hz, a.hx],
    [b.hx, b.hz],
    [-b.hz, b.hx],
  ];
  let minPen = Infinity;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  for (const [ux, uz] of axes) {
    const ra = a.hl * Math.abs(ux * a.hx + uz * a.hz) + a.hw * Math.abs(-ux * a.hz + uz * a.hx);
    const rb = b.hl * Math.abs(ux * b.hx + uz * b.hz) + b.hw * Math.abs(-ux * b.hz + uz * b.hx);
    const d = Math.abs(dx * ux + dz * uz);
    const pen = ra + rb - d;
    if (pen <= 0) return pen;
    minPen = Math.min(minPen, pen);
  }
  return minPen;
}

/** Pairs of different vehicles whose footprints overlap by more than `tol` metres. */
export function collisions(boxes: Box[], tol: number): [Box, Box, number][] {
  const cell = 24;
  const grid = new Map<number, Box[]>();
  const key = (i: number, j: number) => i * 100003 + j;
  for (const b of boxes) {
    const k = key(Math.floor(b.x / cell), Math.floor(b.z / cell));
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(b);
  }
  const hits: [Box, Box, number][] = [];
  for (const a of boxes) {
    const ci = Math.floor(a.x / cell);
    const cj = Math.floor(a.z / cell);
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const l = grid.get(key(ci + di, cj + dj));
        if (!l) continue;
        for (const b of l) {
          if (b.car <= a.car) continue;
          const pen = overlap(a, b);
          if (pen > tol) hits.push([a, b, pen]);
        }
      }
  }
  return hits;
}

export type { PathPoint };
