import { it } from 'vitest';
import { createVesselState } from '../../src/physics';
import { DEEP_SEA, SD_CALM, drive, euler, knots } from './seadoo-helpers';
import { SEADOO_AIRCRAFT } from '../../src/config';
const o = JSON.parse(process.env.O ?? '{}');
const ac = structuredClone(SEADOO_AIRCRAFT); const wc = ac.watercraft!;
for (const [k, v] of Object.entries(o.hull ?? {})) (wc.hull as any)[k] = v;
for (const [k, v] of Object.entries(o.prop ?? {})) (wc.propulsors[0] as any)[k] = v;
for (const [k, v] of Object.entries(o.rider ?? {})) (wc.rider as any)[k] = v;
const CFG = { ...SD_CALM, aircraft: ac };
it('roll', () => {
  const c = createVesselState(DEEP_SEA, CFG, { x: 0, z: 0, headingDeg: 0, speedKt: Number(process.env.KT ?? 50) });
  (globalThis as any).__roll = {};
  let k = 0;
  drive(c.state, Number(process.env.SEC ?? 4), (t) => ({ throttle: Number(process.env.TH ?? 1), aileron: t > 0.5 ? Number(process.env.H ?? 1) : 0 }), DEEP_SEA, CFG, (t, st) => {
    if (k++ % Number(process.env.EV ?? 24) || t < 0.4) return;
    const r = (globalThis as any).__roll;
    console.log(`${t.toFixed(2)} kt=${knots(st).toFixed(0)} roll=${euler(st).rollDeg.toFixed(1)} r=${st.derived.r.toFixed(2)} lee=${st.vessel!.leewayDeg.toFixed(1)} lean=${st.vessel!.rider!.lean.toFixed(2)} n=${st.derived.loadFactor.toFixed(2)} vol=${st.vessel!.displacedVolume.toFixed(2)} ` + Object.entries(r).filter(([n]) => !['wind','moor','contacts'].includes(n)).map(([n, v]: any) => typeof v === 'number' ? `${n}:${v.toFixed(0)}` : `${n}:${v.roll.toFixed(0)}/${v.yaw.toFixed(0)}/${v.fx.toFixed(0)}`).join(' '));
  });
});
