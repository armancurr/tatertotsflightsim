/**
 * The Maverick view picture (picture-in-picture): the white-hot spots over the vehicles (pure,
 * projected with the view camera), the corner blit, the ≤ maxHz refresh, and — with a recording
 * stand-in for THREE.WebGLRenderer — that the renderer's state (render target, viewport, scissor,
 * scissor test, auto-clear, clear colour, shadow auto-update, scene matrix auto-update, the
 * aircraft's visibility) is exactly restored after the extra renders.
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { CONFIG } from '../../src/config';
import { createCombatWorld } from '../../src/combat/world';
import { createSeekerView, seekerHotSpots, MAX_HOT } from '../../src/ui/seekerView';
import { fcParams } from '../support/fc';

function viewCam(pos: [number, number, number], look: [number, number, number], fov = 3) {
  const c = new THREE.PerspectiveCamera(fov, 4 / 3, 4, 40000);
  c.position.set(...pos);
  c.lookAt(...look);
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
}

describe('hot spots', () => {
  it('a tank dead ahead gives a hull glow and a hotter engine deck behind it, at the picture centre', () => {
    const w = createCombatWorld();
    w.addTarget({ kind: 'tank', position: { x: 0, y: 0, z: -3000 }, headingDeg: 0, group: 't' });
    const c = viewCam([0, 300, 0], [0, 1.1, -3000]);
    const out = new Float32Array(MAX_HOT * 4);
    const n = seekerHotSpots(out, c.matrixWorldInverse.elements, c.projectionMatrix.elements, c.fov, w.targets, w.classOf);
    expect(n).toBe(2);
    const hull = out.subarray(0, 4);
    const deck = out.subarray(4, 8);
    expect(hull[0]).toBeCloseTo(0.5, 2);
    expect(hull[1]).toBeCloseTo(0.5, 2);
    expect(deck[3]).toBeGreaterThan(hull[3]);
    // Facing north (away from the viewer to the south of it... the camera is south, looking north): the deck (rear) is nearer, lower in the picture.
    expect(deck[1]).toBeLessThan(hull[1] + 0.05);
    expect(hull[2]).toBeGreaterThan(0);
  });

  it('skips vehicles behind or far outside the picture; wrecks burn hotter', () => {
    const w = createCombatWorld();
    w.addTarget({ kind: 'tank', position: { x: 0, y: 0, z: 3000 }, headingDeg: 0, group: 't' });
    w.addTarget({ kind: 'tank', position: { x: 2000, y: 0, z: -3000 }, headingDeg: 0, group: 't' });
    const wreck = w.addTarget({ kind: 'truck', position: { x: 5, y: 0, z: -3000 }, headingDeg: 90, group: 't' });
    wreck.alive = false;
    const c = viewCam([0, 300, 0], [0, 1.1, -3000]);
    const out = new Float32Array(MAX_HOT * 4);
    const n = seekerHotSpots(out, c.matrixWorldInverse.elements, c.projectionMatrix.elements, c.fov, w.targets, w.classOf);
    expect(n).toBe(2);
    expect(out[4 + 3]).toBeGreaterThan(1);
  });

  it('property: never more than MAX_HOT spots, all finite, radii positive', () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ x: fc.double({ min: -9000, max: 9000, noNaN: true }), z: fc.double({ min: -9000, max: 9000, noNaN: true }), h: fc.double({ noNaN: false }) }), { maxLength: 40 }),
        fc.double({ min: 0.5, max: 60, noNaN: true }),
        (ts, fov) => {
          const w = createCombatWorld();
          for (const t of ts) w.addTarget({ kind: 'ifv', position: { x: t.x, y: 0, z: t.z }, headingDeg: t.h, group: 'f' });
          const c = viewCam([0, 500, 0], [0, 0, -4000], fov);
          const out = new Float32Array(MAX_HOT * 4);
          const n = seekerHotSpots(out, c.matrixWorldInverse.elements, c.projectionMatrix.elements, fov, w.targets, w.classOf);
          expect(n).toBeLessThanOrEqual(MAX_HOT);
          for (let i = 0; i < n * 4; i++) expect(Number.isFinite(out[i])).toBe(true);
          for (let i = 0; i < n; i++) expect(out[i * 4 + 2]).toBeGreaterThan(0);
        },
      ),
      fcParams(150),
    );
  });
});

/** A stand-in for WebGLRenderer that records state changes and every render call. */
function mockRenderer() {
  const st = {
    target: null as THREE.WebGLRenderTarget | null,
    viewport: new THREE.Vector4(0, 0, 1440, 900),
    scissor: new THREE.Vector4(0, 0, 1440, 900),
    scissorTest: false,
    autoClear: true,
    clear: new THREE.Color(0x123456),
    clearAlpha: 1,
    pixelRatio: 2,
  };
  const renders: { target: THREE.WebGLRenderTarget | null; scissorTest: boolean; viewport: number[]; autoClear: boolean; what: string; shadowAuto: boolean; hiddenVisible: boolean | null }[] = [];
  let hidden: THREE.Object3D | null = null;
  const r = {
    st,
    renders,
    setHidden(o: THREE.Object3D) {
      hidden = o;
    },
    shadowMap: { autoUpdate: true, needsUpdate: false, enabled: true },
    info: { render: { frame: 0 } },
    getRenderTarget: () => st.target,
    setRenderTarget: (t: THREE.WebGLRenderTarget | null) => {
      st.target = t;
    },
    getViewport: (v: THREE.Vector4) => v.copy(st.viewport),
    setViewport: (x: number, y: number, w: number, h: number) => {
      st.viewport.set(x, y, w, h);
    },
    getScissor: (v: THREE.Vector4) => v.copy(st.scissor),
    setScissor: (x: number, y: number, w: number, h: number) => {
      st.scissor.set(x, y, w, h);
    },
    getScissorTest: () => st.scissorTest,
    setScissorTest: (b: boolean) => {
      st.scissorTest = b;
    },
    get autoClear() {
      return st.autoClear;
    },
    set autoClear(v: boolean) {
      st.autoClear = v;
    },
    getClearColor: (c: THREE.Color) => c.copy(st.clear),
    getClearAlpha: () => st.clearAlpha,
    setClearColor: (c: THREE.ColorRepresentation, a = 1) => {
      st.clear.set(c);
      st.clearAlpha = a;
    },
    getPixelRatio: () => st.pixelRatio,
    getSize: (v: THREE.Vector2) => v.set(1440, 900),
    getContext: () => ({ getExtension: () => null }),
    render: (scene: THREE.Object3D, _cam: THREE.Camera) => {
      renders.push({
        target: st.target, scissorTest: st.scissorTest, viewport: st.viewport.toArray(), autoClear: st.autoClear,
        what: (scene as THREE.Scene).isScene ? 'scene' : 'blit', shadowAuto: r.shadowMap.autoUpdate, hiddenVisible: hidden ? hidden.visible : null,
      });
    },
    readRenderTargetPixels: (_t: unknown, _x: number, _y: number, w: number, h: number, buf: Uint8Array) => {
      for (let i = 0; i < w * h * 4; i++) buf[i] = (i * 37) % 256;
    },
  };
  return r;
}

