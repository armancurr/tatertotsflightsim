/**
 * The jet-ski race course and its lap / checkpoint logic (PURE).
 *
 * A closed course of inflatable marks like real personal-watercraft (PWC) closed-course racing:
 * a start/finish arch (a gate you drive through), tall turn buoys you round on a given side, and a
 * three-buoy slalom. A lap is ~2 km with left and right turns (a left-hand hairpin in the middle).
 *
 * Rounding a mark: every mark has a CHECK LINE — a segment from the buoy outward on the side the
 * craft must pass, across the direction of travel there — and a FOUL LINE on the wrong side. A mark
 * counts when the craft crosses its check line going the right way, in order. Crossing a mark's
 * foul line, or reaching a later mark's check line first, MISSES it (a penalty: the lap is invalid
 * and doesn't count toward the best). The start/finish gate is the check line between the arch's
 * legs. Nothing here allocates per update.
 *
 * Sides: 'starboard' = keep the buoy on the craft's right (you turn right round it), 'port' =
 * on its left. World frame: +X east, +Z south; heading east, the craft's left (port) is north.
 */
import { RACE_SITE } from './sites';

export type MarkKind = 'gate' | 'turn' | 'slalom';
export type MarkSide = 'port' | 'starboard';

export interface RaceMarkDef {
  id: string;
  kind: MarkKind;
  x: number;
  z: number;
  /** For buoys: the side of the craft it is kept on. Gates: ignored. */
  side: MarkSide;
  /** Direction of travel at the mark (unit, world x/z) — derived from the racing line. */
  dx: number;
  dz: number;
  /** Check-line length (from the buoy outward; gates: the half-width of the arch). */
  reach: number;
  /** Foul-line length (the wrong side), m. 0 = none. */
  foul: number;
}

export interface Segment {
  ax: number;
  az: number;
  bx: number;
  bz: number;
}

export interface RaceCourse {
  id: string;
  name: string;
  /** marks[0] is the start/finish gate; the lap runs marks[1] … marks[n−1] then back to marks[0]. */
  marks: RaceMarkDef[];
  /** The racing line (closed polyline through every mark on its correct side), for tests, the preview and QA. */
  line: { x: number; z: number }[];
  /** Check and foul lines per mark. */
  check: Segment[];
  foul: (Segment | null)[];
  /** Lap length along the racing line, m. */
  length: number;
  /** Centre and radius that contain the course (the HUD shows within `radius + showMargin`). */
  cx: number;
  cz: number;
  radius: number;
}

/** Arch span (m) of the start/finish gate. */
export const GATE_SPAN = 24;

interface MarkSpec {
  id: string;
  kind: MarkKind;
  x: number;
  z: number;
  side: MarkSide;
  reach: number;
  foul: number;
  /** How far the racing line passes from the buoy, m. */
  offset: number;
}

/**
 * The marks in course order (world). Clockwise seen from above (right-hand turns), with a
 * left-hand hairpin (M) pushed into the course and a slalom along the offshore leg.
 */
const MARKS: MarkSpec[] = [
  { id: 'START', kind: 'gate', x: -2360, z: 7850, side: 'starboard', reach: GATE_SPAN / 2, foul: 0, offset: 0 },
  { id: 'T1', kind: 'turn', x: -2030, z: 7870, side: 'starboard', reach: 150, foul: 100, offset: 16 },
  { id: 'T2', kind: 'turn', x: -2050, z: 8140, side: 'starboard', reach: 140, foul: 100, offset: 16 },
  { id: 'T3', kind: 'turn', x: -2230, z: 8110, side: 'starboard', reach: 60, foul: 60, offset: 16 },
  { id: 'M', kind: 'turn', x: -2310, z: 7995, side: 'port', reach: 70, foul: 95, offset: 22 },
  { id: 'T4', kind: 'turn', x: -2390, z: 8110, side: 'starboard', reach: 60, foul: 60, offset: 16 },
  { id: 'S1', kind: 'slalom', x: -2490, z: 8135, side: 'port', reach: 60, foul: 35, offset: 14 },
  { id: 'S2', kind: 'slalom', x: -2575, z: 8165, side: 'starboard', reach: 60, foul: 35, offset: 14 },
  { id: 'S3', kind: 'slalom', x: -2660, z: 8135, side: 'port', reach: 60, foul: 35, offset: 14 },
  { id: 'T5', kind: 'turn', x: -2770, z: 8150, side: 'starboard', reach: 140, foul: 100, offset: 16 },
  { id: 'T6', kind: 'turn', x: -2760, z: 7880, side: 'starboard', reach: 140, foul: 100, offset: 16 },
];

