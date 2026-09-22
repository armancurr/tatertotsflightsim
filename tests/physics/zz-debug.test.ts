import { it } from 'vitest';
import { createInitialState, defaultControls, computeAero } from '../../src/physics';
import { fly, iasKt, pitchHold, bankHold, RUNWAY_ENV, trimmed } from './helpers';
import { toRunwayCoords } from '../../src/world/runway';
it('rotate', () => {
  const s0 = createInitialState(RUNWAY_ENV);
  let s = fly(s0, { ...defaultControls(), throttle: 1 }, 60, { env: RUNWAY_ENV, until: (x) => iasKt(x) >= 55 });
  let n = 0;
  fly(s, (x) => ({ ...defaultControls(), throttle: 1, elevator: pitchHold(x, 9), aileron: bankHold(x, 0) }), 12, { env: RUNWAY_ENV, each: (x) => { if (n++ % 30 === 0) console.log(x.time.toFixed(2), 'ias', iasKt(x).toFixed(1), 'pitch', x.derived.pitchDeg.toFixed(2), 'q', (x.derived.q*57.3).toFixed(2), 'alpha', (x.derived.alpha*57.3).toFixed(1), 'comp', x.wheelCompression.map(c=>c.toFixed(3)).join(','), 'agl', x.derived.altitudeAGL.toFixed(2), x.phase, x.crash?.reason ?? ''); }, until: (x) => x.airborneTime > 2 || x.phase === 'crashed' });
  // rollout crash
  const { state } = trimmed({ altitudeM: 30, iasKt: 55, flapsNotch: 3 });
  const g = createInitialState(RUNWAY_ENV);
  const r0 = { ...g, velocity: { x: 0, y: 0, z: -state.derived.tas }, flapsDeg: 30, phase: 'landed' as const };
  n = 0;
  const e = fly(r0, { ...defaultControls(), flapsNotch: 3, brake: 1, elevator: 0.3 }, 60, { env: RUNWAY_ENV, until: (x) => x.derived.groundSpeed < 0.3 || x.phase === 'crashed', each: (x) => { if (n++ % 20 === 0) console.log('ro', x.time.toFixed(2), 'gs', x.derived.groundSpeed.toFixed(1), 'pitch', x.derived.pitchDeg.toFixed(2), 'comp', x.wheelCompression.map(c=>c.toFixed(3)).join(','), x.phase); } });
  console.log(e.phase, e.crash);
});
