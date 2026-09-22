/**
 * GLSL for the water materials (injected into MeshStandardMaterial by
 * material.ts, so three's sun GGX specular, shadows, env map, depth modes and
 * the atmosphere's aerial-perspective fog chunks all apply). One source,
 * three variants: WATER_SEA, WATER_LAKE, WATER_RIVER.
 *
 * Surface (per pixel, world space):
 *  - Gerstner trains (waves.ts, same numbers as waterSurfaceAt) → large-wave
 *    normal + crest measure; each train fades out when the pixel footprint
 *    can't resolve it and its slope variance moves into roughness.
 *  - two layers of the FFT detail tile (detail.ts), rotated around the wind and
 *    scrolled at their phase speed (rivers: advected by the flow coordinate);
 *    the tile's LEAN mip chain gives the unresolved variance → roughness, so
 *    close water sparkles and distant water shows a broad glitter path.
 *  - km-scale wind slicks / cat's paws modulate the small waves (no tiling).
 * Colour: depth from the bathymetry clipmap (or the river's channel profile) →
 * bed (sand/weed/mud, refracted, caustics in the shallows) seen through
 * absorbing water + in-scattered body colour; foam (surf lines from the shore
 * distance field, sparse whitecaps, rapids, bridge piers) as a diffuse layer.
 * Composite: sun GGX (three) + env reflection along a reflection vector kept
 * above the horizon with split-sum Fresnel (EnvironmentBRDF) + lit body;
 * straight alpha only at the waterline so the beach shows through.
 */

export const WATER_VERTEX_PARS = /* glsl */ `
varying vec3 vWaterW;
varying vec2 vWaveP;
uniform vec2 uOrigin;
uniform vec4 uWaveA[ 16 ];
uniform vec4 uWaveB[ 16 ];
uniform float uWaveGain;
#ifdef WATER_SEA
  uniform sampler2D uBathyN;
  uniform vec4 uBathyNXf;
  uniform float uDispRange;
#endif
#ifdef WATER_RIVER
  attribute vec2 aAcross;
  attribute vec4 aRiver;   // halfWidth, depth, flow, foam
  attribute vec4 aRiver2;  // s, fade, speed, side
  uniform float uMargin;
  uniform float uPxAngle;
  uniform float uMinPx;
  uniform float uLiftPerM;
  uniform float uPull;
  varying vec4 vRiver;
  varying vec4 vRiver2;    // across metres, fade, speed, drawn half-width
  varying vec2 vFlowDir;
#endif
#ifdef WATER_LAKE
  attribute float aLake;
  varying float vLake;
#endif
`;

/** After <begin_vertex>: sea displacement, river widening + lift. */
export const WATER_BEGIN_VERTEX = /* glsl */ `
{
  vec3 wp0 = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vWaveP = wp0.xz - uOrigin;
  #ifdef WATER_SEA
    // Gerstner displacement near the camera; each train fades when the grid can't carry it
    float r = length( wp0.xz - cameraPosition.xz );
    float spacing = max( 0.6, r * 0.045 );
    float near = 1.0 - smoothstep( uDispRange * 0.6, uDispRange, r );
    if ( near > 0.0 ) {
      vec2 bu = ( wp0.xz - uBathyNXf.xy ) * uBathyNXf.z;
      float depth = textureLod( uBathyN, bu, 0.0 ).r;
      float shoal = 0.3 + 0.7 * smoothstep( 0.3, 8.0, depth );
      vec3 d = vec3( 0.0 );
      for ( int i = 0; i < WAVE_N; i++ ) {
        vec4 a = uWaveA[ i ];
        vec4 b = uWaveB[ i ];
        float w = smoothstep( 2.5 * spacing, 5.0 * spacing, b.w ) * near * shoal * uWaveGain;
        float th = dot( a.xy, vWaveP ) + a.w;
        float c = cos( th );
        vec2 dir = a.xy / max( length( a.xy ), 1e-6 );
        d.xz += dir * ( b.y * c * w );
        d.y += b.x * sin( th ) * w;
      }
      transformed += d;
    }
  #endif
  #ifdef WATER_RIVER
    float dist = distance( wp0, cameraPosition );
    float hwBase = aRiver.x + uMargin;
    float hwDrawn = max( hwBase, dist * uPxAngle * uMinPx * 0.5 );
    transformed.xz += aAcross * ( hwDrawn - hwBase );
    transformed.y += uLiftPerM * max( dist - 350.0, 0.0 );
    vRiver = aRiver;
    vRiver2 = vec4( aRiver2.w * hwDrawn, aRiver2.y, aRiver2.z, hwDrawn );
    vFlowDir = vec2( aAcross.y, - aAcross.x ) * aRiver2.w; // downstream (across = side · (−tz, tx))
  #endif
  #ifdef WATER_LAKE
    vLake = aLake;
  #endif
}
`;

