/**
 * PURE adapter: AircraftState (+ controls, camera) → AudioInputs, with the edge detection the
 * sound engine needs (touchdown once per record, gear/flap motors while the surfaces travel,
 * Doppler closing speed from the camera's motion). Keep one tracker per app; call it every frame.
 */
import { CONFIG, MS_TO_KT } from '../config';
import type { AircraftState, CameraMode, Controls, SurfaceType, Vec3 } from '../types';
import type { AudioInputs } from './types';

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
}

const f = (v: number, d = 0) => (Number.isFinite(v) ? v : d);
/** m/s → kt, finite, 0..1e5. */
const kt = (ms: number) => Math.min(1e5, Math.max(0, f(f(ms) * MS_TO_KT)));
const DEG = Math.PI / 180;
/** A camera moving further than this in one frame was teleported (mode switch/reset), m. */
const TELEPORT_M = 60;
const CLOSING_TAU = 0.15;

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
  // Reused output object: no per-frame allocation. Callers must not keep it across frames.
  const out: AudioInputs = {
    rpm: 0, power: 0, engineRunning: false, starting: false, airspeedKt: 0, onGround: true, groundSpeedKt: 0,
    stallWarning: false, gearMoving: false, flapsMoving: false, touchdownFpm: null, crashed: false,
    cameraMode: 'chase', paused: false, brake: 0, surface: 'runway',
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

    // Listener: distance and Doppler closing speed (aircraft vs camera velocity along the line of sight).
    let listenerDistanceM: number | undefined;
    let closingSpeedMs: number | undefined;
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

    first = false;
    const crashed = st.phase === 'crashed';
    out.rpm = Math.min(1e5, Math.max(0, f(st.engine.rpm)));
    out.power = Math.max(0, Math.min(1, f(st.engine.power)));
    out.engineRunning = !!st.engine.running;
    out.starting = !!st.engine.starting;
    out.airspeedKt = iasKt;
    out.onGround = !!st.onGround;
    out.groundSpeedKt = kt(d.groundSpeed);
    out.stallWarning = !!stallWarning;
    out.gearMoving = gearMoving;
    out.flapsMoving = flapsMoving;
    out.touchdownFpm = touchdownFpm;
    out.crashed = crashed;
    out.cameraMode = s.cameraMode;
    out.paused = !!s.paused;
    out.brake = Math.max(0, Math.min(1, f(s.controls.brake)));
    out.surface = s.surface ?? 'runway';
    out.listenerDistanceM = listenerDistanceM;
    out.closingSpeedMs = closingSpeedMs;
    out.crashSpeedKt = crashed && st.crash ? f(st.crash.speedKt, iasKt) : undefined;
    return out;
  };
}
