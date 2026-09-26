/**
 * Shared contracts between the pure simulation (physics, controls, camera,
 * instruments) and the renderer. Nothing in this file may import three.js.
 *
 * ─── Coordinate frames (READ THIS BEFORE TOUCHING ANY MATH) ─────────────────
 *
 * WORLD frame (same as three.js world):
 *   +X = east, +Y = up, +Z = south   (so NORTH is -Z)
 *   Units: metres. y is height above mean sea level (MSL).
 *   Heading 0° = north (-Z), 90° = east (+X), 180° = south (+Z), 270° = west.
 *
 * BODY frame (same convention as a three.js Object3D, so the renderer can copy
 * the orientation quaternion straight onto the aircraft model):
 *   +X = right wing, +Y = up (top of the aircraft), -Z = forward (the nose).
 *   Origin = centre of gravity (CG).
 *
 * `orientation` rotates BODY vectors into WORLD vectors.
 *
 * Aerodynamic quantities use the usual aircraft sign conventions, computed via
 * the helpers in src/physics/frames.ts (do not re-derive them ad hoc):
 *   u (forward speed) = -v_body.z,  v (rightward) = v_body.x,  w (downward) = -v_body.y
 *   alpha (angle of attack, + nose above the flight path) = atan2(w, u)
 *   beta  (sideslip, + air coming from the right)         = asin(v / V)
 *   p (roll rate, + right wing down) = -ω_body.z
 *   q (pitch rate, + nose up)        = +ω_body.x
 *   r (yaw rate, + nose right)       = -ω_body.y
 *   Pitch moment M (+ nose up)          → torque_body.x = +M
 *   Roll moment  L (+ right wing down)  → torque_body.z = -L
 *   Yaw moment   N (+ nose right)       → torque_body.y = -N
 *
 * Euler angles used for display: heading ψ (deg, 0..360, clockwise from north),
 * pitch θ (deg, + nose up), roll/bank φ (deg, + right wing down).
 * quat = Ry(-ψ) · Rx(θ) · Rz(-φ)  (three.js Euler order 'YXZ' with x=θ, y=-ψ, z=-φ).
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

/** Coarse phase of the flight, owned by the physics state machine. */
export type FlightPhase = 'ground' | 'airborne' | 'landed' | 'crashed';

/** What `window.sim.state` reports: the phase, with 'stalled' layered on top while airborne. */
export type SimStateLabel = 'ground' | 'airborne' | 'stalled' | 'landed' | 'crashed';

export type SurfaceType =
  | 'runway'
  | 'asphalt'
  | 'grass'
  | 'dirt'
  | 'field'
  | 'forest'
  | 'rock'
  | 'snow'
  | 'sand'
  | 'urban'
  | 'water';

export type GearState = 'down' | 'up' | 'transit';

export type CameraMode = 'cockpit' | 'chase' | 'external' | 'orbit';

export type EngineStatus = 'RUNNING' | 'STARTING' | 'OFF' | 'FAILED';

/**
 * Pilot control inputs as seen by the physics. These are already smoothed by
 * the control system (src/input); the physics applies them as given.
 */
export interface Controls {
  /** 0..1 throttle lever position. */
  throttle: number;
  /** -1..1, +1 = yoke pulled fully back (nose up). */
  elevator: number;
  /** -1..1, +1 = full right aileron (roll right). */
  aileron: number;
  /** -1..1, +1 = full right rudder (yaw right; also steers the nosewheel right on the ground). */
  rudder: number;
  /** -1..1, +1 = full nose-up trim. */
  elevatorTrim: number;
  /** Commanded flap notch index into config.aircraft.flaps.notchesDeg (0 = up). */
  flapsNotch: number;
  /** Gear handle: true = down. */
  gearDown: boolean;
  /** 0..1 toe brakes (both main wheels). */
  brake: number;
  parkingBrake: boolean;
  /** Master/magneto switch. Engine starts (after a short crank) when switched on, stops when off. */
  engineOn: boolean;
  /** Speed brake extended (jets; ignored by aircraft without one). */
  speedBrake?: boolean;
  /** Gun trigger held (pilot input; the weapons system decides whether rounds actually leave). */
  trigger?: boolean;
  /**
   * Rounds are leaving the gun this step (set by the weapons system: trigger + barrels at speed +
   * ammo left). The physics applies `cfg.weapons.gun.recoilN` at the muzzle while it is true.
   */
  gunFiring?: boolean;
  /**
   * Helicopters: the stability assist (attitude hold, heading hold, hover hold; K toggles it).
   * Absent = on. Ignored by fixed-wing aircraft.
   */
  stabilityAssist?: boolean;
}

/**
 * The world as the physics sees it. Pure functions of world x/z (metres).
 * The renderer draws the same functions so what you see is what you hit.
 */
