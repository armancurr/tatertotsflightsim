/// <reference lib="webworker" />
/**
 * Lays out the target range off the main thread (A* over thousands of cells, vegetation and farm
 * keep-outs): receives the site, answers with the RangePlan.
 */
import { createRangeGround } from './groundQuery';
import { planRange } from './plan';

self.onmessage = (e: MessageEvent<{ x: number; z: number; headingDeg: number }>) => {
  try {
    const site = e.data;
    const plan = planRange(createRangeGround(site), site);
    (self as unknown as Worker).postMessage({ ok: true, plan });
  } catch (err) {
    (self as unknown as Worker).postMessage({ ok: false, message: err instanceof Error ? err.message : String(err) });
  }
};
