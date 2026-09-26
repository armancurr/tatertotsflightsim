/**
 * The in-page QA pilot (scripts/qa-pilot.js) flies the Bell 206B-3 JetRanger headless through the real
 * keyboard pipeline and the real world (tests/functional/qa-pilot.harness.ts): W/S collective, arrows
 * cyclic (through the stability assist's attitude command), A/D pedals, [ ] pitch-attitude trim.
 *  - From runway 36: lift off to a 5 ft hover, hold it 10 s, a 180° pedal turn, the transition through
 *    translational lift to a 60 kt climb, 1,000 ft, a 90° turn, back to the approach fix and a normal
 *    approach to a hover over the numbers and a vertical touchdown.
 *  - From Shift+R (60 kt on a ~6° approach): straight to the hover and the touchdown.
 *  - A practice autorotation to the ground from 1,000 ft.
 * Set B206_DEBUG=1 to print the pilot's log.
 */
import { describe, it, expect, vi } from 'vitest';
import { getAircraftDef } from '../../src/fleet';
import { createHeadlessRun, qa, type QaDriver } from './qa-pilot.harness';

vi.setConfig({ testTimeout: 60000 });

const debug = (...a: unknown[]) => { if (process.env.B206_DEBUG) console.log(...a); };
const M_FT = 3.280839895;

type HeliPilot = {
  init(o?: Record<string, unknown>): Promise<Record<string, unknown>>;
  liftoff(hoverFt?: number): Promise<string>;
  hover(ms: number): Promise<{ result: string; driftM: number; maxDriftM: number; maxHeightErrFt: number; maxHeadingErrDeg: number; skidFt: number }>;
  hoverTurn(deg: number): Promise<string>;
  transition(kt?: number, climbFpm?: number): Promise<string>;
  climbTo(aglFt: number, o?: Record<string, unknown>): Promise<string>;
  turn(deg: number, bank?: number): Promise<string>;
  approachAndLand(o?: Record<string, unknown>): Promise<string>;
  autorotation(o?: Record<string, unknown>): Promise<string>;
  level(ms: number): Promise<string>;
  readonly heli: boolean;
  profile: Record<string, unknown>;
  stats: Record<string, unknown> & { hoverTurn?: { headingErrDeg: number; maxDriftM: number }; autorotation?: { nrMin: number; nrMax: number; descentFpm: number } };
  log: Record<string, unknown>[];
};

