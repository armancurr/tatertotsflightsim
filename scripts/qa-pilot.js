/**
 * QA pilot — flies the simulator ONLY through keyboard events (the same path a person uses: DOM
 * keydown/keyup → input manager → smoothed controls → physics). It reads `window.sim` like a pilot
 * reads the instruments, and taps keys in short pulses like a person on a keyboard. It never
 * teleports or writes sim state: a sortie starts from the runway, `?spawn=` or R / Shift+R, and
 * everything after that is stick, throttle, switches and the trigger.
 *
 * Browser (Playwright: page.addScriptTag({ path })):
 *   await qaPilot.init();                        // reads the aircraft (window.sim.aircraft) → profile from its config
 *   await qaPilot.takeoff();                     // per aircraft: roll, rotate at Vr, gear/flaps up, climb out
 *   await qaPilot.climbTo(2500);                 // ft AGL
 *   await qaPilot.turn(-90, 30);                 // heading change (deg, − = left), bank
 *   await qaPilot.gTurn(4, 180);                 // a level turn at 4 g
 *   await qaPilot.dash({ mach: 1.1 });           // afterburner dash (F-16)
 *   await qaPilot.stallAndRecover();
 *   await qaPilot.flyInto(12000, -14000);        // aim at a point and descend into it
 *   await qaPilot.approachAndLand();             // stabilised 3° approach, flare, rollout (after Shift+R, or from a pattern)
 *   await qaPilot.circuit();                     // Cessna: a full traffic pattern from the runway, to a full stop
 *   await qaPilot.rtbAndLand();                  // from anywhere: pattern entry → downwind → base → final → land
 *   await qaPilot.flyToRange();  qaPilot.pickTarget('tank');  await qaPilot.gunRun(id);  await qaPilot.mavShot(id);
 * Progress: qaPilot.phase, qaPilot.log, qaPilot.stats.
 *
 * Node (tests/functional/qa-pilot*.test.ts): the pure maths is on `globalThis.qaPilotLib`, and
 * `qaPilotLib.createPilot(driver)` runs this same pilot against the headless physics.
 */