export interface Environment {
  /** Terrain (or runway/pavement) surface height MSL at x,z. Ignores water and obstacles. */
  groundHeight(x: number, z: number): number;
  /** Unit surface normal of the terrain at x,z (optional; physics falls back to +Y). */
  groundNormal?(x: number, z: number): Vec3;
  /** What the ground is made of at x,z (drives friction and landing classification). */
  surfaceAt(x: number, z: number): SurfaceType;
  /** Height of the water surface at x,z, or null when there is no water there. */
  waterLevel(x: number, z: number): number | null;
  /** Top height (MSL) of the tallest obstacle (tree, building, tower) at x,z, or -Infinity. */
  obstacleTop?(x: number, z: number): number;
  /** Wind velocity in world frame (m/s, the direction the air moves toward). Optional. */
  wind?(x: number, y: number, z: number, time: number): Vec3;
}

export interface EngineState {
  running: boolean;
  /** True while the starter is cranking. */
  starting: boolean;
  /** Seconds of cranking so far. */
  startTimer: number;
  /** Set on crash; a failed engine will not restart until reset. */
  failed: boolean;
  /** 0..1 fraction of max power actually being produced (lags the throttle). */
  power: number;
  rpm: number;
  /** Current propeller thrust, newtons. */
  thrust: number;
  /** 0..1 afterburner intensity (jet engines only; absent/0 for pistons). */
  afterburner?: number;
}

export interface TouchdownRecord {
  /** Sim time of the touchdown, seconds. */
  time: number;
  /** Vertical speed at first wheel contact, feet per minute (negative = descending). */
  verticalSpeedFpm: number;
  /** Indicated airspeed at touchdown, knots. */
  airspeedKt: number;
  rating: 'butter' | 'smooth' | 'firm' | 'hard';
  bankDeg: number;
  pitchDeg: number;
  surface: SurfaceType;
  onRunway: boolean;
  /** Lateral distance from the runway centreline in metres (+ right of centreline when facing the landing direction), if on a runway. */
  centerlineOffsetM: number | null;
}

export interface CrashRecord {
  time: number;
  /** Human-readable cause, e.g. "Hit terrain", "Gear-up landing", "Prop strike", "Ditched in water", "Hard landing — gear collapsed". */
  reason: string;
  speedKt: number;
  verticalSpeedFpm: number;
  position: Vec3;
}

/** Values derived from the state every step, for instruments, tests and window.sim. */
export interface DerivedData {
  /** True airspeed, m/s. */
  tas: number;
  /** Indicated (equivalent) airspeed, m/s. */
  ias: number;
  groundSpeed: number;
  /** Angle of attack, radians. */
  alpha: number;
  /** Sideslip, radians. */
  beta: number;
  /** m/s, + climbing. */
  verticalSpeed: number;
  /** Height of the CG above the ground/water below, metres. */
  altitudeAGL: number;
  headingDeg: number;
  pitchDeg: number;
  rollDeg: number;
  /** Load factor along body up, in g (1 in level flight). */
  loadFactor: number;
  /** Air density kg/m³. */
  density: number;
  /** Body rates in aircraft convention, rad/s. */
  p: number;
  q: number;
  r: number;
}

/**
 * Helicopter rotor, drivetrain and turboshaft state (src/physics/rotor.ts). Present only on aircraft
 * with a `rotorcraft` config. On a helicopter `Controls.throttle` is the COLLECTIVE lever, elevator /
 * aileron the cyclic and rudder the anti-torque pedals.
 */
export interface RotorState {
  /** Main-rotor speed, rad/s (100 % NR = rotor.nominalRpm). The tail rotor turns at gearRatio × this. */
  omega: number;
  /** Main- and tail-rotor induced velocity (dynamic inflow), m/s. */
  vi: number;
  viTail: number;
  /** Main- and tail-rotor thrust, N. */
  thrust: number;
  tailThrust: number;
  /** Tip-path-plane tilt relative to the mast, rad: + aft (thrust tilted back), + right. */
  flapLong: number;
  flapLat: number;
  /** Turboshaft: shaft power delivered, W; gas-producer speed N1, 0..~1.05; governor integrator, W. */
  enginePower: number;
  n1: number;
  govInt: number;
  /** Engine torque as a fraction of the transmission limit (1 = 100 % on the torquemeter). */
  torque: number;
  /** What actually moves the blades (after the stability assist): collective 0..1, cyclic ±1 (+ aft / + right), pedal ±1 (+ right). */
  collective: number;
  cyclicLong: number;
  cyclicLat: number;
  pedal: number;
  /** Stability assist engaged this step, its integrators (control units) and the held heading, deg. */
  sasOn: boolean;
  sasLong: number;
  sasLat: number;
  sasYaw: number;
  headingRef: number;
  /** Hover hold's integrators: attitude trim it has learned to stop the drift (wind, tail-rotor drift), deg. */
  hoverLong: number;
  hoverLat: number;
  /** Stick-slip friction: where each skid contact is stuck to the ground (world), null when not touching. */
  skidAnchors: (Vec3 | null)[];
  /** 0..1 vortex-ring-state intensity, 0..1 retreating-blade stall, 0..1 ground-effect strength. */
  vrs: number;
  bladeStall: number;
  groundEffect: number;
  /** Aerodynamic (rotors + airframe) body force this step, N: x right, y up (for the slip ball and g). */
  fx: number;
  fy: number;
}

