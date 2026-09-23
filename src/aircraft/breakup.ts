/**
 * Crash break-up support for the model: split merged geometry into per-part pieces, and a rig
 * that remembers where every part lives so the crash system can detach parts into the scene
 * (flinging them as rigid bodies) and `restore()` puts each one back exactly — same parent,
 * same child slot, same local transform, visible again.
 *
 * Every part object is a pure container at the identity when attached: the model animates
 * only its children (surfaces, gear links, prop spin…), never the part object itself, so a
 * detached part's transform belongs to the crash system alone.
 */
import * as THREE from 'three';
import type { BreakupPart } from '../fleet/types';

/**
 * Partition an indexed (or non-indexed) geometry's triangles into `n` compacted geometries by
 * a classifier on each triangle's centroid (body frame). Classes outside 0..n−1 are dropped.
 * Every attribute is carried over; an empty class gives null. The input is not modified.
 */
export function splitByTriangles(
  geo: THREE.BufferGeometry,
  n: number,
  classify: (cx: number, cy: number, cz: number) => number,
): Array<THREE.BufferGeometry | null> {
  const pos = geo.getAttribute('position');
  const index = geo.index;
  const triCount = (index ? index.count : pos.count) / 3;
  const vi = (i: number) => (index ? index.getX(i) : i);
  const lists: number[][] = Array.from({ length: n }, () => []);
  for (let t = 0; t < triCount; t++) {
    const a = vi(t * 3);
    const b = vi(t * 3 + 1);
    const c = vi(t * 3 + 2);
    const cx = (pos.getX(a) + pos.getX(b) + pos.getX(c)) / 3;
    const cy = (pos.getY(a) + pos.getY(b) + pos.getY(c)) / 3;
    const cz = (pos.getZ(a) + pos.getZ(b) + pos.getZ(c)) / 3;
    const k = classify(cx, cy, cz);
    if (k >= 0 && k < n) lists[k].push(a, b, c);
  }
  const names = Object.keys(geo.attributes);
  return lists.map((tris) => {
    if (tris.length === 0) return null;
    const remap = new Map<number, number>();
    const order: number[] = [];
    const idx = new (tris.length > 65535 ? Uint32Array : Uint16Array)(tris.length);
    for (let i = 0; i < tris.length; i++) {
      let j = remap.get(tris[i]);
      if (j === undefined) {
        j = order.length;
        remap.set(tris[i], j);
        order.push(tris[i]);
      }
      idx[i] = j;
    }
    const out = new THREE.BufferGeometry();
    for (const name of names) {
      const src = geo.getAttribute(name) as THREE.BufferAttribute;
      const size = src.itemSize;
      const Ctor = src.array.constructor as new (len: number) => THREE.TypedArray;
      const arr = new Ctor(order.length * size);
      for (let i = 0; i < order.length; i++) for (let c = 0; c < size; c++) arr[i * size + c] = src.array[order[i] * size + c];
      out.setAttribute(name, new THREE.BufferAttribute(arr, size, src.normalized));
    }
    out.setIndex(new THREE.BufferAttribute(idx, 1));
    out.computeBoundingSphere();
    return out;
  });
}

interface Slot {
  part: BreakupPart;
  parent: THREE.Object3D;
  index: number;
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  scale: THREE.Vector3;
}

export interface BreakupRig {
  parts: BreakupPart[];
  /** Put every part back where it was when the rig was made (attached, identity-slot, visible). */
  restore(): void;
}

/** Remember the parent/slot/local transform of each part (call while the model is intact). */
export function createBreakupRig(parts: BreakupPart[]): BreakupRig {
  const slots: Slot[] = parts.map((part) => {
    const o = part.object;
    const parent = o.parent;
    if (!parent) throw new Error(`breakup part ${part.name} has no parent`);
    return { part, parent, index: parent.children.indexOf(o), position: o.position.clone(), quaternion: o.quaternion.clone(), scale: o.scale.clone() };
  });
  // Restore in ascending slot order per parent so each lands back in its original position.
  const order = [...slots].sort((a, b) => a.index - b.index);
  return {
    parts,
    restore() {
      for (const s of order) {
        const o = s.part.object;
        if (o.parent !== s.parent) {
          o.removeFromParent();
          s.parent.add(o);
        }
        const kids = s.parent.children;
        const at = kids.indexOf(o);
        const want = Math.min(s.index, kids.length - 1);
        if (at !== want) {
          kids.splice(at, 1);
          kids.splice(want, 0, o);
        }
        o.position.copy(s.position);
        o.quaternion.copy(s.quaternion);
        o.scale.copy(s.scale);
        o.visible = true;
        o.matrixAutoUpdate = true;
        o.updateMatrix();
      }
    },
  };
}
