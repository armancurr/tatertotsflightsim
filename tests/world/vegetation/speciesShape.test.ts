/**
 * Crown structure of the species meshes (wave 7 realism pass): foliage grouped into clumps that the
 * vertex shader can shrink or drop per tree (irregular silhouettes, bare branches in the gaps),
 * clump-shaded normals (each foliage mass has a lit top and a shaded underside), interior ambient
 * occlusion, grey-brown bark, triangle budgets, and robustness of the builders over any seed.
 */
import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import * as THREE from 'three';
import { buildSpeciesGeometry, triangleCount, SPECIES_R0 } from '../../../src/world/vegetation/species';
import { canopyProfile, SPECIES_COUNT, SPECIES_NAMES, SPRUCE, PINE, BROADLEAF, BIRCH, POPLAR, WILLOW, BUSH } from '../../../src/world/vegetation/placement';
import { fcParams } from '../../support/fc';

/** Triangle budget per species (the near meshes are drawn for up to ~1,500 trees at low level). */
const BUDGET: Record<number, number> = { [SPRUCE]: 800, [PINE]: 520, [BROADLEAF]: 760, [BIRCH]: 520, [POPLAR]: 480, [WILLOW]: 540, [BUSH]: 320 };
/** Minimum number of separate foliage clumps (the unit the shader varies per tree). */
const MIN_CLUMPS: Record<number, number> = { [SPRUCE]: 40, [PINE]: 6, [BROADLEAF]: 10, [BIRCH]: 7, [POPLAR]: 7, [WILLOW]: 6, [BUSH]: 4 };

const attr = (g: THREE.BufferGeometry, n: string) => g.getAttribute(n) as THREE.BufferAttribute;

function insideEnvelope(s: number, x: number, y: number, z: number, tol = 0.03): boolean {
  const rho = Math.hypot(x, z);
  if (rho > 1 + tol) return false;
  return y <= canopyProfile(s, Math.min(rho, 1)) + tol;
}

