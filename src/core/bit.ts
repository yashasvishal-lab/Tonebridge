/**
 * Bit/byte helpers, checksums and the run-length scrambler.
 */

const CRC16_TABLE = (() => {
  const t = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? (c << 1) ^ 0x1021 : c << 1;
    t[i] = c & 0xffff;
  }
  return t;
})();

/** CRC-16/CCITT-FALSE. */
export function crc16(data: Uint8Array, init = 0xffff): number {
  let c = init;
  for (let i = 0; i < data.length; i++) c = ((c << 8) ^ CRC16_TABLE[((c >>> 8) ^ data[i]!) & 0xff]!) & 0xffff;
  return c;
}

const CRC32_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

export function crc32(data: Uint8Array, init = 0): number {
  let c = ~init >>> 0;
  for (let i = 0; i < data.length; i++) c = CRC32_TABLE[(c ^ data[i]!) & 0xff]! ^ (c >>> 8);
  return (~c >>> 0) >>> 0;
}

export function writeU16BE(out: Uint8Array, at: number, v: number): void {
  out[at] = (v >>> 8) & 0xff;
  out[at + 1] = v & 0xff;
}

export function readU16BE(src: Uint8Array, at: number): number {
  return ((src[at]! << 8) | src[at + 1]!) >>> 0;
}

export function writeU32BE(out: Uint8Array, at: number, v: number): void {
  out[at] = (v >>> 24) & 0xff;
  out[at + 1] = (v >>> 16) & 0xff;
  out[at + 2] = (v >>> 8) & 0xff;
  out[at + 3] = v & 0xff;
}

export function readU32BE(src: Uint8Array, at: number): number {
  return (src[at]! * 0x1000000 + ((src[at + 1]! << 16) | (src[at + 2]! << 8) | src[at + 3]!)) >>> 0;
}

/** MSB-first byte -> bit expansion. */
export function bytesToBits(bytes: Uint8Array, out?: Uint8Array): Uint8Array {
  const outLen = out ? out.length : bytes.length * 8;
  const bits = out ?? new Uint8Array(outLen);
  for (let i = 0; i < bytes.length && i * 8 < outLen; i++) {
    const b = bytes[i]!;
    for (let k = 0; k < 8; k++) bits[i * 8 + k] = (b >>> (7 - k)) & 1;
  }
  return bits;
}

export function bitsToBytes(bits: Uint8Array, out?: Uint8Array): Uint8Array {
  const outLen = out ? out.length : Math.ceil(bits.length / 8);
  const bytes = out ?? new Uint8Array(outLen);
  bytes.fill(0);
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]! & 1) bytes[i >> 3]! |= 1 << (7 - (i & 7));
  }
  return bytes;
}

/**
 * Additive (synchronous) bit scrambler: Galois LFSR, x^16 + x^14 + x^13 + x^11 + 1.
 *
 * Input is an array of 0/1 values. The state advances once per bit no matter what
 * the data is, so the receiver stays locked even when symbols are corrupted. It
 * removes the long runs of one tone that would starve the AGC and weaken frame sync.
 */
const LFSR_MASK = 0xb400;

export function scrambleBits(bits: Uint8Array, seed: number): Uint8Array {
  const out = new Uint8Array(bits.length);
  let state = (seed ^ 0xace5) & 0xffff;
  if (state === 0) state = 0x1357;
  for (let i = 0; i < bits.length; i++) {
    const lsb = state & 1;
    state >>= 1;
    if (lsb) state ^= LFSR_MASK;
    out[i] = (bits[i]! ^ lsb) & 1;
  }
  return out;
}

/** Scrambling is its own inverse, and neither call touches the caller's buffer. */
export const descrambleBits = scrambleBits;

export function seedFor(tag: number, ...values: number[]): number {
  let h = tag & 0xffff;
  for (const v of values) h = ((h * 31 + (v & 0xffff)) ^ (h >>> 7)) & 0xffff;
  return h === 0 ? 0x5eed : h;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function ascii(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}
