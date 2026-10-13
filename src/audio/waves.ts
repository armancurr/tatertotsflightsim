/**
 * PURE waveform and noise generators for the synthesiser. Periodic sounds are designed in
 * the time domain (one period of samples) and turned into PeriodicWave coefficients with
 * `fourierSeries`, so an OscillatorNode can play them at any pitch without aliasing and
 * retune smoothly (no buffer-rate artefacts).
 */

/** Deterministic PRNG (mulberry32), returns floats in [0,1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface FourierSeries {
  /** Cosine terms, index = harmonic number (0 = DC, always 0). */
  real: Float32Array;
  /** Sine terms. */
  imag: Float32Array;
}

/**
 * Fourier series of one period of `samples` (PeriodicWave convention:
 * x(t) = Σ real[k]·cos(2πkt) + imag[k]·sin(2πkt)). DC is dropped.
 */
export function fourierSeries(samples: ArrayLike<number>, harmonics: number): FourierSeries {
  const n = samples.length;
  const h = Math.max(1, Math.floor(harmonics));
  const real = new Float32Array(h + 1);
  const imag = new Float32Array(h + 1);
  if (n === 0) return { real, imag };
  for (let k = 1; k <= h; k++) {
    let re = 0;
    let im = 0;
    const w = (2 * Math.PI * k) / n;
    for (let j = 0; j < n; j++) {
      const s = Number.isFinite(samples[j]) ? samples[j] : 0;
      re += s * Math.cos(w * j);
      im += s * Math.sin(w * j);
    }
    real[k] = (2 / n) * re;
    imag[k] = (2 / n) * im;
  }
  return { real, imag };
}

function normalise(s: Float32Array): Float32Array {
  let mean = 0;
  for (let i = 0; i < s.length; i++) mean += s[i];
  mean /= Math.max(1, s.length);
  let peak = 0;
  for (let i = 0; i < s.length; i++) {
    s[i] -= mean;
    peak = Math.max(peak, Math.abs(s[i]));
  }
  if (peak > 0) for (let i = 0; i < s.length; i++) s[i] /= peak;
  return s;
}

/** Exhaust blowdown pulse: near-instant rise, exponential decay, slight rarefaction afterwards. `t` in cycle fractions. */
function exhaustPulse(t: number, decay: number): number {
  if (t < 0) return 0;
  const rise = 1 - Math.exp(-t / 0.0025);
  return rise * (Math.exp(-t / decay) - 0.12 * Math.exp(-t / (decay * 2.6)) * Math.min(1, t / decay));
}

/**
 * One full 4-stroke cycle (two crank revolutions) of a 4-cylinder aero engine: four exhaust
 * pulses (firing order 1-3-2-4), slightly uneven in strength and timing like a real
 * Lycoming — that unevenness is what gives the half-order "lumpy" drone.
 */
export function engineCycleWaveform(n: number): Float32Array {
  const s = new Float32Array(n);
  const amps = [1, 0.62, 0.78, 0.95];
  const phase = [0, 0.25 + 0.018, 0.5 - 0.012, 0.75 + 0.01];
  const decay = [0.034, 0.03, 0.038, 0.029];
  for (let j = 0; j < n; j++) {
    const t = j / n;
    let v = 0;
    for (let c = 0; c < 4; c++) {
      // wrap so the pulse tail continues into the next cycle
      let dt = t - phase[c];
      if (dt < 0) dt += 1;
      v += amps[c] * exhaustPulse(dt, decay[c]);
    }
    s[j] = v;
  }
  return normalise(s);
}

/**
 * One full 4-stroke cycle (two crank revolutions) of a 6-cylinder in-line diesel (Volvo Penta D6):
 * six combustion pulses 1/6 of a cycle apart (firing order 1-5-3-6-2-4). A diesel's pressure rise
 * is much steeper than a spark engine's (the "knock" of compression ignition) and its pulses are
 * shorter; small cylinder-to-cylinder differences give the faint half-order roughness.
 */
export function dieselCycleWaveform(n: number): Float32Array {
  const s = new Float32Array(n);
  const amps = [1, 0.9, 0.96, 0.86, 0.94, 0.9];
  const shift = [0, 0.006, -0.004, 0.005, -0.006, 0.003];
  const decay = [0.018, 0.02, 0.017, 0.021, 0.019, 0.018];
  for (let j = 0; j < n; j++) {
    const t = j / n;
    let v = 0;
    for (let c = 0; c < 6; c++) {
      let dt = t - (c / 6 + shift[c]);
      dt -= Math.floor(dt);
      // Fast rise (≈0.1 % of a cycle), then the blowdown; a small damped ring after the knock.
      const rise = 1 - Math.exp(-dt / 0.0012);
      const ring = 0.18 * Math.exp(-dt / 0.008) * Math.sin(2 * Math.PI * dt * 55);
      v += amps[c] * (rise * (Math.exp(-dt / decay[c]) - 0.1 * Math.exp(-dt / (decay[c] * 3)) * Math.min(1, dt / decay[c])) + ring);
    }
    s[j] = v;
  }
  return normalise(s);
}

