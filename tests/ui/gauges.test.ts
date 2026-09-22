import { describe, it, expect } from 'vitest';
import { CONFIG } from '../../src/config';
import {
  GAUGES, SYSTEM_CELLS, asiNeedleDeg, altimeterHandsDeg, vsiNeedleDeg, tachNeedleDeg, attitudeGeometry, turnCoordinatorBankDeg,
  ballOffset, headingCardRotationDeg, drawAirspeed, drawAttitude, drawHeading, drawAltimeter, drawVsi, drawTachometer,
  drawTurnCoordinator, drawSystemsStrip, drawCompassTape, drawPanel, compassLabel,
} from '../../src/ui/gauges';
import { mockCtx, makeReadings } from './fixtures';

const DEG = Math.PI / 180;

/** Every rotate() angle the drawer issued. */
const rotations = (m: ReturnType<typeof mockCtx>) => m.argsOf('rotate').map((a) => a[0] as number);
const hasAngle = (list: number[], rad: number) => list.some((a) => Math.abs(a - rad) < 1e-6);

describe('gauge geometry', () => {
  it('ASI: needle rests at 12 o\'clock; 40 kt at 30°, then 300° for 40→180 kt', () => {
    expect(asiNeedleDeg(0)).toBe(0);
    expect(asiNeedleDeg(40)).toBeCloseTo(30, 6);
    expect(asiNeedleDeg(60)).toBeCloseTo(30 + (20 * 300) / 140, 6);
    expect(asiNeedleDeg(120)).toBeCloseTo(30 + (80 * 300) / 140, 6);
    expect(asiNeedleDeg(180)).toBeCloseTo(330, 6);
    expect(asiNeedleDeg(-20)).toBe(0);
    expect(asiNeedleDeg(999)).toBeLessThan(350);
    expect(asiNeedleDeg(Number.NaN)).toBe(0);
  });

  it('ASI scale is monotonic', () => {
    let last = -1;
    for (let v = 0; v <= 200; v += 0.5) {
      const a = asiNeedleDeg(v);
      expect(a).toBeGreaterThanOrEqual(last);
      last = a;
    }
  });

  it('altimeter hands: 100 ft, 1000 ft and 10 000 ft per revolution', () => {
    expect(altimeterHandsDeg(0)).toEqual({ h100: 0, h1000: 0, h10000: 0 });
    const a = altimeterHandsDeg(1250);
    expect(a.h100).toBeCloseTo(90, 6);
    expect(a.h1000).toBeCloseTo(45, 6);
    expect(a.h10000).toBeCloseTo(4.5, 6);
    expect(altimeterHandsDeg(-100).h100).toBeCloseTo(324, 6);
    expect(altimeterHandsDeg(12500).h10000).toBeCloseTo(45, 6);
  });

  it('VSI: 0 at 9 o\'clock, up is clockwise, ±2000 fpm pegs', () => {
    expect(vsiNeedleDeg(0)).toBe(-90);
    expect(vsiNeedleDeg(1000)).toBeCloseTo(-5, 6);
    expect(vsiNeedleDeg(-1000)).toBeCloseTo(-175, 6);
    expect(vsiNeedleDeg(5000)).toBe(vsiNeedleDeg(2000));
    expect(vsiNeedleDeg(-5000)).toBe(vsiNeedleDeg(-2000));
  });

  it('tach: 0 rpm at -130°, 3500 rpm at +130°, linear', () => {
    expect(tachNeedleDeg(0)).toBe(-130);
    expect(tachNeedleDeg(3500)).toBe(130);
    expect(tachNeedleDeg(1750)).toBeCloseTo(0, 6);
    expect(tachNeedleDeg(9000)).toBe(130);
  });

  it('attitude: pitch up moves the horizon down, right bank rotates it counter-clockwise', () => {
    const level = attitudeGeometry(0, 0, 120);
    expect(level.rotation).toBeCloseTo(0, 10);
    expect(level.offsetY).toBeCloseTo(0, 10);
    const up = attitudeGeometry(10, 0, 120);
    expect(up.offsetY).toBeCloseTo(10 * up.pxPerDeg, 6);
    expect(up.offsetY).toBeGreaterThan(0);
    const right = attitudeGeometry(0, 30, 120);
    expect(right.rotation).toBeCloseTo(-30 * DEG, 10);
    expect(attitudeGeometry(0, 0, 240).pxPerDeg).toBeCloseTo(2 * level.pxPerDeg, 10);
  });

  it('turn coordinator: standard rate (3°/s) banks the little aircraft onto the L/R marks, clamped', () => {
    expect(turnCoordinatorBankDeg(0)).toBe(0);
    expect(turnCoordinatorBankDeg(3)).toBeCloseTo(20, 6);
    expect(turnCoordinatorBankDeg(-3)).toBeCloseTo(-20, 6);
    expect(turnCoordinatorBankDeg(100)).toBeLessThanOrEqual(40);
    expect(ballOffset(1, 100)).toBeGreaterThan(0);
    expect(ballOffset(-1, 100)).toBeCloseTo(-ballOffset(1, 100), 10);
    expect(ballOffset(5, 100)).toBe(ballOffset(1, 100));
  });

  it('heading card rotates opposite the heading', () => {
    expect(headingCardRotationDeg(90)).toBe(-90);
    expect(headingCardRotationDeg(0)).toBeCloseTo(0, 10);
  });

  it('compass labels: letters at the cardinals, tens elsewhere', () => {
    expect(compassLabel(0)).toBe('N');
    expect(compassLabel(90)).toBe('E');
    expect(compassLabel(180)).toBe('S');
    expect(compassLabel(270)).toBe('W');
    expect(compassLabel(30)).toBe('3');
    expect(compassLabel(330)).toBe('33');
  });
});