(() => {
  'use strict';
  const G = typeof globalThis !== 'undefined' ? globalThis : window;
  const D2R = Math.PI / 180;
  const R2D = 180 / Math.PI;
  const M_FT = 3.280839895;
  const KT_MS = 0.514444;
  const FPM_MS = 1 / 196.850394;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const fin = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const wrap180 = (d) => ((((fin(d) + 180) % 360) + 360) % 360) - 180;
  const wrap360 = (d) => ((fin(d) % 360) + 360) % 360;

  // ─── ISA (same maths as src/physics/atmosphere.ts) → Mach from IAS ─────────
  const T0 = 288.15;
  const LAPSE = 0.0065;
  const R_AIR = 287.053;
  const G0 = 9.80665;
  const EXPO = G0 / (R_AIR * LAPSE) - 1;
  const T11 = T0 - LAPSE * 11000;
  function densityRatio(altM) {
    const h = clamp(fin(altM), -1000, 30000);
    if (h <= 11000) return Math.pow(1 - (LAPSE * h) / T0, EXPO);
    return Math.pow(T11 / T0, EXPO) * Math.exp((-G0 * (h - 11000)) / (R_AIR * T11));
  }
  function speedOfSound(altM) {
    const h = clamp(fin(altM), -1000, 30000);
    return Math.sqrt(1.4 * R_AIR * (h <= 11000 ? T0 - LAPSE * h : T11));
  }
  /** Mach number from indicated airspeed (kt) and altitude (ft MSL), as the physics defines IAS. */
  function machFrom(iasKt, altFt) {
    const altM = fin(altFt) / M_FT;
    const tas = (fin(iasKt) * KT_MS) / Math.sqrt(densityRatio(altM));
    return tas / speedOfSound(altM);
  }

  // ─── Aircraft profiles ──────────────────────────────────────────────────────
  /**
   * How this pilot flies each aircraft. Numbers come from the aircraft's config where it has them
   * (V-speeds, landing ratings, gear geometry, flap notches, the gun), otherwise from the brief /
   * flight manuals. Control gains are the pilot's "hands" for that aircraft's keyboard response.
   */
  const BASE = {
    c172rg: {
      jet: false, fbw: false, afterburner: false,
      vrKt: 55, rotatePitchDeg: 9, climbKt: 75, climbPitchMaxDeg: 12, cruiseKt: 105,
      takeoffThrottle: 100, climbThrottle: 100, cruiseThrottle: 75,
      approachKt: 65, finalFlapsNotch: 3, patternFlapsNotch: 1, patternAglFt: 800, patternKt: 75, finalLengthM: 1400,
      maxBankDeg: 30, patternBankDeg: 25, maxThrottle: 100,
      // Flare: wheel height (ft) at which to begin = sink × lead, clamped; the sink target falls with height.
      flareLeadS: 4.5, flareMinFt: 8, flareMaxFt: 28, touchdownSinkFpm: 70, maxFlarePitchDeg: 10, minFlarePitchDeg: -2, flareGain: 0.6, flareIdle: 'entry',
      trackKdegPerM: 0.25, finalMaxCorrDeg: 20,
      pitchKp: 0.22, pitchKd: 0.06, rollKp: 0.12, rollKd: 0.04, yawKp: 0.08, yawKd: 0.03, flareKp: 0.3, flareKd: 0.15,
      speedKp: 2.5, speedKi: 0.6, throttleIdle: 0, approachThrottle: 45,
    },
    f16: {
      jet: true, fbw: true, afterburner: true,
      vrKt: 150, rotatePitchDeg: 11, climbKt: 350, climbPitchMaxDeg: 20, cruiseKt: 420,
      takeoffThrottle: 100, climbThrottle: 88, cruiseThrottle: 80,
      rollSpeedScale: true,
      approachKt: 140, approachAoaDeg: 10, finalFlapsNotch: 2, patternFlapsNotch: 0, patternAglFt: 1500, patternKt: 250, finalLengthM: 5000,
      maxBankDeg: 60, patternBankDeg: 35, maxThrottle: 88,
      flareLeadS: 3, flareMinFt: 10, flareMaxFt: 36, touchdownSinkFpm: 200, maxFlarePitchDeg: 12, minFlarePitchDeg: 0, flareGain: 0.8, flareIdle: 'entry',
      trackKdegPerM: 0.08, finalMaxCorrDeg: 15,
      pitchKp: 0.12, pitchKd: 0.04, rollKp: 0.05, rollKd: 0.015, yawKp: 0.05, yawKd: 0.02, flareKp: 0.4, flareKd: 0.12,
      speedKp: 1.2, speedKi: 0.35, throttleIdle: 0, approachThrottle: 60,
    },
    a10: {
      jet: true, fbw: true, afterburner: false,
      vrKt: 120, rotatePitchDeg: 10, climbKt: 210, climbPitchMaxDeg: 15, cruiseKt: 300,
      takeoffThrottle: 100, climbThrottle: 100, cruiseThrottle: 85,
      rollSpeedScale: true,
      approachKt: 135, finalFlapsNotch: 2, patternFlapsNotch: 0, patternAglFt: 1500, patternKt: 200, finalLengthM: 4000,
      maxBankDeg: 60, patternBankDeg: 30, maxThrottle: 100,
      flareLeadS: 3, flareMinFt: 10, flareMaxFt: 32, touchdownSinkFpm: 180, maxFlarePitchDeg: 9, minFlarePitchDeg: -1, flareGain: 0.8, flareIdle: 'entry',
      trackKdegPerM: 0.1, finalMaxCorrDeg: 15,
      pitchKp: 0.12, pitchKd: 0.04, rollKp: 0.05, rollKd: 0.015, yawKp: 0.05, yawKd: 0.02, flareKp: 0.4, flareKd: 0.12,
      speedKp: 1.2, speedKi: 0.35, throttleIdle: 0, approachThrottle: 60,
      gun: { muzzleVelocity: 1010, boresightDownDeg: 2, rateRps: 65 },
    },
    /**
     * Boeing 747-400 (flown light): gentle hands (big inertia, slow response — small, early inputs),
     * flaps 20 for take-off (Vr ~145, rotate ~2°/s to ~9°, V2 + 10 climb), flaps 30 for landing,
     * a long stabilised final at ~150 kt slowing to Vref ~130 + 5 over the threshold, a flare begun
     * high (the mains are ~16 ft below the pilot's reference and far behind him), pitch kept well
     * below the ~11° tail-strike attitude.
     */
    b747: {
      jet: true, fbw: false, afterburner: false, gentle: true,
      vrKt: 145, rotatePitchDeg: 8.5, climbKt: 180, climbPitchMaxDeg: 14, cruiseKt: 280,
      takeoffThrottle: 100, climbThrottle: 95, cruiseThrottle: 70, takeoffFlapsNotch: 3,
      rollSpeedScale: true,
      approachKt: 150, vrefKt: 130, finalFlapsNotch: 5, patternFlapsNotch: 3, patternAglFt: 2000, patternKt: 190, finalLengthM: 9000,
      maxBankDeg: 25, patternBankDeg: 25, maxThrottle: 100,
      flareLeadS: 6, flareMinFt: 25, flareMaxFt: 60, touchdownSinkFpm: 180, maxFlarePitchDeg: 7.5, minFlarePitchDeg: 1.5, flareGain: 0.5, flareIdle: 'entry',
      trackKdegPerM: 0.05, finalMaxCorrDeg: 10,
      pitchKp: 0.1, pitchKd: 0.08, rollKp: 0.03, rollKd: 0.02, yawKp: 0.04, yawKd: 0.02, flareKp: 0.25, flareKd: 0.12,
      speedKp: 1.2, speedKi: 0.3, throttleIdle: 0, approachThrottle: 50,
    },
  };

  /**
   * Profile for aircraft `id`, refined from its config (`ac` = AircraftConfig, `weapons` =
   * WeaponsConfig) when given: Vr, the landing ratings, the main-gear height, the flap notches.
   */
  function profileFor(id, ac, weapons) {
    const key = BASE[id] ? id : id === 'a10c' ? 'a10' : id === '747' || id === 'b744' ? 'b747' : 'c172rg';
    const p = { id: key, ...structuredCloneSafe(BASE[key]) };
    if (ac && typeof ac === 'object') {
      const lim = ac.limits || {};
      if (fin(lim.vrKt) > 0) p.vrKt = lim.vrKt;
      if (key === 'c172rg' && fin(lim.vyKt) > 0) p.climbKt = lim.vyKt;
      const land = ac.landing || {};
      p.firmFpm = fin(land.firmFpm, 600);
      p.smoothFpm = fin(land.smoothFpm, 300);
      p.butterFpm = fin(land.butterFpm, 120);
      p.minPitchAtTouchdownDeg = fin(land.minPitchDeg, -5);
      const geo = ac.geometry || {};
      const mw = geo.leftMainWheel;
      if (mw && Number.isFinite(mw.y)) p.gearOffsetFt = -mw.y * M_FT;
      const notches = ac.flaps && Array.isArray(ac.flaps.notchesDeg) ? ac.flaps.notchesDeg : null;
      if (notches) {
        p.maxFlapsNotch = notches.length - 1;
        p.finalFlapsNotch = Math.min(p.finalFlapsNotch, p.maxFlapsNotch);
        p.patternFlapsNotch = Math.min(p.patternFlapsNotch, p.maxFlapsNotch);
        p.autoFlapsWithGear = fin(ac.flaps.autoWithGearDeg) > 0;
      }
      const eng = ac.engine || {};
      if (eng.jet && fin(eng.jet.abDetent) > 0 && eng.jet.maxThrustN > eng.jet.milThrustN) {
        p.afterburner = true;
        // Stay just below the afterburner detent unless asked for it.
        p.maxThrottle = Math.floor(eng.jet.abDetent * 100) - 2;
        p.climbThrottle = Math.min(p.climbThrottle, p.maxThrottle);
      } else if (p.jet) {
        p.afterburner = false;
        p.maxThrottle = 100;
      }
      // A conventional (non fly-by-wire) jet — the calibrated A-10 — wants firmer hands in pitch.
      if (p.jet && 'fbw' in ac) {
        p.fbw = !!ac.fbw;
        if (!p.fbw && !p.gentle) { p.pitchKp = 0.2; p.pitchKd = 0.06; p.pitchSpeedScale = true; p.autoTrim = true; p.gKp = 0.3; p.gKd = 0.05; }
        if (!p.fbw && p.gentle) { p.pitchSpeedScale = true; p.autoTrim = true; p.gKp = 0.12; p.gKd = 0.05; }
      }
      const stall = fin(lim.vsoKt);
      if (key === 'a10' && stall > 0) p.approachKt = Math.max(p.approachKt, Math.round(stall * 1.3));
    }
    p.firmFpm ??= 600;
    p.smoothFpm ??= 300;
    p.butterFpm ??= 120;
    p.gearOffsetFt ??= key === 'c172rg' ? 4 : key === 'f16' ? 5.7 : key === 'b747' ? 16.4 : 6.4;
    p.maxFlapsNotch ??= key === 'c172rg' ? 3 : key === 'b747' ? 5 : 2;
    if (weapons && weapons.gun) {
      p.gun = { muzzleVelocity: fin(weapons.gun.muzzleVelocity, 1000), boresightDownDeg: fin(weapons.gun.boresightDownDeg, 0), rateRps: fin(weapons.gun.rateRps, 60) };
    }
    if (weapons && weapons.missiles) {
      const m = weapons.missiles;
      p.missile = { maxRangeM: fin(m.maxRangeM, 8000), minRangeM: fin(m.minRangeM, 400), selectConeDeg: fin(m.selectConeDeg ?? m.acquireConeDeg, 10), lockTimeS: fin(m.lockTimeS, 0.8), speed: fin(m.speed, 300) };
    }
    return p;
  }
  function structuredCloneSafe(o) {
    return JSON.parse(JSON.stringify(o));
  }

  // ─── Landing: the flare law (pure) ──────────────────────────────────────────
  /**
   * Wheel height (ft) at which to begin the flare for a given sink rate (fpm, either sign): the
   * pilot starts rounding out `flareLeadS` seconds before the wheels would touch, never lower than
   * flareMinFt nor higher than flareMaxFt.
   */
  function flareHeightFt(sinkFpm, p) {
    const sink = Math.abs(fin(sinkFpm, 0));
    return clamp((sink / 60) * p.flareLeadS, p.flareMinFt, p.flareMaxFt);
  }
  /**
   * Target sink rate (fpm, positive = down) at wheel height `wheelFt` during the flare that began
   * with sink `sinkAtEntryFpm`: falls linearly with height from the entry sink to the touchdown
   * sink (an exponential round-out), never below the touchdown sink (so it always lands).
   */
  function flareSinkFpm(wheelFt, sinkAtEntryFpm, p) {
    const hF = flareHeightFt(sinkAtEntryFpm, p);
    const entry = Math.max(p.touchdownSinkFpm, Math.abs(fin(sinkAtEntryFpm, p.touchdownSinkFpm)));
    const h = clamp(fin(wheelFt, 0), 0, hF);
    return p.touchdownSinkFpm + (entry - p.touchdownSinkFpm) * (h / hF);
  }
  /** Flight-path angle (deg) of a vertical speed (fpm) at a ground speed (kt). */
  function pathDeg(vsFpm, groundKt) {
    return Math.atan2(fin(vsFpm) * FPM_MS, Math.max(20, fin(groundKt, 20)) * KT_MS) * R2D;
  }
  /**
   * Flare pitch target (deg): the attitude that puts the flight path on the flare's sink target at
   * this height (pitch = α + γ), with extra lead on the path error; clamped to
   * [minFlarePitchDeg, maxFlarePitchDeg] (the tail-strike attitude is never asked for).
   * Lower → never less nose-up (monotone in height).
   */
  function flarePitch(wheelFt, vsFpm, aoaDeg, groundKt, pitchDeg, sinkAtEntryFpm, p) {
    const vsT = -flareSinkFpm(wheelFt, sinkAtEntryFpm, p);
    const gT = pathDeg(vsT, groundKt);
    const g = pathDeg(vsFpm, groundKt);
    const alpha = clamp(fin(aoaDeg, 0), -5, 25);
    const want = alpha + gT + p.flareGain * (gT - g);
    return clamp(Number.isFinite(want) ? want : p.maxFlarePitchDeg, p.minFlarePitchDeg, p.maxFlarePitchDeg);
  }
  /**
   * The whole landing law in one place: above the flare height it is the approach ('approach',
   * pitch = the glide-path attitude passed in), below it the flare. Returns { mode, pitch }.
   */
  function landingPitchTarget(wheelFt, vsFpm, aoaDeg, groundKt, pitchDeg, approachPitchDeg, flareEntrySinkFpm, p) {
    const entry = flareEntrySinkFpm === null || flareEntrySinkFpm === undefined ? Math.abs(fin(vsFpm)) : flareEntrySinkFpm;
    if (fin(wheelFt, 0) > flareHeightFt(entry, p)) return { mode: 'approach', pitch: approachPitchDeg };
    return { mode: 'flare', pitch: flarePitch(wheelFt, vsFpm, aoaDeg, groundKt, pitchDeg, entry, p) };
  }

  // ─── Guidance (pure) ────────────────────────────────────────────────────────
  /** Bearing (deg true) from (x, z) to (tx, tz). World +X east, +Z south. */
  function bearingTo(x, z, tx, tz) {
    return wrap360(Math.atan2(tx - x, -(tz - z)) * R2D);
  }
  /** Cross-track (m, + = right of the course line) and along-track (m) of (x, z) w.r.t. a line through (ax, az) on `courseDeg`. */
  function lineCoords(x, z, ax, az, courseDeg) {
    const c = courseDeg * D2R;
    const dx = Math.sin(c);
    const dz = -Math.cos(c);
    const rx = x - ax;
    const rz = z - az;
    return { along: rx * dx + rz * dz, cross: rx * Math.cos(c) + rz * Math.sin(c) };
  }
  /** Track angle (deg) to fly to converge on a course line: course − k·cross, at most maxInterceptDeg off. */
  function lineHeading(x, z, ax, az, courseDeg, kDegPerM, maxInterceptDeg) {
    const { cross } = lineCoords(x, z, ax, az, courseDeg);
    return wrap360(courseDeg - clamp(cross * kDegPerM, -maxInterceptDeg, maxInterceptDeg));
  }
  /** Pitch (deg) that flies vertical speed `vsFpm`: α + the target path + lead on the path error. */
  function pitchForVs(s, vsFpm, lead = 0.8) {
    const gs = Math.max(fin(s.groundSpeed), fin(s.airspeed) * 0.7, 30);
    const gT = pathDeg(vsFpm, gs);
    const g = pathDeg(s.verticalSpeed, gs);
    const alpha = clamp(fin(s.aoa, 0), -5, 25) * Math.cos(clamp(fin(s.roll), -80, 80) * D2R);
    return alpha + gT + lead * (gT - g);
  }
  /**
   * Final approach targets for runway `rw` ({ thrX, thrZ, courseDeg, fieldFt, aimM, gsDeg }):
   * the glide-path vertical speed and the track to the extended centreline.
   */
  function glidePathTargets(s, p, rw) {
    const c = lineCoords(s.position.x, s.position.z, rw.thrX, rw.thrZ, rw.courseDeg);
    const distM = rw.aimM - c.along;
    const gpFt = Math.max(0, distM * Math.tan(rw.gsDeg * D2R)) * M_FT;
    const heightFt = fin(s.altitude) - rw.fieldFt;
    const aboveFt = heightFt - gpFt;
    const gs = Math.max(fin(s.groundSpeed), 40);
    const nominal = -gs * 101.27 * Math.tan(rw.gsDeg * D2R);
    const vsFpm = clamp(nominal - 3 * aboveFt, nominal * 2.2, Math.min(0, nominal * 0.1 + 150));
    const trackDeg = wrap360(rw.courseDeg - clamp(c.cross * p.trackKdegPerM, -p.finalMaxCorrDeg, p.finalMaxCorrDeg));
    return { vsFpm, trackDeg, aboveFt, distM, crossM: c.cross, alongM: c.along, heightFt };
  }

  /** The runway frame the pilot uses (defaults: runway 36 at Tater Field — config.world.airport). */
  function runwayInfo(airport) {
    const a = airport || { elevation: 30, runway: { center: { x: 0, z: 0 }, headingDeg: 360, length: 1600 } };
    const h = a.runway.headingDeg * D2R;
    const half = a.runway.length / 2;
    return {
      thrX: a.runway.center.x - Math.sin(h) * half,
      thrZ: a.runway.center.z + Math.cos(h) * half,
      courseDeg: wrap360(a.runway.headingDeg),
      fieldFt: a.elevation * M_FT,
      lengthM: a.runway.length,
      aimM: 300,
      gsDeg: 3,
    };
  }

  // ─── The pilot ──────────────────────────────────────────────────────────────
  /**
   * driver: { read() → window.sim-like snapshot, key(code, down, shift?), sleep(ms), now() → ms }.
   * opts: { profile?, runway? (config.world.airport), windowMs? }.
   */
  function createPilot(drv, opts = {}) {
    const sim = () => drv.read();
    const sleep = (ms) => drv.sleep(ms);
    const held = new Set();
    const key = (code, down, shift = false) => {
      if (down === held.has(code)) return;
      if (down) held.add(code); else held.delete(code);
      drv.key(code, down, shift);
    };
    const tap = async (code, ms = 60, shift = false) => { key(code, true, shift); await sleep(ms); key(code, false); await sleep(40); };
    const releaseAll = () => [...held].forEach((c) => key(c, false));
    let P = opts.profile || profileFor((sim() && sim().aircraft) || 'c172rg');
    let RW = runwayInfo(opts.runway);
    const log = [];
    const stats = { takeoffDistM: null, takeoffAt: null, liftoffAt: null, landing: null, events: [] };
    const note = (tag, extra) => {
      const s = sim();
      const e = { tag, t: s.time, ias: s.airspeed, alt: s.altitude, agl: s.altitudeAGL, pitch: s.pitch, roll: s.roll, hdg: s.heading, vs: s.verticalSpeed, aoa: s.aoa, g: s.gLoad, state: s.state, gear: s.gear, flaps: s.flaps, thr: s.throttle, fps: s.fps, x: s.position && s.position.x, z: s.position && s.position.z, ...(extra || {}) };
      log.push(e);
      return e;
    };
    const wheelFt = (s) => fin(s.altitudeAGL) - P.gearOffsetFt;

    // Rates from successive windows (the snapshot has no body rates or ground track).
    let last = null;
    const rates = { q: 0, p: 0, r: 0, g: 0, trackDeg: null };
    function updateRates(s) {
      const t = drv.now();
      if (last && t > last.t) {
        const dt = (t - last.t) / 1000;
        rates.q = (s.pitch - last.pitch) / dt;
        rates.p = (s.roll - last.roll) / dt;
        rates.r = wrap180(s.heading - last.hdg) / dt;
        rates.g = (fin(s.gLoad, 1) - last.g) / dt;
        const dx = s.position.x - last.x;
        const dz = s.position.z - last.z;
        if (Math.hypot(dx, dz) > 0.5) rates.trackDeg = wrap360(Math.atan2(dx, -dz) * R2D);
      }
      last = { t, pitch: s.pitch, roll: s.roll, hdg: s.heading, x: s.position.x, z: s.position.z, g: fin(s.gLoad, 1) };
    }
    const resetRates = () => { last = null; rates.q = rates.p = rates.r = rates.g = 0; rates.trackDeg = null; };
    const track = (s) => (rates.trackDeg === null ? s.heading : rates.trackDeg);

    const throttleRatePct = 45; // config.controls.throttleRate × 100 (%/s)
    let trimI = 0;
    /**
     * Where this pilot's keys have put the elevator (−1…1): a held arrow moves it 2.2/s toward the
     * stop (3.5/s when reversing), released it eases back to neutral at 0.8/s (config.controls
     * pitchRate / returnRate / pitchReturnRate) — the pilot knows how long it held the keys.
     */
    let elevEst = 0;
    const ELEV = { rate: 2.2, reverse: 3.5, back: 0.8 };
    const moveTo = (v, target, d) => (v < target ? Math.min(target, v + d) : Math.max(target, v - d));
    function elevAfter(e, dir, holdS, restS) {
      let v = e;
      if (dir !== 0 && holdS > 0) v = moveTo(v, dir, (dir * v < 0 ? ELEV.reverse : ELEV.rate) * holdS);
      return moveTo(v, 0, ELEV.back * Math.max(0, restS));
    }
    /** Key and hold time (s) that leave the elevator at `want` after a window of T s (best effort). */
    function elevPulse(e, want, T) {
      const w = clamp(want, -1, 1);
      const free = elevAfter(e, 0, 0, T);
      if (Math.abs(free - w) < 0.004) return { dir: 0, hold: 0 };
      const dir = w > free ? 1 : -1;
      let lo = 0;
      let hi = T;
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        const v = elevAfter(e, dir, mid, T - mid);
        if ((dir > 0 && v < w) || (dir < 0 && v > w)) lo = mid; else hi = mid;
      }
      return { dir, hold: (lo + hi) / 2 };
    }
    /** The speed-brake switch as this pilot last set it (X toggles it; it starts retracted). */
    let speedBrakeOn = false;
    /**
     * One control window (ms): proportional key pulses toward the targets.
     * t: { pitch?, roll?, yaw? (heading, ground), thr? (%), brake?, fine? (flare gains) }.
     */
    async function controlWindow(t, ms) {
      const s = sim();
      updateRates(s);
      // A conventional jet's elevator gets stronger with dynamic pressure: scale the hands with (V_ref / IAS)².
      const ps = P.pitchSpeedScale ? clamp(Math.pow((P.approachKt * 1.1) / Math.max(80, fin(s.airspeed, 150)), 2), 0.35, 1.3) : 1;
      // (t.kp / t.kd: this manoeuvre's own hands, e.g. the gun run's dive)
      const kp = t.kp ?? (t.fine ? P.flareKp : P.pitchKp) * (t.fine && s.altitudeAGL < 100 ? 1 : ps);
      const kd = t.kd ?? (t.fine ? P.flareKd : P.pitchKd) * (t.fine && s.altitudeAGL < 100 ? 1 : ps);
      // Jets: ask for at most ±5° of attitude change at a time (no violent bunts or yanks).
      if (P.jet && t.pitch !== null && t.pitch !== undefined && !t.fine && t.kp === undefined) t = { ...t, pitch: clamp(t.pitch, s.pitch - 5, s.pitch + 5) };
      const up = t.g !== undefined && t.g !== null
        ? (P.gKp ?? 0.06) * (t.g - fin(s.gLoad, 1)) - (P.gKd ?? 0.02) * rates.g
        : t.pitch === null || t.pitch === undefined ? 0 : kp * (t.pitch - s.pitch) - kd * rates.q;
      // Jets' fly-by-wire roll is a rate command that gets livelier with speed: scale the hands with 1/IAS.
      const rs = t.rollScale ?? (P.rollSpeedScale ? clamp(250 / Math.max(80, fin(s.airspeed, 250)), 0.3, 1.5) : 1);
      const ur = t.roll === null || t.roll === undefined ? 0 : rs * (P.rollKp * (t.roll - s.roll) - P.rollKd * rates.p);
      const uy = t.yaw === null || t.yaw === undefined ? 0 : P.yawKp * wrap180(t.yaw - s.heading) - P.yawKd * rates.r;
      // Trim like a pilot, in steady flight only (≈ 1 g, the nose not moving; never in a dive, a pull
      // or a flare): stick held one way — or a pitch error that persists — gets a blip of trim that way.
      let trimKey = null;
      const steady = Math.abs(fin(s.gLoad, 1) - 1) < 0.3 && Math.abs(rates.q) < 3 && Math.abs(fin(s.roll)) < 35;
      if (P.autoTrim && !s.onGround && t.pitch !== null && t.pitch !== undefined && !t.fine && t.trim !== false && steady) {
        trimI = clamp(trimI + (0.6 * up + 0.05 * (t.pitch - s.pitch)) * (ms / 1000), -2, 2);
        if (Math.abs(trimI) > 0.35) { trimKey = trimI > 0 ? 'BracketRight' : 'BracketLeft'; trimI *= 0.4; }
      } else if (!steady) trimI *= 0.9;
      // t.elev: put the elevator there (fine hands — the keyboard's return spring accounted for).
      let upDir = up > 0 ? 1 : up < 0 ? -1 : 0;
      let tp = Math.min(ms, Math.abs(up) * ms);
      if (t.elev !== undefined && t.elev !== null && Number.isFinite(t.elev)) {
        const pl = elevPulse(elevEst, t.elev, ms / 1000);
        upDir = pl.dir;
        tp = pl.hold * 1000;
      }
      const tr = Math.min(ms, Math.abs(ur) * ms);
      const ty = Math.min(ms, Math.abs(uy) * ms);
      const dthr = t.thr === null || t.thr === undefined ? 0 : clamp(t.thr, 0, 100) - s.throttle;
      const tt = Math.abs(dthr) < 1.5 ? 0 : Math.min(ms, (Math.abs(dthr) / throttleRatePct) * 1000);
      const minPulse = 12;
      const pitchHeld = tp > (t.elev !== undefined ? 2 : minPulse) && upDir !== 0;
      if (pitchHeld) key(upDir > 0 ? 'ArrowDown' : 'ArrowUp', true);
      if (tr > minPulse) key(ur > 0 ? 'ArrowRight' : 'ArrowLeft', true);
      if (ty > minPulse) key(uy > 0 ? 'KeyD' : 'KeyA', true);
      if (tt > 0) key(dthr > 0 ? 'KeyW' : 'KeyS', true);
      const tTrim = trimKey ? 60 : 0;
      if (trimKey) key(trimKey, true);
      if (t.brake) key('Space', true);
      else if (t.brake === false) key('Space', false);
      if (t.speedBrake !== undefined && t.speedBrake !== null && !!t.speedBrake !== speedBrakeOn) { speedBrakeOn = !!t.speedBrake; drv.key('KeyX', true); drv.key('KeyX', false); }
      if (t.trigger) key('KeyQ', true);
      else if (t.trigger === false) key('KeyQ', false);
      const t0 = drv.now();
      let pitchHeldMs = pitchHeld ? -1 : 0;
      for (;;) {
        const el = drv.now() - t0;
        if (el >= tp) {
          if (pitchHeldMs < 0) pitchHeldMs = el;
          key('ArrowDown', false); key('ArrowUp', false);
        }
        if (el >= tr) { key('ArrowRight', false); key('ArrowLeft', false); }
        if (el >= ty) { key('KeyD', false); key('KeyA', false); }
        if (el >= tt) { key('KeyW', false); key('KeyS', false); }
        if (el >= tTrim) { key('BracketRight', false); key('BracketLeft', false); }
        if (el >= ms) break;
        await sleep(16);
      }
      const winMs = Math.max(ms, drv.now() - t0);
      if (pitchHeldMs < 0) pitchHeldMs = winMs;
      elevEst = elevAfter(elevEst, pitchHeld ? upDir : 0, pitchHeldMs / 1000, (winMs - pitchHeldMs) / 1000);
      key('ArrowDown', false); key('ArrowUp', false); key('ArrowRight', false); key('ArrowLeft', false);
      key('KeyD', false); key('KeyA', false); key('KeyW', false); key('KeyS', false);
    }
    /** Fly until `done(sim)` or timeout (ms of the driver clock), steering to `targets(sim)`. */
    async function fly(targets, done, timeoutMs, ms = 200) {
      const end = drv.now() + timeoutMs;
      resetRates();
      while (drv.now() < end) {
        const s = sim();
        if (s.state === 'crashed') { releaseAll(); return 'crashed'; }
        if (done && done(s)) return 'done';
        await controlWindow(targets(s), typeof ms === 'function' ? ms(s) : ms);
      }
      return 'timeout';
    }
    /** Throttle to a target percent with W/S (hands off the stick meanwhile). */
    async function throttle(pct) {
      for (let i = 0; i < 80; i++) {
        const d = pct - sim().throttle;
        if (Math.abs(d) <= 1.5) break;
        key(d > 0 ? 'KeyW' : 'KeyS', true);
        await sleep(clamp((Math.abs(d) / throttleRatePct) * 1000, 16, 400));
        key('KeyW', false); key('KeyS', false);
        await sleep(20);
      }
    }
    /** Speed hold: throttle % for an airspeed target (PI with a trim guess), limited to [lo, hi]. */
    function speedHold(kt, trim, lo = 0, hi = P.maxThrottle) {
      const h = { kt, i: trim, lastT: null };
      h.throttle = (s) => {
        const now = drv.now();
        const dt = h.lastT === null ? 0.2 : clamp((now - h.lastT) / 1000, 0.01, 1);
        h.lastT = now;
        const err = h.kt - s.airspeed;
        h.i = clamp(h.i + P.speedKi * err * dt, lo, hi);
        return clamp(h.i + P.speedKp * err, lo, hi);
      };
      return h;
    }
    const rollFor = (s, trackDeg, maxBank) => clamp(wrap180(trackDeg - track(s)) * 1.5, -maxBank, maxBank);
    const altHoldVs = (s, altFt, maxVs = 2000) => clamp((altFt - s.altitude) * 4, -maxVs, maxVs);
    /** Flaps to a notch with F / V. */
    async function flapsTo(notch) {
      for (let i = 0; i < 6; i++) {
        const n = fin(sim().flapsNotch, 0);
        if (n === notch) return;
        await tap(n < notch ? 'KeyF' : 'KeyV');
      }
    }
    async function gearTo(down) {
      const s = sim();
      if ((s.gearHandle === 'down') !== down) await tap('KeyG');
    }

    const api = {
      phase: 'idle',
      log,
      stats,
      note,
      releaseAll,
      key,
      tap,
      fly,
      throttle,
      get profile() { return P; },
      set profile(v) { P = v; },
      get runway() { return RW; },
      set runway(v) { RW = v; },
      lib: G.qaPilotLib,

      /**
       * Read the aircraft (window.sim.aircraft) and build its profile from its config (Vite dev
       * server: /src/fleet); falls back to the built-in numbers.
       */
      async init(o = {}) {
        const id = sim().aircraft || 'c172rg';
        let ac;
        let weapons;
        let airport;
        if (o.config) {
          ac = o.config.aircraft; weapons = o.config.weapons; airport = o.config.world && o.config.world.airport;
        } else if (typeof window !== 'undefined' && !o.noImport) {
          try {
            const fleet = await import(/* @vite-ignore */ `${location.origin}/src/fleet/index.ts`);
            const def = fleet.getAircraftDef(id);
            ac = def.config.aircraft; weapons = def.config.weapons; airport = def.config.world.airport;
          } catch {
            /* built-in numbers */
          }
        }
        P = profileFor(id, ac, weapons);
        RW = runwayInfo(airport);
        return P;
      },

      /** Take-off from the runway: full power (afterburner for the F-16), rotate at Vr, gear + flaps up, climb out. */
      async takeoff(o = {}) {
        let s = sim();
        const start = { x: s.position.x, z: s.position.z };
        api.phase = 'takeoff roll';
        note('brake release');
        stats.takeoffAt = s.time;
        const courseDeg = RW.courseDeg;
        const toThr = o.throttle ?? P.takeoffThrottle;
        // Take-off flaps (the 747: flaps 20) before the roll.
        if (P.takeoffFlapsNotch !== undefined && fin(s.flapsNotch, 0) !== P.takeoffFlapsNotch) {
          await flapsTo(Math.min(P.takeoffFlapsNotch, P.maxFlapsNotch ?? P.takeoffFlapsNotch));
          s = sim();
        }
        // Line up: the runway heading, steering back to the centreline with the rudder/nosewheel.
        const steer = (x) => {
          const c = lineCoords(x.position.x, x.position.z, RW.thrX, RW.thrZ, courseDeg);
          return wrap360(courseDeg - clamp(c.cross * 1.2, -8, 8));
        };
        // (a heavy keeps the nose on the runway until Vr — never let it fly itself off)
        let r = await fly((x) => ({ pitch: P.gentle ? 0 : null, roll: 0, yaw: steer(x), thr: toThr, trim: false }), (x) => x.airspeed >= P.vrKt, 90000, 100);
        note('Vr');
        api.phase = 'rotate';
        let liftoff = null;
        // Rotate at ~2–3°/s to the take-off attitude (a heavy jet: never a yank toward the tail strike).
        const rot0 = drv.now();
        const rotRate = P.gentle ? 2 : 100;
        r = await fly(
          (x) => {
            if (!liftoff && !x.onGround && x.altitudeAGL > P.gearOffsetFt + 3) liftoff = { x: x.position.x, z: x.position.z, t: x.time };
            const ramp = Math.min(P.rotatePitchDeg, ((drv.now() - rot0) / 1000) * rotRate);
            return { pitch: ramp, roll: 0, yaw: x.onGround ? steer(x) : null, thr: toThr };
          },
          (x) => !x.onGround && x.verticalSpeed > 300 && x.altitudeAGL > P.gearOffsetFt + 35,
          60000,
          100,
        );
        if (liftoff) {
          stats.liftoffAt = liftoff.t;
          stats.takeoffDistM = Math.hypot(liftoff.x - start.x, liftoff.z - start.z);
        }
        note('positive climb', { takeoffDistM: stats.takeoffDistM && Math.round(stats.takeoffDistM) });
        await gearTo(false);
        api.phase = 'climb out';
        const climbThr = o.climbThrottle ?? (P.id === 'f16' ? toThr : P.climbThrottle);
        const flapsUpKt = P.id === 'c172rg' ? 65 : P.id === 'b747' ? P.vrKt + 45 : P.vrKt + 30;
        let flapsUp = false;
        r = await fly(
          (x) => {
            if (!flapsUp && x.airspeed > flapsUpKt && fin(x.flapsNotch) > 0) { flapsUp = true; flapsTo(0); }
            // Initial climb at V2-ish (Vr + 25) until 500 ft, then the aircraft's climb speed; never below the rotation attitude − 2° down low.
            const low = x.altitudeAGL < P.gearOffsetFt + 500;
            const vT = low ? Math.min(P.climbKt, P.vrKt + 25) : P.climbKt;
            const pitch = clamp(x.pitch + (x.airspeed - vT) * 0.15, low ? P.rotatePitchDeg - 2 : 4, P.climbPitchMaxDeg);
            return { pitch, roll: rollFor(x, courseDeg, 10), thr: climbThr };
          },
          (x) => x.altitudeAGL > (o.untilAglFt ?? 500),
          90000,
        );
        if (fin(sim().flapsNotch) > 0) await flapsTo(0);
        note('climbing');
        s = sim();
        return r;
      },

      /** Climb (or descend) to aglFt, then level off at cruise power. */
      async climbTo(aglFt, o = {}) {
        api.phase = `climb to ${aglFt}`;
        const fieldAlt = sim().altitude - sim().altitudeAGL;
        const targetAlt = fieldAlt + aglFt;
        const hdg = o.headingDeg ?? sim().heading;
        const climbing = targetAlt > sim().altitude;
        const thr = o.throttle ?? (climbing ? P.climbThrottle : P.cruiseThrottle);
        const r = await fly(
          (s) => {
            const near = Math.abs(targetAlt - s.altitude) < 300;
            const pitch = climbing && !near ? clamp(s.pitch + (s.airspeed - P.climbKt) * 0.15, 3, P.climbPitchMaxDeg) : pitchForVs(s, altHoldVs(s, targetAlt, 3000));
            return { pitch, roll: rollFor(s, hdg, P.patternBankDeg), thr };
          },
          (s) => Math.abs(s.altitude - targetAlt) < 60 && Math.abs(s.verticalSpeed) < 500,
          o.timeoutMs ?? 240000,
        );
        api.phase = 'level';
        await fly((s) => ({ pitch: pitchForVs(s, altHoldVs(s, targetAlt)), roll: rollFor(s, hdg, 10), thr: o.cruiseThrottle ?? P.cruiseThrottle }), null, 3000);
        note(`level at ${aglFt}`);
        return r;
      },
      async level(ms) {
        api.phase = 'level';
        const alt = sim().altitude;
        const hdg = sim().heading;
        return fly((s) => ({ pitch: pitchForVs(s, altHoldVs(s, alt)), roll: rollFor(s, hdg, 10) }), null, ms);
      },
      /** Heading change deltaDeg (− = left) at `bank`, holding altitude. */
      async turn(deltaDeg, bank = 30) {
        const s0 = sim();
        const target = wrap360(s0.heading + deltaDeg);
        const alt = s0.altitude + clamp(s0.verticalSpeed, -3000, 3000) / 6;
        const sign = Math.sign(deltaDeg);
        api.phase = `turn ${deltaDeg > 0 ? 'right' : 'left'} ${Math.abs(deltaDeg)}°`;
        note(api.phase + ' start');
        let turned = 0;
        let prevH = s0.heading;
        const r = await fly(
          (s) => {
            turned += wrap180(s.heading - prevH) * sign;
            prevH = s.heading;
            const rem = Math.abs(deltaDeg) - turned;
            const b = rem < 15 ? sign * Math.max(0, rem) * (bank / 15) : sign * bank;
            return { pitch: pitchForVs(s, altHoldVs(s, alt)), roll: b };
          },
          () => Math.abs(deltaDeg) - turned < 2,
          180000,
        );
        await fly((s) => ({ pitch: pitchForVs(s, altHoldVs(s, alt)), roll: 0 }), (s) => Math.abs(s.roll) < 3, 8000);
        note(api.phase + ' done', { targetHdg: target });
        return r;
      },
      /** A level turn at `g` load factor through `deltaDeg` (sign = direction). Returns the peak g seen. */
      async gTurn(g, deltaDeg) {
        const s0 = sim();
        const alt = s0.altitude;
        const sign = Math.sign(deltaDeg) || 1;
        const bank = Math.acos(clamp(1 / g, -1, 1)) * R2D;
        api.phase = `${g} g turn`;
        note(api.phase + ' start');
        let turned = 0;
        let prevH = s0.heading;
        let peakG = 0;
        let sustained = 0;
        const hold = speedHold(s0.airspeed, P.id === 'f16' ? 100 : P.maxThrottle, 0, 100);
        const r = await fly(
          (s) => {
            turned += wrap180(s.heading - prevH) * sign;
            prevH = s.heading;
            peakG = Math.max(peakG, fin(s.gLoad));
            if (s.gLoad >= g - 0.3) sustained += 0.2;
            const rollNow = Math.abs(s.roll);
            // Pull for the load factor once banked; keep the nose from dropping (level turn).
            // Bank first, then pull for the load factor (stick ∝ g error); bank adjusts to hold altitude.
            const vs = s.verticalSpeed;
            const bankT = sign * clamp(bank + clamp(vs / 150, -12, 8), 30, 85);
            if (rollNow < bank - 20) return { pitch: pitchForVs(s, 0), roll: bankT, thr: hold.throttle(s), rollScale: 1 };
            return { g, roll: bankT, thr: hold.throttle(s), rollScale: 1 };
          },
          () => turned >= Math.abs(deltaDeg) - 20,
          120000,
          100,
        );
        await fly((s) => ({ pitch: pitchForVs(s, altHoldVs(s, alt)), roll: 0 }), (s) => Math.abs(s.roll) < 4, 10000);
        note(api.phase + ' done', { peakG, sustainedS: sustained });
        return { result: r, peakG, sustainedS: sustained, altLossFt: alt - sim().altitude };
      },
      /** Afterburner dash in level flight until Mach `mach` (or timeout). Returns the peak Mach. */
      async dash(o = {}) {
        const target = o.mach ?? 1.1;
        const s0 = sim();
        const alt = o.altFt ?? s0.altitude;
        const hdg = o.headingDeg ?? s0.heading;
        api.phase = `dash to M${target}`;
        note('dash start', { mach: machFrom(s0.airspeed, s0.altitude) });
        let peak = 0;
        const r = await fly(
          (s) => {
            peak = Math.max(peak, machFrom(s.airspeed, s.altitude));
            return { pitch: pitchForVs(s, altHoldVs(s, alt, 3000)), roll: rollFor(s, hdg, 20), thr: 100 };
          },
          (s) => machFrom(s.airspeed, s.altitude) >= target,
          o.timeoutMs ?? 120000,
        );
        const s1 = sim();
        note('dash end', { mach: machFrom(s1.airspeed, s1.altitude) });
        return { result: r, peakMach: Math.max(peak, machFrom(s1.airspeed, s1.altitude)), altFt: s1.altitude };
      },
      async stallAndRecover() {
        api.phase = 'stall entry';
        note('stall entry');
        await throttle(0);
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
            const err = wrap180(bearingTo(s.position.x, s.position.z, x, z) - s.heading);
            return { pitch: -8, roll: clamp(err * 1.2, -30, 30) };
          },
          (s) => s.state === 'crashed',
          240000,
        );
        note('impact');
        return r;
      },

      /**
       * Fly direct to (x, z) at an altitude (o.altFt MSL or o.aglFt above the field) and speed; done
       * within o.arriveM. o.until(sim) ends it early.
       */
      async gotoPoint(x, z, o = {}) {
        const fieldAlt = RW.fieldFt;
        const alt = o.altFt ?? fieldAlt + (o.aglFt ?? 2000);
        const hold = speedHold(o.speedKt ?? P.cruiseKt, o.throttle ?? P.cruiseThrottle, P.throttleIdle, o.maxThrottle ?? P.maxThrottle);
        const bank = o.bank ?? P.patternBankDeg;
        api.phase = o.phase ?? `direct ${Math.round(x)},${Math.round(z)}`;
        let dMin = Infinity;
        let dStart = null;
        const r = await fly(
          (s) => {
            const brg = bearingTo(s.position.x, s.position.z, x, z);
            const floorAgl = P.jet ? Math.max(800, s.airspeed * 3) : 400;
            const floor = s.altitudeAGL < floorAgl ? 2000 : null;
            const vs = floor ?? altHoldVs(s, alt, o.maxVs ?? 2500);
            return { pitch: clamp(pitchForVs(s, vs), -15, P.climbPitchMaxDeg), roll: rollFor(s, brg, bank), thr: hold.throttle(s), speedBrake: P.jet ? s.airspeed > hold.kt + 40 : undefined };
          },
          (s) => {
            const d = Math.hypot(s.position.x - x, s.position.z - z);
            if (d < (o.arriveM ?? 600) || (o.until ? o.until(s) : false)) return true;
            // Went past it (closest approach within a turn radius, now opening): don't orbit the waypoint.
            const V = Math.max(40, s.groundSpeed) * KT_MS;
            const R = (V * V) / (9.81 * Math.tan(bank * D2R));
            if (dStart === null) dStart = d;
            dMin = Math.min(dMin, d);
            return dMin < dStart - 300 && dMin < Math.max(R, (o.arriveM ?? 600) * 2) && d > dMin + 300;
          },
          o.timeoutMs ?? 400000,
        );
        note(api.phase + ' reached');
        return r;
      },
      /**
       * Fly along a course line through (ax, az) until `until(sim, lineCoords)`, holding altitude and
       * speed (o.altFt / o.speedKt / o.vs(sim) for a custom vertical path).
       */
      async trackLine(ax, az, courseDeg, until, o = {}) {
        const alt = o.altFt ?? sim().altitude;
        const hold = speedHold(o.speedKt ?? P.cruiseKt, o.throttle ?? P.cruiseThrottle, P.throttleIdle, P.maxThrottle);
        const k = o.kDegPerM ?? 0.03;
        const maxInt = o.maxInterceptDeg ?? 90;
        const bank = o.bank ?? P.patternBankDeg;
        api.phase = o.phase ?? `track ${Math.round(courseDeg)}°`;
        const r = await fly(
          (s) => {
            const trk = lineHeading(s.position.x, s.position.z, ax, az, courseDeg, k, maxInt);
            const low = !o.vs && s.altitudeAGL < Math.min(1000, P.patternAglFt * 0.7);
            const vs = low ? 1500 : o.vs ? o.vs(s) : altHoldVs(s, alt);
            return { pitch: clamp(pitchForVs(s, vs), -12, P.climbPitchMaxDeg), roll: rollFor(s, trk, bank), thr: o.thr ? o.thr(s) : hold.throttle(s), speedBrake: P.jet ? s.airspeed > (o.speedKt ?? hold.kt) + 40 : undefined };
          },
          (s) => until(s, lineCoords(s.position.x, s.position.z, ax, az, courseDeg)),
          o.timeoutMs ?? 400000,
        );
        note(api.phase + ' end');
        return r;
      },

      /**
       * Stabilised approach and landing on runway 36 from on/near the final (Shift+R, or the end of a
       * pattern): final flaps + gear, approach speed on the throttle, the 3° glide path on the stick,
       * the extended centreline by ground track; flare at the height the sink rate calls for, idle,
       * touch down on the mains, brake to a stop on the centreline.
       */
      async approachAndLand(o = {}) {
        api.phase = 'final approach';
        note('approach start');
        await gearTo(true);
        await flapsTo(P.finalFlapsNotch);
        const hold = speedHold(o.approachKt ?? P.approachKt, sim().throttle || P.approachThrottle, P.throttleIdle, P.maxThrottle);
        // Jets with an on-speed AoA fly the final on AoA: the throttle holds it (the speed falls out), the stick the path.
        const aoaT = o.approachAoaDeg ?? P.approachAoaDeg;
        if (aoaT) hold.kt = 0;
        const approachThrottle = (s) => {
          if (!aoaT) return hold.throttle(s);
          const err = s.aoa - aoaT; // + = slow → more power
          const now = drv.now();
          const dt = hold.lastT === null ? 0.2 : clamp((now - hold.lastT) / 1000, 0.01, 1);
          hold.lastT = now;
          const floorKt = (P.approachKt ?? 0) - 10;
          const e2 = err + (s.airspeed < floorKt ? (floorKt - s.airspeed) * 0.3 : 0);
          hold.i = clamp(hold.i + P.speedKi * 2 * e2 * dt, P.throttleIdle, P.maxThrottle);
          return clamp(hold.i + P.speedKp * 2 * e2, P.throttleIdle, P.maxThrottle);
        };
        let entrySink = null;
        let r = await fly(
          (s) => {
            const gp = glidePathTargets(s, P, RW);
            // A heavy: the approach speed out on final, bleeding to Vref + 5 below ~800 ft.
            if (P.vrefKt && !aoaT) hold.kt = (o.approachKt ?? P.approachKt) + ((P.vrefKt + 5) - (o.approachKt ?? P.approachKt)) * clamp((1500 - gp.heightFt) / 700, 0, 1);
            return { pitch: clamp(pitchForVs(s, gp.vsFpm), -8, P.maxFlarePitchDeg - 1), roll: rollFor(s, gp.trackDeg, P.gentle ? 12 : 20), thr: approachThrottle(s) };
          },
          (s) => {
            if (wheelFt(s) <= flareHeightFt(-s.verticalSpeed, P)) { entrySink = Math.max(0, -s.verticalSpeed); return true; }
            return s.onGround;
          },
          o.timeoutMs ?? 300000,
        );
        note('flare', { wheelFt: Math.round(wheelFt(sim())), entrySink });
        api.phase = 'flare';
        const sink0 = entrySink ?? 300;
        r = await fly(
          (s) => {
            const gp = glidePathTargets(s, P, RW);
            const pitch = flarePitch(wheelFt(s), s.verticalSpeed, s.aoa, s.groundSpeed, s.pitch, sink0, P);
            return { pitch, roll: clamp(rollFor(s, gp.trackDeg, 5), -5, 5), thr: P.throttleIdle, fine: true };
          },
          (s) => s.onGround || s.state === 'landed',
          40000,
          100,
        );
        const td = sim().lastLanding;
        stats.landing = td ? { ...td } : null;
        note('touchdown', td ? { rating: td.rating, fpm: td.fpm, tdKt: td.airspeedKt } : {});
        api.phase = 'rollout';
        await api.rollout();
        const end = sim().lastLanding;
        stats.landing = end ? { ...end, ...(stats.landing || {}) } : stats.landing;
        api.phase = 'done';
        return r;
      },
      /** Rollout: idle, wings level, brakes, rudder on the centreline, to a stop. */
      async rollout() {
        const steer = (x) => {
          const c = lineCoords(x.position.x, x.position.z, RW.thrX, RW.thrZ, RW.courseDeg);
          return wrap360(RW.courseDeg - clamp(c.cross * 1.0, -6, 6));
        };
        const t0 = drv.now();
        // Mains down: lower the nose (jets: aerobrake a moment first), idle, speed brake, then the wheel brakes.
        const r = await fly((s) => {
          const tS = (drv.now() - t0) / 1000;
          const aero = P.jet && tS < 2 && s.airspeed > P.vrKt * 0.8;
          return { pitch: aero ? Math.min(s.pitch, P.maxFlarePitchDeg - 2) : P.id === 'c172rg' && s.airspeed > 35 ? Math.min(s.pitch, 3) : null, roll: 0, yaw: steer(s), thr: 0, brake: P.jet ? tS > 1.5 : s.airspeed < 45, speedBrake: P.jet ? true : undefined };
        }, (s) => s.groundSpeed < 2, 90000, 100);
        key('Space', false);
        if (P.jet) await controlWindow({ speedBrake: false }, 50);
        note('stopped');
        return r;
      },
      /**
       * Return to the field and land from anywhere: join a downwind (the side nearer the aircraft)
       * at pattern altitude, turn base and final (one continuous 180° turn), then approachAndLand().
       */
      async rtbAndLand(o = {}) {
        const s = sim();
        const V = P.patternKt * KT_MS;
        const R = (V * V) / (9.81 * Math.tan(P.patternBankDeg * D2R));
        const c = lineCoords(s.position.x, s.position.z, RW.thrX, RW.thrZ, RW.courseDeg);
        const side = o.side ?? (c.cross >= 0 ? 1 : -1);
        const offset = side * Math.max(2 * R, 900);
        const altFt = RW.fieldFt + P.patternAglFt;
        const recip = wrap360(RW.courseDeg + 180);
        const crs = RW.courseDeg * D2R;
        const rightX = Math.cos(crs);
        const rightZ = Math.sin(crs);
        const dirX = Math.sin(crs);
        const dirZ = -Math.cos(crs);
        // Downwind line: parallel to the runway, `offset` to the side, flown on the reciprocal.
        const dwX = RW.thrX + rightX * offset;
        const dwZ = RW.thrZ + rightZ * offset;
        // Join the downwind abeam the far end of the runway (or further upwind if coming from there).
        const joinAlong = Math.max(RW.lengthM + 1500, c.along > RW.lengthM ? c.along * 0.6 : RW.lengthM + 1500);
        const jx = dwX + dirX * joinAlong;
        const jz = dwZ + dirZ * joinAlong;
        api.phase = 'rtb: pattern entry';
        note('rtb', { side, R: Math.round(R) });
        // Too high to join the pattern: a descending orbit (idle, speed brake) down to pattern altitude.
        if (s.altitude > altFt + 2500) {
          await api.descendTo(altFt + 300, { side });
          if (sim().state === 'crashed') return 'crashed';
        }
        const baseAt = P.finalLengthM; // start the 180° turn this far beyond the threshold
        const r0 = lineCoords(s.position.x, s.position.z, dwX, dwZ, recip);
        if (r0.along > baseAt - R) {
          // Already out on the approach side: go straight to a long final (centreline, well out) and turn in.
          const out = P.finalLengthM + 3 * R;
          await api.gotoPoint(RW.thrX - dirX * out, RW.thrZ - dirZ * out, { altFt, speedKt: P.patternKt, arriveM: 1000, phase: 'rtb: to long final', maxVs: P.jet ? 4000 : 1000 });
          if (sim().state === 'crashed') return 'crashed';
        } else {
          if (r0.along < -600 || Math.abs(r0.cross) > 1500) {
            await api.gotoPoint(jx, jz, { altFt, speedKt: P.patternKt, arriveM: 1200, phase: 'rtb: to downwind', maxVs: P.jet ? 4000 : 1000 });
          }
          if (sim().state === 'crashed') return 'crashed';
          // Downwind: slow to pattern speed, pattern flaps, gear down abeam the threshold.
          let configured = false;
          const res = await api.trackLine(dwX, dwZ, recip, (x, lc) => {
            if (!configured && lc.along > -1500) {
              configured = true;
              gearTo(true).then(() => flapsTo(P.patternFlapsNotch));
            }
            return lc.along >= baseAt - R * 0.2;
          }, { altFt, speedKt: P.patternKt, phase: 'downwind', kDegPerM: 0.05, maxInterceptDeg: 60 });
          if (res === 'crashed') return res;
        }
        await gearTo(true);
        await flapsTo(Math.max(P.patternFlapsNotch, Math.min(P.finalFlapsNotch, 1)));
        // Base + final turn: track the final course; the line guidance turns through base onto final.
        const finalHold = speedHold(P.approachKt + 10, sim().throttle, P.throttleIdle, P.maxThrottle);
        const res2 = await api.trackLine(RW.thrX, RW.thrZ, RW.courseDeg, (x, lc) => (Math.abs(lc.cross) < 60 && Math.abs(wrap180(track(x) - RW.courseDeg)) < 8) || lc.along > -P.finalLengthM * 0.5, {
          phase: 'base / turn to final', kDegPerM: 90 / (0.6 * Math.abs(offset)), maxInterceptDeg: 90, bank: P.patternBankDeg + 5,
          vs: (x) => { const gp = glidePathTargets(x, P, RW); return gp.aboveFt > 0 ? Math.max(gp.vsFpm, -1200) : altHoldVs(x, altFt); },
          thr: (x) => finalHold.throttle(x),
        });
        if (res2 === 'crashed') return res2;
        return api.approachAndLand(o);
      },
      /** Descend in a steady orbit (o.side: +1 right, −1 left) at idle to altFt MSL; jets use the speed brake. */
      async descendTo(altFt, o = {}) {
        api.phase = `descend to ${Math.round(altFt)} ft`;
        const sign = o.side ?? 1;
        const maxVs = P.id === 'f16' ? 6000 : P.jet ? 3500 : 900;
        const floorAgl = P.patternAglFt + 400;
        const kt = P.jet ? P.patternKt + 60 : P.patternKt + 10;
        const hold = speedHold(kt, 0, P.throttleIdle, P.maxThrottle);
        const r = await fly(
          (s) => ({ pitch: clamp(pitchForVs(s, -maxVs), Math.max(-25, s.pitch - 4), Math.min(10, s.pitch + 4)), roll: sign * P.patternBankDeg, thr: hold.throttle(s), speedBrake: P.jet ? s.airspeed > kt - 20 : undefined }),
          (s) => s.altitude <= altFt || s.altitudeAGL <= floorAgl,
          o.timeoutMs ?? 300000,
        );
        await fly((s) => ({ pitch: pitchForVs(s, 0), roll: 0, thr: hold.throttle(s), speedBrake: false }), (s) => Math.abs(s.roll) < 5 && Math.abs(s.verticalSpeed) < 800, 15000);
        note(api.phase + ' done');
        return r;
      },
      /** Cessna circuit from the runway: take-off, crosswind, downwind, base, final, landing to a full stop. */
      async circuit(o = {}) {
        const side = o.side ?? -1; // left-hand traffic for runway 36 (downwind to the west)
        await api.takeoff({ untilAglFt: 400 });
        if (sim().state === 'crashed') return 'crashed';
        const altFt = RW.fieldFt + (o.patternAglFt ?? P.patternAglFt);
        const upwind = RW.lengthM + (o.upwindM ?? 800);
        // Upwind to the crosswind turn.
        await api.trackLine(RW.thrX, RW.thrZ, RW.courseDeg, (x, lc) => lc.along > upwind, { altFt, speedKt: P.climbKt, throttle: P.climbThrottle, phase: 'upwind', kDegPerM: 0.1, maxInterceptDeg: 20 });
        return api.rtbAndLand({ side, ...o });
      },

      // ─── Combat (needs window.sim.combat; degrades gracefully without it) ──────
      combat() {
        const c = sim().combat;
        return c && typeof c === 'object' ? c : null;
      },
      /** Live targets (from combat.list()), nearest first. */
      targets() {
        const c = api.combat();
        if (!c || typeof c.list !== 'function') return [];
        const s = sim();
        return c.list().filter((t) => t.alive).map((t) => ({ ...t, dist: Math.hypot(t.x - s.position.x, t.z - s.position.z) })).sort((a, b) => a.dist - b.dist);
      },
      /** The best live target of `kind` (any kind if absent): ahead of the nose first, then nearest; `exclude` ids skipped. */
      pickTarget(kind, o = {}) {
        const s = sim();
        const ex = new Set(o.exclude || []);
        let list = api.targets().filter((t) => !ex.has(t.id));
        if (kind) {
          const k = list.filter((t) => t.kind === kind);
          if (k.length) list = k;
        }
        if (!list.length) return null;
        const score = (t) => {
          const off = Math.abs(wrap180(bearingTo(s.position.x, s.position.z, t.x, t.z) - s.heading));
          return t.dist * (1 + off / 45) + (o.minDistM && t.dist < o.minDistM ? 1e6 : 0);
        };
        return list.slice().sort((a, b) => score(a) - score(b))[0];
      },
      /** Fly to the target range at o.aglFt (default 3,000 ft), arriving o.standoffM (default 5 km) short of it. */
      async flyToRange(o = {}) {
        const c = api.combat();
        const range = (c && c.range) || { x: 0, z: -7000, headingDeg: 0 };
        const s = sim();
        const brg = bearingTo(s.position.x, s.position.z, range.x, range.z);
        const stand = o.standoffM ?? 5000;
        const d = Math.hypot(range.x - s.position.x, range.z - s.position.z);
        api.phase = 'to the range';
        const t0 = s.time;
        let r = 'done';
        if (d > stand + 500) {
          const px = range.x - Math.sin(brg * D2R) * stand;
          const pz = range.z + Math.cos(brg * D2R) * stand;
          r = await api.gotoPoint(px, pz, { aglFt: o.aglFt ?? 3000, speedKt: o.speedKt ?? P.cruiseKt, arriveM: 900, phase: 'to the range', maxVs: 4000 });
        }
        stats.timeToRangeS = sim().time - t0;
        note('at the range', { timeToRangeS: stats.timeToRangeS });
        return r;
      },

      /** Angles (deg) from the aircraft to a world point: azimuth rel. to the heading, elevation (+ up), slant range (m). */
      lineOfSight(s, px, py, pz) {
        const dx = px - s.position.x;
        const dy = py - s.position.y;
        const dz = pz - s.position.z;
        const h = Math.hypot(dx, dz);
        return { az: wrap180(bearingTo(s.position.x, s.position.z, px, pz) - s.heading), el: Math.atan2(dy, h) * R2D, range: Math.hypot(h, dy), ground: h };
      },

      /**
       * A strafing pass with the gun, flown like a low-angle strafe:
       *  1. set-up: an IP well behind the target on the attack axis (its rear arc, toward the low
       *     ground), at the roll-in height;
       *  2. a long straight run-in ON the axis line (cross-track steered out), level, at run-in speed;
       *  3. push-over: the flight path is walked down toward the target at ≤ o.pushRateDeg °/s (a
       *     gentle push, the load factor stays positive) until the velocity vector sits on it —
       *     a steady o.diveDeg dive with the pipper already close;
       *  4. tracking: a damped loop on the CCIP pipper error (proportional + rate, small steps), the
       *     rudder and a little bank for azimuth; open fire inside o.openFireFt slant when the pipper
       *     is on (or inside 80 % of it), a o.burstS burst, cease at the burst end / o.ceaseFt slant /
       *     the pull-out height;
       *  5. safe pull-off: wings level, full power, a o.pullG pull until climbing, then climb out.
       * Returns { result, fired, rounds, kills, pipperErrM (at open fire), minAglFt, minG, ... }.
       */
      async gunRun(targetId, o = {}) {
        // o.attacks > 1: pass after pass (each set up again from the climb-out) until it is destroyed.
        const attacks = Math.max(1, Math.round(o.attacks ?? 1));
        let total = null;
        for (let k = 0; k < attacks; k++) {
          const r = await api.gunPass(targetId, o);
          total = total ? { ...r, rounds: total.rounds + r.rounds, kills: total.kills + (r.kills || 0), passes: k + 1, minAglFt: Math.min(total.minAglFt, r.minAglFt), minG: Math.min(total.minG, r.minG), minGAttack: Math.min(total.minGAttack, r.minGAttack) } : { ...r, passes: 1 };
          const t = api.combat() ? api.combat().list().find((x) => x.id === targetId) : null;
          if (r.result !== 'done' || !t || !t.alive) break;
        }
        return total;
      },
      /** One strafing pass (see gunRun). */
      async gunPass(targetId, o = {}) {
        const diveDeg = o.diveDeg ?? 15;
        const runKt = o.speedKt ?? Math.min(P.cruiseKt, 280);
        const openFireM = (o.openFireFt ?? 4000) / M_FT;
        const ceaseM = (o.ceaseFt ?? 2000) / M_FT;
        const burstMs = (o.burstS ?? 3) * 1000;
        const pullOutFt = o.minPullOutFt ?? 400;
        const pushRate = o.pushRateDeg ?? 1.8;
        const find = () => (api.combat() ? api.combat().list().find((t) => t.id === targetId) : null);
        const t = find();
        if (!t) return { result: 'no target' };
        const s0 = sim();
        const gun = P.gun || { boresightDownDeg: 0, muzzleVelocity: 1000 };
        const V = runKt * KT_MS;
        // Attack axis: from behind the target (its rear arc), swung at most 60° toward our side,
        // then kept within o.ipSectorHalfDeg of the airfield side (the terrain rises beyond the range).
        const rearIp = wrap360(t.headingDeg + 180);
        const ourSide = bearingTo(t.x, t.z, s0.position.x, s0.position.z);
        let ipBrg = wrap360(rearIp + clamp(wrap180(ourSide - rearIp), -60, 60));
        const home = o.ipSectorCenterDeg ?? bearingTo(t.x, t.z, RW.thrX, RW.thrZ);
        ipBrg = wrap360(home + clamp(wrap180(ipBrg - home), -(o.ipSectorHalfDeg ?? 70), o.ipSectorHalfDeg ?? 70));
        const axis = o.attackHeadingDeg ?? wrap360(ipBrg + 180);
        // Geometry: open fire at openFireM slant on the dive line; the push-over (γ 0 → −dive at
        // pushRate) takes tPush seconds, loses hPush and covers dPush; tracking starts trackS earlier.
        const tan = Math.tan(diveDeg * D2R);
        // The push-over is an arc of radius V/ω: it covers R·sin(dive) and drops R·(1 − cos(dive)).
        const Rpush = V / (pushRate * D2R);
        const dPush = Rpush * Math.sin(diveDeg * D2R);
        const hPush = Rpush * (1 - Math.cos(diveDeg * D2R));
        const trackS = o.trackTimeS ?? 5;
        const fireH = openFireM * Math.sin(diveDeg * D2R);
        const trackH = fireH + trackS * V * Math.sin(diveDeg * D2R);
        const rollInAgl = clamp((trackH + hPush) * M_FT, 1500, 6000);
        const rollInH = rollInAgl / M_FT;
        // Push when the target is this far (horizontal): the arc ends on the dive line through the
        // target, (rollInH − hPush) / tan out, after covering dPush.
        const pushD = (rollInH - hPush) / tan + dPush;
        const straightM = o.straightM ?? Math.max(5000, V * 30);
        // Turn radius at 35° of bank (the racetrack's turns): the IP sits that much further out, so the
        // turn onto the axis ends before the straight run-in begins.
        const Rturn = (V * V) / (9.81 * Math.tan(35 * D2R));
        const ipD = pushD + straightM + 1.5 * Rturn;
        const tgtAltFt = t.y * M_FT;
        const res = { result: 'aborted', rounds: 0, fired: false, pipperErrM: null, pipperErrDeg: null, minAglFt: Infinity, minG: Infinity, minGAttack: Infinity, slantAtFireM: null, killsBefore: api.combat().stats.kills, axis: Math.round(axis) };
        const watch = (s) => {
          res.minAglFt = Math.min(res.minAglFt, s.altitudeAGL);
          if (!s.onGround && fin(s.gLoad, 1) < res.minG) { res.minG = fin(s.gLoad, 1); res.minGPhase = api.phase; }
          // the attack itself: push-over, tracking, pull-off
          if (/push over|tracking|pull off/.test(api.phase)) res.minGAttack = Math.min(res.minGAttack, fin(s.gLoad, 1));
        };
        note('gun run setup', { target: targetId, axis: Math.round(axis), rollInAgl: Math.round(rollInAgl), pushD: Math.round(pushD), ipD: Math.round(ipD) });
        const roundsBefore = api.combat().rounds;

        // 1 + 2. The IP (unless already on the axis far enough out and heading down it), then the
        // run-in ON the axis line: level at the roll-in height, run-in speed, cross-track steered out.
        // Not lined up (target > 4° off the nose) when it is time to push: go out and set up again.
        const runHold = speedHold(runKt, sim().throttle, 20, P.maxThrottle);
        const passes = o.passes ?? 3;
        let lined = false;
        for (let pass = 0; pass < passes && !lined; pass++) {
          const s1 = sim();
          const lc0 = lineCoords(s1.position.x, s1.position.z, t.x, t.z, axis);
          if (!(lc0.along < -(pushD + 1500) && Math.abs(lc0.cross) < 300 && Math.abs(wrap180(s1.heading - axis)) < 20)) {
            // A racetrack: outbound on a line parallel to the axis, two turn radii to our side, until
            // abeam the IP; then the 180° turn brings us back onto the axis, heading in.
            const side = lc0.cross >= 0 ? 1 : -1;
            // (the turn's diameter, like the landing pattern's downwind)
            const off = side * 2 * Rturn;
            const obX = t.x + Math.cos(axis * D2R) * off;
            const obZ = t.z + Math.sin(axis * D2R) * off;
            const recip = wrap360(axis + 180);
            const r0 = await api.trackLine(obX, obZ, recip, (x, lc) => {
              watch(x);
              return lineCoords(x.position.x, x.position.z, t.x, t.z, axis).along <= -ipD && Math.abs(wrap180(track(x) - recip)) < 30;
            }, { altFt: tgtAltFt + rollInAgl, speedKt: runKt, phase: 'gun run: outbound', kDegPerM: 0.03, maxInterceptDeg: 90, bank: 35, timeoutMs: 400000, vs: (x) => clamp(altHoldVs(x, tgtAltFt + rollInAgl), -1200, 1500) });
            if (r0 === 'crashed') return { ...res, result: 'crashed' };
            note('abeam the IP', { side });
          }
          // Inbound: the 180° turn onto the axis and the straight run-in (the landing pattern's
          // base-to-final guidance: it turns onto a line and holds it).
          const offNow = Math.abs(lineCoords(sim().position.x, sim().position.z, t.x, t.z, axis).cross);
          let r = await api.trackLine(t.x, t.z, axis, (x) => {
            watch(x);
            const T = find() || t;
            return Math.hypot(T.x - x.position.x, T.z - x.position.z) <= pushD + (o.alignM ?? 3000);
          }, { altFt: tgtAltFt + rollInAgl, speedKt: runKt, phase: 'gun run: run-in', kDegPerM: 90 / (0.6 * Math.max(600, offNow)), maxInterceptDeg: 90, bank: 35, timeoutMs: 400000 });
          if (r === 'crashed') return { ...res, result: 'crashed' };
          // The last stretch: nose on the target itself (wings nearly level), so the push starts lined up.
          api.phase = 'gun run: lined up';
          r = await fly((x) => {
            watch(x);
            const T = find() || t;
            const brg = bearingTo(x.position.x, x.position.z, T.x, T.z);
            return { pitch: clamp(pitchForVs(x, altHoldVs(x, tgtAltFt + rollInAgl, 2500)), -8, 12), roll: clamp(wrap180(brg - track(x)) * 3, -20, 20), yaw: wrap360(x.heading + clamp(wrap180(brg - x.heading), -3, 3)), thr: runHold.throttle(x) };
          }, (x) => {
            const T = find() || t;
            return Math.hypot(T.x - x.position.x, T.z - x.position.z) <= pushD;
          }, 120000, 150);
          if (r === 'crashed') return { ...res, result: 'crashed' };
          const s2 = sim();
          const los2 = api.lineOfSight(s2, t.x, t.y, t.z);
          lined = Math.abs(los2.az) < (o.maxOffDeg ?? 8) && Math.abs(s2.roll) < 15;
          if (!lined) note('not lined up: set up again', { azDeg: +los2.az.toFixed(1) });
        }
        if (!lined) return { ...res, result: 'not lined up' };
        note('push over', { distM: Math.round(Math.hypot(t.x - sim().position.x, t.z - sim().position.z)) });

        // 3 + 4. Push over onto the target, then track the pipper; fire; cease.
        api.phase = 'gun run: push over';
        let gCmd = pathDeg(sim().verticalSpeed, sim().groundSpeed);
        let lastT = drv.now();
        let tracking = false;
        let firing = false;
        let fireStart = 0;
        let done = false;
        let prevEl = null;
        let prevAz = null;
        let azI = 0;
        let elI = 0;
        // Fine hands for the dive: the elevator is placed directly (bias learnt as it goes).
        let eBias = elevEst;
        const kTh = o.elevPerDeg ?? P.diveElevPerDeg ?? 0.045;
        const kQ = o.elevPerDegS ?? P.diveElevPerDegS ?? 0.014;
        const dive = await fly(
          (s) => {
            watch(s);
            const T = find() || t;
            const now = drv.now();
            const dt = clamp((now - lastT) / 1000, 0.01, 0.5);
            lastT = now;
            // Aim at the lower hull, a few metres short: the burst's scatter is long along the line of
            // sight, and the recoil lifts it (the rounds walk long) — so the pilot holds the pipper short.
            const shortM = o.aimShortM ?? 10;
            const rightM = o.aimRightM ?? 0;
            const ca = Math.cos(axis * D2R);
            const sa = Math.sin(axis * D2R);
            const los = api.lineOfSight(s, T.x - sa * shortM + ca * rightM, T.y + 0.9, T.z + ca * shortM + sa * rightM);
            const gam = pathDeg(s.verticalSpeed, Math.max(s.groundSpeed, 60));
            const alpha = clamp(fin(s.aoa, 0), -5, 20);
            // Where the rounds go: the CCIP pipper (the gun line + drop when there is none).
            let elErr;
            let azErr;
            const cc = api.combat() && api.combat().ccip;
            if (cc && Number.isFinite(cc.x)) {
              const pip = api.lineOfSight(s, cc.x, cc.y, cc.z);
              elErr = los.el - pip.el;
              azErr = wrap180(los.az - pip.az);
              if (tracking && !firing) res.pipperErrM = Math.round(Math.hypot(cc.x - T.x, cc.z - T.z));
            } else {
              elErr = los.el - (s.pitch - gun.boresightDownDeg);
              azErr = los.az;
            }
            const dEl = prevEl === null ? 0 : (elErr - prevEl) / dt;
            const dAz = prevAz === null ? 0 : wrap180(azErr - prevAz) / dt;
            if (tracking) azI = clamp(azI + azErr * dt, -3, 3);
            prevEl = elErr;
            prevAz = azErr;
            if (!tracking) {
              // Walk the flight path down toward the target's line of sight (never steeper than dive + 4°).
              const want = clamp(los.el, -(diveDeg + 4), 0);
              gCmd += clamp(want - gCmd, -pushRate * dt, pushRate * dt * 2);
              if ((Math.abs(gam - los.el) < 2.5 && gCmd <= want + 0.5) || gam <= -diveDeg + 1) {
                tracking = true;
                api.phase = 'gun run: tracking';
                note('tracking', { gammaDeg: +gam.toFixed(1), losDeg: +los.el.toFixed(1), elErr: +elErr.toFixed(2) });
              }
            } else {
              // The pipper: a damped step on the flight path (proportional + integral + rate), small at a time.
              elI = clamp(elI + elErr * dt, -2, 2);
              gCmd = gam + clamp(0.9 * elErr + 0.35 * elI + 0.3 * dEl, -2, 2);
            }
            if (o.debug) note('trk', { tracking, gam: +gam.toFixed(1), gCmd: +gCmd.toFixed(1), los: +los.el.toFixed(1), losAz: +los.az.toFixed(1), elErr: +elErr.toFixed(2), azErr: +azErr.toFixed(2), rng: Math.round(los.range), cc: cc ? [Math.round(cc.x), Math.round(cc.y), Math.round(cc.z)] : null, T: [Math.round(T.x), Math.round(T.y), Math.round(T.z)] });
            const inRange = los.range <= openFireM * 1.03;
            // on target: the rounds pass within ~2.5 m of its centre vertically (it is low) and ~4 m sideways
            const aimed = los.range * Math.abs(elErr) * D2R < (o.aimM ?? 2.5) && los.range * Math.abs(azErr) * D2R < (o.aimM ?? 2.5) * 1.6;
            if (!firing && tracking && inRange && (aimed || los.range < openFireM * 0.8)) {
              firing = true;
              fireStart = drv.now();
              res.slantAtFireM = Math.round(los.range);
              res.pipperErrDeg = +Math.hypot(elErr, azErr).toFixed(2);
              res.fired = true;
              note('open fire', { slantM: Math.round(los.range), elErr: +elErr.toFixed(2), azErr: +azErr.toFixed(2), pipperErrM: res.pipperErrM });
            }
            // (the height over the target too: the ground may rise toward it)
            const low = s.altitudeAGL < pullOutFt + 250 || s.altitude - T.y * M_FT < pullOutFt + 250;
            const stop = firing && (drv.now() - fireStart >= burstMs || los.range < ceaseM || low);
            if (stop || low || (!firing && los.range < ceaseM)) done = true;
            const pitch = alpha * Math.cos(clamp(fin(s.roll), -60, 60) * D2R) + gCmd + 0.6 * (gCmd - gam);
            const pErr = clamp(pitch - s.pitch, -4, 4);
            eBias = clamp(eBias + 0.02 * pErr * dt, -0.6, 0.6);
            return {
              pitch,
              elev: clamp(eBias + kTh * pErr - kQ * rates.q, -0.7, 0.7),
              // (firm lateral hands: a fraction of a degree is metres on the target)
              roll: clamp(azErr * 10 + dAz * 3 + azI * 3, -25, 25),
              rollScale: tracking ? 2 : undefined,
              yaw: wrap360(s.heading + clamp(azErr * 8 + dAz * 2, -6, 6)),
              thr: runHold.throttle(s),
              speedBrake: P.jet ? s.airspeed > runKt + 20 : undefined,
              trigger: firing && !stop,
              trim: false,
            };
          },
          (s) => done || s.altitudeAGL < pullOutFt + 150,
          60000,
          100,
        );
        key('KeyQ', false);
        res.rounds = roundsBefore - (api.combat() ? api.combat().rounds : roundsBefore);
        note('cease fire', { rounds: res.rounds });
        if (dive === 'crashed') return { ...res, result: 'crashed' };

        // 5. Safe pull-off: wings level, full power, a firm pull until the nose is well up; then a
        // climbing turn back toward the IP (the low ground we came over — never on over the target
        // toward the hills behind it), climbing out to o.climbToAglFt.
        api.phase = 'gun run: pull off';
        const pullG = o.pullG ?? 4;
        await fly((s) => { watch(s); return { g: s.altitudeAGL < pullOutFt ? pullG + 1 : pullG, roll: 0, thr: P.maxThrottle, speedBrake: false, trim: false }; }, (s) => s.verticalSpeed > 1500 && s.pitch > 10, 20000, 100);
        api.phase = 'gun run: climb-out';
        const back = wrap360(axis + 180);
        await fly((s) => {
          watch(s);
          const turnDone = Math.abs(wrap180(s.heading - back)) < 20;
          return { pitch: clamp(s.pitch + (s.airspeed - P.climbKt) * 0.1, 6, 16), roll: turnDone ? rollFor(s, back, 30) : clamp(rollFor(s, back, 40), -40, 40), thr: P.maxThrottle, trim: turnDone };
        }, (s) => s.altitudeAGL > (o.climbToAglFt ?? 2500) && Math.abs(wrap180(s.heading - back)) < 30, 90000);
        // Level off gently (the nose comes down a little at a time: no bunt into the next set-up).
        api.phase = 'gun run: level off';
        await fly((s) => { watch(s); return { pitch: clamp(pitchForVs(s, 0), s.pitch - 1.5, s.pitch + 1.5), roll: rollFor(s, back, 20), thr: P.cruiseThrottle }; }, (s) => Math.abs(s.verticalSpeed) < 600 && Math.abs(s.roll) < 10, 30000);
        const tt = find();
        res.targetAfter = tt ? { alive: tt.alive, health: tt.health } : null;
        res.kills = api.combat() ? api.combat().stats.kills - res.killsBefore : 0;
        res.result = sim().state === 'crashed' ? 'crashed' : 'done';
        note('gun run done', { rounds: res.rounds, kills: res.kills, minAglFt: Math.round(res.minAglFt), minG: +res.minG.toFixed(2), target: res.targetAfter });
        return res;
      },

      /**
       * Maverick: point the nose at the target (within the seeker cone), press T until the lock is on
       * THAT target, press Z, then turn away. Waits (up to o.waitS) for the missile to arrive.
       */
      async mavShot(targetId, o = {}) {
        const c0 = api.combat();
        if (!c0 || !c0.hasMissiles || !(c0.missiles > 0)) return { result: 'no missiles' };
        const find = () => (api.combat() ? api.combat().list().find((t) => t.id === targetId) : null);
        let t = find();
        if (!t) return { result: 'no target' };
        const M = P.missile || { maxRangeM: 8000, minRangeM: 400, selectConeDeg: 10, lockTimeS: 0.8, speed: 300 };
        const res = { result: 'aborted', locked: false, launched: false, killsBefore: c0.stats.kills, fired: c0.stats.missilesFired };
        // Get inside the envelope: from > 0.85 × max range come in; from inside 1.5 km open out first.
        let s = sim();
        let d = Math.hypot(t.x - s.position.x, t.z - s.position.z);
        if (d < Math.max(M.minRangeM * 3, 2000)) {
          const away = bearingTo(t.x, t.z, s.position.x, s.position.z);
          await api.gotoPoint(t.x + Math.sin(away * D2R) * 4500, t.z - Math.cos(away * D2R) * 4500, { aglFt: o.aglFt ?? 2500, speedKt: P.cruiseKt, arriveM: 700, phase: 'mav: open out' });
        }
        api.phase = 'mav: point';
        note('mav point', { target: targetId });
        const tryLockAt = { t: -1e9 };
        let presses = 0;
        const r = await fly(
          (x) => {
            const T = find() || t;
            const los = api.lineOfSight(x, T.x, T.y + 1, T.z);
            const lk = api.combat() && api.combat().lock;
            const cone = M.selectConeDeg * 0.5;
            // Press T when the nose is on it; again if the lock went to another target.
            if (Math.abs(los.az) < cone && Math.abs(los.el - x.pitch) < M.selectConeDeg * 0.8 && drv.now() - tryLockAt.t > (M.lockTimeS + 0.5) * 1000) {
              if (!lk || lk.state === 'off' || (lk.targetId !== null && lk.targetId !== targetId)) {
                tryLockAt.t = drv.now();
                presses++;
                tap('KeyT');
              }
            }
            return { pitch: clamp(los.el + 1, -12, 8), roll: clamp(los.az * 2.5, -30, 30), thr: P.cruiseThrottle };
          },
          (x) => {
            const lk = api.combat() && api.combat().lock;
            if (!!lk && lk.state === 'locked' && lk.inRange !== false && (lk.targetId === targetId || (presses >= (o.acceptOtherAfter ?? 4) && lk.targetId !== null))) return true;
            // Too low or too close: abort (the caller can come round again).
            const T = find() || t;
            return x.altitudeAGL < 500 || api.lineOfSight(x, T.x, T.y, T.z).range < M.minRangeM * 1.5;
          },
          o.timeoutMs ?? 60000,
        );
        const lk1 = api.combat() && api.combat().lock;
        if (r !== 'done' || !(lk1 && lk1.state === 'locked' && lk1.targetId !== null)) {
          note('mav: no lock', { presses });
          await fly((x) => ({ pitch: 8, roll: 0, thr: P.maxThrottle }), (x) => x.altitudeAGL > 1000 && x.verticalSpeed > 0, 20000);
          return { ...res, result: r === 'crashed' ? 'crashed' : 'no lock', presses };
        }
        res.locked = true;
        if (lk1.targetId !== targetId) { targetId = lk1.targetId; res.retargeted = targetId; }
        note('mav locked', { presses, rangeM: Math.round(api.combat().lock.rangeM || 0) });
        await tap('KeyZ', 80);
        await sleep(300);
        res.launched = api.combat().stats.missilesFired > res.fired;
        note('rifle', { launched: res.launched });
        api.phase = 'mav: egress';
        const hdg0 = sim().heading;
        const alt0 = sim().altitude;
        const until = drv.now() + (o.waitS ?? 25) * 1000;
        await fly(
          (x) => ({ pitch: pitchForVs(x, altHoldVs(x, alt0)), roll: rollFor(x, wrap360(hdg0 + (o.breakDeg ?? 35)), 30), thr: P.cruiseThrottle }),
          () => {
            const c = api.combat();
            const T = find();
            return drv.now() > until || (c && c.missilesInFlight === 0 && drv.now() > until - (o.waitS ?? 25) * 1000 + 2000) || (T && !T.alive);
          },
          (o.waitS ?? 25) * 1000 + 1000,
        );
        const tt = find();
        res.targetAfter = tt ? { alive: tt.alive, health: tt.health } : null;
        res.kills = api.combat().stats.kills - res.killsBefore;
        res.result = sim().state === 'crashed' ? 'crashed' : 'done';
        note('mav done', { kills: res.kills, target: res.targetAfter });
        return res;
      },
    };
    return api;
  }

  const lib = {
    D2R, R2D, M_FT, KT_MS, clamp, wrap180, wrap360,
    densityRatio, speedOfSound, machFrom,
    BASE, profileFor,
    flareHeightFt, flareSinkFpm, flarePitch, landingPitchTarget, pathDeg,
    bearingTo, lineCoords, lineHeading, pitchForVs, glidePathTargets, runwayInfo,
    createPilot,
  };
  G.qaPilotLib = lib;

  if (typeof window !== 'undefined' && typeof document !== 'undefined' && window.dispatchEvent) {
    const KEYS = { BracketLeft: '[', BracketRight: ']', KeyW: 'w', KeyS: 's', KeyA: 'a', KeyD: 'd', KeyG: 'g', KeyF: 'f', KeyV: 'v', KeyQ: 'q', KeyZ: 'z', KeyT: 't', KeyX: 'x', KeyR: 'r', Space: ' ' };
    const browserDriver = {
      read: () => window.sim,
      key(code, down, shift = false) {
        const k = KEYS[code] ?? code;
        window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { code, key: shift ? k.toUpperCase() : k, shiftKey: shift, bubbles: true }));
      },
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => performance.now(),
    };
    window.qaPilot = createPilot(browserDriver, {});
  }
})();
