/**
 * The berthed-ships system (src/game/systems/berthedShips.ts + src/world/harbour/berthedShips.ts),
 * driven in node with a fake context: it tolerates the cruise ship / battleship fleet ids being absent
 * (they are built elsewhere), creates a ship's model lazily near the camera and an impostor far away,
 * hides the ship (and its obstacle) while the player drives it, rasterises the drawn superstructure into
 * the obstacle, and survives a model that fails to build.
 */
import { describe, it, expect, vi } from 'vitest';
import * as THREE from 'three';
import { createBerthedShipsSystem, MODEL_RANGE, IMPOSTOR_RANGE, rasterizeModel } from '../../src/game/systems/berthedShips';
import { berthedObstacles, berthedShipSpecs, shipToWorld, deckAt, BERTHED_SHIP_IDS } from '../../src/world/harbour/berthedShips';
import { createEnvironment } from '../../src/world/environment';
import { FLEET, type AircraftModelHandle } from '../../src/fleet';
import { drain } from '../../src/world/traffic/jobs';
import type { SystemContext, SystemFrame } from '../../src/game/systems/types';
import { CRUISE_STANDIN, IOWA_STANDIN, type StandIn } from '../support/shipStandIn';

/** A model: a hull-sized box to the deck and a 20 m tower amidships. */
function boxModel(s: StandIn, created: { n: number }): AircraftModelHandle {
  created.n++;
  const root = new THREE.Group();
  const st = s.config.aircraft.watercraft!.hull.stations;
  const L = st[st.length - 1].z - st[0].z;
  const deck = st[3].deckY;
  const tower = new THREE.Mesh(new THREE.BoxGeometry(8, 20, 10), new THREE.MeshStandardMaterial());
  tower.position.set(0, deck + 10, 0);
  const hull = new THREE.Mesh(new THREE.BoxGeometry(st[3].deckHalf * 2 - 2, deck + 5, L * 0.8), new THREE.MeshStandardMaterial());
  hull.position.set(0, (deck - 5) / 2, 0);
  root.add(hull, tower);
  return { root, setVisualState: () => {}, dispose: () => root.clear() };
}

function fakeCtx(playerId = 'c172rg') {
  const scene = new THREE.Scene();
  const env = createEnvironment();
  const ctx = {
    scene,
    env,
    renderer: { domElement: { height: 900 } },
    actions: { currentAircraft: () => ({ id: playerId }) },
    atmosphere: { sunDirection: new THREE.Vector3(0.3, 0.8, 0.2).normalize(), state: null },
  } as unknown as SystemContext;
  return { ctx, scene, env };
}

const camAt = (x: number, z: number, y = 50) => {
  const c = new THREE.PerspectiveCamera();
  c.position.set(x, y, z);
  c.updateMatrixWorld();
  return c;
};
const frameAt = (camera: THREE.PerspectiveCamera, time = 0): SystemFrame => ({ camera, dt: 1 / 60, time, waveTime: time } as unknown as SystemFrame);

describe('berthed ships: fleet ids absent', () => {
  it('the real fleet has no cruise ship or battleship yet: nothing is berthed, nothing throws', () => {
    const missing = BERTHED_SHIP_IDS.filter((id) => !FLEET.some((d) => d.id === id));
    const { ctx, scene, env } = fakeCtx();
    const sys = createBerthedShipsSystem(ctx);
    for (let i = 0; i < 3; i++) sys.update!(frameAt(camAt(-5700, 8800), i));
    const st = sys.stats!() as { ships: unknown[] };
    expect(st.ships.length).toBe(BERTHED_SHIP_IDS.length - missing.length);
    if (missing.length === BERTHED_SHIP_IDS.length) {
      expect(env.obstacleTop(-5740, 8770)).toBe(-Infinity);
      expect(berthedShipSpecs(FLEET)).toEqual([]);
    }
    sys.dispose!();
    expect(scene.children.length).toBe(0);
  });

  it('an entry that is not a vessel is skipped', () => {
    expect(berthedShipSpecs([{ id: 'cruise', config: FLEET[0].config }])).toEqual([]);
  });
});

