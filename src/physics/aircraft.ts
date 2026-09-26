/**
 * The flight model: state creation, the fixed-step 6-DOF integrator and the flight-phase state
 * machine (ground → airborne → landed / crashed), for every aircraft in the fleet — the config
 * passed to step() selects the airframe, the engine type (piston / jet) and fly-by-wire, or, for a
 * helicopter (`rotorcraft`), the rotor model in ./rotor.ts in place of the wing and engine, or, for
 * a boat or ship (`watercraft`), the hull model in ./hull.ts in place of everything (phase 'afloat').
 * Pure and deterministic: step() never mutates its inputs and never touches the renderer or the DOM.
 *
 * ─── Calibration: Cessna 172RG (1100 kg, ISA, no wind; fixed 1/120 s step) ───
 * Checked by tests/physics/realism.test.ts, stall.test.ts, spin.test.ts, attitude.test.ts, turn-entry.test.ts.
 *
 *   Quantity                                   Measured                              C172RG POH / target
 *   ─────────────────────────────────────────  ────────────────────────────────────  ───────────────────
 *   CLmax clean / full flaps (30°)             1.62 @ 15.5° / 2.20 @ 13.5°           1.5–1.7 clean
 *   Stall, clean, idle (Vs1)                   49.5 KIAS                             48 KIAS (44–54)
 *   Stall, full flaps, idle (Vs0)              42.4 KIAS                             40 KIAS (36–47)
 *   Full-throttle ground roll to Vr 55 KIAS    230 m (16.2 s)                        200–400 m
 *   Rotate at Vr, 0.7 yoke → lift-off          5.9 °/s rotation, 60.6 KIAS, 9.4° pitch, 299 m   3–6 °/s, 8–10°
 *   Yank: yoke +1 for 1 s then +0.3            ≤ 9.7° pitch on the wheels, airborne in 1.3 s, no tail strike
 *   Best-rate climb, Vy 75 KIAS, sea level     679 fpm, 11° pitch                    550–950 fpm
 *   75 % power cruise, 8000 ft, gear up        127 KTAS (113 KIAS), 2630 rpm         120–140 KTAS
 *   Top speed, full power, sea level, gear up  138 KTAS                              < 160 kt
 *   Idle glide 70 KIAS, gear up / gear down    9.6 : 1 / 8.6 : 1                     8–10 : 1
 *   Hands-off trimmed cruise, 110 KIAS         4° bank upset → 1.7° in 60 s (→ 0.3° in 180 s), |Δalt| < 3 m
 *   Max roll rate, full aileron, 90 KIAS       55 °/s                                30–90 °/s
 *   Aileron-only roll-in to 30°, 90 KIAS       heading follows the bank from 0.1 s, 0.0° wrong-way   ≤ 1° adverse (keyboard)
 *     (cnAileron −0.006 → +0.001 Frise/differential ailerons, cnP −0.03 → −0.01; was 5.4° wrong-way, 1.0 s)
 *   Approach 72 KIAS, flaps 20, 3° glide       throttle 0.51, trim −0.53, pitch −4.3° (holds hands-off)
 *   Approach + simple flare                    "smooth" −175 fpm, 60 KIAS, mains first, 582 m past threshold
 *   Braking rollout from 55 kt, full flaps     163 m                                 < 500 m
 *   Coordinated full-aft stall at idle         breaks straight (bank ≤ 1°), nose +19° → −4°   straight, nose drops
 *   Skidding turn stall (inside rudder, top    inside wing drops past 60° (snaps toward the rudder)  base-to-final
 *     aileron, tightening pull)                                                         stall-spin
 *   Full aft + full rudder at the stall, idle  autorotating (p, r > 60 °/s) 0.7 s after the stall   incipient 1–3 s
 *   Developed spin (held pro-spin)             177 °/s (2.0 s/turn), nose −44°, α 44°, 71 KIAS,     150–250 °/s, 40–70° down,
 *                                              ~8,100 fpm = ~270 ft/turn, 'stalled' throughout      50–75 KIAS, 200–350 ft/turn
 *   PARE recovery from the developed spin      rotation stops in ~0.4 turn (1.2 s)   ≤ 1–1.5 turns
 *   Spiral dive (70° bank, cruise power)       IAS builds past 110 KIAS, wing unstalled  (spin: IAS stays < 75)
 *   Full aft yoke at 110 / 125 KIAS            3.6 g / 4.4 g; > 6.5 g or > 1.3·Vne = structural failure
 *
 * ─── Calibration: F-16C Block 50 (12,000 kg clean, full fuel; F110-GE-129; ISA) ───
 * Checked by tests/physics/jet.test.ts, f16-aero.test.ts, fbw.test.ts, f16-missions.test.ts, turn-entry.test.ts.
 *
 *   Quantity                                   Measured                              Real / target
 *   ─────────────────────────────────────────  ────────────────────────────────────  ───────────────────
 *   Thrust SL static, mil / max AB / idle      76.3 / 129 / 3.5 kN                   76 / 129 kN
 *   Spool idle → 95 % mil                      4.2 s (33 % of mil after 1 s)         4–5 s
 *   Afterburner light-off → full               1.0 s (only with the core ≥ 92 %)     ~1 s
 *   CLα, CLmax                                 3.5 / rad; 1.63 @ 32° α (vortex lift) ~3.5; ~1.6 @ 30–35°
 *   CD0 subsonic → transonic peak → M 2        0.0185 → 0.044 @ M 1.1 → 0.037        roughly doubles M 0.95–1.1
 *   Max L/D (clean)                            10.9 @ 250 KIAS                       ~10–11
 *   Top speed, max AB: sea level / 40,000 ft   M 1.25 (830 KIAS) / M 3.00 (steady)   M 1.2 / M 2.0  GAME TUNING: q / ram-temp limits in jet.ts
 *   Level AB acceleration, 40,000 ft           M 1.56 → M 3.07 in 90 s (844 KIAS)
 *   Peak climb (Ps), SL, max AB / sustained    ~51,700 fpm / 18.5 °/s at M 0.8       50–60,000 fpm / 18–20 °/s
 *     turn
 *   Instantaneous turn, 5,000 ft               23 °/s at 392 KIAS (9 g at the 25° limit)  ~26 °/s (lighter)
 *   Top speed, military power: SL / 40,000 ft  M 0.98 / M 1.05                       ~M 1.0 (no supercruise)
 *   AB take-off (12 t): rotate / lift-off      155 KIAS / ~184 KIAS, 483 m           rotate 150–160 kt, 450–700 m
 *   Held full aft stick on the take-off roll   rotation-rate limited, pitch ≤ 12° on the wheels (tail-strike protection)
 *   Mil take-off                               ~175 KIAS, 775 m                      ~900 m
 *   Climb at 350 KIAS from 2,000 ft            18,000 fpm mil / 34,000 fpm max AB
 *   AB climb → level at 10,000 ft              680 KIAS within 60 s of lift-off      > 500 kt
 *   FBW pitch: full aft / forward, 480 KIAS    8.9 g (8.5 g after 0.6 s, no overshoot) / −3.05 g    +9 / −3 g
 *   FBW AoA limiter (full aft, slowing)        parks at 25.0° (gear down: 16°), never 'stalled', no departure
 *   9 g turn, 10,000 ft, 480 KIAS, max AB      7.4 s ≥ 8.5 g, heading +160° in 8 s, 480 → 435 KIAS
 *   FBW roll, full stick, 350 KIAS             300 °/s within 0.6 s, |β| < 2.5°      ≈ 300 °/s
 *   Aileron-only roll-in (350 / 180 KIAS)      no wrong-way yaw (< 0.2°), heading follows within 0.5 s
 *   Full roll at the AoA limit, 200 KIAS       |β| < 10°, α ≤ 27° (roll cut by α and β: no roll-coupling departure)
 *   Neutral stick                              1.00 g, attitude held (Δpitch 0.001°, Δalt 0.2 ft in 20 s); banks ≤ 45° held level
 *   Speed brake at 300 KIAS, idle              +3.3 kt/s deceleration (≈ 0.17 g)
 *   Approach, 3° glide, gear + flaperons       150 KIAS at α 11.9°, pitch 8.9°       ~140–150 kt at 11–13° α
 *   Landing (flare, idle)                      ~144 KIAS, −374 fpm, 12.7° pitch, rollout 1,050 m (brakes + speed brake)   800–1,200 m
 *   Structural limits                          > 13.5 g / < −6 g, > 972 KIAS (Vne 900 × 1.08) = failure  (game tuning; real 800 KCAS)
 *
 * ─── Calibration: A-10C (16,000 kg combat weight: 4 × AGM-65D + pods; 2 × TF34-GE-100A; ISA) ───
 * Checked by tests/physics/a10.test.ts, a10-flight.test.ts, a10-keyboard.test.ts, a10-fuzz.test.ts, recoil.test.ts.
 *
 *   Quantity                                   Measured                              Real / target
 *   ─────────────────────────────────────────  ────────────────────────────────────  ───────────────────
 *   Thrust SL static / spool idle → 95 %       80.6 kN, no afterburner / 7.2 s       2 × 40.3 kN / 6–8 s
 *   CLα, CLmax clean / MVR 7° / DN 20°         4.9 / rad; 1.45 @ 18° / 1.61 / 1.92    4.8–5.0; 1.4–1.5 @ 16–18°
 *   Stall, idle, 1–2 kt/s: clean / gear+DN     116 KIAS / 100 KIAS, breaks straight  115–125 / 95–105 KIAS
 *   Take-off (MVR, rotate 120 KIAS)            lift-off 144 KIAS, ground roll 748 m  Vr 115–125, 700–1,000 m
 *   Climb at 200 KIAS, military                5,200 fpm                             5,000–6,000 fpm
 *   Max level speed, 1,000 ft (loaded)         369 KTAS                              340–380 (381 clean)
 *   Roll rate, full aileron: 250 / 300 KIAS    92 / 114 °/s (46 at 150 KIAS)         90–110 °/s
 *   60° bank level turn, 300 KIAS              1.97 g, 5.6 °/s                       2 g
 *   Full aft stick: 300 / 430 KIAS             6.2 g (lift-limited) / over-G failure  7.33 g limit, 11 g ultimate
 *   Decelerons, 300 KIAS idle                  +6.3 kt/s, no pitch change            big drag, no trim change
 *   Pro-spin held 10 s → recovery              84 °/s yaw; anti-spin 1.8 s, hands-off 5.4 s   spin-resistant, recoverable
 *   Approach 140 KIAS, flaps DN, 3° glide      α 4.3°, pitch 1.3°, trim +0.2         130–140 KIAS
 *   Landing (flare, idle, brakes + decelerons) 129 KIAS, −308 fpm "smooth", rollout 765 m
 *   GAU-8 burst, 2 s at 300 KIAS (45 kN)       −9.8 kt vs not firing, Δpitch 1.3°, Δhdg 0°   F·t/m ≈ 10.9 kt
 *
 * ─── Calibration: Boeing 747-400 (220 t light: OEW 178.8 t + 41 t fuel; 4 × PW4056; ISA) ───
 * Checked by tests/physics/b747.test.ts, b747-flight.test.ts, b747-keyboard.test.ts, b747-fuzz.test.ts.
 * Real numbers at 220 t scale the MTOW (396.9 t) ones by √(220/396.9) = 0.74 in speed.
 *
 *   Quantity                                   Measured                              Real / target
 *   ─────────────────────────────────────────  ────────────────────────────────────  ───────────────────
 *   Thrust SL static / FL350 M 0.85 / spool    1,008 kN / 197 kN / idle → 95 % 7.4 s  4 × 252 kN / ~200 kN / 6–8 s
 *   CLα; CLmax clean / flaps 10 / 30           5.0 / rad; 1.30 @ 14° / 1.65 / 2.35   4.9–5.3; 1.25–1.55 / — / 2.4–2.6
 *   1-g stall clean / flaps 30; Vref30         138 / 103 KIAS; 127 KIAS              140–150 / 100–110; 125–135
 *   Max L/D clean                              17.1                                  ~17.5
 *   Take-off, flaps 10, Vr 145                 lift-off 152–155 KIAS at 5.5–6.2°, ground roll 915–960 m   Vr 140–150, 1,000–1,300 m
 *     (lift-off ≈ 1,000 m past the threshold of the 1,600 m runway; tail clearance ≥ 1.4 m, strike at 9.6°)
 *   Heavy-handed rotation (2 × column/rate)    lifts off at 6.5°, tail clears by 1.4 m   no tail strike
 *   Initial climb, V2 + 15, flaps 10, TOGA     3,950 fpm                             3,500–5,000 fpm (light)
 *   Climb 10,000 ft → FL350 (320 KIAS/M .84)   12.9 min                              reaches it
 *   Cruise FL350 M 0.85                        271 KIAS, throttle 0.62 (N2 92 %), α 1.0°  M 0.85
 *   Max level speed FL350                      M 0.894 (drag rise from M 0.86)       ~M 0.9 (MMO 0.92)
 *   Roll rate, full wheel: approach / 300 KIAS / cruise   13 / 16 / 21 °/s        10–20 / — / 15–25 °/s
 *     (outboard ailerons locked out flaps up: aero.aileronFlapsUpFraction 0.45)
 *   Pitch: 0.35 column at 250 KIAS             1.5 g after 0.8 s                     slow, heavy
 *   TOGA from the trimmed approach             nose +8° in 8 s (thrust line 2.1 m below the CG)   pitch-up with power
 *   Yaw damper: rudder kick at 280 KIAS        β 4.2° → 0.2° in 15 s                 dutch roll damped
 *   Hands-off cruise, 3.5° bank upset          → 1.0° in 60 s, Δalt −7 ft            stable
 *   Stall, idle, 1 kt/s: clean / flaps 30      shaker 142 / 104, break 135 / 101 KIAS; nose −6° / −9° with the column still coming back
 *   Stall recovery (push, TOGA)                ~650 ft lost                          < 1,500 ft
 *   Approach, Vref30 + 5, 3° glide             α 5.1°, pitch 2.1°, throttle ≈ 0.2    α ~5°, pitch ~2°
 *   Landing (flare at ~30 ft, idle)            smooth −150…−290 fpm at 130–135 KIAS, pitch 4.3°, no bounce
 *   Landing roll, auto ground spoilers + max braking / half braking   735 m / 1,225 m   ~650–800 m / 900–1,300 m
 *     (without the ground spoilers the max-braking roll from 125 kt is 1,200 m instead of 670 m)
 *   Firm 600 fpm arrival                       rated firm/hard, stays on the ground  no bounce
 *   RTO at 130 KIAS (idle + max braking)       abort at 683 m, stops at 1,401 m      on the runway
 *   Full aft column at 280 KIAS                > 3.75 g → structural failure         2.5 g limit, 3.75 ultimate
 *
 * ─── Calibration: Bell 206B-3 JetRanger III (1,300 kg; Allison 250-C20J, 317 shp take-off limit; ISA) ───
 * A helicopter: `rotorcraft` config → src/physics/rotor.ts replaces the wing and the engine (see its header).
 * Checked by tests/physics/b206.test.ts, b206-fuzz.test.ts.
 *
 *   Quantity                                   Measured                              Real / target
 *   ─────────────────────────────────────────  ────────────────────────────────────  ───────────────────
 *   Hover OGE, sea level                       266 shp (84 % torque), collective 0.43   ~85 % torque at mid weights
 *   Hover attitude                             nose +3.7°, left skid low 3.1°, left pedal 0.43   nose up, left skid low
 *   Hover at 5 ft skid height (Hayden)         76 % torque (−10 % from OGE)          5–20 %
 *   Translational lift: 25 kt                  187 shp (−30 % from the hover)        big drop by ETL (15–25 kt)
 *   Power bucket (Vy)                          152 shp at 50 kt                      Vy 52 kt
 *   Top speed, 317 shp / 270 shp (MCP)         116 / 106 KTAS                        ~115 kt max cruise, Vne 130
 *   Cruise 100 kt                              245 shp, nose −1.5°, pedals ~neutral (the fin carries the tail)
 *   HOGE ceiling on 317 shp: 1,451 kg / 1,300 kg   4,750 ft / 11,500 ft              MGW HOGE ~5,000 ft
 *   Autorotation 52 kt, collective down        ~1,700 fpm, NR 107 % (raise it a touch)  ~1,500–1,800 fpm, NR 90–107 %
 *   Autorotation flare + cushion               touchdown < 360 fpm, rotor ~100 % at the flare
 *   Vortex ring state                          collective −0.12 in the hover → 1,000+ fpm and VRS in ~3 s; more
 *                                              collective droops the rotor; forward cyclic exits in ~5 s (< 500 ft)
 *   Torque reaction                            +0.1 collective, pedals fixed: nose right > 10° in 2 s
 *   Stability assist: hover drift / cruise     < 2 m in 30 s / Δhdg < 2°, Δalt < 50 ft in 30 s hands-off
 *   Hover pedal turn                           ~40 °/s, stops within 15°
 *   Engine off on the ground / restart         NR 100 → ~60 % in 20 s / back to 100 % ≤ 100 % torque
 *   Skids: hard landing / dynamic roll-over    > 600 fpm collapses them / a skid-pinned lift-off → main rotor strike
 *
 *   step() cost (M2 Max, node): C172 ~1.6 µs, C172 spinning (strips) ~4 µs, F-16 with FBW ~5 µs, JetRanger ~2.2 µs   ≪ 0.1 ms
 */
