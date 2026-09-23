/**
 * "Tater" — the livery mascot: a flying potato in leather aviator goggles and a flowing red
 * cape, arms out front like a superhero, with speed lines. Drawn procedurally with canvas 2D
 * paths (no image files), deterministically (no Math.random), into any context that has the
 * subset of CanvasRenderingContext2D below — a real canvas, an OffscreenCanvas, or a recording
 * mock in tests.
 *
 * Mascot space: a MASCOT_BOX.w × MASCOT_BOX.h box, origin top-left, +x = aft (the mascot faces
 * −x, toward the aircraft's nose), +y = down (canvas convention).
 */

/** The part of the 2D canvas API the mascot uses. */
export interface Paint2D {
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  globalAlpha: number;
  save(): void;
  restore(): void;
  translate(x: number, y: number): void;
  rotate(a: number): void;
  scale(x: number, y: number): void;
  beginPath(): void;
  closePath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void;
  bezierCurveTo(c1x: number, c1y: number, c2x: number, c2y: number, x: number, y: number): void;
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw?: boolean): void;
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw?: boolean): void;
  fill(): void;
  stroke(): void;
  clip(): void;
  createLinearGradient(x0: number, y0: number, x1: number, y1: number): { addColorStop(o: number, c: string): void };
  createRadialGradient(x0: number, y0: number, r0: number, x1: number, y1: number, r1: number): { addColorStop(o: number, c: string): void };
}

export const MASCOT_BOX = { w: 1000, h: 520 } as const;

export const MASCOT_COLORS = {
  outline: '#2e1b0c',
  skinLight: '#e2ae68',
  skin: '#c08542',
  skinDark: '#80501f',
  spot: '#8a5a27',
  cape: '#d3202b',
  capeLight: '#ff5b45',
  capeDark: '#86101a',
  strap: '#5b3a1d',
  stitch: '#d9b378',
  brass: '#e8c867',
  brassDark: '#94701f',
  lens: '#6fc4f2',
  lensDark: '#1f5f98',
  mouth: '#5c1010',
  tongue: '#e8616b',
  teeth: '#fbf8f0',
  cheek: 'rgba(236, 104, 86, 0.45)',
  eyeWhite: '#fffdf8',
  pupil: '#141414',
  speed: '#2c4a8c',
  boot: '#b8141f',
} as const;

export interface MascotOptions {
  /** Draw the speed lines behind the mascot (default true). */
  speedLines?: boolean;
  /** Outline width in mascot units (default 7; thicker for small decals so it still reads). */
  outline?: number;
}

/** Deterministic pseudo-random sequence (mulberry32). */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Pt = readonly [number, number];

/** Smooth closed blob through the points (quadratic curves through the edge midpoints). */
function blob(ctx: Paint2D, pts: ReadonlyArray<Pt>) {
  const n = pts.length;
  const mid = (i: number): Pt => {
    const a = pts[i % n];
    const b = pts[(i + 1) % n];
    return [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  };
  ctx.beginPath();
  const m0 = mid(n - 1);
  ctx.moveTo(m0[0], m0[1]);
  for (let i = 0; i < n; i++) {
    const m = mid(i);
    ctx.quadraticCurveTo(pts[i][0], pts[i][1], m[0], m[1]);
  }
  ctx.closePath();
}

/** Points of the lumpy potato outline (body frame of the mascot, deterministic). */
export function potatoOutline(cx: number, cy: number, rx: number, ry: number, rot: number, seed = 7): Pt[] {
  const rnd = seeded(seed);
  const pts: Pt[] = [];
  const n = 14;
  const c = Math.cos(rot);
  const s = Math.sin(rot);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    // Lumps, plus a slightly fuller "head" end (−x) and a flatter belly.
    const lump = 1 + (rnd() - 0.5) * 0.09;
    const head = 1 + 0.06 * Math.max(0, -Math.cos(a));
    const x = Math.cos(a) * rx * lump * head;
    const y = Math.sin(a) * ry * lump * (Math.sin(a) > 0 ? 0.94 : 1);
    pts.push([cx + x * c - y * s, cy + x * s + y * c]);
  }
  return pts;
}

function strokeFill(ctx: Paint2D, fill: unknown, outline: number, color: string = MASCOT_COLORS.outline) {
  ctx.fillStyle = fill;
  ctx.fill();
  if (outline > 0) {
    ctx.strokeStyle = color;
    ctx.lineWidth = outline;
    ctx.stroke();
  }
}

/** A limb as a thick round-capped stroke with an outline: path a → (bend) → b. */
function limb(ctx: Paint2D, a: Pt, bend: Pt, b: Pt, width: number, color: string, outline: number) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(a[0], a[1]);
    ctx.quadraticCurveTo(bend[0], bend[1], b[0], b[1]);
  };
  path();
  ctx.strokeStyle = MASCOT_COLORS.outline;
  ctx.lineWidth = width + outline * 2;
  ctx.stroke();
  path();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke();
}

