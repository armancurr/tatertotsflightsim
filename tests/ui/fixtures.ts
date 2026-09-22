/**
 * Shared helpers for the UI tests: hand-built aircraft states (no physics
 * stepping needed), fast-check arbitraries for random states/controls/readings,
 * and a recording mock of CanvasRenderingContext2D that flags NaN coordinates.
 */
import fc from 'fast-check';
import { CONFIG, KT_TO_MS, FT_TO_M } from '../../src/config';
import type { AircraftState, Controls, InstrumentReadings, Quat, TouchdownRecord } from '../../src/types';
import { createInitialState, defaultControls } from '../../src/physics';
import { quatFromEuler } from '../../src/physics/frames';

const DEG = Math.PI / 180;

export interface StateSpec {
  iasKt?: number;
  altFt?: number;
  headingDeg?: number;
  pitchDeg?: number;
  rollDeg?: number;
  vsFpm?: number;
  alphaDeg?: number;
  betaDeg?: number;
  flapsDeg?: number;
  gearPos?: number;
  phase?: AircraftState['phase'];
  stalled?: boolean;
  onGround?: boolean;
  time?: number;
  rpm?: number;
  running?: boolean;
  starting?: boolean;
  failed?: boolean;
  /** Body rates, rad/s (aircraft convention). */
  p?: number;
  q?: number;
  r?: number;
  groundSpeedKt?: number;
  loadFactor?: number;
  aglFt?: number;
}

/** An aircraft state whose `derived` block says exactly what the spec asks (a consistent-enough fake). */
export function makeState(spec: StateSpec = {}): AircraftState {
  const base = createInitialState();
  const ias = (spec.iasKt ?? 90) * KT_TO_MS;
  const hdg = spec.headingDeg ?? 0;
  const pitch = spec.pitchDeg ?? 0;
  const roll = spec.rollDeg ?? 0;
  const vs = (spec.vsFpm ?? 0) / 196.8504;
  const alt = (spec.altFt ?? 3000) * FT_TO_M;
  const onGround = spec.onGround ?? false;
  const phase = spec.phase ?? (onGround ? 'ground' : 'airborne');
  const gs = spec.groundSpeedKt !== undefined ? spec.groundSpeedKt * KT_TO_MS : ias;
  const h = hdg * DEG;
  return {
    ...base,
    time: spec.time ?? 10,
    position: { x: 0, y: alt, z: 0 },
    velocity: { x: Math.sin(h) * gs, y: vs, z: -Math.cos(h) * gs },
    orientation: quatFromEuler(hdg, pitch, roll),
    angularVelocity: { x: spec.q ?? 0, y: -(spec.r ?? 0), z: -(spec.p ?? 0) },
    engine: {
      ...base.engine,
      running: spec.running ?? true,
      starting: spec.starting ?? false,
      failed: spec.failed ?? false,
      rpm: spec.rpm ?? 2400,
      thrust: 800,
      power: 0.6,
    },
    flapsDeg: spec.flapsDeg ?? 0,
    gearPos: spec.gearPos ?? 1,
    phase,
    stalled: spec.stalled ?? false,
    onGround,
    wheelContact: onGround ? [true, true, true] : [false, false, false],
    touchdown: null,
    crash: null,
    derived: {
      ...base.derived,
      tas: ias,
      ias,
      groundSpeed: gs,
      alpha: (spec.alphaDeg ?? 3) * DEG,
      beta: (spec.betaDeg ?? 0) * DEG,
      verticalSpeed: vs,
      altitudeAGL: (spec.aglFt ?? spec.altFt ?? 3000) * FT_TO_M,
      headingDeg: hdg,
      pitchDeg: pitch,
      rollDeg: roll,
      loadFactor: spec.loadFactor ?? 1,
      density: 1.1,
      p: spec.p ?? 0,
      q: spec.q ?? 0,
      r: spec.r ?? 0,
    },
  };
}

export function makeControls(over: Partial<Controls> = {}): Controls {
  return { ...defaultControls(), ...over };
}

export function makeReadings(over: Partial<InstrumentReadings> = {}): InstrumentReadings {
  return {
    airspeedKt: 95,
    altitudeFt: 3500,
    altitudeAglFt: 3400,
    headingDeg: 270,
    verticalSpeedFpm: 300,
    pitchDeg: 3,
    rollDeg: 10,
    slipSkid: 0,
    turnRateDegPerSec: 1.5,
    throttlePct: 65,
    rpm: 2350,
    engineStatus: 'RUNNING',
    flapsDeg: 0,
    flapsTargetDeg: 0,
    gear: 'up',
    gearLight: 'off',
    brakes: false,
    parkingBrake: false,
    trimPct: 10,
    stallWarning: false,
    overspeed: false,
    aoaDeg: 4,
    gLoad: 1,
    groundSpeedKt: 98,
    state: 'airborne',
    ...over,
  };
}

