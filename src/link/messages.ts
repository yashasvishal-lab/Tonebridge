/**
 * Message layer: the small typed envelopes that ride inside a frame body.
 *
 * Addressing, sequencing and chunk indices live in the FEC-protected frame header,
 * so these payloads only carry what the header has no room for.
 */

import { crc32, readU16BE, readU32BE, writeU16BE, writeU32BE } from '../core/bit.ts';

export const KIND = {
  TEXT: 1,
  MANIFEST: 2,
  CHUNK: 3,
  ACK: 4,
  NACK: 5,
  CTRL: 6,
} as const;

export type Kind = (typeof KIND)[keyof typeof KIND];

export const CTRL = {
  HELLO: 1,
  BYE: 2,
  PAIR_COMMIT: 3,
  PAIR_CHALLENGE: 4,
  PAIR_REVEAL: 5,
  PING: 6,
  PONG: 7,
} as const;

export interface TextEnvelope {
  kind: typeof KIND.TEXT;
  text: string;
}
export interface ManifestEnvelope {
  kind: typeof KIND.MANIFEST;
  name: string;
  mime: string;
  size: number;
  chunks: number;
  chunkSize: number;
  sha256: Uint8Array;
}
export interface ChunkEnvelope {
  kind: typeof KIND.CHUNK;
  index: number;
  data: Uint8Array;
}
export interface AckEnvelope {
  kind: typeof KIND.ACK | typeof KIND.NACK;
  msgId: number;
  chunkIdx: number;
}
export interface CtrlEnvelope {
  kind: typeof KIND.CTRL;
  sub: number;
  data: Uint8Array;
}
export type Envelope = TextEnvelope | ManifestEnvelope | ChunkEnvelope | AckEnvelope | CtrlEnvelope;

export function packText(text: string): Uint8Array {
  const body = new TextEncoder().encode(text);
  const out = new Uint8Array(3 + body.length);
  out[0] = KIND.TEXT;
  writeU16BE(out, 1, Math.min(0xffff, body.length));
  out.set(body.subarray(0, 0xffff), 3);
  return out;
}

export function packManifest(m: { name: string; mime: string; size: number; chunks: number; chunkSize: number; sha256: Uint8Array }): Uint8Array {
  const name = new TextEncoder().encode(m.name).subarray(0, 255);
  const mime = new TextEncoder().encode(m.mime).subarray(0, 255);
  const out = new Uint8Array(1 + 1 + name.length + 1 + mime.length + 4 + 2 + 2 + 32);
  let at = 0;
  out[at++] = KIND.MANIFEST;
  out[at++] = name.length;
  out.set(name, at);
  at += name.length;
  out[at++] = mime.length;
  out.set(mime, at);
  at += mime.length;
  writeU32BE(out, at, m.size);
  at += 4;
  writeU16BE(out, at, m.chunks);
  at += 2;
  writeU16BE(out, at, m.chunkSize);
  at += 2;
  const hash = new Uint8Array(32);
  hash.set(m.sha256.subarray(0, 32), 0);
  out.set(hash, at);
  return out;
}

export function packChunk(index: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(3 + data.length);
  out[0] = KIND.CHUNK;
  writeU16BE(out, 1, index & 0xffff);
  out.set(data, 3);
  return out;
}

export function packAck(kind: typeof KIND.ACK | typeof KIND.NACK, msgId: number, chunkIdx: number): Uint8Array {
  const out = new Uint8Array(5);
  out[0] = kind;
  out[1] = msgId & 0xff;
  writeU16BE(out, 2, chunkIdx & 0xffff);
  return out;
}

export function packCtrl(sub: number, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + data.length);
  out[0] = KIND.CTRL;
  out[1] = sub & 0xff;
  out.set(data, 2);
  return out;
}

export function packPing(token: number): Uint8Array {
  const data = new Uint8Array(4);
  writeU32BE(data, 0, token >>> 0);
  return packCtrl(CTRL.PING, data);
}

export function packPong(token: number): Uint8Array {
  const data = new Uint8Array(4);
  writeU32BE(data, 0, token >>> 0);
  return packCtrl(CTRL.PONG, data);
}

export { readU32BE };

export function unpack(body: Uint8Array): Envelope | null {
  if (body.length < 1) return null;
  const kind = body[0]!;
  try {
    switch (kind) {
      case KIND.TEXT: {
        if (body.length < 3) return null;
        const len = readU16BE(body, 1);
        return { kind: KIND.TEXT, text: new TextDecoder().decode(body.subarray(3, 3 + len)) };
      }
      case KIND.MANIFEST: {
        let at = 1;
        const nameLen = body[at++]!;
        const name = new TextDecoder().decode(body.subarray(at, at + nameLen));
        at += nameLen;
        const mimeLen = body[at++]!;
        const mime = new TextDecoder().decode(body.subarray(at, at + mimeLen));
        at += mimeLen;
        const size = readU32BE(body, at);
        at += 4;
        const chunks = readU16BE(body, at);
        at += 2;
        const chunkSize = readU16BE(body, at);
        at += 2;
        const sha256 = body.slice(at, at + 32);
        return { kind: KIND.MANIFEST, name, mime, size, chunks, chunkSize, sha256 };
      }
      case KIND.CHUNK: {
        if (body.length < 3) return null;
        return { kind: KIND.CHUNK, index: readU16BE(body, 1), data: body.slice(3) };
      }
      case KIND.ACK:
      case KIND.NACK: {
        if (body.length < 5) return null;
        return { kind, msgId: body[1]!, chunkIdx: readU16BE(body, 2) };
      }
      case KIND.CTRL: {
        if (body.length < 2) return null;
        return { kind: KIND.CTRL, sub: body[1]!, data: body.slice(2) };
      }
      default:
        return null;
    }
  } catch {
    return null;
  }
}

export function checksumOf(bytes: Uint8Array): number {
  return crc32(bytes);
}

/** Split a file for transport. Chunk size is a multiple of nothing special; FEC adds its own parity. */
export function chunkBytes(data: Uint8Array, chunkSize: number): Uint8Array[] {
  const size = Math.max(8, Math.min(chunkSize, 0xffff));
  const out: Uint8Array[] = [];
  for (let i = 0; i < data.length; i += size) out.push(data.subarray(i, Math.min(data.length, i + size)));
  if (!out.length) out.push(new Uint8Array(0));
  return out;
}