/** A little fist: a round mitt with two finger creases, facing −x. */
function fist(ctx: Paint2D, x: number, y: number, r: number, outline: number) {
  ctx.beginPath();
  ctx.ellipse(x, y, r * 1.08, r, -0.15, 0, Math.PI * 2);
  const g = ctx.createRadialGradient(x - r * 0.4, y - r * 0.45, r * 0.1, x, y, r * 1.1);
  g.addColorStop(0, MASCOT_COLORS.skinLight);
  g.addColorStop(1, MASCOT_COLORS.skin);
  strokeFill(ctx, g, outline);
  ctx.strokeStyle = MASCOT_COLORS.outline;
  ctx.lineWidth = outline * 0.6;
  ctx.lineCap = 'round';
  for (const k of [-0.35, 0.2]) {
    ctx.beginPath();
    ctx.moveTo(x - r * 0.75, y + r * k);
    ctx.quadraticCurveTo(x - r * 0.35, y + r * (k + 0.12), x - r * 0.05, y + r * k);
    ctx.stroke();
  }
}

/** The cape: attached round the top of the head, billowing aft in three scallops. */
function cape(ctx: Paint2D, outline: number, layer: 'back' | 'front') {
  const C = MASCOT_COLORS;
  if (layer === 'back') {
    // Main sheet: top edge sweeps back and up, bottom edge ripples.
    ctx.beginPath();
    ctx.moveTo(480, 150);
    ctx.bezierCurveTo(590, 78, 700, 70, 800, 96);
    ctx.bezierCurveTo(860, 110, 915, 92, 968, 70);
    // Trailing edge, down the tips of the scallops.
    ctx.bezierCurveTo(955, 120, 960, 160, 985, 205);
    ctx.bezierCurveTo(930, 196, 900, 210, 880, 250);
    ctx.bezierCurveTo(850, 225, 800, 228, 770, 262);
    ctx.bezierCurveTo(735, 238, 680, 245, 650, 282);
    ctx.bezierCurveTo(610, 262, 560, 262, 520, 280);
    ctx.lineTo(470, 250);
    ctx.closePath();
    const g = ctx.createLinearGradient(480, 80, 740, 300);
    g.addColorStop(0, C.capeLight);
    g.addColorStop(0.35, C.cape);
    g.addColorStop(1, C.capeDark);
    strokeFill(ctx, g, outline);
    // Inside of the cape showing under each scallop (darker lining).
    ctx.fillStyle = C.capeDark;
    for (const [x0, y0, x1, y1, cx, cy] of [
      [880, 250, 985, 205, 950, 250],
      [770, 262, 880, 250, 830, 280],
      [650, 282, 770, 262, 715, 300],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(cx, cy, x1, y1);
      ctx.quadraticCurveTo((x0 + x1) / 2, (y0 + y1) / 2 - 8, x0, y0);
      ctx.closePath();
      ctx.fill();
      ctx.strokeStyle = C.outline;
      ctx.lineWidth = outline * 0.8;
      ctx.stroke();
    }
    // Fold lines running aft from the shoulders.
    ctx.strokeStyle = C.capeDark;
    ctx.lineCap = 'round';
    for (const [x0, y0, cx, cy, x1, y1, w] of [
      [520, 150, 640, 130, 760, 150, 9],
      [540, 205, 660, 175, 800, 190, 8],
      [600, 250, 700, 220, 860, 215, 7],
    ] as const) {
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(cx, cy, x1, y1);
      ctx.stroke();
    }
    // Sheen along the top edge.
    ctx.strokeStyle = 'rgba(255, 200, 180, 0.55)';
    ctx.lineWidth = 7;
    ctx.beginPath();
    ctx.moveTo(540, 112);
    ctx.bezierCurveTo(610, 88, 690, 84, 790, 108);
    ctx.stroke();
  } else {
    // Collar tied round the top of the body, with a gold clasp.
    ctx.beginPath();
    ctx.moveTo(462, 118);
    ctx.bezierCurveTo(500, 100, 548, 108, 572, 136);
    ctx.bezierCurveTo(556, 160, 520, 172, 488, 168);
    ctx.bezierCurveTo(472, 162, 462, 140, 462, 118);
    ctx.closePath();
    strokeFill(ctx, C.cape, outline);
    ctx.beginPath();
    ctx.arc(484, 158, 15, 0, Math.PI * 2);
    const g = ctx.createRadialGradient(479, 152, 2, 484, 158, 15);
    g.addColorStop(0, '#fff3b0');
    g.addColorStop(1, C.brassDark);
    strokeFill(ctx, g, outline * 0.7);
  }
}

/** Goggles pushed up on the forehead: strap round the head, two brass-rimmed shiny lenses. */
function goggles(ctx: Paint2D, outline: number) {
  const C = MASCOT_COLORS;
  // Strap: a band from the lenses back round the head to the cape collar.
  ctx.beginPath();
  ctx.moveTo(250, 150);
  ctx.bezierCurveTo(320, 118, 420, 112, 482, 128);
  ctx.lineTo(478, 160);
  ctx.bezierCurveTo(420, 146, 330, 152, 262, 180);
  ctx.closePath();
  strokeFill(ctx, C.strap, outline * 0.8);
  // Stitching along both edges.
  ctx.strokeStyle = C.stitch;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  for (let i = 0; i < 6; i++) {
    const x = 372 + i * 17;
    for (const [y0, dy] of [[124 + (i - 3) * 0.5, 0], [152 + (i - 3) * 0.3, 0]] as const) {
      ctx.beginPath();
      ctx.moveTo(x, y0 + dy);
      ctx.lineTo(x + 9, y0 + dy - 1);
      ctx.stroke();
    }
  }
  // Lenses (the nearer one larger), with a bridge between them.
  const lenses: Array<[number, number, number]> = [
    [262, 160, 37],
    [338, 142, 42],
  ];
  ctx.beginPath();
  ctx.moveTo(292, 150);
  ctx.quadraticCurveTo(300, 140, 300, 140);
  ctx.lineWidth = 12;
  ctx.strokeStyle = C.brassDark;
  ctx.stroke();
  for (const [x, y, r] of lenses) {
    // Brass rim.
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    const rim = ctx.createLinearGradient(x - r, y - r, x + r, y + r);
    rim.addColorStop(0, '#fff0a8');
    rim.addColorStop(0.45, C.brass);
    rim.addColorStop(1, C.brassDark);
    strokeFill(ctx, rim, outline);
    // Glass.
    ctx.beginPath();
    ctx.arc(x, y, r * 0.74, 0, Math.PI * 2);
    const glass = ctx.createRadialGradient(x - r * 0.25, y - r * 0.3, r * 0.05, x, y, r * 0.8);
    glass.addColorStop(0, '#d8f4ff');
    glass.addColorStop(0.45, C.lens);
    glass.addColorStop(1, C.lensDark);
    strokeFill(ctx, glass, outline * 0.6);
    // Shine: a bold arc and a dot.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.92)';
    ctx.lineWidth = r * 0.14;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(x, y, r * 0.5, Math.PI * 1.08, Math.PI * 1.45);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 255, 255, 0.95)';
    ctx.beginPath();
    ctx.arc(x + r * 0.28, y + r * 0.26, r * 0.1, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** Big eyes (looking ahead), determined brows, a wide open smile and rosy cheeks. */
function face(ctx: Paint2D, outline: number) {
  const C = MASCOT_COLORS;
  const eyes: Array<[number, number, number, number]> = [
    [255, 224, 22, 28],
    [327, 214, 26, 32],
  ];
  for (const [x, y, rx, ry] of eyes) {
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, -0.12, 0, Math.PI * 2);
    strokeFill(ctx, C.eyeWhite, outline * 0.8);
    ctx.beginPath();
    ctx.arc(x - rx * 0.35, y + ry * 0.05, rx * 0.52, 0, Math.PI * 2);
    ctx.fillStyle = C.pupil;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x - rx * 0.5, y - ry * 0.18, rx * 0.18, 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
  }
  // Brows.
  ctx.strokeStyle = C.outline;
  ctx.lineCap = 'round';
  ctx.lineWidth = outline * 1.3;
  ctx.beginPath();
  ctx.moveTo(234, 190);
  ctx.quadraticCurveTo(252, 180, 272, 186);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(306, 176);
  ctx.quadraticCurveTo(330, 166, 352, 176);
  ctx.stroke();
  // Smile: open D shape with teeth and tongue.
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(222, 262);
  ctx.quadraticCurveTo(285, 272, 350, 256);
  ctx.bezierCurveTo(345, 300, 300, 322, 262, 314);
  ctx.bezierCurveTo(236, 306, 222, 288, 222, 262);
  ctx.closePath();
  ctx.fillStyle = C.mouth;
  ctx.fill();
  ctx.clip();
  ctx.fillStyle = C.teeth;
  ctx.beginPath();
  ctx.moveTo(215, 255);
  ctx.quadraticCurveTo(285, 268, 360, 250);
  ctx.lineTo(360, 272);
  ctx.quadraticCurveTo(285, 288, 215, 276);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = C.tongue;
  ctx.beginPath();
  ctx.ellipse(292, 318, 42, 22, -0.1, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.beginPath();
  ctx.moveTo(222, 262);
  ctx.quadraticCurveTo(285, 272, 350, 256);
  ctx.bezierCurveTo(345, 300, 300, 322, 262, 314);
  ctx.bezierCurveTo(236, 306, 222, 288, 222, 262);
  ctx.closePath();
  ctx.strokeStyle = C.outline;
  ctx.lineWidth = outline;
  ctx.lineJoin = 'round';
  ctx.stroke();
  // Smile creases and cheeks.
  ctx.lineWidth = outline * 0.7;
  ctx.beginPath();
  ctx.moveTo(346, 244);
  ctx.quadraticCurveTo(358, 254, 354, 266);
  ctx.stroke();
  ctx.fillStyle = C.cheek;
  ctx.beginPath();
  ctx.ellipse(372, 262, 24, 15, -0.2, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Draw the mascot into `ctx`, in mascot space (MASCOT_BOX), facing −x. The caller sets the
 * transform (translate/scale/rotate) to place it. Deterministic: the same calls every time.
 */
export function drawTaterMascot(ctx: Paint2D, opts: MascotOptions = {}): void {
  const C = MASCOT_COLORS;
  const outline = opts.outline ?? 7;
  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.globalAlpha = 1;

  // Speed lines streaming aft.
  if (opts.speedLines !== false) {
    const lines: Array<[number, number, number, number]> = [
      [640, 318, 980, 12],
      [700, 352, 930, 9],
      [560, 402, 860, 10],
      [690, 440, 960, 7],
      [520, 60, 700, 7],
    ];
    ctx.strokeStyle = C.speed;
    for (const [x0, y, x1, w] of lines) {
      ctx.lineWidth = w;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
    }
  }

  cape(ctx, outline, 'back');

  // Legs trailing aft, with little red boots.
  limb(ctx, [520, 350], [590, 385], [660, 382], 34, C.skin, outline);
  limb(ctx, [480, 368], [540, 410], [610, 420], 34, C.skinDark, outline);
  for (const [x, y] of [
    [672, 380],
    [622, 420],
  ] as const) {
    ctx.beginPath();
    ctx.ellipse(x, y, 30, 21, -0.1, 0, Math.PI * 2);
    strokeFill(ctx, C.boot, outline);
    ctx.fillStyle = 'rgba(255, 170, 160, 0.6)';
    ctx.beginPath();
    ctx.ellipse(x - 6, y - 8, 14, 6, -0.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // Far arm (behind the body), reaching forward.
  limb(ctx, [300, 330], [210, 350], [140, 328], 30, C.skinDark, outline);
  fist(ctx, 124, 326, 27, outline);

  // Body.
  const body = potatoOutline(395, 262, 208, 138, -0.16);
  blob(ctx, body);
  const g = ctx.createRadialGradient(300, 180, 20, 400, 270, 250);
  g.addColorStop(0, C.skinLight);
  g.addColorStop(0.55, C.skin);
  g.addColorStop(1, C.skinDark);
  strokeFill(ctx, g, outline);

  // Potato "eyes" and freckles (deterministic).
  const rnd = seeded(172);
  const spots: Array<[number, number, number]> = [
    [470, 330, 11],
    [540, 250, 9],
    [430, 380, 7],
    [560, 320, 8],
    [505, 205, 7],
    [395, 340, 6],
  ];
  for (const [x, y, r] of spots) {
    ctx.fillStyle = C.spot;
    ctx.beginPath();
    ctx.ellipse(x, y, r * 1.3, r * 0.75, rnd() * Math.PI, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 225, 170, 0.55)';
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(x - 2, y - 2, r * 0.8, Math.PI * 1.1, Math.PI * 1.7);
    ctx.stroke();
  }
  for (let i = 0; i < 14; i++) {
    const x = 420 + rnd() * 170;
    const y = 200 + rnd() * 170;
    ctx.fillStyle = 'rgba(110, 66, 26, 0.5)';
    ctx.beginPath();
    ctx.arc(x, y, 2 + rnd() * 2.5, 0, Math.PI * 2);
    ctx.fill();
  }
  // Soft highlight on the upper front.
  ctx.fillStyle = 'rgba(255, 236, 196, 0.35)';
  ctx.beginPath();
  ctx.ellipse(300, 170, 70, 26, -0.35, 0, Math.PI * 2);
  ctx.fill();

  cape(ctx, outline, 'front');
  face(ctx, outline);
  goggles(ctx, outline);

  // Near arm, out in front like a superhero.
  limb(ctx, [330, 348], [240, 372], [168, 368], 34, C.skin, outline);
  fist(ctx, 150, 364, 31, outline);

  ctx.restore();
}