export interface AircraftState {
  /** Seconds since the last reset. */
  time: number;
  /** CG position, world metres. */
  position: Vec3;
  /** World velocity, m/s. */
  velocity: Vec3;
  /** Body → world rotation. */
  orientation: Quat;
  /** Angular velocity in the BODY frame, rad/s (x = right axis, y = up axis, z = back axis). */
  angularVelocity: Vec3;
  engine: EngineState;
  /** Actual flap deflection in degrees (moves toward the commanded notch at the flap motor rate). */
  flapsDeg: number;
  /** Actual gear position: 0 = fully up, 1 = down and locked. */
  gearPos: number;
  phase: FlightPhase;
  stalled: boolean;
  /** True when at least one wheel is on the ground this step. */
  onGround: boolean;
  /** Per-wheel ground contact this step: [nose, left main, right main]. */
  wheelContact: [boolean, boolean, boolean];
  /** Per-wheel strut compression in metres: [nose, left main, right main]. */
  wheelCompression: [number, number, number];
  /** Seconds continuously airborne (0 while on the ground). */
  airborneTime: number;
  /** Last touchdown, if any since reset. */
  touchdown: TouchdownRecord | null;
  crash: CrashRecord | null;
  derived: DerivedData;
  /** Helicopters only: rotor, drivetrain and turboshaft state. */
  rotor?: RotorState;
}

/** Everything the instruments/HUD need, already in display units. Produced by src/ui/instruments.ts. */
export interface InstrumentReadings {
  airspeedKt: number;
  altitudeFt: number;
  altitudeAglFt: number;
  headingDeg: number;
  verticalSpeedFpm: number;
  pitchDeg: number;
  rollDeg: number;
  /** Inclinometer ball, -1..1 (+ ball to the right). */
  slipSkid: number;
  /** Rate of turn, deg/s (+ right). */
  turnRateDegPerSec: number;
  throttlePct: number;
  rpm: number;
  engineStatus: EngineStatus;
  flapsDeg: number;
  flapsTargetDeg: number;
  /** The flown aircraft's flap notches, deg (the strip's flap cell draws its gates); absent = the Cessna's. */
  flapNotchesDeg?: readonly number[];
  gear: GearState;
  /** Gear position lights like the real 172RG panel: green = down & locked, red = in transit, off = up. */
  gearLight: 'green' | 'red' | 'off';
  brakes: boolean;
  parkingBrake: boolean;
  /** -100..100 % nose-up trim. */
  trimPct: number;
  stallWarning: boolean;
  overspeed: boolean;
  aoaDeg: number;
  gLoad: number;
  groundSpeedKt: number;
  state: SimStateLabel;
  /** Mach number (jets' HUD). */
  mach?: number;
  /** 0..1 afterburner intensity (jets). */
  afterburner?: number;
  /** Which aircraft these readings belong to (fleet id). */
  aircraftId?: string;
  /** Helicopters: rotor and turboshaft instruments. */
  rotor?: RotorReadings;
}

/** Helicopter instruments (dual tach, torquemeter, N1, collective, warnings). */
export interface RotorReadings {
  /** Main-rotor speed, % of nominal (green 95–104 in flight on the real JetRanger's dual tach). */
  nrPct: number;
  /** Power-turbine speed, %: equals NR while the engine drives the rotor, falls away from it when the freewheel splits them. */
  n2Pct: number;
  /** Gas-producer speed, %. */
  n1Pct: number;
  /** Engine torque, % of the transmission limit. */
  torquePct: number;
  /** Collective lever, 0..100 %. */
  collectivePct: number;
  /** Stability assist engaged. */
  sas: boolean;
  /** Low rotor RPM warning (horn + light below 95 % NR, like the real one). */
  lowRotorRpm: boolean;
  /** Torque above 100 % (the 5-minute take-off limit). */
  overTorque: boolean;
  /** 0..1 vortex ring state, 0..1 retreating-blade stall (cues for the HUD and the sound). */
  vrs: number;
  bladeStall: number;
}

/** Shape of `window.sim` (read-only snapshot fields; see src/game/simApi.ts). */
export interface SimSnapshot {
  /** Indicated airspeed, knots. */
  airspeed: number;
  /** Altitude MSL, feet. */
  altitude: number;
  /** Heading, degrees 0..360. */
  heading: number;
  /** Pitch, degrees (+ nose up). */
  pitch: number;
  /** Roll/bank, degrees (+ right wing down). */
  roll: number;
  /** Throttle lever, percent 0..100. */
  throttle: number;
  gear: GearState;
  /** Flap deflection, degrees. */
  flaps: number;
  state: SimStateLabel;
  /** Frames per second (smoothed over the last second). */
  fps: number;
}
