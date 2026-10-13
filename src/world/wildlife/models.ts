/**
 * Procedural animal models (three.js BufferGeometry, built once): a bottlenose dolphin, a
 * humpback whale, a herring gull and a harbour seal. Object frame = three.js (+X right, +Y up,
 * nose / bill toward −Z), sized in metres for a reference animal (instances scale them).
 *
 * Bodies are lofted from elliptical cross-sections; fins, flukes and wings are thin plates built
 * with both faces (their undersides can be coloured differently: a humpback's white flukes). Every
 * vertex carries `color` (countershaded, linear) and `aBody` = (s, part, span, side):
 *   s    0 at the nose … 1 at the tail (along the body; the vertex shader bends by it)
 *   part 0 body, 1 fin / flipper, 2 flukes, 3 wing, 4 legs (shown only when perched)
 *   span distance out along a wing / fluke from its root (m), side ±1
 */
import * as THREE from 'three';

type RGB = [number, number, number];

const lin = (hex: string): RGB => {
  const c = new THREE.Color(hex);
  return [c.r, c.g, c.b];
};
const mix = (a: RGB, b: RGB, t: number): RGB => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const sstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};
const hash = (a: number, b: number): number => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

class Builder {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly body: number[] = [];
  readonly idx: number[] = [];

  vert(x: number, y: number, z: number, c: RGB, s: number, part: number, span = 0, side = 0): number {
    this.pos.push(x, y, z);
    this.col.push(c[0], c[1], c[2]);
    this.body.push(s, part, span, side);
    return this.pos.length / 3 - 1;
  }

  tri(a: number, b: number, c: number): void {
    this.idx.push(a, b, c);
  }

  /** A flat plate (polygon fan around its first point) with both faces; `under` colours the second face. */
  plate(pts: [number, number, number][], top: (p: [number, number, number], k: number) => RGB, under: (p: [number, number, number], k: number) => RGB, attr: (p: [number, number, number]) => [number, number, number, number], upFirst = true): void {
    const a: number[] = [];
    const b: number[] = [];
    pts.forEach((p, k) => {
      const [s, part, span, side] = attr(p);
      a.push(this.vert(p[0], p[1], p[2], top(p, k), s, part, span, side));
      b.push(this.vert(p[0], p[1], p[2], under(p, k), s, part, span, side));
    });
    for (let k = 1; k < pts.length - 1; k++) {
      if (upFirst) {
        this.tri(a[0], a[k], a[k + 1]);
        this.tri(b[0], b[k + 1], b[k]);
      } else {
        this.tri(a[0], a[k + 1], a[k]);
        this.tri(b[0], b[k], b[k + 1]);
      }
    }
  }

  /** A strip of quads between two polylines (both faces). */
  strip(l0: [number, number, number][], l1: [number, number, number][], top: (p: [number, number, number]) => RGB, under: (p: [number, number, number]) => RGB, attr: (p: [number, number, number]) => [number, number, number, number]): void {
    const face = (colour: (p: [number, number, number]) => RGB, flip: boolean) => {
      const i0 = l0.map((p) => {
        const [s, part, span, side] = attr(p);
        return this.vert(p[0], p[1], p[2], colour(p), s, part, span, side);
      });
      const i1 = l1.map((p) => {
        const [s, part, span, side] = attr(p);
        return this.vert(p[0], p[1], p[2], colour(p), s, part, span, side);
      });
      for (let k = 0; k < l0.length - 1; k++) {
        if (!flip) {
          this.tri(i0[k], i1[k], i1[k + 1]);
          this.tri(i0[k], i1[k + 1], i0[k + 1]);
        } else {
          this.tri(i0[k], i1[k + 1], i1[k]);
          this.tri(i0[k], i0[k + 1], i1[k + 1]);
        }
      }
    };
    face(top, false);
    face(under, true);
  }

  build(name: string): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('aBody', new THREE.Float32BufferAttribute(this.body, 4));
    g.setIndex(this.idx);
    g.computeVertexNormals();
    g.computeBoundingSphere();
    g.computeBoundingBox();
    g.name = name;
    return g;
  }
}

interface Section {
  /** Along the body, 0 nose … 1 tail. */
  s: number;
  /** Half width, half height, centre height (fractions of the length). */
  w: number;
  h: number;
  y: number;
}

/**
 * Lofts a closed body from sections (nose at −L/2, tail at +L/2), `ring` vertices per section,
 * capped at both ends. `colour(y, ny, s, a)` gives the countershading (a = ring angle).
 */