import { CONFIG, MS_TO_FPM, MS_TO_KT, type Config } from '../config';
import type {
  AircraftState, Controls, CrashRecord, DerivedData, EngineState, Environment, Quat, SimStateLabel, TouchdownRecord, Vec3,
} from '../types';
import { clamp, moveToward } from '../math/vec3';
import { qIntegrateBody } from '../math/quat';
import { runwayFrame, runwayAt, fromRunwayCoords, toRunwayCoords, type RunwayFrame } from '../world/runway';
import {
  airDataFromBodyVelocity, bodyToWorld, eulerFromQuat, pqrFromOmega, quatFromEuler, worldToBody,
} from './frames';
import { airDensity, speedOfSound } from './atmosphere';
import { computeAero, stallAlphaRad } from './aero';
import { enginePowerTarget, steadyEngineAny, stepEngine } from './engine';
import { stepJetEngine } from './jet';
import { applyFbw } from './fbw';
import { groundContacts } from './ground';
import { FLAT_ENV } from './flatEnv';
import { solveTrim, type TrimRequest } from './trim';
import { gunRecoil } from './recoil';
import { initialRotorState, solveRotorTrim, stepRotorcraft, trimmedRotorState } from './rotor';
import { createVesselState, stepVessel } from './hull';

const DEG = Math.PI / 180;
const ZERO: Vec3 = Object.freeze({ x: 0, y: 0, z: 0 });

