/**
 * The player hull's wake as a change of the sea surface (PURE, no three.js): the "wake field".
 *
 * A driven boat's wake is rendered into a world-aligned wake map (src/world/water/wakeMap.ts)
 * that the sea shader samples: R = wake wave height (m, signed, additive), G = white-water foam,
 * B = churn (aerated, turbulent water: rougher and paler), A = slick (the calm trail where the
 * turbulence has flattened the small ripples). This module holds the physics of that field — the
 * same numbers as TS functions (tested) and as GLSL (`WAKE_FIELD_GLSL`, drawn) — and builds the
 * strip of track the map is rendered from (`buildWakeStrip`).
 *
 * The field is evaluated in TRACK coordinates: x = distance behind the bow along the hull's past
 * track (so the pattern bends with every turn) and y = lateral offset (+ starboard); world-fixed
 * features (foam lace) use s = distance travelled when the hull passed (fixed to the water).
 *
 *  - Kelvin waves by stationary phase for a point source at speed U: at (x, y) inside the ±19.47°
 *    wedge, tan θ solves 2yτ² − xτ + y = 0 — the transverse (small θ) and the diverging (large θ)
 *    systems — with phase ψ = k₀ sec θ (x − yτ), k₀ = g/U², local wavenumber k = k₀ sec²θ
 *    (λ = 2πU²cos²θ/g), crests at ~35° to the track at the cusp. Amplitude ∝ (L/(x+L))^½, an
 *    Airy-like bump at the cusp line, evanescent outside it; a hull filter keeps what a hull of
 *    length L and draft d makes: long waves (kL ≲ 2) are weak (so the transverse waves and the
 *    wide part of the wedge fade as it planes and the visible wake narrows toward ~0.18/Fr), very
 *    short ones decay as e^(−k d); and anything shorter than the map resolves is faded out.
 *  - Behind the transom when planing: the two quarter waves rising off the chines, the hollow and
 *    the rooster hump on the centreline.
 *  - Foam: solid churned white at the transom opening out and breaking up with age into a
 *    track-aligned lace (cell edges of a stretched, domain-warped cellular noise), gone by ~30 s;
 *    white on the quarter waves and on the steepest diverging crests near the hull.
 */

export const GRAVITY = 9.81;
/** tan²(19.47°) = 1/8: the Kelvin cusp. */
export const KELVIN_TAN2 = 1 / 8;
export const KELVIN_DEG = (Math.atan(Math.sqrt(KELVIN_TAN2)) * 180) / Math.PI;

/** Tunables of the field (shared by the TS mirror and the GLSL). */
export const WAKE_FIELD = {
  /** Wave amplitude per metre of beam at full strength (m/m): a 4 m beam makes ~0.5 m waves (≈ 1 m crest to trough near the cusp). */
  ampPerBeam: 0.11,
  /** Hull filter: long-wave cutoff kL (≈ 2) and the effective draft for the short-wave decay (m). */
  lowKL: 2.5,
  draft: 0.28,
  /** Cusp: Airy bump (× amplitude) and its width in r = √(1 − 8y²/x²); evanescent decay outside. */
  cuspGain: 0.8,
  cuspWidth: 0.22,
  cuspDecay: 0.12,
  /** Waves fade with age (s): e-folding. */
  waveLife: 110,
  /** Quarter waves (m at full planing), their outward angle (deg) and width (m). */
  quarter: 0.34,
  quarterDeg: 9,
  /** Rooster hump and transom hollow (m at full planing). */
  rooster: 0.2,
  hollow: 0.14,
  /** Foam: white life (s), lace life (s), churn and slick life (s). */
  whiteLife: 2.2,
  laceLife: 16,
  churnLife: 32,
  slickLife: 140,
} as const;

export interface WakeFieldInput {
  /** Behind the bow along the track (m), lateral (m, + starboard), world-fixed along-track coordinate (m). */
  x: number;
  y: number;
  s: number;
  /** Hull speed when it passed (m/s), seconds since, planing 0..1. */
  U: number;
  age: number;
  planing: number;
  /** Hull length and beam (m). */
  L: number;
  B: number;
  /** Largest wavenumber the map resolves (1/m). */
  kMax: number;
}

