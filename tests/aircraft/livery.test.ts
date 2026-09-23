import { describe, it, expect, beforeAll } from 'vitest';
import fc from 'fast-check';
import { fcParams } from '../support/fc';
import { MASCOT_BOX, MASCOT_COLORS, drawTaterMascot, potatoOutline, seeded } from '../../src/aircraft/mascot';
import { DECAL_LAYOUT, drawArtDecal, drawFinDecal, drawTextDecal, sampleDecal, type DecalImage, type DecalSample, type LiveryDecals } from '../../src/aircraft/decals';
import { FIN_UV, liverySizes, paintLivery, type LiveryPixels } from '../../src/aircraft/livery';
import { FUSE_Z0, FUSE_Z1, arcToAngle, fuselageSection, superSectionPoint, type SectionParams } from '../../src/aircraft/shape';

// ─── A recording 2D context (no DOM needed) ─────────────────────────────────

interface Call {
  op: string;
  args: unknown[];
}

/** Records every method call and property write; tracks the current transform for bounds checks. */
function recorder() {
  const calls: Call[] = [];
  const points: Array<[number, number]> = [];
  let depth = 0;
  let maxDepth = 0;
  // Affine transform [a b c d e f] (canvas convention) and its save stack.
  let m = [1, 0, 0, 1, 0, 0];
  const stack: number[][] = [];
  const apply = (x: number, y: number): [number, number] => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  const mul = (n: number[]) => {
    m = [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
  };
  const gradient = () => ({ addColorStop: (o: number, c: string) => calls.push({ op: 'stop', args: [o, c] }) });
  const target: Record<string, unknown> = {
    save: () => {
      stack.push(m.slice());
      depth++;
      maxDepth = Math.max(maxDepth, depth);
    },
    restore: () => {
      m = stack.pop() ?? [1, 0, 0, 1, 0, 0];
      depth--;
    },
    translate: (x: number, y: number) => mul([1, 0, 0, 1, x, y]),
    rotate: (a: number) => mul([Math.cos(a), Math.sin(a), -Math.sin(a), Math.cos(a), 0, 0]),
    scale: (x: number, y: number) => mul([x, 0, 0, y, 0, 0]),
    moveTo: (x: number, y: number) => points.push(apply(x, y)),
    lineTo: (x: number, y: number) => points.push(apply(x, y)),
    quadraticCurveTo: (cx: number, cy: number, x: number, y: number) => points.push(apply(cx, cy), apply(x, y)),
    bezierCurveTo: (a: number, b: number, c: number, d: number, x: number, y: number) => points.push(apply(a, b), apply(c, d), apply(x, y)),
    arc: (x: number, y: number, r: number) => points.push(apply(x - r, y - r), apply(x + r, y + r)),
    ellipse: (x: number, y: number, rx: number, ry: number) => points.push(apply(x - rx, y - ry), apply(x + rx, y + ry)),
    createLinearGradient: gradient,
    createRadialGradient: gradient,
    measureText: (t: string) => ({ width: t.length * 10, actualBoundingBoxAscent: 7.2 }),
  };
  const ctx = new Proxy(target, {
    get(t, k: string) {
      if (k in t && typeof t[k] === 'function') {
        const f = t[k] as (...a: unknown[]) => unknown;
        return (...args: unknown[]) => {
          calls.push({ op: k, args });
          return f(...args);
        };
      }
      if (k in t) return t[k];
      return (...args: unknown[]) => {
        calls.push({ op: k, args });
      };
    },
    set(t, k: string, v) {
      calls.push({ op: `set:${k}`, args: [v] });
      t[k] = v;
      return true;
    },
  });
  return { ctx: ctx as never, calls, points, depth: () => depth, maxDepth: () => maxDepth };
}

const numbersIn = (calls: Call[]) => calls.flatMap((c) => c.args.filter((a): a is number => typeof a === 'number'));
const colours = (calls: Call[]) => new Set(calls.flatMap((c) => c.args.filter((a): a is string => typeof a === 'string' && /^(#|rgba)/.test(a))));

describe('Tater mascot drawing (canvas 2D paths into a recording context)', () => {
  it('draws without throwing, with only finite numbers and balanced save/restore', () => {
    const r = recorder();
    expect(() => drawTaterMascot(r.ctx)).not.toThrow();
    expect(r.calls.length).toBeGreaterThan(200);
    for (const n of numbersIn(r.calls)) expect(Number.isFinite(n)).toBe(true);
    expect(r.depth()).toBe(0);
    expect(r.calls.filter((c) => c.op === 'fill').length).toBeGreaterThan(30);
    expect(r.calls.filter((c) => c.op === 'stroke').length).toBeGreaterThan(30);
  });

  it('is deterministic: the same call sequence every time', () => {
    const a = recorder();
    const b = recorder();
    drawTaterMascot(a.ctx);
    drawTaterMascot(b.ctx);
    expect(JSON.stringify(a.calls)).toBe(JSON.stringify(b.calls));
  });

  it('uses the mascot palette: brown potato, red cape, brass goggles with blue lenses, speed lines', () => {
    const r = recorder();
    drawTaterMascot(r.ctx);
    const used = colours(r.calls);
    for (const c of [MASCOT_COLORS.skin, MASCOT_COLORS.cape, MASCOT_COLORS.capeDark, MASCOT_COLORS.brass, MASCOT_COLORS.lens, MASCOT_COLORS.strap, MASCOT_COLORS.speed, MASCOT_COLORS.outline]) {
      expect(used.has(c), c).toBe(true);
    }
    const noLines = recorder();
    drawTaterMascot(noLines.ctx, { speedLines: false });
    expect(colours(noLines.calls).has(MASCOT_COLORS.speed)).toBe(false);
  });

  it('stays inside its box, facing the nose (fists at the front, cape at the back)', () => {
    const r = recorder();
    drawTaterMascot(r.ctx);
    const pad = 20;
    for (const [x, y] of r.points) {
      expect(x).toBeGreaterThanOrEqual(-pad);
      expect(x).toBeLessThanOrEqual(MASCOT_BOX.w + pad);
      expect(y).toBeGreaterThanOrEqual(-pad);
      expect(y).toBeLessThanOrEqual(MASCOT_BOX.h + pad);
    }
    const xs = r.points.map((p) => p[0]);
    expect(Math.min(...xs)).toBeLessThan(0.15 * MASCOT_BOX.w);
    expect(Math.max(...xs)).toBeGreaterThan(0.9 * MASCOT_BOX.w);
  });

  it('potato outline and seeded noise are deterministic and finite', () => {
    expect(potatoOutline(0, 0, 10, 5, 0.3)).toEqual(potatoOutline(0, 0, 10, 5, 0.3));
    const a = seeded(9);
    const b = seeded(9);
    for (let i = 0; i < 50; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('decal layouts draw deterministically, balanced, inside their rasters', () => {
    for (const draw of [
      (c: never) => drawArtDecal(c, 1280, 678),
      (c: never) => drawFinDecal(c, 896, 627),
      (c: never) => drawTextDecal(c, 768, 256, 'N172JT'),
    ]) {
      const a = recorder();
      const b = recorder();
      draw(a.ctx);
      draw(b.ctx);
      expect(JSON.stringify(a.calls)).toBe(JSON.stringify(b.calls));
      expect(a.depth()).toBe(0);
      for (const n of numbersIn(a.calls)) expect(Number.isFinite(n)).toBe(true);
    }
    const t = recorder();
    drawTextDecal(t.ctx, 768, 256, 'N172JT');
    const text = t.calls.filter((c) => c.op === 'fillText').map((c) => c.args[0]).join('');
    expect(text).toBe('N172JT' + DECAL_LAYOUT.name.text);
  });
});

// ─── Decal sampling ──────────────────────────────────────────────────────────

function solidDecal(box: { z0: number; z1: number; y0: number; y1: number }, w: number, h: number, px: (i: number, j: number) => [number, number, number, number]): DecalImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const [r, g, b, a] = px(i, j);
      const k = (j * w + i) * 4;
      data[k] = r;
      data[k + 1] = g;
      data[k + 2] = b;
      data[k + 3] = a;
    }
  }
  return { data, width: w, height: h, ...box };
}

describe('property: decal sampling', () => {
  const box = { z0: 1, z1: 3, y0: -0.5, y1: 0.5 };
  const img = solidDecal(box, 40, 20, (i, j) => [(i * 37) % 256, (j * 91) % 256, ((i + j) * 13) % 256, (i * 7 + j * 11) % 256]);
  const out: DecalSample = { r: 0, g: 0, b: 0, a: 0 };

  it('colour stays in 0..255, coverage in 0..1, and nothing is drawn well outside the box', () => {
    fc.assert(
      fc.property(fc.double({ min: -2, max: 6, noNaN: true }), fc.double({ min: -2, max: 2, noNaN: true }), fc.double({ min: 0, max: 0.05, noNaN: true }), (z, y, f) => {
        sampleDecal(img, z, y, f, f, out);
        for (const c of [out.r, out.g, out.b]) {
          expect(c).toBeGreaterThanOrEqual(0);
          expect(c).toBeLessThanOrEqual(255.0001);
        }
        expect(out.a).toBeGreaterThanOrEqual(0);
        expect(out.a).toBeLessThanOrEqual(1);
        if (z < box.z0 - 0.2 || z > box.z1 + 0.2 || y < box.y0 - 0.2 || y > box.y1 + 0.2) expect(out.a).toBe(0);
      }),
      fcParams(400),
    );
  });

  it('a uniform opaque decal samples to exactly its colour inside the box', () => {
    const flat = solidDecal(box, 8, 8, () => [200, 40, 30, 255]);
    fc.assert(
      fc.property(fc.double({ min: 1.3, max: 2.7, noNaN: true }), fc.double({ min: -0.3, max: 0.3, noNaN: true }), (z, y) => {
        sampleDecal(flat, z, y, 0.01, 0.01, out);
        expect(out.a).toBeCloseTo(1, 6);
        expect(out.r).toBeCloseTo(200, 6);
        expect(out.g).toBeCloseTo(40, 6);
        expect(out.b).toBeCloseTo(30, 6);
      }),
      fcParams(200),
    );
  });

  it('transparent texels never tint the colour (premultiplied filtering)', () => {
    // Left half opaque red, right half fully transparent GREEN: no green may bleed in.
    const half = solidDecal(box, 16, 4, (i) => (i < 8 ? [255, 0, 0, 255] : [0, 255, 0, 0]));
    fc.assert(
      fc.property(fc.double({ min: 0.9, max: 3.1, noNaN: true }), (z) => {
        sampleDecal(half, z, 0, 0.02, 0.02, out);
        if (out.a > 0) expect(out.g).toBeLessThan(1e-9);
      }),
      fcParams(200),
    );
  });
});

// ─── Functional: the painted textures (node, synthetic decals) ───────────────

describe('functional: the livery painter puts the decals where they belong', () => {
  const quality = 'low' as const;
  const L = DECAL_LAYOUT;
  // Art: a magenta block in the middle of the mascot area. Text: left half red, right half blue.
  const artBox = L.art;
  const art = solidDecal(artBox, 200, 100, (i, j) => (i > 60 && i < 140 && j > 30 && j < 70 ? [255, 0, 255, 255] : [0, 0, 0, 0]));
  const text = solidDecal(L.text, 120, 40, (i) => (i < 60 ? [255, 0, 0, 255] : [0, 0, 255, 255]));
  const fin = solidDecal(L.fin, 50, 30, () => [0, 200, 0, 255]);
  const decals: LiveryDecals = { art, text, fin };
  let px: LiveryPixels;
  let plain: LiveryPixels;
  beforeAll(() => {
    px = paintLivery(quality, decals);
    plain = paintLivery(quality, null);
  });

  /** Texel of the fuselage map nearest to the side point (side x sign, z, y). */
  function texel(p: LiveryPixels, side: -1 | 1, z: number, y: number): number[] {
    const { w, h } = liverySizes(quality);
    const r = Math.min(h - 1, Math.max(0, Math.floor(((z - FUSE_Z0) / (FUSE_Z1 - FUSE_Z0)) * h)));
    const zr = FUSE_Z0 + ((r + 0.5) / h) * (FUSE_Z1 - FUSE_Z0);
    const sec: SectionParams = { top: 0, bottom: 0, halfWidth: 0, widthY: 0, nTop: 2, nBot: 2 };
    fuselageSection(zr, sec);
    const ts = Array.from({ length: w }, (_, c) => (c + 0.5) / w);
    const angles = new Float64Array(w);
    arcToAngle(sec, ts, angles);
    let best = -1;
    let bestD = Infinity;
    const pt = { x: 0, y: 0 };
    for (let c = 0; c < w; c++) {
      superSectionPoint(sec, angles[c], pt);
      if (Math.sign(pt.x) !== side || Math.abs(pt.x) < sec.halfWidth * 0.6) continue;
      const d = Math.abs(pt.y - y);
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    const i = (r * w + best) * 4;
    return [p.map[i], p.map[i + 1], p.map[i + 2], p.map[i + 3]];
  }

  it('the mascot art appears at the same (z, y) on both sides (flying toward the nose on each)', () => {
    const z = artBox.z0 + ((artBox.z1 - artBox.z0) * 100) / 200;
    const y = artBox.y1 - ((artBox.y1 - artBox.y0) * 50) / 100;
    for (const side of [-1, 1] as const) {
      const [r, g, b] = texel(px, side, z, y);
      expect(r).toBeGreaterThan(230);
      expect(g).toBeLessThan(30);
      expect(b).toBeGreaterThan(230);
    }
    // Outside the block the paint is untouched.
    expect(texel(px, -1, artBox.z0 + 0.05, y)).toEqual(texel(plain, -1, artBox.z0 + 0.05, y));
  });

  it('the text decal is mirrored on the right side so it reads left-to-right from both sides', () => {
    const y = 0;
    const front = L.text.z0 + 0.15; // first letters on the left side
    const back = L.text.z1 - 0.15;
    const lf = texel(px, -1, front, y);
    const rb = texel(px, 1, back, y);
    const rf = texel(px, 1, front, y);
    expect(lf[0]).toBeGreaterThan(200); // left side, forward end: start of the text (red)
    expect(rb[0]).toBeGreaterThan(200); // right side, aft end: start of the text (red) — reads toward the nose
    expect(rf[2]).toBeGreaterThan(200); // right side, forward end: end of the text (blue)
  });

  it('the fin decal lands in the fin texture box and the painter is deterministic', () => {
    const { fw, fh } = liverySizes(quality);
    const z = (L.fin.z0 + L.fin.z1) / 2;
    const y = (L.fin.y0 + L.fin.y1) / 2;
    const c = Math.floor(((z - FIN_UV.z0) / (FIN_UV.z1 - FIN_UV.z0)) * fw);
    const r = Math.floor(((y - FIN_UV.y0) / (FIN_UV.y1 - FIN_UV.y0)) * fh);
    const i = (r * fw + c) * 4;
    expect(px.fin[i + 1]).toBeGreaterThan(180);
    expect(px.fin[i]).toBeLessThan(40);
    const again = paintLivery(quality, decals);
    expect(Buffer.from(again.map).equals(Buffer.from(px.map))).toBe(true);
    expect(Buffer.from(again.fin).equals(Buffer.from(px.fin))).toBe(true);
  });

  it('windows stay cut out (alpha 0) and the paint is opaque elsewhere, with or without decals', () => {
    // Door window centre, left side.
    expect(texel(px, -1, -0.3, 0.62)[3]).toBe(0);
    expect(texel(px, -1, 2.6, 0.0)[3]).toBe(255);
    expect(texel(plain, 1, 2.6, 0.0)[3]).toBe(255);
  });
});
