/**
 * The road surface material: MeshStandardMaterial extended with onBeforeCompile
 * (three's PBR lighting, shadows, reversed/log depth and the global atmospheric
 * fog chunks all stay intact). Everything is procedural from the ribbon
 * attributes (ribbon.ts header):
 *  - asphalt: grain, per-section resurfacing tone, mottling, darker tyre paths
 *    and oil line, patches, sealed and open cracks (detail fades with the
 *    pixel footprint → no shimmer at distance);
 *  - markings generated from markings.ts (box-filtered lines and dashes →
 *    crisp at 20 m, alias-free at 2 km), crosswalks + stop bars at town
 *    junctions;
 *  - kerbs, sidewalks with slab joints, gravel shoulders, dirt farm tracks
 *    with ruts and a grass middle strip, a soft verge (alpha-to-coverage, so it
 *    stays opaque and depth-sorted);
 *  - structures (kind 6: bridges, guard rails) from a small palette;
 *  - vertex: LOD lift + depth pull (depth.ts), near/far LOD split per fragment.
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';
import { DEPTH_GLSL, lodLiftArray } from './depth';
import { markingLines, junctionMarks, laneWidth, type MarkLine } from './markings';
import { KIND_BY_ID } from './plan';

export interface RoadMaterials {
  near: THREE.MeshStandardMaterial;
  far: THREE.MeshStandardMaterial;
  /** Shared uniforms (update per frame). */
  uniforms: {
    uNearR: { value: number };
    uStreetR: { value: number };
    uLodLift: { value: number[] };
    uDepthPull: { value: number };
  };
  dispose(): void;
}

function replaceOnce(src: string, find: string, repl: string): string {
  if (!src.includes(find)) throw new Error(`road material: shader chunk ${find} not found`);
  return src.replace(find, repl);
}

const f = (x: number): string => {
  const s = x.toFixed(4);
  return s.includes('.') ? s : `${s}.0`;
};

/** GLSL body painting the lines of one kind: accumulates `pw` (white) / `py` (yellow). */
function linesGLSL(lines: MarkLine[]): string {
  return lines
    .map((l) => {
      const cov = `bandCov( ac, ${f(l.offset - l.halfWidth)}, ${f(l.offset + l.halfWidth)}, fwA )`;
      const dash = l.dash > 0 ? ` * dashCov( al, ${f(l.dash)}, ${f(l.period)}, fwL )` : '';
      const keep = l.role === 'edge' ? 'keepEdge' : 'keepCentre';
      const target = l.color === 'white' ? 'pw' : 'py';
      return `    ${target} = max( ${target}, ${cov}${dash} * ${keep} );`;
    })
    .join('\n');
}

/** Per kind marking code (street: plain + arterial variants). */
export function markingsGLSL(): string {
  const out: string[] = [];
  KIND_BY_ID.forEach((kind, id) => {
    // widths vary per road only for streets/roads; lines depend on kind + (arterial) and the paved half width
    const std = markingLines(kind, kind === 'highway' ? 11 : 7, false);
    if (kind === 'street') {
      const art = markingLines(kind, 10, true);
      out.push(`  if ( kindId == ${id}.0 && arterial ) {\n${linesGLSL(art)}\n  }`);
    } else if (std.length) {
      // lines at fixed offsets except the edge lines of roads, placed from the paved half width
      if (kind === 'road' || kind === 'access') {
        const centre = std.filter((l) => l.role === 'centre');
        out.push(
          `  if ( kindId == ${id}.0 ) {\n${linesGLSL(centre)}\n    float eo = min( hw - 0.25, ${f(laneWidth(kind, 7))} + 0.075 );\n    pw = max( pw, ( bandCov( ac, -eo - 0.075, -eo + 0.075, fwA ) + bandCov( ac, eo - 0.075, eo + 0.075, fwA ) ) * keepEdge );\n  }`,
        );
      } else out.push(`  if ( kindId == ${id}.0 ) {\n${linesGLSL(std)}\n  }`);
    }
  });
  return out.join('\n');
}

