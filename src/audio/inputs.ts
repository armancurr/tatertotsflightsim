/**
 * PURE adapter: AircraftState (+ controls, camera) → AudioInputs, with the edge detection the
 * sound engine needs (touchdown once per record, gear/flap motors while the surfaces travel,
 * Doppler closing speed from the camera's motion). Keep one tracker per app; call it every frame.
 * Helicopters (state.rotor present): the rotor/turboshaft fields for the 'turboshaft' voice and the
 * low rotor RPM horn; the fixed-wing stall and gear horns stay silent.
 * Vessels (state.vessel present): engines / propulsors and the hull for the 'marineDiesel' voice (the hull's
 * vertical speed relative to the waves from the surface level's rate); no horns, gear or flap motors,
 * touchdowns or tyres.
 */
import { CONFIG, MS_TO_KT } from '../config';
import type { AircraftState, CameraMode, Controls, SurfaceType, Vec3 } from '../types';
import type { AudioInputs, MarineEngineAudioInputs, RotorAudioInputs, VesselAudioInputs } from './types';
import { lowRotorRpmHorn, rotorPct } from './turboshaftMapping';
import { gearSign } from './marineMapping';
import { gearWarning as gearWarningOf } from '../ui/gearWarning';
import { gearStateFromPos } from '../ui/instruments';
import { qRotate } from '../math/quat';

export interface AudioInputSource {
  state: AircraftState;
  controls: Controls;
  cameraMode: CameraMode;
  paused: boolean;
  /** Frame dt, s. */
  dt: number;
  /** Surface under the aircraft (env.surfaceAt(x, z)); default 'runway'. */
  surface?: SurfaceType;
  /** Stall warning from the instruments (InstrumentReadings.stallWarning); default: computed from AoA. */
  stallWarning?: boolean;
  /** Camera world position, for exterior distance attenuation and Doppler. */
  cameraPosition?: Vec3;
  /** Gear warning horn from the instruments (HudReadings.gearHorn); default: computed from the state and controls. */
  gearWarning?: boolean;
}

const f = (v: number, d = 0) => (Number.isFinite(v) ? v : d);
/** m/s → kt, finite, 0..1e5. */
const kt = (ms: number) => Math.min(1e5, Math.max(0, f(f(ms) * MS_TO_KT)));
const DEG = Math.PI / 180;
/** A camera moving further than this in one frame was teleported (mode switch/reset), m. */
const TELEPORT_M = 60;
const CLOSING_TAU = 0.15;
const TAIL = { x: 0, y: 0, z: 1 };
/** Smoothing of the helicopter's deceleration (flare) for the blade-slap model, s. */
const DECEL_TAU = 0.5;
const RAD_S_TO_RPM = 60 / (2 * Math.PI);
const clampTo = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, f(v)));
/** Smoothing of the hull's vertical speed relative to the water, s. */
const HEAVE_TAU = 0.08;
/** Propulsors a vessel reports to the sound (a fixed pool). */
const MAX_PROPULSORS = 4;