// ─── Controls ─────────────────────────────────────────────────────────────────

/** Throttle idle, yoke centred, flaps up, gear down, brakes off, engine on. */
export function defaultControls(): Controls {
  return {
    throttle: 0,
    elevator: 0,
    aileron: 0,
    rudder: 0,
    elevatorTrim: 0,
    flapsNotch: 0,
    gearDown: true,
    brake: 0,
    parkingBrake: false,
    engineOn: true,
    speedBrake: false,
    trigger: false,
    stabilityAssist: true,
  };
}

const num = (v: number, lo: number, hi: number, fallback = 0): number => (Number.isFinite(v) ? clamp(v, lo, hi) : fallback);

/** Clamp every control into range; NaN → neutral. */
function sanitize(c: Controls, cfg: Config): Controls {
  const n = cfg.aircraft.flaps.notchesDeg.length;
  return {
    throttle: num(c.throttle, 0, 1),
    elevator: num(c.elevator, -1, 1),
    aileron: num(c.aileron, -1, 1),
    rudder: num(c.rudder, -1, 1),
    elevatorTrim: num(c.elevatorTrim, -1, 1),
    flapsNotch: Math.round(num(c.flapsNotch, 0, n - 1)),
    gearDown: c.gearDown !== false,
    brake: num(c.brake, 0, 1),
    parkingBrake: !!c.parkingBrake,
    engineOn: c.engineOn !== false,
    speedBrake: c.speedBrake === true,
    stabilityAssist: c.stabilityAssist !== false,
  };
}

