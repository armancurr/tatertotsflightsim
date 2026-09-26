import { it } from 'vitest';
import { createVesselState } from '../../src/physics';
import { DEEP_SEA, SD_CFG, drive, euler, knots } from './seadoo-helpers';
it('wtrace', () => {
  const k = Number(process.env.K ?? 11), N = 20;
  const hdg = (k * 360) / N;
  const c = createVesselState(DEEP_SEA, SD_CFG, { x: k * 37, z: -k * 91, headingDeg: hdg, speedKt: 55, seaTime: k * 13.7 });
  let i = 0;
  drive(c.state, Number(process.env.SEC ?? 2), () => ({ throttle: 1 }), DEEP_SEA, SD_CFG, (t, st) => {
    if (i++ % Number(process.env.EV ?? 6)) return; const v = st.vessel!;
    console.log(`${t.toFixed(2)} kt=${knots(st).toFixed(0)} pitch=${euler(st).pitchDeg.toFixed(1)} q=${st.angularVelocity.x.toFixed(2)} y-s=${(st.position.y - v.surfaceY).toFixed(2)} vy=${st.velocity.y.toFixed(2)} vol=${v.displacedVolume.toFixed(3)} pl=${v.planing.toFixed(2)} fa=${v.rider!.foreAft.toFixed(2)} ${v.rider!.off ?? ''}`);
  });
});
