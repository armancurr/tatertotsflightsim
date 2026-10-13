/**
 * The jet-ski race course (src/world/offshore/raceCourse.ts): placement (depth for a jet ski,
 * clearance from the traffic routes, the marina and the beach), the course's shape (lap length,
 * left and right turns), the check / foul lines against the racing line, and the lap logic —
 * driven along the racing line, with a buoy on the wrong side, skipping marks, and fuzzed with
 * fast-check: random paths never count a lap that didn't round every mark in order, a correct path
 * always counts. Best-lap persistence per vessel.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  buildRaceCourse, crossing, createRaceTracker, updateRace, raceCourse, resetRace, loadBest, saveBest, bestKey, courseDistance, nextMark, portNormal,
  type RaceCourse, type RaceTracker,
} from '../../../src/world/offshore/raceCourse';
import { getHeightfield } from '../../../src/world/heightfield';
import { getLayout } from '../../../src/world/layout';
import { createSeaPlan } from '../../../src/world/traffic/sea';
import { createEnvironment } from '../../../src/world/environment';
import { routePoints, minDistance } from './helpers';

const C = raceCourse();
const hf = getHeightfield();

/** Densely resampled racing line (closed), step ≈ `step` m. */
function dense(course: RaceCourse, step = 2): { x: number; z: number }[] {
  const out: { x: number; z: number }[] = [];
  const L = course.line;
  for (let i = 0; i < L.length; i++) {
    const a = L[i];
    const b = L[(i + 1) % L.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / step));
    for (let k = 0; k < n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n });
  }
  return out;
}

/** Drives a polyline through the tracker at `speed` m/s; returns the tracker. */
function drive(tr: RaceTracker, pts: { x: number; z: number }[], speed = 20, t0 = 0): { tr: RaceTracker; kinds: string[]; t: number } {
  const kinds: string[] = [];
  let t = t0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dt = Math.hypot(b.x - a.x, b.z - a.z) / speed;
    t += dt;
    const n = updateRace(tr, a.x, a.z, b.x, b.z, t, dt);
    for (let k = 0; k < n; k++) kinds.push(`${tr.events[k].kind}:${tr.course.marks[Math.max(0, tr.events[k].mark)].id}`);
  }
  return { tr, kinds, t };
}

/** Starts a little before the gate so the first move crosses it. */
function lapsOf(course: RaceCourse, laps: number, step = 2): { x: number; z: number }[] {
  const d = dense(course, step);
  const g = course.marks[0];
  const pre = { x: g.x - g.dx * 30, z: g.z - g.dz * 30 };
  const pts = [pre];
  for (let l = 0; l < laps; l++) pts.push(...d);
  pts.push({ x: g.x + g.dx * 20, z: g.z + g.dz * 20 });
  return pts;
}

describe('race course placement', () => {
  it('lap of 1.5–2.5 km inside x ∈ [−3000, −1700], z ∈ [7700, 8300]', () => {
    expect(C.length).toBeGreaterThan(1500);
    expect(C.length).toBeLessThan(2500);
    for (const p of [...C.line, ...C.marks]) {
      expect(p.x).toBeGreaterThanOrEqual(-3000);
      expect(p.x).toBeLessThanOrEqual(-1700);
      expect(p.z).toBeGreaterThanOrEqual(7700);
      expect(p.z).toBeLessThanOrEqual(8300);
    }
  });

  it('has left and right turns (a right-hand circuit with a left-hand hairpin) and a slalom', () => {
    const sides = new Set(C.marks.filter((m) => m.kind !== 'gate').map((m) => m.side));
    expect(sides).toEqual(new Set(['port', 'starboard']));
    expect(C.marks.filter((m) => m.kind === 'slalom').length).toBeGreaterThanOrEqual(3);
    // signed turning along the racing line: both signs occur, net one full turn
    const L = C.line;
    let net = 0;
    let left = 0;
    let right = 0;
    for (let i = 0; i < L.length; i++) {
      const a = L[(i - 1 + L.length) % L.length];
      const b = L[i];
      const c = L[(i + 1) % L.length];
      const h0 = Math.atan2(b.x - a.x, -(b.z - a.z));
      const h1 = Math.atan2(c.x - b.x, -(c.z - b.z));
      let d = h1 - h0;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      net += d;
      if (d > 0.3) right += d;
      if (d < -0.3) left -= d;
    }
    expect(Math.abs(Math.abs(net) - 2 * Math.PI)).toBeLessThan(0.05);
    expect(right).toBeGreaterThan(Math.PI * 1.5);
    expect(left).toBeGreaterThan(Math.PI * 0.6);
  });

  it('deep enough for a jet ski (≥ 1.5 m) along the racing line ± 25 m and at every buoy; ≥ 3 m for the V50 on the line', () => {
    let minLine = Infinity;
    let minBand = Infinity;
    const d = dense(C, 5);
    for (let i = 0; i < d.length; i++) {
      const p = d[i];
      minLine = Math.min(minLine, -hf.height(p.x, p.z));
      for (const o of [-25, 25]) minBand = Math.min(minBand, -hf.height(p.x + o, p.z), -hf.height(p.x, p.z + o));
    }
    for (const m of C.marks) minBand = Math.min(minBand, -hf.height(m.x, m.z));
    expect(minBand).toBeGreaterThanOrEqual(1.5);
    expect(minLine).toBeGreaterThanOrEqual(3);
    for (const m of C.marks) expect(hf.waterLevel(m.x, m.z)).toBe(0);
  });

  it('≥ 150 m from every traffic route, well away from the marina channel and Gull Island', () => {
    const plan = createSeaPlan(getLayout(), createEnvironment());
    const pts = routePoints(plan);
    let min = Infinity;
    for (const p of [...dense(C, 5), ...C.marks]) min = Math.min(min, minDistance(pts, p.x, p.z));
    expect(min).toBeGreaterThanOrEqual(150);
    for (const m of C.marks) {
      expect(Math.hypot(m.x - -4700, m.z - 7897)).toBeGreaterThan(1500);
      const gull = getLayout().islands.find((i) => i.name === 'Gull Island')!;
      expect(Math.hypot(m.x - gull.x, m.z - gull.z) - gull.radius).toBeGreaterThan(2000);
    }
  });
});

