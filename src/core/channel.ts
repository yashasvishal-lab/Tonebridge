/**
 * Acoustic channel model.
 *
 * Speakers, rooms and microphones are the hard part of this link, so the model that
 * describes them lives in the shipped product rather than in a test fixture: the same
 * code powers the Signal Lab sweep, the in-page self test and the "no microphone
 * needed" demo link. Anything the model says survives, survives in a room too.
 */

export interface Echo {
  ms: number;
  db: number;
}

export type NoiseKind = 'white' | 'room' | 'busy' | 'none';

export interface ChannelModel {
  /** Transmit + receive gain applied to the waveform, dB. */
  gainDb: number;
  /** Target signal-to-noise ratio inside the analysed band, dB. */
  snrDb: number;
  noise: NoiseKind;
  echoes: Echo[];
  lowHz: number;
  highHz: number;
  /** Clock error between the two devices, ppm. */
  driftPpm: number;
  /** Silence before the frame starts, ms. */
  startOffsetMs: number;
  /** A fade: someone leans on the speaker, or the mic gets covered. */
  fade?: { atMs: number; lenMs: number; db: number };
  /** Receiver overload; soft clip at this level. */
  clipDb?: number;
}

export const DEFAULT_CHANNEL: ChannelModel = {
  gainDb: -6,
  snrDb: 18,
  noise: 'room',
  echoes: [
    { ms: 2.4, db: -8 },
    { ms: 6.1, db: -13 },
    { ms: 11.7, db: -19 },
  ],
  lowHz: 240,
  highHz: 11500,
  driftPpm: 60,
  startOffsetMs: 40,
};

export const CALM: ChannelModel = { ...DEFAULT_CHANNEL, snrDb: 32, echoes: [], noise: 'none', driftPpm: 0, gainDb: -3 };

export interface ChannelPreset {
  id: string;
  name: string;
  blurb: string;
  model: ChannelModel;
}

export const CHANNEL_PRESETS: ChannelPreset[] = [
  { id: 'bench', name: 'Bench', blurb: 'Cable-grade: no echo, no noise. The theoretical floor.', model: CALM },
  {
    id: 'quiet',
    name: 'Quiet room',
    blurb: 'Desk-to-desk, one soft reflection, fan noise far away.',
    model: { ...DEFAULT_CHANNEL, snrDb: 26, gainDb: -6, echoes: [{ ms: 3.1, db: -12 }] },
  },
  {
    id: 'table',
    name: 'Loud cafe',
    blurb: 'Speech-band noise, clutter, and a phone fumbling on the table.',
    model: {
      ...DEFAULT_CHANNEL,
      snrDb: 9,
      noise: 'busy',
      gainDb: -10,
      echoes: [
        { ms: 1.9, db: -6 },
        { ms: 5.4, db: -10 },
        { ms: 9.2, db: -16 },
        { ms: 17.5, db: -22 },
      ],
      fade: { atMs: 900, lenMs: 120, db: -18 },
    },
  },
  {
    id: 'across',
    name: 'Across the room',
    blurb: '3 m apart, heavy reverb, low level, clipped input stage.',
    model: {
      ...DEFAULT_CHANNEL,
      snrDb: 13,
      gainDb: -22,
      clipDb: -6,
      driftPpm: 180,
      echoes: [
        { ms: 2.2, db: -5 },
        { ms: 4.8, db: -7 },
        { ms: 8.9, db: -11 },
        { ms: 15.3, db: -15 },
        { ms: 23.0, db: -21 },
      ],
    },
  },
  {
    id: 'phone',
    name: 'Cheap phone speaker',
    blurb: 'Band-limited tiny speaker, no bass, nasty top end, clock drift.',
    model: {
      ...DEFAULT_CHANNEL,
      snrDb: 15,
      gainDb: -14,
      lowHz: 520,
      highHz: 6800,
      driftPpm: 240,
      echoes: [
        { ms: 1.4, db: -7 },
        { ms: 3.9, db: -14 },
      ],
    },
  },
];

export function presetById(id: string): ChannelPreset {
  return CHANNEL_PRESETS.find((p) => p.id === id) ?? CHANNEL_PRESETS[1]!;
}

/** Deterministic PRNG so a failed test run is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand: () => number): number {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Run a transmit waveform through the model. Output length may be longer than the
 * input (start offset) but never shorter, so a receiver can rely on the tail.
 */