export const WATER_WORLDPOS_VERTEX = /* glsl */ `
vWaterW = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
`;

/** After <project_vertex>: the river is pulled toward the camera (depth only) so coarse terrain never hides it. */
export const WATER_PROJECT_VERTEX = /* glsl */ `
#ifdef WATER_RIVER
{
  float dd = length( mvPosition.xyz );
  float pull = uPull * smoothstep( 250.0, 1200.0, dd );
  gl_Position = projectionMatrix * vec4( mvPosition.xyz * ( 1.0 - pull ), 1.0 );
}
#endif
`;

export const WATER_FRAGMENT_PARS = /* glsl */ `
varying vec3 vWaterW;
varying vec2 vWaveP;
uniform float uTime;
uniform vec2 uOrigin;
uniform vec4 uWaveA[ 16 ];
uniform vec4 uWaveB[ 16 ];
uniform float uWaveGain;
uniform sampler2D uDetail;
uniform vec4 uDetailL1;    // cos, sin (tile rotation), 1/tile (1/m), slope amplitude
uniform vec4 uDetailL2;
uniform vec4 uDetailOff;   // layer 1 uv offset, layer 2 uv offset
uniform float uBaseVar;    // unresolved capillary slope variance
uniform vec3 uAbsorb;      // absorption + turbidity (1/m)
uniform vec3 uDeep;        // body colour of deep water (albedo)
uniform vec3 uBed;         // bed colour (albedo)
uniform vec4 uWhitecap;    // lo, hi, amount, slick strength
uniform vec3 uSunDir;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec2 uCaustic;     // strength, unused
#ifdef WATER_SEA
  uniform sampler2D uBathyN;
  uniform vec4 uBathyNXf;  // x0, z0, 1/extent, valid
  uniform sampler2D uBathyF;
  uniform vec4 uBathyFXf;
  uniform vec2 uSurf;      // zone width (m), breaker period (s)
#endif
#ifdef WATER_LAKE
  uniform sampler2D uBathyN;
  uniform vec4 uBathyNXf;
  uniform sampler2D uBathyF;
  uniform vec4 uBathyFXf;
  varying float vLake;
  uniform vec3 uTarnDeep;
  uniform vec3 uTarnAbsorb;
#endif
#ifdef WATER_RIVER
  varying vec4 vRiver;
  varying vec4 vRiver2;
  varying vec2 vFlowDir;
  uniform vec4 uPiers[ 4 ];  // x, z (world), radius, unused
  uniform float uMargin;
#endif

vec3 wN;          // world wave normal
float wRough;     // perceptual roughness
float wOpacity;   // body opacity (0 at the waterline)
float wFoam;
float wDist;
float wCover = 1.0; // geometric coverage (river edges, mouth fade)

uint wPcg( uint v ) {
  uint s = v * 747796405u + 2891336453u;
  uint w = ( ( s >> ( ( s >> 28u ) + 4u ) ) ^ s ) * 277803737u;
  return ( w >> 22u ) ^ w;
}
float wHash( vec2 p ) { ivec2 i = ivec2( floor( p ) ); return float( wPcg( uint( i.x ) + wPcg( uint( i.y ) ) ) ) * ( 1.0 / 4294967295.0 ); }
float wNoise( vec2 p ) {
  vec2 i = floor( p ); vec2 f = p - i; vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( wHash( i ), wHash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( wHash( i + vec2( 0.0, 1.0 ) ), wHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
float wSat( float x ) { return clamp( x, 0.0, 1.0 ); }

// Gerstner trains at the (origin-relative) point p: accumulates the normal's
// −slope (x, z), 1 − Σ k s sin θ (y), the crest measure and the lost variance.
void wGerstner( vec2 p, float fw, inout vec3 n, inout float lost, inout float crest ) {
  for ( int i = 0; i < WAVE_N; i++ ) {
    vec4 a = uWaveA[ i ];
    vec4 b = uWaveB[ i ];
    float vis0 = 1.0 - smoothstep( b.w * 0.1, b.w * 0.45, fw );
    float vis = vis0 * uWaveGain;
    float th = dot( a.xy, p ) + a.w;
    float s = sin( th );
    float c = cos( th );
    float k = length( a.xy );
    n.x -= a.x * b.x * c * vis;
    n.z -= a.y * b.x * c * vis;
    float ks = k * b.y * s * vis;
    n.y -= ks;
    crest += ks;
    float kA = b.z * uWaveGain;
    lost += 0.5 * kA * kA * ( 1.0 - vis0 * vis0 );
  }
}

// One detail layer: world slope (xy), height (z); variance (LEAN) out.
vec3 wDetail( vec2 p, vec4 L, vec2 off, out float var ) {
  vec2 q = vec2( L.x * p.x + L.y * p.y, - L.y * p.x + L.x * p.y ) * L.z + off;
  vec4 t = texture( uDetail, q );
  var = max( t.z - dot( t.xy, t.xy ), 0.0 ) * L.w * L.w;
  return vec3( vec2( L.x * t.x - L.y * t.y, L.y * t.x + L.x * t.y ) * L.w, t.w );
}

#if defined( WATER_SEA ) || defined( WATER_LAKE )
// depth (m) and shore distance (m) from the two-level bathymetry clipmap
vec2 wBathy( vec2 xz ) {
  vec2 un = ( xz - uBathyNXf.xy ) * uBathyNXf.z;
  vec2 uf = ( xz - uBathyFXf.xy ) * uBathyFXf.z;
  vec2 f = texture( uBathyF, uf ).rg;
  vec2 nn = texture( uBathyN, un ).rg;
  float en = max( abs( un.x - 0.5 ), abs( un.y - 0.5 ) );
  float ef = max( abs( uf.x - 0.5 ), abs( uf.y - 0.5 ) );
  vec2 r = mix( f, nn, ( 1.0 - smoothstep( 0.36, 0.47, en ) ) * uBathyNXf.w );
  return mix( vec2( 80.0, 2000.0 ), r, ( 1.0 - smoothstep( 0.44, 0.5, ef ) ) * uBathyFXf.w );
}
#endif

#ifdef WATER_SEA
// mirror of bathymetry.ts surfFoam()
float wSurf( float depth, float dist, float t, float n ) {
  float W = uSurf.x;
  float zone = ( 1.0 - smoothstep( 0.5 * W, 1.25 * W, dist ) ) * ( 1.0 - smoothstep( 3.5, 7.0, depth ) ) * smoothstep( -0.35, 0.1, depth );
  float x = dist / ( W * 0.42 ) + t / uSurf.y + n * 0.6;
  float ph = fract( x );
  float crest = exp( - ph / 0.07 ) * ( 0.35 + 0.65 * n ) + exp( - ph / 0.3 ) * 0.25;
  float lap = exp( - pow( dist / 3.0, 2.0 ) ) * ( 0.65 + 0.35 * sin( t * 0.9 + n * 6.2831 ) );
  float f = max( crest * zone, lap * smoothstep( -0.35, 0.05, depth ) );
  return ( depth < -0.35 || depth > 7.0 || dist > 1.25 * W ) ? 0.0 : wSat( f );
}
#endif

// Bed albedo: sand with ripple marks and darker weed/rock patches (sea), mud (lakes, river).
vec3 wBedColor( vec2 p, float depth ) {
  float n1 = wNoise( p / 140.0 );
  float n2 = wNoise( p / 23.0 + 5.3 );
  vec3 bed = uBed * ( 0.8 + 0.4 * n2 );
  float weed = smoothstep( 0.55, 0.8, n1 + 0.25 * n2 ) * smoothstep( 1.5, 5.0, depth );
  return mix( bed, bed * vec3( 0.28, 0.36, 0.26 ), weed );
}

// Cheap animated caustics: bright filaments where two scrolled tile layers' heights cross zero.
float wCaustics( vec2 p ) {
  float a = texture( uDetail, p / 3.1 + vec2( uTime * 0.021, uTime * 0.013 ) ).w;
  float b = texture( uDetail, p / 2.3 - vec2( uTime * 0.017, - uTime * 0.019 ) ).w;
  float c = 1.0 - smoothstep( 0.0, 0.45, abs( a + b ) );
  return c * c;
}
`;

