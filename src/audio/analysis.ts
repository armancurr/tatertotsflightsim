/** PURE signal analysis used by the audio self-test (RMS, single-bin DFT, peak search). */

export function rms(s: ArrayLike<number>): number {
  if (s.length === 0) return 0;
  let acc = 0;
  for (let i = 0; i < s.length; i++) acc += s[i] * s[i];
  return Math.sqrt(acc / s.length);
}

/** Amplitude of the sinusoid at `freq` Hz in `s` (Goertzel over the whole block). */
export function goertzelAmplitude(s: ArrayLike<number>, sampleRate: number, freq: number): number {
  const n = s.length;
  if (n === 0 || !(sampleRate > 0)) return 0;
  const w = (2 * Math.PI * freq) / sampleRate;
  const coeff = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const s0 = s[i] + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  const re = s1 - s2 * Math.cos(w);
  const im = s2 * Math.sin(w);
  return (2 * Math.sqrt(re * re + im * im)) / n;
}

/** Frequency with the largest Goertzel amplitude between fMin and fMax (scan step `step` Hz). */
export function dominantFrequency(s: ArrayLike<number>, sampleRate: number, fMin: number, fMax: number, step: number): number {
  let best = fMin;
  let bestA = -1;
  for (let f = fMin; f <= fMax; f += step) {
    const a = goertzelAmplitude(s, sampleRate, f);
    if (a > bestA) {
      bestA = a;
      best = f;
    }
  }
  return best;
}