// ─── Labels & classification ─────────────────────────────────────────────────

/** 'crashed' | 'stalled' (airborne and stalled) | the phase. */
export function simStateLabel(state: AircraftState): SimStateLabel {
  if (state.phase === 'crashed') return 'crashed';
  if (state.phase === 'airborne' && state.stalled) return 'stalled';
  return state.phase;
}

/** Flight Mach number: true airspeed over the ISA speed of sound at the aircraft's altitude. */
export function machNumber(state: AircraftState): number {
  const m = state.derived.tas / speedOfSound(state.position.y);
  return Number.isFinite(m) ? m : 0;
}

/** Touchdown rating by vertical speed (fpm; the magnitude is used). Beyond hardFpm the gear collapses. */
export function classifyTouchdown(verticalSpeedFpm: number, cfg: Config = CONFIG): TouchdownRecord['rating'] | 'crash' {
  const l = cfg.aircraft.landing;
  const v = Math.abs(verticalSpeedFpm);
  if (!(v <= l.hardFpm)) return 'crash';
  if (v <= l.butterFpm) return 'butter';
  if (v <= l.smoothFpm) return 'smooth';
  if (v <= l.firmFpm) return 'firm';
  return 'hard';
}

// ─── Derived data ────────────────────────────────────────────────────────────

function computeDerived(
  pos: Vec3, vel: Vec3, q: Quat, omega: Vec3, wind: Vec3, loadFactor: number, env: Environment, cfg: Config,
): DerivedData {
  const rho = airDensity(pos.y);
  const vb = worldToBody(q, { x: vel.x - wind.x, y: vel.y - wind.y, z: vel.z - wind.z });
  const ad = airDataFromBodyVelocity(vb);
  const e = eulerFromQuat(q);
  const { p, q: qr, r } = pqrFromOmega(omega);
  // a landable deck (pier, helipad, helideck) is the ground under an aircraft: AGL (radar altimeter, ground effect) from it
  const ground = Math.max(env.groundHeight(pos.x, pos.z), env.deckTop ? env.deckTop(pos.x, pos.z) : -Infinity);
  const water = env.waterLevel(pos.x, pos.z);
  const surface = water !== null && water > ground ? water : ground;
  return {
    tas: ad.V,
    ias: ad.V * Math.sqrt(rho / cfg.sim.seaLevelDensity),
    groundSpeed: Math.hypot(vel.x, vel.z),
    alpha: ad.alpha,
    beta: ad.beta,
    verticalSpeed: vel.y,
    altitudeAGL: pos.y - surface,
    headingDeg: e.headingDeg,
    pitchDeg: e.pitchDeg,
    rollDeg: e.rollDeg,
    loadFactor,
    density: rho,
    p,
    q: qr,
    r,
  };
}

const windAt = (env: Environment, p: Vec3, t: number): Vec3 => (env.wind ? env.wind(p.x, p.y, p.z, t) : ZERO);

// ─── State creation ──────────────────────────────────────────────────────────

/**
 * On runway 36 (or the given runway end's departure frame, e.g. runwayEndFrame('21')), main wheels
 * spawn.runwayStartOffset m past the threshold, resting on the gear, engine idling.
 */