function loft(b: Builder, L: number, sections: Section[], ring: number, colour: (ny: number, s: number, a: number, x: number, y: number) => RGB): void {
  const rows: number[][] = [];
  for (const sec of sections) {
    const row: number[] = [];
    const z = (sec.s - 0.5) * L;
    for (let k = 0; k < ring; k++) {
      const a = (k / ring) * Math.PI * 2;
      const x = Math.cos(a) * sec.w * L;
      const y = sec.y * L + Math.sin(a) * sec.h * L;
      row.push(b.vert(x, y, z, colour(Math.sin(a), sec.s, a, x, y), sec.s, 0));
    }
    rows.push(row);
  }
  for (let r = 0; r < rows.length - 1; r++) {
    for (let k = 0; k < ring; k++) {
      const k1 = (k + 1) % ring;
      // outward faces (counter-clockwise seen from outside; the nose is at −z)
      b.tri(rows[r][k], rows[r][k1], rows[r + 1][k]);
      b.tri(rows[r][k1], rows[r + 1][k1], rows[r + 1][k]);
    }
  }
  const first = sections[0];
  const last = sections[sections.length - 1];
  const nose = b.vert(0, first.y * L, (first.s - 0.5) * L - 0.004 * L, colour(0, first.s, 0, 0, first.y * L), first.s, 0);
  const tail = b.vert(0, last.y * L, (last.s - 0.5) * L + 0.004 * L, colour(0, last.s, 0, 0, last.y * L), last.s, 0);
  for (let k = 0; k < ring; k++) {
    const k1 = (k + 1) % ring;
    b.tri(nose, rows[0][k1], rows[0][k]);
    b.tri(tail, rows[rows.length - 1][k], rows[rows.length - 1][k1]);
  }
}

const bodyAttr = (L: number, part: number, sideOf = (x: number) => Math.sign(x)) => (p: [number, number, number]): [number, number, number, number] => [p[2] / L + 0.5, part, Math.abs(p[0]), sideOf(p[0])];

// ─── Dolphin ─────────────────────────────────────────────────────────────────

/** Reference length of the dolphin model (m). */
export const DOLPHIN_LENGTH = 2.7;

export function buildDolphin(): THREE.BufferGeometry {
  const L = DOLPHIN_LENGTH;
  const b = new Builder();
  const back = lin('#434b54');
  const cape = lin('#353c44');
  const flank = lin('#79838d');
  const belly = lin('#d9d8d0');
  const colour = (ny: number, s: number): RGB => {
    // dark cape along the back, grey flanks, pale belly; a paler throat
    const c = mix(belly, flank, sstep(-0.75, -0.2, ny));
    const d = mix(c, back, sstep(-0.1, 0.55, ny));
    return mix(d, cape, sstep(0.6, 0.95, ny) * sstep(0.1, 0.3, s) * (1 - sstep(0.65, 0.8, s)));
  };
  const S: Section[] = [
    { s: 0.0, w: 0.008, h: 0.008, y: -0.012 },
    { s: 0.035, w: 0.022, h: 0.02, y: -0.014 },
    { s: 0.075, w: 0.032, h: 0.03, y: -0.012 },
    { s: 0.105, w: 0.05, h: 0.056, y: 0.006 },
    { s: 0.15, w: 0.075, h: 0.085, y: 0.016 },
    { s: 0.22, w: 0.096, h: 0.104, y: 0.014 },
    { s: 0.32, w: 0.106, h: 0.116, y: 0.01 },
    { s: 0.42, w: 0.104, h: 0.114, y: 0.01 },
    { s: 0.52, w: 0.092, h: 0.102, y: 0.01 },
    { s: 0.62, w: 0.072, h: 0.088, y: 0.009 },
    { s: 0.72, w: 0.048, h: 0.07, y: 0.006 },
    { s: 0.81, w: 0.028, h: 0.052, y: 0.003 },
    { s: 0.89, w: 0.017, h: 0.032, y: 0.0 },
    { s: 0.95, w: 0.012, h: 0.014, y: 0.0 },
  ];
  loft(b, L, S, 14, colour);
  const at = bodyAttr(L, 1);
  const topAt = (s: number) => {
    // body top height at s (linear between sections)
    for (let i = 1; i < S.length; i++) if (S[i].s >= s) {
      const f = (s - S[i - 1].s) / (S[i].s - S[i - 1].s);
      return ((S[i - 1].y + S[i - 1].h) * (1 - f) + (S[i].y + S[i].h) * f) * L;
    }
    return 0;
  };
  // dorsal fin: falcate, in the midplane (both faces)
  const z = (s: number) => (s - 0.5) * L;
  const y0 = topAt(0.47) - 0.01;
  b.plate(
    [
      [0, y0, z(0.4)],
      [0, y0 + 0.1 * L * 0.3, z(0.43)],
      [0, y0 + 0.1 * L * 0.72, z(0.49)],
      [0, y0 + 0.1 * L * 1.1, z(0.57)],
      [0, y0 + 0.1 * L * 0.55, z(0.545)],
      [0, y0 + 0.1 * L * 0.12, z(0.55)],
      [0, y0 - 0.01, z(0.56)],
    ],
    () => cape,
    () => cape,
    at,
  );
  // pectoral fins: back and down from low on the flanks
  for (const side of [1, -1]) {
    const root: [number, number, number][] = [
      [side * 0.085 * L, -0.055 * L, z(0.2)],
      [side * 0.08 * L, -0.06 * L, z(0.26)],
    ];
    b.plate(
      [root[0], [side * 0.15 * L, -0.1 * L, z(0.24)], [side * 0.19 * L, -0.12 * L, z(0.31)], root[1]],
      () => flank,
      () => flank,
      at,
      side > 0,
    );
  }
  // flukes: horizontal, swept, with the median notch
  const fAt = bodyAttr(L, 2);
  for (const side of [1, -1]) {
    b.plate(
      [
        [0, 0, z(0.905)],
        [side * 0.07 * L, 0, z(0.945)],
        [side * 0.125 * L, 0, z(0.985)],
        [side * 0.135 * L, 0, z(1.0)],
        [side * 0.1 * L, 0, z(0.998)],
        [side * 0.035 * L, 0, z(0.985)],
        [0, 0, z(0.975)],
      ],
      () => back,
      () => flank,
      fAt,
      side < 0,
    );
  }
  return b.build('wildlife.dolphin');
}

