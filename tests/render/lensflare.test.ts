import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { sunScreenPosition, flareEdgeFade } from '../../src/render/lensflare';
import { sunDirectionFromAngles } from '../../src/render/sun';

function camera() {
  const c = new THREE.PerspectiveCamera(60, 16 / 10, 0.08, 90000);
  c.position.set(100, 50, -200); // position must not matter: the sun is at infinity
  c.updateMatrixWorld();
  return c;
}

describe('sun screen position', () => {
  it('puts a sun straight ahead (north, on the horizon) at the screen centre', () => {
    const p = sunScreenPosition(sunDirectionFromAngles(0, 0), camera(), { x: 0, y: 0, inFront: false });
    expect(p.inFront).toBe(true);
    expect(p.x).toBeCloseTo(0, 6);
    expect(p.y).toBeCloseTo(0, 6);
  });
  it('maps elevation to NDC y through the vertical field of view', () => {
    const p = sunScreenPosition(sunDirectionFromAngles(10, 0), camera(), { x: 0, y: 0, inFront: false });
    expect(p.y).toBeCloseTo(Math.tan((10 * Math.PI) / 180) / Math.tan((30 * Math.PI) / 180), 4);
  });
  it('reports a sun behind the camera as not in front', () => {
    const p = sunScreenPosition(sunDirectionFromAngles(20, 180), camera(), { x: 0, y: 0, inFront: true });
    expect(p.inFront).toBe(false);
  });
  it('east is to the right when looking north', () => {
    const p = sunScreenPosition(sunDirectionFromAngles(0, 20), camera(), { x: 0, y: 0, inFront: false });
    expect(p.x).toBeGreaterThan(0);
  });
});

describe('flare edge fade', () => {
  it('is 1 near the centre and 0 well off screen', () => {
    expect(flareEdgeFade(0, 0)).toBe(1);
    expect(flareEdgeFade(1.6, 0)).toBe(0);
    expect(flareEdgeFade(0.95, 0)).toBeGreaterThan(0);
    expect(flareEdgeFade(0.95, 0)).toBeLessThan(1);
  });
});
