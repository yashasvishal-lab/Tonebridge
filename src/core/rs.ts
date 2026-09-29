/**
 * Systematic shortened Reed-Solomon over GF(256).
 *
 * A codeword is `[data..., parity...]`; the generator has roots alpha^0..alpha^(p-1)
 * so every valid codeword satisfies C(alpha^j) = 0. Shortening the classic
 * (255, 255-p) code by dropping leading zero message symbols keeps the parity cost
 * at exactly `p` bytes while preserving correction power.
 *
 * Decoding runs in two stages, which is what makes it useful over a lossy acoustic
 * channel:
 *   1. erasure stage - when the demodulator points at bytes it does not trust, the
 *      error values are recovered by solving a square Vandermonde system over
 *      GF(256). This uses all `p` parity bytes to fix `p` bytes (twice the reach of
 *      error-only decoding).
 *   2. error stage - classic Berlekamp-Massey + Chien + Forney, correcting up to
 *      floor(p/2) unknown bytes.
 * Both stages are verified by recomputing the syndromes, so an uncorrectable frame
 * is reported as a failure instead of being silently miscorrected.
 */

import { GF_EXP, GF_LOG, gfDiv, gfMul } from './gf256.ts';

/** Polynomials are big-endian coefficient arrays: index 0 is the highest degree. */
function polyMul(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    if (ai === 0) continue;
    for (let j = 0; j < b.length; j++) out[i + j] ^= gfMul(ai, b[j]!);
  }
  return out;
}

function polyEval(p: Uint8Array, x: number): number {
  let r = 0;
  for (let i = 0; i < p.length; i++) r = gfMul(r, x) ^ p[i]!;
  return r;
}

export interface DecodeResult {
  ok: boolean;
  /** Corrected codeword (data + parity); only meaningful when ok. */
  codeword: Uint8Array;
  errors: number;
  erasures: number;
}

export class RsCodec {
  readonly parity: number;
  readonly gen: Uint8Array;

  constructor(parity: number) {
    if (!Number.isInteger(parity) || parity < 2 || parity > 64) {
      throw new RangeError('Reed-Solomon parity must be an integer in 2..64');
    }
    this.parity = parity;
    let g: Uint8Array = new Uint8Array([1]);
    for (let i = 0; i < parity; i++) g = polyMul(g, new Uint8Array([1, GF_EXP[i]!]));
    this.gen = g;
  }

  /** Returns `data || parity`. */
  encode(data: Uint8Array): Uint8Array {
    const p = this.parity;
    const out = new Uint8Array(data.length + p);
    out.set(data, 0);
    const rem = new Uint8Array(p);
    for (let i = 0; i < data.length; i++) {
      const coef = data[i]! ^ rem[0]!;
      rem.copyWithin(0, 1);
      rem[p - 1] = 0;
      if (coef === 0) continue;
      for (let j = 0; j < p; j++) rem[j] ^= gfMul(this.gen[j + 1]!, coef);
    }
    out.set(rem, data.length);
    return out;
  }

  /** S[j] = C(alpha^j); all zero means the received word is a codeword. */
  syndromes(cw: Uint8Array): Uint8Array {
    const s = new Uint8Array(this.parity);
    for (let j = 0; j < this.parity; j++) s[j] = polyEval(cw, GF_EXP[j]!);
    return s;
  }

  isClean(cw: Uint8Array): boolean {
    const s = this.syndromes(cw);
    for (let j = 0; j < s.length; j++) if (s[j] !== 0) return false;
    return true;
  }

  /**
   * @param cw received codeword (data || parity)
   * @param erasurePos indices into `cw` the caller suspects are unreliable
   */
  decode(cw: Uint8Array, erasurePos?: number[]): DecodeResult {
    const p = this.parity;
    const n = cw.length;
    if (n <= p) return { ok: false, codeword: cw, errors: 0, erasures: 0 };

    const synd = this.syndromes(cw);
    let dirty = false;
    for (let j = 0; j < p; j++) if (synd[j] !== 0) dirty = true;
    if (!dirty) return { ok: true, codeword: cw, errors: 0, erasures: 0 };

    if (erasurePos && erasurePos.length > 0) {
      const erased = [...new Set(erasurePos.filter((i) => i >= 0 && i < n))];
      if (erased.length > 0 && erased.length <= p) {
        const fixed = this.solveErasures(cw, synd, erased);
        if (fixed) return { ok: true, codeword: fixed, errors: 0, erasures: erased.length };
      }
    }

    const fixed = this.decodeErrors(cw, synd, p, n);
    if (!fixed) return { ok: false, codeword: cw, errors: 0, erasures: 0 };
    return { ok: true, codeword: fixed.word, errors: fixed.errors, erasures: 0 };
  }

