import { describe, it, expect, vi } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { createEffects, type Effects } from '../../src/fx';
import { CONFIG } from '../../src/config';
import { SPARK_TILE } from '../../src/fx/sprites';

const FX = CONFIG.fx;
const DT = 1 / 60;

function camera(pos = new THREE.Vector3(0, 40, 250), look = new THREE.Vector3(0, 40, 0)) {
  const c = new THREE.PerspectiveCamera(60, 1.6, 0.1, 50000);
  c.position.copy(pos);
  c.lookAt(look);
  c.updateMatrixWorld();
  return c;
}

function parts(fx: Effects) {
  const mesh = fx.object.getObjectByName('fx-particles') as THREE.Mesh<THREE.InstancedBufferGeometry, THREE.ShaderMaterial>;
  const debris = fx.object.getObjectByName('fx-debris') as THREE.InstancedMesh;
  const light = fx.object.getObjectByName('fx-fire-light') as THREE.PointLight | undefined;
  return { mesh, geo: mesh.geometry, mat: mesh.material, debris, light };
}

function run(fx: Effects, cam: THREE.PerspectiveCamera, seconds: number, wind?: THREE.Vector3) {
  const n = Math.round(seconds / DT);
  for (let i = 0; i < n; i++) fx.update(cam, DT, wind);
}

function instanceValuesFinite(fx: Effects) {
  const { geo } = parts(fx);
  const n = geo.instanceCount;
  for (const name of ['iPos', 'iParams', 'iColor', 'iExtra', 'iVel']) {
    const a = geo.getAttribute(name) as THREE.InstancedBufferAttribute;
    const arr = a.array as Float32Array;
    for (let i = 0; i < n * a.itemSize; i++) if (!Number.isFinite(arr[i])) return false;
  }
  return true;
}

const make = () => createEffects(new THREE.Scene(), { atlasSize: 32 });