describe('species crowns: clumps, shading, budgets', () => {
  for (let s = 0; s < SPECIES_COUNT; s++) {
    describe(SPECIES_NAMES[s], () => {
      const g = buildSpeciesGeometry(s);
      const pos = attr(g, 'position');
      const leaf = attr(g, 'leaf');
      const clump = attr(g, 'clump');

      it('stays within its triangle budget', () => {
        expect(triangleCount(g)).toBeLessThanOrEqual(BUDGET[s]);
      });

      it('every foliage vertex belongs to a clump; the trunk belongs to none', () => {
        expect(clump).toBeDefined();
        expect(clump.itemSize).toBe(4);
        expect(clump.count).toBe(pos.count);
        const ids = new Set<number>();
        let trunk = 0;
        for (let i = 0; i < pos.count; i++) {
          const w = clump.getW(i);
          if (leaf.getX(i) > 0.5) {
            expect(w).toBeGreaterThanOrEqual(0);
            ids.add(w);
          } else if (w < 0) trunk++;
        }
        expect(ids.size).toBeGreaterThanOrEqual(MIN_CLUMPS[s]);
        expect(trunk).toBeGreaterThan(0);
        // ids are small integers (the shader hashes them)
        for (const id of ids) expect(Number.isInteger(id) && id < 256).toBe(true);
      });

      it('clump centres lie inside the envelope, so shrinking any clump toward its centre stays inside (property)', () => {
        const n = pos.count;
        fc.assert(
          fc.property(fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 256, maxLength: 256 }), (scales) => {
            for (let i = 0; i < n; i++) {
              const w = clump.getW(i);
              if (w < 0) continue;
              const k = scales[w];
              const cx = clump.getX(i);
              const cy = clump.getY(i);
              const cz = clump.getZ(i);
              const x = cx + (pos.getX(i) - cx) * k;
              const y = cy + (pos.getY(i) - cy) * k;
              const z = cz + (pos.getZ(i) - cz) * k;
              if (!insideEnvelope(s, x, y, z)) return false;
            }
            return true;
          }),
          fcParams(25),
        );
      });
    });
  }

  it('broadleaf clumps are shaded as masses: normals on the top of a clump point up, on its underside down', () => {
    const g = buildSpeciesGeometry(BROADLEAF);
    const pos = attr(g, 'position');
    const nrm = attr(g, 'normal');
    const clump = attr(g, 'clump');
    const leaf = attr(g, 'leaf');
    let up = 0;
    let nu = 0;
    let down = 0;
    let nd = 0;
    for (let i = 0; i < pos.count; i++) {
      if (leaf.getX(i) < 0.5) continue;
      const dy = pos.getY(i) - clump.getY(i);
      if (dy > 0.04) {
        up += nrm.getY(i);
        nu++;
      } else if (dy < -0.04) {
        down += nrm.getY(i);
        nd++;
      }
    }
    expect(nu).toBeGreaterThan(50);
    expect(nd).toBeGreaterThan(50);
    expect(up / nu - down / nd).toBeGreaterThan(0.35);
  });

  it('ambient occlusion: foliage deep inside a broadleaf crown is darker than its outer shell', () => {
    const g = buildSpeciesGeometry(BROADLEAF);
    const pos = attr(g, 'position');
    const col = attr(g, 'color');
    const leaf = attr(g, 'leaf');
    const yc = 0.6;
    let inner = 0;
    let ni = 0;
    let outer = 0;
    let no = 0;
    for (let i = 0; i < pos.count; i++) {
      if (leaf.getX(i) < 0.5) continue;
      const d = Math.hypot(pos.getX(i), (pos.getY(i) - yc) / 0.4, pos.getZ(i));
      const l = 0.3 * col.getX(i) + 0.59 * col.getY(i) + 0.11 * col.getZ(i);
      if (d < 0.5) {
        inner += l;
        ni++;
      } else if (d > 0.85) {
        outer += l;
        no++;
      }
    }
    expect(ni).toBeGreaterThan(20);
    expect(no).toBeGreaterThan(50);
    expect(inner / ni).toBeLessThan((outer / no) * 0.75);
  });

  it('bark: broadleaf trunks are grey-brown (not red), birch bark is near white, pine upper trunk orange', () => {
    const barkMean = (s: number) => {
      const g = buildSpeciesGeometry(s);
      const col = attr(g, 'color');
      const leaf = attr(g, 'leaf');
      const m = [0, 0, 0];
      let n = 0;
      for (let i = 0; i < col.count; i++)
        if (leaf.getX(i) < 0.5) {
          m[0] += col.getX(i);
          m[1] += col.getY(i);
          m[2] += col.getZ(i);
          n++;
        }
      return m.map((v) => v / n);
    };
    const oak = barkMean(BROADLEAF);
    expect(oak[0] / oak[2]).toBeLessThan(1.2); // grey-brown, not rust
    expect(oak[0]).toBeGreaterThanOrEqual(oak[2]);
    const birch = barkMean(BIRCH);
    expect(Math.min(...birch)).toBeGreaterThan(0.5);
    const pine = barkMean(PINE);
    expect(pine[0] / pine[2]).toBeGreaterThan(1.4);
  });

  it('any seed builds a valid tree: finite, inside the envelope, within budget, with clumps (fuzz)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: SPECIES_COUNT - 1 }), fc.integer({ min: 1, max: 0x7fffffff }), (s, seed) => {
        const g = buildSpeciesGeometry(s, seed);
        const pos = attr(g, 'position');
        const nrm = attr(g, 'normal');
        const clump = attr(g, 'clump');
        if (triangleCount(g) > BUDGET[s]) return false;
        for (let i = 0; i < pos.count; i++) {
          const v = [pos.getX(i), pos.getY(i), pos.getZ(i), nrm.getX(i), nrm.getY(i), nrm.getZ(i), clump.getX(i), clump.getY(i), clump.getZ(i), clump.getW(i)];
          if (!v.every(Number.isFinite)) return false;
          if (!insideEnvelope(s, pos.getX(i), pos.getY(i), pos.getZ(i))) return false;
          if (Math.abs(Math.hypot(v[3], v[4], v[5]) - 1) > 1e-3) return false;
        }
        const idx = g.index!;
        for (let i = 0; i < idx.count; i++) if (idx.getX(i) >= pos.count) return false;
        const box = new THREE.Box3().setFromBufferAttribute(pos);
        return box.max.y > 0.9 && box.max.y <= 1.0001 && box.min.y > -0.12;
      }),
      fcParams(40),
    );
  }, 60000);

  it('the default build is the seed the game uses (deterministic), other seeds differ', () => {
    const a = buildSpeciesGeometry(BROADLEAF);
    const b = buildSpeciesGeometry(BROADLEAF, 12345);
    const pa = Array.from(attr(a, 'position').array);
    const pb = Array.from(attr(b, 'position').array);
    expect(pa).not.toEqual(pb);
    expect(Array.from(attr(buildSpeciesGeometry(BROADLEAF), 'position').array)).toEqual(pa);
    expect(SPECIES_R0[BROADLEAF]).toBeGreaterThan(0.3);
  });
});
