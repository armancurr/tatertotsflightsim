/**
 * PURE: the GAU-8 gun-gas cloud — the grey propellant smoke that pours from the muzzle during a
 * burst and wraps the nose (the air carries it back along the fuselage). Emitted into a shared
 * particle pool (the fx system's smoke, src/fx), so it is lit, fogged and sorted with every other
 * smoke. The gas leaves the barrel fast, is stopped by the air within a fraction of a second, and
 * the aircraft flies through it; the cloud grows over the first ~0.4 s of a burst.
 */
import type { Vec3 } from '../../types';
import { newParticleInit, type ParticleInit, type ParticlePool } from '../../fx/pool';

export interface GasSource {
  smoke: ParticlePool;
  rnd(): number;
}

export interface GunGasState {
  acc: number;
  tpl: ParticleInit;
}

export const createGunGasState = (): GunGasState => ({ acc: 0, tpl: newParticleInit() });

/** Puffs per second at full burst, for a 30 mm gun (scaled by calibre² for others). */
export const GAS_RATE = 48;

/**
 * Emit this frame's gas. burstTime = seconds the burst has been firing; caliberMm scales the cloud.
 * Returns the number of puffs emitted.
 */
export function emitGunGas(src: GasSource, st: GunGasState, muzzle: Vec3, dir: Vec3, vel: Vec3, dt: number, burstTime: number, caliberMm = 30): number {
  if (!(dt > 0) || !(burstTime >= 0)) return 0;
  const k = Math.min(1, (caliberMm / 30) ** 2);
  const ramp = Math.min(1, 0.35 + burstTime / 0.4);
  st.acc += GAS_RATE * k * ramp * Math.min(dt, 0.1);
  let n = 0;
  while (st.acc >= 1 && n < 16) {
    st.acc -= 1;
    const r = src.rnd;
    const t = st.tpl;
    const ahead = 0.5 + 3.5 * r();
    t.x = muzzle.x + dir.x * ahead + (r() - 0.5) * 0.6;
    t.y = muzzle.y + dir.y * ahead + (r() - 0.5) * 0.6;
    t.z = muzzle.z + dir.z * ahead + (r() - 0.5) * 0.6;
    const out = 25 + 45 * r();
    t.vx = vel.x + dir.x * out + (r() - 0.5) * 8;
    t.vy = vel.y + dir.y * out + (r() - 0.5) * 8;
    t.vz = vel.z + dir.z * out + (r() - 0.5) * 8;
    t.life = 1.6 + 1.6 * r();
    t.size0 = (0.9 + 0.6 * r()) * Math.sqrt(k);
    t.size1 = (4.5 + 3.5 * r()) * Math.sqrt(k) * (0.6 + 0.4 * ramp);
    t.growTau = 0.7;
    t.drag = 3.2;
    t.buoyancy = 0.4;
    t.buoyTau = 1.5;
    t.gravity = 0;
    t.alpha = 0.34 * (0.7 + 0.3 * ramp);
    t.fadeIn = 0.04;
    t.fadeOut = 0.65;
    t.visibleAt = 0;
    t.rot = r() * 6.2832;
    t.rotRate = (r() - 0.5) * 0.8;
    t.heat = 0;
    t.heatTau = 1;
    const shade = 0.56 + 0.1 * r();
    t.r = shade; t.g = shade * 0.99; t.b = shade * 0.97;
    t.lighten = 0.25;
    t.tile = Math.floor(r() * 4);
    t.groundY = -1e9;
    t.bounce = 0;
    t.friction = 0;
    t.turbulence = 1.1;
    t.seed = r();
    src.smoke.emit(t);
    n++;
  }
  if (st.acc > 16) st.acc = 0;
  return n;
}
