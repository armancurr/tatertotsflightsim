/**
 * Airfield lighting as data + the pure logic that animates it. PURE.
 *
 * - Runway edge lights (HIRL): white, the last 2000 ft (or half the runway)
 *   ahead of the pilot yellow — bidirectional, so each light has a `front`
 *   colour (seen by a pilot rolling toward +a, i.e. on runway 36) and a `back`.
 * - Threshold/end lights: green toward the approach, red toward the runway.
 * - Taxiway edge lights: blue, omnidirectional.
 * - MALSR approach lights for 36: 7 steady bars every 200 ft to 1400 ft, a
 *   crossbar at 1000 ft, and 5 sequenced flashers (the "rabbit") beyond.
 * - PAPI left of each touchdown zone: 4 units, inner unit 3.5°, then 3.17,
 *   2.83, 2.5°: each unit is white above its angle, red below.
 * - A rotating green/white beacon and red obstruction lights.
 *
 * `facingDeg` is the world heading the light's FRONT face points toward
 * (the viewer must be on that side to see `front`), null = omnidirectional.
 */
import { endDesignators, fromRunwayCoords, toRunwayCoords, type RunwayFrame } from '../runway';
import type { AirportPlan } from './plan';
import { pavementAt, pointInFillet } from './plan';

export type RGB = readonly [number, number, number];
export type LightKind = 'edge' | 'threshold' | 'taxi' | 'approach' | 'rabbit' | 'papi' | 'beacon' | 'obstruction' | 'reil';

export const COLORS = {
  white: [1.0, 0.93, 0.8] as RGB,
  yellow: [1.0, 0.72, 0.18] as RGB,
  green: [0.12, 1.0, 0.42] as RGB,
  red: [1.0, 0.07, 0.04] as RGB,
  blue: [0.12, 0.32, 1.0] as RGB,
  strobe: [0.9, 0.95, 1.0] as RGB,
  off: [0, 0, 0] as RGB,
} as const;

export interface LightDef {
  kind: LightKind;
  x: number;
  y: number;
  z: number;
  front: RGB;
  back: RGB;
  facingDeg: number | null;
  /** Apparent diameter of the glow up close, m. */
  size: number;
  /** Brightness at night (relative). */
  intensity: number;
  /** Fraction of the night brightness kept in full daylight. */
  day: number;
  /** Flasher index (rabbit) or −1. */
  seq: number;
  end?: string;
  /** PAPI unit index, 0 = inner (nearest the runway). */
  unit?: number;
  /** Runway the light belongs to ('36/18', '03/21'). */
  runway?: string;
}

export const PAPI_ANGLES = [3.5, 3.17, 2.83, 2.5] as const;
/** Half-width of the pink transition zone between red and white, deg. */
export const PAPI_TRANSITION = 0.06;
export const PAPI = {
  glideSlopeDeg: 3,
  /** Threshold crossing height of the 3° path, m. */
  tch: 15,
  /** Inner unit offset from the runway edge and spacing between units, m. */
  edgeOffset: 15,
  spacing: 9,
  lensHeight: 0.9,
};
export const RABBIT = {
  count: 5,
  /** The sweep repeats twice per second. */
  period: 0.5,
  /** Each flasher is lit for this long; the sweep takes count × flash < period. */
  flash: 0.06,
};
export const BEACON = { rpm: 12, beamHalfWidthDeg: 7 };

const FT = 0.3048;
const deg = Math.PI / 180;
const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** 0 = red … 1 = white for one PAPI unit set to `unitAngleDeg`, seen from `viewAngleDeg` above horizontal. */
export function papiUnitWhiteness(viewAngle: number, unitAngleDeg: number): number {
  if (!(viewAngle === viewAngle)) return 0;
  return smooth(unitAngleDeg - PAPI_TRANSITION, unitAngleDeg + PAPI_TRANSITION, viewAngle);
}

/** Number of units showing white (whiteness ≥ ½) at a viewing angle. */
export function papiWhiteCount(viewAngle: number): number {
  let n = 0;
  for (const u of PAPI_ANGLES) if (papiUnitWhiteness(viewAngle, u) >= 0.5) n++;
  return n;
}

/** Elevation angle (deg) of the viewer above the horizontal plane through the light. */
export function viewAngleDeg(cx: number, cy: number, cz: number, lx: number, ly: number, lz: number): number {
  const h = Math.hypot(cx - lx, cz - lz);
  return Math.atan2(cy - ly, h) / deg;
}