/** Replaces <map_fragment>: the whole surface model; sets diffuseColor (lit by three) and the globals. */
export const WATER_SURFACE_FRAGMENT = /* glsl */ `
{
  vec3 wp = vWaterW;
  vec3 toCam = cameraPosition - wp;
  wDist = length( toCam );
  vec3 V = toCam / max( wDist, 1e-3 );
  vec2 p = vWaveP;                // origin-relative (precision)
  vec2 pw = p + uOrigin;          // absolute (noise lookups at km scales)
  float fw = max( length( fwidth( vWaveP ) ), 1e-3 );

  // ── large waves ──
  vec3 ng = vec3( 0.0, 1.0, 0.0 );
  float lost = 0.0;
  float crest = 0.0;
  wGerstner( p, fw, ng, lost, crest );

  // ── small waves: wind slicks and cat's paws modulate them ──
  float slick = 0.55 + 0.9 * wNoise( pw / 1300.0 ) * wNoise( pw / 380.0 + 3.7 );
  slick = mix( 1.0, slick, uWhitecap.w );
  vec2 sd = vec2( 0.0 );
  float dvar = 0.0;
  float v1;
  float v2;
  vec3 d1;
  vec3 d2;
  #ifdef WATER_RIVER
    // flow frame: x along the flow (advected), y across
    vec2 T = normalize( vFlowDir );
    vec2 Nn = vec2( - T.y, T.x );
    vec2 fp = vec2( vRiver.z, vRiver2.x );
    d1 = wDetail( fp, vec4( 1.0, 0.0, uDetailL1.z, uDetailL1.w ), uDetailOff.xy, v1 );
    d2 = wDetail( fp * vec2( 1.0, 1.0 ) + vec2( 0.0, 0.37 ), vec4( 0.94, 0.34, uDetailL2.z, uDetailL2.w ), uDetailOff.zw, v2 );
    vec2 sl = d1.xy + d2.xy;
    sd = T * sl.x + Nn * sl.y;
    float rapids = vRiver.w;
    sd *= 1.0 + 2.2 * rapids;
    dvar = ( v1 + v2 ) * ( 1.0 + 2.2 * rapids ) * ( 1.0 + 2.2 * rapids );
  #else
    d1 = wDetail( p, uDetailL1, uDetailOff.xy, v1 );
    d2 = wDetail( p, uDetailL2, uDetailOff.zw, v2 );
    sd = ( d1.xy + d2.xy ) * slick * uWaveGain;
    dvar = ( v1 + v2 ) * slick * slick * uWaveGain * uWaveGain;
  #endif
  vec3 n = normalize( vec3( ng.x - sd.x, ng.y, ng.z - sd.y ) );

  // ── depth, shore, foam ──
  float depth = 60.0;
  float foam = 0.0;
  vec3 deep = uDeep;
  vec3 absorb = uAbsorb;
  #if defined( WATER_SEA ) || defined( WATER_LAKE )
    vec2 bz = wBathy( pw );
    depth = bz.x;
    float shoreD = bz.y;
  #endif
  #ifdef WATER_LAKE
    deep = mix( uDeep, uTarnDeep, vLake );
    absorb = mix( uAbsorb, uTarnAbsorb, vLake );
  #endif
  // a smooth 0..1 noise along the shore (coarse mip of the tile height)
  float nShore = wSat( 0.5 + 0.3 * textureLod( uDetail, pw / 830.0, 5.0 ).w );
  float foamTex = smoothstep( -0.6, 1.0, d1.z * 0.6 + d2.z * 0.5 );
  #ifdef WATER_SEA
    float surf = wSurf( depth, shoreD, uTime, nShore );
    // near the waterline the surf band gets bubbly structure
    foam = max( foam, surf * mix( 0.55, 1.0, foamTex ) );
    // sparse whitecaps on the steepest crests, patchy with the wind
    float wc = smoothstep( uWhitecap.x, uWhitecap.y, crest + 0.12 * d1.z + 0.25 * ( slick - 1.0 ) ) * uWhitecap.z;
    wc *= smoothstep( 4.0, 12.0, depth );
    foam = max( foam, wc * foamTex );
  #endif
  #ifdef WATER_LAKE
    // a thin lapping line on the shore
    foam = max( foam, exp( - pow( shoreD / 1.6, 2.0 ) ) * 0.35 * ( 0.6 + 0.4 * sin( uTime * 0.7 + nShore * 6.28 ) ) * foamTex );
  #endif
  #ifdef WATER_RIVER
    float hw = vRiver.x;
    float hwDrawn = vRiver2.w;
    float a = abs( vRiver2.x );
    // hairline rivers far away are drawn wider than they are, at the matching coverage
    bool widened = hwDrawn > hw + uMargin + 0.01;
    float hwVis = widened ? 0.9 * hwDrawn : hw;
    float u = a / max( hwVis, 1e-3 );
    depth = vRiver.y * max( 0.0, 1.0 - u * u ) + 0.05;
    float fa = max( fwidth( vRiver2.x ), 0.05 );
    wCover = ( 1.0 - smoothstep( hwVis - max( fa, 0.8 ), hwVis + fa, a ) ) * ( widened ? hw / hwVis : 1.0 );
    wCover *= vRiver2.y; // fade into the sea
    // rapids foam streaks advected with the flow
    float streak = smoothstep( 0.1, 0.9, d1.z * 0.7 + d2.z * 0.6 + 0.3 );
    foam = max( foam, vRiver.w * streak * 0.9 );
    // bridge piers: bow wave + wake downstream
    for ( int i = 0; i < 4; i++ ) {
      vec4 pr = uPiers[ i ];
      if ( pr.z <= 0.0 ) continue;
      vec2 dp = wp.xz - pr.xy;
      float al = dot( dp, T );
      float ac = dot( dp, Nn );
      float wr = pr.z + 0.12 * max( al, 0.0 );
      float wake = exp( - ac * ac / ( wr * wr ) ) * exp( - max( al, 0.0 ) / 30.0 ) * smoothstep( - pr.z * 2.2, - pr.z * 0.6, al );
      foam = max( foam, wake * ( 0.45 + 0.55 * streak ) );
    }
    // eddies and banks: slower, calmer water near the edges
    deep *= 1.0 + 0.25 * vRiver.w;
  #endif
  wFoam = wSat( foam );

  // ── the water body seen from above ──
  float NdV = max( dot( n, V ), 0.02 );
  float cosT = sqrt( 1.0 - ( 1.0 - NdV * NdV ) / 1.7689 );
  float path = max( depth, 0.0 ) * ( 1.0 + 1.0 / cosT );
  vec3 Tr = exp( - absorb * path );
  // refraction: the bed pattern wobbles with the waves
  vec2 bedP = pw + ( n.xz ) * min( max( depth, 0.0 ), 6.0 ) * 0.6;
  vec3 bed = wBedColor( bedP, depth );
  #if defined( WATER_SEA ) || defined( WATER_LAKE )
    float caus = wCaustics( bedP ) * uCaustic.x * smoothstep( 0.2, 1.5, depth ) * ( 1.0 - smoothstep( 4.0, 9.0, depth ) ) * ( 1.0 - smoothstep( 60.0, 220.0, wDist ) );
    bed *= 1.0 + 2.2 * caus;
  #endif
  vec3 body = bed * Tr + deep * ( 1.0 - exp( - ( absorb.g + 0.05 ) * path * 0.7 ) );
  // opacity of the water body: see through to the terrain only in the last few decimetres
  wOpacity = smoothstep( 0.0, 0.9, depth );
  diffuseColor.rgb = mix( body, vec3( 0.82, 0.85, 0.86 ), wFoam );

  // ── roughness from the variance nothing above resolved ──
  float v = lost + dvar + uBaseVar * mix( 1.0, slick, 0.6 ) * uWaveGain;
  float alpha = sqrt( 0.0009 + v );
  wRough = clamp( sqrt( alpha ), 0.06, 0.75 );
  wRough = mix( wRough, 0.9, wFoam );
  n = normalize( mix( n, vec3( 0.0, 1.0, 0.0 ), wFoam * 0.6 ) );
  wN = n;
}
`;