const norm = (x: number, z: number): [number, number] => {
  const l = Math.hypot(x, z) || 1;
  return [x / l, z / l];
};

/** The craft's left (port) normal for a travel direction (dx, dz). */
export const portNormal = (dx: number, dz: number): [number, number] => [dz, -dx];

/**
 * Builds a course: travel directions at every mark (the bisector of the legs in and out), the
 * racing line (each buoy passed `offset` m on its correct side, the turns rounded with extra
 * points), and the check and foul lines.
 */
export function buildRaceCourse(specs: MarkSpec[] = MARKS, id: string = RACE_SITE.id, name: string = RACE_SITE.name): RaceCourse {
  const n = specs.length;
  const marks: RaceMarkDef[] = [];
  for (let i = 0; i < n; i++) {
    const p = specs[(i - 1 + n) % n];
    const c = specs[i];
    const q = specs[(i + 1) % n];
    const [ax, az] = norm(c.x - p.x, c.z - p.z);
    const [bx, bz] = norm(q.x - c.x, q.z - c.z);
    let [dx, dz] = norm(ax + bx, az + bz);
    if (Math.hypot(ax + bx, az + bz) < 1e-6) [dx, dz] = portNormal(ax, az).map((v) => -v) as [number, number];
    marks.push({ id: c.id, kind: c.kind, x: c.x, z: c.z, side: c.side, dx, dz, reach: c.reach, foul: c.foul });
  }
  // racing line: each buoy passed on its correct side; the turn marks get a small arc of points
  const line: { x: number; z: number }[] = [];
  for (let i = 0; i < n; i++) {
    const m = marks[i];
    const s = specs[i];
    const [px, pz] = portNormal(m.dx, m.dz);
    if (m.kind === 'gate') {
      line.push({ x: m.x, z: m.z });
      continue;
    }
    // the craft passes on the side away from the buoy: buoy on starboard → craft to port of it
    const k = m.side === 'starboard' ? 1 : -1;
    if (m.kind === 'turn') {
      // three points round the buoy: before, at the apex, after
      const p = specs[(i - 1 + n) % n];
      const q = specs[(i + 1) % n];
      const [ix, iz] = norm(m.x - p.x, m.z - p.z);
      const [ox, oz] = norm(q.x - m.x, q.z - m.z);
      const [ipx, ipz] = portNormal(ix, iz);
      const [opx, opz] = portNormal(ox, oz);
      line.push({ x: m.x + k * ipx * s.offset - ix * s.offset * 0.9, z: m.z + k * ipz * s.offset - iz * s.offset * 0.9 });
      line.push({ x: m.x + k * px * s.offset * 1.05, z: m.z + k * pz * s.offset * 1.05 });
      line.push({ x: m.x + k * opx * s.offset + ox * s.offset * 0.9, z: m.z + k * opz * s.offset + oz * s.offset * 0.9 });
    } else {
      line.push({ x: m.x + k * px * s.offset, z: m.z + k * pz * s.offset });
    }
  }
  const check: Segment[] = [];
  const foul: (Segment | null)[] = [];
  for (const m of marks) {
    const [px, pz] = portNormal(m.dx, m.dz);
    if (m.kind === 'gate') {
      check.push({ ax: m.x + px * m.reach, az: m.z + pz * m.reach, bx: m.x - px * m.reach, bz: m.z - pz * m.reach });
      foul.push(null);
      continue;
    }
    const k = m.side === 'starboard' ? 1 : -1;
    check.push({ ax: m.x, az: m.z, bx: m.x + k * px * m.reach, bz: m.z + k * pz * m.reach });
    foul.push(m.foul > 0 ? { ax: m.x, az: m.z, bx: m.x - k * px * m.foul, bz: m.z - k * pz * m.foul } : null);
  }
  let length = 0;
  for (let i = 0; i < line.length; i++) {
    const a = line[i];
    const b = line[(i + 1) % line.length];
    length += Math.hypot(b.x - a.x, b.z - a.z);
  }
  let cx = 0;
  let cz = 0;
  for (const m of marks) {
    cx += m.x / n;
    cz += m.z / n;
  }
  let radius = 0;
  for (const m of marks) radius = Math.max(radius, Math.hypot(m.x - cx, m.z - cz));
  return { id, name, marks, line, check, foul, length, cx, cz, radius };
}

