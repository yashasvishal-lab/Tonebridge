import { describe, expect, it } from 'vitest';
import { GF_EXP, gfAlpha, gfDiv, gfInv, gfMul, gfPow } from '../src/core/gf256.ts';
import { RsCodec, rsDecode, rsEncode } from '../src/core/rs.ts';
import { bitsToBytes, bytesToBits, crc16, crc32, descrambleBits, readU16BE, readU32BE, scrambleBits, seedFor, writeU16BE, writeU32BE } from '../src/core/bit.ts';
import { deinterleave, deinterleaveWith, interleave, interleaveMap, symbolsForBytes } from '../src/core/interleave.ts';
import { levelDb, makeToneBank, matchScore, measureTones } from '../src/core/dsp.ts';

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const rnd = (seed: number): (() => number) => {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 4294967296;
  };
};

describe('galois field', () => {
  it('is a field: every non-zero element has an inverse', () => {
    for (let a = 1; a < 256; a++) {
      expect(gfMul(a, gfInv(a))).toBe(1);
      expect(gfDiv(gfMul(a, 7), a)).toBe(7);
    }
    expect(gfMul(0, 137)).toBe(0);
  });

  it('alpha^255 is 1 and the log table wraps', () => {
    expect(gfAlpha(255)).toBe(1);
    expect(GF_EXP[0]).toBe(1);
    for (let i = 0; i < 255; i++) expect(GF_EXP[i]).toBe(GF_EXP[i + 255]);
  });

  it('exponentiation agrees with repeated multiplication', () => {
    for (const a of [2, 3, 17, 91, 255]) {
      let acc = 1;
      for (let n = 0; n < 6; n++) {
        expect(gfPow(a, n)).toBe(acc);
        acc = gfMul(acc, a);
      }
    }
  });
});

describe('reed-solomon', () => {
  it('leaves a clean codeword with zero syndromes', () => {
    const rs = new RsCodec(16);
    const data = new Uint8Array(40).map((_, i) => i * 7);
    const cw = rs.encode(data);
    expect(cw.length).toBe(56);
    expect(rs.isClean(cw)).toBe(true);
    for (let i = 0; i < 16; i++) expect(rs.syndromes(cw)[i]).toBe(0);
    expect(cw.subarray(0, 40)).toEqual(data);
  });

  it('corrects up to half the parity as unknown errors', () => {
    for (const parity of [4, 6, 8, 16, 32]) {
      const rs = new RsCodec(parity);
      const rand = rnd(0xbeef + parity);
      const n = 48;
      const data = new Uint8Array(n).map(() => (rand() * 256) | 0);
      const cw = rs.encode(data);
      const bad = new Uint8Array(cw);
      const k = Math.floor(parity / 2);
      const spots: number[] = [];
      while (spots.length < k) {
        const at = (rand() * n) | 0;
        if (!spots.includes(at)) spots.push(at);
      }
      for (const at of spots) bad[at] ^= 1 + ((rand() * 255) | 0);
      const res = rs.decode(bad);
      expect(res.ok).toBe(true);
      expect(res.errors).toBe(k);
      let touched = 0;
      for (let i = 0; i < cw.length; i++) if (cw[i] !== bad[i]) touched++;
      expect(touched).toBe(k);
      expect(res.codeword.subarray(0, n)).toEqual(data);
    }
  });

  it('corrects a full parity budget when positions are known', () => {
    for (const parity of [8, 16, 32]) {
      const rs = new RsCodec(parity);
      const rand = rnd(0x1234 + parity);
      const n = 60;
      const data = new Uint8Array(n).map(() => (rand() * 256) | 0);
      const cw = rs.encode(data);
      const bad = new Uint8Array(cw);
      const pos: number[] = [];
      while (pos.length < parity) {
        const at = (rand() * (n + parity)) | 0;
        if (!pos.includes(at)) pos.push(at);
      }
      for (const at of pos) bad[at] ^= 0x5a;
      const res = rs.decode(bad, pos);
      expect(res.ok).toBe(true);
      expect(res.erasures).toBe(parity);
      expect(res.codeword.subarray(0, n)).toEqual(data);
      // without being told where the damage is, parity erasures cannot be fixed
      expect(rs.decode(bad).ok).toBe(false);
    }
  });

  it('refuses to hand back a codeword it cannot prove', () => {
    const rand = rnd(7);
    const rs = new RsCodec(8);
    const cw = rs.encode(new Uint8Array(32).map(() => (rand() * 256) | 0));
    const bad = new Uint8Array(cw);
    for (let i = 0; i < 20; i++) bad[(rand() * 40) | 0] ^= 1 + ((rand() * 255) | 0);
    expect(rs.decode(bad).ok).toBe(false);
  });

  it('module helpers agree with the class', () => {
    const data = enc('tonebridge');
    expect(rsEncode(data, 10)).toEqual(new RsCodec(10).encode(data));
    expect(rsDecode(rsEncode(data, 10), 10).ok).toBe(true);
  });

  it('rejects a parity it cannot promise', () => {
    expect(() => new RsCodec(1)).toThrow(RangeError);
    expect(() => new RsCodec(65)).toThrow(RangeError);
  });
});

