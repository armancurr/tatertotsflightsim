/**
 * Every tunable value in the simulator lives here. Balancing is one edit.
 *
 * Units are SI unless the key name says otherwise (…Kt, …Deg, …Fpm, …Ft).
 * The aircraft is a Cessna 172RG "Cutlass RG": the classic 172 airframe with
 * a 180 hp Lycoming and retractable tricycle gear. Numbers come from the POH
 * and the published C172 stability derivatives (Roskam; JSBSim c172 model),
 * adjusted for feel where noted.
 *
 * Ownership: each top-level section belongs to one module. Add keys to your
 * own section; do not reshuffle other sections.
 */

const DEG = Math.PI / 180;

export const CONFIG = {
  // ─── Simulation core ───────────────────────────────────────────────────────
  sim: {
    /** Physics fixed time step, seconds (120 Hz). */
    fixedDt: 1 / 120,
    /** Max physics steps per rendered frame (prevents the spiral of death after a stall/tab switch). */
    maxSubSteps: 10,
    /** Frame deltas above this are clamped (seconds). */
    maxFrameDt: 0.25,
    gravity: 9.80665,
    /** ISA sea-level density kg/m³. */
    seaLevelDensity: 1.225,
  },

  // ─── Aircraft (owned by src/physics) ─────────────────────────────────────
  aircraft: {
    name: 'Cessna 172RG Cutlass RG',
    registration: 'N172JT',
    /** Typical flying mass, kg (MTOW 1202 kg). */
    mass: 1100,
    /** Moments of inertia about the body axes, kg·m². pitch = body X, yaw = body Y, roll = body Z. */
    inertia: { pitch: 1825, yaw: 2667, roll: 1285 },
    wingArea: 16.2,
    wingSpan: 10.92,
    /** Mean aerodynamic chord, m. */
    meanChord: 1.49,
    /** Oswald efficiency factor for induced drag. */
    oswald: 0.75,

    aero: {
      /** Lift coefficient at zero body angle of attack (wing incidence + camber). */
      cl0: 0.25,
      /** Lift curve slope, per radian. */
      clAlpha: 4.9,
      /** Clean stall angle of attack (positive), degrees. */
      stallAlphaDeg: 16,
      /** Negative stall angle of attack, degrees. */
      stallAlphaNegDeg: -13,
      /** Width of the rounded top of the lift curve just before the stall, degrees. */
      stallRoundingDeg: 3,
      /** How far past the stall angle (deg) lift has collapsed to the post-stall (flat-plate) curve. */
      stallBreakWidthDeg: 5,
      /** Post-stall flat-plate lift: CL = k · sin(2α). */
      flatPlateLift: 1.05,
      /** Post-stall flat-plate drag: CD = k · sin²(α). */
      flatPlateDrag: 1.3,
      /** Zero-lift drag, clean, gear up. */
      cd0: 0.027,
      /** Extra zero-lift drag with gear fully down. */
      cdGear: 0.008,
      /** Extra zero-lift drag at full flaps (30°); scales ~linearly with deflection. */
      cdFlapsFull: 0.055,
      /** Extra lift coefficient at full flaps (30°); scales ~linearly with deflection. */
      clFlapsFull: 0.62,
      /** Stall angle change at full flaps, degrees (flaps stall at a slightly lower AoA). */
      stallAlphaFlapsShiftDeg: -2,
      /** Pitch moment from full flaps (C172 pitches up a little as flaps come down). */
      cmFlapsFull: 0.015,
      /** Sideslip drag factor: CD += k·β². */
      cdBeta: 0.6,

      // Side force
      cyBeta: -0.31,
      /** Side force per unit rudder control (+1 = full right rudder pushes the tail left). */
      cyRudder: -0.06,

      // Pitch (moments are per unit control in THIS sim's convention, see types.ts)
      cm0: 0.04,
      cmAlpha: -0.89,
      cmQ: -12.4,
      cmAlphaDot: -5.2,
      /** Pitch moment coefficient at full up elevator (+1). */
      cmElevator: 0.3,
      /** Pitch moment coefficient at full nose-up trim (+1). */
      cmTrim: 0.1,

      // Roll
      clBeta: -0.089,
      clP: -0.47,
      clR: 0.096,
      /** Roll moment coefficient at full right aileron (+1). */
      clAileron: 0.045,
      /** Roll moment coefficient at full right rudder (+1). */
      clRudder: -0.003,

      // Yaw
      cnBeta: 0.065,
      cnP: -0.03,
      cnR: -0.099,
      /** Yaw moment at full right aileron (+1) — adverse yaw, so negative. */
      cnAileron: -0.018,
      /** Yaw moment at full right rudder (+1). */
      cnRudder: 0.032,

      /** Past the stall, roll damping reverses by this fraction (wing drop / autorotation tendency). */
      stallRollDampingLoss: 1.6,
      /** Past the stall, extra roll moment per radian of sideslip/yaw (uncoordinated stalls drop a wing). */
      stallWingDrop: 0.12,
      /** Past the stall, extra nose-down pitch moment coefficient (the "break"). */
      stallPitchBreak: -0.08,
      /** Extra dynamic pressure over the tail from the propeller slipstream, as a fraction of thrust/(½ρ·disc area). */
      propwashTail: 0.35,
      /** P-factor/torque: yaw moment coefficient (nose left) per unit (thrust/weight · alpha). */
      pFactor: 0.02,
    },

    engine: {
      /** Lycoming O-360: 180 hp. */
      maxPowerW: 134000,
      /** Static (zero airspeed) full-throttle thrust, N. */
      staticThrustN: 2500,
      /** Peak propeller efficiency (cruise). */
      propEfficiency: 0.8,
      /** Engine power follows the throttle with this time constant when spooling up, seconds. */
      spoolUpTau: 0.9,
      /** …and this one when spooling down. */
      spoolDownTau: 0.6,
      /** Power fraction produced at idle throttle. */
      idlePower: 0.045,
      idleRpm: 700,
      maxRpm: 2700,
      /** Starter cranking time before the engine catches, seconds. */
      startTime: 1.4,
      /** Windmilling RPM per knot of airspeed with the engine off. */
      windmillRpmPerKt: 8,
    },

    flaps: {
      /** Flap notch positions, degrees. */
      notchesDeg: [0, 10, 20, 30],
      /** Electric flap motor rate, degrees per second. */
      rateDegPerSec: 6,
      /** Max flap extension speed (white arc top), knots. */
      vfeKt: 100,
    },

    gear: {
      retractable: true,
      /** Seconds for a full extension or retraction. */
      transitTime: 5,
      /** Max gear extended speed, knots. */
      vleKt: 140,
    },

    /** Control surface travel, for rendering and for any per-radian derivatives. */
    surfaces: {
      elevatorMaxDeg: 24,
      aileronMaxDeg: 20,
      rudderMaxDeg: 17,
      flapMaxDeg: 30,
      trimTabMaxDeg: 20,
      nosewheelSteerMaxDeg: 12,
    },

    /**
     * Airframe geometry in the BODY frame (metres, origin = CG, +X right, +Y up, -Z forward).
     * The 3D model and the physics contact points both use these numbers, so the
     * wheels you see are exactly where the physics puts them.
     */
    geometry: {
      length: 8.28,
      height: 2.72,
      /** Tyre contact point of each wheel with the strut fully extended (uncompressed). */
      noseWheel: { x: 0, y: -1.22, z: -1.25 },
      leftMainWheel: { x: -1.27, y: -1.22, z: 0.45 },
      rightMainWheel: { x: 1.27, y: -1.22, z: 0.45 },
      mainWheelRadius: 0.19,
      noseWheelRadius: 0.17,
      /** Maximum strut travel before the gear bottoms out, m. */
      strutTravel: 0.18,
      /** Propeller hub position and radius. */
      propHub: { x: 0, y: 0.05, z: -2.05 },
      propRadius: 0.96,
      spinnerTip: { x: 0, y: 0.05, z: -2.28 },
      /** Pilot's eye point (left seat). */
      pilotEye: { x: -0.28, y: 0.52, z: -0.15 },
      /** Wing: root chord line at the top of the cabin. */
      wingRootLeadingEdge: { x: 0, y: 0.95, z: -0.55 },
      wingRootChord: 1.63,
      wingTipChord: 1.13,
      /** Span station where the constant-chord inner panel meets the tapered outer panel (from centreline). */
      wingTaperStart: 2.5,
      dihedralDeg: 1.7,
      horizontalTail: { x: 0, y: -0.02, z: 5.35, span: 3.45, chord: 1.1 },
      verticalTailTop: { x: 0, y: 1.5, z: 5.95 },
      /**
       * Structural points that must never touch the ground. Touching the ground with any of
       * these is a crash (the gear-up belly points only matter when the gear is not down).
       */
      structuralPoints: [
        { name: 'propTip', x: 0, y: -0.91, z: -2.05 },
        { name: 'cowling', x: 0, y: -0.4, z: -1.85 },
        { name: 'leftWingtip', x: -5.46, y: 1.05, z: 0.35 },
        { name: 'rightWingtip', x: 5.46, y: 1.05, z: 0.35 },
        { name: 'tailcone', x: 0, y: -0.1, z: 5.0 },
        { name: 'finTop', x: 0, y: 1.5, z: 5.95 },
        { name: 'cabinRoof', x: 0, y: 1.1, z: 0.0 },
        { name: 'bellyFront', x: 0, y: -0.55, z: -0.9 },
        { name: 'bellyMid', x: 0, y: -0.5, z: 0.6 },
        { name: 'bellyRear', x: 0, y: -0.25, z: 2.8 },
        { name: 'leftStab', x: -1.72, y: -0.02, z: 5.6 },
        { name: 'rightStab', x: 1.72, y: -0.02, z: 5.6 },
      ],
    },

    ground: {
      springMain: 60000,
      damperMain: 6000,
      springNose: 40000,
      damperNose: 3500,
      /** Rolling resistance coefficient per surface. */
      rollingFriction: { runway: 0.02, asphalt: 0.02, grass: 0.05, field: 0.07, dirt: 0.06, sand: 0.12, urban: 0.03, forest: 0.1, rock: 0.05, snow: 0.08, water: 0.5 },
      /** Braking friction coefficient at full brakes (dry pavement). */
      brakeFriction: 0.6,
      /** Max lateral (cornering) friction coefficient. */
      lateralFriction: 0.8,
      /** Speed scale (m/s) of the tanh friction smoothing that keeps the aircraft from jittering at rest. */
      frictionSmoothing: 0.25,
      /** Nosewheel steering authority fades out above this ground speed, m/s. */
      steeringFadeSpeed: 30,
    },

    limits: {
      vsoKt: 40,
      vs1Kt: 48,
      vrKt: 55,
      vxKt: 62,
      vyKt: 75,
      vaKt: 105,
      vnoKt: 129,
      vneKt: 163,
      gLimitPos: 3.8,
      gLimitNeg: -1.52,
      /** Beyond this load factor the airframe fails (crash). */
      structuralFailureG: 6.5,
    },

    stall: {
      /** Stall warning horn sounds this many degrees before the stall angle. */
      warningMarginDeg: 3,
      /** After a stall, AoA must drop this far below the stall angle to count as recovered. */
      recoveryHysteresisDeg: 2,
    },

    /** Touchdown classification by vertical speed at first contact (feet per minute, magnitude). */
    landing: {
      butterFpm: 120,
      smoothFpm: 300,
      firmFpm: 600,
      /** Up to this is a "hard" landing; beyond it the gear collapses → crash. */
      hardFpm: 900,
      /** Bank beyond this at touchdown is a crash (wing strike/ground loop). */
      maxBankDeg: 15,
      /** Pitch at touchdown below this is a crash (nosewheel-first / prop strike). */
      minPitchDeg: -6,
      /** Must be airborne at least this long before a contact counts as a landing (not a takeoff bounce). */
      minAirborneTime: 1.5,
      /** Touching water at more than this ground speed (or at all with the engine running) is a crash. */
      ditchSpeedKt: 0,
      /** Speed at which impact with a structural point is a crash rather than a scrape. */
      scrapeSpeedMs: 0,
    },

    /** Where resets put the aircraft (see src/world/layout for the runway itself). */
    spawn: {
      /** Distance past the runway 36 threshold at which the takeoff reset places the main wheels, m. */
      runwayStartOffset: 45,
      /** Final approach reset: distance before the threshold (m), height above the runway (m), IAS (kt), flap notch. */
      approach: { distance: 4200, height: 320, speedKt: 72, flapsNotch: 2, throttle: 0.42 },
    },
  },

  // ─── Controls & input smoothing (owned by src/input) ────────────────────────
  controls: {
    /** Units/second the yoke moves toward full deflection while a key is held. */
    pitchRate: 2.2,
    rollRate: 2.8,
    yawRate: 2.5,
    /** Units/second the yoke returns to centre when released. */
    returnRate: 3.5,
    /** Exponential smoothing time constant applied after the rate limit, seconds. */
    smoothingTau: 0.06,
    /** Keyboard throttle change, fraction per second. */
    throttleRate: 0.45,
    /** Trim change per second while the trim key is held (-1..1 range). */
    trimRate: 0.35,
    /** Mouse yoke: fraction of the half-screen for full deflection, and centre deadzone. */
    mouseYokeRange: 0.6,
    mouseYokeDeadzone: 0.04,
    /** Keyboard deflection limits (keyboard can't go past these; mouse/gamepad can reach 1). */
    keyboardMaxDeflection: 1,
    gamepadDeadzone: 0.08,
    /** Key bindings (KeyboardEvent.code). */
    keys: {
      pitchDown: ['ArrowUp'],
      pitchUp: ['ArrowDown'],
      rollLeft: ['ArrowLeft'],
      rollRight: ['ArrowRight'],
      yawLeft: ['KeyA'],
      yawRight: ['KeyD'],
      throttleUp: ['KeyW', 'PageUp', 'Equal', 'NumpadAdd'],
      throttleDown: ['KeyS', 'PageDown', 'Minus', 'NumpadSubtract'],
      flapsDown: ['KeyF'],
      flapsUp: ['KeyV'],
      gear: ['KeyG'],
      brake: ['Space'],
      parkingBrake: ['KeyB'],
      trimNoseDown: ['BracketLeft'],
      trimNoseUp: ['BracketRight'],
      engine: ['KeyE'],
      landingLight: ['KeyL'],
      cameraNext: ['KeyC'],
      cameraCockpit: ['Digit1'],
      cameraChase: ['Digit2'],
      cameraExternal: ['Digit3'],
      cameraOrbit: ['Digit4'],
      /** R = reset to the runway; Shift+R = reset on final approach. */
      reset: ['KeyR'],
      pause: ['KeyP', 'Escape'],
      help: ['KeyH'],
      hud: ['KeyI'],
      mouseYoke: ['KeyY'],
      mute: ['KeyM'],
      timeOfDay: ['KeyN'],
    },
  },

  // ─── Cameras (owned by src/camera) ──────────────────────────────────────────
  camera: {
    near: 0.08,
    far: 90000,
    transitionTime: 0.9,
    cockpit: { fov: 68, lookDownDeg: 7, headLookMaxYawDeg: 150, headLookMaxPitchDeg: 70, headLookReturnRate: 2.5 },
    chase: { fov: 60, distance: 15, height: 3.6, lookAhead: 6, positionStiffness: 5, rotationStiffness: 6, bankFollow: 0.35 },
    external: { fov: 45, leadDistance: 280, sideOffset: 30, heightOffset: 6, maxDistance: 520, minFov: 12 },
    orbit: { fov: 55, distance: 22, minDistance: 8, maxDistance: 160, pitchDeg: 12, autoRotateDegPerSec: 6, dragSensitivity: 0.3 },
    /** Never let a camera go below the ground + this clearance (m). */
    groundClearance: 1.2,
    shake: { groundRoll: 0.012, stall: 0.03, crash: 0.25, decay: 3 },
  },

  // ─── World (owned by src/world) ─────────────────────────────────────────────
  world: {
    seed: 17221,
    seaLevel: 0,
    airport: {
      name: 'Tater Field',
      icao: 'KTTR',
      /** Field elevation, m MSL. */
      elevation: 30,
      /** Runway 36/18: centre point, true heading of runway 36, dimensions (m). */
      runway: { center: { x: 0, z: 0 }, headingDeg: 360, length: 1600, width: 30, name: '36/18' },
      /** Radius of the flattened airport plateau and the blend band around it, m. */
      flatRadius: 1300,
      blendWidth: 900,
    },
    terrain: {
      /** Maximum mountain height above sea level, m. */
      mountainHeight: 2600,
      /** Chunk resolution (quads per side) for each terrain tile. */
      chunkResolution: 64,
      /** Size of the largest LOD tile, m. */
      rootSize: 131072,
      /** Split a tile when camera distance < tileSize × this. */
      lodSplitFactor: 1.6,
      /** Smallest tile size, m. */
      minTileSize: 256,
    },
    vegetation: { treeDensity: 1, treeViewDistance: 4500, maxTrees: 160000 },
  },

  // ─── Sky, sun, fog, lighting (owned by src/render) ───────────────────────────
  atmosphere: {
    /** Sun position presets: [elevation°, azimuth° clockwise from north]. Index 0 is the default. */
    timeOfDay: [
      { name: 'Morning', elevationDeg: 38, azimuthDeg: 125 },
      { name: 'Midday', elevationDeg: 62, azimuthDeg: 175 },
      { name: 'Golden hour', elevationDeg: 9, azimuthDeg: 255 },
      { name: 'Dawn', elevationDeg: 4, azimuthDeg: 95 },
    ],
    exposure: 0.62,
    sunIntensity: 3.2,
    skyAmbientIntensity: 0.9,
    /** Aerial perspective: exponential fog density at sea level (per metre) and its height falloff (per metre). */
    fogDensity: 0.000055,
    fogHeightFalloff: 0.00032,
    /** Distance at which things are fully hazed out (m) — also the terrain draw distance. */
    visibility: 60000,
    turbidity: 3.2,
    rayleigh: 1.4,
    mieCoefficient: 0.004,
    mieDirectionalG: 0.82,
    shadowMapSize: 2048,
    /** Half-size of the sun shadow frustum around the aircraft, m. */
    shadowExtent: 160,
    clouds: { coverage: 0.42, baseAltitude: 1500, thickness: 900, count: 220, areaRadius: 38000 },
  },

  // ─── Rendering quality (owned by src/render) ────────────────────────────────
  render: {
    /** Cap on devicePixelRatio (Retina at 2× is very expensive for a full-screen 3D scene). */
    maxPixelRatio: 1.5,
    antialias: true,
    /** Dynamic resolution: scale pixel ratio down when the frame rate drops below target. */
    targetFps: 60,
    minPixelRatio: 0.75,
  },

  // ─── Audio (owned by src/audio) ─────────────────────────────────────────────
  audio: {
    masterVolume: 0.6,
    engineVolume: 0.55,
    windVolume: 0.35,
    stallHornVolume: 0.4,
  },

  // ─── HUD (owned by src/ui) ──────────────────────────────────────────────────
  hud: {
    /** Vertical speed indicator lag time constant, seconds (real VSIs lag). */
    vsiLagTau: 0.8,
    /** Instrument needle smoothing time constant, seconds. */
    needleTau: 0.12,
  },
};

export type Config = typeof CONFIG;
export type AircraftConfig = Config['aircraft'];

/** Degrees → radians helper re-exported for convenience. */
export const DEG_TO_RAD = DEG;
export const RAD_TO_DEG = 1 / DEG;
export const MS_TO_KT = 1.943844;
export const KT_TO_MS = 1 / MS_TO_KT;
export const M_TO_FT = 3.280839895;
export const FT_TO_M = 1 / M_TO_FT;
export const MS_TO_FPM = M_TO_FT * 60;

/** Deep clone of the config, for tests that want to tweak values without touching the shared one. */
export function cloneConfig(): Config {
  return structuredClone(CONFIG);
}
