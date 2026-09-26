/**
 * Berths by size (src/world/port.ts): the registry, choosing a berth for a vessel (by fleet id, else
 * warship → naval, else by size), each ship berth's depth and clearance for the largest ship it takes
 * and for stand-ins of the cruise ship (260 m) and the battleship (270 m), the bow toward open water,
 * the V50's visitors' berth unchanged, and the open-sea start safe for a battleship.
 */
import { describe, it, expect } from 'vitest';
import { CONFIG, V50_AIRCRAFT, IOWA_WEAPONS } from '../../../src/config';
import { getHeightfield } from '../../../src/world/heightfield';
import { getLayout } from '../../../src/world/layout';
import {
  BERTH_IDS, BERTH_LIMITS, SHIP_UNDER_KEEL, berthFor, berthPose, checkHull, fitsBerth, hullFootprint, playerBerth, portBerths, portMarina, seaDepth, seaStart, vesselBerth, vesselSize,
  type BerthId, type VesselSize,
} from '../../../src/world/port';
import { portWorks, pierLocal } from '../../../src/world/harbour/layout';
import { createPortObstacles } from '../../../src/world/harbour/obstacles';
import { marinaObstacleTop } from '../../../src/world/traffic/harbourObstacles';
import { FLEET } from '../../../src/fleet';
import { CRUISE_STANDIN, IOWA_STANDIN, standIn } from '../../support/shipStandIn';

const hf = getHeightfield();
const water = { groundHeight: (x: number, z: number) => hf.height(x, z), waterLevel: (x: number, z: number) => hf.waterLevel(x, z) };
const layout = getLayout();
const works = portWorks(layout);
const port = createPortObstacles(works);
const DEG = Math.PI / 180;
const V50 = { id: 'v50', config: { ...CONFIG, aircraft: V50_AIRCRAFT } };

/** A box hull of the largest size a berth takes. */
const maxHull = (id: BerthId): VesselSize => {
  const l = BERTH_LIMITS[id];
  return { lengthM: l.length, beamM: l.beam, draftM: l.draft, bowZ: -l.length / 2, sternZ: l.length / 2, halfBeam: l.beam / 2, freeboardM: 5 };
};

describe('berths: the registry', () => {
  it('has the visitors\' pontoon, the cruise terminal and the naval pier, each with its limits and a face', () => {
    const b = portBerths(layout);
    expect(Object.keys(b).sort()).toEqual([...BERTH_IDS].sort());
    for (const id of BERTH_IDS) {
      expect(b[id].id).toBe(id);
      expect(b[id].maxLengthM).toBe(BERTH_LIMITS[id].length);
      expect(b[id].reserved).toHaveLength(4);
      const f = b[id].face;
      expect(Math.hypot(f.nx, f.nz)).toBeCloseTo(1, 6);
      // the face runs along the heading
      const h = f.headingDeg * DEG;
      const dx = f.bx - f.ax;
      const dz = f.bz - f.az;
      expect((dx * Math.sin(h) - dz * Math.cos(h)) / Math.hypot(dx, dz)).toBeCloseTo(1, 6);
      // the normal is perpendicular to it
      expect(Math.abs(dx * f.nx + dz * f.nz) / Math.hypot(dx, dz)).toBeLessThan(1e-9);
    }
    expect(b.cruise.name).toBe('Cruise terminal');
    expect(b.naval.name).toBe('Naval pier');
  });

  it('puts the cruise terminal east of the marina and the naval pier west of it, in their x ranges', () => {
    const w = works;
    const xs = (pts: { x: number }[]) => pts.map((p) => p.x);
    const c = w.cruise;
    const n = w.naval;
    const corners = (f: typeof c.frame, r: { u0: number; u1: number; w0: number; w1: number }) =>
      [[r.u0, r.w0], [r.u1, r.w0], [r.u1, r.w1], [r.u0, r.w1]].map(([u, ww]) => ({ x: f.ox + f.ux * u + f.wx * ww, z: f.oz + f.uz * u + f.wz * ww }));
    for (const x of xs([...corners(c.frame, c.pier), ...corners(c.frame, c.apron), ...corners(c.frame, { u0: c.trestle.u0, u1: c.trestle.u1, w0: -7, w1: 7 }), ...portBerths(layout).cruise.reserved])) {
      expect(x).toBeGreaterThanOrEqual(-4150);
      expect(x).toBeLessThanOrEqual(-3300);
    }
    for (const x of xs([...corners(n.frame, n.head), ...corners(n.frame, n.apron), ...portBerths(layout).naval.reserved])) {
      expect(x).toBeGreaterThanOrEqual(-6300);
      expect(x).toBeLessThanOrEqual(-5500);
    }
  });
});