/** One blade passage of the propeller: a sharp loading pulse with a slower recovery (buzz-saw character). */
export function propWaveform(n: number): Float32Array {
  const s = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const t = j / n;
    const pulse = Math.exp(-t / 0.09) * (1 - Math.exp(-t / 0.012));
    const thickness = -0.35 * Math.exp(-(((t - 0.55) / 0.12) ** 2));
    s[j] = pulse + thickness + 0.25 * (1 - t);
  }
  return normalise(s);
}

/** A raised-cosine pulse occupying `duty` of the period (used to amplitude-modulate noise). */
export function pulseWaveform(n: number, duty: number): Float32Array {
  const s = new Float32Array(n);
  const d = Math.min(0.95, Math.max(0.02, duty));
  for (let j = 0; j < n; j++) {
    const t = j / n;
    s[j] = t < d ? 0.5 - 0.5 * Math.cos((2 * Math.PI * t) / d) : 0;
  }
  return normalise(s);
}

/** Pneumatic reed: the reed chops the airflow → an asymmetric, soft-edged pulse (nasal, buzzy). */
export function hornWaveform(n: number): Float32Array {
  const s = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const t = j / n;
    const open = 1 / (1 + Math.exp(-(t - 0.08) * 90)) - 1 / (1 + Math.exp(-(t - 0.42) * 45));
    s[j] = open + 0.15 * Math.sin(2 * Math.PI * 3 * t);
  }
  return normalise(s);
}

/**
 * One period of an on/off gate (0..1) with raised-cosine edges of `edge` × period (default 6 %),
 * on for `duty` of the period. Used to beep the gear warning horn without clicks.
 */
export function gateWaveform(n: number, duty: number, edge = 0.06): Float32Array {
  const s = new Float32Array(n);
  const d = Math.min(0.9, Math.max(0.1, Number.isFinite(duty) ? duty : 0.5));
  const e = Math.min(0.2, Math.max(0.01, edge));
  for (let j = 0; j < n; j++) {
    const t = j / n;
    let v: number;
    if (t < e) v = 0.5 - 0.5 * Math.cos((Math.PI * t) / e);
    else if (t < d) v = 1;
    else if (t < d + e) v = 0.5 + 0.5 * Math.cos((Math.PI * (t - d)) / e);
    else v = 0;
    s[j] = v;
  }
  return s;
}

/** Electronic warning beep: a square wave with slightly rounded edges and a touch of even harmonic (a small cabin speaker). */
export function beepWaveform(n: number): Float32Array {
  const s = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const t = j / n;
    s[j] = Math.tanh(4 * Math.sin(2 * Math.PI * t)) + 0.12 * Math.sin(4 * Math.PI * t);
  }
  return normalise(s);
}

export type NoiseKind = 'white' | 'pink' | 'brown';

/** Deterministic noise, zero mean, peak-normalised to 0.99. */
export function noiseSamples(kind: NoiseKind, n: number, seed: number): Float32Array {
  const rnd = mulberry32(seed);
  const s = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  let last = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2 - 1;
    if (kind === 'white') {
      s[i] = w;
    } else if (kind === 'pink') {
      // Paul Kellet's refined pink filter
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      s[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
    } else {
      last = (last + 0.02 * w) / 1.02;
      s[i] = last;
    }
  }
  const out = normalise(s);
  for (let i = 0; i < n; i++) out[i] *= 0.99;
  return out;
}

/**
 * Afterburner "crackle": sparse, positively skewed pressure spikes (sharp rise, fast decay, slower
 * shallow undershoot) of random, heavy-tailed strength — the signature of a shock-laden supersonic
 * jet. `density` = probability of a spike per sample. Loops seamlessly (spikes wrap around).
 */
export function crackleSamples(n: number, seed: number, density: number): Float32Array {
  const rnd = mulberry32(seed);
  const len = Math.max(1, Math.floor(n));
  const s = new Float32Array(len);
  const d = Math.min(0.1, Math.max(1e-5, Number.isFinite(density) ? density : 0.003));
  for (let i = 0; i < len; i++) {
    if (rnd() >= d) continue;
    const amp = 0.08 + 0.92 * Math.pow(rnd(), 2.2);
    const width = 1.5 + rnd() * 4;
    const span = Math.ceil(width * 8);
    for (let j = 0; j < span; j++) {
      const x = j / width;
      s[(i + j) % len] += amp * (Math.exp(-x) - 0.3 * Math.exp(-x / 3) * Math.min(1, x));
    }
  }
  let peak = 0;
  for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(s[i]));
  if (peak > 0) for (let i = 0; i < len; i++) s[i] = (s[i] / peak) * 0.99;
  return s;
}

/**
 * Fan "buzz-saw": supersonic fan-blade tips radiate at every harmonic of the shaft rate, with
 * uneven, blade-to-blade-irregular amplitudes (multiple pure tones). One shaft revolution.
 */