export function makeTouchdown(over: Partial<TouchdownRecord> = {}): TouchdownRecord {
  return {
    time: 42,
    verticalSpeedFpm: -180,
    airspeedKt: 58,
    rating: 'smooth',
    bankDeg: 1,
    pitchDeg: 4,
    surface: 'runway',
    onRunway: true,
    centerlineOffsetM: 3.2,
    ...over,
  };
}

// ─── fast-check arbitraries ────────────────────────────────────────────────

const num = (min: number, max: number) => fc.double({ min, max, noNaN: true, noDefaultInfinity: true });
/** Mostly sane numbers, sometimes garbage (NaN/±Infinity/huge) — the instruments must survive both. */
const wild = (min: number, max: number) =>
  fc.oneof(
    { weight: 8, arbitrary: num(min, max) },
    { weight: 1, arbitrary: fc.constantFrom(Number.NaN, Infinity, -Infinity, 1e12, -1e12, 0) },
  );

const unitQuat: fc.Arbitrary<Quat> = fc
  .tuple(num(-1, 1), num(-1, 1), num(-1, 1), num(-1, 1))
  .map(([x, y, z, w]) => {
    const n = Math.hypot(x, y, z, w);
    return n < 1e-6 ? { x: 0, y: 0, z: 0, w: 1 } : { x: x / n, y: y / n, z: z / n, w: w / n };
  });

export const arbState: fc.Arbitrary<AircraftState> = fc
  .record({
    time: num(0, 5000),
    y: wild(-500, 12000),
    vx: wild(-120, 120),
    vy: wild(-80, 80),
    vz: wild(-120, 120),
    q: unitQuat,
    wx: wild(-10, 10),
    wy: wild(-10, 10),
    wz: wild(-10, 10),
    rpm: wild(0, 3200),
    running: fc.boolean(),
    starting: fc.boolean(),
    failed: fc.boolean(),
    thrust: wild(-500, 3000),
    flapsDeg: wild(-5, 40),
    gearPos: wild(-0.2, 1.2),
    phase: fc.constantFrom('ground', 'airborne', 'landed', 'crashed') as fc.Arbitrary<AircraftState['phase']>,
    stalled: fc.boolean(),
    onGround: fc.boolean(),
    tas: wild(-5, 120),
    ias: wild(-5, 120),
    gs: wild(0, 120),
    alpha: wild(-Math.PI, Math.PI),
    beta: wild(-Math.PI / 2, Math.PI / 2),
    vs: wild(-80, 80),
    agl: wild(-10, 12000),
    hdg: wild(-720, 720),
    pitch: wild(-90, 90),
    roll: wild(-180, 180),
    lf: wild(-8, 10),
    density: wild(0.3, 1.3),
    p: wild(-8, 8),
    qq: wild(-8, 8),
    r: wild(-8, 8),
  })
  .map((a) => {
    const base = createInitialState();
    return {
      ...base,
      time: a.time,
      position: { x: 0, y: a.y, z: 0 },
      velocity: { x: a.vx, y: a.vy, z: a.vz },
      orientation: a.q,
      angularVelocity: { x: a.wx, y: a.wy, z: a.wz },
      engine: { ...base.engine, rpm: a.rpm, running: a.running, starting: a.starting, failed: a.failed, thrust: a.thrust },
      flapsDeg: a.flapsDeg,
      gearPos: a.gearPos,
      phase: a.phase,
      stalled: a.stalled,
      onGround: a.onGround,
      derived: {
        ...base.derived,
        tas: a.tas,
        ias: a.ias,
        groundSpeed: a.gs,
        alpha: a.alpha,
        beta: a.beta,
        verticalSpeed: a.vs,
        altitudeAGL: a.agl,
        headingDeg: a.hdg,
        pitchDeg: a.pitch,
        rollDeg: a.roll,
        loadFactor: a.lf,
        density: a.density,
        p: a.p,
        q: a.qq,
        r: a.r,
      },
    } satisfies AircraftState;
  });

export const arbControls: fc.Arbitrary<Controls> = fc.record({
  throttle: wild(-0.5, 1.5),
  elevator: wild(-1.5, 1.5),
  aileron: wild(-1.5, 1.5),
  rudder: wild(-1.5, 1.5),
  elevatorTrim: wild(-1.5, 1.5),
  flapsNotch: fc.oneof(fc.integer({ min: -2, max: 6 }), wild(-2, 6)),
  gearDown: fc.boolean(),
  brake: wild(-0.5, 1.5),
  parkingBrake: fc.boolean(),
  engineOn: fc.boolean(),
});