describe('QA pilot flies the JetRanger (headless, keyboard only)', () => {
  it('profile: a helicopter, the skids 4.1 ft below the CG, the assist and the landing ratings from the config', () => {
    const def = getAircraftDef('b206');
    const ac = def.config.aircraft;
    const p = qa.profileFor('b206', ac) as unknown as Record<string, unknown> & { sas: Record<string, number> };
    expect(p.id).toBe('b206');
    expect(p.heli).toBe(true);
    expect(p.gearOffsetFt).toBeCloseTo(-ac.geometry.leftMainWheel.y * M_FT, 3);
    expect(p.smoothFpm).toBe(ac.landing.smoothFpm);
    expect(p.sas.pitchBiasDeg).toBe(ac.rotorcraft!.sas.pitchBiasDeg);
    expect(p.sas.rollCmdDeg).toBe(ac.rotorcraft!.sas.rollCmdDeg);
    // An unknown id with a rotorcraft section is flown as a helicopter too.
    expect((qa.profileFor('some-heli', ac) as Record<string, unknown>).heli).toBe(true);
    // The pure helpers: the trim table and the approach speed schedule.
    const trim = qa.heliTrim as (kt: number, vs: number, p: unknown) => { coll: number; pitch: number };
    expect(trim(0, 0, p).coll).toBeCloseTo(0.408, 3);
    expect(trim(60, 0, p).coll).toBeLessThan(trim(60, 500, p).coll);
    const sched = qa.heliApproachKt as (d: number, p: unknown) => number;
    expect(sched(0, p)).toBe(0);
    expect(sched(800, p)).toBeCloseTo(40, 0);
    expect(sched(100, p)).toBeLessThan(sched(400, p));
  });

  it('init() spots a helicopter from window.sim.rotor, whatever the id; a plane stays a plane', async () => {
    const mk = (snap: Record<string, unknown>): QaDriver => ({ read: () => snap, key: () => {}, sleep: async () => {}, now: () => 0 });
    const heli = qa.createPilot(mk({ aircraft: 'mystery', rotor: { nr: 100, torque: 20 }, position: { x: 0, y: 0, z: 0 } })) as unknown as HeliPilot;
    await heli.init({ noImport: true });
    expect(heli.profile.heli).toBe(true);
    expect(heli.heli).toBe(true);
    const plane = qa.createPilot(mk({ aircraft: 'c172rg', rotor: null, position: { x: 0, y: 0, z: 0 } })) as unknown as HeliPilot;
    await plane.init({ noImport: true });
    expect(plane.profile.heli).toBeUndefined();
    expect(plane.heli).toBe(false);
  });

  it('from runway 36: lift off, hover, 180° pedal turn, transition, 1,000 ft at 60 kt, 90° turn, back to a hover and a landing', async () => {
    const run = createHeadlessRun({ aircraft: 'b206', start: 'runway', maxSimS: 900 });
    const pilot = run.pilot as unknown as HeliPilot;
    await pilot.init({ config: run.cfg });
    expect(pilot.heli).toBe(true);
    const kt = () => run.state.derived.ias * 1.943844;
    const aglFt = () => run.state.derived.altitudeAGL * M_FT;

    // Lift-off to a 5 ft hover (skid height), then hold it 10 s.
    expect(await pilot.liftoff(5)).toBe('done');
    expect(run.state.onGround).toBe(false);
    const hover = await pilot.hover(10000);
    debug('hover', hover);
    expect(hover.result).toBe('done');
    expect(hover.maxDriftM).toBeLessThan(3);
    expect(hover.maxHeightErrFt).toBeLessThan(1.5);
    expect(Math.abs(hover.skidFt - 5)).toBeLessThan(1.5);
    expect(hover.maxHeadingErrDeg).toBeLessThan(3);

    // 180° pedal turn on the spot.
    const h0 = run.state.derived.headingDeg;
    expect(await pilot.hoverTurn(180)).toBe('done');
    const turned = ((run.state.derived.headingDeg - h0 + 540) % 360) - 180;
    debug('hover turn', pilot.stats.hoverTurn, 'turned', turned);
    expect(Math.abs(Math.abs(turned) - 180)).toBeLessThan(5);
    expect(pilot.stats.hoverTurn!.maxDriftM).toBeLessThan(3);
    expect(run.touchdowns.length).toBe(0);

    // Transition through translational lift to a 60 kt climb — without touching the skids on the runway.
    const tTr = run.t;
    expect(await pilot.transition(60, 700)).toBe('done');
    expect(run.touchdowns.length).toBe(0);
    expect(kt()).toBeGreaterThan(55);
    const trMinAgl = Math.min(...run.trace.filter((x) => x.t >= tTr + 2).map((x) => x.agl));
    expect(trMinAgl).toBeGreaterThan(7); // CG ft: the skids never below ~3 ft

    // Climb to 1,000 ft at 60–70 kt.
    const tClimb = run.t;
    expect(await pilot.climbTo(1000)).toBe('done');
    const climbKt = run.trace.filter((x) => x.t >= tClimb + 5).map((x) => x.ias);
    debug(`climb: ${(run.t - tClimb).toFixed(0)} s, ${Math.min(...climbKt)}–${Math.max(...climbKt)} kt, now ${aglFt().toFixed(0)} ft AGL`);
    expect(Math.abs(aglFt() - 1000)).toBeLessThan(80);
    expect(Math.min(...climbKt)).toBeGreaterThan(56);
    expect(Math.max(...climbKt)).toBeLessThan(70);
    expect(kt()).toBeGreaterThan(58);
    expect(kt()).toBeLessThan(70);

    // A 90° turn at 20° of bank, holding the height.
    const hdg0 = run.state.derived.headingDeg;
    const alt0 = aglFt();
    expect(await pilot.turn(90, 20)).toBe('done');
    const dHdg = ((run.state.derived.headingDeg - hdg0 + 540) % 360) - 180;
    expect(Math.abs(dHdg - 90)).toBeLessThan(6);
    expect(Math.abs(aglFt() - alt0)).toBeLessThan(80);

    // Back to the approach fix, the approach, a hover over the numbers and the touchdown.
    const r = await pilot.approachAndLand();
    const td = run.touchdowns[0];
    debug(`landing: ${r}; ${td?.rating} ${td?.verticalSpeedFpm.toFixed(0)} fpm at ${td?.airspeedKt.toFixed(1)} kt, ${td?.centerlineOffsetM?.toFixed(1)} m off the centreline, z ${run.state.position.z.toFixed(0)}; t ${run.t.toFixed(0)} s`);
    if (process.env.B206_DEBUG) for (const e of pilot.log) console.log(JSON.stringify(e));
    expect(run.state.crash, run.state.crash?.reason).toBeNull();
    expect(r).toBe('done');
    expect(td).toBeDefined();
    expect(['butter', 'smooth']).toContain(td.rating);
    expect(Math.abs(td.verticalSpeedFpm)).toBeLessThan(180);
    expect(td.airspeedKt).toBeLessThan(5);
    expect(td.onRunway).toBe(true);
    expect(run.touchdowns.length).toBe(1);
    expect(run.state.onGround).toBe(true);
    expect(run.controls.throttle).toBe(0);
    expect(run.state.derived.groundSpeed).toBeLessThan(0.5);
  });

  it('Shift+R: the 60 kt approach → a hover over the numbers → a gentle touchdown, collective down', async () => {
    const run = createHeadlessRun({ aircraft: 'b206', start: 'approach', maxSimS: 400 });
    const pilot = run.pilot as unknown as HeliPilot;
    await pilot.init({ config: run.cfg });
    const r = await pilot.approachAndLand();
    const td = run.touchdowns[0];
    const aimZ = 800 - 50; // runway 36 threshold (z = +800) + the 50 m aim point
    debug(`Shift+R: ${r}; ${td?.rating} ${td?.verticalSpeedFpm.toFixed(0)} fpm at ${td?.airspeedKt.toFixed(1)} kt; ${Math.abs(run.state.position.z - aimZ).toFixed(1)} m from the aim point; t ${run.t.toFixed(0)} s`);
    const maxSink = Math.max(...run.trace.map((x) => -x.vs));
    const slowSink = Math.max(...run.trace.filter((x) => x.ias < 25 && x.agl > 10).map((x) => -x.vs));
    debug(`max sink ${maxSink} fpm, below 25 kt ${slowSink} fpm`);
    expect(run.state.crash, run.state.crash?.reason).toBeNull();
    expect(r).toBe('done');
    expect(td).toBeDefined();
    expect(['butter', 'smooth']).toContain(td.rating);
    expect(Math.abs(td.verticalSpeedFpm)).toBeLessThan(180);
    expect(td.onRunway).toBe(true);
    expect(run.touchdowns.length).toBe(1);
    expect(Math.hypot(run.state.position.x, run.state.position.z - aimZ)).toBeLessThan(15);
    // A normal approach: never a dive, and slow only with a slow descent (no vortex ring).
    expect(maxSink).toBeLessThan(800);
    expect(slowSink).toBeLessThan(450);
    expect(run.controls.throttle).toBe(0);
  });

  it('autorotation from 1,000 ft: engine off, collective down, the rotor in the green, flare, cushion, a rated touchdown', async () => {
    const run = createHeadlessRun({ aircraft: 'b206', start: { x: 0, z: 2400, aglFt: 1000, headingDeg: 0, speedKt: 60 }, maxSimS: 300 });
    const pilot = run.pilot as unknown as HeliPilot;
    await pilot.init({ config: run.cfg });
    await pilot.level(3000);
    const r = await pilot.autorotation();
    const td = run.touchdowns[0];
    const ar = pilot.stats.autorotation!;
    debug(`autorotation: ${r}; ${ar.descentFpm} fpm, NR ${ar.nrMin}–${ar.nrMax} %; ${td?.rating} ${td?.verticalSpeedFpm.toFixed(0)} fpm at ${td?.airspeedKt.toFixed(0)} kt`);
    expect(run.state.crash, run.state.crash?.reason).toBeNull();
    expect(r).toBe('done');
    expect(run.state.engine.running).toBe(false);
    expect(ar.nrMin).toBeGreaterThan(95);
    expect(ar.nrMax).toBeLessThan(110);
    expect(ar.descentFpm).toBeGreaterThan(1200);
    expect(ar.descentFpm).toBeLessThan(2000);
    expect(td).toBeDefined();
    expect(['butter', 'smooth', 'firm']).toContain(td.rating);
    expect(run.state.derived.groundSpeed).toBeLessThan(1);
  });
});
