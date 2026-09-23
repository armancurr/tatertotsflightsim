/**
 * The farm-field model shared by the CPU (landcover: woodlots, hedgerow trees
 * for wave 2) and the terrain shader (field colours, rows, margins): the same
 * integer hash (PCG) and value noise in TypeScript and GLSL, so both agree on
 * which field is where (up to float32 rounding within centimetres of an edge).
 *
 * Farmland is split into ~1.5 km "districts" (warped boundaries) with their
 * own grid orientation; each district is a grid of 240–470 m × 170–320 m
 * blocks, each block split into 1–4 strips = fields. Every field gets a crop
 * kind, a woodlot flag and every block a margin kind (hedge / grass strip / track).
 */

export const FIELD_KINDS = ['cereal-green', 'row-crop', 'wheat', 'stubble', 'ploughed', 'ploughed-dark', 'grass-ley', 'rapeseed', 'fallow', 'hay'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];
/**
 * Upper bounds of the crop-kind hash ranges, for a fully pastoral and a fully arable
 * district (districts interpolate between the two; same numbers in the GLSL).
 */
export const FIELD_KIND_EDGES_PASTORAL = [0.12, 0.16, 0.22, 0.24, 0.28, 0.3, 0.78, 0.79, 0.88, 1.0];
export const FIELD_KIND_EDGES_ARABLE = [0.22, 0.34, 0.52, 0.57, 0.67, 0.74, 0.88, 0.905, 0.96, 1.0];
export const WOODLOT_CHANCE = 0.075;
export const FARMSTEAD_CHANCE = 0.05;
/** Chance that a strip is cut across its length into two fields, and that a strip merges with its block. */
export const CUT_CHANCE = 0.4;
export const MERGE_CHANCE = 0.38;

export interface FieldInfo {
  /** Stable 32-bit id of the field. */
  id: number;
  kind: FieldKind;
  /** 0..1 hashes: crop kind selector, shade within the kind. */
  kindHash: number;
  shade: number;
  woodlot: boolean;
  /** Distance to the nearest field boundary, m (block edge, strip edge, cut line or district edge). */
  dEdge: number;
  /** Distance to the nearest block edge (where hedges/tracks run), m. */
  dBlock: number;
  /** Approximate distance to the district boundary (a farm track runs along it), m. */
  dDistrict: number;
  /** What runs along this block's edges. */
  margin: 'hedge' | 'grass' | 'track';
  /** Inside a farmstead yard (a few farm buildings at a block corner). */
  farmstead: boolean;
  /** Direction of the tractor rows (unit x, z) and the across-rows coordinate, m. */
  rowDirX: number;
  rowDirZ: number;
  across: number;
  /** Along-rows coordinate, m, and the distance to the field's row ends (headlands), m. */
  along: number;
  dEnds: number;
  /** 1 in the far part of a strip that is cut across (a separate field), else 0. */
  sub: number;
  /** The strip shares one crop with the other merged strips of its block (one bigger field). */
  merged: boolean;
  /** District id and its arable share (0 pastoral … 1 arable). */
  district: number;
  arable: number;
}

export function newFieldInfo(): FieldInfo {
  return {
    id: 0,
    kind: 'cereal-green',
    kindHash: 0,
    shade: 0,
    woodlot: false,
    dEdge: 0,
    dBlock: 0,
    dDistrict: 0,
    margin: 'grass',
    farmstead: false,
    rowDirX: 1,
    rowDirZ: 0,
    across: 0,
    along: 0,
    dEnds: 0,
    sub: 0,
    merged: false,
    district: 0,
    arable: 0,
  };
}

function pcg(v: number): number {
  const s = (Math.imul(v >>> 0, 747796405) + 2891336453) >>> 0;
  const w = Math.imul(((s >>> ((s >>> 28) + 4)) ^ s) >>> 0, 277803737) >>> 0;
  return ((w >>> 22) ^ w) >>> 0;
}

/** Hash of an integer lattice point → [0, 1] (GLSL: tHash). */
export function pcgHash(ix: number, iy: number): number {
  return pcg(((ix | 0) + pcg(iy | 0)) >>> 0) / 4294967295;
}

