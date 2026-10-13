import { it } from 'vitest';
import { createVesselState } from '../../src/physics';
import { DEEP_SEA, SD_CALM, drive, euler, knots } from './seadoo-helpers';
it('ft', () => {
  for (const kt of [0, 12, 40]) {
    const c = createVesselState(DEEP_SEA, SD_CALM, { x: 0, z: 0, headingDeg: 0, speedKt: kt });
    let off = '';
    const s = drive(c.state, 10, () => ({ throttle: 1, aileron: 1 }), DEEP_SEA, SD_CALM, (t, st) => { if (!off && !st.vessel!.rider!.aboard) off = `${st.vessel!.rider!.off}@${t.toFixed(2)} kt=${knots(st).toFixed(0)} roll=${euler(st).rollDeg.toFixed(0)} lee=${st.vessel!.leewayDeg.toFixed(0)}`; });
    console.log('FT', kt, off, s.phase, s.derived.r.toFixed(2), knots(s).toFixed(0), euler(s).rollDeg.toFixed(0));
  }
});
