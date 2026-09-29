/**
 * TBP-1 - Tonebridge Protocol, frame 1.
 *
 *   [ preamble 31 sym ][ header 12 B + FEC ][ body payload + FEC ]
 *
 * Both fields are protected independently: a short ACK only has to survive the
 * header FEC, and a body always ends with a CRC-32 so an uncorrectable frame can
 * never be mistaken for a good one (Reed-Solomon can miscorrect, a CRC cannot be
 * fooled as easily). Between FEC and the symbol map the bytes go through a block
 * interleaver and a synchronous scrambler.
 */

import type { FrameHeader, Plan } from './types.ts';
import { HDR } from './types.ts';
import { bitsToBytes, bytesToBits, crc16, crc32, readU16BE, readU32BE, scrambleBits, seedFor, writeU16BE, writeU32BE } from './bit.ts';
import { RsCodec, type DecodeResult } from './rs.ts';
import { erasurePositions, interleave, interleaveMap, symbolsForBytes } from './interleave.ts';

export const IL_COLS = 12;
/** Symbols below this discrimination ratio are handed to FEC as erasures. */
export const ERASURE_REL = 2.2;
/** A frame is only offered to FEC if at least this fraction of its symbols look clean. */
export const MIN_FRAME_CONF = 1.35;

export function packHeader(plan: Plan, h: FrameHeader): Uint8Array {
  const b = new Uint8Array(HDR.BYTES);
  b[0] = HDR.VERSION;
  b[1] = h.flags & 0xff;
  b[2] = plan.profileTag & 0xff;
  b[3] = h.sender & 0xff;
  b[4] = h.target & 0xff;
  b[5] = h.msgId & 0xff;
  b[6] = h.chunkIdx & 0xff;
  b[7] = h.chunkCount & 0xff;
  writeU16BE(b, 8, h.bodyLen & 0xffff);
  writeU16BE(b, 10, crc16(b.subarray(0, 10)));
  return b;
}

export function unpackHeader(b: Uint8Array, plan: Plan | null): FrameHeader | null {
  if (readU16BE(b, 10) !== crc16(b.subarray(0, 10))) return null;
  if (b[0] !== HDR.VERSION) return null;
  if (plan && (b[2]! & 0xff) !== (plan.profileTag & 0xff)) return null;
  const bodyLen = readU16BE(b, 8);
  if (plan && (bodyLen === 0 || bodyLen > plan.maxBody)) return null;
  return {
    version: b[0]!,
    flags: b[1]!,
    sender: b[3]!,
    target: b[4]!,
    msgId: b[5]!,
    chunkIdx: b[6]!,
    chunkCount: b[7]!,
    bodyLen,
  };
}

/** Worst-first byte positions, capped at the parity a decode can spend on them. */
function rankErasures(
  weak: number[],
  relSlice: Float32Array,
  nSym: number,
  bitsPerSymbol: number,
  cwLen: number,
  fwd: Int32Array,
  parity: number,
): number[] {
  void nSym;
  const badness = new Float32Array(cwLen).fill(Infinity);
  for (const s of weak) {
    const firstBit = s * bitsPerSymbol;
    for (let b = firstBit; b < firstBit + bitsPerSymbol; b++) {
      const q = b >> 3;
      if (q < cwLen) badness[fwd[q]!] = Math.min(badness[fwd[q]!]!, relSlice[s]!);
    }
  }
  const out: number[] = [];
  for (let i = 0; i < cwLen; i++) if (badness[i]! < Infinity) out.push(i);
  out.sort((a, b) => badness[a]! - badness[b]!);
  return out.slice(0, parity);
}

/** How many erasures to declare, most aggressive first but always trying "none". */
function erasureSweep(available: number): number[] {
  if (available === 0) return [0];
  const out = [available];
  for (let k = Math.floor(available / 2); k >= 1; k = Math.floor(k / 2)) out.push(k);
  out.push(0);
  return out;
}

export function headerCodewordLength(plan: Plan): number {
  return plan.headerBytes + plan.headerParity;
}

