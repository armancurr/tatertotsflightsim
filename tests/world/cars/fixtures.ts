/** Shared fixtures for the cars tests: the real road network's lane data (stand-in terrain), built once. */
import { RoadBuilder, type LaneData } from '../../../src/world/roads/builder';
import { LaneGraph } from '../../../src/world/cars/lanes';
import { LAYOUT, HEIGHT } from '../towns/fixtures';

let data: LaneData | null = null;
let graph: LaneGraph | null = null;

export function laneData(): LaneData {
  return (data ??= new RoadBuilder(LAYOUT, HEIGHT).lanes());
}

export function laneGraph(): LaneGraph {
  return (graph ??= new LaneGraph(laneData()));
}

export { LAYOUT, HEIGHT };
