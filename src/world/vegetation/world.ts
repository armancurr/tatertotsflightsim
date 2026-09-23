/**
 * The real world as vegetation placement sees it: one call per candidate gives
 * the landcover tree density, ground height, distance to water and landcover
 * weights, from the same pure heightfield + landcover the terrain and physics
 * use (`treeDensityFrom` is the batch form of `treeDensity`). The terrain
 * normal comes from placement's per-cell height grid, so each candidate costs
 * one terrain sample instead of five. PURE — runs in the vegetation workers
 * and on the main thread (physics obstacles) with identical results.
 */
import { getHeightfield, newTerrainSample, type Heightfield } from '../heightfield';
import { getLandcover, newLandcover, type Landcover } from '../landcover';
import { runwayFrames, toRunwayCoords, type RunwayFrame } from '../runway';
import { newSiteSample, type SiteSample, type VegWorld } from './placement';

/**
 * Landcover paints field woodlots right up to the airfield while `treeDensity`
 * clears everything within the airport radius. Near the airport we plant those
 * woodlots too — except on the airfield itself and in the approach/departure
 * corridors off both runway ends, which stay clear.
 */
export function airportWoodlotDensity(forest: number, x: number, z: number, rw: RunwayFrame | readonly RunwayFrame[] = runwayFrames()): number {
  const list = Array.isArray(rw) ? rw : [rw as RunwayFrame];
  for (let i = 0; i < list.length; i++) {
    const q = toRunwayCoords(x, z, list[i]);
    const past = q.along < 0 ? -q.along : q.along > list[i].length ? q.along - list[i].length : 0;
    const acr = Math.abs(q.across);
    if (acr < 480 && past < 500) return 0; // the airfield
    if (past > 0 && past < 4200 && acr < 330 + 0.14 * past) return 0; // approach / departure corridors
  }
  return forest * 0.9;
}

export function createRealVegWorld(hf: Heightfield = getHeightfield(), lc: Landcover = getLandcover()): VegWorld {
  const ts = newTerrainSample();
  const rw = runwayFrames();
  const nearAirport = hf.layout.airport.flatRadius + 900;
  const nrm = { x: 0, y: 1, z: 0 };
  const probe = newSiteSample();
  const w = newLandcover();
  const site = (x: number, z: number, ny: number, nz: number, out: SiteSample): SiteSample => {
    hf.sample(x, z, ts);
    out.height = ts.h;
    lc.fromSample(ts, ny, x, z, w, nz);
    out.field = w.field;
    out.urban = w.urban;
    out.grass = w.grass;
    out.forest = w.forest;
    out.road = ts.roadD - ts.roadHalfWidth;
    out.airport = ts.airportD;
    const river = ts.riverD - ts.riverHalfWidth;
    const lake = ts.lakeIndex >= 0 ? ts.lakeSd : Infinity;
    let water = river < lake ? river : lake;
    if (ts.coast < water) water = ts.coast;
    out.water = water;
    let d = lc.isPaved(x, z) ? 0 : lc.treeDensityFrom(ts, w, x, z);
    if (d === 0 && w.forest > 0.05 && ts.airportD < nearAirport && w.water === 0 && ts.roadD > ts.roadHalfWidth + 8 && !lc.isPaved(x, z)) {
      d = airportWoodlotDensity(w.forest, x, z, rw);
    }
    out.density = d;
    return out;
  };
  return {
    heightAt: (x, z) => hf.height(x, z),
    densityAt: (x, z) => {
      hf.normalInto(x, z, nrm);
      return site(x, z, nrm.y, nrm.z, probe).density;
    },
    site,
    paved: (x, z) => lc.isPaved(x, z),
  };
}