let cached: RaceCourse | null = null;
/** The world's race course (built once). */
export function raceCourse(): RaceCourse {
  if (!cached) cached = buildRaceCourse();
  return cached;
}

/** Which side of segment s's line (x, z) is on: < 0 one side, ≥ 0 the other (exact, so consistent between moves). */
const orient = (s: Segment, x: number, z: number): number => (s.bx - s.ax) * (z - s.az) - (s.bz - s.az) * (x - s.ax);

/**
 * Does the move (x0, z0) → (x1, z1) cross segment s, and in which direction? +1 when it crosses
 * moving along (dx, dz), −1 against it, 0 when it doesn't cross. A point exactly on the line
 * belongs to one side, so a path through it crosses once — never twice, never not at all.
 */
export function crossing(s: Segment, x0: number, z0: number, x1: number, z1: number, dx: number, dz: number): number {
  const a = orient(s, x0, z0);
  const b = orient(s, x1, z1);
  if (a < 0 === b < 0) return 0;
  const t = a / (a - b);
  const px = x0 + (x1 - x0) * t;
  const pz = z0 + (z1 - z0) * t;
  const sx = s.bx - s.ax;
  const sz = s.bz - s.az;
  const u = ((px - s.ax) * sx + (pz - s.az) * sz) / (sx * sx + sz * sz || 1);
  if (u < 0 || u > 1) return 0;
  return (x1 - x0) * dx + (z1 - z0) * dz >= 0 ? 1 : -1;
}

// ─── The tracker ─────────────────────────────────────────────────────────────

export type RaceEventKind = 'start' | 'mark' | 'missed' | 'lap' | 'invalidLap' | 'abandon';

export interface RaceEvent {
  kind: RaceEventKind;
  /** Mark index (mark / missed), else −1. */
  mark: number;
  /** Lap time (lap / invalidLap), split vs best (mark, when a best exists), else NaN. */
  value: number;
  time: number;
}

export interface RaceTracker {
  course: RaceCourse;
  /** 'idle' = before the start gate; 'racing' = a lap is running. */
  phase: 'idle' | 'racing';
  /** Index of the next mark to round (1 … n−1, then 0 = the finish gate). */
  next: number;
  /** Laps started this session (1 = first lap). */
  lap: number;
  lapStart: number;
  /** Marks missed on the current lap. */
  penalties: number;
  /** Seconds from the lap start to each mark rounded this lap (index = mark; NaN = not yet / missed). */
  splits: Float64Array;
  /** The latest split vs the best lap's split at the same mark (NaN = no best or no split yet). */
  delta: number;
  last: number;
  lastValid: boolean;
  best: number;
  bestSplits: Float64Array;
  /** The vessel being timed (the best is kept per vessel). */
  vesselId: string;
  /** Events of the latest update (a fixed ring; `eventCount` valid). */
  events: RaceEvent[];
  eventCount: number;
  /** Valid laps completed this session. */
  validLaps: number;
}

const MAX_EVENTS = 16;

export function createRaceTracker(course: RaceCourse = raceCourse(), vesselId = 'unknown', best: SavedBest | null = null): RaceTracker {
  const n = course.marks.length;
  const t: RaceTracker = {
    course,
    phase: 'idle',
    next: 0,
    lap: 0,
    lapStart: 0,
    penalties: 0,
    splits: new Float64Array(n).fill(NaN),
    delta: NaN,
    last: NaN,
    lastValid: false,
    best: NaN,
    bestSplits: new Float64Array(n).fill(NaN),
    vesselId,
    events: Array.from({ length: MAX_EVENTS }, () => ({ kind: 'mark' as RaceEventKind, mark: -1, value: NaN, time: 0 })),
    eventCount: 0,
    validLaps: 0,
  };
  if (best) applyBest(t, best);
  return t;
}

function emit(t: RaceTracker, kind: RaceEventKind, mark: number, value: number, time: number): void {
  if (t.eventCount >= MAX_EVENTS) return;
  const e = t.events[t.eventCount++];
  e.kind = kind;
  e.mark = mark;
  e.value = value;
  e.time = time;
}

/** Back to 'idle' (a reset, a teleport, another vessel, or the craft left the course area). */
export function resetRace(t: RaceTracker, abandoned = false, time = 0): void {
  if (abandoned && t.phase === 'racing') emit(t, 'abandon', -1, NaN, time);
  t.phase = 'idle';
  t.next = 0;
  t.penalties = 0;
  t.splits.fill(NaN);
  t.delta = NaN;
}

