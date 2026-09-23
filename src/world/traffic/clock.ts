/**
 * The traffic clock (PURE): seconds of traffic time. Every schedule (vessel
 * routes, the circuit, crossing GA, airliners) is a function of it. It runs
 * with the frame time, stops while the sim is paused, and clamps long frames
 * (a background tab, a debugger stop) so traffic never leaps ahead. URL
 * `?tt=<s>` sets its start (for QA photos of a particular moment).
 */

export interface TrafficClock {
  /** Traffic time, s. */
  readonly t: number;
  /** Advances by the frame time unless paused; returns the step taken (0 while paused). */
  advance(dt: number, paused: boolean): number;
  /** Jumps to time t (ignored if not finite). */
  set(t: number): void;
}

export function createTrafficClock(start: number, maxStep = 1): TrafficClock {
  let t = Number.isFinite(start) ? start : 0;
  return {
    get t() {
      return t;
    },
    advance(dt, paused) {
      if (paused || !(dt > 0) || !Number.isFinite(dt)) return 0;
      const step = Math.min(dt, maxStep);
      t += step;
      return step;
    },
    set(v) {
      if (Number.isFinite(v)) t = v;
    },
  };
}

/** `?tt=<s>` from a URL query string (null if absent or invalid). */
export function parseTrafficTime(search: string | null | undefined): number | null {
  if (!search) return null;
  const raw = new URLSearchParams(search).get('tt');
  if (raw === null || raw.trim() === '') return null;
  const v = Number(raw);
  return Number.isFinite(v) && v >= 0 ? v : null;
}