export function applyChannel(wave: Float32Array, sr: number, m: ChannelModel, rand: () => number = Math.random): Float32Array {
  const n = wave.length;
  const g = Math.pow(10, m.gainDb / 20);
  const aLp = 1 - Math.exp((-2 * Math.PI * m.highHz) / sr);
  const bHp = Math.exp((-2 * Math.PI * m.lowHz) / sr);
  const out = new Float32Array(n);

  let lp = 0;
  let hpPrevX = 0;
  let hpPrevY = 0;
  const taps = m.echoes.map((e) => ({
    d: Math.round((e.ms / 1000) * sr),
    a: Math.pow(10, e.db / 20),
  }));
  const fadeAt = m.fade ? Math.round((m.fade.atMs / 1000) * sr) : -1;
  const fadeLen = m.fade ? Math.max(1, Math.round((m.fade.lenMs / 1000) * sr)) : 1;
  const fadeAmt = m.fade ? Math.pow(10, m.fade.db / 20) : 1;

  for (let i = 0; i < n; i++) {
    let x = wave[i]! * g;
    lp += aLp * (x - lp);
    x = lp;
    const hpY = bHp * (hpPrevY + x - hpPrevX);
    hpPrevX = x;
    hpPrevY = hpY;
    x = hpY;
    let acc = x;
    for (let t = 0; t < taps.length; t++) {
      const tap = taps[t]!;
      const at = i - tap.d;
      if (at >= 0) acc += wave[at]! * g * tap.a;
    }
    if (fadeAt >= 0 && i >= fadeAt && i < fadeAt + fadeLen) acc *= fadeAmt;
    out[i] = acc;
  }

  const clip = m.clipDb !== undefined ? Math.pow(10, m.clipDb / 20) : 0;
  if (clip > 0 && clip < 1) {
    const knee = 1 - clip;
    for (let i = 0; i < n; i++) {
      const v = out[i]!;
      const a = Math.abs(v);
      if (a > clip) out[i] = Math.sign(v) * (clip + knee * Math.tanh((a - clip) / knee));
    }
  }

  // Clock error between the two devices: resample by a tiny ratio.
  let res = out;
  if (m.driftPpm !== 0) {
    const ratio = 1 + m.driftPpm / 1e6;
    const len = Math.floor(n / ratio);
    res = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const s = i * ratio;
      const i0 = Math.floor(s);
      const f = s - i0;
      res[i] = out[i0]! * (1 - f) + (out[Math.min(n - 1, i0 + 1)]! * f);
    }
  }

  // Noise, added after resampling so the requested SNR is the achieved SNR.
  const rn = res.length;
  const pad = Math.round((m.startOffsetMs / 1000) * sr);
  const final = new Float32Array(rn + pad);
  final.set(res, pad);
  if (m.noise !== 'none') {
    let sig = 0;
    for (let i = 0; i < rn; i++) sig += res[i]! * res[i]!;
    const sigPow = sig / Math.max(1, rn);
    const target = sigPow / Math.pow(10, m.snrDb / 10);
    const sigma = Math.sqrt(Math.max(1e-12, target));
    let lp1 = 0;
    let lp2 = 0;
    let prevX = 0;
    const aN = 1 - Math.exp((-2 * Math.PI * (m.noise === 'white' ? sr / 4 : 900)) / sr);
    const bN = Math.exp((-2 * Math.PI * (m.noise === 'busy' ? 180 : 20)) / sr);
    let am = 1;
    for (let i = 0; i < final.length; i++) {
      const w = gauss(rand) * sigma;
      lp1 += aN * (w - lp1);
      lp2 += aN * (lp1 - lp2);
      const y = bN * (lp2 + lp1 - prevX);
      prevX = lp1;
      if (m.noise !== 'white' && (i & 1023) === 0) am = 0.55 + rand() * 0.9;
      let v = (0.45 * w + 0.55 * y * 3) * am;
      if (m.noise === 'room') v += 0.22 * sigma * Math.sin((2 * Math.PI * 50 * i) / sr);
      final[i] = final[i]! + v;
    }
  }
  return final;
}

export function describeChannel(m: ChannelModel): string {
  const parts = [`${m.snrDb >= 0 ? '+' : ''}${m.snrDb} dB SNR`, m.noise, `${m.gainDb} dB loss`];
  if (m.echoes.length) parts.push(`${m.echoes.length} echo${m.echoes.length > 1 ? 'es' : ''}`);
  if (m.driftPpm) parts.push(`${m.driftPpm} ppm clock`);
  if (m.fade) parts.push(`${m.fade.lenMs} ms fade`);
  if (m.clipDb !== undefined) parts.push(`clip ${m.clipDb} dBFS`);
  parts.push(`${Math.round(m.lowHz)} Hz – ${Math.round(m.highHz / 1000)} kHz`);
  return parts.join(' · ');
}