function startLap(t: RaceTracker, time: number): void {
  t.phase = 'racing';
  t.lap += 1;
  t.lapStart = time;
  t.penalties = 0;
  t.splits.fill(NaN);
  t.delta = NaN;
  t.next = t.course.marks.length > 1 ? 1 : 0;
}

function finishLap(t: RaceTracker, time: number): void {
  const lapTime = time - t.lapStart;
  const valid = t.penalties === 0;
  t.last = lapTime;
  t.lastValid = valid;
  t.splits[0] = lapTime;
  if (valid) {
    t.validLaps += 1;
    const b = t.best;
    if (!(b <= lapTime)) {
      t.best = lapTime;
      t.bestSplits.set(t.splits);
    }
    emit(t, 'lap', 0, lapTime, time);
  } else emit(t, 'invalidLap', 0, lapTime, time);
}

function roundMark(t: RaceTracker, i: number, time: number): void {
  const split = time - t.lapStart;
  t.splits[i] = split;
  const b = t.bestSplits[i];
  t.delta = Number.isFinite(b) ? split - b : NaN;
  emit(t, 'mark', i, t.delta, time);
}

/**
 * Advances the race with the craft's move from (x0, z0) to (x1, z1) that took `dt` s and ended at
 * `time` (s); a crossing is timed where it happened along the move. Call once per frame (any step
 * size — long jumps are handled mark by mark in order). Returns the number of events this update
 * produced (in `t.events`).
 */
export function updateRace(t: RaceTracker, x0: number, z0: number, x1: number, z1: number, time: number, dt = 0): number {
  t.eventCount = 0;
  const c = t.course;
  const n = c.marks.length;
  if (!(Number.isFinite(x0) && Number.isFinite(z0) && Number.isFinite(x1) && Number.isFinite(z1))) return 0;
  if (x0 === x1 && z0 === z1) return 0;
  // Resolve crossings in the order they happen along the move: repeat while something is crossed
  // after the point reached so far (a long step can pass several marks).
  let sx = x0;
  let sz = z0;
  // a straight move crosses a line at most once: the line just handled is skipped for the rest of it
  hit.skipKind = 0;
  hit.skipMark = -1;
  for (let guard = 0; guard < n * 3; guard++) {
    // the earliest crossing along the remaining move, among the relevant lines
    hit.t = Infinity;
    hit.kind = 0;
    hit.mark = -1;
    const m0 = c.marks[0];
    if (t.phase === 'idle') {
      consider(c.check[0], sx, sz, x1, z1, m0.dx, m0.dz, 1, 0);
    } else {
      // every check line counts (a later one means the ones before it were missed); the foul line of the next mark only
      for (let i = 0; i < n; i++) consider(c.check[i], sx, sz, x1, z1, c.marks[i].dx, c.marks[i].dz, 1, i);
      const f = c.foul[t.next];
      if (f) consider(f, sx, sz, x1, z1, c.marks[t.next].dx, c.marks[t.next].dz, 2, t.next);
    }
    const bestT = hit.t;
    const bestKind = hit.kind;
    const bestMark = hit.mark;
    hit.skipKind = bestKind;
    hit.skipMark = bestMark;
    if (bestMark < 0) break;
    // advance the start point just past the crossing
    const tt = Math.min(1, Math.max(0, bestT));
    // time of the crossing: the move's fraction covered so far (from the true start)
    const covered = Math.hypot(sx - x0, sz - z0) + Math.hypot(x1 - sx, z1 - sz) * tt;
    const total = Math.hypot(x1 - x0, z1 - z0);
    const at = time - dt * (1 - (total > 0 ? covered / total : 1));
    sx = sx + (x1 - sx) * tt;
    sz = sz + (z1 - sz) * tt;
    if (t.phase === 'idle') {
      startLap(t, at);
      emit(t, 'start', 0, NaN, at);
      continue;
    }
    if (bestKind === 2) {
      // passed the next mark on the wrong side
      t.penalties += 1;
      emit(t, 'missed', t.next, NaN, at);
      t.next = (t.next + 1) % n;
      continue;
    }
    const i = bestMark;
    if (i === 0 && t.next === 1) {
      // back over the start line before rounding anything (drifted back, went round for a run-up): a fresh start
      startLap(t, at);
      emit(t, 'start', 0, NaN, at);
      continue;
    }
    if (i === 0) {
      // the finish gate: anything not yet rounded is missed
      if (t.next !== 0) {
        for (let k = t.next; k < n; k++) {
          t.penalties += 1;
          emit(t, 'missed', k, NaN, at);
        }
      }
      finishLap(t, at);
      startLap(t, at);
      continue;
    }
    if (i === t.next) {
      roundMark(t, i, at);
      t.next = (t.next + 1) % n;
      continue;
    }
    // a check line out of order
    const ahead = (i - t.next + n) % n;
    if (t.next !== 0 && i > t.next) {
      // skipped marks next … i−1: missed; round i
      for (let k = t.next; k < i; k++) {
        t.penalties += 1;
        emit(t, 'missed', k, NaN, at);
      }
      roundMark(t, i, at);
      t.next = (i + 1) % n;
    } else if (t.next === 0 && ahead > 0 && !(Number.isFinite(t.splits[i]) && i >= n / 2)) {
      // (re-crossing a mark of the lap's second half, already rounded, is just wobbling round it)
      // skipped the finish gate and went round again: the lap ends there, invalid, and a new one is on
      t.penalties += 1;
      emit(t, 'missed', 0, NaN, at);
      finishLap(t, at);
      startLap(t, at);
      if (i === 1) {
        roundMark(t, 1, at);
        t.next = 2 % n;
      } else {
        for (let k = 1; k < i; k++) {
          t.penalties += 1;
          emit(t, 'missed', k, NaN, at);
        }
        roundMark(t, i, at);
        t.next = (i + 1) % n;
      }
    }
    // else: a mark already rounded this lap, crossed again — ignored
  }
  return t.eventCount;
}

