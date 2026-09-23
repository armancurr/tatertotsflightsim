/**
 * Daylight on the 747 flight deck. The sun's shadow map is far too coarse to shade a cockpit, so
 * every interior material asks, per fragment, where a ray toward the sun leaves the room (the
 * convex polyhedron of flightDeckLayout.ts): through a window (sunlit) or through the roof, a wall
 * or the floor (shade). The glareshield shades the instrument panel under it. Sky light is scaled
 * the same way along the surface normal tilted up, so surfaces that face the windows get more of it.
 * A fill term adds the light bouncing round the deck (from the sun) and the dim flood lights at dusk.
 *
 * The same maths exists twice, `deckSunVisibility` (TypeScript, for tests) and `DECK_LIGHT_GLSL`,
 * both generated from ROOM and GLARESHIELD.
 */
import * as THREE from 'three';
import { GLARESHIELD, ROOM, WINDSCREEN, polyInside, type Pt2, type RoomPlane, type V3 } from './flightDeckLayout';

/** Soft edge of every window / shadow boundary, m. */
export const DECK_EDGE = 0.02;
/** Sky light: share reaching a surface that faces solid lining, and the tilt of the test toward the sky. */
export const DECK_SKY = { floor: 0.6, tiltUp: 0.6, specularFloor: 0.35 } as const;

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const soft = (d: number) => smooth(-DECK_EDGE, DECK_EDGE, d);
const dot = (a: V3, b: V3) => a.x * b.x + a.y * b.y + a.z * b.z;

/** Glareshield occluder: the horizontal slab from the aft lip to the windscreen. */
const GS = { y: GLARESHIELD.lipY, z0: WINDSCREEN.z0, z1: GLARESHIELD.lipZ, half: GLARESHIELD.halfWidth };

/**
 * Fraction (0 shade … 1 sunlit) of direct light reaching deck point p from direction s (toward the
 * light, deck frame). Always finite; points outside the room count as sunlit.
 */
export function deckSunVisibility(p: V3, s: V3): number {
  const len = Math.hypot(s.x, s.y, s.z);
  if (!(len > 1e-6) || !Number.isFinite(len) || ![p.x, p.y, p.z].every(Number.isFinite)) return 1;
  const d = { x: s.x / len, y: s.y / len, z: s.z / len };
  let best: RoomPlane | null = null;
  let tBest = Infinity;
  for (const pl of ROOM) {
    const ns = dot(pl.n, d);
    if (ns <= 1e-5) continue;
    const t = (pl.d - dot(pl.n, p)) / ns;
    if (t < tBest) {
      tBest = t;
      best = pl;
    }
  }
  if (!best || !Number.isFinite(tBest)) return 1;
  const t = Math.max(0, tBest);
  const e = { x: p.x + d.x * t, y: p.y + d.y * t, z: p.z + d.z * t };
  let vis = 0;
  if (best.windows.length) {
    const r = { x: e.x - best.o.x, y: e.y - best.o.y, z: e.z - best.o.z };
    const u = dot(r, best.e1);
    const v = dot(r, best.e2);
    let w = -Infinity;
    for (const poly of best.windows) w = Math.max(w, polyInside(poly, u, v));
    vis = soft(w);
  }
  // The glareshield shades what lies under it.
  if (vis > 0 && p.y < GS.y && d.y > 1e-5) {
    const tg = (GS.y - p.y) / d.y;
    if (tg < t) {
      const gz = p.z + d.z * tg;
      const gx = Math.abs(p.x + d.x * tg);
      vis *= 1 - soft(Math.min(gz - GS.z0, GS.z1 - gz, GS.half - gx));
    }
  }
  return Math.max(0, Math.min(1, vis));
}

// ─── GLSL (same maths) ───────────────────────────────────────────────────────

const f = (x: number) => {
  const s = (Number.isFinite(x) ? x : 0).toFixed(6);
  return s.includes('.') ? s : `${s}.0`;
};
const v3 = (a: V3) => `vec3(${f(a.x)}, ${f(a.y)}, ${f(a.z)})`;
function polyGlsl(poly: readonly Pt2[]): string {
  const terms = poly.map((a, i) => {
    const b = poly[(i + 1) % poly.length];
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const l = Math.hypot(dx, dy) || 1;
    // (-(u - ax) * dy + (v - ay) * dx) / l
    return `(${f(-dy / l)} * uv.x + ${f(dx / l)} * uv.y + ${f((a[0] * dy - a[1] * dx) / l)})`;
  });
  return terms.reduce((x, y) => `min(${x}, ${y})`);
}

