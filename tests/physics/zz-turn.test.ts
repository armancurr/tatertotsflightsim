import { it } from 'vitest';
import { SEADOO_AIRCRAFT, type Config } from '../../src/config';
import { createVesselState } from '../../src/physics';
import { DEEP_SEA, SD_CALM, SD_CFG, drive, euler, knots } from './seadoo-helpers';
it('turns', () => {
  for (const o of JSON.parse(process.env.V ?? '[{}]')) {
    const ac = structuredClone(SEADOO_AIRCRAFT); const wc = ac.watercraft!;
    for (const [k, v] of Object.entries(o.hull ?? {})) (wc.hull as any)[k] = v;
    for (const [k, v] of Object.entries(o.prop ?? {})) (wc.propulsors[0] as any)[k] = v;
    for (const [k, v] of Object.entries(o.rider ?? {})) (wc.rider as any)[k] = v;
    const cfg: Config = { ...(o.sea ? SD_CFG : SD_CALM), aircraft: ac };
    const c = createVesselState(DEEP_SEA, cfg, { x: 0, z: 0, headingDeg: 0, speedKt: o.kt ?? 25 });
    let rmax = -99, rmin = 99, off = ''; const rs: number[] = []; const us: number[] = []; let lee = 0;
    const s = drive(c.state, o.sec ?? 12, (t) => ({ throttle: o.th ?? c.controls.throttle ?? 0, [o.axis ?? 'aileron']: t > 0.5 ? (o.helm ?? 1) : 0 }), DEEP_SEA, cfg, (t, st) => {
      if (t > (o.sec ?? 12) - 5) { rmax = Math.max(rmax, euler(st).rollDeg); rmin = Math.min(rmin, euler(st).rollDeg); rs.push(st.derived.r); us.push(st.vessel!.speedMs); lee = Math.min(lee, st.vessel!.leewayDeg); }
      if (!off && st.vessel!.rider?.off) off = st.vessel!.rider!.off + '@' + t.toFixed(1);
    });
    const r = rs.reduce((a, b) => a + b) / rs.length; const u = us.reduce((a, b) => a + b) / us.length;
    console.log('TURN', JSON.stringify(o).slice(0, 70), `r=${r.toFixed(2)} kt=${(u * 1.94).toFixed(0)} diam=${(2 * u / r).toFixed(0)} roll ${rmin.toFixed(0)}..${rmax.toFixed(0)} lee=${lee.toFixed(0)} ay=${(u * r / 9.81).toFixed(2)}g off=${off} ${s.phase}`);
  }
});
