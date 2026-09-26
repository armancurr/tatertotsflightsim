import { it } from 'vitest';
import { SEADOO_AIRCRAFT, type Config } from '../../src/config';
import { createVesselState } from '../../src/physics';
import { DEEP_SEA, SD_CALM, drive, euler, knots } from './seadoo-helpers';
it('tr', () => {
  const o = JSON.parse(process.env.O ?? '{}');
  const ac = structuredClone(SEADOO_AIRCRAFT); const wc = ac.watercraft!;
  for (const [k, v] of Object.entries(o.hull ?? {})) (wc.hull as any)[k] = v;
  for (const [k, v] of Object.entries(o.prop ?? {})) (wc.propulsors[0] as any)[k] = v;
  for (const [k, v] of Object.entries(o.rider ?? {})) (wc.rider as any)[k] = v;
  const cfg: Config = { ...SD_CALM, aircraft: ac };
  const c = createVesselState(DEEP_SEA, cfg, { x: 0, z: 0, headingDeg: 0, speedKt: o.kt ?? 45 });
  let k = 0;
  drive(c.state, o.sec ?? 8, (t) => ({ throttle: o.th ?? 1, aileron: t > 0.5 ? (o.helm ?? 1) : 0 }), DEEP_SEA, cfg, (t, st) => {
    if (k++ % (o.ev ?? 24)) return; const v = st.vessel!;
    console.log(`${t.toFixed(2)} kt=${knots(st).toFixed(0)} roll=${euler(st).rollDeg.toFixed(0)} pitch=${euler(st).pitchDeg.toFixed(1)} r=${st.derived.r.toFixed(2)} lee=${v.leewayDeg.toFixed(0)} lean=${v.rider!.lean.toFixed(2)} pl=${v.planing.toFixed(2)} vol=${v.displacedVolume.toFixed(3)} rpm=${v.propulsors[0].rpm.toFixed(0)} vent=${v.propulsors[0].jet!.ventilation.toFixed(1)} n=${st.derived.loadFactor.toFixed(2)}`);
  });
});
