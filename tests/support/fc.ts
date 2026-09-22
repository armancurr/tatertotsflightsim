/**
 * fast-check run parameters shared by every property test.
 *
 * Environment knobs (see docs/TESTING.md):
 *   FC_RUNS_SCALE=10   run every property 10× more often (nightly soak); 0.2 for a quick pass
 *   FC_SEED=<n>        replay with this seed (copy it from a failure report)
 *   FC_PATH=<p>        …and jump straight to the shrunk counterexample (copy "path" too)
 *   FC_VERBOSE=1       print every shrink step on failure
 *
 * Replaying a single failure: FC_SEED=… FC_PATH=… npx vitest run tests/fuzz/x.test.ts -t "<test name>"
 */
import type { Parameters } from 'fast-check';

const scale = (() => {
  const v = Number(process.env.FC_RUNS_SCALE ?? '1');
  return Number.isFinite(v) && v > 0 ? v : 1;
})();

export function fcParams<T = unknown>(numRuns: number, extra: Parameters<T> = {}): Parameters<T> {
  const p: Parameters<T> = { numRuns: Math.max(1, Math.round(numRuns * scale)), ...extra };
  if (process.env.FC_SEED !== undefined && process.env.FC_SEED !== '') p.seed = Number(process.env.FC_SEED);
  if (process.env.FC_PATH) {
    p.path = process.env.FC_PATH;
    p.endOnFailure = true;
  }
  if (process.env.FC_VERBOSE) p.verbose = 2;
  return p;
}
