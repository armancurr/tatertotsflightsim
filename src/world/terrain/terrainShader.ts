/**
 * GLSL for the terrain material (injected into MeshStandardMaterial by
 * material.ts). Scales from a mown airfield seen from 2 m to farmland from
 * 10,000 ft:
 *
 * - Close up: procedurally generated detail textures (detailTextures.ts; an
 *   array texture of grass, crop leaves, soil, gravel, rock, sand, snow and
 *   straw) sampled with hex tiling (random offsets per hex cell — no visible
 *   repetition) at two scales, with detail normals and cavity; the two
 *   strongest surface classes are blended by their texel heights (blend.ts).
 * - Mid range: fields from the shared field model (fields.ts: same hashes as
 *   the CPU, so hedgerow/woodlot trees line up) with crop rows, tramlines,
 *   headlands, furrows, windrows, margins and tracks; urban plot mosaics on
 *   each town's own street grid; warped rock strata, fall-line streaks, scree,
 *   snow that follows slope and gullies.
 * - Far: macro colour variation at 1–30 km (per vertex) so nothing tiles.
 *
 * Noise comes from a small tileable noise texture (textureGrad with gradients
 * taken in uniform control flow) instead of per-pixel hashing; the field model
 * keeps its integer hashes (it must agree with the CPU). Colours are linear
 * albedos in natural ranges (vegetation 0.03–0.15, ripe cereals ~0.3, snow ~0.8).
 */
import { FIELD_GLSL } from '../fields';
import { BLEND_GLSL } from './blend';
import { DETAIL_TILE_M } from './detailTextures';

export const MAX_TOWNS = 32;

const f = (v: number) => (Number.isInteger(v) ? `${v}.0` : `${v}`);

// Shared by both stages: integer hashing (twin of fields.ts pcgHash / valueNoise).
const HASH_GLSL = /* glsl */ `
uint tPcg( uint v ) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ( ( s >> ( ( s >> 28u ) + 4u ) ) ^ s ) * 277803737u;
  return ( w >> 22u ) ^ w;
}
float tHash( vec2 p ) {
  ivec2 i = ivec2( p );
  return float( tPcg( uint( i.x ) + tPcg( uint( i.y ) ) ) ) * ( 1.0 / 4294967295.0 );
}
float tNoiseH( vec2 p ) {
  vec2 i = floor( p );
  vec2 fr = p - i;
  vec2 u = fr * fr * ( 3.0 - 2.0 * fr );
  float a = tHash( i );
  float b = tHash( i + vec2( 1.0, 0.0 ) );
  float c = tHash( i + vec2( 0.0, 1.0 ) );
  float d = tHash( i + vec2( 1.0, 1.0 ) );
  return a + ( b - a ) * u.x + ( c - a ) * u.y + ( a - b - c + d ) * u.x * u.y;
}
float tSat( float x ) { return clamp( x, 0.0, 1.0 ); }
`;

export const TERRAIN_VERTEX_PARS = /* glsl */ `
attribute vec4 lc0;      // forest, field, grass, rock
attribute vec4 lc1;      // snow, sand, urban, water
attribute vec4 lcp0;     // the same on the parent LOD grid (morph target)
attribute vec4 lcp1;
attribute vec3 aMorph;   // dy to the parent LOD surface, water level, tile size
uniform float uSplit;
uniform sampler2D uNoise;
varying vec3 vWPos;
varying vec4 vLc0;
varying vec4 vLc1;
varying float vWaterLevel;
varying vec3 vWNormal;
varying vec4 vWarp;      // field-model domain warp (160-m district warp xy, 14-m field warp zw)
varying vec4 vMacro;     // macro variation at 1.1, 4.2, 9 and 26 km
${HASH_GLSL}
`;

export const TERRAIN_BEGIN_VERTEX = /* glsl */ `
vec3 transformed = vec3( position );
{
  // CDLOD-style geomorph: vertices (and their landcover) slide onto the parent tile's surface
  // as they approach the distance where the parent takes over, so LOD switches don't pop.
  vec3 wp0 = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
  float mEnd = 2.0 * aMorph.z * uSplit;
  float m = smoothstep( mEnd * 0.72, mEnd, distance( wp0, cameraPosition ) );
  transformed.y += aMorph.x * m;
  vLc0 = mix( lc0, lcp0, m );
  vLc1 = mix( lc1, lcp1, m );
  vec2 p = wp0.xz;
  vWarp = vec4( 160.0 * ( tNoiseH( p * 0.0009 ) - 0.5 ), 160.0 * ( tNoiseH( p * 0.0009 + 17.3 ) - 0.5 ),
                14.0 * ( tNoiseH( p * 0.0045 ) - 0.5 ), 14.0 * ( tNoiseH( p * 0.0045 + 9.1 ) - 0.5 ) );
  vMacro = vec4( textureLod( uNoise, p / ( 1100.0 * 32.0 ), 0.0 ).r, textureLod( uNoise, p / ( 4200.0 * 32.0 ) + 0.37, 0.0 ).g,
                 textureLod( uNoise, p / ( 9000.0 * 16.0 ) + 0.61, 0.0 ).b, textureLod( uNoise, p / ( 26000.0 * 32.0 ) + 0.13, 0.0 ).r );
}
`;

export const TERRAIN_WORLDPOS_VERTEX = /* glsl */ `
vWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vWaterLevel = aMorph.y;
vWNormal = normalize( mat3( modelMatrix ) * objectNormal );
`;

const DET_TILES = `const float DET_TILE[8] = float[8]( ${DETAIL_TILE_M.map(f).join(', ')} );`;