/** Scratch for the earliest crossing of one update step (no allocation per update). */
const hit = { t: Infinity, kind: 0, mark: -1, skipKind: 0, skipMark: -1 };

function consider(s: Segment, sx: number, sz: number, x1: number, z1: number, dx: number, dz: number, kind: number, mark: number): void {
  if (kind === hit.skipKind && mark === hit.skipMark) return;
  if (crossing(s, sx, sz, x1, z1, dx, dz) !== 1) return;
  const tt = segParam(s, sx, sz, x1, z1);
  if (tt < hit.t) {
    hit.t = tt;
    hit.kind = kind;
    hit.mark = mark;
  }
}

/** Parameter (0 … 1) along the move where it crosses segment s (assumes it does). */
function segParam(s: Segment, x0: number, z0: number, x1: number, z1: number): number {
  const a = orient(s, x0, z0);
  const b = orient(s, x1, z1);
  return a === b ? 1 : a / (a - b);
}

// ─── Best lap persistence (localStorage, per course and vessel) ──────────────

export interface SavedBest {
  lap: number;
  splits: number[];
}

export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const bestKey = (courseId: string, vesselId: string): string => `tfs.race.best.${courseId}.${vesselId}`;

export function loadBest(store: KeyValueStore | null | undefined, courseId: string, vesselId: string): SavedBest | null {
  if (!store) return null;
  try {
    const raw = store.getItem(bestKey(courseId, vesselId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<SavedBest>;
    if (typeof v.lap !== 'number' || !Number.isFinite(v.lap) || v.lap <= 0) return null;
    const splits = Array.isArray(v.splits) ? v.splits.map((s) => (typeof s === 'number' && Number.isFinite(s) ? s : NaN)) : [];
    return { lap: v.lap, splits };
  } catch {
    return null;
  }
}

export function saveBest(store: KeyValueStore | null | undefined, courseId: string, vesselId: string, t: RaceTracker): boolean {
  if (!store || !Number.isFinite(t.best)) return false;
  try {
    store.setItem(bestKey(courseId, vesselId), JSON.stringify({ lap: t.best, splits: Array.from(t.bestSplits, (s) => (Number.isFinite(s) ? Math.round(s * 1000) / 1000 : null)) }));
    return true;
  } catch {
    return false;
  }
}

export function applyBest(t: RaceTracker, b: SavedBest): void {
  t.best = b.lap;
  t.bestSplits.fill(NaN);
  for (let i = 0; i < Math.min(b.splits.length, t.bestSplits.length); i++) t.bestSplits[i] = b.splits[i] ?? NaN;
}

/** Distance from (x, z) to the course centre minus its radius (≤ 0 inside the course circle). */
export const courseDistance = (c: RaceCourse, x: number, z: number): number => Math.hypot(x - c.cx, z - c.cz) - c.radius;

/** The next mark to head for (the start gate while idle). */
export const nextMark = (t: RaceTracker): RaceMarkDef => t.course.marks[t.phase === 'idle' ? 0 : t.next];