// ─── Humpback ────────────────────────────────────────────────────────────────

export const WHALE_LENGTH = 14;

export function buildWhale(): THREE.BufferGeometry {
  const L = WHALE_LENGTH;
  const b = new Builder();
  const black = lin('#1f2226');
  const dark = lin('#2c3036');
  const white = lin('#d5d6d0');
  const grooveL = lin('#b9b8b0');
  const grooveD = lin('#5d5f60');
  const colour = (ny: number, s: number, a: number, x: number): RGB => {
    let c = mix(white, dark, sstep(-0.85, -0.45, ny + 0.25 * Math.sin(s * 23 + x)));
    c = mix(c, black, sstep(-0.1, 0.5, ny));
    // ventral pleats from the chin to the navel
    if (ny < -0.35 && s > 0.04 && s < 0.46) c = Math.floor(a * 18) % 2 === 0 ? grooveL : grooveD;
    // knobs (tubercles) on the head: a few darker speckles
    if (s < 0.2 && ny > 0.3 && hash(s * 100, a * 10) > 0.8) c = mix(c, lin('#15171a'), 0.8);
    return c;
  };
  const S: Section[] = [
    { s: 0.0, w: 0.02, h: 0.012, y: -0.03 },
    { s: 0.03, w: 0.055, h: 0.032, y: -0.03 },
    { s: 0.08, w: 0.08, h: 0.05, y: -0.028 },
    { s: 0.15, w: 0.1, h: 0.072, y: -0.022 },
    { s: 0.23, w: 0.114, h: 0.092, y: -0.014 },
    { s: 0.31, w: 0.12, h: 0.103, y: -0.006 },
    { s: 0.4, w: 0.117, h: 0.104, y: 0.0 },
    { s: 0.5, w: 0.103, h: 0.094, y: 0.005 },
    { s: 0.6, w: 0.083, h: 0.08, y: 0.008 },
    { s: 0.68, w: 0.064, h: 0.068, y: 0.01 },
    { s: 0.76, w: 0.044, h: 0.055, y: 0.008 },
    { s: 0.84, w: 0.028, h: 0.041, y: 0.004 },
    { s: 0.91, w: 0.019, h: 0.028, y: 0.0 },
    { s: 0.955, w: 0.013, h: 0.016, y: 0.0 },
  ];
  loft(b, L, S, 16, colour);
  const z = (s: number) => (s - 0.5) * L;
  const at = bodyAttr(L, 1);
  // small dorsal fin on its hump
  const top = (0.01 + 0.068) * L;
  b.plate(
    [
      [0, top - 0.05, z(0.63)],
      [0, top + 0.012 * L, z(0.655)],
      [0, top + 0.03 * L, z(0.685)],
      [0, top + 0.012 * L, z(0.69)],
      [0, top - 0.06, z(0.71)],
    ],
    () => black,
    () => black,
    at,
  );
  // the long pectoral flippers (≈ a third of the length): scalloped leading edge, white below
  for (const side of [1, -1]) {
    const lead: [number, number, number][] = [];
    const trail: [number, number, number][] = [];
    const n = 8;
    for (let k = 0; k <= n; k++) {
      const u = k / n;
      const x = side * (0.1 + 0.25 * u) * L;
      const y = (-0.05 - 0.075 * u) * L;
      const zc = z(0.27 + 0.2 * u);
      const chord = (0.055 * (1 - u) + 0.012) * L;
      const bump = k % 2 === 1 ? 0.006 * L : 0;
      lead.push([x, y, zc - chord * 0.35 - bump]);
      trail.push([x, y + 0.004 * L, zc + chord * 0.65]);
    }
    const topC = (p: [number, number, number]) => mix(dark, white, sstep(0.2, 0.3, Math.abs(p[0]) / L) * 0.8);
    if (side > 0) b.strip(lead, trail, topC, () => white, at);
    else b.strip(trail, lead, topC, () => white, at);
  }
  // flukes: broad, serrated trailing edge, white underside with black marks
  const fAt = bodyAttr(L, 2);
  for (const side of [1, -1]) {
    const lead: [number, number, number][] = [];
    const trail: [number, number, number][] = [];
    const n = 8;
    for (let k = 0; k <= n; k++) {
      const u = k / n;
      const x = side * (0.004 + 0.158 * u) * L;
      lead.push([x, 0, z(0.905 + 0.075 * u * u)]);
      const serr = k % 2 === 1 ? 0.005 : 0;
      trail.push([x, 0, z(0.985 + 0.012 * Math.sin(u * Math.PI) - 0.005 * u + serr)]);
    }
    const under = (p: [number, number, number]) => (hash(Math.round(p[0] * 3), Math.round(p[2] * 3)) > 0.72 ? black : white);
    if (side > 0) b.strip(lead, trail, () => black, under, fAt);
    else b.strip(trail, lead, () => black, under, fAt);
  }
  return b.build('wildlife.whale');
}