export const TERRAIN_FRAGMENT_PARS = /* glsl */ `
varying vec3 vWPos;
varying vec4 vLc0;
varying vec4 vLc1;
varying float vWaterLevel;
varying vec3 vWNormal;
varying vec4 vWarp;
varying vec4 vMacro;
uniform float uTime;
uniform vec4 uPavedA[8];   // centre x, centre z, half length, half width
uniform vec4 uPavedB[8];   // forward x, forward z, kind (0 runway, 1 taxiway/apron), unused
uniform int uPavedCount;
uniform vec4 uAirport;     // centre x, centre z, flat radius, runway heading (rad)
uniform vec4 uRunway;      // threshold (36) x, z, length, 0
uniform vec4 uTownA[${MAX_TOWNS}]; // x, z, radius, grid angle (rad)
uniform vec4 uTownB[${MAX_TOWNS}]; // block size, density, 0, 0
uniform int uTownCount;
uniform sampler2D uNoise;
uniform highp sampler2DArray uDetA;
uniform highp sampler2DArray uDetN;
uniform float uDetail;     // 0 until the detail textures are generated, then 1

${HASH_GLSL}
${DET_TILES}
const float L_GRASS = 0.0;
const float L_CROP = 1.0;
const float L_SOIL = 2.0;
const float L_GRAVEL = 3.0;
const float L_ROCK = 4.0;
const float L_SAND = 5.0;
const float L_SNOW = 6.0;
const float L_STRAW = 7.0;

float tBump;          // procedural bump height (m), used by the normal chunk
float tBumpScale;
vec2 tDetN;           // detail normal perturbation (world x, z)
vec2 gDx;             // screen derivatives of world xz (taken in uniform control flow)
vec2 gDy;
float gFw;            // pixel footprint, m (max axis)
float gFwD;           // footprint for detail fades (geometric mean of the axes)

// Tileable texture noise: one lattice unit = 1 in p (like tNoiseH), four channels.
vec4 tN4( vec2 p ) { return textureGrad( uNoise, p * ( 1.0 / 32.0 ), gDx * ( 1.0 / 32.0 ), gDy * ( 1.0 / 32.0 ) ); }
// p in metres, s = feature size in metres
float tN( vec2 p, float s ) { return textureGrad( uNoise, p / ( s * 32.0 ), gDx / ( s * 32.0 ), gDy / ( s * 32.0 ) ).r; }
float tNg( vec2 p, float s ) { return textureGrad( uNoise, p / ( s * 32.0 ), gDx / ( s * 32.0 ), gDy / ( s * 32.0 ) ).g; }
float tFbmT( vec2 p, float s ) { return textureGrad( uNoise, p / ( s * 16.0 ), gDx / ( s * 16.0 ), gDy / ( s * 16.0 ) ).b; }
float tCellT( vec2 p, float s ) { return textureGrad( uNoise, p / ( s * 16.0 ), gDx / ( s * 16.0 ), gDy / ( s * 16.0 ) ).a; }

// Fraction of a pixel of footprint fw covered by a band of half-width w around distance d = 0.
float tBand( float d, float w, float fw ) {
  float c = 1.0 - smoothstep( w - 0.5 * fw, w + 0.5 * fw, d );
  return c * min( 1.0, 2.0 * w / max( fw, 1e-3 ) + 0.25 );
}
// Anti-aliased periodic stripe signal in [-1, 1] that fades to 0 once a period nears the pixel size.
float tStripes( float x, float period, float fw ) {
  return sin( x * 6.2831853 / period ) * ( 1.0 - smoothstep( period * 0.25, period * 0.7, fw ) );
}

${FIELD_GLSL}
${BLEND_GLSL}

// ── surface classes ───────────────────────────────────────────────────────────
struct Surf {
  vec3 col;
  float layer;   // detail layer
  float amt;     // detail strength
  float rough;
  float bump;    // procedural height, m
};
Surf tSurf( vec3 col, float layer, float amt, float rough, float bump ) {
  Surf s; s.col = col; s.layer = layer; s.amt = amt; s.rough = rough; s.bump = bump; return s;
}

// Cleared ground around the airfield and under the approach paths (twin of landcover.ts
// airportClear): no woodlots are drawn there (and no trees stand there).
float tAirportClear( vec2 p ) {
  float c = 1.0 - smoothstep( uAirport.z + 300.0, uAirport.z + 800.0, distance( p, uAirport.xy ) );
  vec2 dir = vec2( sin( uAirport.w ), -cos( uAirport.w ) );
  vec2 d = p - uRunway.xy;
  float along = dot( d, dir );
  float across = dot( d, vec2( -dir.y, dir.x ) );
  float past = along < 0.0 ? -along : max( along - uRunway.z, 0.0 );
  if ( past < 4000.0 ) {
    float halfW = 160.0 + 0.12 * past;
    c = max( c, ( 1.0 - smoothstep( halfW, halfW + 150.0, abs( across ) ) ) * ( 1.0 - smoothstep( 3500.0, 4000.0, past ) ) );
  }
  return c;
}

// Woodland. Near the camera the 3D trees stand on a dark forest floor; beyond them
// (a few km) the canopy itself is drawn: irregular crowns, gaps, species patches.
Surf tForest( vec3 wp ) {
  vec2 p = wp.xz;
  float sp = tFbmT( p, 260.0 );
  vec3 conifer = vec3( 0.016, 0.032, 0.017 );
  vec3 decid = vec3( 0.034, 0.062, 0.02 );
  vec3 canopy = mix( conifer, decid, smoothstep( 0.38, 0.62, sp ) );
  canopy *= 0.8 + 0.4 * tN( p, 38.0 );
  float far = smoothstep( 1800.0, 3200.0, distance( wp, cameraPosition ) );
  float bump = 0.0;
  float k = ( 1.0 - smoothstep( 1.5, 5.0, gFw ) ) * far;
  if ( k > 0.0 ) {
    float d = min( tCellT( p, 7.0 ), tCellT( p + 3.1, 4.3 ) * 1.1 );
    float crown = 1.0 - smoothstep( 0.2, 0.75, d );
    float tone = 0.8 + 0.4 * tN( p, 6.0 );
    canopy *= mix( 1.0, mix( 0.62, 1.15, crown ) * tone, k );
    bump = crown * 0.8 * k;
  }
  vec3 floorC = mix( vec3( 0.03, 0.034, 0.018 ), vec3( 0.05, 0.05, 0.028 ), tN( p, 5.0 ) );
  floorC = mix( floorC, canopy, 0.45 );
  vec3 col = mix( floorC, canopy, far );
  return tSurf( col, L_SOIL, 0.6 * ( 1.0 - far ), 0.97, bump );
}

// Grass: airfield, verges, pasture, rough grazing, alpine meadows.
Surf tGrass( vec2 p, float height ) {
  float n1 = tN( p, 70.0 );
  float n2 = tNg( p, 14.0 );
  vec3 col = mix( vec3( 0.058, 0.102, 0.025 ), vec3( 0.098, 0.142, 0.038 ), n1 );
  // drier, yellower patches and lush dark ones
  col = mix( col, vec3( 0.16, 0.15, 0.065 ), smoothstep( 0.6, 0.9, tFbmT( p, 420.0 ) ) * 0.5 );
  col *= 0.9 + 0.2 * n2;
  // alpine meadow: olive and straw tones, rocky speckles
  float alp = smoothstep( 1100.0, 1700.0, height );
  if ( alp > 0.0 ) {
    vec3 am = mix( vec3( 0.1, 0.11, 0.045 ), vec3( 0.15, 0.135, 0.07 ), tN( p, 160.0 ) );
    col = mix( col, am, alp );
    float st = ( 1.0 - smoothstep( 0.08, 0.3, tCellT( p, 9.0 ) ) ) * smoothstep( 0.45, 0.8, tN( p, 60.0 ) );
    col = mix( col, vec3( 0.22, 0.21, 0.19 ), st * alp * 0.8 );
  }
  // the airfield: mown stripes along the runway, more uniform, greener
  float dA = distance( p, uAirport.xy );
  if ( dA < uAirport.z + 400.0 ) {
    float inField = 1.0 - smoothstep( uAirport.z - 100.0, uAirport.z + 300.0, dA );
    vec2 fwd = vec2( sin( uAirport.w ), -cos( uAirport.w ) );
    float acr = dot( p - uAirport.xy, vec2( -fwd.y, fwd.x ) );
    float mow = tStripes( acr + 3.0 * ( tN( p, 90.0 ) - 0.5 ), 16.0, gFw );
    col = mix( col, vec3( 0.075, 0.125, 0.032 ) * ( 0.92 + 0.16 * n2 ), inField * 0.55 );
    col *= 1.0 + 0.085 * clamp( mow * 2.5, -1.0, 1.0 ) * inField;
  }
  return tSurf( col, L_GRASS, 1.0, 0.95, 0.0 );
}

// Farmland (the field model is shared with the CPU: fields.ts).
Surf tField( vec2 p ) {
  Field F = fieldAt( p, vWarp );
  if ( F.woodlot > 0.5 && tAirportClear( p ) < 0.5 ) return tForest( vWPos );
  int kind = int( F.kind + 0.5 );
  float sh = F.shade;
  vec3 col;
  float layer = L_CROP;
  float rowAmp = 0.0;    // brightness amplitude of the drill rows
  float rowP = 0.75;     // row spacing, m
  float tram = 0.0;      // tramline darkening
  float bump = 0.0;
  float rough = 0.95;
  vec3 soilC = vec3( 0.11, 0.075, 0.045 );
  // rows follow the field; in the headlands (ends of the field) they turn 90 degrees
  bool head = F.dEnds < 11.0 && kind != 6 && kind != 8;
  float rc = head ? F.along : F.across;
  if ( kind == 0 ) {            // green cereals (winter wheat / barley)
    col = mix( vec3( 0.034, 0.072, 0.024 ), vec3( 0.075, 0.118, 0.028 ), sh );
    rowAmp = 0.05; rowP = 0.25; tram = 0.35;
  } else if ( kind == 1 ) {     // maize / beet / potatoes in wide rows
    col = mix( vec3( 0.03, 0.064, 0.018 ), vec3( 0.048, 0.088, 0.024 ), sh );
    rowAmp = 0.0; rowP = 0.75;
    // soil shows between the rows (fades to the mean colour with distance)
    float r = 0.5 + 0.5 * tStripes( rc, rowP, gFw );
    float vis = 1.0 - smoothstep( 0.2, 0.6, gFw );
    float cover = mix( 0.62, 1.0, sh );
    col = mix( col, mix( soilC, col, cover ), vis * ( 1.0 - r ) * 0.9 );
    bump = r * 0.08 * vis;
  } else if ( kind == 2 ) {     // ripe wheat / barley
    col = mix( vec3( 0.27, 0.185, 0.06 ), vec3( 0.37, 0.265, 0.09 ), sh );
    layer = L_STRAW; rowAmp = 0.04; rowP = 0.25; tram = 0.4;
    // wind-combed waves in the crop
    col *= 0.94 + 0.12 * tN( p + vec2( uTime * 0.8, 0.0 ), 9.0 );
  } else if ( kind == 3 ) {     // stubble with straw swaths
    col = mix( vec3( 0.28, 0.225, 0.13 ), vec3( 0.35, 0.29, 0.17 ), sh );
    layer = L_STRAW; tram = 0.2;
    float sw = abs( fract( rc / 7.5 + F.key ) - 0.5 ) * 7.5;
    col *= 1.0 + 0.18 * tBand( sw, 0.7, gFw );
    rough = 1.0;
  } else if ( kind == 4 || kind == 5 ) { // ploughed / harrowed soil
    col = kind == 4 ? mix( vec3( 0.105, 0.07, 0.043 ), vec3( 0.15, 0.1, 0.06 ), sh ) : mix( vec3( 0.058, 0.043, 0.03 ), vec3( 0.082, 0.06, 0.04 ), sh );
    layer = L_SOIL; rough = 1.0;
    float fur = tStripes( rc, 0.4, gFw );
    col *= 1.0 + 0.16 * fur;
    bump = fur * 0.07;
    // passes of the plough: broad tone bands
    col *= 0.93 + 0.14 * tN( vec2( rc / 1.6, F.along / 40.0 ), 1.0 );
  } else if ( kind == 6 ) {     // grass ley / pasture
    col = mix( vec3( 0.06, 0.108, 0.028 ), vec3( 0.118, 0.158, 0.045 ), sh );
    col *= mix( vec3( 1.06, 1.0, 0.85 ), vec3( 0.94, 1.0, 1.12 ), F.key );
    layer = L_GRASS;
    // grazing: darker lush tussocks and trodden paths along the edges
    col *= 0.88 + 0.24 * tN( p, 6.0 );
    col = mix( col, vec3( 0.13, 0.12, 0.06 ), ( 1.0 - smoothstep( 1.0, 5.0, F.dEdge ) ) * 0.35 );
  } else if ( kind == 7 ) {     // oilseed rape in flower
    col = mix( vec3( 0.28, 0.245, 0.04 ), vec3( 0.35, 0.3, 0.055 ), sh );
    col = mix( col, vec3( 0.12, 0.14, 0.04 ), smoothstep( 0.55, 0.8, tFbmT( p, 25.0 ) ) * 0.45 ); // patchy flowering
    tram = 0.45;
  } else if ( kind == 8 ) {     // fallow: weeds, grass and bare patches
    float pn = tFbmT( p, 40.0 );
    col = mix( vec3( 0.075, 0.09, 0.035 ), vec3( 0.13, 0.1, 0.055 ), smoothstep( 0.35, 0.7, pn ) );
    layer = pn > 0.55 ? L_SOIL : L_GRASS;
  } else {                      // hay: cut grass in windrows
    col = mix( vec3( 0.12, 0.14, 0.05 ), vec3( 0.16, 0.16, 0.07 ), sh );
    layer = L_GRASS;
    float wr = abs( fract( rc / 6.5 + F.key ) - 0.5 ) * 6.5;
    col = mix( col, vec3( 0.2, 0.19, 0.08 ), tBand( wr, 0.6, gFw ) * 0.8 );
  }
  // moisture / soil variation inside the field, and soil zones that run across field boundaries
  col *= 0.82 + 0.36 * tN( p + F.key * 5000.0, 45.0 );
  col *= 0.93 + 0.14 * tNg( p, 14.0 );
  col *= 0.84 + 0.32 * smoothstep( 0.2, 0.8, tFbmT( p + 900.0, 170.0 ) );
  // drill rows close up
  col *= 1.0 + rowAmp * tStripes( rc, rowP, gFw );
  // tramlines: wheel-track pairs 1.8 m apart every 24 m, plus one around the headland
  if ( tram > 0.0 ) {
    float tp = abs( fract( F.across / 24.0 + F.key ) - 0.5 ) * 24.0;
    float t = tBand( abs( tp - 0.9 ), 0.23, gFw ) * ( head ? 0.0 : 1.0 );
    t = max( t, tBand( abs( abs( F.dEnds - 10.0 ) - 0.9 ), 0.23, gFw ) );
    col = mix( col, soilC * 0.9, tram * t * ( 1.0 - smoothstep( 1.5, 4.0, gFw ) ) );
  }
  // edges: hedge / grass strip / farm track along block edges; thin strips between fields
  float m = F.margin;
  if ( F.dBlock < 9.0 ) {
    float d = F.dBlock;
    if ( F.dDistrict <= F.dBlock + 0.01 ) m = 2.0; // a farm track runs along the district boundary
    if ( m < 0.5 ) {
      col = mix( col, vec3( 0.02, 0.042, 0.015 ), tBand( d, 2.4, gFw ) * 0.9 );
      float v = tBand( d, 4.0, gFw ) * ( 1.0 - tBand( d, 2.4, gFw ) );
      col = mix( col, vec3( 0.07, 0.11, 0.03 ), v );
      if ( d < 4.0 ) layer = L_GRASS;
    } else if ( m < 1.5 ) {
      float w = 1.8 + 2.2 * F.key;
      col = mix( col, mix( vec3( 0.075, 0.12, 0.032 ), vec3( 0.13, 0.145, 0.06 ), tN( p, 12.0 ) ), tBand( d, w, gFw ) );
      if ( d < w ) layer = L_GRASS;
    } else {
      // dirt track: two ruts and a grass crown, with grass verges
      col = mix( col, vec3( 0.08, 0.115, 0.034 ), tBand( d, 4.2, gFw ) );
      float rut = tBand( abs( d - 1.2 ), 0.38, gFw );
      col = mix( col, vec3( 0.2, 0.165, 0.115 ), rut );
      if ( d < 4.2 ) layer = rut > 0.5 ? L_SOIL : L_GRASS;
    }
  } else if ( F.dEdge < 2.0 && F.shade > 0.4 ) {
    float w = 0.6 + 0.8 * F.shade;
    col = mix( col, vec3( 0.075, 0.115, 0.032 ), tBand( F.dEdge, w, gFw ) * 0.85 );
    if ( F.dEdge < w ) layer = L_GRASS;
  }
  return tSurf( col, layer, 1.0, rough, bump );
}

Surf tRock( vec3 wp, vec3 N ) {
  vec2 p = wp.xz;
  float slope = 1.0 - N.y;
  float tone = tFbmT( p, 240.0 );
  vec3 col = mix( vec3( 0.15, 0.145, 0.135 ), vec3( 0.27, 0.25, 0.22 ), tone );
  col = mix( col, col * vec3( 1.08, 0.98, 0.9 ), tN( p, 900.0 ) );  // warm / cool massifs
  // warped, dipping strata (not flat bands)
  vec2 dip = normalize( vec2( tN( p, 3000.0 ), tNg( p, 3000.0 ) ) - 0.5 + 1e-3 );
  float y = wp.y + 55.0 * ( tFbmT( p, 500.0 ) - 0.5 ) + dot( p, dip ) * 0.12;
  float thick = mix( 5.0, 13.0, tN( p, 1500.0 ) );
  float band = fract( y / thick );
  float strat = smoothstep( 0.0, 0.08, band ) * ( 1.0 - smoothstep( 0.55, 0.7, band ) );
  float sv = 1.0 - smoothstep( thick * 0.15, thick * 0.6, gFw );
  col *= 1.0 + ( strat - 0.5 ) * 0.3 * sv * ( 0.6 + 0.8 * tNg( p, 300.0 ) );
  // water / lichen streaks down the fall line
  vec2 g = normalize( N.xz + 1e-4 );
  vec2 ac = vec2( dot( p, vec2( -g.y, g.x ) ), dot( p, g ) );
  float streak = textureGrad( uNoise, vec2( ac.x / ( 7.0 * 32.0 ), ac.y / ( 110.0 * 32.0 ) ), gDx / 224.0, gDy / 224.0 ).g;
  col *= 1.0 - 0.32 * smoothstep( 0.55, 0.85, streak ) * smoothstep( 0.15, 0.35, slope );
  // lichen and thin turf on the less steep rock
  col = mix( col, vec3( 0.1, 0.105, 0.06 ), ( 1.0 - smoothstep( 0.18, 0.4, slope ) ) * smoothstep( 0.4, 0.7, tN( p, 30.0 ) ) * 0.6 );
  return tSurf( col, L_ROCK, 1.0, 0.82, ( strat - 0.5 ) * 0.4 * sv );
}

Surf tScree( vec2 p, vec3 N ) {
  vec2 g = normalize( N.xz + 1e-4 );
  vec2 ac = vec2( dot( p, vec2( -g.y, g.x ) ), dot( p, g ) );
  // debris fans: lanes of lighter and darker rubble down the fall line
  float lane = textureGrad( uNoise, vec2( ac.x / ( 14.0 * 32.0 ), ac.y / ( 90.0 * 32.0 ) ), gDx / 448.0, gDy / 448.0 ).r;
  vec3 col = mix( vec3( 0.2, 0.19, 0.17 ), vec3( 0.3, 0.285, 0.255 ), lane );
  col *= 0.9 + 0.2 * tN( p, 20.0 );
  return tSurf( col, L_GRAVEL, 1.0, 0.9, 0.0 );
}

Surf tSnow( vec2 p, float slope ) {
  vec3 col = vec3( 0.8, 0.82, 0.86 ) * ( 0.94 + 0.06 * tN( p, 24.0 ) );
  col = mix( col, vec3( 0.66, 0.68, 0.71 ), smoothstep( 0.3, 0.45, slope ) * 0.5 );   // wind-scoured, dirty on steep ground
  return tSurf( col, L_SNOW, 1.0, 0.5, 0.0 );
}

Surf tSand( vec2 p ) {
  vec3 col = mix( vec3( 0.4, 0.34, 0.23 ), vec3( 0.5, 0.43, 0.3 ), tN( p, 30.0 ) );
  return tSurf( col, L_SAND, 1.0, 0.9, 0.0 );
}

// Town ground on the nearest town's own street grid (the buildings and street meshes are drawn
// on top by the towns/roads modules): residential lots with front lawns, driveways, house plots,
// back gardens with trees and hedges; paved commercial blocks and car parks near the centre;
// parks. From far away (where the buildings are no longer drawn) a mosaic of roofs.
Surf tUrban( vec3 wp ) {
  vec2 p = wp.xz;
  int bi = 0;
  float bd = 1e9;
  for ( int i = 0; i < ${MAX_TOWNS}; i++ ) {
    if ( i >= uTownCount ) break;
    float d = distance( p, uTownA[ i ].xy ) - uTownA[ i ].z;
    if ( d < bd ) { bd = d; bi = i; }
  }
  vec4 T = uTownA[ bi ];
  float bs = max( uTownB[ bi ].x, 40.0 );
  float dens = uTownB[ bi ].y * ( 1.0 - smoothstep( 0.2, 1.05, distance( p, T.xy ) / max( T.z, 1.0 ) ) );
  float cs = cos( T.w );
  float sn = sin( T.w );
  vec2 d = p - T.xy;
  vec2 q = vec2( cs * d.x + sn * d.y, -sn * d.x + cs * d.y );
  vec2 g = q / bs;
  vec2 c = floor( g );
  vec2 fr = g - c;
  float de = min( min( fr.x, 1.0 - fr.x ), min( fr.y, 1.0 - fr.y ) ) * bs; // m from the street centreline
  vec3 lawn = mix( vec3( 0.058, 0.082, 0.032 ), vec3( 0.085, 0.1, 0.045 ), tN( p, 7.0 ) );
  vec3 shrub = vec3( 0.028, 0.043, 0.02 );
  vec3 paving = vec3( 0.15, 0.145, 0.138 ) * ( 0.88 + 0.24 * tN( p, 2.5 ) );
  vec3 asphalt = vec3( 0.068, 0.068, 0.072 );
  vec3 col = lawn;
  float layer = L_GRASS;
  float rough = 0.88;
  float amt = 0.8;
  float bh = tHash( c + 71.0 );
  float trees = 1.0 - smoothstep( 0.12, 0.45, tCellT( p + c * 13.0, 5.5 ) );
  if ( bh < 0.06 + 0.3 * dens ) {
    // commercial / civic block: paved yards, a car park with bay lines, a few trees
    float half_ = step( 0.5, tHash( c + 3.0 ) );
    float u = mix( fr.x, fr.y, half_ );
    col = paving * ( 0.92 + 0.16 * tHash( floor( q / 3.0 ) ) );  // paving slabs
    layer = L_GRAVEL;
    amt = 0.3;
    if ( u > 0.55 ) {
      col = asphalt * ( 0.9 + 0.2 * tN( p, 6.0 ) );
      float v = mix( fr.y, fr.x, half_ ) * bs;
      float bay = abs( fract( v / 2.6 ) - 0.5 ) * 2.6;
      float rowc = abs( fract( u * bs / 16.0 ) - 0.5 ) * 16.0;
      col = mix( col, vec3( 0.32 ), tBand( bay, 0.06, gFw ) * step( 2.5, rowc ) * 0.7 );
      rough = 0.8;
    }
    col = mix( col, shrub, trees * 0.35 * step( 0.9, tHash( c + 9.0 ) + trees ) );
  } else if ( bh < 0.11 + 0.3 * dens && dens < 0.6 ) {
    // park: open lawn, paths, clumps of trees
    col = mix( lawn * 1.05, shrub, trees * 0.8 );
    float path = abs( dot( fr - 0.5, normalize( vec2( 1.0, tHash( c + 2.0 ) - 0.5 ) ) ) ) * bs;
    col = mix( col, paving, tBand( path, 1.2, gFw ) );
  } else {
    // two rows of residential lots back to back
    float row = step( 0.5, fr.y );
    float depth = ( row < 0.5 ? fr.y : 1.0 - fr.y ) * bs - 5.0; // m behind the kerb
    float lw = mix( 18.0, 12.0, dens ) + 6.0 * tHash( c + 5.0 );
    float lxm = fr.x * bs / lw;
    float li = floor( lxm );
    float lx = fract( lxm );
    float lh = tHash( c * 3.0 + vec2( li, row ) + 11.0 );
    float yardDepth = 5.0 + 3.0 * lh;
    if ( depth < yardDepth ) {
      col = lawn * ( 0.95 + 0.1 * lh );
      float drive = step( 0.68 + 0.1 * lh, lx ) * step( lx, 0.86 + 0.1 * lh );
      col = mix( col, paving, drive );
      if ( drive > 0.5 ) layer = L_GRAVEL;
    } else if ( depth < yardDepth + 11.0 ) {
      col = mix( paving * 0.9, lawn, step( 0.8, lx ) * 0.7 ); // the house plot (the building stands here)
      layer = L_GRAVEL;
    } else {
      // back garden: lawn, a patio, a vegetable bed, trees and shrubs
      col = mix( lawn, shrub, trees * 0.85 );
      float patio = step( depth, yardDepth + 15.0 ) * step( 0.2, lx ) * step( lx, 0.7 );
      col = mix( col, paving * 1.05, patio * step( 0.35, lh ) );
      float bed = step( 0.75, lh ) * step( 0.6, fract( depth / 20.0 ) ) * step( 0.15, lx ) * step( lx, 0.5 );
      col = mix( col, vec3( 0.1, 0.075, 0.05 ), bed );
      if ( bed > 0.5 ) layer = L_SOIL;
    }
    // hedges and fences between the lots
    col = mix( col, shrub, tBand( min( lx, 1.0 - lx ) * lw, 0.45, gFw ) * 0.7 * step( 0.0, depth ) );
  }
  // streets, pavements and verges along the block edges
  col = mix( col, lawn * 0.95, tBand( de, 7.2, gFw ) );
  col = mix( col, paving * 1.08, tBand( de, 5.8, gFw ) );
  col = mix( col, asphalt, tBand( de, 3.8, gFw ) );
  if ( de < 5.8 ) {
    layer = L_GRAVEL;
    amt = 0.3;
  }
  // roofs stand in for the buildings once those are no longer drawn
  float far = smoothstep( 3500.0, 7500.0, distance( wp, cameraPosition ) );
  if ( far > 0.0 ) {
    vec2 pc = floor( fr * vec2( 4.0, 2.0 ) );
    vec2 pf = fract( fr * vec2( 4.0, 2.0 ) );
    float rh = tHash( c * 5.0 + pc + 17.0 );
    vec3 roof = rh < 0.45 ? vec3( 0.2, 0.08, 0.05 ) : rh < 0.8 ? vec3( 0.09, 0.09, 0.1 ) : vec3( 0.24, 0.23, 0.22 );
    float cover = step( 0.2, pf.x ) * step( pf.x, 0.8 ) * step( 0.25, pf.y ) * step( pf.y, 0.75 ) * step( 0.3, tHash( c + pc * 7.0 + 1.0 ) );
    col = mix( col, roof, far * cover * ( 0.35 + 0.5 * dens ) );
  }
  return tSurf( col, layer, amt, rough, 0.0 );
}

// ── detail textures ───────────────────────────────────────────────────────────
vec2 tRnd2( vec2 v ) {
  uint h = tPcg( uint( int( v.x ) ) + tPcg( uint( int( v.y ) ) ) );
  return vec2( float( h & 65535u ), float( h >> 16u ) ) * ( 1.0 / 65536.0 );
}

// Hex tiling (after Mikkelsen 2022): three samples with random offsets per hex vertex,
// blended by sharpened barycentrics favouring the higher texel.
vec4 tDetHex( float layer, vec2 uv, vec2 gx, vec2 gy, out vec4 nrm ) {
  vec2 st = uv * 2.2;
  vec2 sk = vec2( st.x - 0.57735027 * st.y, 1.15470054 * st.y );
  vec2 base = floor( sk );
  vec3 t = vec3( fract( sk ), 0.0 );
  t.z = 1.0 - t.x - t.y;
  float s = step( 0.0, -t.z );
  float s2 = 2.0 * s - 1.0;
  vec3 w = vec3( -t.z * s2, s - t.y * s2, s - t.x * s2 );
  vec2 u1 = uv + tRnd2( base + vec2( s, s ) );
  vec2 u2 = uv + tRnd2( base + vec2( s, 1.0 - s ) );
  vec2 u3 = uv + tRnd2( base + vec2( 1.0 - s, s ) );
  vec4 a1 = textureGrad( uDetA, vec3( u1, layer ), gx, gy );
  vec4 a2 = textureGrad( uDetA, vec3( u2, layer ), gx, gy );
  vec4 a3 = textureGrad( uDetA, vec3( u3, layer ), gx, gy );
  vec3 W = w * w * w * ( vec3( a1.a, a2.a, a3.a ) + 0.3 ) * ( vec3( a1.a, a2.a, a3.a ) + 0.3 );
  W /= dot( W, vec3( 1.0 ) );
  nrm = textureGrad( uDetN, vec3( u1, layer ), gx, gy ) * W.x + textureGrad( uDetN, vec3( u2, layer ), gx, gy ) * W.y
      + textureGrad( uDetN, vec3( u3, layer ), gx, gy ) * W.z;
  return a1 * W.x + a2 * W.y + a3 * W.z;
}

// Detail for one class: returns the colour modulation (neutral 1) in rgb and the height in a;
// writes the normal perturbation (world x, z) and the cavity into nOut.
vec4 tDetail( float layer, float amt, vec2 p, out vec3 nOut ) {
  nOut = vec3( 0.0, 0.0, 1.0 );
  if ( uDetail <= 0.0 || amt <= 0.0 ) return vec4( 1.0, 1.0, 1.0, 0.5 );
  float S = DET_TILE[ int( layer + 0.5 ) ];
  float fNear = ( 1.0 - smoothstep( S / 64.0, S / 9.0, gFwD ) ) * amt * uDetail;
  float S2 = S * 5.3;
  float fMid = ( 1.0 - smoothstep( S2 / 64.0, S2 / 8.0, gFwD ) ) * amt * uDetail;
  vec3 md = vec3( 1.0 );
  float h = 0.5;
  vec2 pn = vec2( 0.0 );
  float ao = 1.0;
  if ( fMid > 0.0 ) {
    // mid scale: one tap, rotated, adds 1–10 m mottling
    const mat2 R = mat2( 0.8, 0.6, -0.6, 0.8 );
    vec2 uv = R * p / S2;
    vec4 a = textureGrad( uDetA, vec3( uv, layer ), R * gDx / S2, R * gDy / S2 );
    vec4 n = textureGrad( uDetN, vec3( uv, layer ), R * gDx / S2, R * gDy / S2 );
    md = mix( vec3( 1.0 ), a.rgb * 2.0, fMid * 0.65 );
    h = mix( 0.5, a.a, fMid );
    vec2 nn = ( n.xy * 2.0 - 1.0 ) * R; // back to world axes (v * R = transpose( R ) * v)
    pn = nn * fMid * 0.5;
    ao = mix( 1.0, n.z, fMid * 0.5 );
  }
  if ( fNear > 0.0 ) {
    vec4 n;
    vec4 a = tDetHex( layer, p / S, gDx / S, gDy / S, n );
    md *= mix( vec3( 1.0 ), a.rgb * 2.0, fNear );
    h = mix( h, a.a, fNear );
    pn += ( n.xy * 2.0 - 1.0 ) * fNear;
    ao *= mix( 1.0, n.z, fNear );
  }
  nOut = vec3( pn, ao );
  return vec4( md, h );
}

// Airport pavement from the layout rectangles.
float tPaved( vec2 p, out float kind, out vec2 local ) {
  kind = -1.0;
  local = vec2( 0.0 );
  float best = 1e9;
  for ( int i = 0; i < 8; i++ ) {
    if ( i >= uPavedCount ) break;
    vec4 a = uPavedA[ i ];
    vec4 b = uPavedB[ i ];
    vec2 d = p - a.xy;
    float al = dot( d, b.xy );
    float ac = dot( d, vec2( -b.y, b.x ) );
    float ex = max( abs( al ) - a.z, abs( ac ) - a.w );
    if ( ex < best ) { best = ex; kind = b.z; local = vec2( al, ac ); }
  }
  return best; // < 0 inside
}

Surf tClassSurf( int k, vec3 wp, vec3 N ) {
  vec2 p = wp.xz;
  if ( k == 0 ) return tField( p );
  if ( k == 1 ) return tGrass( p, wp.y );
  if ( k == 2 ) return tForest( wp );
  if ( k == 3 ) return tRock( wp, N );
  if ( k == 4 ) return tScree( p, N );
  if ( k == 5 ) return tSnow( p, 1.0 - N.y );
  if ( k == 6 ) return tSand( p );
  return tUrban( wp );
}

vec3 terrainAlbedo( out float rough ) {
  vec3 wp = vWPos;
  vec2 p = wp.xz;
  // derivatives in uniform control flow (everything below may branch)
  gDx = dFdx( p );
  gDy = dFdy( p );
  vec3 dwx = dFdx( wp );
  vec3 dwy = dFdy( wp );
  gFw = max( length( dwx ) + length( dwy ), 1e-3 );
  gFwD = max( sqrt( length( dwx ) * length( dwy ) ), 1e-3 );
  vec3 N = normalize( vWNormal );
  float slope = 1.0 - N.y;

  // per-pixel break-up of the vertex-interpolated class boundaries
  vec4 nz = tN4( p / 26.0 );
  vec4 nz2 = tN4( p / 6.5 );
  float nb = ( nz.r - 0.5 ) + ( nz2.g - 0.5 ) * 0.45;
  float nb2 = tN( p + 7.7, 41.0 ) - 0.5;
  float nSnow = tNg( p, 9.0 ) - 0.5;
  // gullies: streaks down the fall line where snow lingers
  vec2 g = normalize( N.xz + 1e-4 );
  vec2 ac = vec2( dot( p, vec2( -g.y, g.x ) ), dot( p, g ) );
  float streak = textureGrad( uNoise, vec2( ac.x / ( 30.0 * 32.0 ), ac.y / ( 260.0 * 32.0 ) ), gDx / 960.0, gDy / 960.0 ).r;
  streak = smoothstep( 0.25, 0.75, streak );

  float w[8];
  classWeights( vLc0, vLc1, slope, nb, nb2, nSnow, streak, wp.y, w );
  int i1;
  int i2;
  topTwo( w, i1, i2 );

  vec3 col = vec3( 0.0 );
  rough = 0.0;
  tBump = 0.0;
  tDetN = vec2( 0.0 );
  // minor classes: plain colours
  for ( int k = 0; k < 8; k++ ) {
    if ( k == i1 || k == i2 || w[ k ] < 0.004 ) continue;
    Surf s = tClassSurf( k, wp, N );
    col += w[ k ] * s.col;
    rough += w[ k ] * s.rough;
    tBump += w[ k ] * s.bump;
  }
  // the two strongest: detail textures and a height-aware blend
  float w1 = w[ i1 ];
  float w2 = w[ i2 ] >= 0.004 ? w[ i2 ] : 0.0;
  Surf s1 = tClassSurf( i1, wp, N );
  vec3 n1;
  vec4 d1 = tDetail( s1.layer, s1.amt, p, n1 );
  vec3 c1 = s1.col * d1.rgb * n1.z;
  vec3 c2 = vec3( 0.0 );
  float b2 = 0.0;
  if ( w2 > 0.0 ) {
    Surf s2 = tClassSurf( i2, wp, N );
    vec3 n2;
    vec4 d2 = tDetail( s2.layer, s2.amt, p, n2 );
    c2 = s2.col * d2.rgb * n2.z;
    float fade = ( 1.0 - smoothstep( 0.05, 0.6, gFwD ) ) * uDetail;
    b2 = heightBlend( w1, d1.a, w2, d2.a, fade );
    rough += ( w1 + w2 ) * mix( s1.rough, s2.rough, b2 );
    tBump += ( w1 + w2 ) * mix( s1.bump, s2.bump, b2 );
    tDetN = ( w1 + w2 ) * mix( n1.xy, n2.xy, b2 );
  } else {
    rough += w1 * s1.rough;
    tBump += w1 * s1.bump;
    tDetN = w1 * n1.xy;
  }
  col += ( w1 + w2 ) * mix( c1, c2, b2 );

  // airport pavement from the layout (the airport renderer draws its own on top)
  float dA = distance( p, uAirport.xy );
  if ( dA < uAirport.z + 200.0 ) {
    float kind;
    vec2 loc;
    float e = tPaved( p, kind, loc );
    if ( e < gFw ) {
      float cover = 1.0 - smoothstep( -0.5 * gFw, 0.5 * gFw, e );
      vec3 pav = kind < 0.5 ? vec3( 0.075, 0.075, 0.078 ) : vec3( 0.105, 0.103, 0.10 );
      pav *= 0.9 + 0.2 * tN( p, 3.5 );
      if ( kind < 0.5 ) pav *= 1.0 - 0.35 * smoothstep( 6.0, 0.0, abs( loc.y ) ) * tN( p / vec2( 1.0, 12.0 ), 2.0 );
      col = mix( col, pav, cover );
      rough = mix( rough, 0.75, cover );
      tBump *= 1.0 - cover;
      tDetN *= 1.0 - cover;
    }
  }

  // macro variation at 1–30 km (per vertex): brightness, a greener/browner region tint, hue drift
  float veg = w[ 0 ] + w[ 1 ] + w[ 2 ];
  col *= 0.88 + 0.24 * vMacro.y;
  col *= mix( vec3( 1.05, 1.0, 0.9 ), vec3( 0.95, 1.0, 1.06 ), vMacro.x );
  vec3 dry = col * vec3( 1.1, 1.02, 0.82 );
  col = mix( col, dry, veg * smoothstep( 0.45, 0.8, vMacro.w ) * 0.6 );
  col *= 0.94 + 0.12 * vMacro.z;

  // shore, sea bed and water tint
  float depth = vWaterLevel - wp.y;
  float wWater = vLc1.w;
  if ( depth > -1.2 ) {
    float wet = smoothstep( -1.2, 0.0, depth );
    col *= 1.0 - 0.38 * wet;
    rough = mix( rough, 0.35, wet );
    if ( wWater > 0.01 || depth > 0.0 ) {
      vec3 bed = mix( vec3( 0.30, 0.26, 0.18 ), vec3( 0.13, 0.12, 0.09 ), smoothstep( 0.0, 12.0, depth ) );
      bed *= 0.85 + 0.3 * tN( p, 18.0 );
      col = mix( col, bed, tSat( wWater * 1.5 ) );
    }
    if ( depth > 0.0 ) {
      bool sea = vWaterLevel < 0.5;
      vec3 absorb = sea ? vec3( 0.42, 0.075, 0.038 ) : vec3( 0.36, 0.12, 0.11 );
      vec3 scatter = sea ? vec3( 0.0035, 0.024, 0.036 ) : vec3( 0.006, 0.020, 0.018 );
      vec3 T = exp( -absorb * depth );
      col = col * T + scatter * ( 1.0 - exp( -0.22 * depth ) );
      if ( sea && depth < 1.2 ) {
        float t = uTime * 0.11 + tN( p, 250.0 ) * 3.0;
        float front = 1.1 * ( 1.0 - fract( t ) );
        float foam = exp( -pow( ( depth - front ) * 6.0, 2.0 ) ) * smoothstep( 0.35, 0.75, tN( p + uTime * 1.2, 4.0 ) );
        foam += exp( -pow( depth * 9.0, 2.0 ) ) * 0.5 * tNg( p - uTime * 0.4, 2.0 );
        col = mix( col, vec3( 0.75, 0.78, 0.8 ), tSat( foam ) * 0.8 );
      }
      tDetN *= exp( -depth );
    }
  }
  rough = clamp( rough, 0.3, 1.0 );
  tBumpScale = 1.0 - smoothstep( 0.2, 2.5, gFw );
  return col;
}

// Derivative-based bump (Mikkelsen) on the view-space surface.
vec3 terrainBump( vec3 surfPos, vec3 n, float h ) {
  vec3 dpdx = dFdx( surfPos );
  vec3 dpdy = dFdy( surfPos );
  float dhdx = dFdx( h );
  float dhdy = dFdy( h );
  vec3 r1 = cross( dpdy, n );
  vec3 r2 = cross( n, dpdx );
  float det = dot( dpdx, r1 );
  vec3 grad = sign( det ) * ( dhdx * r1 + dhdy * r2 );
  return normalize( abs( det ) * n - grad );
}
`;

export const TERRAIN_MAP_FRAGMENT = /* glsl */ `
float tRough;
diffuseColor.rgb = terrainAlbedo( tRough );
`;

export const TERRAIN_ROUGHNESS_FRAGMENT = /* glsl */ `
float roughnessFactor = tRough;
`;

export const TERRAIN_NORMAL_FRAGMENT = /* glsl */ `
normal = terrainBump( - vViewPosition, normal, tBump * tBumpScale ); // derivatives in uniform control flow
normal = normalize( normal + mat3( viewMatrix ) * vec3( tDetN.x, 0.0, tDetN.y ) );
`;
