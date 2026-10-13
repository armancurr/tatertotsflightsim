/**
 * The big-ship port's structures as physics obstacles (PURE): the cruise terminal and the naval
 * pier (src/world/harbour/layout.ts) as obstacle columns in each pier's frame — `top(x, z)` = the
 * height (m MSL) of whatever stands there, −Infinity over open water — built from the same layout
 * and PORT_DIMS the models (models.ts) draw; tests/world/harbour/obstacles.test.ts samples the drawn
 * geometry against them. The pier decks are also landable (`deckTop`): a helicopter may set down on
 * them (src/world/environment.ts `registerDeckSource`).
 *
 * Primitives and the bucketed lookup are the marina's (src/world/traffic/harbourObstacles.ts).
 */
import { buildSet, obstacleSetTop, type ObstacleSet, type Prim } from '../traffic/harbourObstacles';
import { PORT_DIMS, type CruiseTerminalLayout, type NavalPierLayout, type PortWorks } from './layout';

const D = PORT_DIMS;

/** Railings along a deck edge (a thin wall 1.1 m high). */
function rail(P: Prim[], u0: number, u1: number, w: number, y: number): void {
  P.push({ k: 0, u0, u1, w0: w - 0.08, w1: w + 0.08, top: y + 1.1 });
}

export function cruisePrims(c: CruiseTerminalLayout): Prim[] {
  const P: Prim[] = [];
  const y = c.deckY;
  const t = c.trestle;
  P.push({ k: 0, u0: t.u0, u1: t.u1 + 1, w0: -t.half, w1: t.half, top: y });
  rail(P, t.u0, t.u1, -t.half + 0.1, y);
  rail(P, t.u0, t.u1, t.half - 0.1, y);
  const p = c.pier;
  P.push({ k: 0, u0: p.u0, u1: p.u1, w0: p.w0, w1: p.w1, top: y });
  rail(P, p.u0, p.u1, p.w0 + 0.1, y);
  P.push({ k: 0, u0: p.u1 - 0.18, u1: p.u1 - 0.02, w0: p.w0, w1: p.w1 - 3, top: y + 1.1 });
  for (const b of c.bollards) P.push({ k: 1, u: b.u, w: b.w, r: D.bollardR, top: y + D.bollardTop });
  // cell fenders on the face: a rubber cell and a steel panel from near the water to under the deck
  for (const f of c.fenders) P.push({ k: 0, u0: f.u - 1.6, u1: f.u + 1.6, w0: p.w1, w1: p.w1 + D.fenderOut, top: y - 0.3 });
  const b = c.building;
  P.push({ k: 0, u0: b.u0, u1: b.u1, w0: b.w0, w1: b.w1, top: y + b.height });
  // the barrel vault (steps under the drawn arch, within rise / 8 of it) and the taller glazed atrium
  const W = b.w1 - b.w0;
  const wc = (b.w0 + b.w1) / 2;
  for (let k = 0; k < 8; k++) {
    const half = (W / 2) * Math.sqrt(1 - k / 8);
    P.push({ k: 0, u0: b.u0 + D.atriumLen, u1: b.u1, w0: wc - half, w1: wc + half, top: y + b.height + (D.vaultRise * (k + 1)) / 8 });
  }
  P.push({ k: 0, u0: b.u0, u1: b.u0 + D.atriumLen, w0: b.w0, w1: b.w1, top: y + D.atriumH });

  for (const br of c.bridges) {
    P.push({ k: 0, u0: br.u - D.bridgeW / 2, u1: br.u + D.bridgeW / 2, w0: br.w0, w1: br.w1, top: br.y + D.bridgeH });
    P.push({ k: 1, u: br.u, w: p.w1 - 4, r: 0.6, top: br.y });
  }
  for (const l of c.lamps) P.push({ k: 1, u: l.u, w: l.w, r: 0.45, top: l.y + 0.5 });
  // the apron ashore: raised deck, parked coaches and cars, shelters, lamp posts
  const a = c.apron;
  P.push({ k: 0, u0: a.u0, u1: a.u1, w0: a.w0, w1: a.w1, top: y });
  for (const v of c.vehicles) P.push({ k: 0, u0: v.u - v.len / 2, u1: v.u + v.len / 2, w0: v.w - v.wid / 2, w1: v.w + v.wid / 2, top: y + v.h });
  for (const s of c.shelters) P.push({ k: 0, u0: s.u0, u1: s.u1, w0: s.w0, w1: s.w1, top: y + 2.6 });
  return P;
}