export const WATER_ROUGHNESS_FRAGMENT = /* glsl */ `
float roughnessFactor = wRough;
`;

export const WATER_NORMAL_FRAGMENT = /* glsl */ `
normal = normalize( ( viewMatrix * vec4( wN, 0.0 ) ).xyz );
`;

/** Replaces <opaque_fragment>. */
export const WATER_OPAQUE_FRAGMENT = /* glsl */ `
{
  vec3 V = normalize( cameraPosition - vWaterW );
  vec3 N = wN;
  // reflection vector, mirrored back above the horizon (a downward ray would hit the next wave's sky side)
  vec3 R = reflect( - V, N );
  R.y = abs( R.y );
  R = normalize( R + vec3( 0.0, 0.015, 0.0 ) );
  vec3 env;
  #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
    env = textureCubeUV( envMap, envMapRotation * R, wRough ).rgb * envMapIntensity;
  #else
    env = mix( uSkyHorizon, uSkyZenith, pow( wSat( R.y ), 0.45 ) );
  #endif
  vec3 nV = normalize( ( viewMatrix * vec4( N, 0.0 ) ).xyz );
  vec3 vV = normalize( vViewPosition );
  vec3 Fenv = EnvironmentBRDF( nV, vV, vec3( 0.02 ), 1.0, wRough );
  Fenv *= 1.0 - wFoam;
  vec3 spec = reflectedLight.directSpecular + Fenv * env;
  float F = Fenv.g;
  float w = max( wOpacity, wFoam );
  vec3 premul = spec + w * ( reflectedLight.directDiffuse + reflectedLight.indirectDiffuse );
  float a = 1.0 - ( 1.0 - F ) * ( 1.0 - w );
  float glint = wSat( dot( reflectedLight.directSpecular, vec3( 0.3333 ) ) * 0.3 );
  a = max( a, glint );
  gl_FragColor = vec4( premul / max( a, 1e-3 ), a * wCover );
}
`;
