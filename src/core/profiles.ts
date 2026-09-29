import type { Plan, Profile } from './types.ts';
import { crc16 } from './bit.ts';
import { HDR } from './types.ts';

/**
 * The m-sequence generator behind the frame preamble (degree 5, x^5 + x^2 + 1).
 * Its two-valued periodic autocorrelation (-1 out of 31) is what makes a false
 * lock on ordinary room noise about one in a billion per candidate slot.
 */
export function mSequence(len: number): Uint8Array {
  let r = 0x1f;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    const bit = r & 1;
    out[i] = bit;
    const fb = ((r ^ (r >> 2)) & 1) as number;
    r = (r >> 1) | (fb << 4);
  }
  return out;
}

/**
 * Seconds of audio the receiver keeps for retrospective decoding. A frame longer
 * than this cannot exist, so the largest legal payload is clamped to fit and the
 * memory a session can consume is bounded by construction.
 */
export const RX_WINDOW_SEC = 12;

/** FEC strength, independent of the air interface: parity bytes per field. */
export interface FecLevel {
  id: string;
  name: string;
  bodyParity: number;
  headerParity: number;
  blurb: string;
}

export const FEC_LEVELS: FecLevel[] = [
  { id: 'light', name: 'Light', bodyParity: 8, headerParity: 6, blurb: 'Fastest. Clean room, short distance, nothing but text.' },
  { id: 'balanced', name: 'Balanced', bodyParity: 16, headerParity: 8, blurb: 'The default: one knock on the table costs you nothing.' },
  { id: 'heavy', name: 'Heavy', bodyParity: 32, headerParity: 12, blurb: 'For echoey rooms and people talking nearby.' },
  { id: 'max', name: 'Maximum', bodyParity: 48, headerParity: 16, blurb: 'Last resort: nearly half the airtime is check bytes.' },
];

export function fecById(id: string): FecLevel {
  return FEC_LEVELS.find((f) => f.id === id) ?? FEC_LEVELS[1]!;
}

export interface PlanOverrides {
  bodyParity?: number;
  headerParity?: number;
  txGain?: number;
  symMs?: number;
  tones?: number[];
  subDiv?: number;
}

/** Every tone of a plan is snapped to an exact DFT bin of the device sample rate. */
export function makePlan(profile: Profile, sr: number, ov: PlanOverrides = {}): Plan {
  const tuned: Profile = { ...profile, ...strip(ov) };
  const profile2 = tuned;
  const nominal = Math.max(8, Math.round((sr * profile2.symMs) / 1000));
  const L = Math.min(nominal, Math.floor(sr / 8));
  const bin = sr / L;
  const tones = profile2.tones.map((f) => Math.max(bin, Math.round(f / bin) * bin));
  const mfsk = tones.length;
  const bitsPerSymbol = Math.round(Math.log2(mfsk));
  if (Math.pow(2, bitsPerSymbol) !== mfsk) throw new Error('MFSK order must be a power of two');
  const symMs = (L / sr) * 1000;
  const chips = mSequence(profile2.preambleLen);
  const preamble = new Uint8Array(chips.length);
  for (let i = 0; i < chips.length; i++) preamble[i] = chips[i] ? mfsk - 1 : 0;
  const padSyms = Math.max(0, profile2.padSyms | 0);
  const preSyms = preamble.length + padSyms;
  const headerBytes = HDR.BYTES + profile2.headerParity;
  const headerSyms = Math.ceil((headerBytes * 8) / bitsPerSymbol);
  // Clamp the payload so that preamble + guard + header + body always fits in the
  // receiver's window, whatever the symbol rate of this device.
  const symsLeft = Math.floor((RX_WINDOW_SEC * sr) / L) - preSyms - headerSyms - 4;
  const fitsBytes = Math.floor((symsLeft * bitsPerSymbol) / 8) - 4 - profile2.bodyParity;
  const maxBody = Math.max(8, Math.min(profile2.maxBody, fitsBytes));
  const maxFrameMs = (((preSyms + headerSyms + Math.ceil(((maxBody + 4 + profile2.bodyParity) * 8) / bitsPerSymbol)) * L) / sr) * 1000;
  const tag = crc16(new Uint8Array([L & 0xff, (L >> 8) & 0xff, Math.round(symMs * 10) & 0xff, mfsk])) & 0xff;
  return {
    profileId: profile2.id,
    sr,
    tones,
    L,
    symMs,
    subStep: Math.max(1, Math.round(L / profile2.subDiv)),
    mfsk,
    bitsPerSymbol,
    bitRate: bitsPerSymbol / (symMs / 1000),
    preamble,
    padSyms,
    preSyms,
    headerBytes: HDR.BYTES,
    maxBody,
    chunkBody: Math.max(8, Math.min(profile2.chunkSize, maxBody - 12)),
    maxFrameMs,
    headerParity: profile2.headerParity,
    bodyParity: profile2.bodyParity,
    rampSamples: Math.max(2, Math.round((sr * profile2.rampMs) / 1000)),
    // A frame begins with a short silence and ends with a slightly longer one. The lead
    // matters more than it looks: the receiver jumps past a frame it just decoded with a
    // small clock-rate margin, so two frames transmitted back to back would otherwise
    // have their second preamble sit inside that margin and get skipped.
    leadSamples: Math.round(sr * 0.03),
    tailSamples: Math.round(sr * 0.024),
    shaping: profile2.shaping,
    profileTag: tag,
    txGain: profile2.txGain,
    nyquistRatio: Math.max(...tones) / (sr / 2),
  };
}