describe('gauge drawers', () => {
  it('every drawer runs on a recording context, balances save/restore and draws something', () => {
    for (const [name, draw] of Object.entries(GAUGES)) {
      const m = mockCtx();
      draw(m.ctx, 100, 100, 120, makeReadings());
      expect(m.calls.length, name).toBeGreaterThan(10);
      expect(m.argsOf('save').length, name).toBe(m.argsOf('restore').length);
      expect(m.bad(), name).toEqual([]);
    }
    for (const [name, cell] of Object.entries(SYSTEM_CELLS)) {
      const m = mockCtx();
      cell.draw(m.ctx, 50, 20, 40 * cell.aspect, 40, makeReadings());
      expect(m.calls.length, name).toBeGreaterThan(3);
      expect(m.argsOf('save').length, name).toBe(m.argsOf('restore').length);
      expect(m.bad(), name).toEqual([]);
    }
  });

  it('ASI needle is drawn at the right angle for 0, 60 and 120 kt', () => {
    for (const kt of [0, 60, 120]) {
      const m = mockCtx();
      drawAirspeed(m.ctx, 100, 100, 120, makeReadings({ airspeedKt: kt }));
      expect(hasAngle(rotations(m), asiNeedleDeg(kt) * DEG), `${kt} kt`).toBe(true);
    }
  });

  it('ASI face carries the white/green/yellow arcs and red line from the config limits', () => {
    const m = mockCtx();
    drawAirspeed(m.ctx, 100, 100, 120, makeReadings());
    const arcs = m.argsOf('arc');
    const lim = CONFIG.aircraft.limits;
    const want = (kt: number) => (asiNeedleDeg(kt) - 90) * DEG;
    const has = (a0: number, a1: number) => arcs.some((a) => Math.abs((a[3] as number) - a0) < 1e-6 && Math.abs((a[4] as number) - a1) < 1e-6);
    expect(has(want(lim.vsoKt), want(CONFIG.aircraft.flaps.vfeKt))).toBe(true);
    expect(has(want(lim.vs1Kt), want(lim.vnoKt))).toBe(true);
    expect(has(want(lim.vnoKt), want(lim.vneKt))).toBe(true);
    const styles = m.argsOf('set:strokeStyle').map((a) => String(a[0]).toLowerCase());
    expect(styles.some((s) => s.includes('d8') || s.includes('red') || s.startsWith('#e'))).toBe(true);
  });

  it('attitude indicator rotates the ball by -roll and shifts it by pitch', () => {
    const m = mockCtx();
    drawAttitude(m.ctx, 100, 100, 120, makeReadings({ pitchDeg: 8, rollDeg: 25 }));
    const g = attitudeGeometry(8, 25, 120);
    expect(hasAngle(rotations(m), g.rotation)).toBe(true);
    const shifts = m.argsOf('translate').map((a) => a as number[]);
    expect(shifts.some(([x, y]) => Math.abs(x) < 1e-9 && Math.abs(y - g.offsetY) < 1e-6)).toBe(true);
  });

  it('heading indicator rotates the card by -heading; altimeter, VSI and tach needles at their angles', () => {
    const r = makeReadings({ headingDeg: 135, altitudeFt: 1250, verticalSpeedFpm: 500, rpm: 2300 });
    const hi = mockCtx();
    drawHeading(hi.ctx, 100, 100, 120, r);
    expect(hasAngle(rotations(hi), -135 * DEG)).toBe(true);
    const alt = mockCtx();
    drawAltimeter(alt.ctx, 100, 100, 120, r);
    const hands = altimeterHandsDeg(1250);
    for (const a of [hands.h100, hands.h1000, hands.h10000]) expect(hasAngle(rotations(alt), a * DEG)).toBe(true);
    const vsi = mockCtx();
    drawVsi(vsi.ctx, 100, 100, 120, r);
    expect(hasAngle(rotations(vsi), vsiNeedleDeg(500) * DEG)).toBe(true);
    const tach = mockCtx();
    drawTachometer(tach.ctx, 100, 100, 120, r);
    expect(hasAngle(rotations(tach), tachNeedleDeg(2300) * DEG)).toBe(true);
  });

  it('turn coordinator banks the miniature aircraft with the turn rate', () => {
    const m = mockCtx();
    drawTurnCoordinator(m.ctx, 100, 100, 120, makeReadings({ turnRateDegPerSec: 3 }));
    expect(hasAngle(rotations(m), turnCoordinatorBankDeg(3) * DEG)).toBe(true);
  });

  it('gauge faces are labelled like the real instruments', () => {
    const texts = (fn: typeof drawAirspeed) => {
      const m = mockCtx();
      fn(m.ctx, 100, 100, 160, makeReadings());
      return m.texts().join(' ');
    };
    expect(texts(drawAirspeed)).toMatch(/KNOTS/);
    expect(texts(drawAirspeed)).toMatch(/160/);
    expect(texts(drawAltimeter)).toMatch(/29\.92/);
    expect(texts(drawVsi)).toMatch(/VERTICAL SPEED/);
    expect(texts(drawTachometer)).toMatch(/RPM/);
    expect(texts(drawHeading)).toMatch(/\bN\b/);
    expect(texts(drawTurnCoordinator)).toMatch(/2 MIN/);
  });

  it('compass tape puts the current heading label at the centre', () => {
    for (const [hdg, label] of [[0, 'N'], [90, 'E'], [270, 'W'], [30, '3']] as const) {
      const m = mockCtx();
      drawCompassTape(m.ctx, 0, 0, 400, 44, hdg);
      const centred = m.argsOf('fillText').filter((a) => a[0] === label && Math.abs((a[1] as number) - 200) < 1);
      expect(centred.length, `${hdg}`).toBeGreaterThan(0);
      expect(m.texts()).toContain(`${String(Math.round(hdg)).padStart(3, '0')}°`);
    }
  });

  it('systems strip shows throttle, flaps, gear, trim, brakes and engine', () => {
    const m = mockCtx();
    drawSystemsStrip(m.ctx, 0, 0, 520, 52, makeReadings({ throttlePct: 64, flapsDeg: 20, flapsTargetDeg: 20, gear: 'down', gearLight: 'green', rpm: 2310, brakes: true, parkingBrake: true }));
    const t = m.texts().join(' ');
    expect(t).toMatch(/64%/);
    expect(t).toMatch(/FLAPS/);
    expect(t).toMatch(/20°/);
    expect(t).toMatch(/GEAR/);
    expect(t).toMatch(/DOWN/);
    expect(t).toMatch(/TRIM/);
    expect(t).toMatch(/BRAKE/);
    expect(t).toMatch(/PARK/);
    expect(t).toMatch(/2310/);
    expect(m.bad()).toEqual([]);
  });

  it('systems strip can wrap into two rows of three cells', () => {
    const m = mockCtx();
    drawSystemsStrip(m.ctx, 0, 0, 300, 90, makeReadings({ throttlePct: 30, rpm: 1990 }), 2);
    const t = m.texts().join(' ');
    for (const w of ['30%', 'FLAPS', 'GEAR', 'TRIM', 'BRAKE', 'PARK', '1990']) expect(t).toContain(w);
    const ys = m.argsOf('fillText').filter((a) => a[0] === 'THROTTLE' || a[0] === 'TRIM').map((a) => a[2] as number);
    expect(ys[1]).toBeGreaterThan(ys[0] + 30);
    expect(m.bad()).toEqual([]);
  });

  it('systems strip shows the flap target while the flaps travel, and gear transit in red', () => {
    const m = mockCtx();
    drawSystemsStrip(m.ctx, 0, 0, 520, 52, makeReadings({ flapsDeg: 7, flapsTargetDeg: 20, gear: 'transit', gearLight: 'red' }));
    const t = m.texts().join(' ');
    expect(t).toMatch(/→\s?20°/);
    expect(t).toMatch(/TRANSIT/);
  });

  it('drawPanel: the gear lever placards say UP and DOWN once each, whatever the gear does (no duplicate state word)', () => {
    const count = (r: Parameters<typeof drawPanel>[3], word: string) => {
      const m = mockCtx(2048, 1024);
      drawPanel(m.ctx, 2048, 1024, r);
      return m.texts().filter((t) => t === word).length;
    };
    const down = makeReadings({ gear: 'down', gearLight: 'green' });
    const up = makeReadings({ gear: 'up', gearLight: 'off' });
    const transit = makeReadings({ gear: 'transit', gearLight: 'red' });
    expect(count(down, 'DOWN')).toBe(count(up, 'DOWN'));
    expect(count(down, 'DOWN')).toBe(count(transit, 'DOWN'));
    expect(count(transit, 'TRANSIT')).toBe(0);
    // The lever's own placards: exactly one UP and one DOWN besides the VSI's UP/DOWN.
    const m = mockCtx(2048, 1024);
    drawPanel(m.ctx, 2048, 1024, down);
    const vsi = mockCtx();
    drawVsi(vsi.ctx, 100, 100, 400, down);
    expect(count(down, 'DOWN') - vsi.texts().filter((t) => t === 'DOWN').length).toBe(1);
  });

  it('drawPanel: the gear warning lights a red GEAR lamp on the panel (horn conditions), dark otherwise', () => {
    const redStops = (r: Parameters<typeof drawPanel>[3]) => {
      const m = mockCtx(2048, 1024);
      drawPanel(m.ctx, 2048, 1024, r);
      return m.argsOf('addColorStop').filter((a) => a[1] === '#ff7a6e').length;
    };
    const safe = { ...makeReadings({ gear: 'up', gearLight: 'off', throttlePct: 65, engineStatus: 'RUNNING' }), gearHandleDown: false };
    const unsafe = { ...safe, throttlePct: 5 };
    expect(redStops(safe)).toBe(0);
    expect(redStops(unsafe)).toBeGreaterThanOrEqual(2); // annunciator pill + gear-panel lamp
    const m = mockCtx(2048, 1024);
    drawPanel(m.ctx, 2048, 1024, unsafe);
    expect(m.texts()).toContain('GEAR');
  });

  it('small gauges (< simpleFaceBelowPx) use simplified faces: no small print, fewer and larger numerals', () => {
    const fontsPx = (m: ReturnType<typeof mockCtx>) =>
      m.argsOf('set:font').map((a) => Number(/([\d.]+)px/.exec(String(a[0]))?.[1] ?? 'NaN')).filter(Number.isFinite);
    for (const [name, draw] of Object.entries(GAUGES)) {
      for (const size of [72, 96, 111]) {
        const m = mockCtx();
        draw(m.ctx, 100, 100, size, makeReadings());
        const px = fontsPx(m);
        if (px.length) expect(Math.min(...px), `${name} @${size}px`).toBeGreaterThanOrEqual(size * 0.095);
        expect(m.bad(), name).toEqual([]);
      }
      const big = mockCtx();
      const small = mockCtx();
      draw(big.ctx, 100, 100, 140, makeReadings());
      draw(small.ctx, 100, 100, 96, makeReadings());
      expect(small.texts().length, name).toBeLessThanOrEqual(big.texts().length);
    }
    const asi = mockCtx();
    drawAirspeed(asi.ctx, 100, 100, 96, makeReadings());
    expect(asi.texts()).not.toContain('AIRSPEED');
    expect(asi.texts()).toContain('KT');
    const tach = mockCtx();
    drawTachometer(tach.ctx, 100, 100, 96, makeReadings());
    expect(tach.texts()).not.toContain('HOURS');
    expect(tach.texts()).toContain('RPM');
    expect(CONFIG.hud.simpleFaceBelowPx).toBeGreaterThan(CONFIG.hud.gaugeSize1024);
  });

  it('drawPanel lays out the 172RG panel (six-pack, tach, gear, flaps) without NaN', () => {
    const m = mockCtx(2048, 1024);
    drawPanel(m.ctx, 2048, 1024, makeReadings());
    const t = m.texts().join(' ');
    for (const word of ['KNOTS', 'VERTICAL SPEED', 'RPM', 'GEAR', 'FLAPS', '2 MIN']) expect(t).toContain(word);
    expect(m.bad()).toEqual([]);
    expect(m.argsOf('save').length).toBe(m.argsOf('restore').length);
  });
});