describe('createEffects', () => {
  it('adds its objects to the scene and starts empty', () => {
    const scene = new THREE.Scene();
    const fx = createEffects(scene, { atlasSize: 32 });
    expect(fx.object.parent).toBe(scene);
    const { mesh, geo, debris, light } = parts(fx);
    expect(mesh.visible).toBe(false);
    expect(geo.instanceCount).toBe(0);
    expect(debris.count).toBe(0);
    if (FX.fireLight) expect(light!.intensity).toBe(0);
    fx.update(camera(), DT);
    expect(geo.instanceCount).toBe(0);
  });
  it('the particle material hazes with fog, never writes depth, blends premultiplied', () => {
    const { mat, mesh } = parts(make());
    expect(mat.fog).toBe(true);
    expect(mat.depthWrite).toBe(false);
    expect(mat.depthTest).toBe(true);
    expect(mat.transparent).toBe(true);
    expect(mat.blending).toBe(THREE.CustomBlending);
    expect(mat.blendSrc).toBe(THREE.OneFactor);
    expect(mat.blendDst).toBe(THREE.OneMinusSrcAlphaFactor);
    expect(mesh.frustumCulled).toBe(false);
    expect(mat.fragmentShader).toContain('#include <fog_fragment>');
    expect(mat.vertexShader).toContain('#include <fog_vertex>');
  });
  it('crash → fireball, smoke, debris and the fire light, all finite', () => {
    const fx = make();
    const cam = camera();
    fx.crash(new THREE.Vector3(0, 31, 0), 100, { velocity: new THREE.Vector3(0, -5, -50) });
    run(fx, cam, 0.5);
    const { mesh, geo, debris, light } = parts(fx);
    expect(mesh.visible).toBe(true);
    expect(geo.instanceCount).toBeGreaterThan(50);
    expect(debris.count).toBeGreaterThan(5);
    if (FX.fireLight) expect(light!.intensity).toBeGreaterThan(0);
    expect(instanceValuesFinite(fx)).toBe(true);
  });
  it('instances are drawn back to front', () => {
    const fx = make();
    const cam = camera();
    fx.crash(new THREE.Vector3(0, 31, 0), 100);
    run(fx, cam, 4);
    const { geo } = parts(fx);
    const pos = (geo.getAttribute('iPos') as THREE.InstancedBufferAttribute).array as Float32Array;
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    const depths: number[] = [];
    for (let i = 0; i < geo.instanceCount; i++) depths.push((pos[i * 4] - cam.position.x) * fwd.x + (pos[i * 4 + 1] - cam.position.y) * fwd.y + (pos[i * 4 + 2] - cam.position.z) * fwd.z);
    const tol = (Math.max(...depths) - Math.min(...depths)) / 2048 + 1e-3;
    for (let i = 0; i + 1 < depths.length; i++) expect(depths[i]).toBeGreaterThanOrEqual(depths[i + 1] - tol);
  });
  it('never reallocates its buffers and never exceeds capacity', () => {
    const fx = make();
    const cam = camera();
    const { geo } = parts(fx);
    const arrays = ['iPos', 'iParams', 'iColor', 'iExtra', 'iVel'].map((n) => geo.getAttribute(n).array);
    for (let k = 0; k < 8; k++) {
      fx.crash(new THREE.Vector3(k * 5, 31, 0), 160);
      fx.touchdown(new THREE.Vector3(k * 5, 31.2, 40), -800);
      run(fx, cam, 0.4);
      expect(geo.instanceCount).toBeLessThanOrEqual(FX.smokeCapacity + FX.fireCapacity);
    }
    ['iPos', 'iParams', 'iColor', 'iExtra', 'iVel'].forEach((n, i) => expect(geo.getAttribute(n).array).toBe(arrays[i]));
  });
  it('skips particles behind the camera', () => {
    const fx = make();
    const cam = camera(new THREE.Vector3(0, 40, 250), new THREE.Vector3(0, 40, 500)); // looking away
    fx.crash(new THREE.Vector3(0, 31, 0), 100);
    run(fx, cam, 1);
    expect(parts(fx).geo.instanceCount).toBe(0);
  });
  it('touchdown puffs appear at the main wheels', () => {
    const fx = make();
    const cam = camera(new THREE.Vector3(30, 5, 30), new THREE.Vector3(0, 1, 0));
    fx.touchdown(new THREE.Vector3(0, 30 + 1.3, 0), -500, { velocity: new THREE.Vector3(0, -2, -30), surface: 'runway' });
    run(fx, cam, 0.5);
    const { geo } = parts(fx);
    expect(geo.instanceCount).toBeGreaterThan(8);
    const pos = (geo.getAttribute('iPos') as THREE.InstancedBufferAttribute).array as Float32Array;
    const xs: number[] = [];
    for (let i = 0; i < geo.instanceCount; i++) xs.push(pos[i * 4]);
    expect(Math.min(...xs)).toBeLessThan(-0.6);
    expect(Math.max(...xs)).toBeGreaterThan(0.6);
  });
  it('dt = 0 (paused) freezes but keeps drawing', () => {
    const fx = make();
    const cam = camera();
    fx.crash(new THREE.Vector3(0, 31, 0), 100);
    run(fx, cam, 1);
    const n = parts(fx).geo.instanceCount;
    const age = fx.sim.smoke.time;
    for (let k = 0; k < 30; k++) fx.update(cam, 0);
    expect(parts(fx).geo.instanceCount).toBe(n);
    expect(fx.sim.smoke.time).toBe(age);
  });
  it('reset clears everything; dispose removes and frees GPU resources', () => {
    const scene = new THREE.Scene();
    const fx = createEffects(scene, { atlasSize: 32 });
    const cam = camera();
    fx.crash(new THREE.Vector3(0, 31, 0), 100);
    run(fx, cam, 1);
    fx.reset();
    fx.update(cam, DT);
    const { mesh, geo, mat, debris, light } = parts(fx);
    expect(geo.instanceCount).toBe(0);
    expect(mesh.visible).toBe(false);
    expect(debris.count).toBe(0);
    if (light) expect(light.intensity).toBe(0);
    const g = vi.spyOn(geo, 'dispose');
    const m = vi.spyOn(mat, 'dispose');
    const t = vi.spyOn(mat.uniforms.uAtlas.value as THREE.Texture, 'dispose');
    const nz = vi.spyOn(mat.uniforms.uNoise.value as THREE.Texture, 'dispose');
    fx.dispose();
    expect(nz).toHaveBeenCalled();
    expect(fx.object.parent).toBeNull();
    expect(g).toHaveBeenCalled();
    expect(m).toHaveBeenCalled();
    expect(t).toHaveBeenCalled();
    expect(() => fx.update(cam, DT)).not.toThrow();
  });
  it('setSun feeds a normalised view-space sun direction', () => {
    const fx = make();
    const cam = camera();
    fx.setSun(new THREE.Vector3(0, 10, 0));
    fx.update(cam, DT);
    const v = parts(fx).mat.uniforms.uSunView.value as THREE.Vector3;
    expect(v.length()).toBeCloseTo(1, 6);
    expect(v.y).toBeGreaterThan(0.9); // camera nearly level: world up ≈ view up
  });
  it('wind carries the smoke', () => {
    const fx = make();
    const cam = camera();
    fx.crash(new THREE.Vector3(0, 31, 0), 100);
    run(fx, cam, 10, new THREE.Vector3(10, 0, 0));
    const s = fx.sim.smoke;
    let sum = 0, n = 0;
    for (let i = 0; i < s.capacity; i++) if (s.alive[i]) { sum += s.px[i]; n++; }
    expect(sum / n).toBeGreaterThan(15);
  });
  it('fuzz: random crash/touchdown/update/reset sequences never throw or produce NaN', () => {
    const wild = fc.oneof(fc.double(), fc.constantFrom(Number.NaN, Infinity, -Infinity, 0));
    const op = fc.oneof(
      fc.record({ k: fc.constant('crash' as const), x: wild, s: wild, v: wild }),
      fc.record({ k: fc.constant('td' as const), x: wild, fpm: wild, q: wild }),
      fc.record({ k: fc.constant('update' as const), dt: wild, w: wild, cx: wild }),
      fc.record({ k: fc.constant('reset' as const) }),
    );
    const fx = make();
    fc.assert(fc.property(fc.array(op, { maxLength: 20 }), (ops) => {
      fx.reset();
      for (const o of ops) {
        if (o.k === 'crash') fx.crash(new THREE.Vector3(o.x, 30, o.x), o.s, { velocity: new THREE.Vector3(o.v, o.v, o.v) });
        else if (o.k === 'td') fx.touchdown(new THREE.Vector3(o.x, 31, 0), o.fpm, { orientation: new THREE.Quaternion(o.q, 0, 0, 1), velocity: new THREE.Vector3(0, 0, o.q) });
        else if (o.k === 'update') {
          const cam = camera(new THREE.Vector3(Number.isFinite(o.cx) ? o.cx % 1e5 : 0, 40, 250));
          fx.update(cam, o.dt, new THREE.Vector3(o.w, 0, o.w));
        } else fx.reset();
        expect(instanceValuesFinite(fx)).toBe(true);
        expect(parts(fx).geo.instanceCount).toBeLessThanOrEqual(FX.smokeCapacity + FX.fireCapacity);
      }
    }), { numRuns: 60 });
  });
});

