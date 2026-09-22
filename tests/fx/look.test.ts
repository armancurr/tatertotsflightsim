/**
 * The look of the effects, as numbers: a fire colour ramp that is always a flame colour (never
 * pink/white-blue), a screen-coverage limiter so nothing swamps the camera, a short fireball that
 * turns into dark smoke, small ground fires, and modest touchdown puffs.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { fireColor, screenCoverFade, FIRE_GLSL } from '../../src/fx/shading';
import { FxSim } from '../../src/fx/sim';
import { createEffects } from '../../src/fx';
import { particleAlpha, particleHeat, particleSize, type ParticlePool } from '../../src/fx/pool';
import { CONFIG } from '../../src/config';

const FX = CONFIG.fx;
const DT = 1 / 60;
const run = (sim: FxSim, s: number) => {
  for (let i = 0; i < Math.round(s / DT); i++) sim.step(DT, 0, 0, 0);
};
const alive = (p: ParticlePool) => {
  const out: number[] = [];
  for (let i = 0; i < p.capacity; i++) if (p.alive[i] && particleAlpha(p, i) > 0.01) out.push(i);
  return out;
};
/** Total visible flame "power" (heat × opacity × area) of the fire pool. */
const flamePower = (p: ParticlePool) => alive(p).reduce((s, i) => s + particleHeat(p, i) * particleAlpha(p, i) * particleSize(p, i) ** 2, 0);

describe('fire colour ramp (blackbody-like)', () => {
  it('is dark red when cool, orange, then yellow when hot — red ≥ green ≥ blue always (never pink or blue-white)', () => {
    fc.assert(
      fc.property(fc.double({ min: 0, max: 1.5, noNaN: true }), (t) => {
        const c = fireColor(t);
        expect(c.r).toBeGreaterThanOrEqual(c.g - 1e-9);
        expect(c.g).toBeGreaterThanOrEqual(c.b - 1e-9);
        expect(c.b).toBeLessThanOrEqual(c.r * 0.5 + 1e-9);
      }),
    );
    const cool = fireColor(0.3);
    const mid = fireColor(0.65);
    const hot = fireColor(1.1);
    expect(cool.g / cool.r).toBeLessThan(0.25);
    expect(mid.g / mid.r).toBeGreaterThan(0.25);
    expect(mid.g / mid.r).toBeLessThan(0.6);
    expect(hot.g / hot.r).toBeGreaterThan(0.6);
  });
  it('brightness rises monotonically with temperature, zero when cold, finite for garbage', () => {
    let last = -1;
    for (let t = 0; t <= 1.5; t += 0.01) {
      const c = fireColor(t);
      const y = c.r + c.g + c.b;
      expect(y).toBeGreaterThanOrEqual(last - 1e-9);
      last = y;
    }
    expect(fireColor(0).r).toBe(0);
    for (const t of [Number.NaN, -1, Infinity]) {
      const c = fireColor(t);
      expect(Number.isFinite(c.r + c.g + c.b)).toBe(true);
    }
  });
  it('the GLSL uses the same ramp constants', () => {
    expect(FIRE_GLSL).toContain('vec3 fireRamp');
  });
});

describe('screen coverage limiter', () => {
  it('leaves small/far sprites alone and fades sprites that would fill the screen', () => {
    const p11 = 1 / Math.tan((30 * Math.PI) / 180); // 60° vertical FOV
    expect(screenCoverFade(5, 300, p11, FX.maxScreenCover)).toBe(1);
    expect(screenCoverFade(10, 15, p11, FX.maxScreenCover)).toBeLessThan(0.7);
    expect(screenCoverFade(30, 8, p11, FX.maxScreenCover)).toBeLessThan(0.1);
  });
  it('fuzz: in [0,1], non-increasing in size, non-decreasing in distance', () => {
    const p11 = 1.732;
    fc.assert(
      fc.property(fc.double({ min: 0.01, max: 200, noNaN: true }), fc.double({ min: 0.01, max: 200, noNaN: true }), fc.double({ min: 0.1, max: 5000, noNaN: true }), (s1, s2, d) => {
        const a = screenCoverFade(Math.min(s1, s2), d, p11, FX.maxScreenCover);
        const b = screenCoverFade(Math.max(s1, s2), d, p11, FX.maxScreenCover);
        expect(a).toBeGreaterThanOrEqual(b - 1e-12);
        expect(a).toBeLessThanOrEqual(1);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(screenCoverFade(s1, d * 2, p11, FX.maxScreenCover)).toBeGreaterThanOrEqual(screenCoverFade(s1, d, p11, FX.maxScreenCover) - 1e-12);
      }),
    );
    expect(Number.isFinite(screenCoverFade(Number.NaN, 0, Number.NaN, 0.4))).toBe(true);
  });
  it('the particle shader applies it (and the sun lighting, fog and fire ramp)', () => {
    const fx = createEffects(new THREE.Scene(), { atlasSize: 16 });
    const mesh = fx.object.getObjectByName('fx-particles') as THREE.Mesh<THREE.BufferGeometry, THREE.ShaderMaterial>;
    expect(mesh.material.vertexShader).toContain('uMaxCover');
    expect(mesh.material.fragmentShader).toContain('fireRamp');
    expect(mesh.material.uniforms.uMaxCover.value).toBe(FX.maxScreenCover);
    fx.dispose();
  });
});