export function navalPrims(n: NavalPierLayout): Prim[] {
  const P: Prim[] = [];
  const y = n.deckY;
  const t = n.trestle;
  P.push({ k: 0, u0: t.u0, u1: t.u1 + 1, w0: -t.half, w1: t.half, top: y });
  rail(P, t.u0, t.u1, -t.half + 0.1, y);
  rail(P, t.u0, t.u1, t.half - 0.1, y);
  const h = n.head;
  P.push({ k: 0, u0: h.u0, u1: h.u1, w0: h.w0, w1: h.w1, top: y });
  for (const b of n.bollards) P.push({ k: 1, u: b.u, w: b.w, r: D.bollardR, top: y + D.bollardTop });
  // floating camels between the ship and the face
  for (const c of n.camels) P.push({ k: 0, u0: h.u1, u1: h.u1 + D.camelOut, w0: c.w0, w1: c.w1, top: 1.1 });
  const b = n.building;
  P.push({ k: 0, u0: b.u0, u1: b.u1, w0: b.w0, w1: b.w1, top: y + b.height });
  for (const s of n.stores) P.push({ k: 0, u0: s.u - s.wid / 2, u1: s.u + s.wid / 2, w0: s.w - s.len / 2, w1: s.w + s.len / 2, top: y + s.h });
  // portal crane: four legs, the portal, the machinery house, the jib raised and parked along the head
  const cr = n.crane;
  const C = D.crane;
  for (const du of [-C.legSpan / 2, C.legSpan / 2]) for (const dw of [-C.legGauge / 2, C.legGauge / 2]) P.push({ k: 1, u: cr.u + du, w: cr.w + dw, r: 1.15, top: y + 11 });
  P.push({ k: 0, u0: cr.u - C.legSpan / 2 - 0.8, u1: cr.u + C.legSpan / 2 + 0.8, w0: cr.w - C.legGauge / 2 - 0.8, w1: cr.w + C.legGauge / 2 + 0.8, top: y + 12.2 });
  P.push({ k: 0, u0: cr.u - 4, u1: cr.u + 4, w0: cr.w - 4.5, w1: cr.w + 4.5, top: y + 18.2 });
  const jr = (40 * Math.PI) / 180;
  const jl = 30;
  P.push({ k: 3, au: cr.u, aw: cr.w - 3, bu: cr.u, bw: cr.w - 3 - jl * Math.cos(jr), y0: y + 16.5, y1: y + 16.5 + jl * Math.sin(jr), prof: [[1.0, 1.0]] });
  for (const l of n.lamps) P.push({ k: 1, u: l.u, w: l.w, r: 0.45, top: l.y + 0.5 });
  const a = n.apron;
  P.push({ k: 0, u0: a.u0, u1: a.u1, w0: a.w0, w1: a.w1, top: y });
  const g = n.gate;
  P.push({ k: 0, u0: g.u0, u1: g.u1, w0: g.w0, w1: g.w1, top: y + g.height });
  // the barrier arm and its post across the roadway
  P.push({ k: 1, u: g.u0 - 1, w: g.w0 - 0.6, r: 0.25, top: y + 1.2 });
  P.push({ k: 0, u0: g.u0 - 1.1, u1: g.u0 - 0.9, w0: g.w0 - 6.6, w1: g.w0 - 0.6, top: y + 1.11 });
  return P;
}

/** The landable decks (flat concrete): trestles, pier deck, T-head, aprons. */
function deckPrims(w: PortWorks): { cruise: Prim[]; naval: Prim[] } {
  const c = w.cruise;
  const n = w.naval;
  const box = (r: { u0: number; u1: number; w0: number; w1: number }, top: number): Prim => ({ k: 0, u0: r.u0, u1: r.u1, w0: r.w0, w1: r.w1, top });
  return {
    cruise: [box({ u0: c.trestle.u0, u1: c.trestle.u1, w0: -c.trestle.half, w1: c.trestle.half }, c.deckY), box(c.pier, c.deckY), box(c.apron, c.deckY)],
    naval: [box({ u0: n.trestle.u0, u1: n.trestle.u1, w0: -n.trestle.half, w1: n.trestle.half }, n.deckY), box(n.head, n.deckY), box(n.apron, n.deckY)],
  };
}

export interface PortObstacles {
  /** Obstacle top at a world point (m MSL), −Infinity where there is none. */
  top(x: number, z: number): number;
  /** Landable deck top (m MSL), −Infinity where there is none. */
  deckTop(x: number, z: number): number;
  readonly sets: readonly ObstacleSet[];
}

/** The two piers' obstacle sets and their decks. */
export function createPortObstacles(w: PortWorks): PortObstacles {
  const cs = buildSet(w.cruise.frame, cruisePrims(w.cruise));
  const ns = buildSet(w.naval.frame, navalPrims(w.naval));
  const dp = deckPrims(w);
  const decks = [buildSet(w.cruise.frame, dp.cruise), buildSet(w.naval.frame, dp.naval)];
  const sets = [cs, ns];
  return {
    top(x, z) {
      const a = obstacleSetTop(cs, x, z);
      const b = obstacleSetTop(ns, x, z);
      return a > b ? a : b;
    },
    deckTop(x, z) {
      const a = obstacleSetTop(decks[0], x, z);
      const b = obstacleSetTop(decks[1], x, z);
      return a > b ? a : b;
    },
    sets,
  };
}
