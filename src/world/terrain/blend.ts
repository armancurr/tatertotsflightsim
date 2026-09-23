/**
 * How the terrain shader turns the per-vertex landcover into per-pixel surface
 * classes and blends the two strongest ones by their detail heights. PURE; the
 * GLSL in BLEND_GLSL is a line-for-line twin (keep them in sync — the tests
 * exercise the TypeScript).
 *
 * Classes (index): 0 field, 1 grass, 2 forest, 3 rock, 4 scree, 5 snow, 6 sand, 7 urban.
 * Priority as in landcover.ts: snow > rock > urban > sand > forest > field|grass,
 * each class taking its presence × what is left, so weights are in [0, 1] and sum to 1.
 * Rock splits into bare rock and scree/talus by slope (scree lies at the foot of faces).
 */

export const CLASS_NAMES = ['field', 'grass', 'forest', 'rock', 'scree', 'snow', 'sand', 'urban'] as const;
export const CLASS_COUNT = CLASS_NAMES.length;

const sat = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const sstep = (e0: number, e1: number, x: number): number => {
  const t = sat((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
};

export interface ClassInputs {
  /** Vertex landcover (LANDCOVER_KEYS order): forest, field, grass, rock | snow, sand, urban, water. */
  forest: number;
  field: number;
  grass: number;
  rock: number;
  snow: number;
  sand: number;
  urban: number;
  /** 1 − normal.y of the smooth surface. */
  slope: number;
  /** Boundary break-up noises, roughly −0.5 … 0.5. */
  nb: number;
  nb2: number;
  /** Fine snow-edge noise, −0.5 … 0.5, and the fall-line streak value 0 … 1 (gullies hold snow). */
  nSnow: number;
  streak: number;
  /** Height above sea level (m) — scree only in the high country. */
  height: number;
}

/** Per-pixel class weights (sum 1). Writes into `out` (length ≥ CLASS_COUNT). */
export function classWeights(i: ClassInputs, out: Float32Array | number[]): Float32Array | number[] {
  // The break-up noise only moves a boundary: a class is gated by its own landcover (a class the
  // vertex doesn't have never appears — no snow flecks or forest smudges in lowland fields).
  const wForest = sat((i.forest - 0.5 + i.nb * 0.55) * 3.5 + 0.5) * sstep(0, 0.1, i.forest);
  const wRockBase = Math.max(sat((i.rock - 0.5 + i.nb2 * 0.5) * 3.0 + 0.5) * sstep(0, 0.1, i.rock), sstep(0.24, 0.4, i.slope + i.nb * 0.06) * 0.9);
  // snow: ragged edges, gone on the steepest faces, lingering in gullies on steep slopes
  const steepOff = 1 - sstep(0.34 + 0.12 * i.streak, 0.5 + 0.12 * i.streak, i.slope);
  const wSnow = sat((i.snow - 0.5 + i.nb2 * 0.6 + i.nSnow * 0.35 + (i.streak - 0.5) * 0.5 * sstep(0.08, 0.3, i.slope)) * 3.0 + 0.5) * steepOff * sstep(0, 0.12, i.snow);
  const wSand = sat((i.sand - 0.5 + i.nb * 0.4) * 3.0 + 0.5) * sstep(0, 0.1, i.sand);
  const wUrban = sat((i.urban - 0.5 + i.nb2 * 0.5) * 2.5 + 0.5) * sstep(0, 0.1, i.urban);
  let rem = 1;
  const aS = wSnow * rem;
  rem -= aS;
  const aR = wRockBase * rem;
  rem -= aR;
  const aU = wUrban * rem;
  rem -= aU;
  const aD = wSand * rem;
  rem -= aD;
  const aF = wForest * rem;
  rem -= aF;
  const fg = i.field + i.grass + 1e-4;
  const aC = (rem * i.field) / fg;
  const aG = rem - aC;
  // scree/talus: moderate slopes in the high country (fans below the faces)
  const screeFrac = sstep(900, 1400, i.height) * (1 - sstep(0.26, 0.42, i.slope + i.nb * 0.1)) * sstep(0.02, 0.12, i.slope);
  out[0] = aC;
  out[1] = aG;
  out[2] = aF;
  out[3] = aR * (1 - screeFrac);
  out[4] = aR * screeFrac;
  out[5] = aS;
  out[6] = aD;
  out[7] = aU;
  return out;
}

/** Indices of the two largest weights (first ≥ second). */
export function topTwo(w: ArrayLike<number>): [number, number] {
  let i1 = 0;
  let i2 = 1;
  if (w[1] > w[0]) {
    i1 = 1;
    i2 = 0;
  }
  for (let k = 2; k < CLASS_COUNT; k++) {
    if (w[k] > w[i1]) {
      i2 = i1;
      i1 = k;
    } else if (w[k] > w[i2]) i2 = k;
  }
  return [i1, i2];
}

/**
 * Height-aware blend of the two strongest classes: the share of class 2 in their combined weight.
 * With detail (fade → 1) the higher texel wins inside a narrow band (grass between stones, snow in
 * hollows); without detail (fade → 0, far away) it reverts to the plain linear share.
 */
export function heightBlend(a1: number, h1: number, a2: number, h2: number, fade: number): number {
  const s = a1 + a2;
  if (s <= 1e-6) return 0;
  const lin = a2 / s;
  const k = 0.6;
  const depth = 0.18;
  const x1 = (1 - lin) + h1 * k;
  const x2 = lin + h2 * k;
  const m = Math.max(x1, x2) - depth;
  const b1 = Math.max(x1 - m, 0);
  const b2 = Math.max(x2 - m, 0);
  const hb = b2 / (b1 + b2);
  // never show class 2 where it has no weight at all (and class 1 likewise)
  const guard = sstep(0, 0.12, lin) * (1 - sstep(0.88, 1, lin));
  const hbg = lin + (hb - lin) * guard;
  const f = sat(fade);
  return lin + (hbg - lin) * f;
}

export const BLEND_GLSL = /* glsl */ `
// ── twin of src/world/terrain/blend.ts ──
void classWeights( vec4 lc0, vec4 lc1, float slope, float nb, float nb2, float nSnow, float streak, float height, out float w[8] ) {
  float wForest = tSat( ( lc0.x - 0.5 + nb * 0.55 ) * 3.5 + 0.5 ) * smoothstep( 0.0, 0.1, lc0.x );
  float wRockBase = max( tSat( ( lc0.w - 0.5 + nb2 * 0.5 ) * 3.0 + 0.5 ) * smoothstep( 0.0, 0.1, lc0.w ), smoothstep( 0.24, 0.4, slope + nb * 0.06 ) * 0.9 );
  float steepOff = 1.0 - smoothstep( 0.34 + 0.12 * streak, 0.5 + 0.12 * streak, slope );
  float wSnow = tSat( ( lc1.x - 0.5 + nb2 * 0.6 + nSnow * 0.35 + ( streak - 0.5 ) * 0.5 * smoothstep( 0.08, 0.3, slope ) ) * 3.0 + 0.5 ) * steepOff * smoothstep( 0.0, 0.12, lc1.x );
  float wSand = tSat( ( lc1.y - 0.5 + nb * 0.4 ) * 3.0 + 0.5 ) * smoothstep( 0.0, 0.1, lc1.y );
  float wUrban = tSat( ( lc1.z - 0.5 + nb2 * 0.5 ) * 2.5 + 0.5 ) * smoothstep( 0.0, 0.1, lc1.z );
  float rem = 1.0;
  float aS = wSnow * rem; rem -= aS;
  float aR = wRockBase * rem; rem -= aR;
  float aU = wUrban * rem; rem -= aU;
  float aD = wSand * rem; rem -= aD;
  float aF = wForest * rem; rem -= aF;
  float fg = lc0.y + lc0.z + 1e-4;
  float aC = rem * lc0.y / fg;
  float aG = rem - aC;
  float screeFrac = smoothstep( 900.0, 1400.0, height ) * ( 1.0 - smoothstep( 0.26, 0.42, slope + nb * 0.1 ) ) * smoothstep( 0.02, 0.12, slope );
  w[ 0 ] = aC; w[ 1 ] = aG; w[ 2 ] = aF; w[ 3 ] = aR * ( 1.0 - screeFrac ); w[ 4 ] = aR * screeFrac;
  w[ 5 ] = aS; w[ 6 ] = aD; w[ 7 ] = aU;
}
// The three strongest classes and their weights (wA: classes 0–3, wB: 4–7); i1, i2 as topTwo (same
// tie-breaking). Plain vectors, no arrays: a local array that is indexed dynamically or passed
// between functions ends up in memory on some GPUs (Apple: ~5 ms a frame over farmland at 1440×900).
void rankClasses( vec4 wA, vec4 wB, out int i1, out int i2, out int i3, out float w1, out float w2, out float w3 ) {
  i1 = 0; i2 = 1; i3 = 2;
  w1 = wA.x; w2 = wA.y; w3 = -1.0;
  if ( wA.y > wA.x ) { i1 = 1; i2 = 0; w1 = wA.y; w2 = wA.x; }
#define T_RANK( K, X ) { float x = X; if ( x > w1 ) { i3 = i2; w3 = w2; i2 = i1; w2 = w1; i1 = K; w1 = x; } else if ( x > w2 ) { i3 = i2; w3 = w2; i2 = K; w2 = x; } else if ( x > w3 ) { i3 = K; w3 = x; } }
  T_RANK( 2, wA.z ) T_RANK( 3, wA.w ) T_RANK( 4, wB.x ) T_RANK( 5, wB.y ) T_RANK( 6, wB.z ) T_RANK( 7, wB.w )
#undef T_RANK
}
void topTwo( float w[8], out int i1, out int i2 ) {
  int i3; float w1; float w2; float w3;
  rankClasses( vec4( w[ 0 ], w[ 1 ], w[ 2 ], w[ 3 ] ), vec4( w[ 4 ], w[ 5 ], w[ 6 ], w[ 7 ] ), i1, i2, i3, w1, w2, w3 );
}
float heightBlend( float a1, float h1, float a2, float h2, float fade ) {
  float s = a1 + a2;
  if ( s <= 1e-6 ) return 0.0;
  float lin = a2 / s;
  float x1 = ( 1.0 - lin ) + h1 * 0.6;
  float x2 = lin + h2 * 0.6;
  float m = max( x1, x2 ) - 0.18;
  float b1 = max( x1 - m, 0.0 );
  float b2 = max( x2 - m, 0.0 );
  float hb = b2 / ( b1 + b2 );
  float guard = smoothstep( 0.0, 0.12, lin ) * ( 1.0 - smoothstep( 0.88, 1.0, lin ) );
  float hbg = lin + ( hb - lin ) * guard;
  return lin + ( hbg - lin ) * tSat( fade );
}
`;
