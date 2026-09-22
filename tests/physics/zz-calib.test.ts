import { it } from 'vitest';
import { CONFIG, RAD_TO_DEG, MS_TO_KT } from '../../src/config';
import type { AircraftState, Controls } from '../../src/types';
import { createInitialState, defaultControls, airDensity, step, createApproachState, approachControls, liftCoefficient, stallAlphaRad, solveTrim } from '../../src/physics';
import { toRunwayCoords } from '../../src/world/runway';
import { clamp } from '../../src/math/vec3';
import { fly, trimmed, iasKt, tasKt, altitudeHold, bankHold, pitchHold, DT, RUNWAY_ENV } from './helpers';
const speedHold = (s: AircraftState, kt: number) => clamp(0.02 * (iasKt(s) - kt) - 0.03 * s.derived.q * RAD_TO_DEG, -1, 1);
it('calib', () => {
  const out: Record<string, string> = {};
  // CL max
  let cm = 0; for (let a = 0; a < 25; a += 0.01) cm = Math.max(cm, liftCoefficient(a / RAD_TO_DEG, 0)); out.CLmax_clean = cm.toFixed(3);
  cm = 0; for (let a = 0; a < 25; a += 0.01) cm = Math.max(cm, liftCoefficient(a / RAD_TO_DEG, 30)); out.CLmax_flap30 = cm.toFixed(3);
  // stall speeds
  for (const [n, k] of [[0, 75], [3, 65]] as const) {
    const { state, controls } = trimmed({ altitudeM: 1500, iasKt: k, flapsNotch: n, gearDown: false });
    let at: AircraftState | null = null;
    fly(state, (s) => ({ ...controls, throttle: 0, elevator: Math.min(1, altitudeHold(s, 1500) * 1.5), aileron: bankHold(s, 0) }), 60, { until: (s) => { if (s.stalled) at = s; return s.stalled; } });
    out['stall_flaps' + n] = iasKt(at!).toFixed(1) + ' KIAS';
  }
  // takeoff
  const s0 = createInitialState(RUNWAY_ENV); const a0 = toRunwayCoords(s0.position.x, s0.position.z).along;
  let s = fly(s0, { ...defaultControls(), throttle: 1 }, 60, { env: RUNWAY_ENV, until: (x) => iasKt(x) >= 55 });
  out.groundRoll_to55 = (toRunwayCoords(s.position.x, s.position.z).along - a0).toFixed(0) + ' m, t=' + s.time.toFixed(1) + 's';
  s = fly(s, (x) => ({ ...defaultControls(), throttle: 1, elevator: pitchHold(x, 9), aileron: bankHold(x, 0), rudder: 0.04 }), 20, { env: RUNWAY_ENV, until: (x) => x.phase === 'airborne' });
  out.liftoff = iasKt(s).toFixed(1) + ' KIAS at ' + (toRunwayCoords(s.position.x, s.position.z).along - a0).toFixed(0) + ' m, pitch ' + s.derived.pitchDeg.toFixed(1);
  // Vy climb
  { const { state, controls } = trimmed({ altitudeM: 150, iasKt: 75, gearDown: false });
    const pilot = (x: AircraftState): Controls => ({ ...controls, throttle: 1, elevator: speedHold(x, 75), aileron: bankHold(x, 0), rudder: 0.06 });
    let c = fly(state, pilot, 15); const y0 = c.position.y; c = fly(c, pilot, 30);
    out.climb_Vy_SL = (((c.position.y - y0) / 30) * 196.85).toFixed(0) + ' fpm, pitch ' + c.derived.pitchDeg.toFixed(1) + ', beta ' + (c.derived.beta * RAD_TO_DEG).toFixed(1); }
  // cruise 75% 8000 ft
  { const alt = 2438; const rho = airDensity(alt); const sig = rho / 1.225; const idle = CONFIG.aircraft.engine.idlePower;
    const thr = clamp((0.75 / sig - idle) / (1 - idle), 0, 1);
    const { state, controls } = trimmed({ altitudeM: alt, iasKt: 110, gearDown: false });
    const c = fly(state, (x) => ({ ...controls, throttle: thr, elevator: altitudeHold(x, alt), aileron: bankHold(x, 0) }), 300);
    out.cruise75_8000ft = tasKt(c).toFixed(1) + ' KTAS (' + iasKt(c).toFixed(0) + ' KIAS), rpm ' + c.engine.rpm.toFixed(0);
    const c2 = fly(trimmed({ altitudeM: 300, iasKt: 110, gearDown: false }).state, (x) => ({ ...controls, throttle: (0.75 - idle) / (1 - idle), elevator: altitudeHold(x, 300), aileron: bankHold(x, 0) }), 300);
    out.cruise75_SL = tasKt(c2).toFixed(1) + ' KTAS'; }
  // top speed
  { const { state, controls } = trimmed({ altitudeM: 300, iasKt: 130, gearDown: false });
    const c = fly(state, (x) => ({ ...controls, throttle: 1, elevator: altitudeHold(x, 300), aileron: bankHold(x, 0) }), 300);
    out.topSpeed_SL = tasKt(c).toFixed(1) + ' KTAS'; }
  // glide
  for (const gear of [false, true]) { const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 70, gearDown: gear, flightPathDeg: -6 });
    const pilot = (x: AircraftState): Controls => ({ ...controls, throttle: 0, elevator: speedHold(x, 70), aileron: bankHold(x, 0) });
    let c = fly(state, pilot, 15); const p0 = c.position; c = fly(c, pilot, 60);
    out['glide70_gear' + (gear ? 'Down' : 'Up')] = (Math.hypot(c.position.x - p0.x, c.position.z - p0.z) / (p0.y - c.position.y)).toFixed(2) + ' : 1, vs ' + (c.velocity.y * 196.85).toFixed(0) + ' fpm'; }
  // hands-off cruise
  { const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 110, gearDown: false });
    let mr = 0, md = 0; fly({ ...state, velocity: { ...state.velocity, y: 1 } }, controls, 60, { each: (x) => { mr = Math.max(mr, Math.abs(x.derived.rollDeg)); md = Math.max(md, Math.abs(x.position.y - 1500)); } });
    out.handsOff60s = `max |roll| ${mr.toFixed(1)}°, max |Δalt| ${md.toFixed(1)} m, trim ${controls.elevatorTrim.toFixed(2)}`; }
  // roll rate
  { const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 90 }); let mp = 0;
    fly(state, { ...controls, aileron: 1 }, 1.5, { each: (x) => { mp = Math.max(mp, x.derived.p * RAD_TO_DEG); } }); out.rollRate90kt = mp.toFixed(1) + ' °/s'; }
  // approach
  { const tr = approachControls(); const a = createApproachState();
    out.approach = `throttle ${tr.throttle.toFixed(3)}, trim ${tr.elevatorTrim.toFixed(3)}, pitch ${a.derived.pitchDeg.toFixed(1)}°, alpha ${(a.derived.alpha * RAD_TO_DEG).toFixed(1)}°, rpm ${a.engine.rpm.toFixed(0)}`; }
  // rollout
  { const { state } = trimmed({ altitudeM: 30, iasKt: 55, flapsNotch: 3 }); const g = createInitialState(RUNWAY_ENV);
    const r0: AircraftState = { ...g, velocity: { x: 0, y: 0, z: -state.derived.tas }, flapsDeg: 30, phase: 'landed' };
    const st = toRunwayCoords(r0.position.x, r0.position.z).along;
    const c = fly(r0, { ...defaultControls(), flapsNotch: 3, brake: 1, elevator: 0.3 }, 60, { env: RUNWAY_ENV, until: (x) => x.derived.groundSpeed < 0.3 });
    out.brakeRollout_55kt = (toRunwayCoords(c.position.x, c.position.z).along - st).toFixed(0) + ' m in ' + c.time.toFixed(1) + ' s';
    const c2 = fly(r0, { ...defaultControls(), flapsNotch: 3, elevator: 0.3 }, 200, { env: RUNWAY_ENV, until: (x) => x.derived.groundSpeed < 2 });
    out.noBrakeRollout_to2ms = (toRunwayCoords(c2.position.x, c2.position.z).along - st).toFixed(0) + ' m'; }
  // perf
  { const { state, controls } = trimmed({ altitudeM: 1500, iasKt: 100 }); let x = state; for (let i = 0; i < 5000; i++) x = step(x, controls, DT);
    const t0 = performance.now(); for (let i = 0; i < 50000; i++) x = step(x, controls, DT); out.stepAirMs = ((performance.now() - t0) / 50000).toFixed(4);
    let g = createInitialState(); const t1 = performance.now(); for (let i = 0; i < 50000; i++) g = step(g, { ...defaultControls(), throttle: 0.3 }, DT); out.stepGroundMs = ((performance.now() - t1) / 50000).toFixed(4); }
  console.log(JSON.stringify(out, null, 1));
});
