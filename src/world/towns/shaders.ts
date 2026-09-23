/**
 * GLSL for the building materials (injected into MeshStandardMaterial /
 * MeshDepthMaterial with onBeforeCompile, so three's lighting, shadows, the
 * sky environment and the global aerial-perspective fog all apply).
 *
 * Vertex: the parametric unit mesh → the building (twin of evalVertex in
 * archetypes.ts — keep them in step). Mid LOD: per-instance distance/size
 * culling with a dithered fade, skipping chunks drawn by the near LOD.
 * Fragment: procedural facades (storeys, window grids with frames, sills,
 * curtains, lit windows at dusk, doors, garages, shopfronts, balconies, glass
 * curtain walls, corrugated sheds, barn boards, church stone and lancets,
 * silos), roofs (terracotta tiles, slate, shingles, standing-seam metal,
 * membranes with rooftop units), weathering and ambient occlusion — all
 * box-filtered and faded to their average colour when smaller than a pixel.
 */
import { FACE, FLAG, NMODE, TREE_EQ, TREE_UNDER, TREE_LUMP } from './archetypes';
import { GAMBREL_KNEE_H, GAMBREL_KNEE_T, STYLE } from './placement';
import { STYLE_X } from './instances';

const f = (x: number): string => (Number.isInteger(x) ? `${x}.0` : `${x}`);
const bit = (flag: number): number => Math.round(Math.log2(flag));

const DEFINES = `
#define BF_WALL_PZ ${FACE.wallPZ}
#define BF_WALL_NZ ${FACE.wallNZ}
#define BF_WALL_PX ${FACE.wallPX}
#define BF_WALL_NX ${FACE.wallNX}
#define BF_ROOF_PZ ${FACE.roofPZ}
#define BF_ROOF_NZ ${FACE.roofNZ}
#define BF_ROOF_PX ${FACE.roofPX}
#define BF_ROOF_NX ${FACE.roofNX}
#define BF_ROOF_FLAT ${FACE.roofFlat}
#define BF_PARAPET_TOP ${FACE.parapetTop}
#define BF_PARAPET_IN ${FACE.parapetIn}
#define BF_SOFFIT ${FACE.soffit}
#define BF_FASCIA ${FACE.fascia}
#define BF_CHIMNEY ${FACE.chimney}
#define BF_CHIMNEY_TOP ${FACE.chimneyTop}
#define BF_DORMER_FRONT ${FACE.dormerFront}
#define BF_DORMER_SIDE ${FACE.dormerSide}
#define BF_DORMER_ROOF ${FACE.dormerRoof}
#define BF_SILO_WALL ${FACE.siloWall}
#define BF_SILO_ROOF ${FACE.siloRoof}
#define BF_CUPOLA ${FACE.cupola}
#define BF_CUPOLA_ROOF ${FACE.cupolaRoof}
#define BF_AWNING ${FACE.awning}
#define BF_AWNING_UNDER ${FACE.awningUnder}
#define BF_TRUNK ${FACE.trunk}
#define BG_CHIMNEY ${bit(FLAG.chimney)}
#define BG_DORMERS ${bit(FLAG.dormers)}
#define BG_CUPOLA ${bit(FLAG.cupola)}
#define BG_SIDE ${bit(FLAG.side)}
#define BG_DOORPX ${bit(FLAG.doorPX)}
#define BG_BALCONY ${bit(FLAG.balcony)}
#define BG_SHOPFRONT ${bit(FLAG.shopfront)}
#define BG_GLASS ${bit(FLAG.glass)}
#define BG_CONE ${bit(FLAG.cone)}
#define BG_STEEPLE ${bit(FLAG.steeple)}
#define BG_GARAGE ${bit(FLAG.garage)}
#define BG_SHUTTERS ${bit(FLAG.shutters)}
#define BG_SIDING ${bit(FLAG.siding)}
#define BG_RIBBON ${bit(FLAG.ribbon)}
#define BG_FLATROOF ${bit(FLAG.flatRoof)}
#define BG_WHITEROOF ${bit(FLAG.whiteRoof)}
#define BG_BRICK ${bit(FLAG.brick)}
#define BG_BLANK ${bit(FLAG.blank)}
#define BG_UPPER ${bit(FLAG.upper)}
#define BG_METALROOF ${bit(FLAG.metalRoof)}
#define BG_TREE ${bit(FLAG.tree)}
#define BG_AWNING ${bit(FLAG.awning)}
#define BG_SOLAR ${bit(FLAG.solar)}
#define BG_STONE ${bit(FLAG.stone)}
#define BS_HOUSE ${STYLE.house}
#define BS_APARTMENT ${STYLE.apartment}
#define BS_OFFICE ${STYLE.office}
#define BS_INDUSTRIAL ${STYLE.industrial}
#define BS_BARN ${STYLE.barn}
#define BS_CHURCH ${STYLE.church}
#define BS_SILO ${STYLE.silo}
#define BS_SHOP ${STYLE.shop}
#define BS_SHED ${STYLE.shed}
#define BS_TREE ${STYLE.tree}
#define BS_POOL ${STYLE.pool}
#define BS_CIVIC ${STYLE.civic}
#define BS_HVAC ${STYLE_X.hvac}
#define BS_TANK ${STYLE_X.tank}
#define BS_MAST ${STYLE_X.mast}
#define BS_PLAIN ${STYLE_X.plain}
#define BN_SLOPE ${NMODE.slope}
#define BN_HIPEND ${NMODE.hipEnd}
#define BN_GLOWER ${NMODE.gambrelLower}
#define BN_GUPPER ${NMODE.gambrelUpper}
#define BN_DOME ${NMODE.dome}
#define B_KT ${f(GAMBREL_KNEE_T)}
#define B_KH ${f(GAMBREL_KNEE_H)}
#define B_TE ${f(TREE_EQ)}
#define B_TU ${f(TREE_UNDER)}
#define B_TL ${f(TREE_LUMP)}
`;

/** Vertex declarations (after #include <common>). */
export const BLD_VERT_PARS = `${DEFINES}
attribute vec3 aCoef;
attribute vec3 aOff;
attribute vec4 aNrm;
attribute vec2 aFace;
attribute vec4 iA;
attribute vec4 iB;
attribute vec4 iC;
attribute vec4 iD;
attribute vec4 iE;
#ifdef BLD_COLOR
varying vec3 vBldLoc;
flat varying vec4 vBldB;
flat varying vec4 vBldC;
flat varying vec4 vBldD;
flat varying vec2 vBldF;
flat varying float vBldH;
#endif
#ifdef BLD_MID
uniform sampler2D uBldChunkNear;
uniform vec4 uBldLod;
#endif
uniform vec3 uBldCam;
uniform vec2 uBldTree;
bool bldHas(int flags, int b) { return ((flags >> b) & 1) == 1; }
void bldTransform(out vec3 wpos, out vec3 wn) {
  float W = iB.x;
  float D = iB.y;
  float Hw = iB.z;
  float Hr = iB.w;
  float ridge = iD.x;
  int flags = int(iD.z + 0.5);
  int part = int(aFace.y + 0.5);
  bool on = part == 0 || (part == 1 && bldHas(flags, BG_CHIMNEY)) || (part == 2 && bldHas(flags, BG_DORMERS)) || (part == 3 && bldHas(flags, BG_CUPOLA))
    || (part == 4 && bldHas(flags, BG_AWNING)) || (part == 5 && bldHas(flags, BG_TREE));
  float side = (part == 1 && bldHas(flags, BG_SIDE)) ? -1.0 : 1.0;
  bool cone = bldHas(flags, BG_CONE);
  bool tree = part == 0 && bldHas(flags, BG_TREE);
  int mode = int(aNrm.w + 0.5);
  float pr = aCoef.x;
  if (mode == BN_DOME && cone) pr = 1.0 - 2.0 * length(position.xz);
  vec3 l = vec3(position.x * W * (aCoef.z > 0.5 ? ridge : 1.0) * side + aOff.x,
                position.y * Hw + pr * Hr + aCoef.y * Hr / D + aOff.y,
                position.z * D + aOff.z);
  if (part == 4) l.y += iD.w + 1.4 * iD.y;
  if (tree) {
    // the silo mesh as a crown (twin of evalVertex): wall = flared underside, dome = top
    float ang = abs(position.x) + abs(position.z) > 1e-6 ? atan(position.z, position.x) : 0.0;
    float ph0 = 6.2831853 * fract(iC.z * 7.0);
    float lump = 1.0 - B_TL * (0.5 + 0.3 * sin(3.0 * ang + ph0 + 2.0 * position.y + 3.0 * pr) + 0.2 * sin(7.0 * ang - 2.0 * ph0 + 5.0 * pr));
    float k = mode == BN_DOME ? lump : (B_TU + (1.0 - B_TU) * position.y) * lump;
    l.x = position.x * W * k;
    l.z = position.z * D * k;
    l.y = mode == BN_DOME ? Hw + B_TE * Hr + pr * (1.0 - B_TE) * Hr : Hw + position.y * B_TE * Hr;
  }
  vec3 n = aNrm.xyz;
  if (mode >= BN_SLOPE && mode <= BN_GUPPER) {
    float rise = Hr;
    float run = 0.5 * D;
    if (mode == BN_HIPEND) run = (1.0 - ridge) * 0.5 * W;
    else if (mode == BN_GLOWER) { rise = B_KH * Hr; run = (1.0 - B_KT) * 0.5 * D; }
    else if (mode == BN_GUPPER) { rise = (1.0 - B_KH) * Hr; run = B_KT * 0.5 * D; }
    n = vec3(aNrm.x * rise, aNrm.y * run + 1e-6 * aNrm.y, aNrm.z * rise);
  } else if (mode == BN_DOME) {
    float R = 0.5 * W;
    if (cone) {
      float hl = length(position.xz);
      vec2 hd = hl > 1e-6 ? position.xz / hl : vec2(0.0);
      n = vec3(hd.x * Hr, R, hd.y * Hr);
    } else n = vec3(aNrm.x / R, aNrm.y / max(Hr, 1e-3), aNrm.z / R);
  }
  if (tree) n = vec3(l.x / (0.5 * W), (l.y - Hw - B_TE * Hr) / ((1.0 - B_TE) * Hr), l.z / (0.5 * W));
  n = normalize(n);
  float c = cos(iA.w);
  float s = sin(iA.w);
  wpos = on ? vec3(iA.x - c * l.x + s * l.z, iA.y + l.y, iA.z - s * l.x - c * l.z) : iA.xyz;
  wn = vec3(-c * n.x + s * n.z, n.y, -s * n.x - c * n.z);
  float vis = 1.0;
  // trees: the detailed crown fades out between uBldTree.x and .y from the (real) camera; the mid blob takes over
  float treeFar = smoothstep(uBldTree.x, uBldTree.y, distance(uBldCam, iA.xyz));
#ifndef BLD_MID
  if (bldHas(flags, BG_TREE)) {
    if (treeFar >= 1.0) wpos = iA.xyz;
    vis = 1.0 - treeFar;
  }
#endif
#ifdef BLD_MID
  int ci = int(iE.x + 0.5);
  float nearFlag = texelFetch(uBldChunkNear, ivec2(ci % 256, ci / 256), 0).r;
  vec3 ctr = iA.xyz + vec3(0.0, 0.5 * (Hw + Hr), 0.0);
  float dist = distance(cameraPosition, ctr);
  float size = max(Hw + 0.6 * Hr, 0.7 * max(W, D));
  float thr = dist * uBldLod.x;
  if (dist > uBldLod.y) thr = max(thr, uBldLod.w);
  vis = smoothstep(thr * 0.8, thr, size) * (1.0 - smoothstep(uBldLod.z * 0.9, uBldLod.z, dist));
  if (nearFlag > 0.5) vis = int(iC.w + 0.5) == BS_TREE ? min(vis, treeFar) : 0.0;
  if (vis <= 0.0) wpos = vec3(0.0);
#endif
#ifdef BLD_COLOR
  vBldLoc = l;
  vBldB = iB;
  vBldC = iC;
  vBldD = iD;
  vBldF = vec2(aFace.x, vis);
  vBldH = iA.w;
#endif
}
`;