export function bodyCodewordLength(plan: Plan, bodyLen: number): number {
  return bodyLen + 4 + plan.bodyParity;
}

function bitsToSymbols(bits: Uint8Array, bps: number, pad: number): Uint8Array {
  const nSym = Math.ceil(bits.length / bps);
  const out = new Uint8Array(nSym);
  for (let s = 0; s < nSym; s++) {
    let v = 0;
    for (let k = 0; k < bps; k++) {
      const idx = s * bps + k;
      v = (v << 1) | (idx < bits.length ? bits[idx]! & 1 : pad & 1);
    }
    out[s] = v;
  }
  return out;
}

function symbolsToBits(sym: Uint8Array, bps: number): Uint8Array {
  const out = new Uint8Array(sym.length * bps);
  for (let s = 0; s < sym.length; s++) {
    const v = sym[s]!;
    for (let k = 0; k < bps; k++) out[s * bps + k] = (v >>> (bps - 1 - k)) & 1;
  }
  return out;
}

/** Symbols for the fixed-size header (excluding preamble). */
export function encodeHeaderSymbols(plan: Plan, h: FrameHeader): Uint8Array {
  const rs = new RsCodec(plan.headerParity);
  const cw = rs.encode(packHeader(plan, h));
  const il = interleave(cw, IL_COLS);
  const bits = scrambleBits(bytesToBits(il), seedFor(plan.profileTag, 0x51));
  return bitsToSymbols(bits, plan.bitsPerSymbol, 0);
}

/** Symbols for the frame body (payload gets a CRC-32, then FEC, then interleaving). */
export function encodeBodySymbols(plan: Plan, h: FrameHeader, payload: Uint8Array): Uint8Array {
  const data = new Uint8Array(payload.length + 4);
  writeU32BE(data, 0, crc32(payload));
  data.set(payload, 4);
  const rs = new RsCodec(plan.bodyParity);
  const cw = rs.encode(data);
  const il = interleave(cw, IL_COLS);
  const bits = scrambleBits(bytesToBits(il), seedFor(plan.profileTag, h.msgId, h.chunkIdx));
  return bitsToSymbols(bits, plan.bitsPerSymbol, 0);
}

export interface HeaderDecode {
  header: FrameHeader;
  meanRel: number;
  corrected: number;
}

/**
 * @param symIdx winning tone per symbol, starting at the first header symbol
 * @param symRel discrimination ratio per symbol (same length or longer)
 */
export function decodeHeader(plan: Plan, symIdx: Uint8Array, symRel: Float32Array): HeaderDecode | null {
  const cwLen = headerCodewordLength(plan);
  const nSym = symbolsForBytes(cwLen, plan.bitsPerSymbol);
  if (symIdx.length < nSym) return null;
  const slice = symIdx.subarray(0, nSym);
  const relSlice = symRel.subarray(0, nSym);

  let sum = 0;
  const weak: number[] = [];
  for (let i = 0; i < nSym; i++) {
    sum += relSlice[i]!;
    if (relSlice[i]! < ERASURE_REL) weak.push(i);
  }
  const meanRel = sum / nSym;

  const bits = scrambleBits(symbolsToBits(slice, plan.bitsPerSymbol), seedFor(plan.profileTag, 0x51));
  const il = bitsToBytes(bits, new Uint8Array(cwLen));
  const fwd = interleaveMap(cwLen, IL_COLS);
  const cw = new Uint8Array(cwLen);
  for (let j = 0; j < cwLen; j++) cw[fwd[j]!] = il[j]!;

  const rs = new RsCodec(plan.headerParity);
  const ranked = rankErasures(weak, relSlice, nSym, plan.bitsPerSymbol, cwLen, fwd, plan.headerParity);
  // Marking a byte as an erasure costs FEC half as much as marking it as an unknown
  // error, but a *wrong* erasure mark wastes capacity. So sweep how many of the worst
  // bytes to declare and take the first attempt that produces a valid codeword.
  let res: DecodeResult | null = null;
  for (const k of erasureSweep(ranked.length)) {
    const attempt = rs.decode(cw, k ? ranked.slice(0, k) : undefined);
    if (attempt.ok) {
      res = attempt;
      break;
    }
  }
  if (!res) return null;
  const header = unpackHeader(res.codeword.subarray(0, plan.headerBytes), plan);
  if (!header) return null;
  return { header, meanRel, corrected: res.errors + res.erasures };
}

