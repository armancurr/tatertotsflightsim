/**
 * Public API of the pure flight-physics module (Cessna 172RG).
 * The renderer never touches this module; this module never imports three.js
 * or touches the DOM.
 */
export { FLAT_ENV } from './flatEnv';
export {
  createInitialState,
  createApproachState,
  createTrimmedState,
  defaultControls,
  approachControls,
  step,
  simStateLabel,
  classifyTouchdown,
} from './aircraft';
export {
  liftCoefficient,
  dragCoefficient,
  stallAlphaRad,
  stallFactor,
  computeAero,
  type AeroResult,
  type SurfaceInputs,
} from './aero';
export { airDensity, densityRatio } from './atmosphere';
export { propThrust, powerTarget, throttleForPower, stepEngine } from './engine';
export { groundContacts } from './ground';
export { solveTrim, type TrimRequest, type TrimResult } from './trim';