export const arbDt = fc.oneof(
  { weight: 6, arbitrary: num(0, 0.25) },
  { weight: 1, arbitrary: fc.constantFrom(0, -0.1, Number.NaN, 5, Infinity) },
);

/** Random readings, including out-of-range and garbage values the drawers must survive. */
export const arbReadings: fc.Arbitrary<InstrumentReadings> = fc.record({
  airspeedKt: wild(-50, 400),
  altitudeFt: wild(-2000, 60000),
  altitudeAglFt: wild(-100, 40000),
  headingDeg: wild(-720, 720),
  verticalSpeedFpm: wild(-9000, 9000),
  pitchDeg: wild(-180, 180),
  rollDeg: wild(-360, 360),
  slipSkid: wild(-3, 3),
  turnRateDegPerSec: wild(-60, 60),
  throttlePct: wild(-50, 150),
  rpm: wild(-100, 5000),
  engineStatus: fc.constantFrom('RUNNING', 'STARTING', 'OFF', 'FAILED') as fc.Arbitrary<InstrumentReadings['engineStatus']>,
  flapsDeg: wild(-10, 45),
  flapsTargetDeg: wild(-10, 45),
  gear: fc.constantFrom('down', 'up', 'transit') as fc.Arbitrary<InstrumentReadings['gear']>,
  gearLight: fc.constantFrom('green', 'red', 'off') as fc.Arbitrary<InstrumentReadings['gearLight']>,
  brakes: fc.boolean(),
  parkingBrake: fc.boolean(),
  trimPct: wild(-200, 200),
  stallWarning: fc.boolean(),
  overspeed: fc.boolean(),
  aoaDeg: wild(-180, 180),
  gLoad: wild(-10, 10),
  groundSpeedKt: wild(0, 300),
  state: fc.constantFrom('ground', 'airborne', 'stalled', 'landed', 'crashed') as fc.Arbitrary<InstrumentReadings['state']>,
});

// ─── Recording mock canvas context ───────────────────────────────────────────

export interface Call {
  name: string;
  args: unknown[];
}

export interface MockCtx {
  ctx: CanvasRenderingContext2D;
  calls: Call[];
  /** Calls with a non-finite numeric argument (NaN/Infinity coordinates). */
  bad(): Call[];
  /** Arguments of every call to `name`. */
  argsOf(name: string): unknown[][];
  /** Text strings drawn with fillText/strokeText. */
  texts(): string[];
  reset(): void;
}

/** A CanvasRenderingContext2D stand-in that records every method call and property write. */
export function mockCtx(width = 800, height = 600): MockCtx {
  const calls: Call[] = [];
  const props: Record<string, unknown> = {
    canvas: { width, height },
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    font: '10px sans-serif',
    textAlign: 'start',
    textBaseline: 'alphabetic',
    globalAlpha: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    shadowBlur: 0,
    shadowColor: 'transparent',
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: true,
  };
  const gradient = () => ({ addColorStop: (o: number, c: string) => calls.push({ name: 'addColorStop', args: [o, c] }) });
  const special: Record<string, (...a: unknown[]) => unknown> = {
    createLinearGradient: gradient,
    createRadialGradient: gradient,
    createConicGradient: gradient,
    createPattern: () => ({}),
    measureText: (t: unknown) => ({ width: String(t).length * 6, actualBoundingBoxAscent: 7, actualBoundingBoxDescent: 2 }),
    getTransform: () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }),
    getLineDash: () => [],
    isPointInPath: () => false,
  };
  const ctx = new Proxy(props, {
    get(target, key: string) {
      if (key in special) {
        return (...args: unknown[]) => {
          calls.push({ name: key, args });
          return special[key](...args);
        };
      }
      if (key in target) return target[key];
      return (...args: unknown[]) => {
        calls.push({ name: key, args });
      };
    },
    set(target, key: string, value) {
      calls.push({ name: `set:${key}`, args: [value] });
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  const isBad = (v: unknown): boolean => (typeof v === 'number' && !Number.isFinite(v)) || (Array.isArray(v) && v.some(isBad));
  return {
    ctx,
    calls,
    bad: () => calls.filter((c) => c.args.some(isBad) || c.args.some((a) => typeof a === 'string' && /NaN|Infinity|undefined/.test(a))),
    argsOf: (name) => calls.filter((c) => c.name === name).map((c) => c.args),
    texts: () => calls.filter((c) => c.name === 'fillText' || c.name === 'strokeText').map((c) => String(c.args[0])),
    reset: () => {
      calls.length = 0;
    },
  };
}

export const CFG = CONFIG;