export const PROFILES: Profile[] = [
  {
    id: 'standard',
    name: 'Standard',
    blurb: '4-FSK voice band. The balanced default: works on phones, laptops and desktop speakers.',
    band: '1.9 – 3.0 kHz',
    tones: [1875, 2250, 2625, 3000],
    symMs: 8,
    subDiv: 6,
    headerParity: 8,
    bodyParity: 16,
    maxBody: 223,
    txGain: 0.3,
    rampMs: 4,
    preambleLen: 31,
    padSyms: 3,
    shaping: 'soft',
    chunkSize: 96,
  },
  {
    id: 'robust',
    name: 'Robust',
    blurb: 'Longer symbols, double the FEC, wider guard gap. For distance, echoey rooms and cheap speakers.',
    band: '1.4 – 2.3 kHz',
    tones: [1400, 1700, 2000, 2300],
    symMs: 10,
    subDiv: 6,
    headerParity: 12,
    bodyParity: 32,
    maxBody: 223,
    txGain: 0.34,
    rampMs: 5,
    preambleLen: 31,
    padSyms: 5,
    shaping: 'soft',
    chunkSize: 96,
  },
  {
    id: 'sprint',
    name: 'Sprint',
    blurb: '8-FSK across eight tones. Fastest option on good hardware, least tolerant of echo.',
    band: '1.6 – 4.4 kHz',
    tones: [1600, 2000, 2400, 2800, 3200, 3600, 4000, 4400],
    symMs: 5,
    subDiv: 8,
    headerParity: 8,
    bodyParity: 24,
    maxBody: 223,
    txGain: 0.28,
    rampMs: 3,
    preambleLen: 31,
    padSyms: 3,
    shaping: 'soft',
    chunkSize: 128,
  },
  {
    id: 'ultrasonic',
    name: 'Ultrasonic',
    blurb: '4-FSK above the audible band. Nearly silent, but needs tweeters that still work at 16 kHz.',
    band: '15.0 – 16.5 kHz',
    tones: [15000, 15500, 16000, 16500],
    symMs: 8,
    subDiv: 6,
    headerParity: 12,
    bodyParity: 32,
    maxBody: 223,
    txGain: 0.36,
    rampMs: 4,
    preambleLen: 31,
    padSyms: 4,
    shaping: 'soft',
    chunkSize: 96,
  },
  {
    id: 'deep',
    name: 'Deep',
    blurb: '4-FSK in the low band at 80 bps. The slowest option, and the one that has never lost a frame in the matrix. Penetrates walls, machinery and the worst microphone you own.',
    band: '720 Hz – 1.2 kHz',
    tones: [720, 880, 1040, 1200],
    symMs: 25,
    subDiv: 4,
    headerParity: 12,
    bodyParity: 24,
    maxBody: 160,
    txGain: 0.32,
    rampMs: 8,
    preambleLen: 31,
    padSyms: 6,
    shaping: 'hard',
    chunkSize: 64,
  },
];

/** Drop undefined keys so an override object never blanks a profile field. */
function strip(ov: PlanOverrides): Partial<Profile> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(ov)) if (v !== undefined) out[k] = v as number;
  return out as Partial<Profile>;
}

export function profileById(id: string): Profile {
  return PROFILES.find((p) => p.id === id) ?? PROFILES[0]!;
}

/** True when the device can realistically play and record this plan. */
export function planIsPlayable(plan: Plan): boolean {
  return plan.nyquistRatio < 0.86;
}
