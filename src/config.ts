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

// ─── Aircraft sub-configs that only some aircraft have (owned by src/physics) ──────────────────

/** Piston + propeller (the Cessna) or turbofan with afterburner (the F-16). */
export type EngineType = 'piston' | 'jet';

/** Turbofan with afterburner. `engine.idleRpm` / `engine.maxRpm` are core speed in % (≈ 70 / 100). */
export interface JetEngineConfig {
  /** Sea-level static thrust at military (full dry) power, N. */
  milThrustN: number;
  /** Sea-level static thrust with full afterburner, N. */
  maxThrustN: number;
  /** Sea-level static thrust at idle, N. */
  idleThrustN: number;
  /** Throttle above this detent lights the afterburner (below it: idle → military). */
  abDetent: number;
  /** Afterburner intensity just past the detent (minimum AB), 0..1. */
  abMin: number;
  /** Afterburner light-off needs the core at ≥ this fraction of military. */
  abLightCore: number;
  /** Afterburner intensity ramp rates, 1/s (up ≈ 1 s to full; down = cut). */
  abRampUpPerSec: number;
  abRampDownPerSec: number;
  /** Core spool time constants, s: accelerating from idle / near military, and decelerating. */
  spoolUpTauIdle: number;
  spoolUpTauMil: number;
  spoolDownTau: number;
  /** Thrust lapse with density: thrust ∝ σ^k. */
  densityExponent: number;
  /**
   * Mach effect on thrust (momentum drag at low speed, ram recovery above): dry thrust ×
   * (1 − lowSpeedLapse·M + ramDry·M²), afterburner increment × (1 − lowSpeedLapse·M + ramAb·M²).
   */
  lowSpeedLapse: number;
  ramDry: number;
  ramAb: number;
  /** Where the thrust acts (body frame, m): on the body axis → no pitching moment. */
  thrustPoint: { x: number; y: number; z: number };
}

/** Transonic/supersonic drag (jets). CD0 × factor(M), induced drag × (1 + inducedGain·max(0, M − 1)). */
export interface TransonicConfig {
  /** Drag divergence starts here… */
  machCrit: number;
  /** …and CD0 peaks here, at peakFactor × the subsonic value. */
  machPeak: number;
  peakFactor: number;
  /** CD0 factor at Mach 2 (falls from the peak toward it). */
  factorAtMach2: number;
  inducedGain: number;
}

/** Fly-by-wire control laws (see src/physics/fbw.ts). Null = direct mechanical controls. */
export interface FbwConfig {
  /** Stick full aft / forward commands these load factors (gear up), g. */
  maxG: number;
  minG: number;
  /** Angle-of-attack limiter, deg (gear up / gear handle down), and the negative limit. */
  aoaLimitDeg: number;
  aoaLimitGearDownDeg: number;
  minAoaDeg: number;
  /** Full lateral stick commands this roll rate, deg/s (gear up / down); reduced at high α. */
  maxRollRateDeg: number;
  maxRollRateGearDownDeg: number;
  /** Roll rate is scaled down to this fraction as α rises from rollAoaStartDeg to the AoA limit. */
  rollAoaStartDeg: number;
  rollAtAoaLimitFraction: number;
  /**
   * Sideslip limiter (departure protection): the roll command fades out as |β| grows from
   * betaLimitStartDeg to betaLimitFullDeg (a fast roll at high α turns α into β — roll coupling).
   */
  betaLimitStartDeg: number;
  betaLimitFullDeg: number;
  /**
   * Curved stick gradients (like the F-16's force stick): command ∝ (1 − k)·s + k·s³ in roll and
   * (1 − k)·s + k·s·|s| in pitch — fine control near centre, full authority at the stops.
   */
  rollShaping: number;
  pitchShaping: number;
  /** Gear handle down (take-off/landing gains): full stick commands this flight-path rate, deg/s. */
  pathRateGearDownDeg: number;
  /** Neutral stick holds the flight path up to this bank angle (bank compensation), deg. */
  bankCompensationDeg: number;
  /** Pitch loop: natural frequency (rad/s) and damping of the angle-of-attack response. */
  pitchOmega: number;
  pitchZeta: number;
  /** Roll-rate response time constant, s. */
  rollTau: number;
  /** Yaw loop (sideslip → 0, turn coordination): natural frequency (rad/s) and damping. */
  yawOmega: number;
  yawZeta: number;
  /** Full pedal commands this sideslip in the air, deg. */
  pedalBetaDeg: number;
  /**
   * On the wheels (take-off/landing gains): pitch-rate command. Stabilator = stick × groundElevatorGain
   * (feed-forward) + groundPitchRateGain × (q_cmd − q) [per rad/s]; full stick commands
   * groundPitchRateDeg, and the command fades to 0 at groundPitchLimitDeg of pitch (tail-strike
   * protection, rate groundPitchProtectGain per rad of margin).
   */
  groundElevatorGain: number;
  groundPitchRateGain: number;
  groundPitchRateDeg: number;
  groundPitchLimitDeg: number;
  groundPitchProtectGain: number;
  /** Seconds after lift-off over which the ground (direct) laws blend into the flight laws. */
  liftoffBlendS: number;
}

// ─── Weapons (owned by src/combat; the physics reads gun.recoilN / gun.muzzle) ─────────────────
// Positions are in the BODY frame (origin = CG, +X right, +Y up, −Z nose), metres, and the 3D
// model must put the matching parts exactly there (the gun muzzle, one missile per station).

/** An internal rotary cannon (A-10: GAU-8/A Avenger; F-16: M61A1 Vulcan). */
export interface GunConfig {
  name: string;
  caliberMm: number;
  barrels: number;
  /** Rounds per second at full barrel speed. */
  rateRps: number;
  /** Trigger → first round (the barrels spin up), and full rate → stopped, s. */
  spinUpS: number;
  spinDownS: number;
  /** Rounds loaded at a reset. */
  rounds: number;
  /** Muzzle velocity, m/s (added to the aircraft's velocity). */
  muzzleVelocity: number;
  projectileMassKg: number;
  /** Quadratic drag of the projectile: a = −dragK · |v| · v (1/m, at sea level; scaled by density ratio). */
  dragK: number;
  /** Dispersion: 80 % of rounds land within this cone radius, milliradians. */
  dispersionMrad: number;
  /** Average recoil force while firing, N (acts along body +Z at the muzzle). */
  recoilN: number;
  /** Muzzle position (the firing barrel), body frame. */
  muzzle: { x: number; y: number; z: number };
  /** Gun line depression below the body −Z axis, deg (+ = points below the fuselage datum). */
  boresightDownDeg: number;
  /** Every n-th round is drawn as a tracer. */
  tracerEvery: number;
  /** Rounds are dropped after this time of flight, s. */
  maxFlightS: number;
  /** Damage units per direct hit before armour (see CONFIG.combat.targets), and HEI splash radius, m. */
  damage: number;
  splashRadiusM: number;
}

/**
 * Air-to-ground missiles, ARCADE model: pick a target with T, fire with Z, and the missile flies a
 * scripted curve to it (src/combat/missile.ts). Deliberately not a guidance or seeker simulation.
 */
export interface MissileConfig {
  name: string;
  /** One missile per station, fired in this order (the model hangs one missile at each). */
  stations: { x: number; y: number; z: number }[];
  /** Visual size, m. */
  diameterM: number;
  lengthM: number;
  /** Average speed along the scripted path, m/s, and how high the path arcs (fraction of the distance). */
  speed: number;
  arc: number;
  /** Target selection: within this angle of the nose and this range (m); "LOCK" after lockTimeS. */
  selectConeDeg: number;
  maxRangeM: number;
  minRangeM: number;
  lockTimeS: number;
  /** Damage on arrival and blast radius, m. */
  damage: number;
  blastRadiusM: number;
}

/** What an aircraft carries. `null` = none (the Cessna carries nothing). */
export interface WeaponsConfig {
  gun: GunConfig | null;
  missiles: MissileConfig | null;
}