/** Replaces #include <beginnormal_vertex> in the colour material. */
export const BLD_VERT_NORMAL = `
  vec3 bldP;
  vec3 objectNormal;
  bldTransform(bldP, objectNormal);
#ifdef USE_TANGENT
  vec3 objectTangent = vec3(1.0, 0.0, 0.0);
#endif
`;

/** Replaces #include <begin_vertex>. */
export const BLD_VERT_BEGIN_COLOR = `
  vec3 transformed = bldP;
`;
export const BLD_VERT_BEGIN_DEPTH = `
  vec3 bldN;
  vec3 transformed;
  bldTransform(transformed, bldN);
`;

/** Fragment declarations (after #include <common>). */
export const BLD_FRAG_PARS = `${DEFINES}
varying vec3 vBldLoc;
flat varying vec4 vBldB;
flat varying vec4 vBldC;
flat varying vec4 vBldD;
flat varying vec2 vBldF;
flat varying float vBldH;
uniform float uBldNight;
float bldRough;
float bldMetal;
vec3 bldEmit;
float bldAO;

bool bHas(int flags, int b) { return ((flags >> b) & 1) == 1; }
vec3 bSRGB(float c) {
  float v = floor(c + 0.5);
  float r = floor(v / 65536.0);
  float g = floor((v - r * 65536.0) / 256.0);
  float b = v - r * 65536.0 - g * 256.0;
  return vec3(r, g, b) / 255.0;
}
vec3 bLin(vec3 c) { return pow(c, vec3(2.2)); }
float bh1(float n) { return fract(sin(n * 12.9898 + 4.1414) * 43758.5453); }
float bh2(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float bh3(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float bNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 q = fract(p);
  q = q * q * (3.0 - 2.0 * q);
  return mix(mix(bh2(i), bh2(i + vec2(1.0, 0.0)), q.x), mix(bh2(i + vec2(0.0, 1.0)), bh2(i + vec2(1.0, 1.0)), q.x), q.y);
}
float bFbm(vec2 p) { return 0.55 * bNoise(p) + 0.3 * bNoise(p * 2.03 + 7.1) + 0.15 * bNoise(p * 4.1 + 3.3); }
/** 1 inside [a, b] (x in metres, w = pixel footprint), smooth over one pixel. */
float bIn(float x, float a, float b, float w) { return clamp((x - a) / w + 0.5, 0.0, 1.0) * clamp((b - x) / w + 0.5, 0.0, 1.0); }
float bRect(vec2 q, vec2 lo, vec2 hi, vec2 w) { return bIn(q.x, lo.x, hi.x, w.x) * bIn(q.y, lo.y, hi.y, w.y); }
/** Thin line pattern with period p and width lw (fraction of 1 = line), faded out when sub-pixel. */
float bLines(float x, float p, float lw, float w) {
  float t = fract(x / p);
  float d = min(t, 1.0 - t) * p;
  float fade = 1.0 - smoothstep(0.25 * p, 0.6 * p, w);
  return mix(lw / p, 1.0 - smoothstep(lw * 0.5 - 0.5 * w, lw * 0.5 + 0.5 * w, d), fade);
}
float bIGN(vec2 p) { return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715)))); }

struct BFac { vec3 alb; float rough; float metal; vec3 emit; float ao; };

// Interior light colours (linear, unit intensity): warm 2700 K, neutral LED, cool office, a TV's blue.
const vec3 B_WARM = vec3(1.0, 0.56, 0.24);
const vec3 B_NEUTRAL = vec3(1.0, 0.78, 0.52);
const vec3 B_OFFICE = vec3(1.0, 0.9, 0.72);
const vec3 B_TV = vec3(0.35, 0.5, 1.0);
/** Emission of a lit window (calibrated for exposure ≈ 2.2: glowing at dusk, invisible in daylight). */
const float B_LIT = 0.2;

/** Colour and level of one lit room from its hash: most rooms dim, a few bright. */
vec3 bRoomLight(float h, bool office) {
  float k = fract(h * 5.77);
  vec3 c = office ? (k < 0.6 ? B_OFFICE : B_NEUTRAL) : (k < 0.6 ? B_WARM : k < 0.9 ? B_NEUTRAL : B_TV);
  float f = fract(h * 29.7);
  return c * B_LIT * (0.25 + 1.1 * f * f);
}

/** Glass of one window: dark interior with curtains, reflective; lit at dusk. */
float bldJit;
void bGlass(inout BFac o, float m, vec2 q, float ww, float wh, float h, float litFrac, bool office) {
  float curtain = step(0.42, fract(h * 7.13)) * (office ? 0.0 : 1.0);
  float ch = wh * (0.3 + 0.6 * fract(h * 3.7));
  // curtains/blinds: pale fabric in the upper part, with folds
  float cm = curtain * smoothstep(wh - ch - 0.02, wh - ch + 0.02, q.y);
  float fold = 0.85 + 0.15 * sin(q.x * 31.0 + h * 20.0);
  vec3 cur = mix(vec3(0.42, 0.39, 0.33), vec3(0.3, 0.3, 0.29), fract(h * 5.3)) * fold * 0.55;
  // glass over a dark interior: a metallic-workflow mirror with F0 ≈ 0.08–0.12, faintly tinted
  vec3 glassF0 = vec3(0.075, 0.085, 0.09) * (0.85 + 0.5 * fract(h * 13.1));
  float lit = step(fract(h * 17.31), litFrac);
  // a lit room: brighter toward the ceiling light, curtains glow through
  vec3 e = bRoomLight(h, office) * lit * (cm > 0.5 ? 0.7 : 0.8 + 0.4 * clamp(q.y / max(wh, 0.1), 0.0, 1.0));
  o.alb = mix(o.alb, mix(glassF0, cur, cm), m);
  o.rough = mix(o.rough, mix(0.04 + 0.06 * fract(h * 3.1), 0.2, cm), m);
  o.metal = mix(o.metal, mix(1.0, 0.25, cm), m);
  o.emit += e * m;
  bldJit = mix(bldJit, fract(h * 41.3) - 0.5, m);
}
`;

/**
 * The shading function (goes after the declarations): writes diffuseColor.rgb
 * and the bld* globals used by the replaced roughness/metalness/emissive/AO chunks.
 */
