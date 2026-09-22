/**
 * Frame-rate meter (pure). Fixed memory: a ring buffer for the last second plus a frame-time
 * histogram for the session-long 1 % low. Feed it every rendered frame:
 *   recordFrame(meter, frameDtSeconds, performance.now() / 1000)
 */

const RING = 1024;
/** Histogram: 0.5 ms buckets up to 1 s, last bucket catches everything longer. */
const BUCKET_S = 0.0005;
const BUCKETS = 2001;
/** Frames longer than this count as long frames (hitches). */
const LONG_FRAME_S = 0.05;

export interface FpsMeter {
  /** Ring buffer of the most recent frames: timestamps and durations (seconds). */
  times: Float64Array;
  dts: Float64Array;
  head: number;
  count: number;
  /** Session totals. */
  frames: number;
  totalTime: number;
  longFrames: number;
  /** Consecutive 1-s windows: start time, frames so far, worst completed window's fps. */
  windowStart: number | null;
  windowFrames: number;
  worstWindowFps: number | null;
  /** Frame-time histogram: count and summed duration per bucket. */
  histCount: Uint32Array;
  histSum: Float64Array;
  lastTime: number;
}

export function createFpsMeter(): FpsMeter {
  return {
    times: new Float64Array(RING),
    dts: new Float64Array(RING),
    head: 0,
    count: 0,
    frames: 0,
    totalTime: 0,
    longFrames: 0,
    windowStart: null,
    windowFrames: 0,
    worstWindowFps: null,
    histCount: new Uint32Array(BUCKETS),
    histSum: new Float64Array(BUCKETS),
    lastTime: 0,
  };
}

export function recordFrame(m: FpsMeter, dtSeconds: number, nowSeconds: number): void {
  if (!(dtSeconds > 0) || !Number.isFinite(dtSeconds) || !Number.isFinite(nowSeconds)) return;
  m.times[m.head] = nowSeconds;
  m.dts[m.head] = dtSeconds;
  m.head = (m.head + 1) % RING;
  if (m.count < RING) m.count++;
  m.lastTime = nowSeconds;

  m.frames++;
  m.totalTime += dtSeconds;
  if (dtSeconds > LONG_FRAME_S) m.longFrames++;

  const b = Math.min(BUCKETS - 1, Math.floor(dtSeconds / BUCKET_S));
  m.histCount[b]++;
  m.histSum[b] += dtSeconds;

  if (m.windowStart === null) m.windowStart = nowSeconds - dtSeconds;
  m.windowFrames++;
  const span = nowSeconds - m.windowStart;
  if (span >= 1 - 1e-9) {
    const fps = m.windowFrames / span;
    m.worstWindowFps = m.worstWindowFps === null ? fps : Math.min(m.worstWindowFps, fps);
    m.windowStart = nowSeconds;
    m.windowFrames = 0;
  }
}

export interface FpsStats {
  /** Frames per second over the last ~1 s. */
  fps: number;
  /** Session average. */
  avg: number;
  /** Worst completed 1-s window (falls back to `fps` before the first second completes). */
  min: number;
  /** Average fps of the slowest 1 % of frames this session. */
  onePercentLow: number;
  /** Frames longer than 50 ms this session. */
  longFrames: number;
  frames: number;
}

export function fpsStats(m: FpsMeter): FpsStats {
  // Last second from the ring buffer.
  let n = 0;
  let sum = 0;
  const cutoff = m.lastTime - 1 + 1e-9;
  for (let i = 0; i < m.count; i++) {
    const idx = (m.head - 1 - i + RING) % RING;
    if (m.times[idx] <= cutoff) break;
    n++;
    sum += m.dts[idx];
  }
  const fps = sum > 0 ? n / sum : 0;
  const avg = m.totalTime > 0 ? m.frames / m.totalTime : 0;

  // 1 % low from the histogram: mean duration of the slowest ceil(1 %) frames.
  let onePercentLow = 0;
  if (m.frames > 0) {
    const k = Math.max(1, Math.ceil(m.frames * 0.01));
    let need = k;
    let acc = 0;
    for (let b = BUCKETS - 1; b >= 0 && need > 0; b--) {
      const c = m.histCount[b];
      if (c === 0) continue;
      const take = Math.min(c, need);
      acc += take === c ? m.histSum[b] : (m.histSum[b] / c) * take;
      need -= take;
    }
    onePercentLow = acc > 0 ? k / acc : 0;
  }

  const min = m.worstWindowFps ?? fps;
  return { fps, avg, min, onePercentLow, longFrames: m.longFrames, frames: m.frames };
}
