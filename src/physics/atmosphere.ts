/**
 * International Standard Atmosphere (ISA) density. Pure.
 */
import { CONFIG } from '../config';

const T0 = 288.15; // K, sea-level temperature
const LAPSE = 0.0065; // K/m, troposphere lapse rate
const R_AIR = 287.053; // J/(kg·K)
const G0 = 9.80665;
const EXPONENT = G0 / (R_AIR * LAPSE) - 1; // ≈ 4.2559
const TROPOPAUSE = 11000;
const T11 = T0 - LAPSE * TROPOPAUSE; // 216.65 K

/** Air density (kg/m³) at a geometric altitude above MSL, ISA troposphere + isothermal lower stratosphere. */
export function airDensity(altitudeM: number): number {
  const rho0 = CONFIG.sim.seaLevelDensity;
  if (!Number.isFinite(altitudeM)) return rho0;
  const h = Math.min(Math.max(altitudeM, -1000), 30000);
  if (h <= TROPOPAUSE) return rho0 * Math.pow(1 - (LAPSE * h) / T0, EXPONENT);
  const rho11 = rho0 * Math.pow(T11 / T0, EXPONENT);
  return rho11 * Math.exp((-G0 * (h - TROPOPAUSE)) / (R_AIR * T11));
}

/** ρ/ρ₀. */
export const densityRatio = (density: number): number => density / CONFIG.sim.seaLevelDensity;

const GAMMA_AIR = 1.4;

/** ISA temperature (K) at a geometric altitude MSL: −6.5 K/km to the tropopause, then 216.65 K. */
export function temperatureK(altitudeM: number): number {
  if (!Number.isFinite(altitudeM)) return T0;
  const h = Math.min(Math.max(altitudeM, -1000), 30000);
  return h <= TROPOPAUSE ? T0 - LAPSE * h : T11;
}

/** Speed of sound (m/s) at a geometric altitude MSL, from the ISA temperature: a = √(γ·R·T). */
export function speedOfSound(altitudeM: number): number {
  return Math.sqrt(GAMMA_AIR * R_AIR * temperatureK(altitudeM));
}