export const BLD_FRAG_SHADE = `
BFac bldShade() {
  float W = vBldB.x;
  float D = vBldB.y;
  float Hw = vBldB.z;
  float Hr = vBldB.w;
  vec3 wallS = bSRGB(vBldC.x);
  vec3 roofS = bSRGB(vBldC.y);
  float rnd = vBldC.z;
  int style = int(vBldC.w + 0.5);
  float ridge = vBldD.x;
  float fh = vBldD.y;
  int flags = int(vBldD.z + 0.5);
  float plinth = vBldD.w;
  int face = int(vBldF.x + 0.5);
  vec3 L = vBldLoc;
  bool flatRoof = bHas(flags, BG_FLATROOF);
  bool doorPX = bHas(flags, BG_DOORPX);
  bool upper = bHas(flags, BG_UPPER);
  bool blank = bHas(flags, BG_BLANK);
  float r2 = bh1(rnd * 71.3 + 1.7);
  float r3 = bh1(rnd * 13.9 + 5.1);
  vec3 wallC = bLin(wallS) * (0.72 + 0.16 * r2);
  vec3 roofC = bLin(roofS) * (0.88 + 0.24 * r3);
  bldJit = 0.0;
  BFac o;
  o.alb = wallC;
  o.rough = 0.88;
  o.metal = 0.0;
  o.emit = vec3(0.0);
  o.ao = 1.0;

  // ───────────────────────── trees ─────────────────────────
  if (style == BS_TREE) {
    if (face == BF_TRUNK) {
      o.alb = vec3(0.07, 0.055, 0.04);
      o.rough = 0.95;
      return o;
    }
    vec3 fwp = fwidth(L);
    float det = 1.0 - smoothstep(0.08, 0.35, max(max(fwp.x, fwp.y), fwp.z));
    float c1 = bNoise(vec2(L.x + L.y * 0.7, L.z - L.y * 0.5) * 1.6 + rnd * 40.0);
    float c2 = bNoise(vec2(L.x - L.z, L.y) * 4.3 + rnd * 17.0);
    float clump = mix(0.5, c1 * 0.65 + c2 * 0.35, det);
    vec3 leaf = bLin(wallS) * vec3(1.0 + 0.14 * (r2 - 0.5), 1.0, 1.0 - 0.2 * (r3 - 0.5));
    leaf = mix(vec3(dot(leaf, vec3(0.3, 0.55, 0.15))), leaf, 0.8) * 0.7;
    o.alb = leaf * (0.45 + 1.0 * clump * clump);
    float hgt = clamp((L.y - Hw) / max(Hr, 0.1), 0.0, 1.0);
    o.ao = mix(0.35, 1.0, smoothstep(0.0, 0.8, hgt)) * (0.72 + 0.28 * clump);
    o.rough = 0.8;
    return o;
  }
  // ───────────────────────── pools ─────────────────────────
  if (style == BS_POOL) {
    if (face == BF_ROOF_FLAT) {
      vec2 pp = L.xz;
      float ripple = bNoise(pp * 2.5 + rnd * 30.0);
      o.alb = bLin(roofS) * 0.5 * (0.9 + 0.2 * ripple) * mix(1.0, 0.7, smoothstep(-0.5 * D, 0.5 * D, pp.y));
      o.rough = 0.03;
      bldJit = (ripple - 0.5) * 0.6;
      return o;
    }
    o.alb = bLin(wallS) * 0.85;
    o.rough = 0.85;
    return o;
  }
  // round towers: a near-flat roof deck
  if (face == BF_SILO_ROOF && style == BS_OFFICE) face = BF_ROOF_FLAT;
  // mid prism: gable ends are walls, flat roofs are membranes
  if ((face == BF_ROOF_PX || face == BF_ROOF_NX) && ridge > 0.999 && !flatRoof) face -= 4;
  if (face >= BF_ROOF_PZ && face <= BF_ROOF_NX && flatRoof) face = BF_ROOF_FLAT;

  float night = uBldNight;
  bool isWall = face <= BF_WALL_NX || face == BF_SILO_WALL;
  // ───────────────────────── walls ─────────────────────────
  if (isWall) {
    float u;
    float len;
    if (face == BF_WALL_PZ) { u = L.x + 0.5 * W; len = W; }
    else if (face == BF_WALL_NZ) { u = 0.5 * W - L.x; len = W; }
    else if (face == BF_WALL_PX) { u = 0.5 * D - L.z; len = D; }
    else if (face == BF_WALL_NX) { u = L.z + 0.5 * D; len = D; }
    else { float R = 0.5 * W; u = (atan(L.z, L.x) + 3.14159265) * R; len = 6.2831853 * R; }
    float v = L.y;
    vec2 fw = max(vec2(fwidth(u), fwidth(v)), vec2(1e-4));
    if (face == BF_SILO_WALL) fw.x = max(0.5 * W * min(fwidth(atan(L.z, L.x)), fwidth(atan(-L.z, -L.x))), 1e-4);
    bool front = doorPX ? face == BF_WALL_PX : face == BF_WALL_PZ;
    bool back = doorPX ? face == BF_WALL_NX : face == BF_WALL_NZ;
    bool eaveWall = face == BF_WALL_PZ || face == BF_WALL_NZ;
    float fi2 = float(face) + 1.0;
    float g0 = upper ? 0.0 : plinth;           // ground-floor level above the base
    float vf = v - g0;
    float top = Hw - g0;                         // height of the walls above the ground floor
    float lum = dot(wallS, vec3(0.3, 0.59, 0.11));
    // weathering: grime rising from the ground, rain streaks, per-wall tone
    float streak = bNoise(vec2(u * 1.7 + rnd * 40.0, v * 0.12 + fi2 * 3.1));
    float grime = (1.0 - smoothstep(0.0, 1.4, vf + 0.2)) * (0.55 + 0.45 * bNoise(vec2(u * 0.9, fi2)));
    float stain = bFbm(vec2(u * 0.18, v * 0.22) + rnd * 31.0 + fi2 * 5.7);
    o.alb *= (0.9 + 0.1 * streak) * (1.0 - 0.3 * grime) * (0.96 + 0.04 * float(face & 1)) * (0.86 + 0.24 * stain);
    // upper storeys a touch cleaner, lower ones dustier
    o.alb *= 0.94 + 0.06 * smoothstep(0.0, 12.0, v);
    // base AO and the shade under the eaves
    o.ao *= mix(0.5, 1.0, smoothstep(0.0, 2.2, v));
    bool pitched = !flatRoof && style != BS_SILO && style != BS_TANK;
    if (pitched && eaveWall) o.ao *= mix(0.62, 1.0, smoothstep(0.0, 0.9, Hw - v));
    // plinth / foundation
    if (!upper && style != BS_HVAC && style != BS_MAST) {
      float pm = 1.0 - smoothstep(g0 + 0.2 - fw.y, g0 + 0.2 + fw.y, v);
      o.alb = mix(o.alb, vec3(0.16, 0.155, 0.15) * (0.8 + 0.4 * streak), pm);
    }

    if (face == BF_SILO_WALL && style == BS_CIVIC) {
      // water tower tank: smooth painted steel, a darker band with the town's lettering
      o.rough = 0.45;
      o.metal = 0.2;
      // a painted stripe near the top, weld seams, rust streaks from the rim
      float stripe = bIn(v, Hw - 1.6, Hw - 0.9, fw.y);
      vec3 stripeC = r3 < 0.5 ? vec3(0.03, 0.08, 0.2) : vec3(0.25, 0.03, 0.02);
      o.alb *= 1.0 - 0.08 * bLines(v, 2.4, 0.04, fw.y);
      o.alb = mix(o.alb, stripeC, stripe);
      o.alb *= 1.0 - 0.15 * smoothstep(0.6, 0.9, bNoise(vec2(u * 1.3, v * 0.08) + rnd * 9.0)) * smoothstep(0.5 * Hw, Hw, v);
    } else if (style == BS_HOUSE || style == BS_APARTMENT || style == BS_SHOP || style == BS_OFFICE || style == BS_CIVIC) {
      bool glass = bHas(flags, BG_GLASS);
      bool ribbon = bHas(flags, BG_RIBBON);
      bool shop = bHas(flags, BG_SHOPFRONT);
      bool civic = style == BS_CIVIC;
      bool apt = style == BS_APARTMENT || civic;
      bool house = style == BS_HOUSE;
      // wall finish: brick courses, stone, lap siding or render
      if (bHas(flags, BG_BRICK)) {
        float course = floor(v / 0.075);
        float bv = bh2(vec2(floor(u / 0.23 + course * 0.5), course));
        float det = 1.0 - smoothstep(0.02, 0.06, fw.x);
        o.alb *= mix(1.0, 0.86 + 0.28 * bv, det) * (1.0 - 0.18 * det * bLines(v, 0.075, 0.012, fw.y));
        // soot and efflorescence patches on old brick
        o.alb *= 0.9 + 0.2 * bFbm(vec2(u, v) * 0.4 + rnd * 11.0);
      } else if (bHas(flags, BG_STONE)) {
        float course = floor(v / 0.45);
        float bl = 0.7 + 0.4 * bh1(course + rnd * 7.0);
        float bu = u / bl + course * 0.41;
        float bv = bh2(vec2(floor(bu), course) + rnd * 13.0);
        float det = 1.0 - smoothstep(0.03, 0.09, max(fw.x, fw.y));
        float mortar = max(bLines(v, 0.45, 0.02, fw.y), bLines(bu * bl, bl, 0.02, fw.x));
        o.alb *= mix(1.0, (0.9 + 0.18 * bv) * (1.0 - 0.22 * mortar), det);
      } else if (bHas(flags, BG_SIDING)) {
        o.alb *= 1.0 - 0.22 * bLines(v + 0.1, 0.2, 0.03, fw.y);
      } else if (!glass) {
        // render / stucco: a fine trowelled texture and patchy repaints
        float det = 1.0 - smoothstep(0.02, 0.08, fw.x);
        o.alb *= mix(1.0, 0.95 + 0.1 * bNoise(vec2(u, v) * 3.1 + rnd * 5.0), det) * (0.94 + 0.12 * bNoise(vec2(u, v) * 0.35 + fi2));
      }
      // storeys
      float groundH = fh * (shop ? 1.4 : glass ? 1.35 : 1.0);
      float fi = vf < groundH ? 0.0 : 1.0 + floor((vf - groundH) / fh);
      float fv = vf < groundH ? vf : vf - groundH - (fi - 1.0) * fh;
      float nf = top < groundH + 0.3 ? 1.0 : 1.0 + floor((top - groundH - 0.3) / fh);
      bool inFloors = vf >= 0.0 && fi < nf;
      if (glass && !blank) {
        // ── curtain wall: coated glass (15–40 % reflectance, tinted), mullions, spandrels ──
        float r4 = bh1(rnd * 29.1 + 3.7);
        float mullP = r4 < 0.3 ? 1.2 : r4 < 0.75 ? 1.5 : 3.0;
        float mu = bLines(u, mullP, 0.06, fw.x);
        float mt = bLines(vf - groundH, fh, 0.08, fw.y);
        float panel = floor(u / mullP);
        float ph = bh3(vec3(panel, fi, fi2 + rnd * 50.0));
        bool lobby = fi < 0.5;
        float spandrelH = r4 < 0.5 ? 0.95 : 0.0;   // half the towers are all-glass (spandrels behind the glass)
        float spandrel = lobby ? 0.0 : 1.0 - smoothstep(spandrelH - fw.y, spandrelH + fw.y, fv);
        vec3 gt = bLin(wallS);
        float gl = max(dot(gt, vec3(0.2126, 0.7152, 0.0722)), 1e-3);
        vec3 F0 = gt / gl * (0.14 + 0.22 * r3);
        vec3 glassA = lobby ? vec3(0.02, 0.022, 0.024) : F0 * (0.85 + 0.3 * ph);
        vec3 spand = mix(F0 * 0.5, gt * 0.35, 0.5);
        o.alb = mix(glassA, spand, spandrel);
        o.rough = lobby ? 0.08 : mix(0.09 + 0.08 * ph * ph, 0.3, spandrel);
        o.metal = lobby ? 0.0 : mix(0.92, 0.55, spandrel);
        // vertical fins / piers on some towers
        if (r2 > 0.78) {
          float pier = bLines(u + 2.25, 4.5, r2 > 0.9 ? 0.35 : 0.6, fw.x);
          o.alb = mix(o.alb, bLin(wallS) * 0.45 + 0.05, pier * 0.9);
          o.rough = mix(o.rough, 0.7, pier);
          o.metal = mix(o.metal, 0.1, pier);
          mu *= 1.0 - pier;
        }
        // interior lights at dusk: long runs of a floor (open-plan offices), busier buildings brighter
        float runW = mullP * (6.0 + floor(10.0 * bh3(vec3(fi, fi2, rnd * 7.0))));
        float rh = bh3(vec3(floor(u / runW), fi, rnd * 91.0 + fi2));
        float busy = 0.25 + 0.5 * r4;
        float lit = step(rh, night * busy) * (1.0 - spandrel) * (lobby ? 0.0 : 1.0);
        o.emit += bRoomLight(rh * 13.7, true) * lit * (0.75 + 0.5 * ph);
        // the lobby glows
        o.emit += B_NEUTRAL * B_LIT * 0.35 * night * (lobby ? 1.0 : 0.0) * (1.0 - spandrel);
        vec3 metal = mix(vec3(0.18, 0.19, 0.2), vec3(0.5), step(0.5, r3));
        float frame = max(mu, mt) * 0.85;
        bldJit = (ph - 0.5) * (1.0 - spandrel) * (lobby ? 0.0 : 1.0);
        o.alb = mix(o.alb, metal, frame);
        o.rough = mix(o.rough, 0.35, frame);
        o.metal = mix(o.metal, 0.8, frame);
        o.emit *= 1.0 - frame;
        // entrance doors
        if (lobby && front) {
          float dm = bRect(vec2(u - 0.5 * len, vf), vec2(-1.6, 0.0), vec2(1.6, 2.6), fw);
          o.alb = mix(o.alb, vec3(0.03), dm * 0.6);
        }
      } else if (!blank) {
        // ── punched windows ──
        float bay = house ? 3.1 : ribbon ? 1.6 : civic ? 3.4 : apt ? 3.3 : 2.9;
        float ww = house ? 1.1 + 0.3 * r3 : ribbon ? 1.5 : civic ? 1.5 : apt ? 1.45 : 1.15;
        float wh = house ? 1.3 + 0.2 * r2 : ribbon ? 1.55 : civic ? 2.1 : apt ? 1.5 : 1.65;
        float sill = house ? 0.85 : 0.9;
        float margin = 0.9;
        float usable = max(len - 2.0 * margin, 0.1);
        float nb = max(1.0, floor(usable / bay));
        float cell = usable / nb;
        float bi = clamp(floor((u - margin) / cell), 0.0, nb - 1.0);
        float cu = margin + (bi + 0.5) * cell;
        float thisH = fi < 0.5 ? groundH : fh;
        vec2 q = vec2(u - cu, fv - sill);
        float wh2 = min(wh, thisH - sill - 0.3);
        float h = bh3(vec3(bi, fi, fi2 + rnd * 50.0));
        // which bays have windows: gable ends of houses and terraced shops have fewer
        float keep = 1.0;
        if (!eaveWall && (house || shop)) keep = step(0.45, bh3(vec3(bi, 7.0, fi2 + rnd * 11.0)));
        if (u < margin * 0.6 || u > len - margin * 0.6) keep = 0.0;
        if (!inFloors) keep = 0.0;
        // attic: gable ends above the eave line get one small window
        if (!eaveWall && pitched && v > Hw) {
          keep = 0.0;
          if (Hr > 2.4 && (house || apt)) {
            vec2 qa = vec2(u - 0.5 * len, v - Hw - 0.35 * Hr);
            float am = bRect(qa, vec2(-0.4, -0.45), vec2(0.4, 0.45), fw);
            float af = bRect(qa, vec2(-0.5, -0.55), vec2(0.5, 0.55), fw) - am;
            o.alb = mix(o.alb, vec3(0.8), af);
            bGlass(o, am, qa + vec2(0.0, 0.45), 0.8, 0.9, bh1(rnd * 3.3), night * 0.2, false);
          }
        }
        float ribbonW = ribbon ? cell - 0.12 : ww;
        float wm = keep * bRect(q, vec2(-0.5 * ribbonW, 0.0), vec2(0.5 * ribbonW, wh2), fw);
        float fr = 0.08;
        float fm = keep * bRect(q, vec2(-0.5 * ribbonW - fr, -fr), vec2(0.5 * ribbonW + fr, wh2 + fr), fw) - wm;
        float sm = keep * bRect(q, vec2(-0.5 * ribbonW - 0.1, -0.16), vec2(0.5 * ribbonW + 0.1, -fr), fw);
        vec3 frameC = r2 < 0.7 ? vec3(0.85, 0.84, 0.8) : vec3(0.1, 0.1, 0.1);
        // door, garage, shopfront, balconies override the window of their bay
        bool ground = fi < 0.5 && inFloors;
        float db = floor(fract(rnd * 7.77) * nb);
        bool doorBay = front && ground && bi == db && !upper;
        bool garageBay = front && ground && bHas(flags, BG_GARAGE) && nb >= 2.0 && bi == (db < nb - 1.0 ? nb - 1.0 : 0.0);
        // lit fraction: some homes are out, some blocks busier
        float lf = night * (house ? 0.35 : civic ? 0.15 : apt ? 0.45 : 0.4) * (0.4 + 1.2 * r3);
        // detail fade (windows smaller than ~3 px → their average)
        float det = 1.0 - smoothstep(0.18, 0.4, max(fw.x / cell, fw.y / fh));
        float cov = keep * min(1.0, (ribbonW * wh2) / (cell * thisH));
        BFac avg = o;
        avg.alb = mix(o.alb, vec3(0.03), cov * 0.8);
        avg.rough = mix(o.rough, 0.2, cov);
        avg.emit = B_WARM * B_LIT * 0.8 * lf * cov;
        bool garageOnly = bHas(flags, BG_GARAGE) && len < 7.8 && front;
        if (garageOnly) {
          // a detached garage: one wide door (two on a double garage)
          vec2 qd = vec2(u - 0.5 * len, vf);
          float gw = min(len - 1.2, 5.2);
          float gm = bRect(qd, vec2(-0.5 * gw, 0.0), vec2(0.5 * gw, 2.2), fw);
          vec3 gc = (bh1(rnd * 9.1) < 0.6 ? vec3(0.82, 0.82, 0.8) : vec3(0.3, 0.3, 0.3)) * (1.0 - 0.3 * bLines(qd.y, 0.55, 0.04, fw.y));
          o.alb = mix(o.alb, gc, gm);
          o.rough = mix(o.rough, 0.45, gm);
          o.ao *= 1.0 - 0.3 * gm;
          wm = 0.0; fm = 0.0; sm = 0.0;
        } else if (doorBay) {
          vec2 qd = vec2(u - cu, fv);
          float dm = bRect(qd, vec2(-0.5, 0.0), vec2(0.5, 2.1), fw);
          float df = bRect(qd, vec2(-0.6, 0.0), vec2(0.6, 2.2), fw) - dm;
          float dc = bh1(rnd * 5.1);
          vec3 doorC = dc < 0.3 ? vec3(0.9, 0.9, 0.88) : dc < 0.5 ? vec3(0.05, 0.12, 0.08) : dc < 0.65 ? vec3(0.32, 0.03, 0.03) : dc < 0.8 ? vec3(0.03, 0.05, 0.14) : vec3(0.16, 0.08, 0.04);
          o.alb = mix(o.alb, doorC, dm);
          o.alb = mix(o.alb, frameC, df);
          o.rough = mix(o.rough, 0.5, dm);
          o.ao *= 1.0 - 0.25 * dm;
          wm = 0.0; fm = 0.0; sm = 0.0;
        } else if (garageBay) {
          vec2 qd = vec2(u - cu, fv);
          float gm = bRect(qd, vec2(-1.3, 0.0), vec2(1.3, 2.2), fw);
          vec3 gc = (bh1(rnd * 9.1) < 0.6 ? vec3(0.82, 0.82, 0.8) : vec3(0.3, 0.3, 0.3)) * (1.0 - 0.3 * bLines(qd.y, 0.55, 0.04, fw.y));
          o.alb = mix(o.alb, gc, gm);
          o.rough = mix(o.rough, 0.45, gm);
          o.ao *= 1.0 - 0.3 * gm;
          wm = 0.0; fm = 0.0; sm = 0.0;
        } else if (shop && ground && front) {
          // shopfront: display glass between pilasters, fascia sign above
          float pil = bLines(u, max(cell, 3.2), 0.45, fw.x);
          float disp = bIn(fv, 0.45, groundH - 1.05, fw.y) * (1.0 - pil) * step(0.5, u) * step(u, len - 0.5);
          float sign = bIn(fv, groundH - 0.95, groundH - 0.25, fw.y) * step(0.3, u) * step(u, len - 0.3);
          float sc = bh1(rnd * 17.3);
          vec3 signC = sc < 0.2 ? vec3(0.35, 0.02, 0.02) : sc < 0.4 ? vec3(0.01, 0.12, 0.05) : sc < 0.55 ? vec3(0.02, 0.03, 0.12) : sc < 0.75 ? vec3(0.02) : sc < 0.9 ? vec3(0.8, 0.78, 0.7) : vec3(0.6, 0.35, 0.02);
          float letters = step(0.55, bh2(floor(vec2(u / 0.35, fv / 0.25)) + rnd * 31.0)) * bIn(fv, groundH - 0.8, groundH - 0.4, fw.y) * bIn(u, len * 0.25, len * 0.75, fw.x);
          vec3 letterC = dot(signC, vec3(1.0)) > 1.0 ? vec3(0.03) : vec3(0.85, 0.82, 0.7);
          o.alb = mix(o.alb, mix(signC, letterC, letters * (1.0 - smoothstep(0.03, 0.08, fw.x))), sign);
          o.rough = mix(o.rough, 0.4, sign);
          vec2 qs = vec2(fract(u / 2.0), fv - 0.45);
          bGlass(o, disp, qs, 2.0, groundH - 1.5, bh3(vec3(floor(u / 2.0), 3.0, rnd * 9.0)), max(lf * 1.6, 0.0), false);
          o.alb = mix(o.alb, vec3(0.05), (bIn(fv, 0.35, 0.45, fw.y) + bIn(fv, groundH - 1.05, groundH - 0.95, fw.y)) * (1.0 - pil) * 0.8);
          // awning shadow under the sign (the awning itself casts the sun's shadow near the aircraft)
          if (bHas(flags, BG_AWNING)) o.ao *= 1.0 - 0.45 * bIn(fv, 0.0, groundH - 1.0, fw.y) * smoothstep(0.0, groundH - 1.0, fv);
          else o.ao *= 1.0 - 0.35 * bIn(fv, groundH - 1.6, groundH - 1.0, fw.y) * step(0.5, r3);
          wm = 0.0; fm = 0.0; sm = 0.0;
          det = 1.0;
        } else if (apt && bHas(flags, BG_BALCONY) && eaveWall && fi > 0.5 && inFloors && mod(bi + floor(rnd * 2.0), 2.0) < 0.5) {
          // balcony: slab edge, railing, French door, shade inside
          vec2 qb = vec2(u - cu, fv);
          float bw = cell - 0.5;
          float inBay = bIn(qb.x, -0.5 * bw, 0.5 * bw, fw.x);
          float slab = inBay * bIn(qb.y, -0.2, 0.0, fw.y);
          float rail = inBay * bIn(qb.y, 0.0, 1.05, fw.y);
          float railTop = inBay * bIn(qb.y, 0.98, 1.08, fw.y);
          float door = bRect(qb, vec2(-0.75, 0.0), vec2(0.75, 2.25), fw);
          float recess = inBay * bIn(qb.y, 1.05, fh - 0.2, fw.y);
          // the recess under the slab above is in shadow, darkest at the top
          o.alb *= 1.0 - 0.3 * recess;
          o.ao *= 1.0 - (0.35 + 0.35 * smoothstep(1.2, fh - 0.2, qb.y)) * recess;
          bGlass(o, door * (1.0 - rail), qb, 1.5, 2.25, h, lf, false);
          // railing: solid painted parapet or dark glass with balusters
          float solid = step(0.5, r3);
          float bal = bLines(qb.x, 0.12, 0.03, fw.x);
          vec3 railC = solid > 0.5 ? mix(wallC, vec3(0.9), 0.4) * (0.9 + 0.1 * streak) : mix(vec3(0.05, 0.06, 0.07), vec3(0.02), bal);
          o.alb = mix(o.alb, railC, rail);
          o.rough = mix(o.rough, solid > 0.5 ? 0.85 : 0.2, rail);
          o.metal = mix(o.metal, solid > 0.5 ? 0.0 : 0.6, rail);
          o.alb = mix(o.alb, vec3(0.68, 0.66, 0.62), max(slab, railTop * 0.8));
          o.ao *= 1.0 - 0.45 * inBay * bIn(qb.y, -0.55, -0.2, fw.y);
          wm = 0.0; fm = 0.0; sm = 0.0;
          det = max(det, 0.0);
        }
        // shade under the balcony above
        if (apt && bHas(flags, BG_BALCONY) && eaveWall && inFloors && fi < nf - 1.0 && mod(bi + floor(rnd * 2.0), 2.0) < 0.5) {
          float thisTop = fi < 0.5 ? groundH : fh;
          o.ao *= 1.0 - 0.35 * bIn(u - cu, -0.5 * cell, 0.5 * cell, fw.x) * smoothstep(thisTop - 0.6, thisTop - 0.05, fv);
        }
        // shutters
        if (bHas(flags, BG_SHUTTERS) && house) {
          float sh = keep * bRect(vec2(abs(q.x), q.y), vec2(0.5 * ww + 0.1, 0.0), vec2(0.5 * ww + 0.55, wh2), fw) * (1.0 - wm);
          float sc = bh1(rnd * 2.9);
          vec3 shC = sc < 0.3 ? vec3(0.03, 0.09, 0.05) : sc < 0.55 ? vec3(0.04, 0.07, 0.15) : sc < 0.8 ? vec3(0.02) : vec3(0.3, 0.05, 0.03);
          o.alb = mix(o.alb, shC * (1.0 - 0.3 * bLines(q.y, 0.12, 0.03, fw.y)), sh);
        }
        o.alb = mix(o.alb, frameC, fm);
        o.alb = mix(o.alb, vec3(0.55, 0.54, 0.5), sm);
        o.ao *= 1.0 - 0.2 * sm;
        // mullion + transom on house windows
        float mull = house ? max(bIn(q.x, -0.03, 0.03, fw.x), bIn(q.y, wh2 * 0.66 - 0.03, wh2 * 0.66 + 0.03, fw.y)) : 0.0;
        bGlass(o, wm * (1.0 - mull), q, ww, wh2, h, lf, ribbon);
        o.alb = mix(o.alb, frameC, wm * mull);
        // the reveal: the wall's thickness shades the top and one side of the opening
        float rev = wm * max(bIn(q.y, wh2 - 0.16, wh2, fw.y), bIn(q.x, -0.5 * ribbonW, -0.5 * ribbonW + 0.1, fw.x));
        o.alb *= 1.0 - 0.6 * rev;
        o.metal *= 1.0 - rev;
        // storey bands on apartments/offices
        if (!house) o.alb *= 1.0 - 0.1 * bIn(fract((vf - groundH) / fh) * fh, 0.0, 0.25, fw.y) * step(groundH, vf);
        // cornice at the top of flat-roofed blocks
        if (flatRoof) {
          float corn = bIn(v, Hw - 0.1, Hw + 0.35, fw.y);
          o.alb = mix(o.alb, o.alb * 0.8 + 0.08, corn);
          o.ao *= 1.0 - 0.3 * bIn(v, Hw - 0.5, Hw - 0.1, fw.y);
        }
        // blend to the average when the grid is sub-pixel
        o.alb = mix(avg.alb, o.alb, det);
        o.rough = mix(avg.rough, o.rough, det);
        o.emit = mix(avg.emit, o.emit, det);
      }
    } else if (style == BS_INDUSTRIAL || style == BS_SHED) {
      // corrugated cladding or block
      bool block = r2 > 0.7 && style == BS_INDUSTRIAL;
      float rib = block ? bLines(v, 0.2, 0.015, fw.y) * 0.5 + bLines(u + floor(v / 0.2) * 0.2, 0.4, 0.015, fw.x) * 0.5 : 0.5 + 0.5 * cos(6.2831 * u / 0.19);
      float ribFade = 1.0 - smoothstep(0.03, 0.09, fw.x);
      o.alb *= block ? 1.0 - 0.15 * rib : mix(1.0, 0.86 + 0.18 * rib, ribFade);
      o.rough = block ? 0.9 : 0.55;
      o.metal = block ? 0.0 : 0.25;
      // concrete base
      float base = 1.0 - smoothstep(g0 + 1.1 - fw.y, g0 + 1.1 + fw.y, v);
      o.alb = mix(o.alb, vec3(0.3, 0.29, 0.27) * (0.85 + 0.3 * streak), base);
      o.rough = mix(o.rough, 0.9, base);
      o.metal = mix(o.metal, 0.0, base);
      // clerestory strip on the long walls
      if (eaveWall && Hw - g0 > 5.0) {
        float cl = bIn(v, Hw - 1.7, Hw - 0.8, fw.y) * bIn(u, 1.0, len - 1.0, fw.x) * (1.0 - bLines(u, 2.5, 0.12, fw.x));
        o.alb = mix(o.alb, vec3(0.55, 0.57, 0.55), cl);
        o.rough = mix(o.rough, 0.35, cl);
        o.emit += B_OFFICE * cl * night * 0.25 * step(0.5, r3);
      }
      // loading doors along the front
      if (front) {
        float bayW = style == BS_SHED ? max(5.5, len / 3.0) : 9.0;
        float nb = max(1.0, floor(len / bayW));
        float cell = len / nb;
        float bi = floor(u / cell);
        float cu = (bi + 0.5) * cell;
        float dw = min(style == BS_SHED ? cell - 1.0 : 4.2, cell - 1.2);
        float dh = min(style == BS_SHED ? Hw - g0 - 0.6 : 4.6, Hw - g0 - 1.0);
        vec2 qd = vec2(u - cu, vf);
        float dm = bRect(qd, vec2(-0.5 * dw, 0.0), vec2(0.5 * dw, dh), fw);
        float dfm = bRect(qd, vec2(-0.5 * dw - 0.15, 0.0), vec2(0.5 * dw + 0.15, dh + 0.15), fw) - dm;
        float hh = bh3(vec3(bi, 5.0, rnd * 19.0));
        bool open = hh < (style == BS_SHED ? 0.6 : 0.2);
        vec3 dc = open ? vec3(0.012) : (hh < 0.6 ? vec3(0.55, 0.56, 0.55) : hh < 0.8 ? vec3(0.08, 0.16, 0.3) : vec3(0.7, 0.68, 0.62)) * (1.0 - 0.25 * bLines(qd.y, 0.16, 0.03, fw.y));
        o.alb = mix(o.alb, dc, dm);
        o.rough = mix(o.rough, open ? 0.95 : 0.5, dm);
        o.metal = mix(o.metal, 0.0, dm);
        o.ao *= 1.0 - (open ? 0.6 : 0.15) * dm;
        o.alb = mix(o.alb, vec3(0.06), dfm * 0.7);
        if (open) o.emit += B_OFFICE * dm * night * 0.3 * step(0.6, hh * 3.0 - floor(hh * 3.0));
        // personnel door beside the first bay
        float pd = bRect(vec2(u - cu - 0.5 * dw - 1.0, vf), vec2(-0.45, 0.0), vec2(0.45, 2.1), fw) * step(bi, 0.5);
        o.alb = mix(o.alb, vec3(0.25, 0.26, 0.27), pd);
      }
    } else if (style == BS_BARN) {
      // vertical boards, weathered paint, white trim, big doors on the gable end
      float board = bLines(u, 0.26, 0.025, fw.x);
      float wear = smoothstep(0.55, 0.85, bFbm(vec2(u * 0.35, v * 0.5) + rnd * 20.0)) * (0.3 + 0.7 * r2);
      o.alb = mix(o.alb, vec3(0.18, 0.15, 0.12), wear * 0.6);
      o.alb *= 1.0 - 0.3 * board;
      vec3 trimC = lum > 0.6 ? vec3(0.2, 0.05, 0.03) : vec3(0.78, 0.77, 0.73);
      float trim = max(bIn(u, 0.0, 0.2, fw.x), bIn(u, len - 0.2, len, fw.x));
      if (eaveWall) trim = max(trim, bIn(v, Hw - 0.25, Hw + 0.1, fw.y));
      float base = 1.0 - smoothstep(g0 + 0.45 - fw.y, g0 + 0.45 + fw.y, v);
      o.alb = mix(o.alb, vec3(0.28, 0.27, 0.25), base);
      if (front || back) {
        float dw = min(front ? 4.6 : 3.2, 0.42 * len);
        float dh = min(front ? 4.2 : 3.2, 0.82 * (Hw - g0));
        vec2 qd = vec2(u - 0.5 * len, vf);
        float dm = bRect(qd, vec2(-0.5 * dw, 0.0), vec2(0.5 * dw, dh), fw);
        float dfm = bRect(qd, vec2(-0.5 * dw - 0.18, 0.0), vec2(0.5 * dw + 0.18, dh + 0.18), fw) - dm;
        // X brace on each leaf
        vec2 ql = vec2(abs(qd.x) / (0.5 * dw), qd.y / dh);
        float xb = dm * max(bIn(ql.x - ql.y, -0.05, 0.05, fw.x * 2.0 / dw), bIn(ql.x + ql.y - 1.0, -0.05, 0.05, fw.x * 2.0 / dw));
        float mid = dm * max(bIn(qd.x, -0.07, 0.07, fw.x), bIn(qd.y, dh * 0.5 - 0.07, dh * 0.5 + 0.07, fw.y));
        o.alb = mix(o.alb, trimC, max(max(dfm, xb), mid));
        o.ao *= 1.0 - 0.15 * dm;
        // hayloft door in the gable
        if (front && Hr > 3.0) {
          vec2 qh = vec2(u - 0.5 * len, v - Hw - 0.3);
          float hm = bRect(qh, vec2(-0.85, 0.0), vec2(0.85, 1.7), fw);
          float hf = bRect(qh, vec2(-1.0, -0.15), vec2(1.0, 1.85), fw) - hm;
          o.alb = mix(o.alb, o.alb * 0.8, hm);
          o.alb = mix(o.alb, trimC, hf);
        }
      } else if (eaveWall && r3 > 0.3) {
        // small four-pane windows along the long sides
        float cell = 3.6;
        float bi = floor(u / cell);
        vec2 qw = vec2(u - (bi + 0.5) * cell, vf - 1.6);
        float inside = step(1.0, bi) * step(bi, floor(len / cell) - 2.0);
        float wm = inside * bRect(qw, vec2(-0.4, 0.0), vec2(0.4, 0.8), fw);
        float wf = inside * bRect(qw, vec2(-0.52, -0.12), vec2(0.52, 0.92), fw) - wm;
        o.alb = mix(o.alb, trimC, wf);
        bGlass(o, wm * (1.0 - max(bIn(qw.x, -0.03, 0.03, fw.x), bIn(qw.y, 0.37, 0.43, fw.y))), qw, 0.8, 0.8, bh3(vec3(bi, 1.0, rnd)), night * 0.15, false);
      }
      o.alb = mix(o.alb, trimC, trim);
      o.rough = 0.92;
    } else if (style == BS_CHURCH) {
      // ashlar stone
      float course = floor(v / 0.38);
      float blen = 0.55 + 0.35 * bh1(course + rnd * 7.0);
      float bu = u / blen + course * 0.37;
      float bv = bh2(vec2(floor(bu), course) + rnd * 13.0);
      float det = 1.0 - smoothstep(0.03, 0.09, max(fw.x, fw.y));
      float mortar = max(bLines(v, 0.38, 0.025, fw.y), bLines(bu * blen, blen, 0.025, fw.x));
      o.alb *= mix(1.0, (0.84 + 0.3 * bv) * (1.0 - 0.3 * mortar), det);
      o.alb *= 0.92 + 0.12 * bFbm(vec2(u, v) * 0.3 + rnd * 9.0);
      o.rough = 0.93;
      bool steeple = bHas(flags, BG_STEEPLE);
      // corner quoins
      float quoin = max(bIn(u, 0.0, 0.45, fw.x), bIn(u, len - 0.45, len, fw.x)) * step(0.5, fract(course * 0.5));
      o.alb = mix(o.alb, o.alb * 1.12 + 0.02, quoin * det);
      if (steeple) {
        // belfry louvres, clock, slit windows, door
        float bw = min(0.9, 0.18 * len);
        float nOpen = 2.0;
        float cellW = len / nOpen;
        float bi = floor(u / cellW);
        vec2 qb = vec2(u - (bi + 0.5) * cellW, v - (Hw - 4.4));
        float hs = 2.6;
        float inArch = qb.y < hs ? bIn(qb.x, -0.5 * bw, 0.5 * bw, fw.x) * bIn(qb.y, 0.0, hs, fw.y) : 1.0 - smoothstep(0.5 * bw - fw.x, 0.5 * bw + fw.x, length(vec2(qb.x, qb.y - hs)));
        inArch *= step(0.0, qb.y);
        float louvre = 1.0 - 0.6 * bLines(qb.y, 0.22, 0.08, fw.y);
        o.alb = mix(o.alb, vec3(0.025) * louvre + 0.02, inArch);
        o.ao *= 1.0 - 0.3 * inArch;
        // clock
        vec2 qc = vec2(u - 0.5 * len, v - (Hw - 6.6));
        float cr = min(1.05, 0.21 * len);
        float cd = length(qc);
        float dial = 1.0 - smoothstep(cr - fw.x, cr + fw.x, cd);
        float ring = dial * smoothstep(cr * 0.82 - fw.x, cr * 0.82 + fw.x, cd);
        float ang = atan(qc.x, qc.y);
        float hand1 = dial * bIn(abs(ang - 0.52), 0.0, 0.08, fw.x / max(cd, 0.05)) * step(cd, cr * 0.55);
        float hand2 = dial * bIn(abs(ang + 1.05), 0.0, 0.06, fw.x / max(cd, 0.05)) * step(cd, cr * 0.8);
        o.alb = mix(o.alb, vec3(0.8, 0.78, 0.72), dial);
        o.alb = mix(o.alb, vec3(0.03), max(ring * 0.9, max(hand1, hand2)));
        // slits
        vec2 qs = vec2(u - 0.5 * len, fract((v - g0) / 4.5) * 4.5 - 2.0);
        float slit = bRect(qs, vec2(-0.14, 0.0), vec2(0.14, 1.1), fw) * step(g0 + 3.5, v) * step(v, Hw - 8.2);
        o.alb = mix(o.alb, vec3(0.02), slit);
        if (front) {
          vec2 qd = vec2(u - 0.5 * len, vf);
          float dm = qd.y < 2.2 ? bRect(qd, vec2(-0.75, 0.0), vec2(0.75, 2.2), fw) : 1.0 - smoothstep(0.75 - fw.x, 0.75 + fw.x, length(vec2(qd.x, qd.y - 2.2)));
          o.alb = mix(o.alb, vec3(0.1, 0.05, 0.025), dm * step(0.0, qd.y));
        }
      } else if (eaveWall) {
        // lancet windows along the nave
        float cellW = 4.2;
        float nb = max(1.0, floor((len - 2.0) / cellW));
        float cell = (len - 2.0) / nb;
        float bi = clamp(floor((u - 1.0) / cell), 0.0, nb - 1.0);
        vec2 q = vec2(u - 1.0 - (bi + 0.5) * cell, v - g0 - 1.9);
        float w = 1.15;
        float hs = min(0.52 * (Hw - g0), 4.6) - 0.8 * w;
        float c0 = 0.25 * w;
        float r = 0.75 * w;
        float d = max(length(vec2(q.x - c0, q.y - hs)), length(vec2(q.x + c0, q.y - hs)));
        float lancet = q.y < hs ? bIn(q.x, -0.5 * w, 0.5 * w, fw.x) : 1.0 - smoothstep(r - fw.x, r + fw.x, d);
        lancet *= step(0.0, q.y);
        float lead = max(bLines(q.x + 0.15, 0.3, 0.03, fw.x), bLines(q.y, 0.35, 0.03, fw.y));
        vec3 stained = mix(vec3(0.02, 0.03, 0.09), vec3(0.09, 0.02, 0.02), step(0.5, bh2(floor(q / 0.3) + bi)));
        o.alb = mix(o.alb, mix(stained, vec3(0.02), lead * 0.7), lancet);
        o.rough = mix(o.rough, 0.1, lancet);
        o.emit += mix(vec3(0.5, 0.35, 0.8), B_WARM, step(0.5, bh2(floor(q / 0.3) + bi + 3.0))) * lancet * night * 0.5 * (1.0 - lead);
        o.ao *= 1.0 - 0.2 * lancet;
      } else if (v > Hw && Hr > 3.0) {
        // rose window in the gable
        vec2 qr = vec2(u - 0.5 * len, v - Hw - 0.33 * Hr);
        float rr = min(1.6, 0.13 * len);
        float rd = length(qr);
        float rose = 1.0 - smoothstep(rr - fw.x, rr + fw.x, rd);
        float spokes = rose * bIn(fract(atan(qr.y, qr.x) / 0.5236), 0.44, 0.56, 0.05) * step(rr * 0.3, rd);
        float rim = rose * smoothstep(rr * 0.82, rr * 0.9, rd);
        o.alb = mix(o.alb, vec3(0.03, 0.03, 0.08), rose);
        o.alb = mix(o.alb, wallC * 0.9, max(spokes, rim));
        o.emit += B_WARM * rose * night * 0.4;
      } else if (front && v < Hw) {
        vec2 qd = vec2(u - 0.5 * len, vf);
        float dm = qd.y < 2.6 ? bRect(qd, vec2(-0.95, 0.0), vec2(0.95, 2.6), fw) : 1.0 - smoothstep(0.95 - fw.x, 0.95 + fw.x, length(vec2(qd.x, qd.y - 2.6)));
        o.alb = mix(o.alb, vec3(0.1, 0.05, 0.025), dm * step(0.0, qd.y));
      }
    } else if (style == BS_SILO || style == BS_TANK) {
      bool cone = bHas(flags, BG_CONE);
      bool blue = wallS.b > wallS.r * 1.5;
      if (style == BS_TANK && W > 8.0) {
        // storage tank: welded steel courses, a spiral stair, faint streaks
        o.alb *= 1.0 - 0.1 * bLines(v, 2.4, 0.05, fw.y);
        float stair = bIn(fract((u + v * 1.2) / len) * len, 0.0, 1.0, fw.x) * step(0.4, v);
        o.alb = mix(o.alb, vec3(0.18), stair * 0.8);
        o.alb *= 0.93 + 0.1 * bNoise(vec2(u * 0.5, v * 0.05) + rnd * 3.0);
        o.rough = 0.55;
        o.metal = 0.15;
      } else if (style == BS_TANK) {
        o.alb *= 1.0 - 0.3 * bLines(u, 0.14, 0.02, fw.x);
        o.alb = mix(o.alb, vec3(0.08), bLines(v, 0.7, 0.05, fw.y));
        o.rough = 0.9;
      } else if (blue) {
        // glass-fused steel silo
        o.rough = 0.3;
        o.metal = 0.15;
        o.alb = mix(o.alb, vec3(0.7, 0.7, 0.68), bIn(v, Hw - 1.4, Hw - 0.4, fw.y));
      } else if (cone) {
        // corrugated galvanised bin + stiffeners
        float corr = 0.5 + 0.5 * cos(6.2831 * v / 0.35);
        o.alb *= mix(1.0, 0.88 + 0.16 * corr, 1.0 - smoothstep(0.05, 0.15, fw.y));
        o.alb *= 1.0 - 0.12 * bLines(u, 1.3, 0.1, fw.x);
        o.rough = 0.38;
        o.metal = 0.65;
        float door = bRect(vec2(u - 0.5 * len, vf), vec2(-0.6, 0.2), vec2(0.6, 1.9), fw);
        o.alb = mix(o.alb, vec3(0.3), door);
      } else {
        // concrete stave silo with steel hoops
        o.alb *= 1.0 - 0.28 * bLines(v, 0.75, 0.035, fw.y);
        o.alb *= 1.0 - 0.07 * bLines(u, 0.3, 0.02, fw.x);
        o.alb *= 0.9 + 0.12 * bFbm(vec2(u * 0.4, v * 0.1) + rnd * 5.0);
        o.rough = 0.9;
      }
      // the chute / ladder on one side
      float chute = bIn(u, len * fract(rnd * 3.7), len * fract(rnd * 3.7) + 0.55, fw.x) * step(1.0, v);
      o.alb = mix(o.alb, vec3(0.2, 0.2, 0.19), chute * 0.8);
      o.ao *= 1.0 - 0.3 * chute;
    } else if (style == BS_HVAC) {
      o.alb = mix(wallC, vec3(0.45), 0.3) * (1.0 - 0.3 * bLines(v, 0.12, 0.04, fw.y) * step(0.25, v) * step(v, Hw - 0.2));
      o.rough = 0.5;
      o.metal = 0.35;
    } else if (style == BS_MAST) {
      o.alb = mod(floor(v / 3.0), 2.0) < 0.5 ? vec3(0.55, 0.04, 0.02) : vec3(0.8);
      o.rough = 0.6;
    } else if (style == BS_PLAIN) {
      o.alb *= 1.0 - 0.35 * bIn(u, 0.8, 2.6, fw.x) * bIn(v, 0.6, Hw - 1.2, fw.y) * (1.0 - bLines(v, 0.15, 0.05, fw.y));
      o.rough = 0.85;
    }
  }
  // ───────────────────────── roofs ─────────────────────────
  else if (face >= BF_ROOF_PZ && face <= BF_ROOF_NX || face == BF_DORMER_ROOF || face == BF_SILO_ROOF || face == BF_CUPOLA_ROOF || face == BF_DORMER_SIDE) {
    float along;
    float down;
    float sec = sqrt(1.0 + pow(Hr / max(0.5 * D, 0.1), 2.0));
    if (face == BF_ROOF_PZ || face == BF_ROOF_NZ) { along = L.x; down = abs(L.z) * sec; }
    else if (face == BF_ROOF_PX || face == BF_ROOF_NX) { along = L.z; down = max(abs(L.x) - 0.5 * ridge * W, 0.0) * sec; }
    else if (face == BF_SILO_ROOF) { along = atan(L.z, L.x) * 0.5 * W; down = (Hw + Hr - L.y) * 1.6; }
    else { along = L.z; down = L.x + L.y; }
    vec2 fw = max(vec2(fwidth(along), fwidth(down)), vec2(1e-4));
    if (face == BF_SILO_ROOF) fw.x = max(0.5 * W * min(fwidth(atan(L.z, L.x)), fwidth(atan(-L.z, -L.x))), 1e-4);
    float det = 1.0 - smoothstep(0.05, 0.16, max(fw.x, fw.y));
    vec3 c = roofC;
    bool metalRoof = style == BS_INDUSTRIAL || style == BS_SHED || style == BS_SILO || style == BS_TANK || face == BF_CUPOLA_ROOF || face == BF_SILO_ROOF || bHas(flags, BG_METALROOF);
    bool copper = roofS.g > roofS.r * 1.15;
    bool terracotta = roofS.r > roofS.g * 1.35 && roofS.r > 0.35;
    bool slate = !terracotta && abs(roofS.r - roofS.b) < 0.08 && roofS.r < 0.42;
    if (style == BS_BARN && !terracotta && !slate) metalRoof = true;
    float n = bFbm(vec2(along, down) * 0.35 + rnd * 17.0);
    if (metalRoof || copper) {
      float seam = bLines(along, 0.6, 0.06, fw.x);
      o.alb = c * (1.0 - 0.18 * seam * det) * (0.9 + 0.15 * n);
      o.rough = copper ? 0.55 : 0.35 + 0.2 * n;
      o.metal = copper ? 0.3 : 0.6;
      if (copper) o.alb = mix(o.alb, vec3(0.2, 0.36, 0.3), 0.4 * smoothstep(0.3, 0.8, n));
      else o.alb = mix(o.alb, vec3(0.2, 0.09, 0.04), 0.35 * smoothstep(0.62, 0.9, n) * step(0.6, r2));
    } else if (terracotta) {
      float rowH = 0.33;
      float row = floor(down / rowH);
      float fr = fract(down / rowH);
      float a2 = along / 0.26 + row * 0.5;
      float tv = bh2(vec2(row, floor(a2)) + rnd * 37.0);
      float shade = mix(0.68, 1.0, smoothstep(0.0, 0.3, fr)) * (0.86 + 0.14 * sin(fract(a2) * 6.2831));
      o.alb = c * mix(0.9, (0.85 + 0.3 * tv) * shade, det);
      o.rough = 0.75;
    } else if (slate) {
      float rowH = 0.22;
      float row = floor(down / rowH);
      float fr = fract(down / rowH);
      float a2 = along / 0.36 + row * 0.5;
      float tv = bh2(vec2(row, floor(a2)) + rnd * 37.0);
      float shade = mix(0.72, 1.0, smoothstep(0.0, 0.2, fr)) * (1.0 - 0.3 * bLines(a2 * 0.36, 0.36, 0.02, fw.x));
      o.alb = c * mix(0.92, (0.88 + 0.22 * tv) * shade, det);
      o.rough = 0.5 + 0.15 * tv;
    } else {
      // asphalt shingles
      float rowH = 0.145;
      float row = floor(down / rowH);
      float fr = fract(down / rowH);
      float a2 = along / 0.33 + row * 0.5;
      float tv = bh2(vec2(row, floor(a2)) + rnd * 37.0);
      float shade = mix(0.7, 1.0, smoothstep(0.0, 0.25, fr));
      o.alb = c * mix(0.92, (0.85 + 0.25 * tv) * shade, det) * (0.9 + 0.2 * bNoise(vec2(along, down) * 6.0));
      o.rough = 0.92;
    }
    // skylights on some house roofs
    if (style == BS_HOUSE && (face == BF_ROOF_PZ || face == BF_ROOF_NZ) && bh1(rnd * 61.7 + float(face)) < 0.16) {
      float sx = (bh1(rnd * 7.3 + float(face)) - 0.5) * max(W - 3.0, 0.0);
      float sk = bRect(vec2(along - sx, down - 0.25 * D * sec), vec2(-0.45, -0.6), vec2(0.45, 0.6), fw);
      o.alb = mix(o.alb, vec3(0.03, 0.035, 0.04), sk);
      o.rough = mix(o.rough, 0.05, sk);
      o.metal = mix(o.metal, 0.8, sk);
    }
    // solar panels on the sunnier slope (+z world is south; roofPZ faces (sin h, −cos h))
    if (bHas(flags, BG_SOLAR) && (face == BF_ROOF_PZ || face == BF_ROOF_NZ)) {
      float southPZ = -cos(vBldH);
      bool sunny = face == BF_ROOF_PZ ? southPZ > -0.15 : southPZ < 0.15;
      float runL = 0.5 * D * sec;
      float halfA = 0.5 * W * (0.45 + 0.35 * r3);
      float pm = sunny ? bIn(along, -halfA, halfA, fw.x) * bIn(down, 0.6, runL - 0.7, fw.y) : 0.0;
      float grid = max(bLines(along + halfA, 1.05, 0.05, fw.x), bLines(down, 1.7, 0.05, fw.y));
      o.alb = mix(o.alb, mix(vec3(0.015, 0.02, 0.04), vec3(0.4), grid * 0.6), pm);
      o.rough = mix(o.rough, 0.12, pm);
      o.metal = mix(o.metal, 0.6, pm);
    }
    // age: old roofs fade toward grey
    float age = bh1(rnd * 3.1 + 0.7);
    o.alb = mix(o.alb, vec3(dot(o.alb, vec3(0.3, 0.5, 0.2))), 0.3 * age * (metalRoof ? 0.5 : 1.0));
    // weathering: moss / dirt patches, darker toward the eaves, ridge caps
    float moss = smoothstep(0.55, 0.85, n) * (metalRoof ? 0.3 : 0.6);
    o.alb = mix(o.alb, o.alb * vec3(0.55, 0.6, 0.45), moss * 0.5);
    if (face >= BF_ROOF_PZ && face <= BF_ROOF_NX) {
      float runL = 0.5 * D * sec;
      o.alb *= 1.0 - 0.18 * smoothstep(0.55, 1.0, down / max(runL, 0.1));
      float cap = 1.0 - smoothstep(0.16 - fw.y, 0.16 + fw.y, down);
      o.alb = mix(o.alb, o.alb * 0.8, cap);
    }
    if (face == BF_DORMER_SIDE) {
      o.alb = mix(wallC, roofC, 0.5) * 0.85;
      o.rough = 0.8;
    }
  }
  // ───────────────────────── flat roofs, coping ─────────────────────────
  else if (face == BF_ROOF_FLAT || face == BF_PARAPET_TOP || face == BF_PARAPET_IN) {
    vec2 p = L.xz;
    vec2 fw = max(vec2(fwidth(p.x), fwidth(p.y)), vec2(1e-4));
    if (face == BF_ROOF_FLAT) {
      bool white = bHas(flags, BG_WHITEROOF);
      vec3 c = white ? vec3(0.62, 0.62, 0.6) : roofC;
      float n = bFbm(p * 0.25 + rnd * 23.0);
      float gravel = bNoise(p * 9.0);
      o.alb = c * (0.82 + 0.3 * n) * (0.94 + 0.12 * gravel * (1.0 - smoothstep(0.05, 0.1, fw.x)));
      o.alb *= 1.0 - 0.12 * bLines(p.x, 1.0, 0.04, fw.x) * step(0.5, r2);
      o.alb = mix(o.alb, o.alb * 0.6, smoothstep(0.62, 0.8, bFbm(p * 0.12 + rnd * 3.0)) * 0.6);
      o.rough = white ? 0.7 : 0.92;
      // skylight rows on industrial roofs
      if ((style == BS_INDUSTRIAL || style == BS_SHED) && W > 14.0) {
        float sk = bIn(fract(p.x / 6.0) * 6.0, 2.6, 3.4, fw.x) * bIn(abs(p.y), 0.0, 0.5 * D - 2.0, fw.y);
        o.alb = mix(o.alb, vec3(0.5, 0.53, 0.52), sk);
        o.rough = mix(o.rough, 0.3, sk);
        o.metal = mix(o.metal, 0.2, sk);
      }
      // solar arrays in rows on some flat roofs
      if (bHas(flags, BG_SOLAR)) {
        float inside = bIn(p.x, -0.5 * W + 2.0, 0.5 * W - 2.0, fw.x) * bIn(p.y, -0.5 * D + 2.0, 0.5 * D - 2.0, fw.y);
        float pm = inside * bIn(fract(p.y / 2.6) * 2.6, 0.25, 1.95, fw.y);
        o.alb = mix(o.alb, vec3(0.02, 0.025, 0.05) * (1.0 + 4.0 * bLines(p.x, 1.0, 0.04, fw.x)), pm);
        o.rough = mix(o.rough, 0.15, pm);
        o.metal = mix(o.metal, 0.5, pm);
      }
      // rooftop unit tops: fans
      if (style == BS_HVAC) {
        o.alb = mix(wallC, vec3(0.45), 0.3);
        vec2 qf = vec2(abs(p.x) - 0.25 * W, p.y);
        float fan = 1.0 - smoothstep(0.42 * min(D, 0.5 * W) - fw.x, 0.42 * min(D, 0.5 * W) + fw.x, length(qf));
        o.alb = mix(o.alb, vec3(0.03), fan * 0.9);
        o.metal = 0.35;
        o.rough = 0.5;
      }
      // AO along the parapet
      float edge = min(0.5 * W - abs(p.x), 0.5 * D - abs(p.y));
      o.ao *= mix(0.55, 1.0, smoothstep(0.3, 0.3 + max(Hr, 0.2) * 1.2, edge));
    } else if (face == BF_PARAPET_TOP) {
      o.alb = mix(wallC, vec3(0.55, 0.54, 0.52), 0.6);
      o.rough = 0.8;
    } else {
      o.alb = wallC * 0.8;
      o.ao *= 0.8;
    }
  }
  // ───────────────────────── trims and details ─────────────────────────
  else if (face == BF_SOFFIT) {
    o.alb = mix(wallC, vec3(0.75, 0.74, 0.7), 0.5);
    o.ao *= 0.55;
  } else if (face == BF_FASCIA) {
    float t = bh1(rnd * 4.4);
    o.alb = style == BS_BARN ? vec3(0.78, 0.77, 0.73) : t < 0.55 ? vec3(0.82, 0.82, 0.8) : t < 0.8 ? vec3(0.12, 0.09, 0.07) : roofC * 0.7;
    o.rough = 0.6;
  } else if (face == BF_CHIMNEY) {
    vec2 q = vec2(L.x + L.z, L.y);
    vec2 fw = vec2(fwidth(q.x), fwidth(q.y));
    bool brick = r3 < 0.6;
    vec3 c = brick ? vec3(0.3, 0.1, 0.06) : wallC * 0.85;
    o.alb = c * (1.0 - 0.25 * bLines(q.y, 0.075, 0.012, fw.y)) * (0.85 + 0.2 * bNoise(q * 4.0));
    o.alb *= 1.0 - 0.3 * smoothstep(Hw + Hr, Hw + Hr + 0.7, L.y) * 0.5;
  } else if (face == BF_CHIMNEY_TOP) {
    o.alb = vec3(0.04);
  } else if (face == BF_DORMER_FRONT) {
    // the dormer front: one window centred, white frame
    float cx = (L.x > 0.0 ? 0.22 : -0.22) * W;
    vec2 qd = vec2(L.x - cx, L.y - (Hw + 0.44 * Hr + 0.2));
    vec2 fw = vec2(fwidth(qd.x), fwidth(qd.y));
    float wm = bRect(qd, vec2(-0.5, 0.05), vec2(0.5, 1.05), fw);
    float fm = bRect(qd, vec2(-0.62, -0.05), vec2(0.62, 1.15), fw) - wm;
    o.alb = mix(wallC, vec3(0.85, 0.84, 0.8), 0.5);
    o.alb = mix(o.alb, vec3(0.88), fm);
    bGlass(o, wm, qd - vec2(0.0, 0.05), 1.0, 1.0, bh1(rnd * 8.8 + cx), night * 0.35, false);
  } else if (face == BF_AWNING || face == BF_AWNING_UNDER) {
    // canvas awning: solid or striped
    float sc = bh1(rnd * 23.7);
    vec3 cA = sc < 0.18 ? vec3(0.06, 0.2, 0.08) : sc < 0.34 ? vec3(0.35, 0.03, 0.03) : sc < 0.5 ? vec3(0.03, 0.06, 0.18) : sc < 0.62 ? vec3(0.02) : sc < 0.76 ? vec3(0.28, 0.1, 0.03) : sc < 0.88 ? vec3(0.45, 0.35, 0.18) : vec3(0.02, 0.18, 0.2);
    float st = step(0.45, bh1(rnd * 3.9)) * bLines(L.x, 0.5, 0.25, max(fwidth(L.x), 1e-4));
    o.alb = mix(cA, vec3(0.72, 0.7, 0.65), st);
    o.rough = 0.8;
    if (face == BF_AWNING_UNDER) {
      o.alb *= 0.6;
      o.ao *= 0.55;
    }
  } else if (face == BF_TRUNK) {
    o.alb = vec3(0.07, 0.055, 0.04);
    o.rough = 0.95;
  } else if (face == BF_CUPOLA) {
    vec2 q = vec2(L.x + L.z, L.y);
    vec2 fw = vec2(fwidth(q.x), fwidth(q.y));
    o.alb = vec3(0.78, 0.77, 0.73) * (1.0 - 0.5 * bLines(q.y, 0.15, 0.05, fw.y) * bIn(q.y, Hw + Hr + 0.4, Hw + Hr + 1.3, fw.y));
  }
  return o;
}
`;

/** Replaces #include <color_fragment>. */
export const BLD_FRAG_COLOR = `
  BFac bld = bldShade();
  diffuseColor.rgb = bld.alb;
  bldRough = bld.rough;
  bldMetal = bld.metal;
  bldEmit = bld.emit;
  bldAO = bld.ao;
`;

/** Replaces #include <clipping_planes_fragment> (mid LOD dithered fade). */
export const BLD_FRAG_DITHER = `
#include <clipping_planes_fragment>
  if (vBldF.y < 0.999 && bIGN(gl_FragCoord.xy) >= vBldF.y) discard;
`;
/** Near LOD: trees fading out keep exactly the pixels the mid blob leaves (complementary dither). */
export const BLD_FRAG_DITHER_NEAR = `
#include <clipping_planes_fragment>
  if (vBldF.y < 0.999 && bIGN(gl_FragCoord.xy) < 1.0 - vBldF.y) discard;
`;