describe('berths: choosing one for a vessel', () => {
  it('by fleet id when known', () => {
    const cfg = V50.config;
    expect(berthFor({ id: 'v50', config: cfg })).toBe('visitor');
    expect(berthFor({ id: 'seadoo', config: cfg })).toBe('visitor');
    expect(berthFor({ id: 'cruise', config: cfg })).toBe('cruise');
    expect(berthFor({ id: 'iowa', config: cfg })).toBe('naval');
  });

  it('else by size and draft: a jet ski and a yacht → visitor, a cruise ship → cruise, a warship or a deep hull → naval', () => {
    expect(berthFor({ id: 'yacht2', config: V50.config })).toBe('visitor');
    expect(berthFor(standIn('ski', 3.3, 1.2, 0.35, 0.5))).toBe('visitor');
    expect(berthFor({ ...CRUISE_STANDIN(), id: 'liner' })).toBe('cruise');
    expect(berthFor({ ...standIn('ferry', 120, 22, 5, 8), id: 'ferry' })).toBe('cruise');
    const bb = IOWA_STANDIN();
    // a deep hull that doesn't fit the cruise berth goes to the naval pier …
    expect(berthFor({ ...bb, id: 'bb2' })).toBe('naval');
    // … and so does any warship, even a small one
    const corvette = standIn('corvette', 90, 12, 3.5, 5);
    expect(berthFor({ id: 'corvette', config: { ...corvette.config, weapons: IOWA_WEAPONS } })).toBe('naval');
  });

  it('measures hulls from their station tables', () => {
    const v = vesselSize(V50.config)!;
    expect(v.lengthM).toBeCloseTo(14.2, 1);
    expect(v.beamM).toBeCloseTo(4.11, 2);
    expect(v.draftM).toBeGreaterThan(0.9);
    expect(v.draftM).toBeLessThan(1.3);
    const c = vesselSize(CRUISE_STANDIN().config)!;
    expect(c.lengthM).toBeCloseTo(260, 3);
    expect(c.beamM).toBeCloseTo(31.5, 3);
    expect(c.draftM).toBeCloseTo(7.8, 1);
    const i = vesselSize(IOWA_STANDIN().config)!;
    expect(i.draftM).toBeCloseTo(11, 1);
    expect(fitsBerth('cruise', c)).toBe(true);
    expect(fitsBerth('cruise', i)).toBe(false);
    expect(fitsBerth('naval', i)).toBe(true);
    expect(vesselSize({ ...CONFIG })).toBeNull(); // an aircraft
  });

  it('tolerates fleet ids that are not there yet (cruise / iowa built elsewhere)', () => {
    for (const d of FLEET.filter((x) => x.kind === 'vessel')) {
      const b = vesselBerth(d);
      expect(Number.isFinite(b.x) && Number.isFinite(b.z)).toBe(true);
    }
  });
});

describe('berths: the Princess V50 keeps its visitors\' berth', () => {
  it('vesselBerth(V50) is playerBerth() exactly', () => {
    const b = vesselBerth(V50);
    const p = playerBerth(layout);
    expect({ ...b, berth: undefined }).toEqual({ ...p, berth: undefined });
    expect(b.berth).toBe('visitor');
  });

  it('a jet ski lies alongside the visitors\' pontoon, hull clear of it', () => {
    const ski = standIn('seadoo', 3.3, 1.2, 0.35, 0.5);
    const b = vesselBerth(ski);
    expect(b.berth).toBe('visitor');
    const m = portMarina(layout);
    const c = checkHull(b, vesselSize(ski.config)!, water, (x, z) => marinaObstacleTop(m, x, z));
    expect(c.blocked).toBe(false);
    expect(c.minDepth).toBeGreaterThan(2);
  });
});

