/**
 * Airfield signs (FAA AC 150/5340-18) and building signage from one canvas
 * atlas: red mandatory holding-position signs ("36-18") at every hold line
 * with the taxiway location sign on the back, black/white runway distance-
 * remaining signs, the FBO name on the terminal fascia and the self-serve
 * fuel placard. One mesh, one draw call; the faces are lit at night.
 */
import * as THREE from 'three';
import { MeshBuilder } from './builder';
import { toWorld, type AirportPlan } from './plan';
import { runwayDesignator } from './markings';
import type { HeightFn } from './ground';

type Style = 'mandatory' | 'location' | 'distance' | 'fbo' | 'fuel' | 'blank';
interface Face {
  text: string;
  style: Style;
  /** Atlas cell (x, y, w, h) in 0..1 UV. */
  uv: [number, number, number, number];
}

const ATLAS_W = 1024;
const ATLAS_H = 512;
const CELL_H = 64;

export interface SignsBuild {
  geometry: THREE.BufferGeometry;
  material: THREE.MeshStandardMaterial;
  texture: THREE.Texture | null;
  faces: Face[];
}

const FT = 0.3048;

function drawFace(g: CanvasRenderingContext2D, f: Face) {
  const x = f.uv[0] * ATLAS_W, y = (1 - f.uv[1] - f.uv[3]) * ATLAS_H, w = f.uv[2] * ATLAS_W, h = f.uv[3] * ATLAS_H;
  const font = (px: number) => `bold ${px}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
  g.save();
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  switch (f.style) {
    case 'mandatory': {
      g.fillStyle = '#b3120f';
      g.fillRect(x, y, w, h);
      g.font = font(h * 0.62);
      g.lineWidth = h * 0.07;
      g.strokeStyle = '#000';
      g.strokeText(f.text, x + w / 2, y + h * 0.54);
      g.fillStyle = '#f4f4f0';
      g.fillText(f.text, x + w / 2, y + h * 0.54);
      break;
    }
    case 'location': {
      g.fillStyle = '#0c0c0c';
      g.fillRect(x, y, w, h);
      g.strokeStyle = '#e8b21e';
      g.lineWidth = h * 0.06;
      g.strokeRect(x + h * 0.12, y + h * 0.12, w - h * 0.24, h - h * 0.24);
      g.fillStyle = '#e8b21e';
      g.font = font(h * 0.56);
      g.fillText(f.text, x + w / 2, y + h * 0.54);
      break;
    }
    case 'distance': {
      g.fillStyle = '#0c0c0c';
      g.fillRect(x, y, w, h);
      g.fillStyle = '#f2f2ee';
      g.font = font(h * 0.72);
      g.fillText(f.text, x + w / 2, y + h * 0.55);
      break;
    }
    case 'fbo': {
      const grd = g.createLinearGradient(x, y, x, y + h);
      grd.addColorStop(0, '#1d3a5f');
      grd.addColorStop(1, '#152c49');
      g.fillStyle = grd;
      g.fillRect(x, y, w, h);
      g.fillStyle = '#f3f1ea';
      g.font = font(h * 0.5);
      g.fillText(f.text, x + w / 2, y + h * 0.55);
      break;
    }
    case 'fuel': {
      g.fillStyle = '#f3f1ea';
      g.fillRect(x, y, w, h);
      g.fillStyle = '#1f4f9a';
      g.fillRect(x, y, w, h * 0.5);
      g.fillStyle = '#ffffff';
      g.font = font(h * 0.36);
      g.fillText(f.text.split('|')[0], x + w / 2, y + h * 0.27);
      g.fillStyle = '#1f4f9a';
      g.font = font(h * 0.26);
      g.fillText(f.text.split('|')[1] ?? '', x + w / 2, y + h * 0.76);
      break;
    }
    default:
      g.fillStyle = '#6d7174';
      g.fillRect(x, y, w, h);
  }
  g.restore();
}

export function buildSigns(plan: AirportPlan, heightAt: HeightFn): SignsBuild {
  const d36 = runwayDesignator(plan.rw.headingDeg);
  const d18 = runwayDesignator(plan.rw.headingDeg + 180);
  const faces: Face[] = [];
  let cx = 0, cy = 0;
  const face = (text: string, style: Style, cells = 1, rows = 1): Face => {
    const wpx = Math.round(CELL_H * (style === 'fbo' ? 10 : style === 'fuel' ? 2 : Math.max(1.4, text.length * 0.62 + 0.4)) * cells);
    const hpx = CELL_H * rows;
    if (cx + wpx > ATLAS_W) {
      cx = 0;
      cy += CELL_H * 2;
    }
    const f: Face = { text, style, uv: [cx / ATLAS_W, 1 - (cy + hpx) / ATLAS_H, wpx / ATLAS_W, hpx / ATLAS_H] };
    cx += wpx + 4;
    faces.push(f);
    return f;
  };
  const blank = face('', 'blank');
  const b = new MeshBuilder();
  b.set({ color: 0xffffff, mat: 0 });

  /** Panel of width w (m), height h, on legs, front facing local −Z; front/back faces textured. */
  const panel = (x: number, z: number, headingDeg: number, w: number, h: number, bottom: number, fFront: Face, fBack: Face | null, depth = 0.22, legs = true) => {
    const g = heightAt(x, z);
    b.pushTR(x, g, z, (-headingDeg * Math.PI) / 180);
    const y0 = bottom, y1 = bottom + h;
    const quad = (pts: [number, number, number][], n: [number, number, number], f: Face, flipU = false) => {
      const [u0, v0, uw, vh] = f.uv;
      const uvs: [number, number][] = [
        [flipU ? u0 + uw : u0, v0],
        [flipU ? u0 : u0 + uw, v0],
        [flipU ? u0 : u0 + uw, v0 + vh],
        [flipU ? u0 + uw : u0, v0 + vh],
      ];
      const ids = pts.map((p, i) => b.v(p[0], p[1], p[2], n[0], n[1], n[2], uvs[i][0], uvs[i][1]));
      b.quad(ids[0], ids[1], ids[2], ids[3]);
    };
    const hw = w / 2, hd = depth / 2;
    quad([[-hw, y0, -hd], [hw, y0, -hd], [hw, y1, -hd], [-hw, y1, -hd]], [0, 0, -1], fFront, true);
    quad([[hw, y0, hd], [-hw, y0, hd], [-hw, y1, hd], [hw, y1, hd]], [0, 0, 1], fBack ?? blank, true);
    quad([[-hw, y1, -hd], [hw, y1, -hd], [hw, y1, hd], [-hw, y1, hd]], [0, 1, 0], blank);
    quad([[-hw, y0, hd], [-hw, y0, -hd], [-hw, y1, -hd], [-hw, y1, hd]], [-1, 0, 0], blank);
    quad([[hw, y0, -hd], [hw, y0, hd], [hw, y1, hd], [hw, y1, -hd]], [1, 0, 0], blank);
    quad([[-hw, y0, hd], [hw, y0, hd], [hw, y0, -hd], [-hw, y0, -hd]], [0, -1, 0], blank);
    if (legs && bottom > 0.05) {
      // two legs
      for (const lx of [-hw * 0.6, hw * 0.6]) {
        const lw = 0.05;
        quad([[lx - lw, 0, -lw], [lx + lw, 0, -lw], [lx + lw, y0, -lw], [lx - lw, y0, -lw]], [0, 0, -1], blank);
        quad([[lx + lw, 0, lw], [lx - lw, 0, lw], [lx - lw, y0, lw], [lx + lw, y0, lw]], [0, 0, 1], blank);
        quad([[lx - lw, 0, lw], [lx - lw, 0, -lw], [lx - lw, y0, -lw], [lx - lw, y0, lw]], [-1, 0, 0], blank);
        quad([[lx + lw, 0, -lw], [lx + lw, 0, lw], [lx + lw, y0, lw], [lx + lw, y0, -lw]], [1, 0, 0], blank);
      }
    }
    b.pop();
  };

  // holding-position signs on the pilot's left at each hold line, location sign on the back
  const rwyText = `${d36}-${d18}`;
  const mandatory = face(rwyText, 'mandatory');
  const side = plan.holdLines[0]?.side ?? 1;
  const towardRunway = side > 0 ? (plan.rw.headingDeg + 270) % 360 : (plan.rw.headingDeg + 90) % 360;
  const faceHolding = (towardRunway + 180) % 360; // the sign front faces the pilot coming from the taxiway
  for (const h of plan.holdLines) {
    // pilot heading toward the runway: their left is toward −a when the taxiway is on the +c side
    const leftA = side > 0 ? h.a - h.halfWidth - 4.5 : h.a + h.halfWidth + 4.5;
    const p = toWorld(plan, leftA, h.c + side * 0.5);
    const loc = face(h.name, 'location');
    panel(p.x, p.z, faceHolding, 0.9 + rwyText.length * 0.36, 0.76, 0.32, mandatory, loc);
  }
  // runway distance remaining (thousands of feet), west side: front for 36 departures, back for 18
  const L = plan.rw.length;
  const lft = L / FT;
  for (let k = 1; k * 1000 < lft; k++) {
    const a = L - k * 1000 * FT;
    const back = Math.floor(a / FT / 1000);
    if (back < 1) continue;
    const p = toWorld(plan, a, -(plan.rw.halfWidth + 16));
    panel(p.x, p.z, (plan.rw.headingDeg + 180) % 360, 1.2, 1.0, 0.35, face(String(k), 'distance'), face(String(back), 'distance'));
  }
  // FBO sign on the terminal's airside fascia
  const t = plan.terminal;
  const th = (t.headingDeg * Math.PI) / 180;
  const off = t.depth / 2 + 0.2;
  const fbo = face(`${plan.layout.name.toUpperCase()}  ·  ${plan.layout.icao}`, 'fbo');
  {
    const x = t.center.x + Math.sin(th) * off, z = t.center.z - Math.cos(th) * off;
    const g0 = heightAt(t.center.x, t.center.z);
    const g = heightAt(x, z);
    panel(x, z, t.headingDeg, 13, 0.62, g0 - g + t.height - 0.72, fbo, null, 0.06, false);
  }
  // self-serve fuel placard on a post by the pump
  const fp = plan.fuelPump;
  const fh = (plan.fuel.headingDeg * Math.PI) / 180;
  const fuel = face('100LL|SELF SERVE', 'fuel');
  panel(fp.x + Math.cos(fh) * 2.3, fp.z + Math.sin(fh) * 2.3, plan.fuel.headingDeg, 1.1, 0.55, 1.5, fuel, null, 0.05);

  const g = b.toGeometry(['uv']);
  const uv = g.getAttribute('aUvM');
  g.deleteAttribute('aUvM');
  g.setAttribute('uv', uv);

  let texture: THREE.Texture | null = null;
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = ATLAS_W;
    canvas.height = ATLAS_H;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = '#6d7174';
      ctx.fillRect(0, 0, ATLAS_W, ATLAS_H);
      for (const f of faces) drawFace(ctx, f);
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      tex.generateMipmaps = true;
      tex.minFilter = THREE.LinearMipmapLinearFilter;
      texture = tex;
    }
  }
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    map: texture,
    emissive: texture ? 0xffffff : 0x000000,
    emissiveMap: texture,
    emissiveIntensity: 0.05,
    roughness: 0.55,
    metalness: 0,
  });
  material.name = 'airport-signs';
  return { geometry: g, material, texture, faces };
}
