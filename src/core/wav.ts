/**
 * WAV I/O, so a message can leave a machine on a file instead of through the air.
 * Handy for air-gapped rooms, for archiving a transmission, and for playing a
 * recorded transmission back through the receiver to prove the link is reproducible.
 */

export interface WavData {
  samples: Float32Array;
  sampleRate: number;
  channels: number;
}

export function encodeWav(samples: Float32Array, sampleRate: number, float = false): Uint8Array {
  const channels = 1;
  const bits = float ? 32 : 16;
  const blockAlign = (channels * bits) / 8;
  const dataSize = samples.length * blockAlign;
  const buf = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buf);
  const str = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, float ? 3 : 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  str(36, 'data');
  view.setUint32(40, dataSize, true);
  if (float) {
    for (let i = 0; i < samples.length; i++) view.setFloat32(44 + i * 4, samples[i]!, true);
  } else {
    for (let i = 0; i < samples.length; i++) {
      const v = Math.max(-1, Math.min(1, samples[i]!));
      // Same grid as the decoder (divide by 32768), so quantisation is a symmetric
      // half-LSB error instead of a one-LSB bias near full scale.
      view.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(v * 32768))), true);
    }
  }
  return new Uint8Array(buf);
}

export function decodeWav(bytes: Uint8Array): WavData {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const str = (at: number) => String.fromCharCode(view.getUint8(at), view.getUint8(at + 1), view.getUint8(at + 2), view.getUint8(at + 3));
  if (str(0) !== 'RIFF' || str(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let at = 12;
  let format = 1;
  let channels = 1;
  let sampleRate = 48000;
  let bits = 16;
  let dataAt = -1;
  let dataLen = 0;
  while (at + 8 <= bytes.length) {
    const id = str(at);
    const size = view.getUint32(at + 4, true);
    if (id === 'fmt ') {
      format = view.getUint16(at + 8, true);
      channels = view.getUint16(at + 10, true);
      sampleRate = view.getUint32(at + 12, true);
      bits = view.getUint16(at + 22, true);
    } else if (id === 'data') {
      dataAt = at + 8;
      dataLen = Math.min(size, bytes.length - dataAt);
      break;
    }
    at += 8 + size + (size & 1);
  }
  if (dataAt < 0) throw new Error('WAV file has no data chunk');
  if (channels < 1) throw new Error('WAV file has no channels');
  const perSample = bits / 8;
  const frames = Math.floor(dataLen / (perSample * channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const p = dataAt + (i * channels + c) * perSample;
      let v = 0;
      if (format === 3 && bits === 32) v = view.getFloat32(p, true);
      else if (bits === 32) v = view.getInt32(p, true) / 2147483648;
      else if (bits === 24) v = ((view.getUint8(p) | (view.getUint8(p + 1) << 8) | (view.getUint8(p + 2) << 16)) << 8) / 2147483648;
      else if (bits === 16) v = view.getInt16(p, true) / 32768;
      else if (bits === 8) v = (view.getUint8(p) - 128) / 128;
      else throw new Error(`unsupported WAV sample format (bits=${bits}, format=${format})`);
      acc += v;
    }
    out[i] = acc / channels;
  }
  return { samples: out, sampleRate, channels };
}

/** Fast, statistically meaningful fingerprint used to compare two recordings. */
export function signalDelta(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  if (!n) return 1;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    const d = a[i]! - b[i]!;
    num += d * d;
    den += a[i]! * a[i]!;
  }
  return den > 0 ? Math.sqrt(num / den) : 1;
}
