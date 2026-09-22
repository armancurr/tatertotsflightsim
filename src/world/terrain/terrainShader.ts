/**
 * GLSL for the terrain material (injected into MeshStandardMaterial by
 * material.ts). Everything is procedural in world space — no textures — and
 * scales from a 10 m close-up (tractor rows, grass, tree crowns, rock grain,
 * bump) to 3,000 m (field patchwork, forests, towns, snowfields) and beyond
 * (macro colour variation so nothing tiles). Detail layers fade with the
 * pixel footprint (fwidth) to avoid shimmer.
 *
 * Colours are linear-sRGB albedos in natural ranges (vegetation 0.03–0.2,
 * ripe cereals ~0.4, sand ~0.45, snow ~0.85).
 */

export const TERRAIN_VERTEX_PARS = /* glsl */ `
attribute vec4 lc0;      // forest, field, grass, rock
attribute vec4 lc1;      // snow, sand, urban, water
attribute vec3 aMorph;   // dy to the parent LOD surface, water level, tile size
uniform float uSplit;
varying vec3 vWPos;
varying vec4 vLc0;
varying vec4 vLc1;
varying float vWaterLevel;
varying vec3 vWNormal;
`;

export const TERRAIN_BEGIN_VERTEX = /* glsl */ `
vec3 transformed = vec3( position );
{
  // CDLOD-style geomorph: vertices slide onto the parent tile's surface as they
  // approach the distance where the parent takes over, so LOD switches don't pop.
  vec3 wp0 = ( modelMatrix * vec4( position, 1.0 ) ).xyz;
  float mEnd = 2.0 * aMorph.z * uSplit;
  float m = smoothstep( mEnd * 0.72, mEnd, distance( wp0, cameraPosition ) );
  transformed.y += aMorph.x * m;
}
`;

export const TERRAIN_WORLDPOS_VERTEX = /* glsl */ `
vWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
vLc0 = lc0;
vLc1 = lc1;
vWaterLevel = aMorph.y;
vWNormal = normalize( mat3( modelMatrix ) * objectNormal );
`;