/** Index of the lit sequenced flasher (0 = outermost) or −1 in the pause. */
export function rabbitIndex(time: number): number {
  if (!Number.isFinite(time)) return -1;
  const t = ((time % RABBIT.period) + RABBIT.period) % RABBIT.period;
  const i = Math.floor(t / RABBIT.flash);
  return i >= 0 && i < RABBIT.count ? i : -1;
}

/** Global lamp level from the sun elevation: 1 at night, ≈0.2 in full daylight. */
export function lightLevel(sunElevationDeg: number): number {
  if (!(sunElevationDeg === sunElevationDeg)) return 1;
  return 0.2 + 0.8 * (1 - smooth(-4, 22, sunElevationDeg));
}

/** Rotating beacon: white beam and green beam 180° apart; intensities 0..1 toward an observer. */
export function beaconFlash(time: number, azimuthToViewerDeg: number): { white: number; green: number } {
  const beam = ((time * BEACON.rpm) / 60) * 360;
  const diff = (a: number) => {
    let d = (((a - azimuthToViewerDeg) % 360) + 360) % 360;
    if (d > 180) d = 360 - d;
    return d;
  };
  const f = (d: number) => {
    const x = 1 - d / BEACON.beamHalfWidthDeg;
    return x > 0 ? x * x : 0;
  };
  return { white: f(diff(beam)), green: f(diff(beam + 180)) };
}

// ─── layout ───────────────────────────────────────────────────────────────────

