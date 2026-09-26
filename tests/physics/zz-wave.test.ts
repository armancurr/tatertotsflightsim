import { it } from 'vitest';
import { createVesselState } from '../../src/physics';
import { DEEP_SEA, SD_CFG, drive } from './seadoo-helpers';
it('wave', () => {
  const N = Number(process.env.N ?? 20);
  let spills = 0, n = 0, maxDive = 0, air = 0, under = 0; const reasons: string[] = [];
  for (let k = 0; k < N; k++) {
    const hdg = (k * 360) / N;
    const c = createVesselState(DEEP_SEA, SD_CFG, { x: k * 37 + Number(process.env.OX ?? 0), z: -k * 91, headingDeg: hdg + Number(process.env.OH ?? 0), speedKt: 55, seaTime: k * 13.7 + Number(process.env.OT ?? 0) });
    let off: string | null = null;
    drive(c.state, 8, () => ({ throttle: 1 }), DEEP_SEA, SD_CFG, (t, st) => {
      if (!off && st.vessel!.rider!.off) off = st.vessel!.rider!.off + '@' + t.toFixed(1) + '/' + hdg.toFixed(0);
      if (t > 1) { maxDive = Math.max(maxDive, st.vessel!.surfaceY - st.position.y); if (st.vessel!.surfaceY - st.position.y > 0.3) under += 1 / 120; }
      if (st.vessel!.displacedVolume === 0) air += 1 / 120;
    });
    n++; if (off) { spills++; reasons.push(off); }
  }
  console.log('WAVE', `${spills}/${n}`, reasons.join(' '), 'max CG below surface', maxDive.toFixed(2), 'airtime', air.toFixed(1), 'under', under.toFixed(2));
});
