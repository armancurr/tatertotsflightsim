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

export const FIELD_KINDS = ['cereal-green', 'row-crop', 'wheat', 'stubble', 'ploughed', 'grass-ley', 'rapeseed', 'fallow'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];
/** Upper bounds of the crop-kind hash ranges (same numbers in the GLSL). */
export const FIELD_KIND_EDGES = [0.28, 0.39, 0.53, 0.6, 0.72, 0.93, 0.96, 1.0];
export const WOODLOT_CHANCE = 0.075;
export const FARMSTEAD_CHANCE = 0.05;

export interface FieldInfo {
  /** Stable 32-bit id of the field. */
  id: number;
  kind: FieldKind;
  /** 0..1 hashes: crop kind selector, shade within the kind. */
  kindHash: number;
  shade: number;
  woodlot: boolean;
  /** Distance to the nearest field boundary, m (block edge or strip edge). */
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
}

export function newFieldInfo(): FieldInfo {
  return { id: 0, kind: 'cereal-green', kindHash: 0, shade: 0, woodlot: false, dEdge: 0, dBlock: 0, dDistrict: 0, margin: 'grass', farmstead: false, rowDirX: 1, rowDirZ: 0, across: 0 };
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
  const fidx = cx * 4 + si;
  const fidz = cz * 4 + (alongX ? 2 : 0);
  const kx = fidx + dcx * 131;
  const kz = fidz + dcz * 131;
  const fh = pcgHash(kx, kz);
  out.id = pcg(((kx | 0) + pcg(kz | 0)) >>> 0);
  out.kindHash = fh;
  out.shade = pcgHash(kx + 5, kz + 5);
  out.woodlot = pcgHash(kx + 11, kz + 11) < WOODLOT_CHANCE;
  let k = 0;
  while (k < FIELD_KIND_EDGES.length - 1 && fh >= FIELD_KIND_EDGES[k]) k++;
  out.kind = FIELD_KINDS[k];
  const dBlock = Math.min(Math.min(fx, 1 - fx) * csx, Math.min(fz, 1 - fz) * csz);
  const stripLen = (alongX ? csx : csz) / nStrips;
  const dStrip = Math.min(sfr, 1 - sfr) * stripLen;
  // distance to the district boundary, measured in the warped frame (the warp stretches ≤ ~25 %)
  const ux = wx / 1500 - dcx;
  const uz = wz / 1500 - dcz;
  const dDistrict = Math.min(Math.min(ux, 1 - ux), Math.min(uz, 1 - uz)) * 1500 * 0.75;
  out.dDistrict = dDistrict;
  out.dBlock = Math.min(dBlock, dDistrict);
  out.dEdge = Math.min(dBlock, dStrip, dDistrict);
  const mk = pcgHash(cx + dcx * 3 + 11, cz + dcz * 3 + 11);
  out.margin = mk < 0.45 ? 'hedge' : mk < 0.8 ? 'grass' : 'track';
  out.farmstead = pcgHash(cx + dcx * 29 + 2, cz + dcz * 29 + 2) < FARMSTEAD_CHANCE && fx > 0.04 && fx < 0.04 + 45 / csx && fz > 0.04 && fz < 0.04 + 38 / csz;
  // rows run along the strip's long axis; `across` counts metres across them
  out.rowDirX = alongX ? -sn : cs;
  out.rowDirZ = alongX ? cs : sn;
  out.across = alongX ? qx : qz;
  return out;
}

/**
 * GLSL twin of fieldAt (needs tHash/tNoise from the terrain shader). Fills the
 * same quantities for the fragment shader.
 */
export const FIELD_GLSL = /* glsl */ `
struct Field {
  float fh;       // kind selector
  float shade;
  float woodlot;  // 0 / 1
  float dEdge;    // m
  float dBlock;   // m
  float dStrip;   // m
  float dDistrict; // m
  float margin;   // 0 hedge, 1 grass, 2 track
  float farm;     // 0 / 1 farmstead yard
  vec2 farmUv;    // position inside the farmstead yard (m)
  float across;   // m across the rows
};
Field fieldAt( vec2 p ) {
  Field F;
  vec2 wp = p + 160.0 * ( vec2( tNoise( p * 0.0009 ), tNoise( p * 0.0009 + 17.3 ) ) - 0.5 );
  vec2 dc = floor( wp / 1500.0 );
  float ang = ( tHash( dc + 91.0 ) - 0.5 ) * 0.8;
  float cs = cos( ang );
  float sn = sin( ang );
  vec2 q = vec2( cs * p.x + sn * p.y, -sn * p.x + cs * p.y );
  q += 14.0 * ( vec2( tNoise( p * 0.0045 ), tNoise( p * 0.0045 + 9.1 ) ) - 0.5 );
  float hs = tHash( dc + 3.0 );
  vec2 cellSize = vec2( 240.0 + 230.0 * hs, 170.0 + 150.0 * hs );
  vec2 g = q / cellSize;
  vec2 c = floor( g );
  vec2 f = g - c;
  float h1 = tHash( c + dc * 57.0 );
  float nStrips = 1.0 + floor( h1 * 3.3 );
  float alongX = step( 0.5, tHash( c + dc * 13.0 + 7.0 ) );
  float coord = mix( f.y, f.x, alongX );
  float si = floor( coord * nStrips );
  float sfr = coord * nStrips - si;
  vec2 k = vec2( c.x * 4.0 + si, c.y * 4.0 + alongX * 2.0 ) + dc * 131.0;
  F.fh = tHash( k );
  F.shade = tHash( k + 5.0 );
  F.woodlot = step( tHash( k + 11.0 ), ${WOODLOT_CHANCE} );
  vec2 ud = wp / 1500.0 - dc;
  vec2 dd = min( ud, 1.0 - ud );
  F.dDistrict = min( dd.x, dd.y ) * 1500.0 * 0.75;
  vec2 dB = min( f, 1.0 - f ) * cellSize;
  F.dBlock = min( min( dB.x, dB.y ), F.dDistrict );
  float stripLen = mix( cellSize.y, cellSize.x, alongX ) / nStrips;
  F.dStrip = min( sfr, 1.0 - sfr ) * stripLen;
  F.dEdge = min( F.dBlock, F.dStrip );
  float mk = tHash( c + dc * 3.0 + 11.0 );
  F.margin = mk < 0.45 ? 0.0 : mk < 0.8 ? 1.0 : 2.0;
  vec2 fy = ( f - 0.04 ) * cellSize;
  F.farm = step( tHash( c + dc * 29.0 + 2.0 ), ${FARMSTEAD_CHANCE} ) * step( 0.0, fy.x ) * step( fy.x, 45.0 ) * step( 0.0, fy.y ) * step( fy.y, 38.0 );
  F.farmUv = fy;
  F.across = mix( q.y, q.x, alongX );
  return F;
}
`;