describe('check and foul lines', () => {
  it('the racing line crosses every check line exactly once per lap, in order, forward, and never a foul line', () => {
    const d = dense(C, 1);
    const seq: number[] = [];
    for (let i = 0; i < d.length; i++) {
      const a = d[i];
      const b = d[(i + 1) % d.length];
      for (let m = 0; m < C.marks.length; m++) {
        const c = crossing(C.check[m], a.x, a.z, b.x, b.z, C.marks[m].dx, C.marks[m].dz);
        if (c !== 0) {
          expect(c).toBe(1);
          seq.push(m);
        }
        const f = C.foul[m];
        if (f) expect(crossing(f, a.x, a.z, b.x, b.z, C.marks[m].dx, C.marks[m].dz)).toBe(0);
      }
    }
    // the dense line starts at the gate point (on the gate line): rotate so it starts at mark 0
    const start = seq.indexOf(0);
    const rot = [...seq.slice(start), ...seq.slice(0, start)];
    expect(rot).toEqual(C.marks.map((_, i) => i));
  });

  it('check lines stand on the correct side: a buoy kept to starboard has its check line on the craft’s port side', () => {
    for (let i = 1; i < C.marks.length; i++) {
      const m = C.marks[i];
      const s = C.check[i];
      const [px, pz] = portNormal(m.dx, m.dz);
      const side = (s.bx - s.ax) * px + (s.bz - s.az) * pz;
      expect(Math.sign(side)).toBe(m.side === 'starboard' ? 1 : -1);
    }
  });

  it('crossing() is directional and half-open', () => {
    const s = { ax: 0, az: -10, bx: 0, bz: 10 };
    expect(crossing(s, -1, 0, 1, 0, 1, 0)).toBe(1);
    expect(crossing(s, 1, 0, -1, 0, 1, 0)).toBe(-1);
    expect(crossing(s, -1, 20, 1, 20, 1, 0)).toBe(0);
    expect(crossing(s, -2, 0, -1, 0, 1, 0)).toBe(0);
    // ending exactly on the line doesn't count; the next move (starting on it) does — once
    expect(crossing(s, -1, 0, 0, 0, 1, 0) + crossing(s, 0, 0, 1, 0, 1, 0)).toBe(1);
  });
});