export function createInitialState(env: Environment = FLAT_ENV, cfg: Config = CONFIG, runway?: RunwayFrame | null): AircraftState {
  const ac = cfg.aircraft;
  if (ac.rotorcraft) return createInitialRotorcraftState(env, cfg, runway ?? runwayFrame(cfg));
  if (ac.watercraft) {
    // A vessel has no runway: it floats where it's put (the app starts it at its berth, src/world/port.ts).
    const rw = runway ?? runwayFrame(cfg);
    return createVesselState(env, cfg, { x: rw.threshold.x, z: rw.threshold.z, headingDeg: rw.headingDeg }).state;
  }
  const geo = ac.geometry;
  const gd = ac.ground;
  const rw = runway ?? runwayFrame(cfg);
  const nose = geo.noseWheel;
  const main = geo.leftMainWheel;
  const cgXZ = fromRunwayCoords(ac.spawn.runwayStartOffset + main.z, 0, rw);
  const heading = rw.headingDeg;

  // Static gear loads (moment balance about the CG) → strut compressions.
  const W = ac.mass * cfg.sim.gravity;
  const armN = -nose.z;
  const armM = main.z;
  const loadNose = (W * armM) / (armN + armM);
  const loadMain = (W - loadNose) / 2;
  const dN = loadNose / gd.springNose;
  const dM = loadMain / gd.springMain;

  // Terrain under the wheels (level attitude is close enough for the lookup).
  const qLevel = quatFromEuler(heading, 0, 0);
  const at = (b: Vec3) => {
    const r = bodyToWorld(qLevel, b);
    return env.groundHeight(cgXZ.x + r.x, cgXZ.z + r.z);
  };
  const gN = at(nose);
  const gM = (at(geo.leftMainWheel) + at(geo.rightMainWheel)) / 2;
  // Wheel world y = y_cg + y_b·cosθ − z_b·sinθ ; penetration d = ground − that.
  let theta = 0;
  for (let i = 0; i < 4; i++) {
    const s = (dN - dM - (gN - gM) + (nose.y - main.y) * Math.cos(theta)) / (nose.z - main.z);
    theta = Math.asin(clamp(s, -0.5, 0.5));
  }
  const y = gM - main.y * Math.cos(theta) + main.z * Math.sin(theta) - dM;
  const position = { x: cgXZ.x, y, z: cgXZ.z };
  const orientation = quatFromEuler(heading, theta / DEG, 0);
  const rho = airDensity(y);
  const engine: EngineState = { ...steadyEngineAny(enginePowerTarget(0, rho, cfg), rho, 0, 0, 0, cfg), rpm: ac.engine.idleRpm };

  return {
    time: 0,
    position,
    velocity: { x: 0, y: 0, z: 0 },
    orientation,
    angularVelocity: { x: 0, y: 0, z: 0 },
    engine,
    flapsDeg: 0,
    gearPos: 1,
    phase: 'ground',
    stalled: false,
    onGround: true,
    wheelContact: [true, true, true],
    wheelCompression: [dN, dM, dM],
    airborneTime: 0,
    touchdown: null,
    crash: null,
    derived: computeDerived(position, ZERO, orientation, ZERO, windAt(env, position, 0), 1, env, cfg),
  };
}

/**
 * A helicopter on the ground: skids level on the surface, sagging under their share of the weight,
 * rotor turning at 100 % with the collective down (engine running, governed).
 */
function createInitialRotorcraftState(env: Environment, cfg: Config, rw: RunwayFrame): AircraftState {
  const ac = cfg.aircraft;
  const sk = ac.rotorcraft!.skids;
  const aft = Math.max(...sk.points.map((p) => p.z));
  const cgXZ = fromRunwayCoords(ac.spawn.runwayStartOffset + aft, 0, rw);
  const heading = rw.headingDeg;
  const rotor = initialRotorState(cfg, heading);
  const W = ac.mass * cfg.sim.gravity - rotor.thrust;
  const d = W / sk.points.length / sk.spring;
  const qLevel = quatFromEuler(heading, 0, 0);
  const ground = Math.max(
    ...sk.points.map((b) => {
      const r = bodyToWorld(qLevel, b);
      return env.groundHeight(cgXZ.x + r.x, cgXZ.z + r.z);
    }),
  );
  const position = { x: cgXZ.x, y: ground - sk.points[0].y - d, z: cgXZ.z };
  const engine: EngineState = {
    running: true, starting: false, startTimer: 0, failed: false,
    power: rotor.enginePower / ac.rotorcraft!.engine.transmissionLimitW,
    rpm: ac.rotorcraft!.rotor.nominalRpm, thrust: rotor.thrust, afterburner: 0,
  };
  return {
    time: 0,
    position,
    velocity: { x: 0, y: 0, z: 0 },
    orientation: qLevel,
    angularVelocity: { x: 0, y: 0, z: 0 },
    engine,
    flapsDeg: 0,
    gearPos: 1,
    phase: 'ground',
    stalled: false,
    onGround: true,
    wheelContact: [true, true, true],
    wheelCompression: [d, d, d],
    airborneTime: 0,
    touchdown: null,
    crash: null,
    derived: computeDerived(position, ZERO, qLevel, ZERO, windAt(env, position, 0), 1, env, cfg),
    rotor,
  };
}

/** A helicopter in steady trimmed flight (0 kt = a hover), with the stability assist holding it. */
function createTrimmedRotorcraftState(req: TrimRequest, env: Environment, cfg: Config): { state: AircraftState; controls: Controls } {
  const ac = cfg.aircraft;
  const heading = req.headingDeg ?? 0;
  // Trim in ground effect when spawned low (the hub's height over the surface, level attitude).
  const px = req.x ?? 0;
  const pz = req.z ?? 0;
  const water = env.waterLevel(px, pz);
  const surface = Math.max(env.groundHeight(px, pz), env.deckTop ? env.deckTop(px, pz) : -Infinity, water ?? -Infinity);
  const tr = solveRotorTrim(req, cfg, req.altitudeM + ac.rotorcraft!.rotor.hub.y - surface);
  const gamma = (req.flightPathDeg ?? 0) * DEG;
  const h = heading * DEG;
  const position = { x: req.x ?? 0, y: req.altitudeM, z: req.z ?? 0 };
  const wind = windAt(env, position, 0);
  const vh = tr.tas * Math.cos(gamma);
  const velocity = { x: Math.sin(h) * vh + wind.x, y: tr.tas * Math.sin(gamma) + wind.y, z: -Math.cos(h) * vh + wind.z };
  const orientation = quatFromEuler(heading, tr.pitchDeg, tr.rollDeg);
  const { rotor, pilot } = trimmedRotorState(tr, heading, cfg);
  const engine: EngineState = {
    running: true, starting: false, startTimer: 0, failed: false,
    power: tr.power / ac.rotorcraft!.engine.transmissionLimitW,
    rpm: ac.rotorcraft!.rotor.nominalRpm, thrust: tr.thrust, afterburner: 0,
  };
  const state: AircraftState = {
    time: 0,
    position,
    velocity,
    orientation,
    angularVelocity: { x: 0, y: 0, z: 0 },
    engine,
    flapsDeg: 0,
    gearPos: 1,
    phase: 'airborne',
    stalled: false,
    onGround: false,
    wheelContact: [false, false, false],
    wheelCompression: [0, 0, 0],
    airborneTime: 60,
    touchdown: null,
    crash: null,
    derived: computeDerived(position, velocity, orientation, ZERO, wind, 1, env, cfg),
    rotor,
  };
  return { state, controls: { ...defaultControls(), ...pilot } };
}