describe('byte and bit plumbing', () => {
  it('matches the standard CRC check values', () => {
    expect(crc16(enc('123456789'))).toBe(0x29b1);
    expect(crc32(enc('123456789'))).toBe(0xcbf43926);
    expect(crc16(enc('a'))).not.toBe(crc16(enc('b')));
  });

  it('round-trips big-endian integers', () => {
    const b = new Uint8Array(6);
    writeU16BE(b, 0, 0xbeef);
    writeU32BE(b, 2, 0x0badf00d);
    expect(readU16BE(b, 0)).toBe(0xbeef);
    expect(readU32BE(b, 2)).toBe(0x0badf00d);
  });

  it('round-trips bits regardless of length', () => {
    const src = new Uint8Array(37).map((_, i) => (i * 31) & 0xff);
    const bits = bytesToBits(src);
    expect(bits.length).toBe(37 * 8);
    expect(bitsToBytes(bits)).toEqual(src);
  });

  it('scrambling is an involution and seed-sensitive', () => {
    const bits = bytesToBits(new Uint8Array(64).map((_, i) => i));
    const seed = seedFor(3, 1, 2);
    const out = scrambleBits(bits, seed);
    expect(out).not.toEqual(bits);
    expect(descrambleBits(new Uint8Array(out), seed)).toEqual(bits);
    expect(scrambleBits(bits, seed ^ 1)).not.toEqual(out);
  });

  it('interleaving is a permutation and its inverse', () => {
    for (const n of [12, 40, 97]) {
      const fwd = interleaveMap(n, 12);
      expect(new Set(fwd).size).toBe(n);
      const src = new Uint8Array(n).map((_, i) => i);
      expect(deinterleaveWith(interleave(src, 12), fwd)).toEqual(src);
      expect(deinterleave(interleave(src, 12), 12)).toEqual(src);
    }
    expect(symbolsForBytes(24, 2)).toBe(96);
    expect(symbolsForBytes(24, 3)).toBe(64);
  });
});

describe('tone measurement', () => {
  it('finds the right tone at an exact bin', () => {
    const sr = 48000;
    const L = 480;
    const tones = [1400, 1700, 2000, 2300];
    const bank = makeToneBank(sr, L, tones);
    expect(bank.tones.length).toBe(4);
    const samples = new Float32Array(L);
    const f = (tones[2]! * L) / sr;
    for (let i = 0; i < L; i++) samples[i] = Math.sin((2 * Math.PI * f * i) / L);
    const out = new Float32Array(tones.length);
    expect(measureTones(bank, samples, 0, out)).toBe(true);
    let best = 0;
    for (let i = 1; i < out.length; i++) if (out[i]! > out[best]!) best = i;
    expect(best).toBe(2);
    expect(out[2]!).toBeGreaterThan(out[0]! * 50);
  });

  it('reports level and pattern matching the way the receiver expects', () => {
    const loud = new Float32Array(256).fill(0.5);
    expect(levelDb(loud, 0, loud.length)).toBeCloseTo(-6.02, 1);
    const pattern = new Uint8Array([0, 1, 1, 0]);
    const idx = new Uint8Array([3, 0, 1, 1, 0, 3]);
    expect(matchScore(idx, 1, 1, pattern, 3)).toBeGreaterThan(matchScore(idx, 1, 1, new Uint8Array([3, 3, 3, 3]), 3));
  });
});
