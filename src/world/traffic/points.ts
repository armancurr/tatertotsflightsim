/**
 * A fixed-size, rewritten-every-frame point list for `createPointMaterial`
 * (lights, spray, far dots): no allocation per frame, one draw call, only the
 * used range is uploaded. Also the pose → matrix helper shared by the traffic
 * renderers (vessels and aircraft use the same heading/pitch/roll convention).
 */
import * as THREE from 'three';

export class PointBuffer {
  readonly geometry: THREE.BufferGeometry;
  readonly max: number;
  count = 0;
  private readonly P: Float32Array;
  private readonly C: Float32Array;
  private readonly Q: Float32Array;
  private readonly D: Float32Array;

  constructor(max: number) {
    this.max = max;
    this.P = new Float32Array(max * 3);
    this.C = new Float32Array(max * 4);
    this.Q = new Float32Array(max * 4);
    this.D = new Float32Array(max * 4);
    const g = new THREE.BufferGeometry();
    const attr = (a: Float32Array, n: number) => new THREE.BufferAttribute(a, n).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', attr(this.P, 3));
    g.setAttribute('aColor', attr(this.C, 4));
    g.setAttribute('aParams', attr(this.Q, 4));
    g.setAttribute('aDir', attr(this.D, 4));
    g.setDrawRange(0, 0);
    // positions change every frame and span the world: never cull the whole list
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), Infinity);
    this.geometry = g;
  }

  reset(): void {
    this.count = 0;
  }

  /**
   * Adds a point. Lights: rgb = HDR radiance, a = 0. Particles/dots: rgb = albedo, a = alpha.
   * shape 0 = glowing light, 1 = soft particle, 2 = hard dot. Returns false when full.
   */
  push(x: number, y: number, z: number, r: number, g: number, b: number, a: number, size: number, minPx: number, shape: number, dx = 0, dy = 0, dz = 0, exponent = 0): boolean {
    const i = this.count;
    if (i >= this.max) return false;
    this.P[i * 3] = x;
    this.P[i * 3 + 1] = y;
    this.P[i * 3 + 2] = z;
    this.C[i * 4] = r;
    this.C[i * 4 + 1] = g;
    this.C[i * 4 + 2] = b;
    this.C[i * 4 + 3] = a;
    this.Q[i * 4] = size;
    this.Q[i * 4 + 1] = minPx;
    this.Q[i * 4 + 2] = shape;
    this.Q[i * 4 + 3] = 0;
    this.D[i * 4] = dx;
    this.D[i * 4 + 1] = dy;
    this.D[i * 4 + 2] = dz;
    this.D[i * 4 + 3] = exponent;
    this.count = i + 1;
    return true;
  }

  /** Uploads the used range and sets the draw range. */
  commit(): void {
    const n = this.count;
    this.geometry.setDrawRange(0, n);
    if (n === 0) return;
    for (const [name, size] of [['position', 3], ['aColor', 4], ['aParams', 4], ['aDir', 4]] as const) {
      const a = this.geometry.getAttribute(name) as THREE.BufferAttribute;
      a.clearUpdateRanges();
      a.addUpdateRange(0, n * size);
      a.needsUpdate = true;
    }
  }

  dispose(): void {
    this.geometry.dispose();
  }
}

const _e = new THREE.Euler();
const _q = new THREE.Quaternion();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const DEG = Math.PI / 180;

/**
 * Object matrix for a pose: heading clockwise from north (deg), pitch + = nose/bow up, roll + =
 * right/starboard side down (body frame: nose −Z, right +X, up +Y). Uniform scale.
 */
export function poseMatrix(out: THREE.Matrix4, x: number, y: number, z: number, headingDeg: number, pitchDeg: number, rollDeg: number, scale = 1): THREE.Matrix4 {
  _e.set(pitchDeg * DEG, -headingDeg * DEG, -rollDeg * DEG, 'YXZ');
  _q.setFromEuler(_e);
  _p.set(x, y, z);
  _s.set(scale, scale, scale);
  return out.compose(_p, _q, _s);
}
