/**
 * The terrain material: MeshStandardMaterial extended with onBeforeCompile so
 * three's PBR lighting, shadow receiving, log/reversed depth and — importantly —
 * the (atmosphere-overridden) fog chunks all stay intact. `fog: true`.
 * The procedural surface lives in terrainShader.ts.
 */
import * as THREE from 'three';
import { CONFIG, type Config } from '../../config';
import type { WorldLayout } from '../layout';
import {
  TERRAIN_VERTEX_PARS,
  TERRAIN_BEGIN_VERTEX,
  TERRAIN_WORLDPOS_VERTEX,
  TERRAIN_FRAGMENT_PARS,
  TERRAIN_MAP_FRAGMENT,
  TERRAIN_ROUGHNESS_FRAGMENT,
  TERRAIN_NORMAL_FRAGMENT,
} from './terrainShader';

export interface TerrainMaterial {
  material: THREE.MeshStandardMaterial;
  /** Advance animated detail (surf). */
  setTime(t: number): void;
}

function replaceOnce(src: string, find: string, repl: string): string {
  if (!src.includes(find)) throw new Error(`terrain material: shader chunk ${find} not found`);
  return src.replace(find, repl);
}

export function createTerrainMaterial(layout: WorldLayout, cfg: Config = CONFIG): TerrainMaterial {
  const ap = layout.airport;
  const paved = ap.pavedAreas.slice(0, 8);
  const pavedA = [];
  const pavedB = [];
  for (let i = 0; i < 8; i++) {
    const r = paved[i];
    if (!r) {
      pavedA.push(new THREE.Vector4(1e9, 1e9, 0, 0));
      pavedB.push(new THREE.Vector4(0, -1, 1, 0));
      continue;
    }
    const h = (r.headingDeg * Math.PI) / 180;
    pavedA.push(new THREE.Vector4(r.center.x, r.center.z, r.halfLength, r.halfWidth));
    pavedB.push(new THREE.Vector4(Math.sin(h), -Math.cos(h), i === 0 ? 0 : 1, 0));
  }
  const uniforms = {
    uTime: { value: 0 },
    uSplit: { value: cfg.world.terrain.lodSplitFactor },
    uPavedA: { value: pavedA },
    uPavedB: { value: pavedB },
    uPavedCount: { value: paved.length },
    uAirport: { value: new THREE.Vector4(ap.runway.center.x, ap.runway.center.z, ap.flatRadius, (ap.runway.headingDeg * Math.PI) / 180) },
  };

  const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, metalness: 0, fog: true });
  material.name = 'terrain';
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    let v = shader.vertexShader;
    v = replaceOnce(v, '#include <common>', `#include <common>\n${TERRAIN_VERTEX_PARS}`);
    v = replaceOnce(v, '#include <begin_vertex>', TERRAIN_BEGIN_VERTEX);
    v = replaceOnce(v, '#include <worldpos_vertex>', `#include <worldpos_vertex>\n${TERRAIN_WORLDPOS_VERTEX}`);
    shader.vertexShader = v;
    let f = shader.fragmentShader;
    f = replaceOnce(f, '#include <common>', `#include <common>\n${TERRAIN_FRAGMENT_PARS}`);
    f = replaceOnce(f, '#include <map_fragment>', TERRAIN_MAP_FRAGMENT);
    f = replaceOnce(f, '#include <roughnessmap_fragment>', TERRAIN_ROUGHNESS_FRAGMENT);
    f = replaceOnce(f, '#include <normal_fragment_maps>', `#include <normal_fragment_maps>\n${TERRAIN_NORMAL_FRAGMENT}`);
    shader.fragmentShader = f;
  };
  material.customProgramCacheKey = () => 'terrain-v1';
  return {
    material,
    setTime(t: number) {
      uniforms.uTime.value = t;
    },
  };
}