/** Controls that hold a trim solution (throttle + elevator trim, elevator 0). */
function controlsFor(req: TrimRequest, tr: ReturnType<typeof solveTrim>): Controls {
  return {
    ...defaultControls(),
    throttle: tr.throttle,
    elevatorTrim: tr.elevatorTrim,
    flapsNotch: Math.round(req.flapsNotch ?? 0),
    gearDown: req.gearDown !== false,
  };
}

/**
 * An airborne aircraft in steady, trimmed flight (wings level) plus the
 * controls that hold it there hands-off. Handy for tests and scenario resets.
 */
export function createTrimmedState(
  req: TrimRequest,
  env: Environment = FLAT_ENV,
  cfg: Config = CONFIG,
): { state: AircraftState; controls: Controls } {
  if (cfg.aircraft.rotorcraft) return createTrimmedRotorcraftState(req, env, cfg);
  if (cfg.aircraft.watercraft) {
    // A vessel underway: the altitude is ignored (it floats), the speed is through the water.
    const v = createVesselState(env, cfg, { x: req.x ?? 0, z: req.z ?? 0, headingDeg: req.headingDeg ?? 0, speedKt: req.iasKt });
    return { state: v.state, controls: { ...defaultControls(), ...v.controls } };
  }
  const tr = solveTrim(req, cfg);
  const heading = req.headingDeg ?? 0;
  const gamma = (req.flightPathDeg ?? 0) * DEG;
  const h = heading * DEG;
  const position = { x: req.x ?? 0, y: req.altitudeM, z: req.z ?? 0 };
  const wind = windAt(env, position, 0);
  const vh = tr.tas * Math.cos(gamma);
  const velocity = { x: Math.sin(h) * vh + wind.x, y: tr.tas * Math.sin(gamma) + wind.y, z: -Math.cos(h) * vh + wind.z };
  const orientation = quatFromEuler(heading, tr.pitchDeg, 0);
  const ias = tr.tas * Math.sqrt(tr.density / cfg.sim.seaLevelDensity) * MS_TO_KT;
  const engine = steadyEngineAny(tr.power, tr.density, tr.tas * Math.cos(tr.alpha), ias, tr.tas / speedOfSound(req.altitudeM), cfg);
  const state: AircraftState = {
    time: 0,
    position,
    velocity,
    orientation,
    angularVelocity: { x: 0, y: 0, z: 0 },
    engine,
    flapsDeg: tr.flapsDeg,
    gearPos: req.gearDown === false ? 0 : 1,
    phase: 'airborne',
    stalled: false,
    onGround: false,
    wheelContact: [false, false, false],
    wheelCompression: [0, 0, 0],
    airborneTime: 60,
    touchdown: null,
    crash: null,
    derived: computeDerived(position, velocity, orientation, ZERO, wind, 1, env, cfg),
  };
  return { state, controls: controlsFor(req, tr) };
}

function approachRequest(runwayGround: number, cfg: Config): TrimRequest {
  const ap = cfg.aircraft.spawn.approach;
  const rw = runwayFrame(cfg);
  const p = fromRunwayCoords(-ap.distance, 0, rw);
  return {
    altitudeM: runwayGround + ap.height,
    iasKt: ap.speedKt,
    flightPathDeg: -Math.atan2(ap.height, ap.distance + ap.aimPointM) / DEG,
    flapsNotch: ap.flapsNotch,
    gearDown: true,
    headingDeg: rw.headingDeg,
    x: p.x,
    z: p.z,
  };
}

/** On final for runway 36: gear down, approach flaps, on a ~3° glide to the aim point at spawn.approach.speedKt. */
export function createApproachState(env: Environment = FLAT_ENV, cfg: Config = CONFIG): AircraftState {
  const rw = runwayFrame(cfg);
  return createTrimmedState(approachRequest(env.groundHeight(rw.threshold.x, rw.threshold.z), cfg), env, cfg).state;
}

/** Controls matching createApproachState: gear down, approach flaps, throttle + trim that hold the glide hands-off. */
export function approachControls(cfg: Config = CONFIG): Controls {
  const req = approachRequest(cfg.world.airport.elevation, cfg);
  if (cfg.aircraft.rotorcraft) return createTrimmedRotorcraftState(req, FLAT_ENV, cfg).controls;
  if (cfg.aircraft.watercraft) return defaultControls();
  return controlsFor(req, solveTrim(req, cfg));
}

// ─── The step ────────────────────────────────────────────────────────────────

function crashedState(
  s: AircraftState, reason: string, time: number, env: Environment, cfg: Config, extra: Partial<AircraftState> = {},
): AircraftState {
  const v = s.velocity;
  const crash: CrashRecord = {
    time,
    reason,
    speedKt: Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) * MS_TO_KT,
    verticalSpeedFpm: v.y * MS_TO_FPM,
    position: { ...s.position },
  };
  const position = { ...s.position };
  return {
    ...s,
    ...extra,
    time,
    position,
    velocity: { x: 0, y: 0, z: 0 },
    orientation: { ...s.orientation },
    angularVelocity: { x: 0, y: 0, z: 0 },
    engine: { running: false, starting: false, startTimer: 0, failed: true, power: 0, rpm: 0, thrust: 0, afterburner: 0 },
    ...(s.rotor ? { rotor: { ...s.rotor, omega: 0, thrust: 0, tailThrust: 0, enginePower: 0, n1: 0, torque: 0, vrs: 0, bladeStall: 0 } } : {}),
    phase: 'crashed',
    stalled: false,
    crash,
    derived: computeDerived(position, ZERO, s.orientation, ZERO, ZERO, 1, env, cfg),
  };
}

function cloneState(s: AircraftState): AircraftState {
  return structuredClone(s);
}