describe('seeker view renders', () => {
  const rect = { x: 1090, y: 630, w: 320, h: 240 };

  it('renders the scene into its own target (never the screen pipeline), then blits into the corner; state restored exactly', () => {
    const r = mockRenderer();
    const scene = new THREE.Scene();
    scene.matrixWorldAutoUpdate = true;
    const aircraft = new THREE.Group();
    scene.add(aircraft);
    r.setHidden(aircraft);
    const view = createSeekerView(CONFIG);
    view.camera.position.set(0, 300, 0);
    view.camera.lookAt(0, 0, -3000);
    const before = { viewport: r.st.viewport.toArray(), scissor: r.st.scissor.toArray(), clear: r.st.clear.getHex(), alpha: r.st.clearAlpha };
    const g = r as unknown as THREE.WebGLRenderer;
    const did = view.render(g, scene, aircraft, 0, rect);
    expect(did).toBe(true);
    view.blit(g, rect);
    expect(r.renders.map((x) => x.what)).toEqual(['scene', 'blit']);
    const [sceneR, blitR] = r.renders;
    expect(sceneR.target).not.toBeNull();
    expect(sceneR.shadowAuto).toBe(false);
    expect(sceneR.hiddenVisible).toBe(false);
    // Blit: screen, scissored to the corner (GL y from the bottom), no clear.
    expect(blitR.target).toBeNull();
    expect(blitR.scissorTest).toBe(true);
    expect(blitR.autoClear).toBe(false);
    expect(blitR.viewport).toEqual([rect.x, 900 - rect.y - rect.h, rect.w, rect.h]);
    // Everything back as it was.
    expect(r.st.target).toBeNull();
    expect(r.st.viewport.toArray()).toEqual(before.viewport);
    expect(r.st.scissor.toArray()).toEqual(before.scissor);
    expect(r.st.scissorTest).toBe(false);
    expect(r.st.autoClear).toBe(true);
    expect(r.st.clear.getHex()).toBe(before.clear);
    expect(r.st.clearAlpha).toBe(before.alpha);
    expect(r.shadowMap.autoUpdate).toBe(true);
    expect(r.shadowMap.needsUpdate).toBe(false);
    expect(scene.matrixWorldAutoUpdate).toBe(true);
    expect(aircraft.visible).toBe(true);
    // The picture is sized at the renderer's pixel ratio.
    expect(view.stats().width).toBe(rect.w * 2);
    expect(view.stats().height).toBe(rect.h * 2);
    view.dispose();
  });

  it('refreshes at most maxHz (the corner is re-blitted every frame)', () => {
    const r = mockRenderer();
    const scene = new THREE.Scene();
    const view = createSeekerView(CONFIG);
    const g = r as unknown as THREE.WebGLRenderer;
    let n = 0;
    for (let i = 0; i < 60; i++) {
      if (view.render(g, scene, null, i / 60, rect)) n++;
      view.blit(g, rect);
    }
    expect(n).toBeLessThanOrEqual(CONFIG.hud.weapons.seeker.maxHz + 1);
    expect(n).toBeGreaterThanOrEqual(CONFIG.hud.weapons.seeker.maxHz - 2);
    expect(r.renders.filter((x) => x.what === 'blit').length).toBe(60);
    view.dispose();
  });

  it('restores the state even when the scene render throws', () => {
    const r = mockRenderer();
    const scene = new THREE.Scene();
    const aircraft = new THREE.Group();
    const g = r as unknown as THREE.WebGLRenderer;
    r.render = () => {
      throw new Error('boom');
    };
    const view = createSeekerView(CONFIG);
    expect(() => view.render(g, scene, aircraft, 0, rect)).toThrow('boom');
    expect(r.st.target).toBeNull();
    expect(r.shadowMap.autoUpdate).toBe(true);
    expect(aircraft.visible).toBe(true);
    expect(scene.matrixWorldAutoUpdate).toBe(true);
    view.dispose();
  });

  it('probe: mean and spread of the picture from a small read-back', () => {
    const r = mockRenderer();
    const view = createSeekerView(CONFIG);
    const p = view.probe(r as unknown as THREE.WebGLRenderer);
    expect(p).not.toBeNull();
    expect(p!.mean).toBeGreaterThan(0);
    expect(p!.std).toBeGreaterThan(0);
    // And the probe put everything back.
    expect(r.st.target).toBeNull();
    view.dispose();
  });
});