function buildGlsl(): string {
  const lines: string[] = [];
  lines.push('uniform mat4 uDeckFromWorld;', 'varying vec3 vDeckP;');
  lines.push(`float deckSoft(float d) { return smoothstep(${f(-DECK_EDGE)}, ${f(DECK_EDGE)}, d); }`);
  lines.push('float deckVis(vec3 p, vec3 s) {', '  const float BIG = 1e6;', '  float tb = BIG; int k = -1; float ns; float t;');
  ROOM.forEach((pl, i) => {
    lines.push(`  ns = dot(${v3(pl.n)}, s); if (ns > 1e-5) { t = (${f(pl.d)} - dot(${v3(pl.n)}, p)) / ns; if (t < tb) { tb = t; k = ${i}; } }`);
  });
  lines.push('  if (k < 0) return 1.0;', '  tb = max(tb, 0.0);', '  vec3 e = p + s * tb;', '  float vis = 0.0;', '  vec2 uv;');
  ROOM.forEach((pl, i) => {
    if (!pl.windows.length) return;
    const polys = pl.windows.map(polyGlsl).reduce((a, b) => `max(${a}, ${b})`);
    lines.push(`  if (k == ${i}) { vec3 r = e - ${v3(pl.o)}; uv = vec2(dot(r, ${v3(pl.e1)}), dot(r, ${v3(pl.e2)})); vis = deckSoft(${polys}); }`);
  });
  lines.push(
    `  if (vis > 0.0 && p.y < ${f(GS.y)} && s.y > 1e-5) {`,
    `    float tg = (${f(GS.y)} - p.y) / s.y;`,
    '    if (tg < tb) {',
    '      float gz = p.z + s.z * tg;',
    '      float gx = abs(p.x + s.x * tg);',
    `      vis *= 1.0 - deckSoft(min(min(gz - ${f(GS.z0)}, ${f(GS.z1)} - gz), ${f(GS.half)} - gx));`,
    '    }',
    '  }',
    '  return clamp(vis, 0.0, 1.0);',
    '}',
    'vec3 deckDir(vec3 viewDir) { return normalize(mat3(uDeckFromWorld) * inverseTransformDirection(viewDir, viewMatrix)); }',
  );
  return lines.join('\n');
}

export const DECK_LIGHT_GLSL = buildGlsl();

export interface DeckLight {
  /** Deck-from-world matrix (shared uniform of every interior material). */
  deckFromWorld: { value: THREE.Matrix4 };
  /** Extra irradiance (linear RGB): light bouncing round the deck + flood lights. */
  fill: { value: THREE.Color };
  apply<T extends THREE.MeshStandardMaterial>(m: T, key: string): T;
  /** Keep the uniform on the deck group's pose (call before rendering the interior). */
  update(deck: THREE.Object3D): void;
}

export function createDeckLight(): DeckLight {
  const deckFromWorld = { value: new THREE.Matrix4() };
  const fill = { value: new THREE.Color(0, 0, 0) };
  return {
    deckFromWorld,
    fill,
    apply(m, key) {
      const prev = m.onBeforeCompile;
      const prevKey = m.customProgramCacheKey.bind(m);
      m.onBeforeCompile = (shader, renderer) => {
        prev.call(m, shader, renderer);
        shader.uniforms.uDeckFromWorld = deckFromWorld;
        shader.uniforms.uDeckFill = fill;
        shader.vertexShader = shader.vertexShader
          .replace('#include <common>', '#include <common>\nuniform mat4 uDeckFromWorld;\nvarying vec3 vDeckP;')
          .replace('#include <project_vertex>', '#include <project_vertex>\nvDeckP = (uDeckFromWorld * modelMatrix * vec4(transformed, 1.0)).xyz;');
        const begin = THREE.ShaderChunk.lights_fragment_begin.replace(
          'getDirectionalLightInfo( directionalLight, directLight );',
          'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= deckVis( vDeckP, deckDir( directLight.direction ) );',
        );
        shader.fragmentShader = shader.fragmentShader
          .replace('#include <common>', '#include <common>\nuniform vec3 uDeckFill;\n' + DECK_LIGHT_GLSL)
          .replace('#include <lights_fragment_begin>', begin)
          .replace(
            '#include <lights_fragment_maps>',
            `#include <lights_fragment_maps>
{
  vec3 dN = deckDir( geometryNormal );
  float dSky = ${f(DECK_SKY.floor)} + ${f(1 - DECK_SKY.floor)} * deckVis( vDeckP, normalize( dN + vec3( 0.0, ${f(DECK_SKY.tiltUp)}, 0.0 ) ) );
  #if defined( RE_IndirectDiffuse )
  irradiance *= dSky;
  iblIrradiance *= dSky;
  irradiance += uDeckFill;
  #endif
  #if defined( RE_IndirectSpecular )
  radiance *= mix( ${f(DECK_SKY.specularFloor)}, 1.0, deckVis( vDeckP, deckDir( reflect( -geometryViewDir, geometryNormal ) ) ) );
  #endif
}`,
          );
      };
      m.customProgramCacheKey = () => `${prevKey()}|deckLight|${key}`;
      return m;
    },
    update(deck) {
      deckFromWorld.value.copy(deck.matrixWorld).invert();
    },
  };
}