export const TERRAIN_FRAGMENT_PARS = /* glsl */ `
varying vec3 vWPos;
varying vec4 vLc0;
varying vec4 vLc1;
varying float vWaterLevel;
varying vec3 vWNormal;
uniform float uTime;
uniform vec4 uPavedA[8];   // centre x, centre z, half length, half width
uniform vec4 uPavedB[8];   // forward x, forward z, kind (0 runway, 1 taxiway/apron), unused
uniform int uPavedCount;
uniform vec4 uAirport;     // centre x, centre z, flat radius, runway heading (rad)

float tBump;       // bump height (m) set by terrainAlbedo, used by the normal chunk
float tBumpScale;

uint tPcg( uint v ) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ( ( s >> ( ( s >> 28u ) + 4u ) ) ^ s ) * 277803737u;
  return ( w >> 22u ) ^ w;
}
float tHash( vec2 p ) {
  ivec2 i = ivec2( p );
  return float( tPcg( uint( i.x ) + tPcg( uint( i.y ) ) ) ) * ( 1.0 / 4294967295.0 );
}
vec2 tHash2( vec2 p ) {
  ivec2 i = ivec2( p );
  uint h = tPcg( uint( i.x ) + tPcg( uint( i.y ) ) );
  return vec2( float( h ), float( tPcg( h ) ) ) * ( 1.0 / 4294967295.0 );
}
float tNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = p - i;
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  float a = tHash( i );
  float b = tHash( i + vec2( 1.0, 0.0 ) );
  float c = tHash( i + vec2( 0.0, 1.0 ) );
  float d = tHash( i + vec2( 1.0, 1.0 ) );
  return mix( mix( a, b, u.x ), mix( c, d, u.x ), u.y );
}
float tFbm( vec2 p ) {
  float s = 0.0;
  float a = 0.5;
  for ( int i = 0; i < 3; i++ ) {
    s += a * tNoise( p );
    p = mat2( 1.6, 1.2, -1.2, 1.6 ) * p + 11.3;
    a *= 0.5;
  }
  return s / 0.875;
}
// Distance to the nearest jittered feature point (tree crowns, stones).
float tCells( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = p - i;
  float d = 8.0;
  for ( int y = -1; y <= 1; y++ )
    for ( int x = -1; x <= 1; x++ ) {
      vec2 o = vec2( float( x ), float( y ) );
      vec2 r = o + 0.15 + 0.7 * tHash2( i + o ) - f;
      d = min( d, dot( r, r ) );
    }
  return sqrt( d );
}
float tSat( float x ) { return clamp( x, 0.0, 1.0 ); }
// Fraction of a pixel of footprint fw covered by a band of half-width w around distance d = 0.
float tBand( float d, float w, float fw ) {
  float c = 1.0 - smoothstep( w - 0.5 * fw, w + 0.5 * fw, d );
  return c * min( 1.0, 2.0 * w / max( fw, 1e-3 ) + 0.25 );
}

vec3 tForest( vec2 p, float fw, out float bump );

// ── Farmland: irregular rectangular fields in farm "districts" with their own orientation ──
// (same grid, hashes and woodlot/margin choices as src/world/fields.ts, so CPU trees match)
vec3 tFarmland( vec2 p, float fw, out float rough, out float bump ) {
  vec2 wp = p + 160.0 * ( vec2( tNoise( p * 0.0009 ), tNoise( p * 0.0009 + 17.3 ) ) - 0.5 );
  vec2 dc = floor( wp / 1500.0 );
  float dh = tHash( dc + 91.0 );
  float ang = ( dh - 0.5 ) * 0.8;
  vec2 cs = vec2( cos( ang ), sin( ang ) );
  vec2 q = vec2( cs.x * p.x + cs.y * p.y, -cs.y * p.x + cs.x * p.y );
  q += 14.0 * ( vec2( tNoise( p * 0.0045 ), tNoise( p * 0.0045 + 9.1 ) ) - 0.5 );
  vec2 cellSize = mix( vec2( 240.0, 170.0 ), vec2( 470.0, 320.0 ), tHash( dc + 3.0 ) );
  vec2 g = q / cellSize;
  vec2 c = floor( g );
  vec2 f = g - c;
  float h1 = tHash( c + dc * 57.0 );
  float nStrips = 1.0 + floor( h1 * 3.3 );
  float alongX = step( 0.5, tHash( c + dc * 13.0 + 7.0 ) );
  float coord = mix( f.y, f.x, alongX );
  float si = floor( coord * nStrips );
  float sfr = coord * nStrips - si;
  vec2 fid = c * 4.0 + vec2( si, alongX * 2.0 );
  float fh = tHash( fid + dc * 131.0 );
  float fh2 = tHash( fid + dc * 131.0 + 5.0 );
  if ( tHash( fid + dc * 131.0 + 11.0 ) <= 0.075 ) { rough = 0.97; return tForest( p, fw, bump ); } // woodlot
  vec2 dEdge = min( f, 1.0 - f ) * cellSize;
  float stripLen = mix( cellSize.y, cellSize.x, alongX ) / nStrips;
  float dStrip = min( sfr, 1.0 - sfr ) * stripLen;
  float dCell = min( dEdge.x, dEdge.y );
  float dB = min( dCell, dStrip );
  float across = mix( q.y, q.x, alongX );

  vec3 col;
  float rowAmp;
  float tramAmp = 0.0;
  rough = 0.95;
  if ( fh < 0.30 ) { col = mix( vec3( 0.058, 0.115, 0.024 ), vec3( 0.092, 0.160, 0.036 ), fh2 ); rowAmp = 0.05; tramAmp = 0.16; }        // green cereals
  else if ( fh < 0.41 ) { col = mix( vec3( 0.036, 0.078, 0.020 ), vec3( 0.055, 0.100, 0.026 ), fh2 ); rowAmp = 0.22; }                  // maize / beet rows
  else if ( fh < 0.59 ) { col = mix( vec3( 0.40, 0.29, 0.11 ), vec3( 0.54, 0.41, 0.17 ), fh2 ); rowAmp = 0.04; tramAmp = 0.22; }        // ripe wheat / barley
  else if ( fh < 0.69 ) { col = mix( vec3( 0.33, 0.28, 0.16 ), vec3( 0.44, 0.38, 0.23 ), fh2 ); rowAmp = 0.12; }                        // stubble / straw
  else if ( fh < 0.81 ) { col = mix( vec3( 0.085, 0.056, 0.032 ), vec3( 0.15, 0.098, 0.055 ), fh2 ); rowAmp = 0.30; rough = 1.0; }     // ploughed soil
  else if ( fh < 0.955 ) { col = mix( vec3( 0.11, 0.17, 0.045 ), vec3( 0.17, 0.22, 0.075 ), fh2 ); rowAmp = 0.06; }                    // hay / grass ley
  else { col = mix( vec3( 0.47, 0.41, 0.025 ), vec3( 0.56, 0.48, 0.04 ), fh2 ); rowAmp = 0.03; }                                         // rapeseed in flower
  // moisture / growth variation inside the field
  col *= 0.86 + 0.28 * tNoise( p / 55.0 + fh * 61.0 );
  // tractor rows (2.5 m) close up, tramlines (24 m) visible from the air
  float rowVis = 1.0 - smoothstep( 0.5, 1.6, fw );
  float rows = sin( across * 2.513 );
  col *= 1.0 + rowAmp * rows * rowVis;
  float tl = abs( fract( across / 24.0 + fh2 ) - 0.5 ) * 24.0;
  col *= 1.0 - tramAmp * tBand( tl, 0.45, fw ) * ( 1.0 - smoothstep( 6.0, 14.0, fw ) );
  // field margins: hedgerows (dark), grass strips (green) or tracks (light)
  float kind = tHash( c + dc * 3.0 + 11.0 );
  vec3 edgeCol = kind < 0.45 ? vec3( 0.022, 0.045, 0.016 ) : kind < 0.8 ? vec3( 0.09, 0.14, 0.04 ) : vec3( 0.26, 0.22, 0.15 );
  float edgeW = kind < 0.45 ? 2.2 : 1.5;
  col = mix( col, edgeCol, tBand( dCell, edgeW, fw ) * 0.9 );
  col = mix( col, vec3( 0.08, 0.12, 0.04 ), tBand( dStrip, 0.8, fw ) * 0.6 );
  bump = rows * rowAmp * 0.08;
  return col;
}

vec3 tMeadow( vec2 p, float fw ) {
  float n1 = tNoise( p / 70.0 );
  float n2 = tNoise( p / 14.0 );
  vec3 col = mix( vec3( 0.066, 0.118, 0.028 ), vec3( 0.115, 0.165, 0.042 ), n1 );
  col = mix( col, vec3( 0.20, 0.19, 0.085 ), smoothstep( 0.62, 0.92, tNoise( p / 420.0 + 3.0 ) ) * 0.55 );
  col *= 0.9 + 0.2 * n2;
  return col;
}

vec3 tForest( vec2 p, float fw, out float bump ) {
  float sp = tFbm( p / 210.0 );
  vec3 conifer = vec3( 0.014, 0.030, 0.015 );
  vec3 decid = vec3( 0.032, 0.060, 0.019 );
  vec3 col = mix( conifer, decid, smoothstep( 0.38, 0.62, sp ) );
  col *= 0.78 + 0.44 * tNoise( p / 32.0 );
  bump = 0.0;
  if ( fw < 4.0 ) {
    float d = tCells( p / 6.0 );
    float crown = 1.0 - smoothstep( 0.25, 0.75, d );
    float k = 1.0 - smoothstep( 1.5, 4.0, fw );
    col *= mix( 1.0, mix( 0.45, 1.3, crown ), k );
    bump = crown * 1.2 * k;
  }
  return col;
}

vec3 tRock( vec3 wp, vec2 p, float fw, out float bump ) {
  float n = tFbm( p / 40.0 );
  vec3 col = mix( vec3( 0.13, 0.125, 0.12 ), vec3( 0.25, 0.225, 0.195 ), n );
  float strata = sin( wp.y * 0.42 + 7.0 * tNoise( p / 150.0 ) );
  col *= 1.0 + 0.16 * strata * ( 1.0 - smoothstep( 3.0, 16.0, fw ) );
  float grain = tNoise( p / 6.0 );
  col *= 0.82 + 0.3 * grain;
  // lichen / scree tint
  col = mix( col, col * vec3( 0.95, 1.0, 0.85 ), tNoise( p / 90.0 ) * 0.5 );
  bump = ( strata * 0.4 + grain ) * 0.9;
  return col;
}

vec3 tUrban( vec2 p, float fw ) {
  vec2 cc = floor( p / 900.0 );
  float ang = ( tHash( cc + 5.0 ) - 0.5 ) * 0.5;
  vec2 cs = vec2( cos( ang ), sin( ang ) );
  vec2 q = vec2( cs.x * p.x + cs.y * p.y, -cs.y * p.x + cs.x * p.y );
  vec2 g = q / 62.0;
  vec2 c = floor( g );
  vec2 f = g - c;
  float h = tHash( c + 71.0 );
  vec3 lot;
  if ( h < 0.30 ) lot = vec3( 0.28, 0.095, 0.055 );        // terracotta roofs
  else if ( h < 0.52 ) lot = vec3( 0.11, 0.11, 0.12 );     // slate / dark roofs
  else if ( h < 0.70 ) lot = vec3( 0.30, 0.29, 0.27 );     // concrete, flat roofs
  else if ( h < 0.84 ) lot = vec3( 0.06, 0.10, 0.035 );    // gardens
  else lot = vec3( 0.075, 0.075, 0.08 );                    // car parks, yards
  // parcels inside the block
  vec2 sub = floor( f * vec2( 3.0, 2.0 ) );
  lot *= 0.8 + 0.4 * tHash( c * 7.0 + sub + 3.0 );
  float dEdge = min( min( f.x, 1.0 - f.x ), min( f.y, 1.0 - f.y ) ) * 62.0;
  vec3 col = mix( lot, vec3( 0.055, 0.055, 0.06 ), tBand( dEdge, 5.0, fw ) );
  return col;
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

vec3 terrainAlbedo( out float rough ) {
  vec3 wp = vWPos;
  vec2 p = wp.xz;
  float fw = max( length( fwidth( wp ) ), 1e-3 );
  vec3 N = normalize( vWNormal );
  float slope = 1.0 - N.y;

  // per-pixel breakup of class boundaries inside the vertex-interpolated transitions
  float nb = ( tNoise( p / 26.0 ) - 0.5 ) + ( tNoise( p / 6.5 ) - 0.5 ) * 0.45;
  float nb2 = tNoise( p / 41.0 + 7.7 ) - 0.5;
  float wForest = tSat( ( vLc0.x - 0.5 + nb * 0.55 ) * 3.5 + 0.5 );
  float wField = vLc0.y;
  float wGrass = vLc0.z;
  float wRock = max( tSat( ( vLc0.w - 0.5 + nb2 * 0.5 ) * 3.0 + 0.5 ), smoothstep( 0.24, 0.40, slope + nb * 0.06 ) * 0.9 );
  float wSnow = tSat( ( vLc1.x - 0.5 + nb2 * 0.6 + ( tNoise( p / 9.0 ) - 0.5 ) * 0.2 ) * 3.0 + 0.5 ) * ( 1.0 - smoothstep( 0.36, 0.52, slope ) );
  float wSand = tSat( ( vLc1.y - 0.5 + nb * 0.4 ) * 3.0 + 0.5 );
  float wUrban = tSat( ( vLc1.z - 0.5 + nb2 * 0.5 ) * 2.5 + 0.5 );
  float wWater = vLc1.w;
  // priority as in landcover.ts: snow > rock > urban > sand > forest > field > grass
  float rem = 1.0;
  float aS = wSnow * rem; rem -= aS;
  float aR = wRock * rem; rem -= aR;
  float aU = wUrban * rem; rem -= aU;
  float aD = wSand * rem; rem -= aD;
  float aF = wForest * rem; rem -= aF;
  float fg = wField + wGrass + 1e-4;
  float aC = rem * wField / fg;
  float aG = rem - aC;

  vec3 col = vec3( 0.0 );
  rough = 0.0;
  tBump = 0.0;
  float b;
  if ( aC > 0.003 ) { float r; col += aC * tFarmland( p, fw, r, b ); rough += aC * r; tBump += aC * b; }
  if ( aG > 0.003 ) { col += aG * tMeadow( p, fw ); rough += aG * 0.95; tBump += aG * ( tNoise( p / 0.9 ) - 0.5 ) * 0.12; }
  if ( aF > 0.003 ) { col += aF * tForest( p, fw, b ); rough += aF * 0.97; tBump += aF * b; }
  if ( aR > 0.003 ) { col += aR * tRock( wp, p, fw, b ); rough += aR * 0.82; tBump += aR * b; }
  if ( aS > 0.003 ) {
    vec3 sc = vec3( 0.80, 0.83, 0.88 ) * ( 0.93 + 0.07 * tNoise( p / 24.0 ) );
    sc = mix( sc, vec3( 0.62, 0.64, 0.68 ), smoothstep( 0.3, 0.45, slope ) * 0.4 );
    col += aS * sc; rough += aS * 0.55; tBump += aS * ( tNoise( p / 3.0 ) - 0.5 ) * 0.2;
  }
  if ( aD > 0.003 ) {
    vec3 sd = mix( vec3( 0.44, 0.37, 0.25 ), vec3( 0.55, 0.47, 0.32 ), tNoise( p / 30.0 ) );
    sd *= 0.94 + 0.12 * tNoise( p / 1.5 );
    col += aD * sd; rough += aD * 0.9; tBump += aD * sin( ( p.x * 0.6 + p.y * 0.8 ) * 3.0 + tNoise( p / 4.0 ) * 6.0 ) * 0.03;
  }
  if ( aU > 0.003 ) { col += aU * tUrban( p, fw ); rough += aU * 0.8; }

  // airfield: mown stripes on the grass, pavement from the layout
  float dA = distance( p, uAirport.xy );
  if ( dA < uAirport.z + 200.0 ) {
    vec2 fwd = vec2( sin( uAirport.w ), -cos( uAirport.w ) );
    float acr = dot( p - uAirport.xy, vec2( -fwd.y, fwd.x ) );
    float mow = step( 0.5, fract( acr / 22.0 ) ) * 2.0 - 1.0;
    col *= 1.0 + 0.06 * mow * ( 1.0 - smoothstep( 1.0, 5.0, fw ) ) * ( 1.0 - smoothstep( uAirport.z - 200.0, uAirport.z, dA ) );
    float kind;
    vec2 loc;
    float e = tPaved( p, kind, loc );
    if ( e < fw ) {
      float cover = 1.0 - smoothstep( -0.5 * fw, 0.5 * fw, e );
      vec3 pav = kind < 0.5 ? vec3( 0.075, 0.075, 0.078 ) : vec3( 0.105, 0.103, 0.10 );
      pav *= 0.9 + 0.2 * tNoise( p / 3.5 ) + 0.06 * ( tNoise( p / 0.4 ) - 0.5 ) * ( 1.0 - smoothstep( 0.1, 0.5, fw ) );
      if ( kind < 0.5 ) pav *= 1.0 - 0.35 * smoothstep( 6.0, 0.0, abs( loc.y ) ) * tNoise( p / vec2( 2.0, 25.0 ) ); // rubber on the centreline
      col = mix( col, pav, cover );
      rough = mix( rough, 0.75, cover );
      tBump *= 1.0 - cover;
    }
  }

  // macro variation so nothing tiles, from km-scale patches down to fields
  float m1 = tNoise( p / 4200.0 );
  float m2 = tNoise( p / 1100.0 + 3.1 );
  col *= 0.86 + 0.28 * m1;
  col *= mix( vec3( 1.06, 1.0, 0.88 ), vec3( 0.94, 1.0, 1.08 ), m2 );
  // close-range grain
  col *= 1.0 + ( tNoise( p / 0.37 ) - 0.5 ) * 0.14 * ( 1.0 - smoothstep( 0.05, 0.35, fw ) );

  // shore, sea bed and water tint
  float depth = vWaterLevel - wp.y;
  if ( depth > -1.2 ) {
    float wet = smoothstep( -1.2, 0.0, depth );
    col *= 1.0 - 0.38 * wet;
    rough = mix( rough, 0.35, wet );
    if ( wWater > 0.01 || depth > 0.0 ) {
      // sand / mud bed
      vec3 bed = mix( vec3( 0.30, 0.26, 0.18 ), vec3( 0.13, 0.12, 0.09 ), smoothstep( 0.0, 12.0, depth ) );
      bed *= 0.85 + 0.3 * tNoise( p / 18.0 );
      col = mix( col, bed, tSat( wWater * 1.5 ) );
    }
    if ( depth > 0.0 ) {
      bool sea = vWaterLevel < 0.5;
      vec3 absorb = sea ? vec3( 0.42, 0.075, 0.038 ) : vec3( 0.36, 0.12, 0.11 );
      vec3 scatter = sea ? vec3( 0.0035, 0.024, 0.036 ) : vec3( 0.006, 0.020, 0.018 );
      vec3 T = exp( -absorb * depth );
      col = col * T + scatter * ( 1.0 - exp( -0.22 * depth ) );
      // surf: foam lines running up the beach
      if ( sea && depth < 1.2 ) {
        float t = uTime * 0.11 + tNoise( p * 0.004 ) * 3.0;
        float front = 1.1 * ( 1.0 - fract( t ) );
        float foam = exp( -pow( ( depth - front ) * 6.0, 2.0 ) ) * smoothstep( 0.35, 0.75, tNoise( p * 0.25 + uTime * 0.3 ) );
        foam += exp( -pow( depth * 9.0, 2.0 ) ) * 0.5 * tNoise( p * 0.5 - uTime * 0.2 );
        col = mix( col, vec3( 0.75, 0.78, 0.8 ), tSat( foam ) * 0.8 );
      }
    }
  }
  rough = clamp( rough, 0.3, 1.0 );
  tBumpScale = 1.0 - smoothstep( 0.2, 2.5, fw );
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
`;