export function airportLights(plan: AirportPlan, heightAt: (x: number, z: number) => number = () => plan.elevation): LightDef[] {
  const rw = plan.rw;
  const L = rw.length;
  const hw = rw.halfWidth;
  const out: LightDef[] = [];
  /** Adder in the frame of runway `fr` (a along, c right of its centreline). */
  const adder = (fr: RunwayFrame) => (kind: LightKind, a: number, c: number, h: number, o: Partial<LightDef> & { front: RGB }) => {
    const p = fromRunwayCoords(a, c, fr);
    out.push({
      kind,
      x: p.x,
      y: heightAt(p.x, p.z) + h,
      z: p.z,
      back: o.back ?? o.front,
      facingDeg: o.facingDeg === undefined ? null : o.facingDeg,
      size: o.size ?? 0.6,
      intensity: o.intensity ?? 1,
      day: o.day ?? 0.3,
      seq: o.seq ?? -1,
      runway: fr.name,
      ...o,
    });
  };
  const add = adder(rw);
  /** True where a fixture would stand on pavement (it is left out: in-pavement lights aren't modelled). */
  const onPavement = (fr: RunwayFrame, a: number, c: number) => {
    const w = fromRunwayCoords(a, c, fr);
    const q = toRunwayCoords(w.x, w.z, rw);
    return pavementAt(plan, q.along, q.across) !== null;
  };

  // runway edge lights (HIRL), threshold/end lights, REILs — for every runway
  for (const fr of [rw, ...(plan.rw2 !== rw ? [plan.rw2] : [])]) {
    const addR = adder(fr);
    const [dA, dB] = endDesignators(fr);
    const toApproachA = (fr.headingDeg + 180) % 360; // front faces the pilot approaching/rolling toward +a
    const toApproachB = fr.headingDeg % 360;
    const Lr = fr.length;
    const hwr = fr.halfWidth;
    const caution = Math.min(600, Lr / 2);
    const segs = Math.ceil(Lr / 61);
    for (const s of [-1, 1])
      for (let i = 0; i <= segs; i++) {
        const a = (i / segs) * Lr;
        if (onPavement(fr, a, s * (hwr + 1.0))) continue;
        addR('edge', a, s * (hwr + 1.0), 0.35, {
          front: a >= Lr - caution - 1e-6 ? COLORS.yellow : COLORS.white,
          back: a <= caution + 1e-6 ? COLORS.yellow : COLORS.white,
          facingDeg: toApproachA,
          size: 0.7,
          intensity: 1,
          day: 0.28,
        });
      }
    const nTh = Math.round(fr.width / 3);
    for (let i = 0; i <= nTh; i++) {
      const c = -hwr + (i / nTh) * fr.width;
      addR('threshold', -1.5, c, 0.3, { front: COLORS.green, back: COLORS.red, facingDeg: toApproachA, size: 0.7, intensity: 1.1, day: 0.45, end: dA });
      addR('threshold', Lr + 1.5, c, 0.3, { front: COLORS.green, back: COLORS.red, facingDeg: toApproachB, size: 0.7, intensity: 1.1, day: 0.45, end: dB });
    }
    // REILs (a pair of synchronized white strobes 12 m beyond the edges) at every end without a MALSR
    const reil = (a: number, facing: number, end: string) => {
      for (const s of [-1, 1]) addR('reil', a, s * (hwr + 12), 0.9, { front: COLORS.strobe, back: COLORS.off, facingDeg: facing, size: 1.3, intensity: 3.2, day: 1, seq: 2, end });
    };
    if (fr !== rw) reil(-1.5, toApproachA, dA);
    reil(Lr + 1.5, toApproachB, dB);
  }
  const toApproach36 = (rw.headingDeg + 180) % 360;
  const toApproach18 = rw.headingDeg % 360;

  // MALSR for 36
  for (let k = 1; k <= 7; k++) {
    const a = -k * 200 * FT;
    const cs = [-2, -1, 0, 1, 2];
    if (k === 5) cs.push(-10, -8, -6, -4, 4, 6, 8, 10);
    for (const c of cs) add('approach', a, c, 0.6, { front: COLORS.white, back: COLORS.off, facingDeg: toApproach36, size: 0.8, intensity: 1.3, day: 0.55, end: '36' });
  }
  for (let k = 0; k < RABBIT.count; k++) {
    const a = -(2400 - k * 200) * FT; // outermost first
    add('rabbit', a, 0, 1.0, { front: COLORS.strobe, back: COLORS.off, facingDeg: toApproach36, size: 1.6, intensity: 4, day: 1, seq: k, end: '36' });
  }

  // PAPI: 36 left of the approach (−c); 18 on its right (west), clear of the crossing runway
  const aP = PAPI.tch / Math.tan(PAPI.glideSlopeDeg * deg);
  for (let u = 0; u < 4; u++) {
    const off = hw + PAPI.edgeOffset + u * PAPI.spacing;
    add('papi', aP, -off, PAPI.lensHeight, { front: COLORS.red, back: COLORS.off, facingDeg: toApproach36, size: 1.0, intensity: 2.2, day: 1, end: '36', unit: u });
  }
  for (let u = 0; u < 4; u++) {
    const off = hw + PAPI.edgeOffset + u * PAPI.spacing;
    add('papi', L - aP, -off, PAPI.lensHeight, { front: COLORS.red, back: COLORS.off, facingDeg: toApproach18, size: 1.0, intensity: 2.2, day: 1, end: '18', unit: u });
  }
  // the crossing runway's PAPIs (field.ts places them clear of the other runway and taxiway A)
  if (plan.rw2 !== rw) {
    const fr = plan.rw2;
    const addR = adder(fr);
    const [dA] = endDesignators(fr);
    for (const p of plan.field.papi) {
      const facing = p.end === dA ? (fr.headingDeg + 180) % 360 : fr.headingDeg % 360;
      for (let u = 0; u < 4; u++) addR('papi', p.t, p.s + p.side * u * PAPI.spacing, PAPI.lensHeight, { front: COLORS.red, back: COLORS.off, facingDeg: facing, size: 1.0, intensity: 2.2, day: 1, end: p.end, unit: u });
    }
  }

  // taxiway edge lights
  const taxi: { a: number; c: number }[] = [];
  const tw = plan.taxiway;
  const along = (a0: number, a1: number, c: number, maxSp: number) => {
    const n = Math.max(1, Math.ceil((a1 - a0) / maxSp));
    for (let i = 0; i <= n; i++) taxi.push({ a: a0 + ((a1 - a0) * i) / n, c });
  };
  const across = (c0: number, c1: number, a: number, maxSp: number) => {
    const n = Math.max(1, Math.ceil(Math.abs(c1 - c0) / maxSp));
    for (let i = 0; i <= n; i++) taxi.push({ a, c: c0 + ((c1 - c0) * i) / n });
  };
  along(tw.a0 + 1, tw.a1 - 1, tw.c - tw.halfWidth - 1, 50);
  along(tw.a0 + 1, tw.a1 - 1, tw.c + tw.halfWidth + 1, 50);
  for (const k of plan.connectors) {
    const cLo = Math.min(k.c0, k.c1) + plan.filletRadius + 2;
    const cHi = Math.max(k.c0, k.c1) - plan.filletRadius - 2;
    across(cLo, cHi, k.a - k.halfWidth - 1, 30);
    across(cLo, cHi, k.a + k.halfWidth + 1, 30);
  }
  for (const f of plan.fillets) {
    // centre of the arc = away from the corner; the grass is on that side
    const mid = f.arc[Math.floor(f.arc.length / 2)];
    const first = f.arc[0];
    const last = f.arc[f.arc.length - 1];
    const ca = first.a + last.a - f.corner.a;
    const cc = first.c + last.c - f.corner.c;
    const d = Math.hypot(ca - mid.a, cc - mid.c) || 1;
    taxi.push({ a: mid.a + ((ca - mid.a) / d) * 1, c: mid.c + ((cc - mid.c) / d) * 1 });
  }
  // taxiway ends and apron ends
  for (const a of [tw.a0 - 1, tw.a1 + 1]) across(tw.c - tw.halfWidth + 1.5, tw.c + tw.halfWidth - 1.5, a, 20);
  const ap = plan.apron;
  const side = tw.c >= 0 ? 1 : -1;
  const apNear = side > 0 ? ap.c0 : ap.c1;
  const apFar = side > 0 ? ap.c1 : ap.c0;
  for (const a of [ap.a0 - 1, ap.a1 + 1]) across(apNear + side * (plan.filletRadius + 2), apFar - side * 2, a, 40);

  // the field's taxiways and aprons (B, C, T-hangar lanes, the ARFF apron): every edge, 1 m out
  const edgeLights = (poly: readonly { a: number; c: number }[], maxSp: number) => {
    let area = 0;
    for (let i = 0; i < poly.length; i++) area += poly[i].a * poly[(i + 1) % poly.length].c - poly[(i + 1) % poly.length].a * poly[i].c;
    const sg = area >= 0 ? 1 : -1;
    for (let i = 0; i < poly.length; i++) {
      const p0 = poly[i];
      const p1 = poly[(i + 1) % poly.length];
      const len = Math.hypot(p1.a - p0.a, p1.c - p0.c);
      if (len < 2) continue;
      const na = (sg * (p1.c - p0.c)) / len;
      const nc = (-sg * (p1.a - p0.a)) / len;
      const n = Math.max(1, Math.ceil(len / maxSp));
      for (let k = 0; k <= n; k++) taxi.push({ a: p0.a + ((p1.a - p0.a) * k) / n + na, c: p0.c + ((p1.c - p0.c) * k) / n + nc });
    }
  };
  for (const r of plan.pavement)
    if (r.name === 'B' || r.name === 'arff' || /^T\d$/.test(r.name) || r.name === 'T-cross') edgeLights([{ a: r.a0, c: r.c0 }, { a: r.a1, c: r.c0 }, { a: r.a1, c: r.c1 }, { a: r.a0, c: r.c1 }], 30);
  for (const f of plan.polys) if (f.kind === 'taxiway') edgeLights(f.p, 30);

  const kept: { a: number; c: number }[] = [];
  for (const p of taxi) {
    if (pavementAt(plan, p.a, p.c) !== null) continue;
    let bad = false;
    for (const f of plan.fillets) if (pointInFillet(f, p.a, p.c)) bad = true;
    if (bad) continue;
    if (kept.some((q) => Math.hypot(q.a - p.a, q.c - p.c) < 8.5)) continue;
    kept.push(p);
  }
  for (const p of kept) add('taxi', p.a, p.c, 0.3, { front: COLORS.blue, size: 0.55, intensity: 0.9, day: 0.22 });

  // beacon on the tower mast, red obstruction lights on the tower roof
  const t = plan.tower;
  const tg = heightAt(t.center.x, t.center.z);
  out.push({ kind: 'beacon', x: t.center.x, y: tg + t.height + 3.2, z: t.center.z, front: COLORS.off, back: COLORS.off, facingDeg: null, size: 2.2, intensity: 5, day: 0.6, seq: -1 });
  const hd = (t.headingDeg * Math.PI) / 180;
  for (const s of [-1, 1]) {
    const x = t.center.x + Math.cos(hd) * s * (t.width / 2 + 0.2);
    const z = t.center.z + Math.sin(hd) * s * (t.width / 2 + 0.2);
    out.push({ kind: 'obstruction', x, y: tg + t.height + 0.6, z, front: COLORS.red, back: COLORS.red, facingDeg: null, size: 0.6, intensity: 1.2, day: 0.35, seq: -1 });
  }
  // red obstruction lights on the tallest field installations (glideslope mast, ARFF hose tower)
  for (const b of plan.field.buildings) {
    if (b.kind !== 'glideslope') continue;
    // the mast stands 1.8 m left of the shelter (local −X of the building frame)
    const p = fromRunwayCoords(b.a, b.c, rw);
    const r = (-b.headingDeg * Math.PI) / 180;
    const x = p.x - 1.8 * Math.cos(r), z = p.z + 1.8 * Math.sin(r);
    out.push({ kind: 'obstruction', x, y: heightAt(x, z) + 13.0, z, front: COLORS.red, back: COLORS.red, facingDeg: null, size: 0.6, intensity: 1.2, day: 0.35, seq: -1 });
  }
  return out;
}
