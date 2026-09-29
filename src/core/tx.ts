/**
 * Transmitter: symbols -> samples.
 *
 * The whole waveform is rendered offline into a Float32Array, which is what lets one
 * code path serve the speaker, the software loopback, the WAV export and the test
 * suite. Phase is continuous across keying (so there are no clicks and no splatter
 * that would eat the neighbouring tones), and optional "soft" shaping eases the
 * instantaneous frequency between tones with a raised-cosine.
 */

import type { Plan } from './types.ts';
import { buildFrameSymbols } from './frame.ts';
import type { FrameHeader } from './types.ts';

export interface SynthOptions {
  gain?: number;
  /** Extra leading silence in samples (channel settle time). */
  leadSamples?: number;
}

const TAU = Math.PI * 2;

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

export function synthesizeSymbols(plan: Plan, symbols: Uint8Array, opts: SynthOptions = {}): Float32Array {
  const sr = plan.sr;
  const gain = Math.min(1, Math.max(0.001, opts.gain ?? plan.txGain));
  const lead = opts.leadSamples ?? plan.leadSamples;
  const tail = plan.tailSamples;
  const L = plan.L;
  const n = symbols.length;
  const out = new Float32Array(lead + n * L + tail);
  const shape = plan.shaping === 'soft' ? Math.min(0.22, Math.max(0.04, 0.12)) : 0;
  const ramp = Math.min(plan.rampSamples, Math.floor((n * L) / 3));

  let phase = 0;
  let prevF = plan.tones[0]!;
  let at = lead;
  for (let s = 0; s < n; s++) {
    const f = plan.tones[symbols[s]! % plan.mfsk]!;
    for (let i = 0; i < L; i++, at++) {
      let fc = f;
      if (shape > 0) {
        const t = i / L;
        if (t < shape) fc = prevF + (f - prevF) * smoothstep(t / shape);
      }
      let v = Math.sin(phase);
      phase += (TAU * fc) / sr;
      if (phase > TAU * 1024) phase -= TAU * 1024;
      out[at] = v;
    }
    prevF = f;
  }

  // Raised-cosine entry / exit, and a hard clamp so nothing can exceed full scale.
  const end = lead + n * L;
  for (let i = 0; i < ramp; i++) {
    const g = 0.5 - 0.5 * Math.cos((Math.PI * i) / ramp);
    out[lead + i] *= g;
    out[end - 1 - i] *= g;
  }
  for (let i = lead; i < end; i++) {
    const v = out[i]! * gain;
    out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
  }
  return out;
}

export interface RenderedFrame {
  wave: Float32Array;
  symbols: Uint8Array;
  durationMs: number;
  /** Airtime spent by FEC + header + preamble, as a fraction of the total. */
  overhead: number;
}

/** Pack a payload into a frame and render the audio for it. */
export function renderFrame(
  plan: Plan,
  body: Uint8Array,
  partial: Partial<FrameHeader> & { flags: number },
  opts: SynthOptions = {},
): RenderedFrame {
  const header: FrameHeader = {
    version: 1,
    flags: partial.flags,
    sender: partial.sender ?? 0,
    target: partial.target ?? 0xff,
    msgId: partial.msgId ?? 0,
    chunkIdx: partial.chunkIdx ?? 0,
    chunkCount: partial.chunkCount ?? 1,
    bodyLen: body.length,
  };
  const symbols = buildFrameSymbols(plan, header, body);
  const wave = synthesizeSymbols(plan, symbols, opts);
  const usedBits = body.length * 8;
  const totalBits = Math.max(1, symbols.length * plan.bitsPerSymbol);
  return {
    wave,
    symbols,
    durationMs: (wave.length / plan.sr) * 1000,
    overhead: 1 - usedBits / totalBits,
  };
}