// ─── Herring gull ────────────────────────────────────────────────────────────

export const GULL_SPAN = 1.35;

export function buildGull(): THREE.BufferGeometry {
  const b = new Builder();
  const white = lin('#f2f2ee');
  const grey = lin('#a3adb6');
  const black = lin('#141414');
  const bill = lin('#e8c040');
  const legC = lin('#d49a8e');
  const Lb = 0.6;
  const colour = (ny: number, s: number): RGB => {
    if (s < 0.085) return bill;
    // grey mantle on the back between the wings, white elsewhere; dark tail tip
    const mantle = sstep(0.4, 0.8, ny) * sstep(0.35, 0.45, s) * (1 - sstep(0.7, 0.8, s));
    let c = mix(white, grey, mantle);
    if (s > 0.93 && ny > 0) c = mix(c, black, 0.6);
    return c;
  };
  const S: Section[] = [
    { s: 0.0, w: 0.006, h: 0.006, y: 0.05 },
    { s: 0.045, w: 0.012, h: 0.016, y: 0.048 },
    { s: 0.085, w: 0.018, h: 0.024, y: 0.05 },
    { s: 0.12, w: 0.052, h: 0.062, y: 0.055 },
    { s: 0.19, w: 0.066, h: 0.072, y: 0.045 },
    { s: 0.27, w: 0.07, h: 0.075, y: 0.02 },
    { s: 0.38, w: 0.098, h: 0.1, y: 0.0 },
    { s: 0.5, w: 0.1, h: 0.098, y: 0.0 },
    { s: 0.63, w: 0.078, h: 0.075, y: 0.008 },
    { s: 0.76, w: 0.05, h: 0.045, y: 0.018 },
    { s: 0.88, w: 0.055, h: 0.014, y: 0.024 },
    { s: 0.98, w: 0.06, h: 0.006, y: 0.026 },
  ];
  loft(b, Lb, S, 8, colour);
  const z = (s: number) => (s - 0.5) * Lb;
  // wings: inner arm, forearm, hand; chord shrinking to a pointed tip, black tip with a white mirror
  const half = GULL_SPAN / 2;
  const root = 0.045;
  const stations = [
    { x: root, lead: z(0.33), trail: z(0.66) },
    { x: 0.25, lead: z(0.34), trail: z(0.7) },
    { x: 0.42, lead: z(0.355), trail: z(0.66) },
    { x: 0.55, lead: z(0.4), trail: z(0.64) },
    { x: 0.64, lead: z(0.48), trail: z(0.6) },
    { x: half, lead: z(0.58), trail: z(0.6) },
  ];
  const wingTop = (p: [number, number, number]) => {
    const r = Math.abs(p[0]);
    if (r > half - 0.03) return white;
    if (r > 0.53) return black;
    // white trailing edge
    return p[2] > z(0.6) ? white : grey;
  };
  const wingUnder = (p: [number, number, number]) => (Math.abs(p[0]) > 0.56 && Math.abs(p[0]) < half - 0.03 ? mix(black, white, 0.35) : white);
  for (const side of [1, -1]) {
    const lead: [number, number, number][] = stations.map((st) => [side * st.x, 0.03 + 0.012 * (st.x / half), st.lead]);
    const trail: [number, number, number][] = stations.map((st) => [side * st.x, 0.03 + 0.012 * (st.x / half), st.trail]);
    const at = (p: [number, number, number]): [number, number, number, number] => [p[2] / Lb + 0.5, 3, Math.abs(p[0]) - root, side];
    if (side > 0) b.strip(lead, trail, wingTop, wingUnder, at);
    else b.strip(trail, lead, wingTop, wingUnder, at);
  }
  // legs (perched only): two thin pink posts under the belly
  for (const side of [1, -1]) {
    const x = side * 0.025;
    const legAt = (p: [number, number, number]): [number, number, number, number] => [p[2] / Lb + 0.5, 4, 0, side];
    b.plate(
      [
        [x - 0.008, -0.07, z(0.58)],
        [x + 0.008, -0.07, z(0.58)],
        [x + 0.006, -0.155, z(0.56)],
        [x - 0.006, -0.155, z(0.56)],
      ],
      () => legC,
      () => legC,
      legAt,
    );
    b.plate(
      [
        [x, -0.155, z(0.5)],
        [x + 0.02, -0.155, z(0.56)],
        [x - 0.02, -0.155, z(0.56)],
      ],
      () => legC,
      () => legC,
      legAt,
      false,
    );
  }
  return b.build('wildlife.gull');
}

