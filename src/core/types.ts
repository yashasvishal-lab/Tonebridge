/**
 * Tonebridge core types.
 *
 * Everything in `src/core` is deliberately free of DOM, React and Node APIs so
 * that the exact same DSP/codec code runs in the browser, in the CLI tool and in
 * the unit tests. If it works in a test, it works on air.
 */

export type Shaping = 'hard' | 'soft';

/** A user-selectable over-the-air configuration. */
export interface Profile {
  id: string;
  name: string;
  blurb: string;
  /** Nominal tone centres in Hz (they get snapped to exact DFT bins per device). */
  tones: number[];
  /** Nominal symbol period in ms. */
  symMs: number;
  /** Timing candidates per symbol (search resolution). */
  subDiv: number;
  /** Reed-Solomon parity bytes for the fixed-size header. */
  headerParity: number;
  /** Reed-Solomon parity bytes appended to every frame body. */
  bodyParity: number;
  /** Largest body (payload) in bytes. */
  maxBody: number;
  /** Default transmit gain 0..1. */
  txGain: number;
  rampMs: number;
  /** Preamble length in symbols (sync + AGC training). */
  preambleLen: number;
  /** Quiet gap between the preamble and the header, in symbols. */
  padSyms: number;
  shaping: Shaping;
  /** Suggested per-chunk payload for file/message transfers, in bytes. */
  chunkSize: number;
  /** Human note about the band, surfaced in the UI. */
  band: string;
}

/** A profile resolved against a concrete device sample rate. */
export interface Plan {
  profileId: string;
  sr: number;
  /** Tone frequencies snapped to exact DFT bins for this sample rate. */
  tones: number[];
  /** Samples per symbol. */
  L: number;
  /** Realised symbol period in ms (after rounding L). */
  symMs: number;
  /** Samples between timing candidates. */
  subStep: number;
  mfsk: number;
  bitsPerSymbol: number;
  /** Gross over-the-air bit rate. */
  bitRate: number;
  preamble: Uint8Array;
  padSyms: number;
  /** Preamble + guard, in symbols: where the header field starts. */
  preSyms: number;
  headerBytes: number;
  headerParity: number;
  bodyParity: number;
  rampSamples: number;
  leadSamples: number;
  tailSamples: number;
  shaping: Shaping;
  profileTag: number;
  txGain: number;
  /** Highest tone / Nyquist - used to warn about hardware that cannot play it. */
  nyquistRatio: number;
  /** Airtime of the largest legal frame, ms. Bounded by the receive window. */
  maxFrameMs: number;
  /** Body bytes a transport chunk should use, leaving room for the envelope. */
  chunkBody: number;
  /** Largest body that still fits one frame, after any airtime clamp. */
  maxBody: number;
}

export interface RxStats {
  /** Signal-to-noise ratio over the frame, dB. */
  snrDb: number;
  /** Mean per-symbol discrimination ratio (chosen tone vs all others). */
  meanConf: number;
  /** Worst per-symbol discrimination ratio in the frame. */
  minConf: number;
  /** Reed-Solomon symbol errors corrected. */
  corrected: number;
  /** Reed-Solomon erasures used (confidence-driven). */
  erasures: number;
  /** Total symbols in the frame. */
  symbols: number;
  /** Residual carrier/timing error, parts per million. */
  timingPpm: number;
  /** Absolute receive level, dBFS (mean-square of the frame window). */
  levelDb: number;
  /** Sample index where the frame started, when known. */
  startSample: number;
  /** Wall clock of first sample in the frame, ms since epoch. */
  clockMs: number;
}

export interface FrameHeader {
  version: number;
  flags: number;
  sender: number;
  target: number;
  msgId: number;
  chunkIdx: number;
  chunkCount: number;
  bodyLen: number;
}

/** Flag bits, see docs/PROTOCOL.md */
export const FLAGS = {
  ENCRYPTED: 0x01,
  WANTS_ACK: 0x02,
  FILE: 0x04,
  MANIFEST: 0x08,
  ACK: 0x10,
  NACK: 0x20,
  CTRL: 0x40,
  BEACON: 0x80,
} as const;

export const HDR = {
  VERSION: 1,
  /** Fixed size of the encoded header field, bytes. */
  BYTES: 12,
  BROADCAST: 0xff,
} as const;

export interface RxFrame {
  header: FrameHeader;
  body: Uint8Array;
  stats: RxStats;
}
