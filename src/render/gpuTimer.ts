/**
 * GPU pass timing with EXT_disjoint_timer_query_webgl2 (when the browser
 * exposes it). `begin(label)` / `end()` bracket one pass (queries cannot
 * nest); results arrive a few frames later and are smoothed per label.
 * Without the extension every call is a no-op and `get` returns NaN.
 */

interface Pending {
  label: string;
  query: WebGLQuery;
}

export interface GpuTimer {
  readonly available: boolean;
  begin(label: string): void;
  end(): void;
  /** Collect finished queries (call once per frame). */
  poll(): void;
  /** Smoothed milliseconds for a label (NaN until measured). */
  get(label: string): number;
  /** All labels → smoothed ms (rounded to 0.01). */
  snapshot(): Record<string, number>;
  /** Forget the smoothed values (e.g. before a benchmark). */
  reset(): void;
  dispose(): void;
}

type TimerExt = { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number };

export function createGpuTimer(gl: WebGL2RenderingContext | null, smoothing = 0.1): GpuTimer {
  const ext = gl ? (gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null) : null;
  const free: WebGLQuery[] = [];
  const pending: Pending[] = [];
  const values = new Map<string, number>();
  let active: Pending | null = null;

  const available = !!(gl && ext);
  return {
    available,
    begin(label) {
      if (!gl || !ext || active) return;
      if (pending.length > 24) return; // results not coming back (context busy): don't pile up
      const query = free.pop() ?? gl.createQuery();
      if (!query) return;
      gl.beginQuery(ext.TIME_ELAPSED_EXT, query);
      active = { label, query };
    },
    end() {
      if (!gl || !ext || !active) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT);
      pending.push(active);
      active = null;
    },
    poll() {
      if (!gl || !ext) return;
      const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT) as boolean;
      while (pending.length > 0) {
        const p = pending[0];
        if (!gl.getQueryParameter(p.query, gl.QUERY_RESULT_AVAILABLE)) break;
        pending.shift();
        const ns = gl.getQueryParameter(p.query, gl.QUERY_RESULT) as number;
        free.push(p.query);
        if (disjoint) continue;
        const ms = ns / 1e6;
        const prev = values.get(p.label);
        values.set(p.label, prev === undefined ? ms : prev + (ms - prev) * smoothing);
      }
    },
    get(label) {
      return values.get(label) ?? NaN;
    },
    snapshot() {
      const o: Record<string, number> = {};
      for (const [k, v] of values) o[k] = Math.round(v * 100) / 100;
      return o;
    },
    reset() {
      values.clear();
    },
    dispose() {
      if (!gl) return;
      for (const q of free) gl.deleteQuery(q);
      for (const p of pending) gl.deleteQuery(p.query);
      free.length = 0;
      pending.length = 0;
    },
  };
}
