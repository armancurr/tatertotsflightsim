/**
 * The offshore wind farm (PURE): turbine positions, the wind they turn in, their yaw and rotor
 * speed, and their obstacles — the renderer and the physics read the same numbers.
 *
 * The turbines are modern ~15 MW class machines: a 150 m hub, a 220 m three-blade rotor, a white
 * tapered tower on a yellow transition piece (with its access platform at +20 m) on a monopile.
 * The rotor faces into the wind (upwind rotor, 12 m ahead of the tower axis, tilted 6°) and turns
 * at a tip-speed ratio of ~8 between cut-in (3 m/s) and rated (7.6 rpm at ~10.6 m/s); above
 * cut-out (25 m/s) it is feathered and idles.
 *
 * Wind: the sea's surface wind (`CONFIG.world.water.windFromDeg` / `windKt`, what the waves are
 * drawn with), or `env.wind` at hub height when the environment has one, raised to hub height by
 * the offshore power-law profile (α = 0.11, reference 10 m).
 */
import { CONFIG, type Config } from '../../config';
import type { Environment } from '../../types';
import { WIND_FARM_SITE } from './sites';

const DEG = Math.PI / 180;
const KT = 0.514444;

export const TURBINE = {
  hubHeight: 150,
  rotorRadius: 110,
  /** Hub ahead of the tower axis (upwind), m. */
  overhang: 12,
  tiltDeg: 6,
  /** Tower radius at the base (top of the transition piece) and at the top. */
  towerBaseR: 4.1,
  towerTopR: 2.9,
  /** Yellow transition piece: from below the waterline to the access platform. */
  tpBottom: -4,
  tpTop: 22,
  tpR: 4.4,
  /** Nacelle: length, width, height (the hub sits at its front, at hub height). */
  nacelle: { length: 20, width: 8, height: 8 },
  /** Rotor speed: cut-in / rated / cut-out wind (m/s), minimum and rated rpm, tip-speed ratio. */
  cutIn: 3,
  rated: 10.6,
  cutOut: 25,
  minRpm: 4.2,
  ratedRpm: 7.6,
  tsr: 8,
  /** Obstacle half-thickness of the swept disc along the wind (blade chord, tilt and coning), m. */
  discHalfThickness: 6,
} as const;

export interface TurbineSite {
  id: number;
  x: number;
  z: number;
}

/** Every turbine (row by row, west to east) and the substation. */
export function windFarmLayout(): { turbines: TurbineSite[]; substation: { x: number; z: number } } {
  const turbines: TurbineSite[] = [];
  for (const z of WIND_FARM_SITE.rowsZ) for (const x of WIND_FARM_SITE.columnsX) turbines.push({ id: turbines.length, x, z });
  return { turbines, substation: { ...WIND_FARM_SITE.substation } };
}

export interface OffshoreWind {
  /** Direction the wind blows FROM, deg true. */
  fromDeg: number;
  /** Speed at 10 m, m/s. */
  speed10: number;
  /** Speed at hub height, m/s. */
  speedHub: number;
}

/** Offshore wind shear: V(h) = V10 · (h / 10)^0.11. */
export const windAtHeight = (v10: number, h: number): number => v10 * Math.pow(Math.max(h, 1) / 10, 0.11);

/**
 * The wind the turbines turn in. `env.wind` (world velocity, the direction the air moves TOWARD)
 * at hub height when the environment provides one and it is not calm; otherwise the sea's surface
 * wind from config.
 */
export function offshoreWind(env: Pick<Environment, 'wind'> | null | undefined, cfg: Config = CONFIG, x = 10645, z = 10820, time = 0): OffshoreWind {
  if (env?.wind) {
    const w = env.wind(x, TURBINE.hubHeight, z, time);
    const s = Math.hypot(w.x, w.z);
    if (Number.isFinite(s) && s > 0.2) {
      // air moving toward (w.x, w.z) → it blows FROM the opposite bearing
      const toDeg = Math.atan2(w.x, -w.z) / DEG;
      const fromDeg = (((toDeg + 180) % 360) + 360) % 360;
      return { fromDeg, speed10: s / Math.pow(TURBINE.hubHeight / 10, 0.11), speedHub: s };
    }
  }
  const wc = cfg.world.water;
  const v10 = Math.max(0, wc.windKt) * KT;
  return { fromDeg: (((wc.windFromDeg % 360) + 360) % 360), speed10: v10, speedHub: windAtHeight(v10, TURBINE.hubHeight) };
}

