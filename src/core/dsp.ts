/**
 * Tone-bank front end: a Hann-windowed DFT at exactly the tone frequencies of the
 * active plan, evaluated at whatever (possibly fractional) symbol step the receiver
 * decided on. For M <= 8 tones a direct DFT is cheaper and far more accurate than an
 * FFT of the same window, and it lets the demodulator retune per device instead of
 * hoping the browser's FFT bin grid happens to line up.
 */

export interface ToneBank {
  sr: number;
  /** Analysis window length in samples (one symbol). */
  L: number;
  m: number;
  tones: number[];
  /** Per-tone cos/sin tables over the window. */
  cs: Float32Array[];
  sn: Float32Array[];
  w: Float32Array;
  /** Converts |X|^2 into the mean-square amplitude of the equivalent sine. */
  norm: number;
}

export function makeToneBank(sr: number, L: number, tones: number[]): ToneBank {
  const w = new Float32Array(L);
  let sum = 0;
  for (let n = 0; n < L; n++) {
    const v = 0.5 * (1 - Math.cos((2 * Math.PI * n) / L));
    w[n] = v;
    sum += v;
  }
  const cs: Float32Array[] = [];
  const sn: Float32Array[] = [];
  for (const f of tones) {
    const c = new Float32Array(L);
    const s = new Float32Array(L);
    const dw = (2 * Math.PI * f) / sr;
    for (let n = 0; n < L; n++) {
      c[n] = Math.cos(dw * n);
      s[n] = Math.sin(dw * n);
    }
    cs.push(c);
    sn.push(s);
  }
  return { sr, L, m: tones.length, tones: [...tones], cs, sn, w, norm: 2 / (sum * sum) };
}

/** Powers of each tone over `bank.L` samples starting at `start`. Returns false if out of range. */
export function measureTones(bank: ToneBank, samples: Float32Array, start: number, out: Float32Array): boolean {
  const s0 = Math.round(start);
  if (s0 < 0 || s0 + bank.L > samples.length) return false;
  const { L, w } = bank;
  for (let k = 0; k < bank.m; k++) {
    const cs = bank.cs[k]!;
    const sn = bank.sn[k]!;
    let re = 0;
    let im = 0;
    for (let n = 0; n < L; n++) {
      const v = samples[s0 + n]! * w[n]!;
      re += v * cs[n]!;
      im -= v * sn[n]!;
    }
    out[k] = (re * re + im * im) * bank.norm;
  }
  return true;
}

export interface SymbolSet {
  count: number;
  /** Winning tone per symbol. */
  idx: Uint8Array;
  /** Chosen tone power vs. the mean of the others (1 = indistinguishable). */
  rel: Float32Array;
  /** Chosen tone power, mean-square. */
  pow: Float32Array;
  /** Total power across the tone bank, mean-square. */
  tot: Float32Array;
}

export function allocSymbols(count: number): SymbolSet {
  return {
    count,
    idx: new Uint8Array(count),
    rel: new Float32Array(count),
    pow: new Float32Array(count),
    tot: new Float32Array(count),
  };
}

const EPS = 1e-12;

/**
 * Measure `count` symbols starting at `startSample`, advancing `step` samples each.
 * `step` is fractional so the receiver can track sample-rate drift between devices.
 */
export function readSymbols(
  bank: ToneBank,
  samples: Float32Array,
  startSample: number,
  step: number,
  out: SymbolSet,
): boolean {
  const buf = new Float32Array(bank.m);
  for (let i = 0; i < out.count; i++) {
    const start = Math.round(startSample + i * step);
    if (!measureTones(bank, samples, start, buf)) return false;
    let best = 0;
    let total = 0;
    for (let k = 0; k < bank.m; k++) {
      const v = buf[k]!;
      total += v;
      if (v > buf[best]!) best = k;
    }
    const others = total - buf[best]!;
    out.idx[i] = best;
    out.pow[i] = buf[best]!;
    out.tot[i] = total;
    // Capped: an unclamped ratio on a clean channel runs into 1e9 and makes it
    // impossible to compare two timing hypotheses.
    out.rel[i] = Math.min(64, buf[best]! / (others / Math.max(1, bank.m - 1) + EPS));
  }
  return true;
}

/** Mean-square level of a stretch of audio, in dBFS. */
export function levelDb(samples: Float32Array, start: number, len: number): number {
  const s0 = Math.max(0, Math.floor(start));
  const s1 = Math.min(samples.length, Math.floor(start + len));
  if (s1 <= s0) return -120;
  let acc = 0;
  for (let i = s0; i < s1; i++) acc += samples[i]! * samples[i]!;
  return 10 * Math.log10(acc / (s1 - s0) + 1e-12);
}

/** Hamming weight of the agreement between a received chip pattern and the preamble. */
export function matchScore(idx: Uint8Array, stride: number, base: number, pattern: Uint8Array, maxIndex: number): number {
  let hits = 0;
  for (let j = 0; j < pattern.length; j++) {
    const at = base + j * stride;
    if (at < 0 || at >= idx.length) return -1;
    const got = idx[at]!;
    if (got > maxIndex) return -1;
    if (got === pattern[j]!) hits++;
  }
  return hits;
}

/** A power-of-two-free "any sample rate" helper: LCM used to align byte/symbol grids. */
export function lcm(a: number, b: number): number {
  const g = gcd(a, b);
  return (a / g) * b;
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b);
}
