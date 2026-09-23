/**
 * Logarithmic depth for custom ShaderMaterials (src/render/logDepthPatch.ts) — what Firefox and Safari
 * render with (no EXT_clip_control). Pure string transforms: where the pieces go, what is left alone.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { injectLogDepth, mainBody } from '../../src/render/logDepthPatch';
import { fcParams } from '../support/fc';

const VS = `varying vec2 vUv;
float f(float x) { if (x > 0.0) { return x; } return -x; }
void main() {
  vUv = uv;
  if (uv.x > 0.5) { vUv.y = f(uv.y); }
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;
const FS = `uniform sampler2D map;
varying vec2 vUv;
void main() {
  vec4 c = texture2D(map, vUv);
  if (c.a < 0.1) discard;
  gl_FragColor = c;
}
`;

describe('injectLogDepth', () => {
  it('declares the varyings before main, writes them after gl_Position, and writes gl_FragDepth first thing in the fragment main', () => {
    const out = injectLogDepth({ vertexShader: VS, fragmentShader: FS });
    const v = out.vertexShader;
    const f = out.fragmentShader;
    expect(v.indexOf('varying float vFragDepth')).toBeLessThan(v.indexOf('void main'));
    expect(v.indexOf('vFragDepth = 1.0 + gl_Position.w')).toBeGreaterThan(v.indexOf('gl_Position = projectionMatrix'));
    const vb = mainBody(v)!;
    expect(v.indexOf('vFragDepth = 1.0')).toBeLessThan(vb.close);
    expect(f.indexOf('uniform float logDepthBufFC')).toBeLessThan(f.indexOf('void main'));
    expect(f.indexOf('gl_FragDepth')).toBeLessThan(f.indexOf('texture2D(map'));
    expect(f.indexOf('gl_FragDepth')).toBeGreaterThan(f.indexOf('void main'));
    // Only active under three's USE_LOGDEPTHBUF define.
    expect(v).toMatch(/#ifdef USE_LOGDEPTHBUF[\s\S]*vFragDepth = 1\.0/);
    expect(f).toMatch(/#ifdef USE_LOGDEPTHBUF[\s\S]*gl_FragDepth/);
    // The original code is all still there.
    for (const line of [...VS.split('\n'), ...FS.split('\n')].filter((l) => l.trim())) expect(v + f).toContain(line.trim());
  });

  it('leaves alone shaders that already handle depth, have no main, or return early from the vertex main', () => {
    const cases = [
      { vertexShader: '#include <logdepthbuf_pars_vertex>\n' + VS, fragmentShader: FS },
      { vertexShader: VS, fragmentShader: 'void main() { gl_FragDepth = 0.5; gl_FragColor = vec4(1.0); }' },
      { vertexShader: 'void notMain() {}', fragmentShader: FS },
      { vertexShader: 'void main() { if (position.x > 1.0) { gl_Position = vec4(0.0); return; } gl_Position = vec4(position, 1.0); }', fragmentShader: FS },
    ];
    for (const c of cases) expect(injectLogDepth(c)).toEqual(c);
  });

  it('is idempotent', () => {
    const once = injectLogDepth({ vertexShader: VS, fragmentShader: FS });
    expect(injectLogDepth(once)).toEqual(once);
  });

  it('mainBody finds the matching brace across nested blocks', () => {
    const b = mainBody(VS)!;
    expect(VS[b.open]).toBe('{');
    expect(VS[b.close]).toBe('}');
    expect(VS.slice(b.close + 1).trim()).toBe('');
  });

  it('property: never throws; output braces stay balanced; unchanged or strictly longer', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), fc.boolean(), (a, b, wrap) => {
        const pair = wrap
          ? { vertexShader: `${a}\nvoid main() { gl_Position = vec4(0.0); ${b.replace(/[{}]/g, '')} }`, fragmentShader: `void main() { ${a.replace(/[{}]/g, '')} }` }
          : { vertexShader: a, fragmentShader: b };
        const out = injectLogDepth(pair);
        const bal = (s: string) => (s.match(/\{/g) ?? []).length - (s.match(/\}/g) ?? []).length;
        expect(bal(out.vertexShader)).toBe(bal(pair.vertexShader));
        expect(bal(out.fragmentShader)).toBe(bal(pair.fragmentShader));
        expect(out.vertexShader.length).toBeGreaterThanOrEqual(pair.vertexShader.length);
      }),
      fcParams(300),
    );
  });
});