/** A ground vehicle class: size (m), toughness (damage units) and armour by aspect (damage multipliers). */
export interface TargetClassConfig {
  name: string;
  /** Hull box: full length (z), width (x), height (y), m. */
  length: number;
  width: number;
  height: number;
  health: number;
  /** Damage multipliers for hits on the front, sides, rear and top (1 = no armour). */
  armor: { front: number; side: number; rear: number; top: number };
  /** Road speed when moving, m/s. */
  speed: number;
}


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
      cl0: 0.4,
      /** Lift curve slope, per radian. */
      clAlpha: 4.9,
      /** Clean stall angle of attack (positive), degrees. */
      stallAlphaDeg: 15.5,
      /** Negative stall angle of attack, degrees. */
      stallAlphaNegDeg: -13,
      /** Width of the rounded top of the lift curve just before the stall, degrees. */
      stallRoundingDeg: 2.5,
      /** How far past the stall angle (deg) lift has collapsed to the post-stall (flat-plate) curve. */
      stallBreakWidthDeg: 5,
      /** Post-stall flat-plate lift: CL = k · sin(2α). */
      flatPlateLift: 1.05,
      /** Post-stall flat-plate drag: CD = k · sin²(α). */
      flatPlateDrag: 1.3,
      /** Zero-lift drag, clean, gear up. */
      cd0: 0.024,
      /** Extra zero-lift drag with gear fully down. */
      cdGear: 0.01,
      /** Extra zero-lift drag at full flaps (30°); scales ~linearly with deflection. */
      cdFlapsFull: 0.055,
      /** Extra lift coefficient at full flaps (30°); scales ~linearly with deflection. */
      clFlapsFull: 0.75,
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
      cm0: 0.05,
      /**
       * The tail's share of cm0 (its download from the stabiliser incidence). It rides the propeller
       * slipstream, so adding power pitches the nose up like the real 172. cm0 is the power-off total.
       */
      cm0Tail: 0.08,
      cmAlpha: -0.89,
      cmQ: -12.4,
      cmAlphaDot: -5.2,
      /** Pitch moment coefficient at full up elevator (+1). */
      cmElevator: 0.24,
      /** Pitch moment coefficient at full nose-up trim (+1). */
      cmTrim: 0.15,

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
      /**
       * Yaw from roll rate (wing adverse yaw minus the fin's proverse part). Tuned down from −0.03 with
       * cnAileron so an aileron-only (keyboard) roll-in no longer swings the nose the wrong way first:
       * the heading follows the bank within ~0.3 s, < 1° wrong-way (tests/physics/turn-entry.test.ts).
       */
      cnP: -0.01,
      cnR: -0.099,
      /**
       * Yaw moment at full right aileron (+1). The 172's Frise-type, differential ailerons (20° up /
       * 15° down) are designed to cancel aileron adverse yaw: net slightly proverse (was −0.006, which
       * swung the nose ~5° the wrong way on a keyboard roll-in).
       */
      cnAileron: 0.001,
      /** Yaw moment at full right rudder (+1). */
      cnRudder: 0.032,

      // ── Stall / spin: strip-theory wing (see aero.ts wingStripMoments) ──
      // Each half wing is split into spanwise strips that see their own local angle of attack
      // (α + p·y/V, washout, the ailerons on the outer strips) and local airspeed (u − r·y). The wing's
      // roll moment (damping, Clr, aileron) and its yaw moment (adverse yaw, the drag of a stalled wing,
      // leading-edge suction of an unstalled one) come from summing the strips. In attached flow the
      // strip roll moment is scaled to match clP and clAileron above (their calibration is kept); as the
      // wing stalls the down-going wing loses lift (autorotation → spin), a down aileron deepens the
      // stall of its wing, and the gain moves to stripRollGainStalled.
      /**
       * The strip moments take over from the linear ones as the wing stalls AND the flow over it turns
       * asymmetric: weight = stall weight × smoothstep(onset, full, asymmetry), asymmetry =
       * |p̂| + |r̂| + kβ·|β| + kA·|aileron| (p̂ = p·b/2V). A stalled wing meeting the air symmetrically keeps
       * the linear damping, so a coordinated, wings-level stall breaks straight.
       */
      /** …where the stall weight ramps from 0 to 1 over ±this many degrees around the stall angle. */
      stripStallBlendDeg: 1.5,
      stripAsymOnset: 0.01,
      stripAsymFull: 0.05,
      stripAsymBeta: 0.3,
      stripAsymAileron: 0.05,
      /** Strips per half wing. */
      wingStrips: 4,
      /** Geometric washout, degrees: the tip meets the air this much lower than the root (root stalls first). */
      washoutDeg: 3,
      /** Wing sections lose their lift more gradually past the stall than the whole-wing break above, degrees. */
      stripStallBreakWidthDeg: 12,
      /** Gain on the raw strip-theory roll moment once the wing is fully stalled (attached: set by clP). */
      stripRollGainStalled: 0.7,
      /** Gain on the strip yaw moment. */
      stripYawGain: 1,
      /** The ailerons span the strips outboard of this fraction of the half span. */
      aileronSpanStart: 0.55,
      /**
       * At high α the fin and rudder sit in the wake of the stalled wing and stabiliser: the directional
       * stability and yaw damping (cnBeta, cnR) lose this fraction once the wing is fully stalled.
       */
      stallYawDampingLoss: 0.3,
      /** …and the rudder loses this fraction (it still stops a spin). */
      stallRudderLoss: 0.2,
      /** Fuselage crossflow normal force at high α: ΔCN = k·sin α·|sin α| (referenced to the wing area). */
      bodyCrossflowCn: 0.3,
      /** Past the stall the flaps keep this fraction of their lift increment (flapped stalls are gentler). */
      postStallFlapLiftFraction: 0.5,
      /** Past the stall, extra nose-down pitch moment coefficient (the "break"). */
      stallPitchBreak: -0.12,
      /** Past the stall the tail sits in the stalled wing's wake: elevator/trim effectiveness drops by this fraction. */
      stallTailBlanking: 0.4,
      /** Extra dynamic pressure over the tail from the propeller slipstream, as a fraction of thrust/(½ρ·disc area). */
      propwashTail: 0.3,
      /**
       * The whole tail sits in the slipstream, so its stability and damping contributions (cmAlpha, cmQ,
       * cnBeta, cnR) scale with the same tail dynamic-pressure ratio as the elevator/rudder, capped here.
       * This keeps the AoA change per unit of elevator the same with and without power.
       */
      propwashTailMaxRatio: 2,
      /**
       * Ground effect: near the ground the wing's downwash at the tail is reduced, which pitches the nose
       * down (more up-elevator needed to rotate and flare): ΔCm = −k·CL·φ, φ = 1/(1 + (h / (scale·span))²),
       * h = wing height above the surface.
       */
      cmGroundEffect: 0.08,
      /** Wing ground effect: fractional lift increase at the ground (scaled by McCormick's 1 − φ, attached flow). */
      groundEffectLift: 0.25,
      groundEffectScale: 0.25,
      /** P-factor/torque: yaw moment coefficient (nose left) per unit (thrust/weight · alpha), for alpha > 0 (rigged neutral in cruise). */
      pFactor: 0.08,
      /** Extra zero-lift drag with the speed brake out (aircraft without one: 0). */
      cdSpeedBrake: 0,
      /** Mach drag rise (jets); null = incompressible (the Cessna never gets near it). */
      transonic: null as TransonicConfig | null,
    },

    engine: {
      /** Piston + constant-speed prop. */
      type: 'piston' as EngineType,
      /** Jet parameters (jets only). */
      jet: null as JetEngineConfig | null,
      /** Lycoming O-360: 180 hp. */
      maxPowerW: 134000,
      /** Static (zero airspeed) full-throttle thrust, N. */
      staticThrustN: 2500,
      /** Peak propeller efficiency (cruise). */
      propEfficiency: 0.85,
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
      /** Starter cranking RPM. */
      crankRpm: 180,
      /** RPM follows its target with these time constants (running / spinning down), seconds. */
      rpmTau: 0.35,
      spinDownTau: 1.5,
      /**
       * Drag of a propeller that is not being driven hard (windmilling), as a drag coefficient on the
       * disc area, scaled by (1 − power fraction)²: an idle or dead engine makes the glide steeper.
       */
      windmillDragCoeff: 0.18,
    },

    flaps: {
      /** Flap notch positions, degrees. */
      notchesDeg: [0, 10, 20, 30],
      /** Electric flap motor rate, degrees per second. */
      rateDegPerSec: 6,
      /** Max flap extension speed (white arc top), knots. */
      vfeKt: 100,
      /** Trailing-edge flaps that come down automatically with the gear handle (F-16 flaperons), deg; 0 = none. */
      autoWithGearDeg: 0,
      /** …only below this IAS, kt. */
      autoRetractKt: 0,
    },

    gear: {
      retractable: true,
      /** Seconds for a full extension or retraction. */
      transitTime: 5,
      /** Max gear extended speed, knots. */
      vleKt: 140,
      /** Max speed for operating the gear (in transit), knots. */
      vloKt: 140,
      /** Seconds continuously airborne before the squat-switch interlock lets the gear retract. */
      retractDelay: 1.5,
      /** Squat switch: the gear will not retract while the aircraft sits on its wheels. */
      squatSwitch: true,
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
      pilotEye: { x: -0.28, y: 0.64, z: 0.02 },
      /** Wing: root chord line at the top of the cabin. */
      wingRootLeadingEdge: { x: 0, y: 0.95, z: -0.55 },
      wingRootChord: 1.63,
      wingTipChord: 1.13,
      /** Span station where the constant-chord inner panel meets the tapered outer panel (from centreline). */
      wingTaperStart: 2.5,
      dihedralDeg: 1.7,
      horizontalTail: { x: 0, y: -0.02, z: 5.35, span: 3.45, chord: 1.1 },
      verticalTailTop: { x: 0, y: 1.5, z: 5.45 },
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
        { name: 'finTop', x: 0, y: 1.5, z: 5.45 },
        { name: 'cabinRoof', x: 0, y: 1.1, z: 0.0 },
        { name: 'bellyFront', x: 0, y: -0.55, z: -0.9 },
        { name: 'bellyMid', x: 0, y: -0.5, z: 0.6 },
        { name: 'bellyRear', x: 0, y: -0.25, z: 2.8 },
        { name: 'leftStab', x: -1.72, y: -0.02, z: 5.6 },
        { name: 'rightStab', x: 1.72, y: -0.02, z: 5.6 },
      ],
    },

    /** Visual-only tuning of the 3D model and its animation (owned by src/aircraft; physics ignores it). */
    model: {
      /** Down-going aileron travel as a fraction of the up travel (C172: 20° up / 15° down). */
      aileronDownRatio: 0.75,
      /** Flap aft slide (m) and drop (m) at full 30° — the slotted flap runs out on its tracks. */
      flapSlideM: 0.12,
      flapDropM: 0.035,
      /** Blades fade into the blurred disc between these rpm (idle ≈ 700 still shows the blades, strobing). */
      propBlurStartRpm: 350,
      propBlurFullRpm: 1300,
      /** Wingtip strobes: one flash of `strobeFlashS` every `strobePeriodS`. Beacon: one sweep per `beaconPeriodS`. */
      strobePeriodS: 1.2,
      strobeFlashS: 0.07,
      beaconPeriodS: 1.1,
      /** Yoke push/pull travel (m), yoke turn at full aileron (deg), rudder pedal travel (m). */
      yokeTravelM: 0.07,
      yokeRollMaxDeg: 45,
      pedalTravelM: 0.05,
      /** Nose leg swings aft this far into its well; nose doors open this far. */
      noseGearRetractDeg: 90,
      gearDoorOpenDeg: 75,
      /** Cabin fill: fraction of the sun's irradiance that reaches shaded cabin surfaces (bounce light). */
      cabinFill: 0.16,
      /** Instrument panel texture redraw rate in the cockpit view (Hz), and outside it. */
      panelRedrawHz: 30,
      panelRedrawHzExterior: 4,
      /** Landing light: position in the left wing leading edge (body frame), beam, strength. */
      landingLight: { x: -1.72, y: 0.965, z: -0.56, angleDeg: 10, penumbra: 0.45, range: 320, decay: 1.2, intensity: 600, aimDownDeg: 3 },
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
      /** Nosewheel steering keeps at least this fraction of its authority at speed. */
      steeringMinFraction: 0.15,
      /** Speed scale (m/s) of the tanh smoothing for rolling/braking friction (small = firm static hold). */
      longitudinalSmoothing: 0.05,
      /** Past strutTravel the strut bottoms out: spring × this factor. */
      bottomOutStiffness: 10,
      /** Strut damping when extending (rebound) = damper × this (oleo struts rebound slowly: no bounce, no nose kick). */
      reboundDampingFactor: 3,
      /** Sliding friction of the tail skid/tailcone on a gentle scrape. */
      tailSkidFriction: 0.4,
    },

    /** Fly-by-wire control laws; null = the pilot's controls drive the surfaces directly. */
    fbw: null as FbwConfig | null,

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
      /** Negative load factor beyond which the airframe fails (crash). */
      structuralFailureNegG: -3,
      /** Flutter/overspeed: IAS beyond vneKt × this is a structural failure (≈ design dive speed + margin). */
      overspeedFailureFactor: 1.3,
      /** Safety net: body angular rates are clamped to this magnitude, rad/s (≈ 460°/s). */
      maxAngularRate: 8,
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
      scrapeSpeedMs: 3,
      /** A structural point (or the gear) hitting the surface faster than this (m/s) is "Hit terrain". */
      terrainImpactMs: 8,
      /** A structural point found deeper than this below the surface flew into it ("Hit terrain"), m. */
      terrainPenetrationM: 0.3,
      /** Collision broad phase: skip ground/structure checks when the CG is higher than this above the surface, m. */
      nearGroundAglM: 30,
      /** …and skip obstacle checks above this height over the terrain, m. */
      obstacleCheckAglM: 400,
    },

    /** Where resets put the aircraft (see src/world/layout for the runway itself). */
    spawn: {
      /** Distance past the runway 36 threshold at which the takeoff reset places the main wheels, m. */
      runwayStartOffset: 45,
      /**
       * Final approach reset: distance before the threshold (m), height above the runway (m), IAS (kt), flap notch,
       * throttle (initial guess — the trim solver finds the exact value), aim point past the threshold (m).
       * height ≈ tan(3°) × (distance + aimPointM), so the spawn sits on a 3° glide to the aim point.
       */
      approach: { distance: 4200, height: 236, speedKt: 72, flapsNotch: 2, throttle: 0.5, aimPointM: 300 },
    },
  },

  // ─── Controls & input smoothing (owned by src/input) ────────────────────────
  controls: {
    /** Units/second the yoke moves toward full deflection while a key is held. */
    pitchRate: 2.2,
    rollRate: 2.8,
    yawRate: 2.5,
    /** Units/second the yoke returns to centre when released (ailerons, rudder; also any reversal). */
    returnRate: 3.5,
    /** Units/second the ELEVATOR relaxes toward neutral when released — slow, like a pilot easing off back pressure. */
    pitchReturnRate: 0.8,
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
    /** Seconds for the toe brakes to go 0 → 1 while the brake key is held, and 1 → 0 when released. */
    brakeApplyTime: 0.15,
    brakeReleaseTime: 0.1,
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
      /** Speed brake (jets). */
      speedBrake: ['KeyX'],
      /** Gun trigger (hold) · launch a missile · lock / next target (armed aircraft: A-10, F-16). */
      fireGun: ['KeyQ', 'Enter'],
      fireMissile: ['KeyZ'],
      lockTarget: ['KeyT'],
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
    /** A target jump larger than this (m) in one update is a reset/teleport: the camera snaps, no lag. */
    snapDistance: 300,
    /**
     * dragSensitivity = degrees per pixel of mouse drag. headLookReturnRate = 1/s (1/time constant).
     * Wheel zooms the cockpit FOV between minFov and maxFov (zoomPerNotch = fraction per wheel notch).
     */
    cockpit: { fov: 68, lookDownDeg: 7, headLookMaxYawDeg: 150, headLookMaxPitchDeg: 70, headLookReturnRate: 2.5, dragSensitivity: 0.25, minFov: 30, maxFov: 90, zoomPerNotch: 0.08 },
    /** Drag orbits the chase camera temporarily (springs back with dragReturnTau s); wheel zooms the distance by minZoom..maxZoom. */
    chase: { fov: 60, distance: 15, height: 3.6, lookAhead: 6, positionStiffness: 5, rotationStiffness: 6, bankFollow: 0.35, dragSensitivity: 0.3, dragReturnTau: 0.5, maxDragPitchDeg: 60, minZoom: 0.5, maxZoom: 4, zoomPerNotch: 0.1 },
    /**
     * Fly-by camera. The anchor is leadDistance ahead along the velocity (at least minLead, at most
     * leadTime seconds of flight). FOV narrows so a box framingSize metres wide stays in view.
     * On the ground below spotterSpeed (m/s) it becomes a spotter spotterDistance m off the side.
     */
    external: { fov: 45, leadDistance: 280, sideOffset: 30, heightOffset: 6, maxDistance: 520, minFov: 12, framingSize: 60, fovTau: 0.25, minLead: 60, leadTime: 6, spotterDistance: 40, spotterSpeed: 10, spotterEyeHeight: 1.7 },
    orbit: { fov: 55, distance: 22, minDistance: 8, maxDistance: 160, pitchDeg: 12, autoRotateDegPerSec: 6, dragSensitivity: 0.3, minPitchDeg: -10, maxPitchDeg: 85, autoRotateDelay: 3, zoomPerNotch: 0.12 },
    /** Never let a camera go below the ground + this clearance (m). */
    groundClearance: 1.2,
    /**
     * Camera shake ("trauma" model). CameraInput.shake is an intensity 0..1; the visible amplitude is
     * intensity² × amplitudeDeg (rotation) / amplitudeM (translation), so small values stay subtle.
     * Intensities per source for shakeTarget(): groundRoll at groundRollSpeed (m/s ground speed, scales
     * linearly below it), stall, crash (decays at `decay` 1/s after the impact). The rig also decays
     * sudden drops in the input at `decay` so shake never cuts off abruptly. frequency = noise Hz.
     */
    shake: { groundRoll: 0.35, groundRollSpeed: 36, stall: 0.5, crash: 1, decay: 3, amplitudeDeg: 3, amplitudeM: 0.12, frequency: 9 },
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
    /** Airport renderer (owned by src/world/airport). */
    airportRender: {
      /** Surface wind shown by the windsock: direction it blows FROM (deg true) and speed (kt). */
      wind: { fromDeg: 330, speedKt: 8 },
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
    /** Trees and forests (owned by src/world/vegetation). */
    vegetation: {
      /** Global multiplier on the landcover tree density (0 = no trees). */
      treeDensity: 1,
      /** Beyond this distance (m, camera → tree) no tree is drawn; the terrain colour takes over. */
      treeViewDistance: 4500,
      /** Hard cap on tree instances submitted to the GPU per frame (all LODs). */
      maxTrees: 200000,
      /** Placement cell (m): the unit of deterministic generation, streaming work and the obstacle hash. */
      cellSize: 64,
      /** Jittered-grid candidates per cell side (cellSize / gridPerCell = tree spacing in full forest, m). */
      gridPerCell: 10,
      /** Streaming chunk (m, a multiple of cellSize): one impostor draw call per visible chunk. */
      chunkSize: 2048,
      /** Full 3D meshes out to this distance (m); impostors beyond. */
      meshDistance: 210,
      /** Width of the dithered mesh ↔ impostor cross-fade band (m), ending at meshDistance. */
      lodFadeBand: 50,
      /** (legacy) every near mesh casts shadows; the sun's shadow map covers about this far. */
      shadowDistance: 200,
      /** Impostors fade out over this band (m) ending at treeViewDistance. */
      farFadeBand: 1100,
      /** Beyond this distance impostors thin out (keep ∝ (d0/d)^exp) and grow to keep the canopy closed. */
      thinStartDistance: 1100,
      thinExponent: 1.5,
      /** Maximum impostor enlargement compensating for thinning. */
      thinCompensationMax: 1.6,
      /** Preallocated near-mesh instances per species. */
      nearCapacity: 6000,
      /** Rebuild the near-mesh set after the camera moves this far (m)… */
      nearRebuildDistance: 8,
      /** …or turns by more than acos(this) (cos 7°). */
      nearRebuildCos: 0.9925,
      /** The near set is culled per placement cell against the view frustum widened by this factor… */
      nearFrustumWiden: 1.4,
      /** …except cells within this distance (m), which always draw (their shadows fall into view). */
      nearAlwaysDistance: 60,
      /** Web Workers generating tree chunks and grass cells (0 = inline on the main thread). */
      workers: 3,
      /** Inline fallback only: time budget for generating tree cells per frame (ms). */
      frameBudgetMs: 1.5,
      /** Inline fallback only: budget when the camera's own chunk has no trees yet (ms). */
      urgentBudgetMs: 30,
      /** Inline fallback only: hard cap on cells generated per frame. */
      maxCellsPerFrame: 48,
      /** Placement cells kept for obstacle queries (LRU). */
      obstacleCacheCells: 256,
      /** Impostor atlas tile size (px); the atlas is 6 view elevations × 7 species. */
      impostorTileSize: 192,
      /** Wind sway: strength multiplier and gust speed multiplier. */
      windStrength: 1,
      windSpeed: 1,
      /** Strength of the sunlit-leaf translucency (back-lit glow), 0 = off. */
      translucency: 1,
    },
    /** Grass tufts and wildflowers near the camera (owned by src/world/grass). */
    grass: {
      /** Tufts are drawn out to this distance from the camera (m), thinning with distance. */
      viewDistance: 120,
      /** Full density within this distance (m); beyond, keep ∝ (d0/d)^thinExponent. */
      fullDensityDistance: 16,
      thinExponent: 1.35,
      /** No grass once the camera is this high above the ground (m); fades in below fadeHeight. */
      maxHeight: 90,
      fadeHeight: 45,
      /** Grass cell size (m) and candidate tufts per cell side (cellSize/perSide = tuft spacing). */
      cellSize: 16,
      perSide: 32,
      /** The mown airfield: within this distance of the runway centre (m). */
      mownRadius: 1300,
      /** Hard cap on tufts drawn. */
      maxTufts: 60000,
      /** Rebuild the instance list after the camera moves this far (m) or turns acos(rebuildCos). */
      rebuildDistance: 2,
      rebuildCos: 0.99,
      /** Blades per tuft. */
      blades: 7,
      /** Wind sway multiplier. */
      windStrength: 1,
    },
    /** Buildings, farmsteads and roads (owned by src/world/towns + src/world/roads). */
    towns: {
      /** Building chunk size, m: one InstancedMesh per archetype per chunk (frustum-culled as a unit). */
      chunkSize: 1024,
      /** Detailed geometry (pitched roofs, facade shader) while a chunk is nearer than this, m. */
      nearDistance: 1600,
      /** Simple boxes beyond nearDistance, hidden past midDistance (the terrain's urban colour takes over)… */
      midDistance: 7500,
      /** …except tall buildings (towers, spires, silos), which stay visible as boxes out to farDistance, m. */
      farDistance: 16000,
      /** A box is drawn at distance d only while its size (m) ≥ d × this (≈ 1.5 px at 1440×900). */
      minAngularSize: 0.0016,
      /** LOD switch hysteresis, as a fraction of the switch distance. */
      hysteresis: 0.06,
      /** Farmsteads: one candidate per jittered grid cell of this size (m), kept with this probability. */
      farmsteadSpacing: 900,
      farmsteadChance: 0.62,
      /** Farmsteads/rural houses need ground below this height (m MSL) and gentler than this slope. */
      farmMaxHeight: 420,
      maxSlope: 0.16,
      /** Scattered houses along country roads outside towns: probability per 45 m of road side. */
      roadsideHouseChance: 0.035,
      roads: {
        /** Near-LOD chunk size, m: one merged mesh (ribbons + bridges + guard rails) per chunk, built on demand. */
        chunkSize: 2048,
        /** Far-LOD super-chunk size, m (coarse ribbons of the major roads + streets, no farm tracks). */
        farChunkSize: 8192,
        /** Near LOD within this camera distance, far LOD beyond (split per fragment, seamless), m. */
        nearDistance: 3000,
        /** Terrain sampling step along roads before simplification, m; tolerance of the simplified drape, m. */
        sampleSpacing: 4,
        drapeTolerance: 0.05,
        /** Longest ribbon segment after simplification, m. */
        maxSegment: 48,
        /** Far LOD: every n-th sample, drape tolerance and longest segment. */
        farStride: 3,
        farTolerance: 0.25,
        farMaxSegment: 160,
        /** Height of the paved ribbon above the terrain, m (+1.2 cm per kind rank; plus the LOD lift and depth pull). */
        lift: 0.12,
        /**
         * LOD lift per kind (m per m of camera distance): keeps roads above the coarse far terrain mesh
         * (measured against the heightfield, see src/world/roads/depth.ts and its test).
         */
        lodLift: { highway: 0.0008, road: 0.0009, access: 0.0008, lane: 0.003, street: 0.0015, drive: 0.0013 },
        /** View-space depth pull toward the camera (fraction of the view depth; screen position unchanged). */
        depthPull: 0.0012,
        viewDistance: 18000,
        streetViewDistance: 6500,
        /** Bridge deck clearance above the water (m) and approach ramp length (m). */
        bridgeClearance: 4,
        bridgeRamp: 70,
        /** Street lights along town streets: spacing (m) and draw distance (m). */
        streetLightSpacing: 38,
        streetLightDistance: 2600,
        /** Worker-less fallback: chunk build budget per frame (ms), and when nothing near is built yet. */
        frameBudgetMs: 3,
        urgentBudgetMs: 30,
      },
    },
    /** Ships, boats and other aircraft (owned by src/world/traffic; systems ships.ts + airTraffic.ts). */
    traffic: {
      /** Schedules are a pure function of this seed + the traffic clock (+ the player's position at decision points). */
      seed: 4217,
      /** Traffic clock at start-up, s (URL `?tt=<s>` overrides, for QA photos). The clock stops while paused. */
      startTime: 0,
      /** Surface wind for sailing (direction it blows FROM, deg true) and its speed, kt. */
      windFromDeg: 230,
      windKt: 13,
      /** Airborne traffic keeps at least this far from the player (m); nothing spawns closer than spawnClearance. */
      playerClearance: 330,
      spawnClearance: 3000,
      sea: {
        /** Port Chateau marina: centre x on the city waterfront (the quay follows the coastline). */
        marinaX: -4700,
        /** Fraction of the marina berths that hold a boat. */
        berthFill: 0.72,
        sailingYachts: 6,
        motorYachts: 3,
        fishingBoats: 3,
        lakeBoats: 3,
        /** Small craft are drawn within this distance of the camera (m); ships (ferry, cargo) within shipViewDistance. */
        viewDistance: 7000,
        shipViewDistance: 42000,
        /** Low-detail boat meshes beyond this distance (m). */
        lodDistance: 700,
        /** Wakes (foam trail + Kelvin arms) are drawn for vessels within this distance of the camera (m). */
        wakeDistance: 6000,
        /** Wake samples per vessel (ribbon resolution). */
        wakeSamples: 22,
        /** Ferry: cruise speed (kt), dwell at each terminal (s), acceleration (m/s²). */
        ferry: { speedKt: 13, dwell: 110, accel: 0.07 },
      },
      air: {
        /** Aircraft flying left-hand circuits for runway 36 (touch-and-go / full stop / go-around). */
        circuit: 3,
        /** GA aircraft on straight tracks across the area, and airliners at cruise. */
        crossing: 3,
        airliners: 3,
        helicopter: true,
        patternAltitudeFt: 1000,
        /** Downwind leg offset west of the runway centreline (m). */
        downwindOffset: 1150,
        crossingAltitudeFt: [2500, 6500] as [number, number],
        airlinerAltitudeFt: [30000, 38000] as [number, number],
        /** Aircraft meshes within this distance (m); a lit dot beyond, hidden past dotDistance. */
        meshDistance: 4000,
        dotDistance: 30000,
        /** Contrails: age (s) at which a persistent trail has faded out. */
        contrailMaxAge: 170,
      },
    },
    /** Sea, bay, river and lakes (owned by src/world/water). */
    water: {
      /** Surface wind over the water: speed (kt) and the direction it blows FROM (deg true). */
      windKt: 12,
      windFromDeg: 215,
      /** Analytic (Gerstner) wave trains shared by the shader and waterSurfaceAt; seed of their phases/directions. */
      waveCount: 12,
      waveSeed: 7,
      /** Gerstner choppiness (0 = sine waves, 1 = sharpest crests without loops). */
      choppiness: 0.55,
      /** Whitecap amount (1 ≈ Monahan's coverage for the wind speed). */
      whitecaps: 1,
      /** Bathymetry clipmap around the camera: texels per side, extents of the near/far levels (m). */
      bathymetryRes: 256,
      bathymetryNear: 4096,
      bathymetryFar: 36864,
      /** Re-bake a level when the camera is this fraction of its extent from the level centre. */
      bathymetryRecenter: 0.14,
      /** Surf: foam bands this far out from the shoreline (m) and the breaker period (s). */
      surfWidth: 60,
      surfPeriod: 7.5,
      /** River flow speed in the plains and in steep reaches (m/s), and the slope where rapids (foam) begin. */
      riverSpeed: 0.8,
      riverSpeedSteep: 3.2,
      rapidsSlope: 0.004,
      /** River ribbon: depth pull toward the camera (fraction of the view distance) and lift per km of distance (m). */
      riverDepthPull: 0.006,
      riverLiftPerKm: 1.2,
      /** Rivers stay at least this many pixels wide at any distance (coverage-faded, never dashed). */
      riverMinPixels: 1.4,
      /** Lakes: 1 = mirror calm on windless mornings (morning/dawn presets), 0 = as windy as midday. */
      lakeMorningCalm: 0.85,
      /** Detail normal tile (baked once from an ocean spectrum): texels per side. */
      detailTileSize: 256,
    },
    /** Road traffic: moving cars, trucks, buses and tractors, parked cars (owned by src/world/cars; system cars.ts). */
    cars: {
      /** Every choice (spawns, vehicle types, colours, routes) is a hash of this seed + counters; the clock pauses with the sim. */
      seed: 5309,
      /** Fixed simulation step, s (poses are extrapolated between steps). */
      step: 1 / 20,
      /** Moving traffic lives within this distance of the camera (m); it is released beyond despawnRadius. */
      radius: 2600,
      despawnRadius: 2900,
      /** New cars appear at least this far from the camera (m) once the first fill is done (or behind it). */
      spawnHideDistance: 700,
      /** Pool sizes: moving vehicles (a semi counts once) and parked cars. */
      maxMoving: 420,
      maxParked: 1400,
      /** Moving vehicles per km per direction by road kind (farm tracks: tractors only). */
      density: { highway: 9, road: 5, access: 3, lane: 1.6, street: 3.2, drive: 0 },
      /** Village/hamlet streets (no sidewalks) carry this fraction of the street density. */
      villageStreetFactor: 0.45,
      /** Tractors driving on farm tracks near the camera (at most). */
      tractors: 5,
      /** Parked cars: fraction of kerb slots taken, slot pitch (m), kept clear of junction boxes (m); drawn within parkedRadius (m). */
      parkedFill: 0.42,
      parkedPitch: 6.4,
      parkedJunctionClear: 7,
      parkedRadius: 1100,
      /** Detailed models within nearDistance (m); simple ones beyond, moving cars to farDistance, parked to parkedRadius. */
      nearDistance: 300,
      farDistance: 2600,
      /** Contact shadows (AO + a soft sun shadow) within this distance, m. */
      shadowDistance: 1400,
      /** Intelligent-driver model: desired time gap (s), jam gap (m), comfortable accel / decel (m/s²), emergency decel. */
      idm: { timeHeadway: 1.5, minGap: 2.2, accel: 1.8, decel: 2.4, maxDecel: 8 },
      /** Comfortable lateral acceleration in curves and turns, m/s²; slowest turn speed, m/s. */
      lateralAccel: 2.3,
      minTurnSpeed: 2.8,
      /** Drivers' desired speed as a fraction of the limit (uniform in this range). */
      speedFactor: [0.93, 1.08] as [number, number],
      /** Headlights/tail lights come on below this sun elevation (deg), fully by lightsFullDeg. */
      lightsOnDeg: 14,
      lightsFullDeg: 4,
      /** A vehicle stopped this long (s) out of sight is released (gridlock safety valve). */
      stuckTimeout: 60,
    },
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
    /** Tone-mapping exposure (scene radiance → display). */
    exposure: 2.2,
    /** Top-of-atmosphere sun illuminance in three.js light units; the sun light, sky and haze all scale with it. */
    sunIntensity: 3.2,
    /** Sunlight colour above the atmosphere (linear RGB) — effectively the camera white balance. */
    sunColor: [0.92, 0.98, 1.08] as [number, number, number],
    /** Multiplier on scene.environment (the PMREM sky) = the sky-ambient light on PBR materials. */
    skyAmbientIntensity: 0.9,
    /**
     * Aerial perspective = the aerosol (Mie) haze of the sky model: extinction at sea level (per metre)
     * and its height falloff (per metre, 1/scale height). Rayleigh (blue) scattering is added on top.
     */
    fogDensity: 0.00003,
    fogHeightFalloff: 0.0007,
    /** Distance at which things are fully hazed out (m) — also the terrain draw distance. */
    visibility: 60000,
    /** Multiplier on Earth's Rayleigh scattering (1 = standard atmosphere). */
    rayleighScale: 1.0,
    /** Aerosol single-scattering albedo. */
    mieAlbedo: 0.9,
    /** Aerosol phase-function asymmetry: how tight/bright the glow around the sun is. */
    mieDirectionalG: 0.8,
    /** Isotropic multiple-scattering approximation strength (brightens/whitens the horizon). */
    multiScatter: 0.4,
    /** Legacy Preetham parameters (unused by the physical sky; kept for compatibility). */
    turbidity: 3.2,
    rayleigh: 1.4,
    mieCoefficient: 0.004,
    shadowMapSize: 2048,
    /** Half-size of the sun shadow frustum around the aircraft, m. */
    shadowExtent: 160,
    /**
     * Fair-weather cumulus field: `count` clouds in a square tile of half-size `areaRadius` that repeats
     * around the camera. Bases at `baseAltitude` (m MSL, ±100 m), tops up to base + `thickness`.
     * `wind` = drift of the whole field (m/s, +x east, +z south): clouds and their shadows move with it.
     */
    clouds: {
      coverage: 0.42,
      baseAltitude: 1500,
      thickness: 2000,
      count: 420,
      areaRadius: 38000,
      wind: [5, 2] as [number, number],
      /**
       * Raymarched clouds (render.cloudMode 'volumetric'): extinction at full density (1/m), erosion of the
       * base shape by the shape (150–600 m lobes) and detail (25–200 m billows) noise, light calibration of
       * the multiple-scattering approximation, max march distance (m), weather-map resolution (texels per
       * tile side) and the temporal accumulation weight of each new frame.
       */
      volumetric: {
        sigma: 0.05,
        shapeErosion: 0.85,
        detailErosion: 0.35,
        sunScale: 8,
        ambientScale: 1,
        maxDistance: 50000,
        weatherSize: 2048,
        temporalAlpha: 0.12,
      },
    },
    /** Cloud shadows on every material (fog-chunk override): strength = 1 − brightness in full shadow; map texels per tile side. */
    cloudShadows: { enabled: true, strength: 0.42, size: 1024 },
    /** High thin cirrus wisps drawn in the sky shader. */
    cirrus: { altitude: 9000, coverage: 0.45, opacity: 0.55, scale: 1 / 45000 },
    /** Apparent sun radius (the real sun is 0.2666°). */
    sunAngularRadiusDeg: 0.2666,
    /** Re-bake the PMREM environment when the camera altitude changes by more than this (m). */
    envRebakeAltitudeStep: 600,
    /**
     * Shadow depth bias along the light ray and normal-offset bias, both in METRES (converted to the
     * shadow camera's depth range; the sign is flipped automatically for a reversed depth buffer).
     */
    shadowBias: 0.08,
    shadowNormalBias: 0.14,
    /** Distance from the focus to the shadow camera toward the sun, and the total depth it covers (m). */
    shadowLightDistance: 800,
    shadowDepthRange: 4000,
    /** PCF filter radius in shadow-map texels (soft edges). */
    shadowRadius: 2,
  },

  // ─── Rendering quality (owned by src/render) ────────────────────────────────
  render: {
    /** Cap on devicePixelRatio (Retina at 2× is very expensive for a full-screen 3D scene). */
    maxPixelRatio: 1.5,
    antialias: true,
    /** Dynamic resolution: scale pixel ratio down when the frame rate drops below target. */
    targetFps: 60,
    minPixelRatio: 0.75,
    dynamicResolution: true,
    /** Linear-HDR render target (RGBA16F + 32-bit float reversed depth) + output pass. */
    hdr: true,
    /** MSAA samples of the HDR target. */
    msaaSamples: 4,
    /**
     * 'filmic' (Filmic Neutral: Khronos Neutral's hue-preserving shoulder without its shadow-crushing toe) |
     * 'neutral' | 'aces' | 'agx'. ACES bleaches the golden-hour glow; AgX is flat; Neutral crushes shadows.
     */
    toneMapping: 'filmic',
    /** Output grade: corner darkening 0..1 and saturation (1 = unchanged). */
    vignette: 0.16,
    saturation: 1.0,
    lensFlare: { enabled: true, glare: 1.0, ghosts: 0.015, starburst: 0.06 },
    /**
     * Clouds: 'volumetric' (raymarched, falls back to billboards automatically when over budget),
     * 'billboard' (instanced puff sprites) or 'off'. URL override: ?clouds=volumetric|billboard|off.
     */
    // Volumetric is opt-in until its pass fits the budget (measured 3–5 ms at 0.5 res on the M2 Max; see RESUME/report).
    cloudMode: 'billboard' as 'volumetric' | 'billboard' | 'off',
    /** Volumetric cloud buffer size per axis relative to the CSS resolution (0.5 = quarter the pixels). */
    cloudResolution: 0.5,
    /** GPU ms the volumetric cloud pass may take before the budget controller degrades it. */
    cloudBudgetMs: 2.5,
  },

  // ─── Audio (owned by src/audio) ─────────────────────────────────────────────
  audio: {
    masterVolume: 0.6,
    engineVolume: 0.47,
    windVolume: 0.35,
    stallHornVolume: 0.4,
    /** Tyre rumble on the ground and brake scrub. */
    rollingVolume: 0.32,
    /** One-shots: touchdown chirp/thump, gear clunk, crash boom and debris. */
    effectsVolume: 0.7,
    /** Gear hydraulic pump hum and flap motor whine (cabin sounds). */
    motorVolume: 0.16,
    /** Lycoming O-360 (4 cylinders, 4-stroke → 2 firings per revolution) and a 2-blade McCauley prop. */
    cylinders: 4,
    propBlades: 2,
    /** Engine exhaust loudness at idle power, relative to full power. */
    idleLoudness: 0.42,
    /** Below this rpm the running engine fades out (it is not firing yet). */
    firingMinRpm: 250,
    /** Low-pass cutoff of the "cabin" (cockpit view) and of the open exterior sound, Hz. */
    cabinCutoffHz: 850,
    exteriorCutoffHz: 16000,
    /** Exterior views: full level within refDistanceM, inverse-distance beyond; the high end is absorbed with distance. */
    refDistanceM: 15,
    /** Distance at which the exterior cutoff has halved (air absorption), m. */
    absorptionHalfM: 350,
    /** Gain of cabin-only sounds (horn, motors, whistle) heard from outside the aircraft. */
    exteriorCabinGain: 0.1,
    speedOfSoundMs: 340,
    /** Wind noise: full level at windFullKt; band-pass centre sweeps windMinHz → windMaxHz up to windTopKt. */
    windFullKt: 140,
    windMinHz: 260,
    windMaxHz: 2400,
    windTopKt: 180,
    /** Cockpit door-seal whistle: narrow band at whistleHz, fading in between whistleStartKt and whistleFullKt. */
    whistleHz: 2650,
    whistleStartKt: 55,
    whistleFullKt: 135,
    whistleVolume: 0.05,
    /** Rolling rumble reaches full level at rollingFullKt; relative roughness per surface. */
    rollingFullKt: 60,
    surfaceRumble: { runway: 0.45, asphalt: 0.5, grass: 0.85, dirt: 0.9, field: 1, forest: 1, rock: 1, snow: 0.55, sand: 0.8, urban: 0.6, water: 0.7 },
    /** Stall warning: a pneumatic reed horn (~1600–2000 Hz, nasal) through a band-pass. Needs airflow to sound. */
    stallHornHz: 1780,
    stallHornQ: 4.5,
    stallHornMinKt: 12,
    /**
     * Landing-gear warning horn (172RG): an electronic intermittent tone through the cabin speaker —
     * lower and beeping, unmistakably different from the continuous reed stall horn.
     */
    gearHornHz: 620,
    gearHornRateHz: 2.4,
    /** Fraction of each beep period the tone is on. */
    gearHornDuty: 0.52,
    gearHornVolume: 0.3,
    /** Touchdown chirp/thump: faint at touchdownMinFpm, full at touchdownFullFpm (magnitudes). */
    touchdownMinFpm: 40,
    touchdownFullFpm: 700,
    /** Gain/filter ramp time constants for setTargetAtTime, seconds (no clicks). */
    rampTau: 0.045,
    cameraRampTau: 0.12,
    /** Gentle glue compressor on the master (above ~−10 dBFS only), then a fast limiter + a soft clipper → never > 0 dBFS. */
    glueThresholdDb: -10,
    glueRatio: 2.5,
    limiterThresholdDb: -3,
    /** The soft clipper is linear up to this level, then bends smoothly towards softClipCeiling. */
    softClipKnee: 0.7,
    softClipCeiling: 0.97,
    /** Crash sound design (layered impact, metal tearing, debris, scraping, secondary explosions, fire). */
    crash: {
      /** Crash sounds keep full level within refDistanceM of the camera, then fall as (ref/d)^distanceExponent. */
      refDistanceM: 40,
      distanceExponent: 0.8,
      /** Secondary explosions after the impact (unless the crash effects dispatch `sim:explosion` themselves). */
      secondaryMin: 2,
      secondaryMax: 6,
      /** First one once the impact has died down; then random gaps (mean, minimum); none after secondaryLastS. */
      secondaryFirstS: 1.1,
      secondaryMeanGapS: 1.6,
      secondaryMinGapS: 0.7,
      secondaryLastS: 11,
      /** Burning fire bed level and its fade time constant, s. */
      fireLevel: 0.5,
      fireFadeS: 35,
      /** Rate limits for the window events `sim:explosion` / `sim:impact`, per second. */
      maxExplosionsPerS: 6,
      maxImpactsPerS: 12,
      /** `sim:impact` speed (m/s) that plays at full intensity. */
      impactFullMs: 45,
    },
    /**
     * F-16C / GE F110-GE-129 turbofan (aircraft sound 'jet'). `state.engine.rpm` is the core speed N2 in %,
     * `state.engine.power` the dry power 0..1 and `state.engine.afterburner` 0..1.
     */
    jet: {
      /** HP (core) spool at 100 % N2 and LP (fan) spool at 100 % N1, rpm. */
      coreMaxRpm: 14460,
      fanMaxRpm: 7900,
      /** Blades of the HP-compressor stage whose blade-pass tone is the turbine whine (100 % N2 ≈ 5 kHz). */
      whineBlades: 21,
      /** Ground idle N2, %. */
      idleCorePct: 70,
      /** Overall level of the jet relative to the Cessna's engine (a fighter is much louder), and in the cockpit (canopy + helmet). */
      volume: 2.3,
      cockpitGain: 0.42,
      /** Channel levels before engineVolume × volume. */
      whine: 0.09,
      shaft: 0.04,
      fan: 0.11,
      roar: 0.75,
      rumble: 0.5,
      abRumble: 1.5,
      abTear: 0.55,
      crackle: 0.65,
      /** Cockpit-only: intake howl (fan tone resonating in the inlet duct under the seat) and ECS air hiss. */
      intake: 0.1,
      ecs: 0.035,
      /** Jet fuel starter whine while starting. */
      starter: 0.08,
      /** Afterburner light-off "whoomph" level. */
      whoomph: 0.9,
      /** Hydraulic whine (gear and speed brake), Hz, level, and how long the speed brake travels, s. */
      hydraulicHz: 1180,
      hydraulicVolume: 0.12,
      speedBrakeTravelS: 2,
      /** Exterior views: full level within this distance (a 15 m airframe, a much louder source than the Cessna). */
      refDistanceM: 25,
    },
  },

  // ─── HUD (owned by src/ui) ──────────────────────────────────────────────────
  hud: {
    /**
     * On-screen G meter (every aircraft): a round accelerometer with max/min tell-tales and red marks
     * at the aircraft's own limits. Size and top-left position in CSS px; needle smoothing, s;
     * caution from this fraction of the limit; redraws per second.
     */
    gMeter: { size: 112, left: 16, top: 84, tau: 0.06, cautionFraction: 0.8, redrawHz: 30 },
    /** Vertical speed indicator lag time constant, seconds (real VSIs lag). */
    vsiLagTau: 0.8,
    /** Instrument needle smoothing time constant, seconds. */
    needleTau: 0.12,
    /** Turn coordinator gyro smoothing, seconds. */
    turnTau: 0.3,
    /** Inclinometer ball damping (it sits in a liquid-filled tube), seconds. */
    ballTau: 0.3,
    /** Tilt of the apparent gravity (deg) that puts the ball at the end of its tube. */
    ballRangeDeg: 12,
    /** Toe-brake input above this lights the BRAKE lamp. */
    brakeLampThreshold: 0.05,
    /** Readings are clamped to these (the gauges peg there). */
    maxAirspeedKt: 250,
    maxVsiFpm: 6000,
    maxTurnRateDegPerSec: 30,
    maxG: 12,
    /** Altimeter setting shown in the Kollsman window, inHg. */
    kollsmanInHg: 29.92,
    /** Tachometer green arc (the 172RG's normal operating range), rpm. */
    tachGreenLowRpm: 2100,
    tachGreenHighRpm: 2700,
    /** Gauge diameter (CSS px) at 1024 and 1440 px viewport width, linear in between; clamped to min/max. */
    gaugeSize1024: 96,
    gaugeSize1440: 126,
    gaugeMin: 72,
    gaugeMax: 150,
    /** A gauge is never taller than this fraction of the viewport height. */
    gaugeMaxHeightFraction: 0.16,
    /** Cap on the HUD canvases' devicePixelRatio. */
    maxPixelRatio: 2,
    /** In cockpit view the 3D panel shows the six-pack: 'hidden' drops the HUD clusters, 'compact' keeps small ones. */
    cockpitGauges: 'hidden' as 'hidden' | 'compact',
    /** Seconds the landing toast, a generic flash and the start hint stay up. */
    landingToastSeconds: 7,
    flashSeconds: 2.2,
    startHintSeconds: 12,
    /** STALL annunciator blink rate, Hz. */
    stallBlinkHz: 2.5,
    /**
     * Landing-gear warning, as on the real 172RG: with the gear not down and locked in flight, the
     * horn sounds (and the red GEAR annunciator flashes) when the throttle is pulled back below
     * throttleBelowPct or the flaps reach flapsAtOrAboveDeg. With the handle UP on the ground the
     * squat switch holds the gear down and the horn sounds (amber GEAR — SQUAT SWITCH).
     * VLO = max speed with the gear in transit (VLE, gear down, is config.aircraft.gear.vleKt).
     */
    gearWarning: { throttleBelowPct: 15, flapsAtOrAboveDeg: 20, vloKt: 140, blinkHz: 2 },
    /** Gauges drawn smaller than this (CSS px) use a simplified face: fewer, larger numerals, no small print. */
    simpleFaceBelowPx: 112,
    /**
     * Start-up loading veil (src/ui/veil.ts). It is "ready" after smoothFrames consecutive frames
     * shorter than smoothFrameMs (or maxWarmupS after the first frame, whatever happens), then fades
     * out by itself autoDismissS later — or at once on the first key/click (which also unlocks audio).
     * `?veil=0` skips it. Whatever happens (the app failed to start…) it lifts after maxTotalS.
     */
    veil: { autoDismissS: 1.5, fadeS: 0.8, smoothFrameMs: 34, smoothFrames: 24, maxWarmupS: 6, maxTotalS: 40 },
    /**
     * F-16 head-up display (src/ui/jetHud.ts), shown instead of the six-pack when the aircraft's
     * `hud` is 'jet'. Phosphor green with a faint dark halo so it reads against bright sky. Its box
     * is a fraction of the viewport (clamped in px); `degPerHeight` = pitch degrees across its height.
     */
    jet: {
      color: '#6bff95',
      halo: 'rgba(0,26,8,0.42)',
      widthFrac: 0.4,
      heightFrac: 0.6,
      minW: 330,
      maxW: 600,
      degPerHeight: 38,
      /** Boresight (gun cross) height as a fraction of the HUD box. */
      boresightY: 0.34,
    },
    /** Slim branding top bar (logo, name, aircraft picker, menu button): its height in CSS px at 1024 and 1440 px wide. */
    topBar: { height1024: 36, height1440: 40 },
  },

  // ─── Menu, aircraft picker and branding (owned by src/ui: menu.ts, picker.ts, topBar.ts) ───────
  menu: {
    productName: "Tater's Flight Sim",
    fullName: 'Tater Tots Flight Simulator',
    /** localStorage key that remembers the chosen aircraft (restored when the URL has no ?aircraft=). */
    storageKey: 'tfs.aircraft',
    /** Throttle position (%) above which the F-16's afterburner lights (shown in the controls notes). */
    afterburnerFromPct: 90,
  },

  // ─── Effects: particles, camera shake, speed FOV (owned by src/fx) ─────────
  fx: {
    /** Seed of the effects RNG (deterministic bursts for tests and screenshots). */
    seed: 1721,
    /** Preallocated pools: smoke/dust, fire/embers (one sorted draw call together) and solid debris chunks. */
    smokeCapacity: 1800,
    fireCapacity: 1100,
    debrisCapacity: 64,
    /** Continuous emitters (part fires, the smoke column, steam), preallocated. */
    maxEmitters: 24,
    /** Particles fade out when the camera is closer than size × nearFade (no screen-filling sprites). */
    nearFade: 0.55,
    /** …and fade (with the square of the excess) once one sprite would cover more than this fraction of the screen height. */
    maxScreenCover: 0.45,
    /**
     * Fire: HDR emission scale of the blackbody ramp (src/fx/shading.ts), and how much the hottest
     * flame still occludes what is behind it (0 = pure additive glow, 1 = opaque). Sooty edges are opaque.
     */
    fireIntensity: 2.4,
    fireOcclusion: 0.55,
    /** Sparks/embers: emission × fireIntensity; drawn as streaks over this exposure time (s). */
    sparkIntensity: 1.5,
    shutter: 0.02,
    /** Sprites smaller than this many pixels grow to it with opacity × (size/min)² (far fires stay visible as points). */
    minPixels: 1.5,
    /** Smoke self-shadowing strength 0..1 (2-tap density toward the sun). */
    selfShadow: 0.85,
    /** Fire light on smoke uses at least this albedo (black smoke still glows orange from below at night). */
    glowFloor: 0.1,
    /** Fire light on the smoke above it (linear RGB per unit glow): daylight swamps it, dusk shows the orange underside. */
    smokeGlow: [0.4, 0.15, 0.035] as [number, number, number],
    /** Side of the tiling animated-noise texture, px. */
    noiseSize: 128,
    /** A single point light flickers at the fire (lights the ground and the wreck). Always present (intensity 0 when idle) so no shader recompiles. */
    fireLight: true,
    fireLightIntensity: 150,
    fireLightDistance: 140,
    /** The white-hot flash of an explosion lights the scene through the same point light (candela at flash level 1). */
    flashLightIntensity: 1600,
    crash: {
      /** Below this impact speed there is no fireball (fuel tanks survive) — only dust, debris and a little smoke. */
      fireMinKt: 25,
      /** Fuel fireball: a short-lived rolling ball of flame (puffs grow to fireballSize m) that turns into a black mushroom. */
      fireballCount: 80,
      fireballLife: [1.2, 2.4] as [number, number],
      fireballSize: [7, 16] as [number, number],
      fireballSpeed: 14,
      /** Lingering smoke column: emitted for smokeDuration s (rate decays), each puff lives smokeLife s. */
      smokeDuration: 20,
      smokeRate: 12,
      smokeLife: [20, 32] as [number, number],
      /** Puff diameter at birth and fully grown (time constant smokeGrowTau s): the plume widens as it rises. */
      smokeSize: [5, 36] as [number, number],
      smokeGrowTau: 9,
      /** Initial rise (m/s) and sustained buoyancy (m/s², decaying with smokeBuoyancyTau s): a column climbs ~200 m. */
      smokeRise: 8,
      smokeBuoyancy: 3,
      smokeBuoyancyTau: 25,
      /** Horizontal/vertical velocity relaxation toward the wind, 1/s (bends the column downwind). */
      smokeDrag: 0.28,
      /** Thick oily smoke albedo near the fire (warm-black via smokeTint), lightening with age (×(1 + smokeLighten·t)). */
      smokeAlbedo: 0.04,
      smokeLighten: 2.5,
      smokeTint: [1.1, 1.0, 0.88] as [number, number, number],
      /** Ground fire: many small, short flame licks and billows at the wreck (flames/s at full intensity). */
      groundFireDuration: 16,
      groundFireRate: 55,
      /** Fires on burning parts: flame licks per second (× intensity, grows with the part's size) and smoke puffs per second. */
      partFireRate: 45,
      partSmokeRate: 7,
      debrisCount: 30,
      emberCount: 80,
    },
    /**
     * Fires (addFire, crash ground fires): the flame height scale L = radius × (heightPerRadius[0] +
     * heightPerRadius[1] × intensity) (≤ maxHeight m); flames are a mix of broad bodies, tall
     * tongues and rolling billows (the rest), each ≤ maxFlameSize m across.
     */
    fire: {
      heightPerRadius: [1.0, 1.0] as [number, number],
      maxHeight: 7,
      maxFlameSize: 4.2,
      bodyShare: 0.4,
      tongueShare: 0.4,
    },
    touchdown: {
      /** Puffs per main wheel at a feather-light and at a hard touchdown. */
      minPuffs: 2,
      maxPuffs: 8,
      life: [0.8, 1.8] as [number, number],
      /** Final puff diameter at a soft / hard touchdown, m. */
      softSize: 0.9,
      hardSize: 2.6,
      /** Peak opacity at a soft / hard touchdown. */
      softAlpha: 0.12,
      hardAlpha: 0.45,
      /** Tyre smoke on pavement; dust on soft ground; spray on water. */
      smokeAlbedo: [0.72, 0.73, 0.75] as [number, number, number],
      dustAlbedo: [0.46, 0.38, 0.28] as [number, number, number],
      grassAlbedo: [0.38, 0.4, 0.27] as [number, number, number],
      sprayAlbedo: [0.85, 0.88, 0.9] as [number, number, number],
      /** fpm (magnitude) at which the puffs reach full size/count. */
      fullFpm: 700,
    },
    /** Camera shake intensities (0..1, fed to CameraInput.shake — the rig squares it). */
    shake: {
      rollMax: 0.42,
      rollFullKt: 65,
      surfaceRoughness: { runway: 0.45, asphalt: 0.5, grass: 0.85, dirt: 0.9, field: 1, forest: 1, rock: 1, snow: 0.6, sand: 0.8, urban: 0.65, water: 0.7 },
      /** Stall buffet begins buffetMarginDeg below the stall AoA and is full buffetPastDeg past it. */
      buffetMax: 0.55,
      buffetMarginDeg: 3,
      buffetPastDeg: 2,
      /** Airframe vibration between overspeedStart·Vne and overspeedFull·Vne. */
      overspeedMax: 0.4,
      overspeedStart: 0.9,
      overspeedFull: 1.08,
      /** Crash shake starts at 1 and decays at this rate, 1/s. */
      crashDecay: 1.6,
    },
    /** Subtle FOV widening with airspeed (degrees added to the camera FOV). */
    fov: { startKt: 55, fullKt: 170, maxDeg: 3.5 },
  },
  /**
   * The crash director (src/crash + src/game/systems/crash.ts): the airframe breaks into rigid
   * bodies that keep the aircraft's momentum, a multi-stage fireball, slow motion and a crash camera.
   */
  crash: {
    /** Impact speed (kt) below which nothing breaks off, and at which the break-up/explosion is total. */
    bumpKt: 22,
    fullKt: 110,
    /** Flight-path angle (deg below the horizon) from which an impact counts as nose-in rather than a skid. */
    noseInDeg: 28,
    debris: {
      /** Rigid bodies (airframe parts), preallocated. */
      capacity: 32,
      gravity: 9.81,
      /** Largest integration step, s (the sim sub-steps longer frames). */
      subStep: 1 / 120,
      /** Linear air drag (1/s), spin damping in the air and on the ground (1/s), ploughing drag while sliding (1/s). */
      airDrag: 0.03,
      spinDrag: 0.12,
      groundSpinDrag: 1.4,
      ploughDrag: 0.12,
      /** Impacts slower than this (m/s) do not bounce (no jitter at rest). */
      bounceMinSpeed: 2,
      /** A body falls asleep after sleepTime s in contact below sleepSpeed m/s and sleepSpin rad/s; every body rests after maxAge s. */
      sleepSpeed: 0.3,
      sleepSpin: 0.4,
      sleepTime: 0.5,
      maxAge: 60,
      maxSpeed: 250,
      maxSpin: 30,
      /** Trees/buildings: velocity damping (1/s) while a part is inside an obstacle's height. */
      canopyDrag: 2.4,
      /** Water: drag (1/s) when submerged, speed kept when slapping into the surface, depth (m) below which a part is gone. */
      waterDrag: 2.2,
      waterImpactKeep: 0.55,
      sinkDepth: 2.5,
    },
    /** Explosion push: speed (m/s) for a refMass-kg part at full severity (∝ √(refMass/mass)), cap, random spin (rad/s). */
    explosion: { speed: 9, refMass: 60, maxDv: 24, spin: 6 },
    /** Slow motion: the debris and effects run at `scale` for `hold` s of real time, then ease back to real time over `ramp` s. */
    slowMo: { scale: 0.3, hold: 0.9, ramp: 0.8 },
    camera: {
      /** Extra hand-held shake at impact (m, deg), decaying with shakeTau s. */
      shakeM: 0.45,
      shakeDeg: 1.6,
      shakeTau: 0.45,
      /** The crash camera takes over between blendStart and blendEnd s (real time) after the impact (cockpit: at once). */
      blendStart: 0.5,
      blendEnd: 3.2,
      orbitDegPerSec: 3.5,
      elevationDeg: 19,
      /** Distance frames the debris field: clamp(spread × fitScale, minDistance, maxDistance) m. */
      minDistance: 38,
      maxDistance: 150,
      fitScale: 2.6,
      /** Smoothing of the framed point, s. */
      focusTau: 0.7,
    },
    fire: {
      /** Burning parts burn for this long (s); the smoke column rises for columnDuration s. */
      partDuration: [20, 30] as [number, number],
      columnDuration: 45,
      /** Secondary fuel explosions (s after impact, sim time) along the debris trail. */
      secondary: [0.28, 0.7] as [number, number],
    },
    scorch: {
      /** Decal pool size, crater radius range (m) and furrow width (m). */
      count: 6,
      craterRadius: [4, 11] as [number, number],
      furrowWidth: 2.6,
    },
  },

  // ─── Weapons carried (owned by src/combat; per aircraft — see A10_WEAPONS / F16_WEAPONS) ─────
  /** The Cessna carries nothing. */
  weapons: { gun: null, missiles: null } as WeaponsConfig,

  // ─── Combat world: targets, damage, effects budgets (owned by src/combat) ───────────────────
  combat: {
    /**
     * The target range: vehicles are placed on open, flat ground (not water, towns or forest)
     * between minDistance and maxDistance from the runway centre, preferring the bearing
     * `bearingDeg` (north of the airport: straight ahead after a runway-36 take-off).
     */
    range: { bearingDeg: 350, minDistance: 5500, maxDistance: 9000, radius: 900 },
    /** Vehicle classes (real sizes). Armour multipliers are for the 30 mm API round. */
    targets: {
      tank: { name: 'T-72B', length: 6.95, width: 3.59, height: 2.23, health: 100, armor: { front: 0.05, side: 0.35, rear: 0.6, top: 0.8 }, speed: 8 } as TargetClassConfig,
      ifv: { name: 'BMP-2', length: 6.72, width: 3.15, height: 2.45, health: 60, armor: { front: 0.5, side: 0.9, rear: 1, top: 1 }, speed: 9 } as TargetClassConfig,
      apc: { name: 'BTR-80', length: 7.65, width: 2.9, height: 2.41, health: 50, armor: { front: 0.7, side: 1, rear: 1, top: 1 }, speed: 11 } as TargetClassConfig,
      truck: { name: 'Ural-4320', length: 7.37, width: 2.55, height: 2.87, health: 25, armor: { front: 1, side: 1, rear: 1, top: 1 }, speed: 12 } as TargetClassConfig,
      aaa: { name: 'ZSU-23-4 Shilka', length: 6.54, width: 3.13, height: 2.25, health: 45, armor: { front: 0.8, side: 1, rear: 1, top: 1 }, speed: 7 } as TargetClassConfig,
    },
    /** Destroyed vehicles come back after a reset (R) or after this long, s (0 = only on reset). */
    respawnS: 0,
    /** Live projectile pool (rounds in flight) and impact effects per frame, max. */
    maxRounds: 1500,
    maxImpactFxPerFrame: 24,
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

// ─── Fleet: other flyable aircraft (owned by src/physics + src/fleet) ───────────
// Each aircraft has a section with EXACTLY the shape of CONFIG.aircraft, so the physics,
// cameras and instruments work unchanged: pass `{ ...CONFIG, aircraft: F16_AIRCRAFT }`.

/**
 * General Dynamics F-16C Fighting Falcon (Block 50, F110-GE-129).
 *
 * GEOMETRY IS FIXED (orchestrator contract, real dimensions: 15.06 m long, 9.96 m span with
 * wingtip rails, 4.88 m tall, 4.00 m wheelbase, 2.36 m track): the 3D model and the physics
 * contact points both read it. Body frame: origin = CG, +X right, +Y up, −Z nose; wheels touch
 * the ground at y = −1.75 with the struts extended.
 *
 * Flight model (src/physics): F110 turbofan with afterburner (engine.type 'jet'), a CLα ≈ 3.5/rad
 * wing whose leading-edge-extension vortex lift carries CLmax ≈ 1.6 to ~32° α, transonic drag rise,
 * speed brake, flaperons that droop 20° with the gear handle, and fly-by-wire (g / roll-rate
 * command, 25° AoA limiter, sideslip-zeroing yaw loop). Calibration: src/physics/aircraft.ts header.
 * Stability derivatives after Stevens & Lewis / Nguyen et al. (NASA TP-1538), rounded.
 */
function makeF16(): AircraftConfig {
  const c172 = CONFIG.aircraft;
  return {
    name: 'F-16C Fighting Falcon',
    registration: '90-0772',
    /** Clean, full internal fuel (~3,200 kg), pilot, gun ammo. */
    mass: 12000,
    inertia: { pitch: 75674, yaw: 85552, roll: 12875 },
    wingArea: 27.87,
    wingSpan: 9.96,
    meanChord: 3.45,
    oswald: 0.8,

    aero: {
      /** Cambered (LEF-scheduled) wing: CL at zero body α. */
      cl0: 0.1,
      clAlpha: 3.5,
      /** Vortex lift from the strakes keeps the lift rising to CLmax ≈ 1.6 at ~32°. */
      stallAlphaDeg: 32,
      stallAlphaNegDeg: -20,
      stallRoundingDeg: 14,
      stallBreakWidthDeg: 15,
      flatPlateLift: 1.3,
      flatPlateDrag: 1.7,
      cd0: 0.0185,
      cdGear: 0.02,
      /** Flaperons 20° (gear handle down). */
      cdFlapsFull: 0.02,
      clFlapsFull: 0.3,
      stallAlphaFlapsShiftDeg: 0,
      cmFlapsFull: -0.03,
      cdBeta: 0.4,
      cyBeta: -1.0,
      cyRudder: -0.1,
      /** Relaxed static stability: nearly neutral in pitch; the FBW does the rest. */
      cm0: 0,
      cm0Tail: 0,
      cmAlpha: -0.25,
      cmQ: -5,
      cmAlphaDot: -1.5,
      /** All-moving stabilator (~10 m², ±25°): big authority — it has to rotate against the thrust line. */
      cmElevator: 0.6,
      cmTrim: 0.05,
      clBeta: -0.06,
      clP: -0.35,
      clR: 0.1,
      /** Flaperons + differential stabilator. */
      clAileron: 0.05,
      clRudder: 0.01,
      cnBeta: 0.12,
      cnP: -0.02,
      cnR: -0.35,
      cnAileron: -0.004,
      cnRudder: 0.045,
      stripStallBlendDeg: 3,
      stripAsymOnset: 0.01,
      stripAsymFull: 0.05,
      stripAsymBeta: 0.3,
      stripAsymAileron: 0.05,
      wingStrips: 4,
      /** Leading-edge flaps, not twist, keep the outer wing flying. */
      washoutDeg: 0,
      stripStallBreakWidthDeg: 20,
      /** Low-aspect-ratio wing: weak autorotation (the F-16 is spin-resistant; the FBW keeps it out of it anyway). */
      stripRollGainStalled: 0.3,
      stripYawGain: 1,
      aileronSpanStart: 0.3,
      /** Past ~30° α the fin sits in the fuselage/strake wake (the F-16's famous loss of directional stability). */
      stallYawDampingLoss: 0.5,
      stallRudderLoss: 0.5,
      bodyCrossflowCn: 0.4,
      postStallFlapLiftFraction: 0.5,
      stallPitchBreak: -0.02,
      stallTailBlanking: 0.3,
      /** No propeller: nothing blows over the tail, no P-factor. */
      propwashTail: 0,
      propwashTailMaxRatio: 1,
      cmGroundEffect: 0.03,
      groundEffectLift: 0.12,
      groundEffectScale: 0.25,
      pFactor: 0,
      /** Two 60° petals beside the nozzle. */
      cdSpeedBrake: 0.06,
      transonic: { machCrit: 0.82, machPeak: 1.1, peakFactor: 2.4, factorAtMach2: 2.0, inducedGain: 0.7 },
    },

    engine: {
      type: 'jet',
      jet: {
        /** F110-GE-129: 17,155 lbf dry, ~29,000 lbf with afterburner (installed). */
        milThrustN: 76300,
        maxThrustN: 129000,
        idleThrustN: 3500,
        abDetent: 0.9,
        abMin: 0.3,
        abLightCore: 0.92,
        abRampUpPerSec: 1.0,
        abRampDownPerSec: 3,
        spoolUpTauIdle: 3.2,
        spoolUpTauMil: 0.6,
        spoolDownTau: 1.1,
        densityExponent: 0.8,
        lowSpeedLapse: 0.45,
        ramDry: 0.3,
        ramAb: 0.4,
        /** Nozzle centre, slightly below the CG (≈ 1.45 m above the runway). */
        thrustPoint: { x: 0, y: -0.3, z: 7.0 },
      },
      // Piston/prop keys unused by a jet except where noted.
      maxPowerW: 0,
      staticThrustN: 76300,
      propEfficiency: 1,
      spoolUpTau: 1,
      spoolDownTau: 1,
      idlePower: 0,
      /** Core speed (N2), % — what `state.engine.rpm` reports for a jet. */
      idleRpm: 70,
      maxRpm: 100,
      /** Jet fuel starter spin-up to light-off, s (shortened for play). */
      startTime: 6,
      /** Windmilling core % per knot with the engine off. */
      windmillRpmPerKt: 0.05,
      /** Starter-motored core %, before light-off. */
      crankRpm: 25,
      rpmTau: 0.35,
      spinDownTau: 3,
      windmillDragCoeff: 0,
    },

    flaps: {
      /** Flaperon droop, deg (they also come down automatically with the gear handle). */
      notchesDeg: [0, 10, 20],
      rateDegPerSec: 15,
      vfeKt: 370,
      autoWithGearDeg: 20,
      autoRetractKt: 370,
    },

    gear: {
      retractable: true,
      transitTime: 4,
      vleKt: 300,
      /** Gear operating speed, knots. */
      vloKt: 300,
      retractDelay: 1.5,
      squatSwitch: true,
    },

    surfaces: {
      elevatorMaxDeg: 25,
      aileronMaxDeg: 20,
      rudderMaxDeg: 30,
      flapMaxDeg: 20,
      trimTabMaxDeg: 0,
      nosewheelSteerMaxDeg: 32,
    },

    geometry: {
      ...c172.geometry,
    length: 15.06,
    height: 4.88,
    noseWheel: { x: 0, y: -1.75, z: -3.5 },
    leftMainWheel: { x: -1.18, y: -1.75, z: 0.5 },
    rightMainWheel: { x: 1.18, y: -1.75, z: 0.5 },
    mainWheelRadius: 0.35,
    noseWheelRadius: 0.23,
    strutTravel: 0.22,
    // No propeller: the "hub" is the intake mouth (keeps prop-wash maths finite until the jet model lands).
    propHub: { x: 0, y: -1.0, z: -2.95 },
    propRadius: 0.45,
    spinnerTip: { x: 0, y: -0.05, z: -9.2 },
    pilotEye: { x: 0, y: 1.0, z: -4.4 },
    wingRootLeadingEdge: { x: 0, y: -0.3, z: -1.9 },
    wingRootChord: 5.0,
    wingTipChord: 1.05,
    wingTaperStart: 0.8,
    dihedralDeg: 0,
    horizontalTail: { x: 0, y: -0.45, z: 4.9, span: 5.58, chord: 2.0 },
    verticalTailTop: { x: 0, y: 3.13, z: 5.6 },
    structuralPoints: [
      { name: 'noseTip', x: 0, y: -0.05, z: -8.6 },
      { name: 'radomeBelly', x: 0, y: -0.7, z: -6.4 },
      { name: 'intakeLip', x: 0, y: -0.85, z: -2.95 },
      { name: 'leftWingtip', x: -4.98, y: -0.35, z: 1.8 },
      { name: 'rightWingtip', x: 4.98, y: -0.35, z: 1.8 },
      { name: 'leftStab', x: -2.79, y: -0.55, z: 5.2 },
      { name: 'rightStab', x: 2.79, y: -0.55, z: 5.2 },
      { name: 'finTop', x: 0, y: 3.13, z: 5.6 },
      { name: 'tailcone', x: 0, y: -0.55, z: 5.4 },
      { name: 'leftVentral', x: -0.62, y: -0.85, z: 3.6 },
      { name: 'rightVentral', x: 0.62, y: -0.85, z: 3.6 },
      { name: 'bellyMid', x: 0, y: -0.8, z: 0.0 },
      { name: 'cabinRoof', x: 0, y: 1.25, z: -3.8 },
    ],
    },

    /** Visual-only (src/aircraft; the F-16 model owner may override). */
    model: structuredClone(c172.model),

    ground: {
      /** Struts sized for ~11× the Cessna's weight. */
      springMain: 650000,
      damperMain: 65000,
      springNose: 420000,
      damperNose: 38000,
      rollingFriction: { ...c172.ground.rollingFriction },
      /** Anti-skid brakes. */
      brakeFriction: 0.45,
      lateralFriction: 0.7,
      frictionSmoothing: 0.25,
      /** Nosewheel steering is for taxiing: its authority fades out by ~50 kt. */
      steeringFadeSpeed: 25,
      steeringMinFraction: 0.08,
      longitudinalSmoothing: 0.05,
      bottomOutStiffness: 10,
      reboundDampingFactor: 3,
      tailSkidFriction: 0.4,
    },

    fbw: {
      maxG: 9,
      minG: -3,
      aoaLimitDeg: 25,
      aoaLimitGearDownDeg: 16,
      minAoaDeg: -10,
      maxRollRateDeg: 300,
      maxRollRateGearDownDeg: 120,
      rollAoaStartDeg: 10,
      rollAtAoaLimitFraction: 0.25,
      betaLimitStartDeg: 3,
      betaLimitFullDeg: 8,
      rollShaping: 0.6,
      pitchShaping: 0.5,
      pathRateGearDownDeg: 6,
      bankCompensationDeg: 45,
      pitchOmega: 5,
      pitchZeta: 0.8,
      rollTau: 0.12,
      yawOmega: 3,
      yawZeta: 0.8,
      pedalBetaDeg: 6,
      groundElevatorGain: 0.5,
      groundPitchRateGain: 10,
      groundPitchRateDeg: 5,
      /** Tail clearance: the tailcone meets the runway at ≈ 13.5° with the struts compressed. */
      groundPitchLimitDeg: 12,
      groundPitchProtectGain: 2,
      liftoffBlendS: 1,
    },

    limits: {
      vsoKt: 115,
      vs1Kt: 130,
      vrKt: 150,
      vxKt: 250,
      vyKt: 350,
      vaKt: 350,
      vnoKt: 600,
      /** 800 KCAS placard. */
      vneKt: 800,
      gLimitPos: 9,
      gLimitNeg: -3,
      /** Ultimate load ≈ 1.5 × 9 g. */
      structuralFailureG: 13.5,
      structuralFailureNegG: -6,
      /** IAS beyond 800 × 1.08 ≈ 865 KIAS fails the airframe. */
      overspeedFailureFactor: 1.08,
      maxAngularRate: 8,
    },

    stall: {
      warningMarginDeg: 3,
      recoveryHysteresisDeg: 2,
    },

    landing: {
      butterFpm: 150,
      smoothFpm: 360,
      firmFpm: 660,
      hardFpm: 960,
      maxBankDeg: 12,
      /** Nose gear first. */
      minPitchDeg: -3,
      minAirborneTime: 1.5,
      ditchSpeedKt: 0,
      scrapeSpeedMs: 3,
      terrainImpactMs: 8,
      terrainPenetrationM: 0.3,
      nearGroundAglM: 40,
      obstacleCheckAglM: 400,
    },

    spawn: {
      runwayStartOffset: 60,
      /** 3° final from 6 km at 150 kt, flaperons down (notch 2 = 20°). */
      approach: { distance: 6000, height: 330, speedKt: 150, flapsNotch: 2, throttle: 0.5, aimPointM: 300 },
    },
  };
}

export const F16_AIRCRAFT: AircraftConfig = makeF16();

/**
 * Fairchild Republic A-10C Thunderbolt II ("Warthog"): straight-wing, twin TF34-GE-100A
 * turbofans (40.3 kN each, no afterburner), built around the 30 mm GAU-8/A Avenger.
 *
 * GEOMETRY IS FIXED (orchestrator contract, real dimensions: 16.26 m long, 17.53 m span, 4.47 m
 * tall, 47.0 m² wing, 5.40 m wheelbase, 5.25 m track): the 3D model and the physics contact points
 * both read it. Body frame: origin = CG, +X right, +Y up, −Z nose; wheels touch the ground at
 * y = −1.95 with the struts extended. The nose gear is offset 0.30 m right of the centreline (the
 * gun's firing barrel sits on the centreline). Twin fins at x = ±2.87 on the tailplane tips.
 * Engine pods on the upper rear fuselage, centred at x = ±1.55, y = +1.1, z = +3.1 … +6.4.
 *
 * FLIGHT MODEL: placeholder (F-16 aero with the A-10 geometry) until src/physics calibrates it.
 */
function makeA10(): AircraftConfig {
  const f16 = structuredClone(F16_AIRCRAFT);
  return {
    ...f16,
    name: 'A-10C Thunderbolt II',
    registration: '80-0281',
    wingArea: 47.01,
    wingSpan: 17.53,
    meanChord: 2.73,
    engine: {
      ...f16.engine,
      jet: {
        ...f16.engine.jet!,
        /** 2 × TF34-GE-100A, 9,065 lbf each; no afterburner (maxThrustN = milThrustN). */
        milThrustN: 80600,
        maxThrustN: 80600,
        idleThrustN: 4000,
        /** Both nozzles combined; the nacelles are canted so the thrust line passes just above the CG. */
        thrustPoint: { x: 0, y: 0.35, z: 6.4 },
      },
      staticThrustN: 80600,
    },
    geometry: {
      ...f16.geometry,
      length: 16.26,
      height: 4.47,
      noseWheel: { x: 0.3, y: -1.95, z: -4.85 },
      leftMainWheel: { x: -2.62, y: -1.95, z: 0.55 },
      rightMainWheel: { x: 2.62, y: -1.95, z: 0.55 },
      mainWheelRadius: 0.46,
      noseWheelRadius: 0.3,
      strutTravel: 0.25,
      propHub: { x: 0, y: 1.1, z: 3.1 },
      propRadius: 0.62,
      spinnerTip: { x: 0, y: -0.55, z: -7.25 },
      pilotEye: { x: 0, y: 1.1, z: -4.3 },
      wingRootLeadingEdge: { x: 0, y: -0.6, z: -0.75 },
      wingRootChord: 3.05,
      wingTipChord: 1.9,
      wingTaperStart: 0.35,
      dihedralDeg: 5,
      horizontalTail: { x: 0, y: 0.45, z: 8.2, span: 5.74, chord: 1.85 },
      verticalTailTop: { x: 0, y: 2.52, z: 8.6 },
      structuralPoints: [
        { name: 'noseTip', x: 0, y: -0.35, z: -6.95 },
        { name: 'chin', x: 0, y: -1.0, z: -3.6 },
        { name: 'bellyMid', x: 0, y: -1.05, z: 0.5 },
        { name: 'leftWingtip', x: -8.76, y: 0.05, z: 0.9 },
        { name: 'rightWingtip', x: 8.76, y: 0.05, z: 0.9 },
        { name: 'leftEngine', x: -1.55, y: 1.75, z: 4.6 },
        { name: 'rightEngine', x: 1.55, y: 1.75, z: 4.6 },
        { name: 'leftFinTop', x: -2.87, y: 2.52, z: 8.8 },
        { name: 'rightFinTop', x: 2.87, y: 2.52, z: 8.8 },
        { name: 'leftFinRoot', x: -2.87, y: -0.35, z: 8.6 },
        { name: 'rightFinRoot', x: 2.87, y: -0.35, z: 8.6 },
        { name: 'tailcone', x: 0, y: -0.25, z: 9.3 },
        { name: 'cabinRoof', x: 0, y: 1.6, z: -4.0 },
      ],
    },
    limits: { ...f16.limits, vsoKt: 100, vs1Kt: 115, vrKt: 120, vxKt: 180, vyKt: 210, vaKt: 300, vnoKt: 400, vneKt: 450, gLimitPos: 7.33, gLimitNeg: -3, structuralFailureG: 11, structuralFailureNegG: -5 },
  };
}

export const A10_AIRCRAFT: AircraftConfig = makeA10();

/** A-10C: GAU-8/A Avenger (1,150 rounds, PGU-13/14 combat mix) + 4 × AGM-65D Maverick on two LAU-88s (stations 3 and 9). */
export const A10_WEAPONS: WeaponsConfig = {
  gun: {
    name: 'GAU-8/A Avenger',
    caliberMm: 30,
    barrels: 7,
    /** 3,900 rounds/min. */
    rateRps: 65,
    spinUpS: 0.55,
    spinDownS: 0.7,
    rounds: 1150,
    muzzleVelocity: 1010,
    projectileMassKg: 0.425,
    /** ½ρ·Cd·A/m with Cd ≈ 0.3: ~700 m/s left at 1,220 m, ~1.5 s time of flight. */
    dragK: 3.0e-4,
    /** "80 % of rounds inside a 40 ft circle at 4,000 ft". */
    dispersionMrad: 5,
    /** ~10,000 lbf — about one engine's thrust. */
    recoilN: 45000,
    muzzle: { x: 0, y: -0.55, z: -7.25 },
    boresightDownDeg: 2,
    tracerEvery: 4,
    maxFlightS: 6,
    damage: 10,
    splashRadiusM: 3,
  },
  missiles: {
    name: 'AGM-65D Maverick',
    /** LAU-88 outboard/inboard rails under stations 3 and 9; fired left, right, left, right. */
    stations: [
      { x: -4.62, y: -1.35, z: 0.35 },
      { x: 4.62, y: -1.35, z: 0.35 },
      { x: -3.98, y: -1.35, z: 0.35 },
      { x: 3.98, y: -1.35, z: 0.35 },
    ],
    diameterM: 0.305,
    lengthM: 2.49,
    speed: 300,
    arc: 0.06,
    selectConeDeg: 10,
    maxRangeM: 8000,
    minRangeM: 400,
    lockTimeS: 0.8,
    damage: 400,
    blastRadiusM: 18,
  },
};

/** F-16C: M61A1 Vulcan, 511 rounds of 20 mm in the left strake. No air-to-ground missiles (yet). */
export const F16_WEAPONS: WeaponsConfig = {
  gun: {
    name: 'M61A1 Vulcan',
    caliberMm: 20,
    barrels: 6,
    /** 6,000 rounds/min. */
    rateRps: 100,
    spinUpS: 0.3,
    spinDownS: 0.5,
    rounds: 511,
    muzzleVelocity: 1030,
    projectileMassKg: 0.1,
    dragK: 5.8e-4,
    dispersionMrad: 8,
    recoilN: 18000,
    /** Port in the left strake root, beside the cockpit (GUN_MUZZLE in src/aircraft/f16). */
    muzzle: { x: -0.605, y: 0.03, z: -4.12 },
    boresightDownDeg: 0,
    tracerEvery: 5,
    maxFlightS: 5,
    damage: 3,
    splashRadiusM: 1.5,
  },
  missiles: null,
};