export function createRoadMaterials(): RoadMaterials {
  const rc = CONFIG.world.towns.roads;
  const uniforms = {
    uNearR: { value: rc.nearDistance },
    uStreetR: { value: rc.streetViewDistance },
    uLodLift: { value: lodLiftArray(rc) },
    uDepthPull: { value: rc.depthPull },
  };
  const jm = junctionMarks(1, 0);
  const make = (far: boolean): THREE.MeshStandardMaterial => {
    const m = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9, metalness: 0, fog: true });
    m.name = far ? 'roads-far' : 'roads-near';
    m.alphaToCoverage = true;
    m.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);
      shader.defines = { ...(shader.defines ?? {}), ...(far ? { ROAD_FAR: '' } : {}) };
      let v = shader.vertexShader;
      v = replaceOnce(v, '#include <common>', `#include <common>\n${VERTEX_PARS}`);
      v = replaceOnce(v, '#include <begin_vertex>', VERTEX_BEGIN);
      v = replaceOnce(v, '#include <project_vertex>', VERTEX_PROJECT);
      shader.vertexShader = v;
      let fs = shader.fragmentShader;
      fs = replaceOnce(fs, '#include <common>', `#include <common>\n${FRAGMENT_PARS}`);
      fs = replaceOnce(fs, '#include <map_fragment>', fragmentSurface(jm.cw0 - 1, jm.bar, jm.barPeriod));
      fs = replaceOnce(fs, '#include <roughnessmap_fragment>', 'float roughnessFactor = roadRough;');
      fs = replaceOnce(fs, '#include <metalnessmap_fragment>', 'float metalnessFactor = roadMetal;');
      shader.fragmentShader = fs;
    };
    m.customProgramCacheKey = () => (far ? 'roads-far-v1' : 'roads-near-v1');
    return m;
  };
  const near = make(false);
  const far = make(true);
  return {
    near,
    far,
    uniforms,
    dispose() {
      near.dispose();
      far.dispose();
    },
  };
}

// ─── GLSL ─────────────────────────────────────────────────────────────────────

const VERTEX_PARS = /* glsl */ `
attribute vec4 aRoad;
attribute vec4 aJunc;
attribute vec2 aJunc2;
varying vec4 vRoad;
varying vec4 vJunc;
varying vec2 vJunc2;
varying vec3 vRoadWorld;
${DEPTH_GLSL}
`;

const VERTEX_BEGIN = /* glsl */ `
vec3 transformed = vec3( position );
vRoad = aRoad;
vJunc = aJunc;
vJunc2 = aJunc2;
{
  vec3 wp = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;
  vRoadWorld = wp;
  float kindId = mod( aRoad.w, 8.0 );
  transformed.y += roadLodLift( kindId >= 6.0 ? 4.0 : kindId, distance( wp, cameraPosition ) );
}
`;

const VERTEX_PROJECT = /* glsl */ `
vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
gl_Position = projectionMatrix * roadPull( mvPosition );
`;

const FRAGMENT_PARS = /* glsl */ `
varying vec4 vRoad;
varying vec4 vJunc;
varying vec2 vJunc2;
varying vec3 vRoadWorld;
uniform float uNearR;
uniform float uStreetR;
float roadRough = 0.9;
float roadMetal = 0.0;

float rHash( vec2 p ) {
  p = fract( p * vec2( 123.34, 456.21 ) );
  p += dot( p, p + 45.32 );
  return fract( p.x * p.y );
}
float rNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 g = fract( p );
  vec2 u = g * g * ( 3.0 - 2.0 * g );
  return mix( mix( rHash( i ), rHash( i + vec2( 1.0, 0.0 ) ), u.x ), mix( rHash( i + vec2( 0.0, 1.0 ) ), rHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}
// box-filtered coverage of [a, b] by a footprint fw centred at x (markings.ts bandCoverage)
float bandCov( float x, float a, float b, float fw ) {
  return clamp( ( min( x + fw * 0.5, b ) - max( x - fw * 0.5, a ) ) / fw, 0.0, 1.0 );
}
float pulseInt( float t, float on, float period ) {
  float k = floor( t / period );
  return k * on + min( t - k * period, on );
}
// box-filtered pulse train (markings.ts dashCoverage)
float dashCov( float t, float on, float period, float fw ) {
  return ( pulseInt( t + fw * 0.5, on, period ) - pulseInt( t - fw * 0.5, on, period ) ) / fw;
}
// thin line of half width w around 0, filtered; fades out (to its mean) when sub-pixel
float thinLine( float x, float w, float fw ) {
  return bandCov( x, -w, w, fw );
}
`;

