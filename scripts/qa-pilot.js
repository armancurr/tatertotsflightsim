/**
 * QA pilot — a browser-side script that flies the simulator ONLY through keyboard
 * events (the same path a person uses: DOM keydown/keyup → input manager →
 * smoothed controls → physics). It reads `window.sim` like a pilot reads the
 * instruments, and taps keys in short pulses like a person on a keyboard.
 *
 * Inject into the running page (Playwright: page.addScriptTag({ path })), then:
 *   await window.qaPilot.takeoff();              // roll, rotate at 55 kt, climb out, gear up
 *   await window.qaPilot.climbTo(2500);          // ft AGL
 *   await window.qaPilot.turn(-90, 30);          // heading change (deg, − = left), bank
 *   await window.qaPilot.stallAndRecover();
 *   await window.qaPilot.flyInto(12000, -14000); // aim at a point and descend into it
 *   await window.qaPilot.approachAndLand();      // after window.sim.resetApproach()
 * Progress: window.qaPilot.phase, window.qaPilot.log.
 */
(() => {
  const sim = () => window.sim;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const held = new Set();
  const key = (code, down) => {
    if (down === held.has(code)) return;
    if (down) held.add(code); else held.delete(code);
    const k = { KeyW: 'w', KeyS: 's', KeyG: 'g', KeyF: 'f', Space: ' ' }[code] ?? code;
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: k, bubbles: true }));
  };
  const tap = async (code, ms = 60) => { key(code, true); await sleep(ms); key(code, false); };
  const releaseAll = () => [...held].forEach((c) => key(c, false));
  const wrap180 = (d) => ((((d + 180) % 360) + 360) % 360) - 180;
  const log = [];
  const note = (tag) => { const s = sim(); log.push({ tag, t: s.time, ias: s.airspeed, alt: s.altitude, agl: s.altitudeAGL, pitch: s.pitch, roll: s.roll, hdg: s.heading, vs: s.verticalSpeed, state: s.state, gear: s.gear, flaps: s.flaps, thr: s.throttle, fps: s.fps }); };

  /**
   * One 200 ms control window: proportional pulses on pitch and roll keys.
   * pitchTarget/rollTarget in degrees (null = hands off that axis).
   */
  let lastPitch = null, lastRoll = null;
  async function window200(pitchTarget, rollTarget) {
    const s = sim();
    const dq = lastPitch === null ? 0 : (s.pitch - lastPitch) / 0.2;
    const dp = lastRoll === null ? 0 : (s.roll - lastRoll) / 0.2;
    lastPitch = s.pitch; lastRoll = s.roll;
    const up = pitchTarget === null ? 0 : 0.22 * (pitchTarget - s.pitch) - 0.06 * dq;
    const ur = rollTarget === null ? 0 : 0.12 * (rollTarget - s.roll) - 0.04 * dp;
    const tp = Math.min(200, Math.abs(up) * 200);
    const tr = Math.min(200, Math.abs(ur) * 200);
    if (tp > 15) key(up > 0 ? 'ArrowDown' : 'ArrowUp', true);
    if (tr > 15) key(ur > 0 ? 'ArrowRight' : 'ArrowLeft', true);
    const t0 = performance.now();
    while (performance.now() - t0 < 200) {
      const el = performance.now() - t0;
      if (el >= tp) { key('ArrowDown', false); key('ArrowUp', false); }
      if (el >= tr) { key('ArrowRight', false); key('ArrowLeft', false); }
      await sleep(16);
    }
    key('ArrowDown', false); key('ArrowUp', false); key('ArrowRight', false); key('ArrowLeft', false);
  }
  /** Fly until `done(sim)` or timeout, steering pitch/roll targets from `targets(sim)`. */
  async function fly(targets, done, timeoutMs) {
    const end = performance.now() + timeoutMs;
    lastPitch = lastRoll = null;
    while (performance.now() < end) {
      const s = sim();
      if (s.state === 'crashed') return 'crashed';
      if (done && done(s)) return 'done';
      const { pitch, roll } = targets(s);
      await window200(pitch, roll);
    }
    return 'timeout';
  }
  /** Throttle to a target percent with W/S. */
  async function throttle(pct) {
    for (let i = 0; i < 80; i++) {
      const d = pct - sim().throttle;
      if (Math.abs(d) <= 2) break;
      key(d > 0 ? 'KeyW' : 'KeyS', true);
      await sleep(Math.min(300, Math.abs(d) * 20));
      key('KeyW', false); key('KeyS', false);
      await sleep(30);
    }
  }
  /** Pitch target that holds a vertical speed (fpm) around a base attitude. */
  const pitchForVs = (s, vsTarget, base) => base + Math.max(-6, Math.min(6, (vsTarget - s.verticalSpeed) / 250));

  const api = {
    phase: 'idle',
    log,
    note,
    releaseAll,
    async takeoff() {
      api.phase = 'takeoff roll';
      note('start');
      await throttle(100);
      const r = await fly(() => ({ pitch: null, roll: null }), (s) => s.airspeed >= 55, 60000);
      note('Vr');
      api.phase = 'rotate';
      await fly(() => ({ pitch: 9, roll: 0 }), (s) => s.airspeed >= 70 && s.altitudeAGL > 60, 30000);
      note('positive climb');
      await tap('KeyG');
      api.phase = 'climb';
      await fly(() => ({ pitch: 8, roll: 0 }), (s) => s.altitudeAGL > 400, 60000);
      note('climbing');
      return r;
    },
    async climbTo(aglFt) {
      api.phase = `climb to ${aglFt}`;
      const r = await fly((s) => ({ pitch: s.airspeed < 72 ? 6 : 8, roll: 0 }), (s) => s.altitudeAGL >= aglFt, 240000);
      await throttle(70);
      api.phase = 'level';
      await fly((s) => ({ pitch: pitchForVs(s, 0, 3), roll: 0 }), null, 5000);
      note(`level at ${aglFt}`);
      return r;
    },
    async level(ms) {
      api.phase = 'level';
      return fly((s) => ({ pitch: pitchForVs(s, 0, 3), roll: 0 }), null, ms);
    },
    async turn(deltaDeg, bank = 30) {
      const s0 = sim();
      const target = (s0.heading + deltaDeg + 360) % 360;
      const sign = Math.sign(deltaDeg);
      api.phase = `turn ${deltaDeg > 0 ? 'right' : 'left'} ${Math.abs(deltaDeg)}°`;
      note(api.phase + ' start');
      const r = await fly(
        (s) => {
          const rem = wrap180(target - s.heading);
          const b = Math.abs(rem) < 15 ? rem * (bank / 15) : sign * bank;
          return { pitch: pitchForVs(s, 0, 4), roll: b };
        },
        (s) => Math.abs(wrap180(target - s.heading)) < 3,
        120000,
      );
      await fly((s) => ({ pitch: pitchForVs(s, 0, 3), roll: 0 }), (s) => Math.abs(s.roll) < 3, 6000);
      note(api.phase + ' done');
      return r;
    },
    async stallAndRecover() {
      api.phase = 'stall entry';
      note('stall entry');
      await throttle(0);
      // Hold altitude as speed decays, raising the nose until the wing stalls.
      let r = await fly((s) => ({ pitch: Math.min(22, 4 + (80 - s.airspeed) * 0.6), roll: 0 }), (s) => s.state === 'stalled', 90000);
      note('stalled');
      api.phase = 'stalled';
      await fly(() => ({ pitch: 22, roll: 0 }), null, 1500);
      note('stall held');
      api.phase = 'recovery';
      key('ArrowUp', true);
      await sleep(600);
      key('ArrowUp', false);
      await throttle(100);
      r = await fly((s) => ({ pitch: s.airspeed < 62 ? -4 : 6, roll: 0 }), (s) => s.state !== 'stalled' && s.airspeed > 65 && s.verticalSpeed > 0, 30000);
      note('recovered');
      return r;
    },
    async flyInto(x, z) {
      api.phase = 'descending into terrain';
      note('aim at terrain');
      const r = await fly(
        (s) => {
          const brg = ((Math.atan2(x - s.position.x, -(z - s.position.z)) * 180) / Math.PI + 360) % 360;
          const err = wrap180(brg - s.heading);
          return { pitch: -8, roll: Math.max(-30, Math.min(30, err * 1.2)) };
        },
        (s) => s.state === 'crashed',
        240000,
      );
      note('impact');
      return r;
    },
    async approachAndLand() {
      // From the Shift+R approach state: runway 36, threshold (0, 800), elevation 30 m, 3° glide path.
      api.phase = 'approach';
      note('approach start');
      const thr = { x: 0, z: 800 - 300 }; // aim 300 m past the threshold
      await throttle(42);
      let r = await fly(
        (s) => {
          const dx = s.position.x, dist = s.position.z - thr.z;
          const gpAgl = Math.max(0, dist * Math.tan((3 * Math.PI) / 180)) * 3.28;
          const onPath = s.altitudeAGL - gpAgl; // + above
          // Lateral: steer to the centreline (x = 0) with a heading target, then bank toward it.
          const hdgTarget = Math.max(-20, Math.min(20, -dx * 0.25));
          const rollT = Math.max(-15, Math.min(15, wrap180(hdgTarget - s.heading) * 1.5));
          const vsTarget = -380 - onPath * 3;
          return { pitch: pitchForVs(s, vsTarget, 1), roll: rollT };
        },
        (s) => s.altitudeAGL < 25,
        240000,
      );
      note('flare height');
      api.phase = 'flare';
      await throttle(0);
      r = await fly((s) => ({ pitch: Math.min(7, 2 + (25 - s.altitudeAGL) * 0.25), roll: 0 }), (s) => s.onGround || s.state === 'landed' || s.state === 'crashed', 30000);
      note('touchdown');
      api.phase = 'rollout';
      key('Space', true);
      await fly(() => ({ pitch: null, roll: 0 }), (s) => s.groundSpeed < 2, 60000);
      key('Space', false);
      note('stopped');
      api.phase = 'done';
      return r;
    },
  };
  window.qaPilot = api;
})();
