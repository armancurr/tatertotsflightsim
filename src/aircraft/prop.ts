/**
 * Two-blade constant-speed propeller: twisted, tapered blades lofted from
 * cambered sections (aluminium front, flat-black back, red/white/red tips),
 * the spinner, and the translucent blur disc that takes over at speed.
 * Rotation is clockwise seen from the cockpit (Lycoming), i.e. negative about +Z.
 */
import * as THREE from 'three';
import { CONFIG } from '../config';
import { loftGeometry } from './loft';
import { nacaRing } from './airfoil';
import { merge, tint, type AircraftMaterials } from './materials';

const G = CONFIG.aircraft.geometry;

export const PROP_PART = { hub: 'propHub', spinner: 'spinner', blades: 'propBlades', disc: 'propDisc' } as const;

export interface PropRig {
  hub: THREE.Group;
  spin: THREE.Group;
  blades: THREE.Mesh;
  disc: THREE.Mesh;
  spinner: THREE.Mesh;
}

const _c = new THREE.Color();

function bladeGeometry(quality: 'high' | 'low'): THREE.BufferGeometry {
  const R = G.propRadius;
  const n = quality === 'high' ? 14 : 9;
  const pitch = 1.75; // m per revolution (fine pitch, constant-speed)
  // Stations along the blade; band edges are doubled so the tip colours stay crisp.
  const bands = [0.855, 0.9, 0.94];
  const base = [0.1, 0.15, 0.2, 0.27, 0.36, 0.46, 0.56, 0.66, 0.76, 0.84];
  const tipS = [0.955, 0.965, 0.975, 0.995, 1.0];
  const rs: number[] = [...base];
  for (const b of bands) rs.push(b, b);
  rs.push(...tipS);
  const rings: number[][] = [];
  const colours: Array<[number, number]> = []; // [radius fraction, band index] per ring
  let bandIdx = 0;
  for (let i = 0; i < rs.length; i++) {
    const f = rs[i];
    if (i > 0 && rs[i] === rs[i - 1]) bandIdx++;
    const r = f * R;
    const shank = f < 0.22;
    let chord = shank ? 0.07 + (f - 0.1) * 0.35 : 0.155 - Math.abs(f - 0.45) * 0.07;
    let thick = shank ? 0.55 - (f - 0.1) * 3.0 : Math.max(0.065, 0.2 - (f - 0.22) * 0.22);
    if (f > 0.95) {
      const k = (f - 0.95) / 0.05;
      chord *= Math.sqrt(Math.max(0.02, 1 - k * k));
      thick *= 1 - 0.5 * k;
    }
    const beta = Math.atan(pitch / (2 * Math.PI * Math.max(r, 0.12)));
    const sec = nacaRing({ m: shank ? 0 : 0.035, p: 0.4, t: Math.max(0.06, thick), n });
    const dx = -Math.cos(beta);
    const dz = Math.sin(beta);
    const tx = -Math.sin(beta);
    const tz = -Math.cos(beta);
    const ring: number[] = [];
    for (let k = 0; k < sec.length; k += 2) {
      const c = (sec[k] - 0.4) * chord;
      const a = sec[k + 1] * chord;
      ring.push(c * dx + a * tx, r, c * dz + a * tz);
    }
    rings.push(ring);
    colours.push([f, bandIdx]);
  }
  const g = loftGeometry(rings, { capStart: true });
  // Per-vertex colours: front face aluminium, back face black, tips banded red/white/red.
  const pos = g.getAttribute('position');
  const nor = g.getAttribute('normal');
  const count = pos.count;
  const col = new Float32Array(count * 3);
  const rm = new Float32Array(count * 2);
  const perRing = (rings[0].length / 3) + 1;
  for (let v = 0; v < count; v++) {
    const ringIndex = Math.min(rings.length - 1, Math.floor(v / perRing));
    const [f, band] = v < rings.length * perRing ? colours[ringIndex] : [0.1, 0];
    let hex = nor.getZ(v) < 0 ? 0xaeb2b6 : 0x141415;
    let rough = nor.getZ(v) < 0 ? 0.35 : 0.75;
    let metal = nor.getZ(v) < 0 ? 0.85 : 0.0;
    if (f >= 0.855 && band >= 1) {
      hex = band === 2 ? 0xeeeeea : 0xc0231c;
      rough = 0.4;
      metal = 0;
    }
    _c.setHex(hex);
    col[v * 3] = _c.r;
    col[v * 3 + 1] = _c.g;
    col[v * 3 + 2] = _c.b;
    rm[v * 2] = rough;
    rm[v * 2 + 1] = metal;
  }
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setAttribute('rm', new THREE.BufferAttribute(rm, 2));
  const other = g.clone();
  other.rotateZ(Math.PI);
  const both = merge([g, other]);
  return both;
}

function spinnerGeometry(quality: 'high' | 'low'): THREE.BufferGeometry {
  const len = G.propHub.z - G.spinnerTip.z + 0.06; // from the back plate to the tip
  const r0 = 0.168;
  const pts: THREE.Vector2[] = [new THREE.Vector2(0.001, 0), new THREE.Vector2(r0 - 0.01, 0), new THREE.Vector2(r0, 0.008)];
  const k = 20;
  for (let i = 1; i <= k; i++) {
    const s = i / k;
    // Ogive: full radius at the back, pointed but rounded tip.
    const r = r0 * Math.pow(1 - Math.pow(s, 1.45), 0.72);
    pts.push(new THREE.Vector2(Math.max(0.001, r), 0.008 + s * (len - 0.008)));
  }
  const g = new THREE.LatheGeometry(pts, quality === 'high' ? 48 : 28);
  g.rotateX(-Math.PI / 2); // lathe +Y → −Z (forward)
  g.translate(0, 0, 0.06); // back plate 6 cm behind the prop plane
  return g;
}

export function buildProp(mats: AircraftMaterials, quality: 'high' | 'low'): PropRig {
  const hub = new THREE.Group();
  hub.name = PROP_PART.hub;
  hub.position.set(G.propHub.x, G.propHub.y, G.propHub.z);
  const spin = new THREE.Group();
  hub.add(spin);

  const blades = new THREE.Mesh(bladeGeometry(quality), mats.blades);
  blades.name = PROP_PART.blades;
  blades.castShadow = true;
  spin.add(blades);

  const spinner = new THREE.Mesh(tint(spinnerGeometry(quality), 0x1b2c58, 0.22, 0.05), mats.parts);
  spinner.name = PROP_PART.spinner;
  spinner.castShadow = true;
  spin.add(spinner);

  const discGeo = new THREE.RingGeometry(0.14, G.propRadius, quality === 'high' ? 96 : 48, 1);
  discGeo.rotateY(Math.PI); // front face looks forward (−Z)
  const disc = new THREE.Mesh(discGeo, mats.disc);
  disc.name = PROP_PART.disc;
  disc.position.z = -0.004;
  disc.renderOrder = 2;
  disc.visible = false;
  disc.userData.noBounds = false;
  hub.add(disc);

  return { hub, spin, blades, disc, spinner };
}
