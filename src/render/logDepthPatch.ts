/**
 * Logarithmic-depth support for custom ShaderMaterials.
 *
 * Firefox and Safari have no EXT_clip_control, so the renderer falls back from reversed-Z to three's
 * logarithmic depth buffer (renderer.ts). Built-in materials then write a logarithmic gl_FragDepth,
 * but a custom ShaderMaterial without three's logdepthbuf chunks writes the plain depth — a different
 * scale — so its fragments pass or fail the depth test against the wrong surfaces: nav-light glows,
 * effects, traffic and far scenery vanish or show through things in those browsers.
 *
 * `injectLogDepth` adds the missing pieces to a vertex/fragment pair (pure, string → string; no-op for
 * shaders that already handle it or have no `main`). `installLogDepthForShaderMaterials` applies it to
 * every ShaderMaterial (not RawShaderMaterial) at program build time via onBeforeCompile — only when
 * the renderer actually uses a logarithmic depth buffer.
 */
import * as THREE from 'three';

const VERT_PARS = `
#ifdef USE_LOGDEPTHBUF
varying float vFragDepth;
varying float vIsPerspective;
#endif
`;
const VERT_MAIN_END = `
#ifdef USE_LOGDEPTHBUF
	vFragDepth = 1.0 + gl_Position.w;
	vIsPerspective = float( projectionMatrix[ 2 ][ 3 ] == - 1.0 );
#endif
`;
const FRAG_PARS = `
#ifdef USE_LOGDEPTHBUF
uniform float logDepthBufFC;
varying float vFragDepth;
varying float vIsPerspective;
#endif
`;
const FRAG_MAIN_START = `
#ifdef USE_LOGDEPTHBUF
	gl_FragDepth = vIsPerspective == 0.0 ? gl_FragCoord.z : log2( vFragDepth ) * logDepthBufFC * 0.5;
#endif
`;

/** Index of `void main(...) {`'s opening brace and of its matching closing brace, or null. */
export function mainBody(src: string): { open: number; close: number; decl: number } | null {
  const m = /\bvoid\s+main\s*\(\s*(void)?\s*\)\s*\{/.exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return { open, close: i, decl: m.index };
    }
  }
  return null;
}

export interface ShaderPair {
  vertexShader: string;
  fragmentShader: string;
}

/** Add logarithmic-depth output to a custom shader pair; returns the input unchanged when not applicable. */
export function injectLogDepth(s: ShaderPair): ShaderPair {
  const { vertexShader: vs, fragmentShader: fs } = s;
  if (/logdepthbuf|vFragDepth|gl_FragDepth/.test(vs + fs)) return s;
  const v = mainBody(vs);
  const f = mainBody(fs);
  if (!v || !f) return s;
  // A vertex main that returns early could skip the varyings: leave it alone.
  if (/\breturn\b/.test(vs.slice(v.open, v.close))) return s;
  if (!/gl_Position\s*=/.test(vs.slice(v.open, v.close))) return s;
  const vertexShader = vs.slice(0, v.decl) + VERT_PARS + vs.slice(v.decl, v.close) + VERT_MAIN_END + vs.slice(v.close);
  const fragmentShader = fs.slice(0, f.decl) + FRAG_PARS + fs.slice(f.decl, f.open + 1) + FRAG_MAIN_START + fs.slice(f.open + 1);
  return { vertexShader, fragmentShader };
}

let installed = false;

/** Patch every ShaderMaterial's program build (idempotent). Call only with a logarithmic depth buffer. */
export function installLogDepthForShaderMaterials(): void {
  if (installed) return;
  installed = true;
  const proto = THREE.ShaderMaterial.prototype as THREE.ShaderMaterial & { onBeforeCompile: THREE.Material['onBeforeCompile'] };
  const prev = proto.onBeforeCompile;
  proto.onBeforeCompile = function (this: THREE.ShaderMaterial, shader, renderer) {
    prev.call(this, shader, renderer);
    if ((this as THREE.ShaderMaterial & { isRawShaderMaterial?: boolean }).isRawShaderMaterial) return;
    const out = injectLogDepth(shader);
    shader.vertexShader = out.vertexShader;
    shader.fragmentShader = out.fragmentShader;
  };
}