describe('berthed ships: with stand-ins', () => {
  const cruise = CRUISE_STANDIN();
  const iowa = IOWA_STANDIN();

  it('lies at each ship\'s own berth, afloat at its waterline, obstacle and deck from the stations', () => {
    const specs = berthedShipSpecs([cruise, iowa]);
    expect(specs.map((s) => [s.id, s.berth])).toEqual([['cruise', 'cruise'], ['iowa', 'naval']]);
    const ob = berthedObstacles(specs, () => true);
    for (const s of specs) {
      const mid = deckAt(s, 0);
      expect(ob.top(s.pose.x, s.pose.z)).toBeCloseTo(mid.y, 6);
      expect(ob.deckTop(s.pose.x, s.pose.z)).toBeCloseTo(mid.y, 6);
      // just outside the hull: nothing
      const out = shipToWorld(s, mid.half + 0.5, 0, 0);
      expect(ob.top(out.x, out.z)).toBe(-Infinity);
      // beyond the bow and the stern: nothing
      const bow = shipToWorld(s, 0, 0, s.size.bowZ - 1);
      expect(ob.top(bow.x, bow.z)).toBe(-Infinity);
    }
    // the naval pier's brow joins the battleship to the T-head
    const bb = specs[1];
    expect(bb.brow).not.toBeNull();
    const b = bb.brow!;
    expect(ob.top((b.ax + b.bx) / 2, (b.az + b.bz) / 2)).toBeGreaterThan(Math.min(b.ay, b.by));
    expect(Math.hypot(b.bx - b.ax, b.bz - b.az)).toBeLessThan(15);
    // inactive (the player drives it): gone
    const off = berthedObstacles(specs, (id) => id !== 'iowa');
    expect(off.top(bb.pose.x, bb.pose.z)).toBe(-Infinity);
    expect(off.top(specs[0].pose.x, specs[0].pose.z)).toBeGreaterThan(0);
  });

  it('creates the model lazily near the camera, an impostor far away, nothing beyond', () => {
    const created = { n: 0 };
    const fleet = [cruise, iowa].map((s) => ({ ...s, createModel: () => boxModel(s, created) }));
    const { ctx, env } = fakeCtx();
    const sys = createBerthedShipsSystem(ctx, fleet);
    const specs = berthedShipSpecs(fleet);
    const bb = specs[1];
    // far away: impostors only, no models built
    sys.update!(frameAt(camAt(bb.pose.x + IMPOSTOR_RANGE * 0.8, bb.pose.z)));
    type St = { ships: { id: string; model: boolean; modelShown: boolean; impostor: boolean; active: boolean; raster: boolean }[] };
    let st = sys.stats!() as St;
    expect(created.n).toBe(0);
    expect(st.ships.find((s) => s.id === 'iowa')!.impostor).toBe(true);
    sys.update!(frameAt(camAt(bb.pose.x + IMPOSTOR_RANGE * 1.2, bb.pose.z)));
    st = sys.stats!() as St;
    expect(st.ships.find((s) => s.id === 'iowa')!.impostor).toBe(false);
    // near: the battleship's model is built (only it — the cruise ship is > MODEL_RANGE away? no: 2.3 km)
    sys.update!(frameAt(camAt(bb.pose.x + 500, bb.pose.z + 300)));
    st = sys.stats!() as St;
    const iw = st.ships.find((s) => s.id === 'iowa')!;
    expect(iw.model && iw.modelShown && !iw.impostor).toBe(true);
    expect(created.n).toBeGreaterThanOrEqual(1);
    // the drawn superstructure is rasterised into the obstacle over a few frames
    for (let i = 0; i < 50 && !(sys.stats!() as St).ships.find((s) => s.id === 'iowa')!.raster; i++) sys.update!(frameAt(camAt(bb.pose.x + 500, bb.pose.z + 300), i / 60));
    const deck = deckAt(bb, 0).y;
    expect(env.obstacleTop(bb.pose.x, bb.pose.z)).toBeGreaterThan(deck + 15);
    // the tower is not a landable deck; the fantail still is
    expect(env.deckTop(bb.pose.x, bb.pose.z)).toBe(-Infinity);
    const aft = shipToWorld(bb, 0, 0, bb.size.sternZ - 20);
    expect(env.deckTop(aft.x, aft.z)).toBeGreaterThan(bb.y);
    // the model rides at the berth
    const root = (ctx.scene.getObjectByName('berthedShips.iowa') as THREE.Object3D);
    expect(Math.hypot(root.position.x - bb.pose.x, root.position.z - bb.pose.z)).toBeLessThan(0.01);
    // the player picks the battleship: it disappears and stops being an obstacle
    sys.onAircraftChange!({ id: 'iowa' } as never, {} as never);
    sys.update!(frameAt(camAt(bb.pose.x + 500, bb.pose.z + 300)));
    st = sys.stats!() as St;
    expect(st.ships.find((s) => s.id === 'iowa')!.active).toBe(false);
    expect(root.visible).toBe(false);
    expect(env.obstacleTop(bb.pose.x, bb.pose.z)).toBe(-Infinity);
    sys.dispose!();
  });

  it('a model that fails to build falls back to the impostor', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fleet = [{ ...iowa, createModel: (): AircraftModelHandle => { throw new Error('no model'); } }];
    const { ctx } = fakeCtx();
    const sys = createBerthedShipsSystem(ctx, fleet);
    const bb = berthedShipSpecs(fleet)[0];
    expect(() => sys.update!(frameAt(camAt(bb.pose.x + 300, bb.pose.z)))).not.toThrow();
    const st = sys.stats!() as { ships: { model: boolean; impostor: boolean }[] };
    expect(st.ships[0].model).toBe(false);
    expect(st.ships[0].impostor).toBe(true);
    warn.mockRestore();
    sys.dispose!();
  });

  it('rasterises a model\'s triangles into tops at the berth (walls and roofs)', () => {
    const created = { n: 0 };
    const m = boxModel(iowa, created);
    const s = berthedShipSpecs([iowa])[0];
    const g = drain(rasterizeModel(m.root, s));
    const at = (bx: number, bz: number) => g.data[Math.floor((bz - g.z0) / g.cell) * g.nx + Math.floor((bx - g.x0) / g.cell)];
    const deck = iowa.config.aircraft.watercraft!.hull.stations[3].deckY;
    expect(at(0, 0)).toBeCloseTo(s.y + deck + 20, 0);
    expect(at(0, 40)).toBeCloseTo(s.y + deck, 0);
    expect(at(s.size.halfBeam + 8, 0)).toBe(-Infinity);
    expect(MODEL_RANGE).toBeLessThan(IMPOSTOR_RANGE);
  });
});