describe('crash: real-footage behaviour', () => {
  it('the fireball is short: flame power at 2.5 s is a small fraction of the peak', () => {
    const sim = new FxSim(11);
    sim.crash(0, 30, 0, 110, 0, -6, -55, 29);
    let peak = 0;
    for (let k = 0; k < 40; k++) {
      run(sim, 0.05);
      peak = Math.max(peak, flamePower(sim.fire));
    }
    run(sim, 0.5); // 2.5 s
    expect(flamePower(sim.fire)).toBeLessThan(peak * 0.25);
  });
  it('turns into dark smoke: after 3 s the smoke is dark (albedo ≤ 0.12) and plentiful', () => {
    const sim = new FxSim(11);
    sim.crash(0, 30, 0, 110, 0, -6, -55, 29);
    run(sim, 3);
    const vis = alive(sim.smoke);
    expect(vis.length).toBeGreaterThan(60);
    const dark = vis.filter((i) => (sim.smoke.r[i] + sim.smoke.g[i] + sim.smoke.b[i]) / 3 <= 0.12);
    expect(dark.length / vis.length).toBeGreaterThan(0.7);
  });
  it('ground fires are small flickering flames, not tall flame icons', () => {
    const sim = new FxSim(11);
    sim.crash(0, 30, 0, 110, 0, -6, -55, 29);
    run(sim, 5);
    const flames = alive(sim.fire).filter((i) => particleHeat(sim.fire, i) > 0.3);
    expect(flames.length).toBeGreaterThan(5);
    for (const i of flames) {
      expect(particleSize(sim.fire, i)).toBeLessThan(4.5);
      expect(sim.fire.life[i]).toBeLessThan(1.6);
    }
  });
  it('embers are tiny', () => {
    const sim = new FxSim(11);
    sim.crash(0, 30, 0, 110, 0, -6, -55, 29);
    run(sim, 0.3);
    const tiny = alive(sim.fire).filter((i) => particleSize(sim.fire, i) < 0.35);
    expect(tiny.length).toBeGreaterThan(20);
  });
});

describe('touchdown: modest tyre smoke', () => {
  it('a firm landing makes small, thin, short-lived puffs', () => {
    const sim = new FxSim(3);
    sim.touchdown([{ x: -1.27, y: 30, z: 0 }, { x: 1.27, y: 30, z: 0 }], 29.8, -420, 0, -2, -30, 'runway');
    run(sim, 0.6);
    const vis = alive(sim.smoke);
    expect(vis.length).toBeGreaterThan(4);
    for (const i of vis) {
      expect(sim.smoke.size1[i]).toBeLessThan(3.5);
      expect(sim.smoke.alpha[i]).toBeLessThanOrEqual(0.5);
      expect(sim.smoke.life[i]).toBeLessThanOrEqual(2.6);
    }
  });
  it('a butter landing barely puffs', () => {
    const sim = new FxSim(3);
    sim.touchdown([{ x: -1.27, y: 30, z: 0 }, { x: 1.27, y: 30, z: 0 }], 29.8, -80, 0, -0.4, -30, 'runway');
    run(sim, 0.4);
    const vis = alive(sim.smoke);
    expect(vis.reduce((s, i) => s + sim.smoke.alpha[i] * sim.smoke.size1[i] ** 2, 0)).toBeLessThan(12);
  });
});
