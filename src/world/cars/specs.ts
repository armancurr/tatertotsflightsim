/**
 * Vehicle types (PURE): real-world dimensions and performance, shared by the
 * traffic simulation (lengths, widths, accelerations) and the models.
 *
 * Model frame (vehicles.ts): +X right, +Y up, −Z = the front; the origin is on
 * the ground midway between the front and rear axle (the rear axle of a semi
 * tractor is its tandem centre). The simulation places both axles on the lane
 * path, so a vehicle follows its lane like a real one (the body overhangs).
 */
export const VT = { sedan: 0, hatch: 1, suv: 2, pickup: 3, van: 4, box: 5, semi: 6, bus: 7, tractor: 8 } as const;
export type VehicleType = (typeof VT)[keyof typeof VT];
/** Model ids: the vehicle types, plus the semi's trailer. */
export const MODEL_TRAILER = 9;
export const MODEL_COUNT = 10;
export const TYPE_NAMES = ['sedan', 'hatchback', 'suv', 'pickup', 'van', 'box truck', 'semi', 'bus', 'tractor'] as const;

export interface VehicleSpec {
  /** Bumper to bumper (semi: tractor front to trailer rear), m. */
  length: number;
  width: number;
  height: number;
  wheelbase: number;
  /** Front bumper → front axle, m. */
  frontOverhang: number;
  /** Wheel radius (front / rear), m. */
  wheelR: number;
  wheelRRear: number;
  /** Comfortable acceleration / deceleration, m/s², top speed m/s. */
  accel: number;
  decel: number;
  vmax: number;
}

export const SPECS: readonly VehicleSpec[] = [
  { length: 4.85, width: 1.84, height: 1.44, wheelbase: 2.83, frontOverhang: 0.95, wheelR: 0.33, wheelRRear: 0.33, accel: 1.9, decel: 2.5, vmax: 38 },
  { length: 4.3, width: 1.79, height: 1.46, wheelbase: 2.63, frontOverhang: 0.88, wheelR: 0.32, wheelRRear: 0.32, accel: 1.8, decel: 2.5, vmax: 36 },
  { length: 4.78, width: 1.91, height: 1.72, wheelbase: 2.82, frontOverhang: 0.95, wheelR: 0.37, wheelRRear: 0.37, accel: 1.7, decel: 2.4, vmax: 36 },
  { length: 5.85, width: 1.98, height: 1.9, wheelbase: 3.68, frontOverhang: 0.98, wheelR: 0.4, wheelRRear: 0.4, accel: 1.6, decel: 2.3, vmax: 36 },
  { length: 5.5, width: 2.03, height: 2.45, wheelbase: 3.5, frontOverhang: 0.95, wheelR: 0.36, wheelRRear: 0.36, accel: 1.4, decel: 2.2, vmax: 33 },
  { length: 7.6, width: 2.4, height: 3.45, wheelbase: 4.6, frontOverhang: 1.15, wheelR: 0.48, wheelRRear: 0.48, accel: 1.0, decel: 2.0, vmax: 29 },
  { length: 20.1, width: 2.55, height: 4.0, wheelbase: 3.9, frontOverhang: 1.2, wheelR: 0.52, wheelRRear: 0.52, accel: 0.7, decel: 1.8, vmax: 28 },
  { length: 12.2, width: 2.55, height: 3.2, wheelbase: 6.2, frontOverhang: 2.3, wheelR: 0.5, wheelRRear: 0.5, accel: 1.0, decel: 2.0, vmax: 27 },
  { length: 4.4, width: 2.25, height: 2.85, wheelbase: 2.55, frontOverhang: 1.1, wheelR: 0.5, wheelRRear: 0.82, accel: 0.8, decel: 2.0, vmax: 7.5 },
];

/** The semi's trailer (a 53 ft box): distances back from the tractor's front bumper, m. */
export const SEMI = {
  /** Fifth wheel (kingpin) — the trailer pivots here. */
  kingpin: 4.75,
  /** Trailer front face / rear face. */
  trailerFront: 3.85,
  trailerRear: 20.1,
  /** Centre of the trailer's tandem axles. */
  trailerAxle: 17.15,
  trailerWidth: 2.59,
  trailerHeight: 4.05,
  trailerWheelR: 0.5,
} as const;

/** Trailer model origin: midway between the kingpin and the rear axle centre. */
export const TRAILER_WHEELBASE = SEMI.trailerAxle - SEMI.kingpin;

/** Largest vehicle half-length (for spatial queries), m. */
export const MAX_HALF_LENGTH = Math.max(...SPECS.map((s) => s.length)) / 2;
