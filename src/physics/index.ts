/**
 * Public API of the pure flight-physics module (Cessna 172RG, F-16C, A-10C, 747-400 and the Bell 206
 * JetRanger helicopter — the aircraft is chosen by the config passed to step()).
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
  machNumber,
  groundSpoilerExtension,
} from './aircraft';
export { applyFbw, fbwCommands, type FbwTelemetry } from './fbw';
export { jetThrust, jetCoreTarget, jetAbTarget, stepJetEngine, steadyJetEngine, coreRpm } from './jet';
export {
  liftCoefficient,
  dragCoefficient,
  stallAlphaRad,
  stallFactor,
  computeAero,
  machDragFactor,
  wingStripGeometry,
  wingStripMoments,
  aileronEffectiveness,
  flapPlacardKt,
  type AeroResult,
  type AeroExtras,
  type SurfaceInputs,
} from './aero';
export { airDensity, densityRatio, temperatureK, speedOfSound } from './atmosphere';
export { propThrust, powerTarget, throttleForPower, stepEngine, engineThrust, enginePowerTarget, engineThrottleForPower, steadyEngineAny } from './engine';
export { groundContacts } from './ground';
export { solveTrim, type TrimRequest, type TrimResult } from './trim';
export { gunRecoil, type BodyWrench } from './recoil';
export {
  rotorcraftForces,
  inducedVelocity,
  availablePower,
  solveRotorTrim,
  nominalOmega,
  type RotorControls,
  type RotorcraftForces,
  type RotorTrim,
} from './rotor';