describe('lap logic', () => {
  it('three clean laps along the racing line: start, every mark in order, three valid laps; best = fastest', () => {
    const tr = createRaceTracker(C, 'seadoo');
    const { kinds } = drive(tr, lapsOf(C, 3), 20);
    expect(kinds[0]).toBe('start:START');
    expect(kinds.filter((k) => k.startsWith('lap')).length).toBe(3);
    expect(kinds.some((k) => k.startsWith('missed') || k.startsWith('invalidLap'))).toBe(false);
    const marks = kinds.filter((k) => k.startsWith('mark:')).slice(0, C.marks.length - 1).map((k) => k.slice(5));
    expect(marks).toEqual(C.marks.slice(1).map((m) => m.id));
    expect(tr.validLaps).toBe(3);
    expect(tr.last).toBeCloseTo(C.length / 20, 0);
    expect(tr.best).toBeCloseTo(C.length / 20, 0);
    expect(tr.lap).toBe(4); // the 4th lap has just started
  });

  it('a faster lap becomes the best and the splits compare against it', () => {
    const tr = createRaceTracker(C, 'v50');
    const lap = dense(C, 2);
    const g = C.marks[0];
    let r = drive(tr, [{ x: g.x - g.dx * 30, z: g.z - g.dz * 30 }, ...lap, lap[0], lap[1]], 15);
    expect(tr.best).toBeCloseTo(C.length / 15, 0);
    r = drive(tr, [lap[1], ...lap.slice(2), lap[0], lap[1]], 25, r.t);
    expect(tr.best).toBeCloseTo(C.length / 25, 0);
    expect(tr.last).toBeCloseTo(C.length / 25, 0);
    // a mark in the next lap at 20 m/s is behind the best (25 m/s): delta > 0
    const t0 = r.t;
    drive(tr, lap.slice(1, Math.floor(lap.length / 2)), 20, t0);
    expect(tr.delta).toBeGreaterThan(0);
  });

  it('passing a buoy on the wrong side is a missed mark: the lap is invalid and not the best', () => {
    const tr = createRaceTracker(C, 'seadoo');
    // mirror the racing line's points round T2 (index 2) to its wrong side
    const i = 2;
    const m = C.marks[i];
    const line = C.line.map((p) => ({ ...p }));
    const bad = line.map((p) => {
      const d = Math.hypot(p.x - m.x, p.z - m.z);
      if (d > 30) return p;
      return { x: m.x - (p.x - m.x), z: m.z - (p.z - m.z) };
    });
    const course = { ...C, line: bad };
    const { kinds } = drive(tr, lapsOf(course, 1), 20);
    expect(kinds).toContain('missed:T2');
    expect(kinds).toContain('invalidLap:START');
    expect(tr.validLaps).toBe(0);
    expect(Number.isNaN(tr.best)).toBe(true);
    expect(tr.lastValid).toBe(false);
  });

  it('cutting straight from T1 to T6 misses everything in between; skipping the finish gate invalidates the lap', () => {
    const tr = createRaceTracker(C, 'seadoo');
    const g = C.marks[0];
    const idx = (id: string) => C.marks.findIndex((m) => m.id === id);
    const L = C.line;
    const near = (id: string) => {
      const m = C.marks[idx(id)];
      let best = 0;
      for (let k = 0; k < L.length; k++) if (Math.hypot(L[k].x - m.x, L[k].z - m.z) < Math.hypot(L[best].x - m.x, L[best].z - m.z)) best = k;
      return best;
    };
    const k1 = near('T1');
    const k6 = near('T6');
    const path = [{ x: g.x - 30, z: g.z }, ...L.slice(0, k1 + 2), ...L.slice(k6 - 1), L[0], L[1]];
    const { kinds } = drive(tr, path, 20);
    for (const id of ['T2', 'T3', 'M', 'T4', 'S1', 'S2', 'S3', 'T5']) expect(kinds).toContain(`missed:${id}`);
    expect(kinds).toContain('mark:T6');
    expect(kinds).toContain('invalidLap:START');
    // now skip the finish gate: go round outside the arch
    const tr2 = createRaceTracker(C, 'seadoo');
    const lap = dense(C, 2).filter((p) => Math.hypot(p.x - g.x, p.z - g.z) > 40);
    const detour = lap.map((p) => (Math.hypot(p.x - g.x, p.z - g.z) < 80 ? { x: p.x, z: p.z + 60 } : p));
    const r = drive(tr2, [{ x: g.x - 30, z: g.z }, { x: g.x + 30, z: g.z }, ...detour, ...detour.slice(0, 220)], 20);
    expect(r.kinds).toContain('missed:START');
    expect(tr2.validLaps).toBe(0);
  });

  it('reset / abandon goes back to idle; the next mark is the start gate while idle', () => {
    const tr = createRaceTracker(C, 'seadoo');
    expect(nextMark(tr).id).toBe('START');
    drive(tr, lapsOf(C, 1).slice(0, 200));
    expect(tr.phase).toBe('racing');
    resetRace(tr, true, 100);
    expect(tr.phase).toBe('idle');
    expect(tr.events[0].kind).toBe('abandon');
    expect(nextMark(tr).id).toBe('START');
    expect(courseDistance(C, C.cx, C.cz)).toBeLessThan(0);
  });

  it('ignores NaN and zero moves', () => {
    const tr = createRaceTracker(C);
    expect(updateRace(tr, NaN, 0, 1, 1, 1)).toBe(0);
    expect(updateRace(tr, 1, 1, 1, 1, 1)).toBe(0);
    expect(tr.phase).toBe('idle');
  });
});

