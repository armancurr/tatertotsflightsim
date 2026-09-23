/**
 * The Maverick picture-in-picture must never draw with a texture that is attached to the framebuffer
 * it is drawing into: WebGL reports that as "GL_INVALID_OPERATION: Feedback loop formed between
 * Framebuffer and active Texture" and drops the draw (the warm-up used to render the IR quad —
 * which samples the seeker picture — into the seeker picture's own target).
 *
 * A recording stand-in for THREE.WebGLRenderer notes, for every render call, the bound render
 * target and every texture the drawn materials sample.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CONFIG } from '../../src/config';
import { createSeekerView } from '../../src/ui/seekerView';

interface Draw {
  target: THREE.WebGLRenderTarget | null;
  sampled: THREE.Texture[];
}

function sampledTextures(root: THREE.Object3D): THREE.Texture[] {
  const out: THREE.Texture[] = [];
  root.traverse((o) => {
    const mats = (o as THREE.Mesh).material;
    for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
      const u = (m as THREE.ShaderMaterial).uniforms ?? {};
      for (const k of Object.keys(u)) if ((u[k].value as THREE.Texture | null)?.isTexture) out.push(u[k].value as THREE.Texture);
      const map = (m as THREE.MeshBasicMaterial).map;
      if (map) out.push(map);
    }
  });
  return out;
}

function recordingRenderer() {
  let target: THREE.WebGLRenderTarget | null = null;
  let autoClear = true;
  const draws: Draw[] = [];
  const clear = new THREE.Color();
  const vp = new THREE.Vector4(0, 0, 1440, 900);
  const sc = new THREE.Vector4(0, 0, 1440, 900);
  let scissorTest = false;
  const r = {
    draws,
    shadowMap: { autoUpdate: true, needsUpdate: false, enabled: true },
    info: { render: { frame: 0 } },
    getRenderTarget: () => target,
    setRenderTarget: (t: THREE.WebGLRenderTarget | null) => {
      target = t;
    },
    getViewport: (v: THREE.Vector4) => v.copy(vp),
    setViewport: (x: number, y: number, w: number, h: number) => vp.set(x, y, w, h),
    getScissor: (v: THREE.Vector4) => v.copy(sc),
    setScissor: (x: number, y: number, w: number, h: number) => sc.set(x, y, w, h),
    getScissorTest: () => scissorTest,
    setScissorTest: (b: boolean) => {
      scissorTest = b;
    },
    get autoClear() {
      return autoClear;
    },
    set autoClear(v: boolean) {
      autoClear = v;
    },
    getClearColor: (c: THREE.Color) => c.copy(clear),
    getClearAlpha: () => 1,
    setClearColor: (c: THREE.ColorRepresentation) => clear.set(c),
    getPixelRatio: () => 2,
    getSize: (v: THREE.Vector2) => v.set(1440, 900),
    getContext: () => ({ getExtension: () => null }),
    render: (scene: THREE.Object3D) => {
      draws.push({ target, sampled: sampledTextures(scene) });
    },
    readRenderTargetPixels: (_t: unknown, _x: number, _y: number, w: number, h: number, buf: Uint8Array) => {
      buf.fill(90, 0, w * h * 4);
    },
  };
  return r;
}

/** Textures attached to a render target (colour + depth). */
function attachments(t: THREE.WebGLRenderTarget | null): THREE.Texture[] {
  if (!t) return [];
  return [...t.textures, ...(t.depthTexture ? [t.depthTexture] : [])];
}

function expectNoFeedbackLoops(draws: Draw[]) {
  expect(draws.length).toBeGreaterThan(0);
  for (const d of draws) {
    const bound = attachments(d.target);
    for (const s of d.sampled) expect(bound.includes(s), `a draw samples "${s.name}" while rendering into it`).toBe(false);
  }
}

describe('Maverick view: no framebuffer/texture feedback loops', () => {
  const rect = { x: 1090, y: 630, w: 320, h: 240 };

  it('warmUp compiles the IR shader without drawing into the picture it samples', () => {
    const r = recordingRenderer();
    const view = createSeekerView(CONFIG);
    view.warmUp(r as unknown as THREE.WebGLRenderer);
    expectNoFeedbackLoops(r.draws);
    // …and leaves the renderer on the screen.
    expect(r.getRenderTarget()).toBeNull();
    view.dispose();
  });

  it('render → blit → probe over many frames never samples a bound attachment', () => {
    const r = recordingRenderer();
    const g = r as unknown as THREE.WebGLRenderer;
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial()));
    const view = createSeekerView(CONFIG);
    view.warmUp(g);
    for (let i = 0; i < 30; i++) {
      view.render(g, scene, null, i / 30, rect);
      view.blit(g, rect);
    }
    view.probe(g);
    expectNoFeedbackLoops(r.draws);
    expect(r.draws.some((d) => d.sampled.length > 0), 'the IR quad samples the picture').toBe(true);
    view.dispose();
  });
});