/** The bearing the rotor faces (into the wind): the nacelle's nose points at the wind's source. */
export const turbineYawDeg = (windFromDeg: number): number => (((windFromDeg % 360) + 360) % 360);

/** Rotor speed (rpm) for a hub-height wind (m/s): tip-speed ratio control between cut-in and rated, idle outside. */
export function rotorRpm(vHub: number): number {
  const T = TURBINE;
  if (!Number.isFinite(vHub) || vHub < T.cutIn || vHub >= T.cutOut) return 0;
  const rpm = ((T.tsr * vHub) / T.rotorRadius) * (60 / (2 * Math.PI));
  return Math.min(T.ratedRpm, Math.max(T.minRpm, rpm));
}

/** Tower radius at height y (m above sea level). */
export function towerRadiusAt(y: number): number {
  const T = TURBINE;
  if (y <= T.tpTop) return T.tpR;
  const t = Math.min(1, (y - T.tpTop) / (T.hubHeight - T.tpTop));
  return T.towerBaseR + (T.towerTopR - T.towerBaseR) * t;
}

export interface WindFarmPhysics {
  /** Top (m MSL) of a turbine (tower, nacelle or the rotor's swept disc) or the substation at world x, z, or −∞. */
  obstacleTop(x: number, z: number): number;
  /** Re-aim the obstacle discs for another wind direction. */
  setWindFrom(fromDeg: number): void;
}

export const SUBSTATION = { w: 34, d: 26, deckY: 24, top: 44, legSpread: 26 } as const;

/**
 * Obstacles: the tower (a cylinder to the nacelle roof), the nacelle (a box along the wind axis)
 * and the swept rotor disc (a thin vertical slab across the wind whose top at lateral offset s is
 * the disc's rim, hub + √(R² − s²)), and the substation's block. Allocation-free.
 */
export function createWindFarmPhysics(windFromDeg: number): WindFarmPhysics {
  const T = TURBINE;
  const { turbines, substation } = windFarmLayout();
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const t of turbines) {
    minX = Math.min(minX, t.x);
    maxX = Math.max(maxX, t.x);
    minZ = Math.min(minZ, t.z);
    maxZ = Math.max(maxZ, t.z);
  }
  const pad = T.rotorRadius + T.overhang + 10;
  minX -= pad;
  maxX += pad;
  minZ -= pad;
  maxZ += pad;
  // unit vector toward where the wind comes from (the rotor faces it)
  let fx = 0;
  let fz = -1;
  const setWindFrom = (d: number) => {
    const h = turbineYawDeg(d) * DEG;
    fx = Math.sin(h);
    fz = -Math.cos(h);
  };
  setWindFrom(windFromDeg);
  const R = T.rotorRadius;
  const nacTop = T.hubHeight + T.nacelle.height / 2;
  const sx = substation.x;
  const sz = substation.z;
  return {
    setWindFrom,
    obstacleTop(x, z) {
      if (x < minX || x > maxX || z < minZ || z > maxZ) return -Infinity;
      if (Math.abs(x - sx) <= SUBSTATION.w / 2 + 2 && Math.abs(z - sz) <= SUBSTATION.d / 2 + 2) return SUBSTATION.top;
      let top = -Infinity;
      for (let i = 0; i < turbines.length; i++) {
        const t = turbines[i];
        const dx = x - t.x;
        const dz = z - t.z;
        if (dx > R + 20 || dx < -R - 20 || dz > R + 20 || dz < -R - 20) continue;
        // along the wind (toward its source) and across it
        const a = dx * fx + dz * fz;
        const s = dx * -fz + dz * fx;
        if (dx * dx + dz * dz <= T.tpR * T.tpR + 1) top = Math.max(top, nacTop);
        // nacelle: from the tower back to the hub
        if (a >= -T.nacelle.length + T.overhang - 2 && a <= T.overhang + 3 && Math.abs(s) <= T.nacelle.width / 2) top = Math.max(top, nacTop);
        // swept disc
        if (Math.abs(a - T.overhang) <= T.discHalfThickness && Math.abs(s) <= R) top = Math.max(top, T.hubHeight + Math.sqrt(R * R - s * s));
      }
      return top;
    },
  };
}
