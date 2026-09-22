import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { createTowns } from '../../../src/world/towns';
import { createRoads } from '../../../src/world/roads';
import { createObstacleIndex } from '../../../src/world/towns/obstacles';
import { LAYOUT, HEIGHT } from './fixtures';

const camAt = (x: number, y: number, z: number, tx: number, tz: number): THREE.PerspectiveCamera => {
  const cam = new THREE.PerspectiveCamera(60, 1440 / 900, 1, 60000);
  cam.position.set(x, y, z);
  cam.lookAt(tx, HEIGHT(tx, tz), tz);
  cam.updateMatrixWorld();
  return cam;
};

describe('createTowns (functional)', () => {
  const scene = new THREE.Scene();
  const towns = createTowns(scene, { heightAt: HEIGHT });
  it('adds the buildings to the scene and answers obstacle queries from the same placement', () => {
    expect(scene.getObjectByName('towns')).toBeTruthy();
    expect(towns.stats().buildings).toBe(towns.buildings.length);
    const idx = createObstacleIndex(towns.buildings);
    for (const b of towns.buildings.slice(0, 200)) expect(towns.obstacleTop(b.x, b.z)).toBe(idx(b.x, b.z));
  });
  it('draws the city when looking at it and nothing when far away out at sea', () => {
    const city = LAYOUT.towns[1];
    towns.update(camAt(city.x, 800, city.z + 2500, city.x, city.z), 0);
    expect(towns.stats().drawCalls).toBeGreaterThan(3);
    towns.update(camAt(0, 500, 60000, 0, 80000), 0);
    expect(towns.stats().drawCalls).toBe(0);
  });
  it('dispose removes everything', () => {
    towns.dispose();
    expect(scene.getObjectByName('towns')).toBeUndefined();
  });
});

describe('createRoads (functional)', () => {
  const scene = new THREE.Scene();
  const roads = createRoads(scene, { heightAt: HEIGHT });
  it('builds merged chunk meshes and culls by distance/frustum', () => {
    expect(scene.getObjectByName('roads')).toBeTruthy();
    expect(roads.stats().chunks).toBeGreaterThan(50);
    roads.update(camAt(2100, 400, 4500, 2100, 2100), 0);
    expect(roads.stats().drawCalls).toBeGreaterThan(0);
    roads.update(camAt(0, 500, 90000, 0, 120000), 0);
    expect(roads.stats().drawCalls).toBe(0);
    roads.dispose();
    expect(scene.getObjectByName('roads')).toBeUndefined();
  });
});