function fragmentSurface(_cwPad: number, bar: number, barPeriod: number): string {
  return /* glsl */ `
  float kindId = mod( vRoad.w, 8.0 );
  float flags = mod( floor( vRoad.w / 8.0 ), 8.0 );
  float camDist = distance( vRoadWorld, cameraPosition );
#ifdef ROAD_FAR
  if ( camDist < uNearR ) discard;
  if ( kindId == 4.0 && camDist > uStreetR ) discard;
#else
  if ( camDist > uNearR ) discard;
#endif
  vec3 col;
  float alpha = 1.0;
  if ( kindId >= 6.0 ) {
    // ── structures: palette by material id ──
    vec2 uv = vRoad.xy;
    float n = rNoise( uv * 0.7 ) * 0.6 + rNoise( uv * 3.1 ) * 0.4;
    if ( flags < 0.5 ) {        // concrete
      col = vec3( 0.30, 0.29, 0.27 ) * ( 0.82 + 0.3 * n );
      col *= 1.0 - 0.25 * smoothstep( 0.55, 0.9, rNoise( uv * vec2( 0.4, 2.5 ) ) ); // streaks
      roadRough = 0.88;
    } else if ( flags < 1.5 ) { // galvanised steel (guard rails, railings)
      col = vec3( 0.46, 0.47, 0.49 ) * ( 0.85 + 0.25 * n );
      roadRough = 0.42;
      roadMetal = 0.75;
    } else if ( flags < 2.5 ) { // dark painted steel
      col = vec3( 0.06, 0.07, 0.075 ) * ( 0.9 + 0.2 * n );
      roadRough = 0.6;
      roadMetal = 0.3;
    } else if ( flags < 3.5 ) { // weathered concrete (piers in water, abutments)
      col = vec3( 0.24, 0.23, 0.21 ) * ( 0.75 + 0.35 * n );
      roadRough = 0.92;
    } else {                    // earth / rip-rap stone
      col = mix( vec3( 0.16, 0.15, 0.13 ), vec3( 0.28, 0.27, 0.25 ), n );
      roadRough = 0.95;
    }
  } else {
    float ac = vRoad.x;
    float al = vRoad.y;
    float hw = vRoad.z;
    float aa = abs( ac );
    float fwA = max( fwidth( ac ), 1e-4 );
    float fwL = max( fwidth( al ), 1e-4 );
    float alW = mod( al, 997.0 );
    float swW = floor( vRoad.w / 64.0 ) * 0.1;
    bool sidewalk = mod( flags, 2.0 ) > 0.5;
    bool arterial = mod( floor( flags / 2.0 ), 2.0 ) > 0.5;
    bool embank = flags >= 4.0;
    // detail visibility by footprint (1 = crisp, 0 = averaged away)
    float det2 = 1.0 - smoothstep( 0.02, 0.07, fwL );   // cm features (cracks)
    float det1 = 1.0 - smoothstep( 0.15, 0.6, fwL );    // dm features (grain, joints)
    float det0 = 1.0 - smoothstep( 1.0, 4.0, fwL );     // m features (patches)

    // ── junctions: both ends (d, h, y) ──
    float keepEdge = 1.0;
    float keepCentre = 1.0;
    float pw = 0.0;
    float py = 0.0;
    float swGap = 0.0;
    float townMark = 0.0;
    for ( int e = 0; e < 2; e++ ) {
      float jd = e == 0 ? vJunc.x : vJunc.y;
      float jh = e == 0 ? vJunc.z : vJunc.w;
      float jy = e == 0 ? vJunc2.x : vJunc2.y;
      float side = e == 0 ? -1.0 : 1.0;
      if ( jh == 0.0 ) continue;
      bool cut = jy > 50.0;
      if ( cut ) jy -= 100.0;
      float ah = abs( jh );
      // edge lines break at every junction; everything stops before a town crosswalk
      keepEdge *= smoothstep( ah + 0.3, ah + 0.6, jd );
      // outside the paved edge (sidewalk, shoulder, verge): yield to the crossing road
      if ( jd < ah + ( cut ? jy : 0.0 ) ) swGap = 1.0;
      if ( jh > 0.0 ) {
        float cw0 = ah + 0.5;
        float cw1 = cw0 + max( 2.4, jy - 0.4 );
        float stop1 = cw1 + 1.05;
        float k = smoothstep( stop1 + 0.2, stop1 + 0.5, jd );
        keepEdge *= k;
        keepCentre *= k;
        float inner = hw - 0.25;
        float cw = bandCov( jd, cw0, cw1, fwL ) * dashCov( ac + inner, ${f(bar)}, ${f(barPeriod)}, fwA ) * bandCov( ac, -inner, inner, fwA );
        float stopBar = bandCov( jd, cw1 + 0.6, stop1, fwL ) * bandCov( ac * side, 0.15, inner, fwA );
        townMark = max( townMark, max( cw, stopBar ) );
      }
    }
    if ( aa > hw && swGap > 0.5 ) discard;

    // ── asphalt ──
    float blk = floor( al / 230.0 );
    float tone = rHash( vec2( blk, kindId * 7.0 + 3.0 ) );
    if ( kindId == 3.0 ) tone = 0.55 + 0.45 * tone;             // old country lanes: greyer
    vec3 asph = mix( vec3( 0.052, 0.052, 0.054 ), vec3( 0.118, 0.114, 0.108 ), tone );
    vec2 q = vec2( alW, ac );
    asph *= 0.86 + 0.28 * rNoise( q * vec2( 0.045, 0.22 ) );
    asph *= 1.0 + ( rNoise( q * 7.0 ) - 0.5 ) * 0.22 * det1;    // aggregate grain
    // tyre paths (darker, polished) and the oil line in each lane's centre
    float lw = kindId == 0.0 ? ${f(laneWidth('highway', 11))} : ( kindId == 1.0 || kindId == 2.0 ) ? min( 3.3, hw - 0.2 ) : hw;
    float lc = abs( aa - lw * 0.5 );
    float wheel = exp( -pow( ( lc - 0.85 ) / 0.32, 2.0 ) );
    float oil = exp( -pow( lc / 0.28, 2.0 ) );
    asph *= 1.0 - ( 0.13 * wheel + 0.12 * oil ) * det0;
    // patches (fresh, darker, crisp-edged)
    vec2 pc = floor( vec2( alW / 9.0, ( ac + 20.0 ) / 2.6 ) );
    float ph = rHash( pc + blk * 0.37 );
    if ( ph < ( kindId == 3.0 ? 0.2 : 0.08 ) ) {
      vec2 pf = vec2( fract( alW / 9.0 ), fract( ( ac + 20.0 ) / 2.6 ) );
      vec2 r0 = 0.1 + 0.3 * vec2( rHash( pc + 1.3 ), rHash( pc + 2.7 ) );
      vec2 r1 = 0.6 + 0.3 * vec2( rHash( pc + 4.1 ), rHash( pc + 5.9 ) );
      float inP = bandCov( pf.x, r0.x, r1.x, fwL / 9.0 ) * bandCov( pf.y, r0.y, r1.y, fwA / 2.6 );
      asph = mix( asph, vec3( 0.045, 0.045, 0.047 ) * ( 0.9 + 0.2 * rNoise( q * 3.0 ) ), inP * det0 );
    }
    // cracks: sealed (tar snakes) along joints + random transverse; open hairline cracks
    float mean = 0.0;
    float crack = 0.0;
    {
      float wob = ( rNoise( vec2( alW * 0.35, 1.7 ) ) - 0.5 ) * 0.25;
      float tar = thinLine( ac - wob - 0.02, 0.025, fwA ) * step( 0.45, rNoise( vec2( alW * 0.04, 9.0 ) ) );
      float cell = floor( alW / 11.0 );
      float tpos = ( rHash( vec2( cell, 3.3 ) ) * 0.8 + 0.1 ) * 11.0;
      float twob = ( rNoise( vec2( ac * 0.9, cell ) ) - 0.5 ) * 0.6;
      float trans = thinLine( mod( alW, 11.0 ) - tpos - twob, 0.02, fwL ) * step( 0.35, rHash( vec2( cell, 7.1 ) ) ) * step( aa, hw * ( 0.4 + 0.6 * rHash( vec2( cell, 8.2 ) ) ) );
      float hair = thinLine( rNoise( q * vec2( 0.9, 2.2 ) ) - 0.5, 0.012, fwidth( rNoise( q * vec2( 0.9, 2.2 ) ) ) + 1e-4 ) * wheel * step( 0.62, rNoise( q * 0.11 ) );
      crack = max( max( tar, trans ) * det2, hair * det2 * 0.8 );
      asph = mix( asph, vec3( 0.022, 0.022, 0.024 ), crack * 0.85 );
      if ( max( tar, trans ) * det2 > 0.5 ) roadRough = 0.6;
    }

    // ── markings ──
${markingsGLSL()}
    pw = max( pw, townMark );
    float wear = ( 0.7 + 0.3 * rNoise( q * vec2( 1.3, 5.0 ) ) ) * ( 1.0 - 0.25 * wheel );
    wear = mix( 0.85, wear, det1 );
    col = asph;
    col = mix( col, vec3( 0.60, 0.60, 0.58 ), pw * wear );
    col = mix( col, vec3( 0.56, 0.37, 0.045 ), py * wear );
    if ( pw + py > 0.3 ) roadRough = mix( roadRough, 0.7, clamp( pw + py, 0.0, 1.0 ) );

    // ── farm tracks: dirt ruts, grass middle strip ──
    vec3 grass = vec3( 0.075, 0.12, 0.032 ) * ( 0.8 + 0.4 * rNoise( q * vec2( 0.5, 1.5 ) ) );
    vec3 dirt = vec3( 0.20, 0.165, 0.12 ) * ( 0.85 + 0.3 * rNoise( q * vec2( 1.1, 3.0 ) ) );
    if ( kindId == 5.0 ) {
      float rutC = min( 0.85, hw * 0.47 );
      float rut = bandCov( abs( aa - rutC ), 0.0, 0.34 + 0.06 * rNoise( q * 0.8 ), fwA );
      float gravel = 0.55 + 0.45 * rNoise( q * vec2( 0.07, 0.2 ) );
      vec3 bed = mix( grass, dirt * 1.15, gravel * smoothstep( hw, hw - 0.4, aa ) );
      col = mix( bed, dirt * ( 0.9 + 0.2 * rNoise( q * 9.0 ) * det1 ), rut );
      roadRough = 0.95;
    }

    // ── outside the paved edge ──
    float edgeN = sidewalk ? 0.0 : ( rNoise( vec2( alW * 0.6, sign( ac ) * 5.0 ) ) - 0.5 ) * ( kindId >= 3.0 ? 0.35 : 0.08 );
    float outW = sidewalk ? swW : ( kindId == 0.0 ? 1.3 : kindId == 1.0 ? 1.0 : kindId == 2.0 ? 0.9 : kindId == 3.0 ? 0.5 : kindId == 4.0 ? 0.5 : 0.3 );
    float fadeW = sidewalk ? 0.8 : ( kindId == 0.0 ? 2.2 : kindId == 1.0 ? 1.8 : kindId == 2.0 ? 1.6 : kindId == 3.0 ? 1.4 : kindId == 4.0 ? 1.1 : 1.1 );
    float outside = smoothstep( hw - 0.5 * fwA, hw + 0.5 * fwA, aa - edgeN );
    if ( outside > 0.0 ) {
      vec3 oc;
      if ( sidewalk ) {
        // kerb top (bright), then concrete slabs with joints
        float x = aa - hw;
        vec3 conc = vec3( 0.27, 0.26, 0.245 ) * ( 0.88 + 0.24 * rNoise( q * vec2( 0.35, 1.2 ) ) );
        float joint = thinLine( mod( alW, 1.52 ) - 0.76, 0.006, fwL ) * det2;
        conc *= 1.0 - 0.35 * joint;
        oc = mix( vec3( 0.36, 0.35, 0.33 ), conc, smoothstep( 0.16, 0.2, x ) );
        oc = mix( oc, grass, smoothstep( swW - 0.05, swW + 0.1, x ) );
        roadRough = 0.85;
      } else if ( embank ) {
        oc = mix( vec3( 0.14, 0.13, 0.11 ), grass, smoothstep( 0.3, 1.2, aa - hw ) );
        roadRough = 0.95;
      } else {
        // gravel / dirt shoulder into grass
        vec3 grav = vec3( 0.15, 0.137, 0.115 ) * ( 0.8 + 0.4 * rNoise( q * vec2( 1.7, 4.0 ) ) );
        oc = mix( grav, grass, smoothstep( 0.2, outW + 0.4, aa - hw + ( rNoise( q * 0.6 ) - 0.5 ) * 0.5 ) );
        roadRough = 0.95;
      }
      col = mix( col, oc, outside );
      // kerb shadow line / crumbly edge
      if ( sidewalk ) col *= 1.0 - 0.45 * thinLine( aa - hw - 0.19, 0.03, fwA ) * det1;
      // soft verge: alpha → 0 over the fade band (alpha-to-coverage)
      if ( !embank ) {
        float o0 = hw + outW;
        float fz = sidewalk ? ( aa - o0 - 0.12 ) / 0.25 : ( aa - o0 + ( rNoise( q * vec2( 0.3, 0.9 ) ) - 0.5 ) * fadeW * 0.6 ) / fadeW;
        alpha = 1.0 - smoothstep( 0.0, 1.0, fz );
      }
    }
    // the gutter along a kerb
    if ( sidewalk ) col *= 1.0 - 0.3 * bandCov( aa, hw - 0.35, hw, fwA ) * ( 1.0 - outside );
  }
  diffuseColor.rgb = col;
  diffuseColor.a = alpha;
`;
}
