/**
 * GF(2^8) with the 0x11d primitive polynomial, alpha = 2.
 * Tables are built once at module load; every operation is O(1).
 */

const PRIMITIVE = 0x11d;

export const GF_EXP = new Uint8Array(512);
export const GF_LOG = new Uint8Array(256);

(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= PRIMITIVE;
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

export function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

export function gfDiv(a: number, b: number): number {
  if (b === 0) throw new Error('gfDiv: division by zero');
  if (a === 0) return 0;
  return GF_EXP[GF_LOG[a] + 255 - GF_LOG[b]];
}

export function gfInv(a: number): number {
  if (a === 0) throw new Error('gfInv: zero has no inverse');
  return GF_EXP[255 - GF_LOG[a]];
}

/** alpha^e for any integer e, positive or negative. */
export function gfAlpha(e: number): number {
  return GF_EXP[((e % 255) + 255) % 255];
}

export function gfPow(a: number, n: number): number {
  if (a === 0) return 0;
  if (n === 0) return 1;
  if (n < 0) return gfPow(gfInv(a), -n);
  let log = (GF_LOG[a] * n) % 255;
  if (log < 0) log += 255;
  return GF_EXP[log];
}
