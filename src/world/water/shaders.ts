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
 *
 * Lakes and rivers also reflect the LAND: the reflected ray is marched over the
 * terrain + canopy height in the bathymetry clipmap (shading.ts marchReflection,
 * same numbers), so hills, mountains and tree lines appear mirrored — crisp on
 * calm water, smeared with roughness — lit by the sun and sky and hazed over
 * the reflected path; the river first tests its own banks analytically (a tree
 * line at the water's edge, crowns from noise). The sun glint is hidden where
 * the land blocks it.
 * Rivers: channel cross-section with the thalweg on the outer bank and dry
 * point bars (gravel upstream, sand downstream) on the inner bank of bends,
 * irregular edges; clear water upstream → olive-brown sediment downstream;
 * flow lanes (calm/rippled streaks advected downstream) that show the current
 * from altitude; riffles; rapids whitewater as standing waves + moving streaks.
 * Sea: a turbid plume off the river mouth, and the player boat's wake from the wake map
 * (wakeMap.ts / wakeField.ts: wave height → vertex lift near the camera and the normal by finite
 * differences, so the Kelvin crests catch the sky and the sun; white water as lace-broken foam in
 * the sea's own foam lighting; churned, aerated water paler and rougher; a calm slick behind).
 */
import { LAND, MARCH, PROFILE, RIVER_OPTICS, glsl3, glslF } from './shading';

const O = RIVER_OPTICS;

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
  uniform sampler2D uWakeMap;
  uniform vec4 uWakeXf;
#endif
#ifdef WATER_RIVER
  attribute vec2 aAcross;
  attribute vec4 aRiver;   // halfWidth, depth, flow, foam
  attribute vec4 aRiver2;  // s, fade, speed, side
  attribute vec4 aRiver3;  // bend, turbidity, riffle, -
  varying vec4 vRiver3;
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
      // the player's wake (wakeMap.ts): its waves lift the surface near the camera
      if ( uWakeXf.w > 0.5 ) {
        vec2 wu = ( wp0.xz - uWakeXf.xy ) * uWakeXf.z;
        vec2 we = min( wu, 1.0 - wu );
        float wedge = clamp( min( we.x, we.y ) / 0.06, 0.0, 1.0 );
        // only where the grid (spacing ≈ 0.045 × distance) resolves the wake's short waves; beyond, the normal carries them
        float wres = 1.0 - smoothstep( 25.0, 60.0, length( wp0.xz - cameraPosition.xz ) );
        if ( wedge > 0.0 && wres > 0.0 ) {
          vec4 wm = textureLod( uWakeMap, wu, 0.0 );
          // half the height (the normals carry the look), none in the churned wash behind the transom
          transformed.y += wm.r * 0.5 * ( 1.0 - 0.85 * clamp( wm.b, 0.0, 1.0 ) ) * wedge * wedge * ( 3.0 - 2.0 * wedge ) * near * wres;
        }
      }
    }
  #endif
  #ifdef WATER_RIVER
    float dist = distance( wp0, cameraPosition );
    float hwBase = aRiver.x + uMargin;
    float hwDrawn = max( hwBase, dist * uPxAngle * uMinPx * 0.5 );
    transformed.xz += aAcross * ( hwDrawn - hwBase );
    transformed.y += uLiftPerM * max( dist - 350.0, 0.0 );
    vRiver = aRiver;
    vRiver3 = aRiver3;
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
// bathymetry clipmap (RGBA: depth, shore distance, land surface, land tone)
uniform sampler2D uBathyN;
uniform vec4 uBathyNXf;    // x0, z0, 1/extent, valid
uniform sampler2D uBathyF;
uniform vec4 uBathyFXf;
#ifdef WATER_SEA
  uniform sampler2D uWakeMap; // player wake: R height (m), G foam, B churn, A slick
  uniform vec4 uWakeXf;       // x0, z0, 1/extent, active
  uniform vec2 uWakeTexel;    // texel (m), 1/res
  uniform vec2 uSurf;      // zone width (m), breaker period (s)
  uniform vec4 uMouth;     // river mouth x, z, plume radius (m), strength
#endif
#ifdef WATER_LAKE
  varying float vLake;
  uniform vec3 uTarnDeep;
  uniform vec3 uTarnAbsorb;
#endif
#ifdef WATER_RIVER
  varying vec4 vRiver;
  varying vec4 vRiver2;
  varying vec4 vRiver3;
  varying vec2 vFlowDir;
  uniform vec4 uPiers[ 4 ];  // x, z (world), radius, unused
  uniform float uMargin;
  uniform float uRiverFlow;  // v_ref · t (m): the flow coordinate's advection
#endif

vec3 wN;          // world wave normal
float wRough;     // perceptual roughness
float wOpacity;   // body opacity (0 at the waterline)
float wFoam;
float wDry = 0.0; // exposed gravel / sand bar
float wDist;
float wCover = 1.0; // geometric coverage (river edges, mouth fade)
// river frame for the bank reflections
vec2 wNn = vec2( 1.0, 0.0 );
float wAcr = 0.0;
float wHw = 0.0;
bool wBankOK = false;

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
  vec2 nn = texture( uBathyN, un ).rg;  // (depth, shore)
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
vec3 wBedColor( vec2 p, float depth, vec3 tint ) {
  float n1 = wNoise( p / 140.0 );
  float n2 = wNoise( p / 23.0 + 5.3 );
  vec3 bed = tint * ( 0.8 + 0.4 * n2 );
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

/** After <clipping_planes_pars_fragment> (lights, env map and fog functions are declared by then): the land reflections. */
export const WATER_REFLECT_PARS = /* glsl */ `
#ifdef WATER_REFLECT
// land surface (m) and tone at xz: the near level where it covers, else the far one
vec2 wLandAt( vec2 xz ) {
  vec2 un = ( xz - uBathyNXf.xy ) * uBathyNXf.z;
  vec2 dn = abs( un - 0.5 );
  if ( uBathyNXf.w > 0.5 && max( dn.x, dn.y ) < 0.49 ) return textureLod( uBathyN, un, 0.0 ).ba;
  vec2 uf = ( xz - uBathyFXf.xy ) * uBathyFXf.z;
  vec2 df = abs( uf - 0.5 );
  if ( uBathyFXf.w > 0.5 && max( df.x, df.y ) < 0.5 ) return textureLod( uBathyF, uf, 0.0 ).ba;
  return vec2( -1e4, 0.0 );
}
// shading.ts landAlbedo
vec3 wLandAlbedo( float t ) {
  t = clamp( t, 0.0, 1.0 );
  if ( t < ${glslF(LAND.toneGrass)} ) return mix( ${glsl3(LAND.forest)}, ${glsl3(LAND.grass)}, t / ${glslF(LAND.toneGrass)} );
  if ( t < ${glslF(LAND.toneField)} ) return mix( ${glsl3(LAND.grass)}, ${glsl3(LAND.field)}, ( t - ${glslF(LAND.toneGrass)} ) / ${glslF(LAND.toneField - LAND.toneGrass)} );
  if ( t < ${glslF(LAND.toneRock)} ) return mix( ${glsl3(LAND.field)}, ${glsl3(LAND.rock)}, ( t - ${glslF(LAND.toneField)} ) / ${glslF(LAND.toneRock - LAND.toneField)} );
  return mix( ${glsl3(LAND.rock)}, ${glsl3(LAND.snow)}, ( t - ${glslF(LAND.toneRock)} ) / ${glslF(1 - LAND.toneRock)} );
}
// shading.ts marchReflection (+ the river's own banks first): radiance of the land seen along R, coverage in .a
vec4 wReflection( vec3 P, vec3 R, float rough ) {
  float soft = 0.014 + 1.1 * rough * rough;
  float t = ${glslF(MARCH.t0)};
  float best = -1.0;
  float bt = 0.0;
  float btone = 0.0;
  #ifdef WATER_RIVER
    if ( wBankOK ) {
      float ra = dot( R.xz, wNn );
      if ( abs( ra ) > 1e-3 ) {
        float sg = sign( ra );
        float tb = max( ( sg * wHw - wAcr ) / ra, 0.5 );
        vec3 q = P + R * tb;
        vec2 L = wLandAt( q.xz + wNn * sg * 12.0 );
        float crowns = 0.5 + 0.65 * wNoise( q.xz / 6.5 );
        float e = ( max( L.x - P.y, 0.0 ) * crowns - R.y * tb ) / tb;
        best = e;
        bt = tb;
        btone = L.y;
        t = max( t, tb * 1.2 );
      }
    }
  #endif
  // per-pixel jitter of the start: the march's coarse steps turn into fine grain instead of terraces
  t *= 1.0 + ${glslF((MARCH.growth - 1) * 0.5)} * wHash( gl_FragCoord.xy );
  if ( best <= soft ) {
    for ( int i = 0; i < ${MARCH.steps}; i++ ) {
      vec3 q = P + R * t;
      if ( q.y > ${glslF(MARCH.ceiling)} ) break;
      vec2 L = wLandAt( q.xz );
      float e = ( L.x - q.y ) / t;
      if ( e > best ) {
        best = e;
        bt = t;
        btone = L.y;
      }
      if ( e > soft ) break;
      t *= ${glslF(MARCH.growth)};
    }
  }
  // refine around the steepest sample
  if ( best > - soft && bt > 0.0 ) {
    ${MARCH.refine
      .map(
        (f) => `{
      float tt = bt * ${glslF(f)};
      vec2 L = wLandAt( P.xz + R.xz * tt );
      float e = ( L.x - P.y - R.y * tt ) / tt;
      if ( e > best ) { best = e; btone = L.y; }
    }`,
      )
      .join(' ')}
  }
  float cover = smoothstep( - soft, soft, best );
  if ( cover <= 0.0 ) return vec4( 0.0 );
  vec3 alb = wLandAlbedo( btone );
  // the slopes seen in a reflection face the water
  vec3 Nl = normalize( vec3( - R.x, 1.4, - R.z ) );
  float ndl = max( dot( Nl, uSunDir ), 0.0 );
  vec3 sunC = vec3( 0.0 );
  #if NUM_DIR_LIGHTS > 0
    sunC = directionalLights[ 0 ].color;
  #endif
  vec3 amb = uSkyHorizon * 0.35;
  #if defined( USE_ENVMAP ) && defined( ENVMAP_TYPE_CUBE_UV )
    amb = textureCubeUV( envMap, envMapRotation * vec3( 0.0, 1.0, 0.0 ), 1.0 ).rgb * envMapIntensity * 0.8;
  #endif
  vec3 c = alb * ( sunC * ndl * RECIPROCAL_PI + amb );
  #ifdef USE_FOG
    if ( atmoFog[ 0 ].w > 0.5 ) c = atmoFogApply( c, R * bt, P.y );
    else c = mix( c, fogColor, 1.0 - exp( - bt * 0.00012 ) );
  #endif
  return vec4( c, cover );
}
#endif
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

  // ── the player's wake (wake map): its wave slopes, white water, churn and slick ──
  float wkFoam = 0.0;
  float wkChurn = 0.0;
  float wkSlick = 0.0;
  #ifdef WATER_SEA
    if ( uWakeXf.w > 0.5 ) {
      vec2 wu = ( pw - uWakeXf.xy ) * uWakeXf.z;
      vec2 we = min( wu, 1.0 - wu );
      float wedge = wSat( min( we.x, we.y ) / 0.06 );
      if ( wedge > 0.0 ) {
        wedge = wedge * wedge * ( 3.0 - 2.0 * wedge );
        vec4 wc0 = textureLod( uWakeMap, wu, 0.0 );
        // slopes over a 4-texel span (~2 m): the wake's swells stay soft, never a creased fold
        float tx = 2.0 * uWakeTexel.y;
        float hx1 = textureLod( uWakeMap, wu + vec2( tx, 0.0 ), 0.0 ).r;
        float hx0 = textureLod( uWakeMap, wu - vec2( tx, 0.0 ), 0.0 ).r;
        float hz1 = textureLod( uWakeMap, wu + vec2( 0.0, tx ), 0.0 ).r;
        float hz0 = textureLod( uWakeMap, wu - vec2( 0.0, tx ), 0.0 ).r;
        vec2 grad = vec2( hx1 - hx0, hz1 - hz0 ) / ( 4.0 * uWakeTexel.x );
        grad = clamp( grad, vec2( -0.8 ), vec2( 0.8 ) );
        // slopes the pixel can resolve go into the normal, the rest into roughness
        float wres = 1.0 - smoothstep( 2.0 * uWakeTexel.x, 8.0 * uWakeTexel.x, fw );
        ng.x -= grad.x * wedge * wres;
        ng.z -= grad.y * wedge * wres;
        lost += 0.5 * dot( grad, grad ) * wedge * ( 1.0 - wres );
        wkFoam = wSat( wc0.g ) * wedge;
        wkChurn = wSat( wc0.b ) * wedge;
        wkSlick = wSat( wc0.a ) * wedge;
        // the propeller wash boils: churned water is covered in short, steep, restless ripples (two
        // layers of noise slopes drifting against each other, so it seethes rather than scrolls).
        // The smooth swell underneath never reads as a bent sheet. Resolved slopes go into the
        // normal; far away, where a pixel spans many ripples, they become roughness.
        float tb = max( wkChurn, 0.8 * wkFoam );
        if ( tb > 0.01 ) {
          float tres = 1.0 - smoothstep( 0.12, 0.7, fw );
          vec2 q1 = pw * 1.35 + vec2( uTime * 0.55, - uTime * 0.35 );
          vec2 q2 = pw * 3.1 - vec2( uTime * 0.8, uTime * 0.6 );
          const float e = 0.35;
          float n1 = wNoise( q1 );
          float n2 = wNoise( q2 );
          vec2 g1 = vec2( wNoise( q1 + vec2( e, 0.0 ) ) - n1, wNoise( q1 + vec2( 0.0, e ) ) - n1 ) / e;
          vec2 g2 = vec2( wNoise( q2 + vec2( e, 0.0 ) ) - n2, wNoise( q2 + vec2( 0.0, e ) ) - n2 ) / e;
          vec2 tg = ( g1 * 0.55 + g2 * 0.45 ) * 0.42 * tb;
          ng.x -= tg.x * tres;
          ng.z -= tg.y * tres;
          lost += ( 0.06 + 0.5 * dot( tg, tg ) * ( 1.0 - tres ) ) * tb;
        }
      }
    }
  #endif

  // ── depth / shore (sea, lakes) ──
  float depth = 60.0;
  float foam = 0.0;
  vec3 deep = uDeep;
  vec3 absorb = uAbsorb;
  vec3 bedTint = uBed;
  float shoreD = 2000.0;
  #if defined( WATER_SEA ) || defined( WATER_LAKE )
    vec2 bz = wBathy( pw );
    depth = bz.x;
    shoreD = bz.y;
  #endif

  // ── small waves: wind slicks and cat's paws modulate them ──
  float slick = 0.55 + 0.9 * wNoise( pw / 1300.0 ) * wNoise( pw / 380.0 + 3.7 );
  slick = mix( 1.0, slick, uWhitecap.w );
  #ifdef WATER_LAKE
    // cat's paws drifting downwind: glassy patches between rippled ones; the lee of the shore is calm
    float paw = wNoise( pw / 240.0 + uTime * vec2( 0.006, 0.004 ) ) * 0.65 + wNoise( pw / 70.0 - uTime * vec2( 0.012, 0.0 ) ) * 0.35;
    slick = mix( 0.1, 1.4, smoothstep( 0.3, 0.72, paw ) ) * mix( 0.35, 1.0, smoothstep( 15.0, 180.0, shoreD ) );
  #endif
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
    float acr = vRiver2.x;
    float flowS = vRiver.z;                 // stationary along-channel coordinate (m)
    float flowT = flowS - uRiverFlow;       // advected with the current
    float rapids = vRiver.w;
    float riffle = vRiver3.z;
    // lanes: calm and rippled streaks drifting downstream — the current made visible
    float lane = wNoise( vec2( flowT / 42.0, acr / 6.0 + 17.0 ) ) * 0.7 + wNoise( vec2( flowT / 13.0 + 5.0, acr / 2.3 ) ) * 0.3;
    vec2 fp = vec2( flowS, acr );
    d1 = wDetail( fp, vec4( 0.956, 0.292, uDetailL1.z, uDetailL1.w ), uDetailOff.xy, v1 );
    d2 = wDetail( fp + vec2( 0.0, 0.37 ), vec4( 0.819, -0.574, uDetailL2.z, uDetailL2.w ), uDetailOff.zw, v2 );
    // a third, larger layer (not advected, rotated 60°) and separate amplitude patches per layer
    // hide the tiles' periodicity in the sun glitter
    float v3;
    vec3 d3 = wDetail( fp * 0.43 + vec2( 3.1, 0.0 ), vec4( 0.5, 0.866, uDetailL1.z, uDetailL1.w * 0.8 ), vec2( 0.0 ), v3 );
    float m1 = 0.35 + 1.3 * wNoise( fp / 17.0 + 4.0 );
    float m2 = 0.35 + 1.3 * wNoise( fp / 11.0 - 9.0 );
    vec2 sl = d1.xy * m1 + d2.xy * m2 + d3.xy * ( 1.6 - 0.5 * ( m1 + m2 ) );
    float rip = ( 0.25 + 1.1 * smoothstep( 0.25, 0.75, lane ) ) * ( 1.0 + 1.4 * riffle ) * ( 1.0 + 2.2 * rapids );
    sd = ( T * sl.x + Nn * sl.y ) * rip * 0.8;
    dvar = ( v1 * m1 * m1 + v2 * m2 * m2 + v3 ) * rip * rip * 0.64;
  #else
    d1 = wDetail( p, uDetailL1, uDetailOff.xy, v1 );
    d2 = wDetail( p, uDetailL2, uDetailOff.zw, v2 );
    sd = ( d1.xy + d2.xy ) * slick * uWaveGain;
    dvar = ( v1 + v2 ) * slick * slick * uWaveGain * uWaveGain;
    // the wake's slick: the turbulence has flattened the ripples; churned water is rough and broken
    float wkCalm = 1.0 - 0.7 * wkSlick * ( 1.0 - wkChurn );
    sd *= wkCalm;
    dvar = dvar * wkCalm * wkCalm + 0.02 * wkChurn;
  #endif
  vec3 n = normalize( vec3( ng.x - sd.x, ng.y, ng.z - sd.y ) );

  // ── foam ──
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
    // the wake's white water: the lace in the map, broken up finer here (bubbles, the tile's ripples)
    float wkMicro = mix( 0.5, wNoise( pw * 2.7 ) * 0.6 + wNoise( pw * 6.3 + 1.7 ) * 0.4, 1.0 - smoothstep( 0.08, 0.35, fw ) );
    float wkF = wkFoam * ( 0.55 + 0.5 * foamTex + 0.5 * wkMicro );
    foam = max( foam, smoothstep( 0.08, 0.75, wkF ) * ( 0.6 + 0.4 * wkFoam ) );
    // aerated water under the churn: pale turquoise, glowing with scattered light
    deep = mix( deep, vec3( 0.03, 0.12, 0.12 ), wkChurn * ( 1.0 - 0.5 * wkFoam ) );
    absorb = mix( absorb, vec3( 0.3, 0.07, 0.07 ), wkChurn );
    // the river's sediment plume off the mouth
    float plume = uMouth.w * exp( - length( pw - uMouth.xy ) / uMouth.z ) * ( 0.5 + 0.5 * wNoise( pw / 170.0 + vec2( uTime * 0.008, 0.0 ) ) );
    deep = mix( deep, ${glsl3(O.turbidDeep)}, plume );
    absorb = mix( absorb, ${glsl3(O.turbidAbsorb)}, plume );
  #endif
  #ifdef WATER_LAKE
    // a thin lapping line on the shore
    foam = max( foam, exp( - pow( shoreD / 1.6, 2.0 ) ) * 0.35 * ( 0.6 + 0.4 * sin( uTime * 0.7 + nShore * 6.28 ) ) * foamTex );
  #endif
  #ifdef WATER_RIVER
    float hw = vRiver.x;
    float hwDrawn = vRiver2.w;
    float a = abs( acr );
    // hairline rivers far away are drawn wider than they are, at the matching coverage
    bool widened = hwDrawn > hw + uMargin + 0.01;
    float hwVis = widened ? 0.9 * hwDrawn : hw;
    float u = acr / max( hwVis, 1e-3 );
    // shading.ts riverProfile: thalweg on the outer bank, point bar on the inner, irregular edges
    float bnd = widened ? 0.0 : clamp( vRiver3.x, -1.0, 1.0 );
    float ab = abs( bnd );
    float uu = clamp( u, -1.2, 1.2 );
    float u0 = - ${glslF(PROFILE.thalweg)} * bnd;
    bool inner = ( uu - u0 ) * bnd > 0.0;
    float xq = wSat( uu >= u0 ? ( uu - u0 ) / max( 1.0 - u0, 1e-3 ) : ( u0 - uu ) / max( 1.0 + u0, 1e-3 ) );
    float prof = inner ? pow( 1.0 - xq, 1.0 + 0.8 * ab ) : 1.0 - pow( xq, 2.0 + 1.5 * ab );
    float edgeN = widened ? 0.0 : wNoise( vec2( flowS / 55.0, sign( acr ) * 7.3 ) ) * 0.7 + wNoise( vec2( flowS / 13.0, sign( acr ) * 3.1 ) ) * 0.3;
    float lift = ( inner ? ${glslF(PROFILE.bar)} * ab : 0.0 ) + ${glslF(PROFILE.edge)} * smoothstep( 0.5, 0.9, edgeN ) * smoothstep( 0.55, 1.0, abs( uu ) );
    depth = vRiver.y * ( prof - lift ) + 0.05;
    wDry = smoothstep( 0.02, -0.12, depth );
    float fa = max( fwidth( acr ), 0.05 );
    wCover = ( 1.0 - smoothstep( hwVis - max( fa, 0.8 ), hwVis + fa, a ) ) * ( widened ? hw / hwVis : 1.0 );
    wCover *= vRiver2.y; // fade into the sea
    // optics from turbidity (shading.ts riverOptics)
    float turb = vRiver3.y;
    absorb = mix( ${glsl3(O.clearAbsorb)}, ${glsl3(O.turbidAbsorb)}, turb );
    deep = mix( ${glsl3(O.clearDeep)}, ${glsl3(O.turbidDeep)}, turb );
    bedTint = mix( ${glsl3(O.gravelBed)}, ${glsl3(O.mudBed)}, turb );
    // aerated water in riffles and rapids is paler and greener
    deep = mix( deep, vec3( 0.05, 0.075, 0.06 ), wSat( 0.5 * riffle + 0.8 * rapids ) );
    // rapids: a step-pool torrent — whitewater boils below each drop and trails into the pool,
    // broken up by standing waves and streaks moving with the flow (shading.ts riverWhitewater)
    float stepL = max( 14.0, 2.2 * hw );
    float phase = fract( flowS / stepL + 0.45 * wNoise( vec2( flowS / 70.0, acr / 10.0 + 3.0 ) ) );
    float fade1 = 1.0 - smoothstep( 1.5, 5.0, fw );   // unresolved noise → its mean
    float standing = wNoise( vec2( flowS / 9.0, acr / 5.0 ) ) * 0.6 + mix( 0.5, wNoise( vec2( flowS / 2.6, acr / 1.7 ) ), fade1 ) * 0.4;
    float streakN = mix( 0.45, wNoise( vec2( flowT / 7.0, acr / 1.1 ) ), fade1 );
    float rr = wSat( rapids );
    // a drop spans part of the channel (chutes between boulders), never a straight line bank to bank
    float chute = smoothstep( 0.2, 0.55, wNoise( vec2( floor( flowS / stepL ) * 1.7, acr / max( 0.6 * hw, 3.0 ) ) ) );
    float drop = exp( - phase / ( 0.1 + 0.18 * rr ) ) * chute;
    float ww = drop * ( 0.3 + 0.7 * standing ) + streakN * 0.3 * rr;
    float thr = 0.72 - 0.25 * rr;
    float white = smoothstep( thr, thr + 0.3, ww ) * smoothstep( 0.05, 0.3, rr );
    // fibrous, bubbly texture inside the whitewater
    white *= mix( 0.55, 1.0, mix( 0.6, foamTex, fade1 ) );
    foam = max( foam, white );
    // boulders breaking the surface, a pillow of foam just downstream of each
    float rock = smoothstep( 0.85, 0.89, wNoise( vec2( flowS / 3.2, acr / 2.4 ) ) ) * smoothstep( 0.25, 0.6, rr );
    float rockUp = smoothstep( 0.8, 0.87, wNoise( vec2( ( flowS - 2.0 ) / 3.2, acr / 2.4 ) ) ) * smoothstep( 0.25, 0.6, rr );
    foam = max( foam, rockUp * ( 1.0 - rock ) * mix( 0.6, 1.0, foamTex ) );
    float wRock = rock * fade1;
    // bubble lines trailing the rapids, drifting with the current
    float fl = mix( 0.5, wNoise( vec2( flowT / 24.0, acr / 0.8 ) ), fade1 );
    foam = max( foam, smoothstep( 0.8, 0.96, fl ) * 0.4 * smoothstep( 0.1, 0.5, rr ) );
    // bridge piers: bow wave + wake downstream
    for ( int i = 0; i < 4; i++ ) {
      vec4 pr = uPiers[ i ];
      if ( pr.z <= 0.0 ) continue;
      vec2 dp = wp.xz - pr.xy;
      float al = dot( dp, T );
      float ac = dot( dp, Nn );
      float wr = pr.z + 0.12 * max( al, 0.0 );
      float wake = exp( - ac * ac / ( wr * wr ) ) * exp( - max( al, 0.0 ) / 30.0 ) * smoothstep( - pr.z * 2.2, - pr.z * 0.6, al );
      foam = max( foam, wake * ( 0.45 + 0.55 * foamTex ) );
    }
    foam *= 1.0 - wDry;
    // for the bank reflections
    wNn = Nn;
    wAcr = acr;
    wHw = hw;
    wBankOK = ! widened;
  #endif
  wFoam = wSat( foam );

  // ── the water body seen from above ──
  float NdV = max( dot( n, V ), 0.02 );
  float cosT = sqrt( 1.0 - ( 1.0 - NdV * NdV ) / 1.7689 );
  float path = max( depth, 0.0 ) * ( 1.0 + 1.0 / cosT );
  vec3 Tr = exp( - absorb * path );
  // refraction: the bed pattern wobbles with the waves
  vec2 bedP = pw + ( n.xz ) * min( max( depth, 0.0 ), 6.0 ) * 0.6;
  vec3 bed = wBedColor( bedP, depth, bedTint );
  #if defined( WATER_SEA ) || defined( WATER_LAKE )
    float caus = wCaustics( bedP ) * uCaustic.x * smoothstep( 0.2, 1.5, depth ) * ( 1.0 - smoothstep( 4.0, 9.0, depth ) ) * ( 1.0 - smoothstep( 60.0, 220.0, wDist ) );
    bed *= 1.0 + 2.2 * caus;
  #endif
  vec3 body = bed * Tr + deep * ( 1.0 - exp( - ( absorb.g + 0.05 ) * path * 0.7 ) );
  // opacity of the water body: see through to the terrain only in the last few decimetres
  #ifdef WATER_RIVER
    wOpacity = smoothstep( -0.05, 0.08, depth ); // opaque: the ribbon's own edge fades into the bank
  #else
    wOpacity = smoothstep( 0.0, 0.9, depth );
  #endif
  diffuseColor.rgb = mix( body, vec3( 0.74, 0.77, 0.78 ), wFoam );
  #ifdef WATER_RIVER
    // exposed bars: gravel upstream, sand downstream, pebbly, dark and wet at the waterline
    vec3 barC = mix( ${glsl3(O.gravelBar)}, ${glsl3(O.sandBar)}, turb );
    float peb = mix( 0.5, wNoise( pw / 0.9 ), 1.0 - smoothstep( 0.3, 1.2, fw ) ) * 0.45 + wNoise( pw / 4.0 + 3.0 ) * 0.35 + wNoise( pw / 17.0 ) * 0.2;
    barC *= 0.7 + 0.55 * peb;
    // willow scrub and grass on the higher, older part of the bar; drift lines of dark wet sediment
    float scrub = smoothstep( 0.55, 0.75, wNoise( pw / 9.0 + 11.0 ) * 0.7 + wNoise( pw / 2.5 ) * 0.3 ) * smoothstep( -0.25, -0.8, depth );
    barC = mix( barC, vec3( 0.05, 0.075, 0.03 ), scrub * 0.85 );
    barC *= mix( 0.5, 1.0, smoothstep( -0.02, -0.4, depth ) );
    diffuseColor.rgb = mix( diffuseColor.rgb, barC, wDry );
    // wet dark boulders in the rapids
    diffuseColor.rgb = mix( diffuseColor.rgb, vec3( 0.07, 0.068, 0.062 ) * ( 0.7 + 0.6 * peb ), wRock );
    wDry = max( wDry, wRock );
  #endif

  // ── roughness from the variance nothing above resolved ──
  #ifdef WATER_LAKE
    lost *= min( slick, 1.0 );
  #endif
  float v = lost + dvar + uBaseVar * mix( 1.0, slick, 0.6 ) * uWaveGain;
  float alpha = sqrt( 0.0009 + v );
  wRough = clamp( sqrt( alpha ), 0.06, 0.75 );
  wRough = mix( wRough, 0.9, max( wFoam, wDry ) );
  n = normalize( mix( n, vec3( 0.0, 1.0, 0.0 ), max( wFoam * 0.6, wDry ) ) );
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
  float landCover = 0.0;
  #ifdef WATER_REFLECT
    if ( wDry < 0.99 ) {
      vec4 land = wReflection( vWaterW, R, wRough );
      env = mix( env, land.rgb, land.a );
      landCover = land.a;
    }
  #endif
  vec3 nV = normalize( ( viewMatrix * vec4( N, 0.0 ) ).xyz );
  vec3 vV = normalize( vViewPosition );
  vec3 Fenv = EnvironmentBRDF( nV, vV, vec3( 0.02 ), 1.0, wRough );
  Fenv *= 1.0 - max( wFoam, wDry );
  vec3 spec = reflectedLight.directSpecular * ( 1.0 - landCover ) + Fenv * env;
  float F = Fenv.g;
  float w = max( max( wOpacity, wFoam ), wDry );
  vec3 premul = spec + w * ( reflectedLight.directDiffuse + reflectedLight.indirectDiffuse );
  float a = 1.0 - ( 1.0 - F ) * ( 1.0 - w );
  float glint = wSat( dot( reflectedLight.directSpecular, vec3( 0.3333 ) ) * 0.3 );
  a = max( a, glint );
  gl_FragColor = vec4( premul / max( a, 1e-3 ), a * wCover );
}
`;