export interface BodyDecode {
  payload: Uint8Array;
  corrected: number;
  erasures: number;
}

export function decodeBody(plan: Plan, h: FrameHeader, symIdx: Uint8Array, symRel: Float32Array): BodyDecode | null {
  const cwLen = bodyCodewordLength(plan, h.bodyLen);
  const nSym = symbolsForBytes(cwLen, plan.bitsPerSymbol);
  if (symIdx.length < nSym) return null;
  const slice = symIdx.subarray(0, nSym);
  const relSlice = symRel.subarray(0, nSym);

  const weak: number[] = [];
  for (let i = 0; i < nSym; i++) if (relSlice[i]! < ERASURE_REL) weak.push(i);

  const bits = scrambleBits(symbolsToBits(slice, plan.bitsPerSymbol), seedFor(plan.profileTag, h.msgId, h.chunkIdx));
  const il = bitsToBytes(bits, new Uint8Array(cwLen));
  const fwd = interleaveMap(cwLen, IL_COLS);
  const cw = new Uint8Array(cwLen);
  for (let j = 0; j < cwLen; j++) cw[fwd[j]!] = il[j]!;

  const erasureSyms = erasurePositions(weak, plan.bitsPerSymbol, cwLen, IL_COLS, fwd);
  // Rank the candidate erasures by how bad their symbols looked, then cap at parity.
  const badness = new Float32Array(cwLen).fill(Infinity);
  for (let i = 0; i < nSym; i++) {
    if (relSlice[i]! >= ERASURE_REL) continue;
    const firstBit = i * plan.bitsPerSymbol;
    for (let b = firstBit; b < firstBit + plan.bitsPerSymbol; b++) {
      const q = b >> 3;
      if (q < cwLen) badness[fwd[q]!] = Math.min(badness[fwd[q]!]!, relSlice[i]!);
    }
  }
  const ranked = erasureSyms
    .filter((p) => p < cwLen)
    .sort((a, b) => badness[a]! - badness[b]!)
    .slice(0, plan.bodyParity);

  const rs = new RsCodec(plan.bodyParity);
  const res = rs.decode(cw, ranked.length ? ranked : undefined);
  if (!res.ok) return null;
  const data = res.codeword.subarray(0, cwLen - plan.bodyParity);
  const expected = readU32BE(data, 0);
  const payload = data.subarray(4);
  if (crc32(payload) !== expected) return null;
  return { payload, corrected: res.errors + res.erasures, erasures: res.erasures };
}

/** Full symbol stream for a frame, preamble included (used by TX, the CLI and tests). */
export function buildFrameSymbols(plan: Plan, h: FrameHeader, payload: Uint8Array): Uint8Array {
  const head = encodeHeaderSymbols(plan, h);
  const body = encodeBodySymbols(plan, h, payload);
  const pre = plan.preamble.length;
  const out = new Uint8Array(pre + plan.padSyms + head.length + body.length);
  out.set(plan.preamble, 0);
  // The guard repeats the last preamble chip, which lets the room's response to the
  // preamble die down before the first header symbol instead of landing on it.
  for (let i = 0; i < plan.padSyms; i++) out[pre + i] = plan.preamble[pre - 1]!;
  out.set(head, pre + plan.padSyms);
  out.set(body, pre + plan.padSyms + head.length);
  return out;
}

export function frameSymbolCount(plan: Plan, bodyLen: number): number {
  return (
    plan.preSyms +
    symbolsForBytes(headerCodewordLength(plan), plan.bitsPerSymbol) +
    symbolsForBytes(bodyCodewordLength(plan, bodyLen), plan.bitsPerSymbol)
  );
}