export interface WakeFieldOut {
  height: number;
  foam: number;
  churn: number;
  slick: number;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Half-angle of the Kelvin wedge (rad) — 19.47°, independent of speed. */
export const kelvinHalfAngle = (): number => Math.atan(Math.sqrt(KELVIN_TAN2));

/** Wavelength (m) of the Kelvin wave travelling at θ (rad) to the track behind a source at U (m/s): 2πU²cos²θ/g. */
export const kelvinWavelength = (U: number, thetaRad: number): number => (2 * Math.PI * U * U * Math.cos(thetaRad) ** 2) / GRAVITY;

/** Apparent (amplitude-peak) wake angle of a hull at length Froude number Fr (Rabaud & Moisy): the Kelvin angle below Fr ≈ 0.5, ≈ 0.18/Fr above. */
export const apparentWakeAngle = (U: number, L: number): number => {
  const fr = U / Math.sqrt(GRAVITY * Math.max(1, L));
  return Math.min(kelvinHalfAngle(), 0.18 / Math.max(1e-3, fr));
};

/** The two stationary-phase roots τ = tan θ at (x, y): transverse (small) and diverging (large); null outside the wedge. */
export function kelvinRoots(x: number, y: number): { transverse: number; diverging: number; r: number } | null {
  const Y = Math.max(Math.abs(y), 1e-3);
  if (x <= 0) return null;
  const d = 1 - (8 * Y * Y) / (x * x);
  if (d < 0) return null;
  const r = Math.sqrt(d);
  return { transverse: (x * (1 - r)) / (4 * Y), diverging: (x * (1 + r)) / (4 * Y), r };
}

/** Hull filter on a wave of wavenumber k (1/m): weak long waves (kL ≲ 2), e^(−k·d) short-wave decay, faded above kMax. */
export function hullFilter(k: number, L: number, kMax: number): number {
  const kl = (k * L) / WAKE_FIELD.lowKL;
  const lo = 1 - Math.exp(-(kl * kl));
  const hi = Math.exp(-k * WAKE_FIELD.draft);
  const res = 1 - smoothstep(0.5 * kMax, kMax, k);
  return lo * hi * res;
}

/** Overall wave amplitude (m) for a hull of beam B at speed U (m/s) and planing fraction. */
export const wakeAmplitude = (U: number, B: number, planing: number): number => WAKE_FIELD.ampPerBeam * B * smoothstep(0.4, 5, U) * (1 - 0.25 * Math.min(1, Math.max(0, planing)));

/** The Kelvin pattern alone (m) at track coordinates (x behind the bow, y lateral). */
export function kelvinHeight(x: number, y: number, U: number, L: number, B: number, planing: number, kMax: number): number {
  if (x <= 0 || U < 0.3) return 0;
  const k0 = GRAVITY / (U * U);
  const A = wakeAmplitude(U, B, planing) * Math.sqrt(L / (x + L)) * smoothstep(0, 0.4 * L, x);
  const Y = Math.max(Math.abs(y), 1e-3);
  const q = (8 * Y * Y) / (x * x) - 1;
  const branch = (tau: number, gain: number) => {
    const sec2 = 1 + tau * tau;
    const k = k0 * sec2;
    const f = hullFilter(k, L, kMax);
    if (f <= 1e-5) return 0;
    const psi = k0 * Math.sqrt(sec2) * (x - Y * tau);
    // second-order Stokes: sharper crests, flatter troughs (ka capped)
    const ka = Math.min(0.45, 1.5 * A * gain * f * k);
    return A * gain * f * (Math.cos(psi) + ka * Math.cos(2 * psi));
  };
  if (q <= 0) {
    const r = Math.sqrt(-q);
    const cusp = 1 + WAKE_FIELD.cuspGain * Math.exp(-r / WAKE_FIELD.cuspWidth);
    const tt = (x * (1 - r)) / (4 * Y);
    const td = (x * (1 + r)) / (4 * Y);
    return branch(tt, cusp) + branch(td, cusp);
  }
  // outside the cusp line: the merged wave, dying away
  const tc = x / (4 * Y);
  return branch(tc, 2 * (1 + WAKE_FIELD.cuspGain) * Math.exp(-q / WAKE_FIELD.cuspDecay));
}

/** Behind the transom when planing: quarter waves, hollow, rooster (m). */
export function sternHeight(x: number, y: number, U: number, L: number, B: number, planing: number): number {
  const p = Math.min(1, Math.max(0, planing)) * smoothstep(3, 9, U);
  if (p <= 0) return 0;
  const xs = x - L;
  const ay = Math.abs(y);
  const tq = Math.tan((WAKE_FIELD.quarterDeg * Math.PI) / 180);
  const yq = 0.45 * B + Math.max(xs, 0) * tq;
  const sq = 0.55 + 0.06 * Math.max(xs, 0);
  const along = smoothstep(-0.15 * L, 0.35 * L, xs) * Math.exp(-Math.max(xs, 0) / (2.5 * L));
  const quarter = WAKE_FIELD.quarter * along * Math.exp(-((ay - yq) ** 2) / (2 * sq * sq)) * (B / 4.11);
  const rooster = WAKE_FIELD.rooster * Math.exp(-(((xs - 0.9 * L) / (0.6 * L)) ** 2)) * Math.exp(-(y * y) / (2 * (0.3 * B) ** 2));
  const hollow = -WAKE_FIELD.hollow * Math.exp(-(((xs - 0.15 * L) / (0.35 * L)) ** 2)) * Math.exp(-(y * y) / (2 * (0.45 * B) ** 2));
  return p * (quarter + rooster + hollow);
}

/** Half-width (m) of the turbulent trail at `age` s behind a hull of beam B. */
export const trailHalfWidth = (age: number, B: number): number => 0.5 * B * (0.75 + 0.9 * Math.sqrt(Math.max(age, 0) / 10));

/**
 * The field at a point (the TS mirror of the GLSL, without the sub-metre lace, which is replaced
 * by its mean): height (m), foam, churn, slick (0..1).
 */
export function wakeField(i: WakeFieldInput, out: WakeFieldOut = { height: 0, foam: 0, churn: 0, slick: 0 }): WakeFieldOut {
  const { x, y, U, L, B, planing, kMax } = i;
  const age = Math.max(0, i.age);
  const life = Math.exp(-age / WAKE_FIELD.waveLife);
  let h = (kelvinHeight(x, y, U, L, B, planing, kMax) + sternHeight(x, y, U, L, B, planing)) * life;
  // nothing lifts the water inside the hull's own footprint
  const inHull = (1 - smoothstep(0.85 * L, 1.0 * L, x)) * (1 - smoothstep(0.4 * B, 0.55 * B, Math.abs(y)));
  h = h > 0 ? h * (1 - inHull) : h;
  const behind = smoothstep(0.92 * L, 1.02 * L, x);
  const fI = smoothstep(1.5, 6, U) * (0.7 + 0.3 * Math.min(1, Math.max(0, planing)));
  const wf = trailHalfWidth(age, B);
  const ay = Math.abs(y);
  const prof = 1 - smoothstep(0.7 * wf, 1.15 * wf, ay);
  const lace = 0.45; // mean coverage of the lace network
  const white = Math.exp(-age / WAKE_FIELD.whiteLife);
  const foamTrail = fI * prof * (white + (1 - white) * lace * Math.exp(-age / WAKE_FIELD.laceLife));
  out.height = Number.isFinite(h) ? h : 0;
  out.foam = Math.min(1, foamTrail * behind);
  out.churn = Math.min(1, fI * (1 - smoothstep(0.9 * wf, 1.4 * wf, ay)) * Math.exp(-age / WAKE_FIELD.churnLife) * behind);
  out.slick = Math.min(1, smoothstep(1, 4, U) * (1 - smoothstep(1.2 * wf, 1.8 * wf, ay)) * Math.exp(-age / WAKE_FIELD.slickLife) * behind);
  return out;
}

// ─── The map's frame ────────────────────────────────────────────────────────────────────────────

export interface WakeMapFrame {
  /** World x, z of the map's (0, 0) corner, snapped to whole texels (never swims). */
  x0: number;
  z0: number;
  extent: number;
  res: number;
  texel: number;
}

/**
 * The map's frame for a boat at (bx, bz) heading `headingDeg`: centred `lead` × extent behind the
 * boat (the wake is behind it), the corner snapped to whole texels.
 */
export function wakeMapFrame(bx: number, bz: number, headingDeg: number, extent: number, res: number, lead = 0.3, out?: WakeMapFrame): WakeMapFrame {
  const h = (headingDeg * Math.PI) / 180;
  const cx = bx - Math.sin(h) * lead * extent;
  const cz = bz + Math.cos(h) * lead * extent;
  const texel = extent / res;
  const o = out ?? { x0: 0, z0: 0, extent, res, texel };
  o.x0 = Math.round((cx - extent / 2) / texel) * texel;
  o.z0 = Math.round((cz - extent / 2) / texel) * texel;
  o.extent = extent;
  o.res = res;
  o.texel = texel;
  return o;
}

// ─── The strip of track the map is drawn from ─────────────────────────────────────────────────

/** What the strip builder needs of the hull's track (src/world/traffic/hullTrack.ts HullTrack). */
export interface TrackSource {
  readonly travelled: number;
  readonly oldestTravelled: number;
  sampleAtDistance(s: number, now: number, out: { x: number; z: number; course: number; speed: number; travelled: number; age: number; planing?: number }): unknown;
}

/** Along-track spacing bands (m): [until distance behind, spacing]. Each band's samples sit on its own fixed grid of s. */
export const STRIP_BANDS: readonly (readonly [number, number])[] = [
  [160, 2],
  [420, 5],
  [900, 12],
];
/** Most samples a strip can hold. */
export const STRIP_MAX = 2 + STRIP_BANDS.reduce((n, [end, step], i) => n + Math.ceil((end - (i ? STRIP_BANDS[i - 1][0] : 0)) / step) + 1, 0);
/** Vertices across the strip (port edge, centre, starboard edge). */
export const STRIP_ACROSS = 3;

export interface WakeStrip {
  /** Per vertex: world x, z. */
  xz: Float32Array;
  /** Per vertex: s (m, world-fixed along-track), y (m, lateral), age (s), U (m/s). */
  track: Float32Array;
  /** Per vertex: planing, half-width W (m), −, −. */
  extra: Float32Array;
  /** Samples written (vertices = count × STRIP_ACROSS). */
  count: number;
}

export function newWakeStrip(): WakeStrip {
  const n = STRIP_MAX * STRIP_ACROSS;
  return { xz: new Float32Array(n * 2), track: new Float32Array(n * 4), extra: new Float32Array(n * 4), count: 0 };
}

/** Index buffer for a strip of STRIP_MAX samples × STRIP_ACROSS. */
export function wakeStripIndices(): Uint32Array {
  const out: number[] = [];
  for (let j = 0; j < STRIP_MAX - 1; j++)
    for (let a = 0; a < STRIP_ACROSS - 1; a++) {
      const p = j * STRIP_ACROSS + a;
      const q = p + STRIP_ACROSS;
      out.push(p, q, p + 1, p + 1, q, q + 1);
    }
  return new Uint32Array(out);
}

const _smp = { x: 0, z: 0, course: 0, speed: 0, travelled: 0, age: 0, planing: 0 };
const _ss = new Float64Array(STRIP_MAX);

/**
 * Samples the track on fixed grids of s (dense near the boat, coarser behind: vertices don't slide
 * over the water as the boat moves, so the foam stays put) and writes the strip: per sample a line
 * across the track, as wide as the Kelvin wedge there (+ margin, feathered in the shader), narrowed
 * in tight turns so the strip never folds over itself. Speed and planing are the hull's when it
 * passed; L is the hull length (the bow is L/2 ahead of the track's hull centre).
 */
export function buildWakeStrip(track: TrackSource, now: number, L: number, B: number, out: WakeStrip): WakeStrip {
  const sNow = track.travelled;
  const sMin = Math.max(track.oldestTravelled, sNow - STRIP_BANDS[STRIP_BANDS.length - 1][0]);
  // s values: now, then each band's grid
  let n = 0;
  _ss[n++] = sNow;
  let start = 0;
  for (const [end, step] of STRIP_BANDS) {
    let s = Math.floor((sNow - start) / step) * step;
    if (s >= sNow - 1e-6) s -= step;
    for (; s > sNow - end - 1e-6 && n < STRIP_MAX - 1; s -= step) {
      if (s < sMin) break;
      if (s < _ss[n - 1] - 1e-6) _ss[n++] = s;
    }
    start = end;
  }
  if (n < STRIP_MAX && sMin < _ss[n - 1] - 1e-3) _ss[n++] = sMin;
  if (n < 2) {
    out.count = 0;
    return out;
  }
  const hx = new Float64Array(n);
  const hz = new Float64Array(n);
  const hc = new Float64Array(n);
  for (let j = 0; j < n; j++) {
    _smp.planing = 0;
    track.sampleAtDistance(_ss[j], now, _smp);
    hx[j] = _smp.x;
    hz[j] = _smp.z;
    hc[j] = _smp.course;
    const v = j * STRIP_ACROSS;
    for (let a = 0; a < STRIP_ACROSS; a++) {
      out.track[(v + a) * 4] = _ss[j];
      out.track[(v + a) * 4 + 2] = _smp.age;
      out.track[(v + a) * 4 + 3] = _smp.speed;
      out.extra[(v + a) * 4] = _smp.planing;
    }
  }
  const DEG = Math.PI / 180;
  for (let j = 0; j < n; j++) {
    const x = sNow - _ss[j] + L / 2; // behind the bow
    let W = Math.max(0, x) * 0.42 + B + 4;
    // tight turns: no wider than ~85 % of the local turn radius (from the neighbours' headings)
    const a = Math.max(0, j - 2);
    const b = Math.min(n - 1, j + 2);
    const ds = Math.abs(_ss[a] - _ss[b]);
    const dh = Math.abs(((((hc[a] - hc[b]) % 360) + 540) % 360) - 180) * DEG;
    if (dh > 1e-4 && ds > 0) W = Math.min(W, Math.max(B + 4, (0.85 * ds) / dh));
    const h = hc[j] * DEG;
    // starboard of the heading: (cos h, sin h)
    const rx = Math.cos(h);
    const rz = Math.sin(h);
    const v = j * STRIP_ACROSS;
    for (let k = 0; k < STRIP_ACROSS; k++) {
      const y = (k / (STRIP_ACROSS - 1) * 2 - 1) * W;
      out.xz[(v + k) * 2] = hx[j] + rx * y;
      out.xz[(v + k) * 2 + 1] = hz[j] + rz * y;
      out.track[(v + k) * 4 + 1] = y;
      out.extra[(v + k) * 4 + 1] = W;
    }
  }
  out.count = n;
  return out;
}

// ─── GLSL ───────────────────────────────────────────────────────────────────────────────────────

const f = (x: number): string => (Number.isInteger(x) ? `${x}.0` : String(x));

/**
 * The wake field in GLSL: `vec4 wakeField( x, y, s, U, age, planing, W, L, B, kMax )` → (height,
 * foam, churn, slick). Mirrors the TS above; the lace is a stretched, domain-warped cellular noise
 * in (s, y). Every pow() base is max()-guarded; sqrt() arguments are clamped (the RECORD lesson).
 */
export const WAKE_FIELD_GLSL = /* glsl */ `
const float WK_G = ${f(GRAVITY)};
float wkSmooth( float a, float b, float x ) { float t = clamp( ( x - a ) / ( b - a ), 0.0, 1.0 ); return t * t * ( 3.0 - 2.0 * t ); }
float wkHash( vec2 p ) { p = fract( p * vec2( 123.34, 456.21 ) ); p += dot( p, p + 45.32 ); return fract( p.x * p.y ); }
vec2 wkHash2( vec2 p ) { return vec2( wkHash( p ), wkHash( p + 17.13 ) ); }
float wkNoise( vec2 p ) {
  vec2 i = floor( p ); vec2 u = fract( p ); u = u * u * ( 3.0 - 2.0 * u );
  return mix( mix( wkHash( i ), wkHash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( wkHash( i + vec2( 0.0, 1.0 ) ), wkHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
// cellular noise: F2 − F1 (small on the cell edges: a lace network)
float wkCells( vec2 p ) {
  vec2 i = floor( p ); vec2 fp = fract( p );
  float d1 = 8.0; float d2 = 8.0;
  for ( int yy = -1; yy <= 1; yy++ ) for ( int xx = -1; xx <= 1; xx++ ) {
    vec2 g = vec2( float( xx ), float( yy ) );
    vec2 o = g + wkHash2( i + g ) - fp;
    float d = dot( o, o );
    if ( d < d1 ) { d2 = d1; d1 = d; } else if ( d < d2 ) d2 = d;
  }
  return sqrt( max( d2, 0.0 ) ) - sqrt( max( d1, 0.0 ) );
}
float wkFilter( float k, float L, float kMax ) {
  float kl = k * L / ${f(WAKE_FIELD.lowKL)};
  return ( 1.0 - exp( - kl * kl ) ) * exp( - k * ${f(WAKE_FIELD.draft)} ) * ( 1.0 - wkSmooth( 0.5 * kMax, kMax, k ) );
}
float wkBranch( float x, float Y, float tau, float k0, float L, float kMax, float Ag ) {
  float sec2 = 1.0 + tau * tau;
  float k = k0 * sec2;
  float fl = wkFilter( k, L, kMax );
  if ( fl < 1e-5 ) return 0.0;
  float psi = k0 * sqrt( sec2 ) * ( x - Y * tau );
  // second-order Stokes: sharper crests, flatter troughs (ka capped)
  float ka = min( 0.45, 1.5 * Ag * fl * k );
  return Ag * fl * ( cos( psi ) + ka * cos( 2.0 * psi ) );
}
float wkKelvin( float x, float y, float U, float L, float B, float planing, float kMax ) {
  if ( x <= 0.0 || U < 0.3 ) return 0.0;
  float k0 = WK_G / ( U * U );
  float A = ${f(WAKE_FIELD.ampPerBeam)} * B * wkSmooth( 0.4, 5.0, U ) * ( 1.0 - 0.25 * clamp( planing, 0.0, 1.0 ) );
  A *= sqrt( L / ( x + L ) ) * wkSmooth( 0.0, 0.4 * L, x );
  float Y = max( abs( y ), 1e-3 );
  float q = 8.0 * Y * Y / ( x * x ) - 1.0;
  if ( q <= 0.0 ) {
    float r = sqrt( max( - q, 0.0 ) );
    float cusp = 1.0 + ${f(WAKE_FIELD.cuspGain)} * exp( - r / ${f(WAKE_FIELD.cuspWidth)} );
    float tt = x * ( 1.0 - r ) / ( 4.0 * Y );
    float td = x * ( 1.0 + r ) / ( 4.0 * Y );
    return wkBranch( x, Y, tt, k0, L, kMax, A * cusp ) + wkBranch( x, Y, td, k0, L, kMax, A * cusp );
  }
  float tc = x / ( 4.0 * Y );
  return wkBranch( x, Y, tc, k0, L, kMax, A * 2.0 * ( 1.0 + ${f(WAKE_FIELD.cuspGain)} ) * exp( - q / ${f(WAKE_FIELD.cuspDecay)} ) );
}
float wkStern( float x, float y, float U, float L, float B, float planing ) {
  float p = clamp( planing, 0.0, 1.0 ) * wkSmooth( 3.0, 9.0, U );
  if ( p <= 0.0 ) return 0.0;
  float xs = x - L;
  float ay = abs( y );
  float yq = 0.45 * B + max( xs, 0.0 ) * ${f(Math.tan((WAKE_FIELD.quarterDeg * Math.PI) / 180))};
  float sq = 0.55 + 0.06 * max( xs, 0.0 );
  float along = wkSmooth( -0.15 * L, 0.35 * L, xs ) * exp( - max( xs, 0.0 ) / ( 2.5 * L ) );
  float dq = ay - yq;
  float quarter = ${f(WAKE_FIELD.quarter)} * along * exp( - dq * dq / ( 2.0 * sq * sq ) ) * ( B / 4.11 );
  float xr = ( xs - 0.9 * L ) / ( 0.6 * L );
  float rooster = ${f(WAKE_FIELD.rooster)} * exp( - xr * xr ) * exp( - y * y / ( 2.0 * 0.09 * B * B ) );
  float xh = ( xs - 0.15 * L ) / ( 0.35 * L );
  float hollow = - ${f(WAKE_FIELD.hollow)} * exp( - xh * xh ) * exp( - y * y / ( 2.0 * 0.2025 * B * B ) );
  return p * ( quarter + rooster + hollow );
}
// the lace: foam on the edges of stretched, warped cells (streaks along the track), thinning with age
float wkLace( float s, float y, float age ) {
  vec2 p = vec2( s / 3.2, y / 1.05 );
  vec2 w = vec2( wkNoise( p * 0.7 + 3.1 ), wkNoise( p * 0.7 - 7.7 ) ) - 0.5;
  p += w * 1.1;
  float e = wkCells( p );
  float e2 = wkCells( p * 2.3 + 11.0 );
  float fa = clamp( age / ${f(WAKE_FIELD.laceLife)}, 0.0, 1.0 );
  float thick = mix( 0.26, 0.05, sqrt( fa ) );
  float net = 1.0 - wkSmooth( thick * 0.35, thick, e );
  float fine = 1.0 - wkSmooth( thick * 0.2, thick * 0.6, e2 );
  // streaks along the track
  float streak = wkNoise( vec2( s / 16.0, y / 0.45 ) );
  float streak2 = wkSmooth( 0.35, 0.75, streak );
  return clamp( max( net, fine * 0.6 ) * ( 0.35 + 0.9 * streak2 ), 0.0, 1.0 );
}
vec4 wakeField( float x, float y, float s, float U, float age, float planing, float W, float L, float B, float kMax ) {
  age = max( age, 0.0 );
  float life = exp( - age / ${f(WAKE_FIELD.waveLife)} );
  float kel = wkKelvin( x, y, U, L, B, planing, kMax );
  float h = ( kel + wkStern( x, y, U, L, B, planing ) ) * life;
  float inHull = ( 1.0 - wkSmooth( 0.85 * L, L, x ) ) * ( 1.0 - wkSmooth( 0.4 * B, 0.55 * B, abs( y ) ) );
  h = h > 0.0 ? h * ( 1.0 - inHull ) : h;
  // feather the strip's own edge
  h *= 1.0 - wkSmooth( 0.8 * W, W, abs( y ) );
  float behind = wkSmooth( 0.92 * L, 1.02 * L, x );
  float pl = clamp( planing, 0.0, 1.0 );
  float fI = wkSmooth( 1.5, 6.0, U ) * ( 0.7 + 0.3 * pl );
  float wf = 0.5 * B * ( 0.75 + 0.9 * sqrt( age / 10.0 ) );
  float ay = abs( y );
  // ragged trail edges
  float edgeN = wkNoise( vec2( s / 7.0, sign( y ) * 5.0 ) ) - 0.5;
  float prof = 1.0 - wkSmooth( 0.7 * wf, 1.15 * wf, ay + edgeN * 0.35 * wf );
  float white = exp( - age / ${f(WAKE_FIELD.whiteLife)} );
  float lace = wkLace( s, y, age );
  // churned white core (a beam wide, the prop wash), lace over the whole trail, both breaking up
  float core = 1.0 - wkSmooth( 0.35 * wf, 0.75 * wf, ay + edgeN * 0.3 * wf );
  float solid = white * mix( 0.55, 1.0, core ) * mix( 0.75, 1.0, lace );
  float foam = fI * prof * max( solid, lace * ( 0.25 + 0.75 * core ) * exp( - age / ${f(WAKE_FIELD.laceLife)} ) ) * behind;
  // white water on the quarter waves and on the steepest diverging crests beside the hull
  float st = wkStern( x, y, U, L, B, planing );
  foam = max( foam, wkSmooth( 0.12, 0.3, st ) * lace * exp( - max( x - L, 0.0 ) / ( 1.6 * L ) ) );
  float A0 = ${f(WAKE_FIELD.ampPerBeam)} * B * sqrt( L / ( max( x, 0.0 ) + L ) );
  foam = max( foam, wkSmooth( 0.75, 1.3, kel / max( A0, 1e-3 ) ) * exp( - x / ( 3.0 * L ) ) * lace * 0.9 );
  // the diverging crests carry white streaks for the first hundred metres or so: broken lines of
  // foam along each sharp crest (streaked along the crest, which runs nearly with the track)
  float crestN = kel / max( A0 * wkSmooth( 0.4, 5.0, U ), 1e-3 );
  float crestStreak = wkSmooth( 0.3, 0.8, wkNoise( vec2( s / 9.0, y / 0.7 ) ) ) * ( 0.5 + 0.5 * lace );
  foam = max( foam, wkSmooth( 0.35, 0.8, crestN ) * exp( - max( x - L, 0.0 ) / ( 7.0 * L ) ) * crestStreak * wkSmooth( 3.0, 8.0, U ) * 0.85 * life );
  float churn = fI * ( 1.0 - wkSmooth( 0.9 * wf, 1.4 * wf, ay + edgeN * 0.3 * wf ) ) * exp( - age / ${f(WAKE_FIELD.churnLife)} ) * behind;
  float slick = wkSmooth( 1.0, 4.0, U ) * ( 1.0 - wkSmooth( 1.2 * wf, 1.8 * wf, ay ) ) * exp( - age / ${f(WAKE_FIELD.slickLife)} ) * behind;
  return vec4( h, clamp( foam, 0.0, 1.0 ), clamp( churn, 0.0, 1.0 ), clamp( slick, 0.0, 1.0 ) );
}
`;
