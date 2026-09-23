/**
 * Earth berms and revetments (the plan's `berms`): smooth mounds of fresh-dug earth — a rounded
 * profile across the berm, tapered ends, grassed-over lower flanks — draped over the ground and
 * merged into one static geometry (one draw call for the whole range). Vertex-coloured for the
 * shared vehicle material (lift, pull, fog), with the `aPart` attribute the material expects.
 */
import * as THREE from 'three';
import { CONFIG } from '../../config';
import type { Berm } from './plan';

const NU = 9;
const NV = 10;

/** Height of a berm (m) at local (u across its thickness, v along its length) — 0 outside. */
export function bermHeight(b: Pick<Berm, 'length' | 'width' | 'height'>, u: number, v: number): number {
  const hu = (b.length / 2) * 1.25;
  const t = u / hu;
  if (Math.abs(t) >= 1) return 0;
  const bump = (1 - t * t) * (1 - t * t);
  const end = b.width / 2 - Math.abs(v);
  if (end <= 0) return 0;
  const k = Math.min(1, end / 1.8);
  const taper = k * k * (3 - 2 * k);
  return b.height * bump * taper;
}

export function buildBermGeometry(berms: readonly Berm[], ground: (x: number, z: number) => number, cfg = CONFIG.combat.range.berm): THREE.BufferGeometry {
  const nPer = NU * NV;
  const pos = new Float32Array(berms.length * nPer * 3);
  const col = new Float32Array(berms.length * nPer * 3);
  const idx: number[] = [];
  const DEG = Math.PI / 180;
  berms.forEach((b, bi) => {
    const h = b.headingDeg * DEG;
    const fx = Math.sin(h);
    const fz = -Math.cos(h);
    const rx = -fz;
    const rz = fx;
    const hu = (b.length / 2) * 1.25;
    const base = bi * nPer;
    for (let j = 0; j < NV; j++) {
      const v = -b.width / 2 + (b.width * j) / (NV - 1);
      for (let i = 0; i < NU; i++) {
        const u = -hu + (2 * hu * i) / (NU - 1);
        const x = b.x + fx * u + rx * v;
        const z = b.z + fz * u + rz * v;
        const hh = bermHeight(b, u, v);
        const k = (base + j * NU + i) * 3;
        pos[k] = x;
        pos[k + 1] = ground(x, z) + hh - 0.12;
        pos[k + 2] = z;
        // fresh earth on the crest, grass creeping up the flanks (a little mottled)
        const n = Math.sin(x * 1.7 + z * 0.9) * 0.5 + 0.5;
        const e = Math.min(1, Math.max(0, (hh / b.height - 0.12) / 0.45)) * (0.75 + 0.25 * n);
        col[k] = cfg.grass[0] + (cfg.color[0] - cfg.grass[0]) * e;
        col[k + 1] = cfg.grass[1] + (cfg.color[1] - cfg.grass[1]) * e;
        col[k + 2] = cfg.grass[2] + (cfg.color[2] - cfg.grass[2]) * e;
      }
    }
    for (let j = 0; j < NV - 1; j++)
      for (let i = 0; i < NU - 1; i++) {
        const a = base + j * NU + i;
        const c = a + NU;
        idx.push(a, c, a + 1, a + 1, c, c + 1);
      }
  });
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array((pos.length / 3) * 4), 4));
  g.setIndex(idx);
  g.computeVertexNormals();
  // make every triangle face up (winding depends on the berm's heading)
  const nrm = g.getAttribute('normal') as THREE.BufferAttribute;
  let down = 0;
  for (let i = 0; i < nrm.count; i++) if (nrm.getY(i) < 0) down++;
  if (down > nrm.count / 2) {
    for (let t = 0; t < idx.length; t += 3) [idx[t + 1], idx[t + 2]] = [idx[t + 2], idx[t + 1]];
    g.setIndex(idx);
    g.computeVertexNormals();
  }
  g.computeBoundingSphere();
  return g;
}
