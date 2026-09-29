/**
 * Block deinterleaver.
 *
 * A hand over the speaker or a passing truck kills a *contiguous* run of symbols,
 * which after symbol->byte mapping is a burst of adjacent bad bytes. Reed-Solomon
 * handles scattered damage well and bursts poorly, so the codeword is written into a
 * grid row by row and read back column by column.
 *
 * Both directions share one index map, which the receiver also uses to translate
 * "this symbol looks unreliable" into "this codeword byte looks unreliable".
 */

export function interleaveMap(n: number, cols: number): Int32Array {
  const fwd = new Int32Array(n);
  const clampedCols = Math.max(1, Math.min(cols, n || 1));
  const rows = Math.ceil(n / clampedCols);
  let at = 0;
  for (let c = 0; c < clampedCols; c++) {
    for (let r = 0; r < rows; r++) {
      const idx = r * clampedCols + c;
      if (idx < n) fwd[at++] = idx;
    }
  }
  return fwd;
}

export function interleave(src: Uint8Array, cols: number): Uint8Array {
  const fwd = interleaveMap(src.length, cols);
  const out = new Uint8Array(src.length);
  for (let j = 0; j < fwd.length; j++) out[j] = src[fwd[j]!]!;
  return out;
}

export function deinterleaveWith(src: Uint8Array, fwd: Int32Array): Uint8Array {
  const out = new Uint8Array(src.length);
  for (let j = 0; j < fwd.length; j++) out[fwd[j]!] = src[j]!;
  return out;
}

export function deinterleave(src: Uint8Array, cols: number): Uint8Array {
  return deinterleaveWith(src, interleaveMap(src.length, cols));
}

/** Symbol count needed for `bytes` at `bitsPerSymbol` bits per symbol. */
export function symbolsForBytes(bytes: number, bitsPerSymbol: number): number {
  return Math.ceil((bytes * 8) / bitsPerSymbol);
}

/**
 * Codeword byte positions touched by a set of unreliable symbols.
 * `fwd` maps interleaved position -> codeword position (see interleaveMap).
 */
export function erasurePositions(
  symbolIdx: number[],
  bitsPerSymbol: number,
  cwLen: number,
  cols: number,
  fwd?: Int32Array,
): number[] {
  const map = fwd ?? interleaveMap(cwLen, cols);
  const out = new Set<number>();
  for (const s of symbolIdx) {
    const firstBit = s * bitsPerSymbol;
    for (let b = firstBit; b < firstBit + bitsPerSymbol; b++) {
      const q = b >> 3;
      if (q >= map.length) continue; // padding symbol beyond the codeword
      const pos = map[q]!;
      if (pos < cwLen) out.add(pos);
    }
  }
  return [...out];
}