  /** Recover values at known-bad positions by solving S_j = sum_i Y_i X_i^j. */
  private solveErasures(cw: Uint8Array, synd: Uint8Array, erased: number[]): Uint8Array | null {
    const n = cw.length;
    const e = erased.length;
    const xs = erased.map((idx) => GF_EXP[(n - 1 - idx) % 255]!);
    // Augmented system [A | S] with A[j][i] = X_i^j.
    const a: number[][] = [];
    for (let j = 0; j < e; j++) a.push(new Array<number>(e + 1).fill(0));
    for (let j = 0; j < e; j++) {
      for (let i = 0; i < e; i++) {
        a[j]![i] = GF_EXP[((j * GF_LOG[xs[i]!]!) % 255 + 255) % 255]!;
      }
      a[j]![e] = synd[j]!;
    }

    // Gauss-Jordan with row swaps.
    for (let col = 0; col < e; col++) {
      let piv = -1;
      for (let r = col; r < e; r++) if (a[r]![col] !== 0) { piv = r; break; }
      if (piv < 0) return null;
      if (piv !== col) { const t = a[col]; a[col] = a[piv]!; a[piv] = t!; }
      const inv = gfDiv(1, a[col]![col]!);
      for (let c = col; c <= e; c++) a[col]![c] = gfMul(a[col]![c]!, inv);
      for (let r = 0; r < e; r++) {
        if (r === col || a[r]![col] === 0) continue;
        const f = a[r]![col]!;
        for (let c = col; c <= e; c++) a[r]![c] ^= gfMul(f, a[col]![c]!);
      }
    }
    // The solved unknowns are error magnitudes: the codeword is the received word
    // XOR the error pattern (in GF(2^m) subtraction and addition are both XOR).
    const fixed = Uint8Array.from(cw);
    for (let i = 0; i < e; i++) fixed[erased[i]!] ^= a[i]![e]!;
    return this.isClean(fixed) ? fixed : null;
  }

  /** Berlekamp-Massey + Chien + Forney, error-only. */
  private decodeErrors(cw: Uint8Array, synd: Uint8Array, p: number, n: number): { word: Uint8Array; errors: number } | null {
    const lMax = Math.floor(p / 2);
    const lambda = berlekampMassey(synd, lMax);
    if (!lambda) return null;
    const deg = lambda.length - 1;
    if (deg === 0) return null;

    // Omega(x) = S(x)*lambda(x) mod x^p, ascending degrees.
    const omega = new Uint8Array(p);
    for (let d = 0; d < p; d++) {
      let acc = 0;
      for (let i = 0; i <= d && i < lambda.length; i++) acc ^= gfMul(synd[d - i]!, lambda[i]!);
      omega[d] = acc;
    }

    const positions: number[] = [];
    for (let idx = 0; idx < n; idx++) {
      const xInv = GF_EXP[(255 - ((n - 1 - idx) % 255)) % 255]!;
      let acc = 0;
      let xp = 1;
      for (let i = 0; i < lambda.length; i++) {
        acc ^= gfMul(lambda[i]!, xp);
        xp = gfMul(xp, xInv);
      }
      if (acc === 0) positions.push(idx);
    }
    if (positions.length !== deg) return null;

    const fixed = Uint8Array.from(cw);
    for (const idx of positions) {
      const xExp = (n - 1 - idx) % 255;
      const X = GF_EXP[xExp]!;
      const xInv = GF_EXP[(255 - xExp) % 255]!;
      const pow = new Uint8Array(lambda.length + 1);
      pow[0] = 1;
      for (let i = 1; i <= lambda.length; i++) pow[i] = gfMul(pow[i - 1]!, xInv);

      let dEval = 0;
      for (let i = 1; i < lambda.length; i += 2) dEval ^= gfMul(lambda[i]!, pow[i - 1]!);
      if (dEval === 0) return null;
      let oEval = 0;
      for (let i = 0; i < omega.length; i++) oEval ^= gfMul(omega[i]!, pow[i]!);

      // Forney with fcr = 0: magnitude = X * Omega(X^-1) / Lambda'(X^-1)
      fixed[idx] ^= gfMul(X, gfDiv(oEval, dEval));
    }
    if (!this.isClean(fixed)) return null;
    return { word: fixed, errors: deg };
  }
}

/**
 * Berlekamp-Massey LFSR synthesis. Returns the locator polynomial in ascending
 * degree order, or null when the syndrome sequence needs more than `lMax` taps.
 */
function berlekampMassey(s: Uint8Array, lMax: number): Uint8Array | null {
  let C = new Uint8Array([1]);
  let B = new Uint8Array([1]);
  let L = 0;
  let m = 1;
  let b = 1;

  for (let n = 0; n < s.length; n++) {
    let d = s[n]!;
    for (let i = 1; i <= L; i++) d ^= gfMul(i < C.length ? C[i]! : 0, n - i >= 0 ? s[n - i]! : 0);
    if (d === 0) {
      m++;
      continue;
    }
    const T = C.slice();
    const coef = gfDiv(d, b);
    if (C.length < B.length + m) {
      const grown = new Uint8Array(B.length + m);
      grown.set(C);
      C = grown;
    }
    for (let i = 0; i < B.length; i++) C[i + m] ^= gfMul(coef, B[i]!);
    if (2 * L <= n) {
      L = n + 1 - L;
      if (L > lMax) return null;
      B = T;
      b = d;
      m = 1;
    } else {
      m++;
    }
  }
  let end = C.length;
  while (end > 1 && C[end - 1] === 0) end--;
  if (end - 1 > lMax || end - 1 === 0) return null;
  return C.slice(0, end);
}

export function rsEncode(data: Uint8Array, parity: number): Uint8Array {
  return new RsCodec(parity).encode(data);
}

export function rsDecode(codeword: Uint8Array, parity: number, erasures?: number[]): DecodeResult {
  return new RsCodec(parity).decode(codeword, erasures);
}