export function buzzsawWaveform(n: number, seed: number, harmonics = 36): Float32Array {
  const rnd = mulberry32(seed);
  const s = new Float32Array(n);
  const amps: number[] = [];
  const phases: number[] = [];
  for (let k = 1; k <= harmonics; k++) {
    amps.push(Math.pow(k, -0.75) * (0.35 + 0.9 * rnd()));
    phases.push(2 * Math.PI * rnd());
  }
  for (let j = 0; j < n; j++) {
    const t = j / n;
    let v = 0;
    for (let k = 1; k <= harmonics; k++) v += amps[k - 1] * Math.sin(2 * Math.PI * k * t + phases[k - 1]);
    s[j] = v;
  }
  return normalise(s);
}

/** Turbine whine partial: a sine with a little 2nd/3rd harmonic (blade-pass tones are not pure). */
export function whineWaveform(n: number): Float32Array {
  const s = new Float32Array(n);
  for (let j = 0; j < n; j++) {
    const t = (2 * Math.PI * j) / n;
    s[j] = Math.sin(t) + 0.22 * Math.sin(2 * t + 0.4) + 0.07 * Math.sin(3 * t + 1.1);
  }
  return normalise(s);
}

/**
 * Soft-clipper transfer curve for a WaveShaperNode over input −1..1: linear up to `knee`, then a tanh
 * shoulder that approaches (never reaches) `ceiling`. Monotone, odd, |out| < ceiling.
 */
export function softClipCurve(n: number, knee: number, ceiling: number): Float32Array {
  const len = Math.max(3, Math.floor(n) | 1);
  const c = new Float32Array(len);
  const k = Math.min(0.95, Math.max(0.1, knee));
  const top = Math.min(1, Math.max(k + 0.01, ceiling));
  const room = top - k;
  for (let i = 0; i < len; i++) {
    const x = (i / (len - 1)) * 2 - 1;
    const a = Math.abs(x);
    const y = a <= k ? a : k + room * Math.tanh((a - k) / room);
    c[i] = Math.sign(x) * Math.min(y, top - 1e-6);
  }
  return c;
}

/** The two blades of a teetering rotor are never quite identical: relative strength and phase of blade 2. */
const BLADE2 = { amp: 0.86, phase: 0.5 + 0.011 };

/** Circular distance of phase `t` from `c` (both in periods), −0.5..0.5. */
const wrap = (t: number, c: number): number => {
  let d = t - c;
  d -= Math.round(d);
  return d;
};

/**
 * One main-rotor REVOLUTION of a two-blade rotor as a gate (0..1): a pulse per blade passage.
 * `width` is the Gaussian width in revolutions (≈0.07 = soft whoosh/thump, ≈0.012 = sharp slap).
 * Not normalised: use it with `gateOffset` (the osc is the zero-mean, peak-normalised version).
 */
export function rotorGateWaveform(n: number, width: number): Float32Array {
  const s = new Float32Array(n);
  const w = Math.max(0.002, Math.min(0.25, Number.isFinite(width) ? width : 0.05));
  for (let j = 0; j < n; j++) {
    const t = j / n;
    const d1 = wrap(t, 0);
    const d2 = wrap(t, BLADE2.phase);
    s[j] = Math.exp(-0.5 * (d1 / w) ** 2) + BLADE2.amp * Math.exp(-0.5 * (d2 / w) ** 2);
  }
  return s;
}

/**
 * One main-rotor revolution of blade–vortex-interaction pressure: per blade passage a sharp, mostly
 * positive-then-negative impulse (the derivative of a narrow Gaussian, asymmetric) — the "crack" of
 * blade slap. Zero-mean, peak-normalised.
 */
export function bladeSlapWaveform(n: number, width = 0.006): Float32Array {
  const s = new Float32Array(n);
  const w = Math.max(0.002, Math.min(0.05, width));
  const pulse = (d: number) => {
    const x = d / w;
    // Steeper compression than rarefaction: the impulse is lopsided like a real BVI pressure spike.
    return -x * Math.exp(-0.5 * x * x) * (x < 0 ? 1.35 : 0.8);
  };
  for (let j = 0; j < n; j++) {
    const t = j / n;
    s[j] = pulse(wrap(t, 0)) + BLADE2.amp * pulse(wrap(t, BLADE2.phase));
  }
  return normalise(s);
}

/**
 * The constant a gain's base value needs so that `base + osc` never goes negative, where `osc` plays
 * `samples` as a PeriodicWave (WebAudio drops the DC and normalises the peak to 1). ≥ 0.
 */
export function gateOffset(samples: ArrayLike<number>): number {
  const n = samples.length;
  if (n === 0) return 0;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += Number.isFinite(samples[i]) ? samples[i] : 0;
  mean /= n;
  let peak = 0;
  let min = Infinity;
  for (let i = 0; i < n; i++) {
    const v = (Number.isFinite(samples[i]) ? samples[i] : 0) - mean;
    peak = Math.max(peak, Math.abs(v));
    min = Math.min(min, v);
  }
  return peak > 0 ? Math.max(0, -min / peak) : 0;
}
