/**
 * Scorch marks and ploughed furrows on the ground after a crash: a small pool of terrain-hugging
 * decals (a grid draped over the height function when placed — no per-frame work), one shared
 * lit, fogged, shadow-receiving material with a procedural soot/earth texture and a tiny depth pull
 * toward the camera so they never z-fight the terrain. Nothing is drawn until a crash places one.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';

const N = 12; // grid segments per side

export interface ScorchEnv {
  groundHeight(x: number, z: number): number;
  waterLevel?(x: number, z: number): number | null;
}

function hash(ix: number, iy: number, seed: number): number {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function vnoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed), c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}
function fbm(x: number, y: number, seed: number): number {
  let s = 0, amp = 0.5, norm = 0, f = 1;
  for (let o = 0; o < 4; o++) {
    s += amp * vnoise(x * f, y * f, seed + o * 13);
    norm += amp;
    amp *= 0.5;
    f *= 2.07;
  }
  return s / norm;
}
const sm = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** RGBA texture 2S × S: left half a burnt crater, right half a ploughed furrow (u along the furrow). */
export function scorchTexture(S = 128): Uint8Array {
  const W = 2 * S;
  const out = new Uint8Array(W * S * 4);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      let r: number, g: number, b: number, a: number;
      if (x < S) {
        const u = ((x + 0.5) / S) * 2 - 1, v = ((y + 0.5) / S) * 2 - 1;
        const rr = Math.hypot(u, v);
        const ang = Math.atan2(v, u);
        const n = fbm(u * 3 + 7, v * 3 + 1, 11);
        const rays = Math.pow(Math.max(0, Math.sin(ang * 7 + 3 * n) * Math.sin(ang * 3.3 + 1)), 3);
        const edge = rr * (1 + 0.5 * (n - 0.5));
        a = sm(0.98, 0.45, edge) * (0.75 + 0.25 * n) + rays * sm(1.0, 0.5, rr) * 0.45;
        a *= sm(1.0, 0.92, rr);
        const soot = sm(0.75, 0.15, edge);
        // soot black in the middle, scorched brown earth toward the rim
        r = 0.03 + (1 - soot) * 0.13; g = 0.025 + (1 - soot) * 0.09; b = 0.02 + (1 - soot) * 0.055;
        const k = 0.8 + 0.4 * fbm(u * 9, v * 9, 3);
        r *= k; g *= k; b *= k;
      } else {
        const u = ((x - S + 0.5) / S) * 2 - 1, v = ((y + 0.5) / S) * 2 - 1;
        const n = fbm(u * 6 + 3, v * 2 + 9, 21);
        const width = 0.6 + 0.35 * (n - 0.5);
        a = sm(width + 0.35, width - 0.1, Math.abs(v)) * sm(1.0, 0.8, Math.abs(u)) * (0.7 + 0.3 * fbm(u * 14, v * 5, 5));
        const groove = 0.5 + 0.5 * Math.sin(v * 18 + 2 * n);
        r = 0.1 * (0.7 + 0.3 * groove); g = 0.075 * (0.7 + 0.3 * groove); b = 0.05 * (0.7 + 0.3 * groove);
        const soot = sm(0.2, 0.9, fbm(u * 3, v * 3, 8));
        r *= 1 - 0.6 * soot; g *= 1 - 0.6 * soot; b *= 1 - 0.6 * soot;
      }
      // colours are linear; the texture is declared linear (no sRGB decode)
      out[o] = Math.round(255 * Math.min(1, r * 3));
      out[o + 1] = Math.round(255 * Math.min(1, g * 3));
      out[o + 2] = Math.round(255 * Math.min(1, b * 3));
      out[o + 3] = Math.round(255 * Math.min(1, Math.max(0, a)));
    }
  }
  return out;
}

export class ScorchMarks {
  readonly group = new THREE.Group();
  private readonly meshes: THREE.Mesh[] = [];
  private readonly material: THREE.MeshStandardMaterial;
  private readonly texture: THREE.DataTexture;
  private next = 0;
  private used = 0;