describe('per-particle look data', () => {
  const attr = (fx: Effects, name: string) => (parts(fx).geo.getAttribute(name) as THREE.InstancedBufferAttribute).array as Float32Array;
  it('each instance carries its ground height, seed, age fraction and aspect (iExtra) and its velocity (iVel)', () => {
    const fx = make();
    const cam = camera(new THREE.Vector3(0, 8, 40), new THREE.Vector3(0, 3, 0));
    fx.sim.addFire(0, 1, 0, 0, 1, 60, 2, true);
    run(fx, cam, 1.5);
    fx.sim.sparks(3, 2, 0, 0, 6, 0, 30);
    run(fx, cam, 0.2);
    const n = parts(fx).geo.instanceCount;
    expect(n).toBeGreaterThan(20);
    const ex = attr(fx, 'iExtra'), vel = attr(fx, 'iVel'), par = attr(fx, 'iParams');
    const seeds = new Set<number>();
    let sparks = 0, tall = 0;
    for (let k = 0; k < n; k++) {
      expect(ex[k * 4]).toBeLessThanOrEqual(1e-3); // fade height: at or below the ground under the fire
      expect(ex[k * 4]).toBeGreaterThan(-40);
      seeds.add(ex[k * 4 + 1]);
      expect(ex[k * 4 + 2]).toBeGreaterThanOrEqual(0); // age fraction
      expect(ex[k * 4 + 2]).toBeLessThanOrEqual(1);
      expect(ex[k * 4 + 3]).toBeGreaterThan(0); // aspect
      if (ex[k * 4 + 3] < 0.7) tall++;
      if (par[k * 4 + 3] === SPARK_TILE) {
        sparks++;
        expect(Math.hypot(vel[k * 4], vel[k * 4 + 1], vel[k * 4 + 2])).toBeGreaterThan(0.5);
      }
    }
    expect(seeds.size).toBe(n); // no two particles alike
    expect(sparks).toBeGreaterThan(10);
    expect(tall).toBeGreaterThan(2);
  });
  it('the animation clock advances with dt and freezes while paused', () => {
    const fx = make();
    const cam = camera();
    const u = parts(fx).mat.uniforms;
    run(fx, cam, 0.5);
    const t0 = u.uTime.value as number;
    expect(t0).toBeGreaterThan(0.4);
    for (let k = 0; k < 10; k++) fx.update(cam, 0);
    expect(u.uTime.value).toBe(t0);
  });
  it('the shader animates flames, fireballs and puffs from a tiling noise texture and draws sparks as streaks', () => {
    const { mat } = parts(make());
    const noise = mat.uniforms.uNoise.value as THREE.Texture;
    expect(noise.wrapS).toBe(THREE.RepeatWrapping);
    expect(noise.wrapT).toBe(THREE.RepeatWrapping);
    for (const k of ['smokeErosion', 'selfShadow', 'fireballTemperature', 'flameTemperature', 'fireRamp', 'uNoise', 'uTime']) expect(mat.fragmentShader).toContain(k);
    for (const k of ['pixelScale', 'variation', 'iVel', 'iExtra', 'uShutter']) expect(mat.vertexShader).toContain(k);
    expect(mat.uniforms.uMinPx.value).toBe(FX.minPixels);
  });
  it('the viewport height reaches the shader before each draw (for the minimum pixel size)', () => {
    const fx = make();
    const { mesh, mat } = parts(fx);
    const fake = { getCurrentViewport: (v: THREE.Vector4) => v.set(0, 0, 1440, 900) } as unknown as THREE.WebGLRenderer;
    mesh.onBeforeRender(fake, new THREE.Scene(), camera(), mesh.geometry, mat, null as unknown as THREE.Group);
    expect(mat.uniforms.uViewportH.value).toBe(900);
  });
});