export function createAudioInputTracker(cfg = CONFIG): (s: AudioInputSource) => AudioInputs {
  let first = true;
  let hasTd = false;
  let tdTime = Number.NaN;
  let tdFpm = Number.NaN;
  let lastGearPos = Number.NaN;
  let lastFlaps = Number.NaN;
  const lastCam = { x: 0, y: 0, z: 0 };
  let hasLastCam = false;
  let closing = 0;
  let lastSpeedBrake: boolean | null = null;
  let speedBrakeTimer = 0;
  // Helicopters: reused rotor inputs, the smoothed deceleration and the horn's hysteresis.
  const rotor: RotorAudioInputs = {
    nrRpm: 0, n1: 0, enginePowerW: 0, torque: 0, thrustN: 0, tailThrustN: 0, collective: 0, vrs: 0, bladeStall: 0,
    groundEffect: 0, climbMs: 0, decelMs2: 0,
  };
  let lastHs = Number.NaN;
  let decel = 0;
  let rotorHorn = false;
  // Vessels: reused inputs, the surface level's last value (for the hull's motion relative to the waves).
  const vessel: VesselAudioInputs = {
    engines: Array.from({ length: MAX_PROPULSORS }, (): MarineEngineAudioInputs => ({ rpm: 0, load: 0, boost: 0, gear: 0, propRps: 0, thrustN: 0 })),
    engineCount: 0, speedMs: 0, planing: 0, trimDeg: 0, aground: false, heaveMs: 0, pitchRate: 0, rollRate: 0, moored: false,
  };
  let lastSurfaceY = Number.NaN;
  let heave = 0;
  // Reused output object: no per-frame allocation. Callers must not keep it across frames.
  const out: AudioInputs = {
    rpm: 0, power: 0, engineRunning: false, starting: false, airspeedKt: 0, onGround: true, groundSpeedKt: 0,
    stallWarning: false, gearMoving: false, flapsMoving: false, touchdownFpm: null, crashed: false,
    cameraMode: 'chase', paused: false, brake: 0, surface: 'runway', gearWarning: false,
    afterburner: 0, speedBrakeMoving: false, aft: 0, rotor: undefined, lowRotorRpm: false, vessel: undefined,
  };

  return (s) => {
    const st = s.state;
    const d = st.derived;
    const dt = Number.isFinite(s.dt) && s.dt > 0 ? Math.min(s.dt, 1) : 0;
    const iasKt = kt(d.ias);

    // Touchdown: once per record (keyed by time + vs so cloned records don't retrigger).
    const tdRec = st.touchdown;
    let touchdownFpm: number | null = null;
    if (tdRec) {
      const isNew = !hasTd || tdRec.time !== tdTime || tdRec.verticalSpeedFpm !== tdFpm;
      if (isNew && !first && Number.isFinite(tdRec.verticalSpeedFpm)) touchdownFpm = tdRec.verticalSpeedFpm;
      hasTd = true;
      tdTime = tdRec.time;
      tdFpm = tdRec.verticalSpeedFpm;
    } else {
      hasTd = false;
    }

    // Gear / flaps travelling.
    const gp = f(st.gearPos, 1);
    const gearMoving = (gp > 1e-4 && gp < 1 - 1e-4) || (Number.isFinite(lastGearPos) && Math.abs(gp - lastGearPos) > 1e-6);
    lastGearPos = gp;
    const notches = cfg.aircraft.flaps.notchesDeg;
    const cmd = notches[Math.max(0, Math.min(notches.length - 1, Math.round(f(s.controls.flapsNotch))))];
    const fd = f(st.flapsDeg, cmd);
    const flapsMoving = Math.abs(fd - cmd) > 0.05 || (Number.isFinite(lastFlaps) && Math.abs(fd - lastFlaps) > 1e-4);
    lastFlaps = fd;

    // Stall warning: the vane trips `warningMarginDeg` before the (flap-adjusted) stall angle.
    let stallWarning = s.stallWarning;
    if (stallWarning === undefined) {
      const ae = cfg.aircraft.aero;
      const stallDeg = ae.stallAlphaDeg + (ae.stallAlphaFlapsShiftDeg * fd) / cfg.aircraft.flaps.notchesDeg[notches.length - 1];
      stallWarning = f(d.alpha) / DEG >= stallDeg - cfg.aircraft.stall.warningMarginDeg && iasKt >= cfg.audio.stallHornMinKt;
    }

    // Speed brake (jets): the hydraulics run for the travel time after every toggle.
    const sb = !!s.controls.speedBrake;
    if (lastSpeedBrake !== null && sb !== lastSpeedBrake) speedBrakeTimer = cfg.audio.jet.speedBrakeTravelS;
    else speedBrakeTimer = Math.max(0, speedBrakeTimer - dt);
    lastSpeedBrake = sb;

    // Listener: distance and Doppler closing speed (aircraft vs camera velocity along the line of sight).
    let listenerDistanceM: number | undefined;
    let closingSpeedMs: number | undefined;
    let aft: number | undefined;
    const cam = s.cameraPosition;
    if (cam && Number.isFinite(cam.x) && Number.isFinite(cam.y) && Number.isFinite(cam.z)) {
      const p = st.position;
      const rx = f(cam.x - p.x), ry = f(cam.y - p.y), rz = f(cam.z - p.z);
      const dist = Math.hypot(rx, ry, rz);
      listenerDistanceM = Number.isFinite(dist) ? dist : undefined;
      let cvx = 0, cvy = 0, cvz = 0;
      if (hasLastCam && dt > 0) {
        const jx = cam.x - lastCam.x, jy = cam.y - lastCam.y, jz = cam.z - lastCam.z;
        if (Math.hypot(jx, jy, jz) < TELEPORT_M) {
          cvx = jx / dt;
          cvy = jy / dt;
          cvz = jz / dt;
        }
      }
      lastCam.x = cam.x;
      lastCam.y = cam.y;
      lastCam.z = cam.z;
      hasLastCam = true;
      if (dist > 1e-3 && Number.isFinite(dist)) {
        // Directivity: the tail (body +Z) direction vs the direction to the camera.
        const tail = qRotate(st.orientation, TAIL);
        const tl = Math.hypot(tail.x, tail.y, tail.z);
        const c = (tail.x * rx + tail.y * ry + tail.z * rz) / (tl * dist);
        aft = Number.isFinite(c) ? Math.max(-1, Math.min(1, c)) : undefined;
        const v = st.velocity;
        const target = ((f(v.x) - cvx) * rx + (f(v.y) - cvy) * ry + (f(v.z) - cvz) * rz) / dist;
        const k = dt > 0 ? 1 - Math.exp(-dt / CLOSING_TAU) : 0;
        closing = first ? f(target) : closing + (f(target) - closing) * k;
        if (!Number.isFinite(closing)) closing = 0;
      }
      closingSpeedMs = closing;
    } else {
      hasLastCam = false;
    }

    const crashed = st.phase === 'crashed';

    // Helicopter: rotor, drivetrain and turboshaft (physical units; turboshaftMapping.ts makes the sound).
    const r = st.rotor;
    if (r) {
      const hs = Math.hypot(f(st.velocity.x), f(st.velocity.z));
      if (!first && Number.isFinite(lastHs) && dt > 0) {
        const k = 1 - Math.exp(-dt / DECEL_TAU);
        decel += ((lastHs - hs) / dt - decel) * k;
        if (!Number.isFinite(decel)) decel = 0;
      } else {
        decel = 0;
      }
      lastHs = hs;
      rotor.nrRpm = clampTo(f(r.omega) * RAD_S_TO_RPM, 0, 2000);
      rotor.n1 = clampTo(r.n1, 0, 1.5);
      rotor.enginePowerW = clampTo(r.enginePower, 0, 1e7);
      rotor.torque = clampTo(r.torque, 0, 5);
      rotor.thrustN = clampTo(r.thrust, -1e6, 1e6);
      rotor.tailThrustN = clampTo(r.tailThrust, -1e6, 1e6);
      rotor.collective = clampTo(r.collective, 0, 1);
      rotor.vrs = clampTo(r.vrs, 0, 1);
      rotor.bladeStall = clampTo(r.bladeStall, 0, 1);
      rotor.groundEffect = clampTo(r.groundEffect, 0, 1);
      rotor.climbMs = clampTo(st.velocity.y, -300, 300);
      rotor.decelMs2 = clampTo(decel, -100, 100);
      rotorHorn = lowRotorRpmHorn(rotorPct(rotor.nrRpm), !!st.onGround, rotor.collective, !!st.engine.running, crashed, rotorHorn);
    } else {
      lastHs = Number.NaN;
      decel = 0;
      rotorHorn = false;
    }

    // Vessel: engines / propulsors, the hull in the water.
    const vs = st.vessel;
    if (vs) {
      const props = Array.isArray(vs.propulsors) ? vs.propulsors : [];
      const n = Math.min(MAX_PROPULSORS, props.length);
      for (let i = 0; i < n; i++) {
        const p = props[i];
        const e = vessel.engines[i];
        e.rpm = clampTo(p?.rpm, 0, 1e5);
        e.load = clampTo(p?.load, 0, 5);
        e.boost = clampTo(p?.boost, 0, 1);
        e.gear = gearSign(p?.gear);
        e.propRps = clampTo(p?.n, -1e4, 1e4);
        e.thrustN = clampTo(p?.thrust, -1e8, 1e8);
      }
      vessel.engineCount = n;
      vessel.speedMs = clampTo(vs.speedMs, -200, 200);
      vessel.planing = clampTo(vs.planing, 0, 3);
      vessel.trimDeg = clampTo(vs.trimDeg, -90, 90);
      vessel.aground = !!vs.aground;
      vessel.moored = !!vs.mooring;
      const w = st.angularVelocity;
      vessel.pitchRate = clampTo(w?.x, -20, 20);
      vessel.rollRate = clampTo(w?.z, -20, 20);
      // The hull's vertical speed relative to the water under it (the waves' own rise and fall removed).
      const sy = f(vs.surfaceY, Number.NaN);
      if (Number.isFinite(sy) && Number.isFinite(lastSurfaceY) && dt > 0 && !first) {
        const rel = clampTo(f(st.velocity.y) - (sy - lastSurfaceY) / dt, -30, 30);
        heave += (rel - heave) * (1 - Math.exp(-dt / HEAVE_TAU));
        if (!Number.isFinite(heave)) heave = 0;
      } else if (!Number.isFinite(lastSurfaceY) || first) {
        heave = clampTo(st.velocity.y, -30, 30);
      }
      lastSurfaceY = sy;
      vessel.heaveMs = clampTo(heave, -30, 30);
    } else {
      lastSurfaceY = Number.NaN;
      heave = 0;
    }

    first = false;
    const gearHorn =
      !r &&
      !vs &&
      (s.gearWarning ??
      gearWarningOf(
        {
          onGround: !!st.onGround, crashed, gear: gearStateFromPos(gp), handleDown: s.controls.gearDown !== false,
          throttlePct: f(s.controls.throttle) * 100, flapsDeg: fd, iasKt,
        },
        cfg,
      ).horn);
    out.rpm = Math.min(1e5, Math.max(0, f(st.engine.rpm)));
    out.power = Math.max(0, Math.min(1, f(st.engine.power)));
    out.engineRunning = !!st.engine.running;
    out.starting = !!st.engine.starting;
    out.airspeedKt = iasKt;
    out.onGround = !!st.onGround && !vs;
    out.groundSpeedKt = kt(d.groundSpeed);
    out.stallWarning = !!stallWarning && !r && !vs; // a helicopter (or a boat) has no stall-warning vane
    out.gearMoving = gearMoving && !vs;
    out.flapsMoving = flapsMoving && !vs;
    out.touchdownFpm = vs ? null : touchdownFpm;
    out.crashed = crashed;
    out.cameraMode = s.cameraMode;
    out.paused = !!s.paused;
    out.brake = Math.max(0, Math.min(1, f(s.controls.brake)));
    out.surface = vs ? 'water' : (s.surface ?? 'runway');
    out.listenerDistanceM = listenerDistanceM;
    out.closingSpeedMs = closingSpeedMs;
    out.crashSpeedKt = crashed && st.crash ? f(st.crash.speedKt, iasKt) : undefined;
    out.gearWarning = !!gearHorn && !crashed;
    out.afterburner = Math.max(0, Math.min(1, f(st.engine.afterburner ?? 0)));
    out.speedBrakeMoving = speedBrakeTimer > 0;
    out.aft = aft;
    out.rotor = r ? rotor : undefined;
    out.lowRotorRpm = rotorHorn;
    out.vessel = vs ? vessel : undefined;
    return out;
  };
}