  constructor(scene: THREE.Object3D, count: number = CONFIG.crash.scorch.count) {
    this.group.name = 'crash-scorch';
    const S = 128;
    this.texture = new THREE.DataTexture(scorchTexture(S), 2 * S, S, THREE.RGBAFormat);
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.generateMipmaps = true;
    this.texture.needsUpdate = true;
    this.material = new THREE.MeshStandardMaterial({
      map: this.texture,
      color: new THREE.Color(1 / 3, 1 / 3, 1 / 3),
      roughness: 1,
      metalness: 0,
      transparent: true,
      depthWrite: false,
    });
    this.material.name = 'crash-scorch';
    this.material.onBeforeCompile = (shader) => {
      // pull toward the camera a little (same trick as the roads): no z-fighting with the terrain
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `vec4 mvPosition = modelViewMatrix * vec4( transformed, 1.0 );
mvPosition.xyz *= 0.9985;
gl_Position = projectionMatrix * mvPosition;`,
      );
    };
    const n = Math.max(1, Math.floor(count));
    for (let i = 0; i < n; i++) {
      const g = new THREE.PlaneGeometry(1, 1, N, N);
      g.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(g, this.material);
      m.name = 'crash-scorch-decal';
      m.visible = false;
      m.receiveShadow = true;
      m.renderOrder = -1;
      m.frustumCulled = true;
      this.group.add(m);
      this.meshes.push(m);
    }
    scene.add(this.group);
  }

  /**
   * Drape a decal over the ground: centre (x,z), length × width (m) along heading `angle` (rad from +X
   * toward +Z), kind 'crater' | 'furrow'. Returns the decal's slot (to update a growing furrow), −1 on water.
   */
  place(x: number, z: number, length: number, width: number, angle: number, env: ScorchEnv, kind: 'crater' | 'furrow', slot = -1): number {
    if (!(Number.isFinite(x) && Number.isFinite(z) && length > 0.1 && width > 0.1)) return -1;
    const wl = env.waterLevel?.(x, z);
    if (wl !== null && wl !== undefined && wl > env.groundHeight(x, z)) return -1;
    const i = slot >= 0 && slot < this.meshes.length ? slot : this.next;
    if (slot < 0) {
      this.next = (this.next + 1) % this.meshes.length;
      this.used = Math.min(this.meshes.length, this.used + 1);
    }
    const mesh = this.meshes[i];
    const geo = mesh.geometry as THREE.BufferGeometry;
    const pos = geo.getAttribute('position') as THREE.BufferAttribute;
    const uv = geo.getAttribute('uv') as THREE.BufferAttribute;
    const c = Math.cos(angle), s = Math.sin(angle);
    const L = Number.isFinite(length) ? Math.min(length, 400) : 1;
    const Wd = Number.isFinite(width) ? Math.min(width, 100) : 1;
    let k = 0;
    for (let iy = 0; iy <= N; iy++) {
      for (let ix = 0; ix <= N; ix++) {
        const u = ix / N - 0.5, v = iy / N - 0.5;
        const lx = u * L, lz = v * Wd;
        const wx = x + lx * c - lz * s;
        const wz = z + lx * s + lz * c;
        const gy = env.groundHeight(wx, wz);
        pos.setXYZ(k, wx, (Number.isFinite(gy) ? gy : 0) + 0.06, wz);
        const tu = (kind === 'crater' ? 0 : 0.5) + (u + 0.5) * 0.5;
        uv.setXY(k, tu, v + 0.5);
        k++;
      }
    }
    pos.needsUpdate = true;
    uv.needsUpdate = true;
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    mesh.visible = true;
    return i;
  }

  /** Decals currently shown. */
  count(): number {
    let n = 0;
    for (const m of this.meshes) if (m.visible) n++;
    return n;
  }

  clear(): void {
    for (const m of this.meshes) m.visible = false;
    this.next = 0;
    this.used = 0;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const m of this.meshes) m.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }
}