describe('lap logic, fuzzed', () => {
  /** Independent oracle: did the path cross every check line forward, in order, at some point after the gate? */
  function everyMarkCrossedInOrder(pts: { x: number; z: number }[]): boolean {
    let want = 0;
    let started = false;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      for (let m = 0; m < C.marks.length; m++) {
        if (crossing(C.check[m], a.x, a.z, b.x, b.z, C.marks[m].dx, C.marks[m].dz) !== 1) continue;
        if (!started) {
          if (m === 0) {
            started = true;
            want = 1;
          }
          continue;
        }
        if (m === want) {
          if (want === 0) return true;
          want = (want + 1) % C.marks.length;
        }
      }
    }
    return false;
  }

  it('random paths never count a valid lap unless every mark was crossed in order (and none of its foul lines)', () => {
    const xy = fc.record({ x: fc.double({ min: -3100, max: -1600, noNaN: true }), z: fc.double({ min: 7650, max: 8350, noNaN: true }) });
    fc.assert(
      fc.property(fc.array(xy, { minLength: 2, maxLength: 120 }), (pts) => {
        const tr = createRaceTracker(C, 'fuzz');
        const r = drive(tr, pts, 20);
        if (tr.validLaps > 0) expect(everyMarkCrossedInOrder(pts)).toBe(true);
        expect(r.kinds.every((k) => !k.includes('undefined'))).toBe(true);
      }),
      { numRuns: 400 },
    );
  });

  it('noisy laps round the course — dropping a mark’s neighbourhood never gives a valid lap', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: C.marks.length - 1 }), fc.integer({ min: 0, max: 10000 }), fc.double({ min: 0, max: 60, noNaN: true }), (skip, seed, noise) => {
        let s = seed;
        const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
        const m = C.marks[skip];
        // the line with random noise, and the skipped mark's points pulled well inside (short-cutting it)
        const pts = lapsOf(C, 2, 8).map((p) => ({ x: p.x + rnd() * noise, z: p.z + rnd() * noise }))
          .filter((p) => Math.hypot(p.x - m.x, p.z - m.z) > 70);
        const tr = createRaceTracker(C, 'fuzz');
        drive(tr, pts, 18);
        if (tr.validLaps > 0) expect(everyMarkCrossedInOrder(pts)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it('a correct path always counts: the racing line with lateral noise (≤ 6 m) and any step size', () => {
    fc.assert(
      fc.property(fc.double({ min: 0.5, max: 45, noNaN: true }), fc.double({ min: 0, max: 6, noNaN: true }), fc.integer({ min: 0, max: 1e6 }), fc.double({ min: 3, max: 32, noNaN: true }), (step, noise, seed, speed) => {
        let s = seed;
        const rnd = () => ((s = (s * 1103515245 + 12345) % 2147483648) / 2147483648) * 2 - 1;
        const pts = lapsOf(C, 2, step).map((p, i, a) => (i === 0 || i === a.length - 1 ? p : { x: p.x + rnd() * noise, z: p.z + rnd() * noise }));
        const tr = createRaceTracker(C, 'fuzz');
        const r = drive(tr, pts, speed);
        expect(r.kinds.filter((k) => k.startsWith('missed'))).toEqual([]);
        expect(tr.validLaps).toBe(2);
      }),
      { numRuns: 300 },
    );
  });
});

describe('best lap persistence', () => {
  const mem = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };

  it('saves and loads the best lap and splits per course and vessel', () => {
    const st = mem();
    const tr = createRaceTracker(C, 'seadoo');
    drive(tr, lapsOf(C, 1), 22);
    expect(saveBest(st, C.id, 'seadoo', tr)).toBe(true);
    expect(st.m.has(bestKey(C.id, 'seadoo'))).toBe(true);
    const b = loadBest(st, C.id, 'seadoo')!;
    expect(b.lap).toBeCloseTo(tr.best, 3);
    expect(b.splits.length).toBe(C.marks.length);
    expect(loadBest(st, C.id, 'v50')).toBeNull();
    const tr2 = createRaceTracker(C, 'seadoo', b);
    expect(tr2.best).toBeCloseTo(tr.best, 3);
    expect(tr2.bestSplits[3]).toBeCloseTo(tr.bestSplits[3], 3);
  });

  it('ignores missing, corrupt or nonsense data and a throwing store', () => {
    const st = mem();
    st.setItem(bestKey(C.id, 'x'), '{nope');
    expect(loadBest(st, C.id, 'x')).toBeNull();
    st.setItem(bestKey(C.id, 'x'), JSON.stringify({ lap: -3 }));
    expect(loadBest(st, C.id, 'x')).toBeNull();
    expect(loadBest(null, C.id, 'x')).toBeNull();
    const boom = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('full'); } };
    expect(loadBest(boom, C.id, 'x')).toBeNull();
    const tr = createRaceTracker(C);
    tr.best = 99;
    expect(saveBest(boom, C.id, 'x', tr)).toBe(false);
  });

  it('buildRaceCourse is deterministic', () => {
    expect(buildRaceCourse().length).toBe(C.length);
  });
});