/** Smooth value noise in [0, 1] (GLSL: tNoise). */
export function valueNoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx);
  const uy = fy * fy * (3 - 2 * fy);
  const a = pcgHash(ix, iy);
  const b = pcgHash(ix + 1, iy);
  const c = pcgHash(ix, iy + 1);
  const d = pcgHash(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

const sstep = (e0: number, e1: number, x: number): number => {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
};

/** Is strip `si` of block (cx, cz) merged with its block at long-axis position `lc`? */
function stripMerged(cx: number, cz: number, si: number, alongX: boolean, dcx: number, dcz: number, lc: number): boolean {
  const kx = cx * 4 + si + dcx * 131;
  const kz = cz * 4 + (alongX ? 2 : 0) + dcz * 131;
  if (pcgHash(kx + 31, kz + 31) >= MERGE_CHANCE) return false;
  const cut = pcgHash(kx + 23, kz + 23) < CUT_CHANCE;
  return !(cut && lc > 0.28 + 0.44 * pcgHash(kx + 29, kz + 29));
}

/** The field at world x, z. Writes into `out`. */
export function fieldAt(x: number, z: number, out: FieldInfo): FieldInfo {
  // district with warped boundaries and its own grid orientation
  const wx = x + 160 * (valueNoise(x * 0.0009, z * 0.0009) - 0.5);
  const wz = z + 160 * (valueNoise(x * 0.0009 + 17.3, z * 0.0009 + 17.3) - 0.5);
  const dcx = Math.floor(wx / 1500);
  const dcz = Math.floor(wz / 1500);
  const ang = (pcgHash(dcx + 91, dcz + 91) - 0.5) * 0.8;
  const cs = Math.cos(ang);
  const sn = Math.sin(ang);
  let qx = cs * x + sn * z;
  let qz = -sn * x + cs * z;
  qx += 14 * (valueNoise(x * 0.0045, z * 0.0045) - 0.5);
  qz += 14 * (valueNoise(x * 0.0045 + 9.1, z * 0.0045 + 9.1) - 0.5);
  const hs = pcgHash(dcx + 3, dcz + 3);
  const csx = 240 + (470 - 240) * hs;
  const csz = 170 + (320 - 170) * hs;
  const gx = qx / csx;
  const gz = qz / csz;
  const cx = Math.floor(gx);
  const cz = Math.floor(gz);
  const fx = gx - cx;
  const fz = gz - cz;
  const h1 = pcgHash(cx + dcx * 57, cz + dcz * 57);
  const nStrips = 1 + Math.floor(h1 * 3.3);
  const alongX = pcgHash(cx + dcx * 13 + 7, cz + dcz * 13 + 7) >= 0.5;
  const coord = alongX ? fx : fz;
  const si = Math.floor(coord * nStrips);
  const sfr = coord * nStrips - si;
  const kx = cx * 4 + si + dcx * 131;
  const kz = cz * 4 + (alongX ? 2 : 0) + dcz * 131;
  out.woodlot = pcgHash(kx + 11, kz + 11) < WOODLOT_CHANCE;
  // sub-structure: a strip may be cut across its length (two fields) or merged with its block
  const lc = alongX ? fz : fx; // position along the strip's long axis
  const longLen = alongX ? csz : csx;
  const cut = pcgHash(kx + 23, kz + 23) < CUT_CHANCE;
  const cutT = 0.28 + 0.44 * pcgHash(kx + 29, kz + 29);
  const sub = cut && lc > cutT ? 1 : 0;
  const merged = sub === 0 && pcgHash(kx + 31, kz + 31) < MERGE_CHANCE;
  const ax = merged ? (cx + dcx * 131) * 8 + 5 : sub === 1 ? kx + 7777 : kx;
  const az = merged ? (cz + dcz * 131) * 8 + 5 : sub === 1 ? kz - 3333 : kz;
  const fh = pcgHash(ax, az);
  out.id = pcg(((ax | 0) + pcg(az | 0)) >>> 0);
  out.kindHash = fh;
  out.shade = pcgHash(ax + 5, az + 5);
  out.sub = sub;
  out.merged = merged;
  out.district = pcg(((dcx | 0) + pcg((dcz + 7) | 0)) >>> 0);
  const ar = sstep(0.2, 0.8, pcgHash(dcx + 61, dcz + 61));
  out.arable = ar;
  let k = 0;
  while (k < FIELD_KINDS.length - 1 && fh >= FIELD_KIND_EDGES_PASTORAL[k] + (FIELD_KIND_EDGES_ARABLE[k] - FIELD_KIND_EDGES_PASTORAL[k]) * ar) k++;
  out.kind = FIELD_KINDS[k];
  const dBlockRaw = Math.min(Math.min(fx, 1 - fx) * csx, Math.min(fz, 1 - fz) * csz);
  const stripLen = (alongX ? csx : csz) / nStrips;
  // a strip boundary is a field edge unless both strips there are merged with the block
  const leftEdge = si > 0 && !(merged && stripMerged(cx, cz, si - 1, alongX, dcx, dcz, lc));
  const rightEdge = si < nStrips - 1 && !(merged && stripMerged(cx, cz, si + 1, alongX, dcx, dcz, lc));
  const dStrip = Math.min(leftEdge ? sfr * stripLen : Infinity, rightEdge ? (1 - sfr) * stripLen : Infinity);
  const dCut = cut ? Math.abs(lc - cutT) * longLen : Infinity;
  // distance to the district boundary, measured in the warped frame (the warp stretches ≤ ~25 %)
  const ux = wx / 1500 - dcx;
  const uz = wz / 1500 - dcz;
  const dDistrict = Math.min(Math.min(ux, 1 - ux), Math.min(uz, 1 - uz)) * 1500 * 0.75;
  out.dDistrict = dDistrict;
  out.dBlock = Math.min(dBlockRaw, dDistrict);
  out.dEdge = Math.min(out.dBlock, dStrip, dCut);
  const mk = pcgHash(cx + dcx * 3 + 11, cz + dcz * 3 + 11);
  out.margin = mk < 0.45 ? 'hedge' : mk < 0.8 ? 'grass' : 'track';
  out.farmstead = pcgHash(cx + dcx * 29 + 2, cz + dcz * 29 + 2) < FARMSTEAD_CHANCE && fx > 0.04 && fx < 0.04 + 45 / csx && fz > 0.04 && fz < 0.04 + 38 / csz;
  // rows run along the strip's long axis; `across` counts metres across them
  out.rowDirX = alongX ? -sn : cs;
  out.rowDirZ = alongX ? cs : sn;
  out.across = alongX ? qx : qz;
  out.along = alongX ? qz : qx;
  // headlands: the ends of the field along the rows (block ends or the cut line)
  const lo = sub === 1 ? cutT : 0;
  const hi = cut && sub === 0 ? cutT : 1;
  out.dEnds = Math.min(lc - lo, hi - lc) * longLen;
  return out;
}

/**
 * GLSL twin of fieldAt (needs tHash/tNoise from the terrain shader). Fills the
 * same quantities for the fragment shader.
 */
export const FIELD_GLSL = /* glsl */ `
const float F_EP[10] = float[10]( ${FIELD_KIND_EDGES_PASTORAL.map((v) => v.toFixed(3)).join(', ')} );
const float F_EA[10] = float[10]( ${FIELD_KIND_EDGES_ARABLE.map((v) => v.toFixed(3)).join(', ')} );
struct Field {
  float kind;     // index into FIELD_KINDS
  float fh;       // kind selector hash
  float shade;
  float woodlot;  // 0 / 1
  float dEdge;    // m
  float dBlock;   // m
  float dDistrict; // m
  float margin;   // 0 hedge, 1 grass, 2 track
  float across;   // m across the rows
  float along;    // m along the rows
  float dEnds;    // m to the row ends (headlands)
  float arable;   // district arable share
  float key;      // per-field hash for detail variation
  vec2 rowDir;    // world xz direction of the rows (the "along" axis)
  vec2 acrossDir; // world xz direction of the "across" axis
};
bool fStripMerged( vec2 c, float si, float alongX, vec2 dc, float lc ) {
  vec2 k = vec2( c.x * 4.0 + si, c.y * 4.0 + alongX * 2.0 ) + dc * 131.0;
  if ( tHash( k + 31.0 ) >= ${MERGE_CHANCE} ) return false;
  bool cut = tHash( k + 23.0 ) < ${CUT_CHANCE};
  return !( cut && lc > 0.28 + 0.44 * tHash( k + 29.0 ) );
}
// p: world xz; warp: (160-m district warp, 14-m field warp) evaluated per vertex
Field fieldAt( vec2 p, vec4 warp ) {
  Field F;
  vec2 wp = p + warp.xy;
  vec2 dc = floor( wp / 1500.0 );
  float ang = ( tHash( dc + 91.0 ) - 0.5 ) * 0.8;
  float cs = cos( ang );
  float sn = sin( ang );
  vec2 q = vec2( cs * p.x + sn * p.y, -sn * p.x + cs * p.y ) + warp.zw;
  float hs = tHash( dc + 3.0 );
  vec2 cellSize = vec2( 240.0 + 230.0 * hs, 170.0 + 150.0 * hs );
  vec2 g = q / cellSize;
  vec2 c = floor( g );
  vec2 f = g - c;
  float nStrips = 1.0 + floor( tHash( c + dc * 57.0 ) * 3.3 );
  float alongX = step( 0.5, tHash( c + dc * 13.0 + 7.0 ) );
  float coord = mix( f.y, f.x, alongX );
  float si = floor( coord * nStrips );
  float sfr = coord * nStrips - si;
  vec2 k = vec2( c.x * 4.0 + si, c.y * 4.0 + alongX * 2.0 ) + dc * 131.0;
  F.woodlot = step( tHash( k + 11.0 ), ${WOODLOT_CHANCE} );
  float lc = mix( f.x, f.y, alongX );
  float longLen = mix( cellSize.x, cellSize.y, alongX );
  bool cut = tHash( k + 23.0 ) < ${CUT_CHANCE};
  float cutT = 0.28 + 0.44 * tHash( k + 29.0 );
  float sub = ( cut && lc > cutT ) ? 1.0 : 0.0;
  bool merged = sub == 0.0 && tHash( k + 31.0 ) < ${MERGE_CHANCE};
  vec2 a = merged ? ( c + dc * 131.0 ) * 8.0 + 5.0 : ( sub == 1.0 ? k + vec2( 7777.0, -3333.0 ) : k );
  F.fh = tHash( a );
  F.shade = tHash( a + 5.0 );
  F.key = tHash( a + 13.0 );
  float ar = smoothstep( 0.2, 0.8, tHash( dc + 61.0 ) );
  F.arable = ar;
  float kind = 0.0;
  for ( int i = 0; i < 9; i++ ) if ( F.fh >= mix( F_EP[ i ], F_EA[ i ], ar ) ) kind = float( i + 1 );
  F.kind = kind;
  vec2 dB = min( f, 1.0 - f ) * cellSize;
  float stripLen = mix( cellSize.y, cellSize.x, alongX ) / nStrips;
  bool leftEdge = si > 0.0 && !( merged && fStripMerged( c, si - 1.0, alongX, dc, lc ) );
  bool rightEdge = si < nStrips - 1.0 && !( merged && fStripMerged( c, si + 1.0, alongX, dc, lc ) );
  float dStrip = min( leftEdge ? sfr * stripLen : 1e5, rightEdge ? ( 1.0 - sfr ) * stripLen : 1e5 );
  float dCut = cut ? abs( lc - cutT ) * longLen : 1e5;
  vec2 ud = wp / 1500.0 - dc;
  vec2 dd = min( ud, 1.0 - ud );
  F.dDistrict = min( dd.x, dd.y ) * 1500.0 * 0.75;
  F.dBlock = min( min( dB.x, dB.y ), F.dDistrict );
  F.dEdge = min( F.dBlock, min( dStrip, dCut ) );
  float mk = tHash( c + dc * 3.0 + 11.0 );
  F.margin = mk < 0.45 ? 0.0 : mk < 0.8 ? 1.0 : 2.0;
  F.across = mix( q.y, q.x, alongX );
  F.along = mix( q.x, q.y, alongX );
  F.rowDir = alongX > 0.5 ? vec2( -sn, cs ) : vec2( cs, sn );
  F.acrossDir = alongX > 0.5 ? vec2( cs, sn ) : vec2( -sn, cs );
  float lo = sub == 1.0 ? cutT : 0.0;
  float hi = ( cut && sub == 0.0 ) ? cutT : 1.0;
  F.dEnds = min( lc - lo, hi - lc ) * longLen;
  return F;
}
`;