describe('berths: the ship berths are deep and clear', () => {
  for (const id of ['cruise', 'naval'] as const) {
    it(`${id}: the largest ship it takes has ≥ draft + ${SHIP_UNDER_KEEL} m under its whole footprint, clear of every structure`, () => {
      const hull = maxHull(id);
      const pose = berthPose(id, hull, layout);
      expect(pose.berth).toBe(id);
      const c = checkHull(pose, hull, water, (x, z) => Math.max(port.top(x, z), marinaObstacleTop(portMarina(layout), x, z)));
      expect(c.minDepth).toBeGreaterThanOrEqual(BERTH_LIMITS[id].draft + SHIP_UNDER_KEEL);
      expect(c.blocked).toBe(false);
    });
  }

  for (const [name, mk, id] of [['cruise ship (260 m)', CRUISE_STANDIN, 'cruise'], ['battleship (270 m)', IOWA_STANDIN, 'naval']] as const) {
    it(`the ${name} stand-in: at the ${id} berth, draft + 2 m of water, the hull a fender gap off the face`, () => {
      const v = mk();
      const size = vesselSize(v.config)!;
      const pose = vesselBerth(v);
      expect(pose.berth).toBe(id);
      const c = checkHull(pose, size, water, (x, z) => port.top(x, z));
      expect(c.minDepth).toBeGreaterThanOrEqual(size.draftM + SHIP_UNDER_KEEL);
      expect(c.blocked).toBe(false);
      // the hull's side lies `gap` off the face
      const f = portBerths(layout)[id].face;
      const off = (pose.x - f.ax) * f.nx + (pose.z - f.az) * f.nz;
      expect(off - size.halfBeam).toBeCloseTo(f.gap, 6);
      // and inside the berth's reserved water
      const res = portBerths(layout)[id].reserved;
      const inside = (p: { x: number; z: number }) => {
        let s = 0;
        for (let i = 0; i < 4; i++) {
          const a = res[i];
          const b = res[(i + 1) % 4];
          const cr = (b.x - a.x) * (p.z - a.z) - (b.z - a.z) * (p.x - a.x);
          s += Math.sign(cr);
        }
        return Math.abs(s) === 4;
      };
      for (const p of hullFootprint(pose, size)) expect(inside(p)).toBe(true);
    });
  }

  it('the bows point to open water: 1.5 km ahead of each berthed ship is deep and free of structures', () => {
    for (const [v, id] of [[CRUISE_STANDIN(), 'cruise'], [IOWA_STANDIN(), 'naval']] as const) {
      const size = vesselSize(v.config)!;
      const pose = vesselBerth(v);
      const h = pose.headingDeg * DEG;
      const fx = Math.sin(h);
      const fz = -Math.cos(h);
      for (let s = 0; s <= 1500; s += 10)
        for (const k of [-1, 0, 1]) {
          const along = -size.bowZ + s;
          const x = pose.x + fx * along - fz * k * size.halfBeam;
          const z = pose.z + fz * along + fx * k * size.halfBeam;
          expect(seaDepth(water, x, z), `${id} ${s} m ahead`).toBeGreaterThan(size.draftM + SHIP_UNDER_KEEL);
          expect(port.top(x, z), `${id} ${s} m ahead`).toBe(-Infinity);
          expect(marinaObstacleTop(portMarina(layout), x, z)).toBe(-Infinity);
        }
    }
    // the cruise ship heads out to sea (south-ish), the battleship west along the coast
    expect(Math.cos(portBerths(layout).cruise.face.headingDeg * DEG)).toBeLessThan(-0.95);
    expect(Math.sin(portBerths(layout).naval.face.headingDeg * DEG)).toBeLessThan(-0.95);
  });

  it('the cruise ship lies port side to and the battleship starboard side to', () => {
    expect(portBerths(layout).cruise.face.side).toBe('port');
    expect(portBerths(layout).naval.face.side).toBe('starboard');
    // check the side geometrically: the face is on the vessel's port (left) side for the cruise ship
    for (const id of ['cruise', 'naval'] as const) {
      const f = portBerths(layout)[id].face;
      const h = f.headingDeg * DEG;
      // starboard = (cos h, sin h); the face lies at −n from the vessel
      const toFace = -(Math.cos(h) * f.nx + Math.sin(h) * f.nz);
      expect(toFace > 0 ? 'starboard' : 'port').toBe(f.side);
    }
  });

  it('the berths are laid out where the heightfield says (the piers reach the depth, not beyond it by much)', () => {
    const c = works.cruise;
    const n = works.naval;
    // the cruise berth: an 11 m draft ship needs 11 m; the pier head is < 900 m out
    expect(c.pier.u1).toBeLessThan(900);
    expect(n.head.u1).toBeLessThan(1100);
    // the shoreline: the pier roots start on land
    const root = (f: typeof c.frame, u: number) => hf.height(f.ox + f.ux * u, f.oz + f.uz * u);
    expect(root(c.frame, c.trestle.u0)).toBeGreaterThan(1);
    expect(root(n.frame, n.trestle.u0)).toBeGreaterThan(1);
    // the berthed hull is on the pier's water side
    const bp = berthPose('cruise', maxHull('cruise'), layout);
    expect(pierLocal(c.frame, bp.x, bp.z).w).toBeGreaterThan(c.pier.w1);
  });
});

describe('the open-sea start is safe for a battleship', () => {
  it('a 290 m × 36 m hull with an 11.5 m draft has ≥ 2 m under it everywhere, 300 m of sea room round it', () => {
    const p = seaStart(layout);
    const hull = maxHull('naval');
    for (const hd of [0, 45, 90, 135]) {
      const c = checkHull({ ...p, headingDeg: p.headingDeg + hd }, hull, water, (x, z) => port.top(x, z));
      expect(c.minDepth).toBeGreaterThan(hull.draftM + SHIP_UNDER_KEEL);
      expect(c.blocked).toBe(false);
    }
    for (let a = 0; a < 360; a += 20) expect(seaDepth(water, p.x + 450 * Math.cos(a * DEG), p.z + 450 * Math.sin(a * DEG))).toBeGreaterThan(hull.draftM + SHIP_UNDER_KEEL);
  });
});