// ─── Harbour seal ────────────────────────────────────────────────────────────

export const SEAL_LENGTH = 1.6;

export function buildSeal(): THREE.BufferGeometry {
  const L = SEAL_LENGTH;
  const b = new Builder();
  const base = lin('#6d675f');
  const dark = lin('#3e3a36');
  const belly = lin('#a59e92');
  const colour = (ny: number, s: number, a: number): RGB => {
    let c = mix(belly, base, sstep(-0.7, -0.1, ny));
    // mottled coat
    if (hash(Math.round(s * 40), Math.round(a * 4)) > 0.7) c = mix(c, dark, 0.55);
    if (s < 0.03) c = dark;
    return c;
  };
  const S: Section[] = [
    { s: 0.0, w: 0.018, h: 0.018, y: 0.04 },
    { s: 0.04, w: 0.05, h: 0.045, y: 0.045 },
    { s: 0.1, w: 0.075, h: 0.07, y: 0.05 },
    { s: 0.16, w: 0.07, h: 0.066, y: 0.04 },
    { s: 0.26, w: 0.11, h: 0.09, y: 0.03 },
    { s: 0.42, w: 0.15, h: 0.105, y: 0.02 },
    { s: 0.58, w: 0.14, h: 0.095, y: 0.012 },
    { s: 0.72, w: 0.1, h: 0.072, y: 0.008 },
    { s: 0.85, w: 0.055, h: 0.045, y: 0.006 },
    { s: 0.92, w: 0.035, h: 0.03, y: 0.006 },
  ];
  loft(b, L, S, 12, colour);
  const z = (s: number) => (s - 0.5) * L;
  const at = bodyAttr(L, 1);
  // hind flippers: a fan behind the tail, fore flippers at the chest
  for (const side of [1, -1]) {
    b.plate(
      [
        [side * 0.01, 0.01 * L, z(0.9)],
        [side * 0.07 * L, 0.012 * L, z(1.0)],
        [side * 0.02 * L, 0.012 * L, z(1.02)],
      ],
      () => dark,
      () => dark,
      at,
      side > 0,
    );
    b.plate(
      [
        [side * 0.12 * L, -0.05 * L, z(0.3)],
        [side * 0.17 * L, -0.085 * L, z(0.36)],
        [side * 0.12 * L, -0.07 * L, z(0.38)],
      ],
      () => base,
      () => base,
      at,
      side > 0,
    );
  }
  return b.build('wildlife.seal');
}