/**
 * Ground spoilers (aircraft with aero.spoilers): every panel comes up while the main gear is on the
 * ground above the wheel spin-up speed with the speed brake lever raised or the thrust levers at
 * idle (armed auto spoilers on landing, and a rejected take-off); 0 otherwise.
 */
export function groundSpoilerExtension(state: AircraftState, c: Pick<Controls, 'throttle' | 'speedBrake'>, cfg: Config = CONFIG): number {
  const sp = cfg.aircraft.aero.spoilers;
  if (!sp || state.gearPos < 0.999) return 0;
  if (!(state.wheelContact[1] || state.wheelContact[2])) return 0;
  if (!(state.derived.groundSpeed * MS_TO_KT >= sp.autoMinGroundKt)) return 0;
  return c.speedBrake === true || c.throttle <= sp.autoIdleThrottle ? 1 : 0;
}

function stepOnce(state: AircraftState, raw: Controls, dt: number, env: Environment, cfg: Config): AircraftState {
  const time = state.time + dt;
  if (state.phase === 'crashed') {
    const s = cloneState(state);
    s.time = time;
    return s;
  }
  // Boats and ships: the hull model (./hull.ts) does everything.
  if (cfg.aircraft.watercraft) return stepVessel(state, raw, dt, env, cfg);
  const ac = cfg.aircraft;
  const pilot = sanitize(raw, cfg);
  // Fly-by-wire: the pilot's stick/pedals become surface commands (the nosewheel still follows the pedals).
  const c = ac.fbw ? applyFbw(state, pilot, cfg) : pilot;
  const g = cfg.sim.gravity;
  const m = ac.mass;
  const pos = state.position;
  const vel = state.velocity;
  const q = state.orientation;
  const w = state.angularVelocity;

  // ── Air data ──
  const wind = windAt(env, pos, state.time);
  const vb = worldToBody(q, { x: vel.x - wind.x, y: vel.y - wind.y, z: vel.z - wind.z });
  const rho = airDensity(pos.y);
  const ad = airDataFromBodyVelocity(vb);
  const iasKt = ad.V * Math.sqrt(rho / cfg.sim.seaLevelDensity) * MS_TO_KT;
  const mach = ad.V / speedOfSound(pos.y);

  // ── Systems: flaps, gear (squat switch), engine ──
  const notches = ac.flaps.notchesDeg;
  // Flaperons (F-16) droop automatically with the gear handle down, below their placard speed.
  const autoFlaps = ac.flaps.autoWithGearDeg > 0 && c.gearDown && iasKt < ac.flaps.autoRetractKt ? ac.flaps.autoWithGearDeg : 0;
  const flapsDeg = moveToward(state.flapsDeg, Math.max(notches[c.flapsNotch], autoFlaps), ac.flaps.rateDegPerSec * dt);
  // Squat switch + interlock: the gear only starts up once the aircraft has been continuously airborne
  // for gear.retractDelay s, so a handle raised during the takeoff roll or a skipped bounce can't
  // fold the gear under a settling aircraft (play-test bug #2).
  const weightOnWheels = state.onGround || state.airborneTime < ac.gear.retractDelay;
  const gearTarget = !ac.gear.retractable || c.gearDown || (ac.gear.squatSwitch && weightOnWheels && state.gearPos >= 0.999) ? 1 : 0;
  const gearPos = moveToward(state.gearPos, gearTarget, dt / ac.gear.transitTime);
  // ── Airframe forces (body) ──
  let engine: EngineState;
  let aero: { fx: number; fy: number; fz: number; tx: number; ty: number; tz: number };
  let rotor: AircraftState['rotor'];
  if (ac.rotorcraft) {
    // Helicopter: rotors, airframe, drivetrain and turboshaft (./rotor). Hub height over the surface
    // (last step's AGL is plenty accurate) for the ground effect.
    const hubHeight = state.derived.altitudeAGL + bodyToWorld(q, ac.rotorcraft.rotor.hub).y;
    const hs = stepRotorcraft(state, pilot, vb, rho, hubHeight, dt, cfg);
    engine = hs.engine;
    rotor = hs.rotor;
    aero = { fx: hs.force.x, fy: hs.force.y, fz: hs.force.z, tx: hs.torque.x, ty: hs.torque.y, tz: hs.torque.z };
  } else {
    engine =
      ac.engine.type === 'jet'
        ? stepJetEngine(state.engine, c, dt, rho, mach, iasKt, cfg)
        : stepEngine(state.engine, c, dt, rho, Math.max(0, ad.u), iasKt, cfg);
    // Wing height above the surface (last step's AGL is plenty accurate) for ground effect.
    const wingHeight = state.derived.altitudeAGL + ac.geometry.wingRootLeadingEdge.y;
    const groundSpoilers = groundSpoilerExtension(state, c, cfg);
    aero = computeAero(vb, w, rho, flapsDeg, gearPos, c, engine.thrust, cfg, wingHeight, { mach, speedBrake: c.speedBrake ? 1 : 0, groundSpoilers });
  }
  // Gun recoil while rounds are leaving the barrel (set by the weapons system; see ./recoil).
  const gun = gunRecoil(raw.gunFiring, cfg);
  const fAir = bodyToWorld(q, { x: aero.fx + gun.fx, y: aero.fy + gun.fy, z: aero.fz + gun.fz });

  // ── Ground, structure, water, obstacles ──
  const omegaWorld = bodyToWorld(q, w);
  const gr = groundContacts(
    { position: pos, velocity: vel, orientation: q, omegaWorld, gearPos, brake: c.brake, parkingBrake: c.parkingBrake, rudder: pilot.rudder, engineRunning: engine.running, skidAnchors: state.rotor?.skidAnchors },
    env,
    cfg,
  );
  if (gr.crashReason) return crashedState(state, gr.crashReason, time, env, cfg, { flapsDeg, gearPos });

  // ── Flight phase: touchdowns and takeoffs ──
  let phase = state.phase;
  let airborneTime = state.airborneTime;
  let touchdown = state.touchdown;
  if (gr.onGround) {
    if (state.phase === 'airborne') {
      const vsFpm = vel.y * MS_TO_FPM;
      const lim = ac.landing;
      if (-vsFpm > lim.hardFpm) {
        const reason = -vel.y > lim.terrainImpactMs ? 'Hit terrain' : ac.rotorcraft ? 'Hard landing — skids collapsed' : 'Hard landing — gear collapsed';
        return crashedState(state, reason, time, env, cfg, { flapsDeg, gearPos });
      }
      if (state.airborneTime >= lim.minAirborneTime) {
        const e = eulerFromQuat(q);
        if (Math.abs(e.rollDeg) > lim.maxBankDeg) {
          const why = ac.rotorcraft ? 'Rolled over — too much bank at touchdown' : 'Wingtip strike — too much bank at touchdown';
          return crashedState(state, why, time, env, cfg, { flapsDeg, gearPos });
        }
        if (e.pitchDeg < lim.minPitchDeg) {
          const why = ac.rotorcraft ? 'Nosed over — landed on the skid toes' : 'Prop strike — landed nose-first';
          return crashedState(state, why, time, env, cfg, { flapsDeg, gearPos });
        }
        const surface = env.surfaceAt(pos.x, pos.z);
        const onRunway = surface === 'runway';
        touchdown = {
          time,
          verticalSpeedFpm: vsFpm,
          airspeedKt: iasKt,
          rating: classifyTouchdown(vsFpm, cfg) as TouchdownRecord['rating'],
          bankDeg: e.rollDeg,
          pitchDeg: e.pitchDeg,
          surface,
          onRunway,
          centerlineOffsetM: onRunway ? toRunwayCoords(pos.x, pos.z, runwayAt(pos.x, pos.z, cfg) ?? runwayFrame(cfg)).across : null,
        };
        phase = 'landed';
      } else {
        // A short hop: back to whatever ground phase we came from, no new rating.
        phase = state.touchdown ? 'landed' : 'ground';
      }
    }
    airborneTime = 0;
  } else {
    phase = 'airborne';
    airborneTime = state.airborneTime + dt;
  }

  // ── Integrate (semi-implicit Euler) ──
  const fx = fAir.x + gr.force.x;
  const fy = fAir.y + gr.force.y - m * g;
  const fz = fAir.z + gr.force.z;
  const velocity = { x: vel.x + (fx / m) * dt, y: vel.y + (fy / m) * dt, z: vel.z + (fz / m) * dt };
  const position = { x: pos.x + velocity.x * dt, y: pos.y + velocity.y * dt, z: pos.z + velocity.z * dt };

  const tg = worldToBody(q, gr.torque);
  const tx = aero.tx + tg.x + gun.tx;
  const ty = aero.ty + tg.y + gun.ty;
  const tz = aero.tz + tg.z + gun.tz;
  const I = ac.inertia;
  // ω̇ = I⁻¹(τ − ω × Iω), diagonal inertia (pitch = X, yaw = Y, roll = Z).
  const hx = I.pitch * w.x;
  const hy = I.yaw * w.y;
  const hz = I.roll * w.z;
  const wMax = ac.limits.maxAngularRate;
  const angularVelocity = {
    x: clamp(w.x + ((tx - (w.y * hz - w.z * hy)) / I.pitch) * dt, -wMax, wMax),
    y: clamp(w.y + ((ty - (w.z * hx - w.x * hz)) / I.yaw) * dt, -wMax, wMax),
    z: clamp(w.z + ((tz - (w.x * hy - w.y * hx)) / I.roll) * dt, -wMax, wMax),
  };
  const orientation = qIntegrateBody(q, angularVelocity, dt);

  // ── Load factor: specific force along body up (accelerometer), and the airframe (aero) part for over-G ──
  const nAero = aero.fy / (m * g);
  const gBody = worldToBody(q, gr.force);
  const loadFactor = (aero.fy + gun.fy + gBody.y) / (m * g);
  if (nAero > ac.limits.structuralFailureG || nAero < ac.limits.structuralFailureNegG) {
    // A teetering rotor unloaded into negative g flaps into the mast.
    const why = ac.rotorcraft && nAero < ac.limits.structuralFailureNegG ? 'Mast bumping — rotor separated in negative g' : 'Structural failure — over-G';
    return crashedState(state, why, time, env, cfg, { flapsDeg, gearPos });
  }
  if (iasKt > ac.limits.vneKt * ac.limits.overspeedFailureFactor) {
    return crashedState(state, 'Structural failure — overspeed', time, env, cfg, { flapsDeg, gearPos });
  }

  const derived = computeDerived(position, velocity, orientation, angularVelocity, wind, loadFactor, env, cfg);

  // ── Stall flag with hysteresis (only meaningful in the air) ──
  const aStall = stallAlphaRad(flapsDeg, cfg);
  let stalled = false;
  // (A helicopter has no wing to stall: the rotor's blade stall is in state.rotor.)
  if (phase === 'airborne' && !ac.rotorcraft) {
    stalled = state.stalled
      ? derived.alpha > aStall - ac.stall.recoveryHysteresisDeg * DEG
      : derived.alpha > aStall;
  }

  return {
    time,
    position,
    velocity,
    orientation,
    angularVelocity,
    engine,
    flapsDeg,
    gearPos,
    phase,
    stalled,
    onGround: gr.onGround,
    wheelContact: gr.wheelContact,
    wheelCompression: gr.wheelCompression,
    airborneTime,
    touchdown,
    crash: null,
    derived,
    ...(rotor ? { rotor: { ...rotor, skidAnchors: gr.skidAnchors ?? rotor.skidAnchors } } : {}),
  };
}

/**
 * Advance the aircraft by dt seconds (normally config.sim.fixedDt = 1/120 s).
 * Pure: returns a NEW state and never mutates its inputs; deterministic.
 * A dt larger than 1.5 × fixedDt is split into equal sub-steps.
 */
export function step(
  state: AircraftState,
  controls: Controls,
  dt: number,
  env: Environment = FLAT_ENV,
  cfg: Config = CONFIG,
): AircraftState {
  if (!(dt > 0) || !Number.isFinite(dt)) return cloneState(state);
  const maxDt = cfg.sim.fixedDt * 1.5;
  if (dt <= maxDt) return stepOnce(state, controls, dt, env, cfg);
  const n = Math.ceil(dt / cfg.sim.fixedDt);
  const h = dt / n;
  let s = state;
  for (let i = 0; i < n; i++) s = stepOnce(s, controls, h, env, cfg);
  return s;
}
