import { describe, expect, it } from 'vitest';
import { PROFILES, fecById, makePlan, planIsPlayable, profileById } from '../src/core/profiles.ts';
import { renderFrame } from '../src/core/tx.ts';
import { decodeRecording } from '../src/core/rx.ts';
import { packHeader, unpackHeader, IL_COLS, MIN_FRAME_CONF } from '../src/core/frame.ts';
import { CHANNEL_PRESETS, applyChannel, mulberry32, presetById } from '../src/core/channel.ts';
import { encodeWav, decodeWav, signalDelta } from '../src/core/wav.ts';
import { packText, unpack } from '../src/link/messages.ts';

const sr = 48000;
const planFor = (id: string): ReturnType<typeof makePlan> => makePlan(profileById(id), sr, { bodyParity: fecById('balanced').bodyParity, headerParity: fecById('balanced').headerParity });

describe('air interface plan', () => {
  it('snaps every tone to an exact DFT bin of the device', () => {
    for (const p of PROFILES) {
      for (const rate of [44100, 48000, 96000]) {
        const plan = makePlan(p, rate);
        const bin = rate / plan.L;
        // Exact multiples of the analysis bin: that is the whole trick that lets one
        // profile work on a 44.1 kHz laptop and a 48 kHz phone without retuning.
        for (const f of plan.tones) expect(Math.abs(f / bin - Math.round(f / bin))).toBeLessThan(1e-9);
        expect(plan.sr).toBe(rate);
      }
    }
  });

  it('keeps the symbol an integer number of samples and re-derives the rate', () => {
    for (const p of PROFILES) {
      const plan = planFor(p.id);
      expect(Number.isInteger(plan.L)).toBe(true);
      expect(plan.bitRate).toBeCloseTo((1000 / plan.symMs) * plan.bitsPerSymbol, 0);
      expect(plan.mfsk).toBe(p.tones.length);
      expect(plan.subStep).toBeGreaterThanOrEqual(1);
    }
  });

  it('guarantees the largest legal frame still fits the receive window', () => {
    for (const p of PROFILES) {
      const plan = planFor(p.id);
      expect(plan.maxBody).toBeLessThanOrEqual(p.maxBody);
      expect(plan.maxFrameMs).toBeLessThanOrEqual(12_000 + 1);
      expect(plan.chunkBody).toBeLessThanOrEqual(plan.maxBody - 12);
      expect(plan.chunkBody).toBeGreaterThanOrEqual(8);
    }
  });

  it('flags an interface no tweeter can play', () => {
    const harsh = makePlan(profileById('standard'), sr, { tones: [17000, 19000, 21000, 23000] });
    expect(planIsPlayable(harsh)).toBe(false);
    expect(planIsPlayable(planFor('standard'))).toBe(true);
  });

  it('honours overrides without breaking coherence', () => {
    const plan = makePlan(profileById('standard'), sr, { symMs: 12, tones: [1200, 1600, 2000, 2400], bodyParity: 24 });
    expect(plan.bodyParity).toBe(24);
    expect(plan.tones.every((f, i, a) => i === 0 || f > a[i - 1]!)).toBe(true);
    const body = packText('override check');
    const rendered = renderFrame(plan, body, { flags: 2, sender: 1, target: 255, msgId: 4, chunkIdx: 0, chunkCount: 1 }, { gain: plan.txGain });
    const frames = decodeRecording(rendered.wave, sr, plan);
    expect(frames.length).toBe(1);
    expect(unpack(frames[0]!.body)).toMatchObject({ text: 'override check' });
  });
});

describe('frame header', () => {
  it('round-trips through pack and unpack', () => {
    const plan = planFor('standard');
    const h = { version: 1, flags: 3, sender: 12, target: 7, msgId: 99, chunkIdx: 41, chunkCount: 200, bodyLen: 120 };
    const back = unpackHeader(packHeader(plan, h), plan);
    expect(back).toEqual(h);
  });

  it('refuses a header whose CRC or profile tag is wrong', () => {
    const plan = planFor('standard');
    const bytes = packHeader(plan, { version: 1, flags: 0, sender: 1, target: 255, msgId: 1, chunkIdx: 0, chunkCount: 1, bodyLen: 20 });
    expect(unpackHeader(bytes, plan)).not.toBeNull();
    const tampered = new Uint8Array(bytes);
    tampered[3] = (tampered[3]! + 1) & 0xff;
    expect(unpackHeader(tampered, plan)).toBeNull();
    const other = new Uint8Array(bytes);
    other[0] = 2;
    expect(unpackHeader(other, plan)).toBeNull();
  });

  it('rejects a body length the receiver could never buffer', () => {
    const plan = planFor('deep');
    const bytes = packHeader(plan, { version: 1, flags: 0, sender: 1, target: 255, msgId: 1, chunkIdx: 0, chunkCount: 1, bodyLen: plan.maxBody + 1 });
    expect(unpackHeader(bytes, plan)).toBeNull();
  });
});

describe('modulator', () => {
  it('stays inside full scale and eases in and out', () => {
    for (const p of PROFILES) {
      const plan = planFor(p.id);
      const rendered = renderFrame(plan, packText('gain and ramps'), { flags: 0, sender: 1, target: 255, msgId: 1, chunkIdx: 0, chunkCount: 1 }, { gain: plan.txGain });
      const wave = rendered.wave;
      let peak = 0;
      for (const v of wave) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeLessThanOrEqual(1);
      expect(peak).toBeGreaterThan(0.2);
      expect(Math.abs(wave[0]!)).toBeLessThan(0.02);
      expect(Math.abs(wave[wave.length - 1]!)).toBeLessThan(0.02);
      expect(rendered.durationMs).toBeCloseTo((wave.length / sr) * 1000, 0);
      expect(rendered.symbols.length).toBeGreaterThan(plan.preSyms);
      // The header is not allowed to be longer than the whole frame budget.
      expect(rendered.overhead).toBeLessThan(rendered.symbols.length);
    }
  });

  it('produces a deterministic waveform for identical input', () => {
    const plan = planFor('standard');
    const hdr = { flags: 0, sender: 1, target: 255, msgId: 8, chunkIdx: 0, chunkCount: 1 };
    const a = renderFrame(plan, packText('determinism'), hdr, { gain: 0.3 }).wave;
    const b = renderFrame(plan, packText('determinism'), hdr, { gain: 0.3 }).wave;
    expect(a).toEqual(b);
  });
});

describe('delivery over the channel model', () => {
  it('delivers product-sized chunks flawlessly in every baseline room', () => {
    // chunkBody is what the engine actually puts on the air, so this is the path that
    // matters: same profile, same FEC, three frames per room, nothing retransmitted.
    const baseline = ['bench', 'quiet', 'phone'];
    for (const p of PROFILES) {
      const plan = planFor(p.id);
      for (const cid of baseline) {
        const preset = presetById(cid);
        const rand = mulberry32(0x9e3779b9 ^ p.id.length ^ cid.length);
        for (let t = 0; t < 3; t++) {
          const text = `frame ${t} on ${p.id}/${cid} :: ${'x'.repeat(plan.chunkBody)}`.slice(0, Math.max(1, plan.chunkBody - 3));
          const body = packText(text);
          expect(body.length).toBeLessThanOrEqual(plan.maxBody);
          const wave = renderFrame(plan, body, { flags: 2, sender: 5, target: 255, msgId: 10 + t, chunkIdx: t, chunkCount: 3 }, { gain: plan.txGain }).wave;
          const noisy = applyChannel(wave, sr, { ...preset.model, snrDb: preset.model.snrDb }, rand);
          const got = decodeRecording(noisy, sr, plan).find((f) => {
            const e = unpack(f.body);
            return !!e && e.kind === 1 && e.text === text;
          });
          expect(got, `${p.id} lost a ${body.length}-byte frame in ${cid}`).toBeTruthy();
          // A frame that survives should not have needed much repair.
          expect(got!.stats.corrected + got!.stats.erasures).toBeLessThan(plan.bodyParity);
          expect(got!.stats.meanConf).toBeGreaterThan(MIN_FRAME_CONF);
          expect(got!.header).toMatchObject({ sender: 5, msgId: 10 + t, chunkIdx: t, chunkCount: 3, bodyLen: body.length });
        }
      }
    }
  });

  it('fills a maximum-length frame when the room is a bench top', () => {
    // The window clamp exists so a huge frame is possible but bounded; prove the
    // largest legal body really is deliverable, not just representable.
    for (const p of PROFILES) {
      const plan = planFor(p.id);
      const text = 'z'.repeat(plan.maxBody - 3);
      const body = packText(text);
      expect(body.length).toBeLessThanOrEqual(plan.maxBody);
      const wave = renderFrame(plan, body, { flags: 0, sender: 1, target: 255, msgId: 200, chunkIdx: 0, chunkCount: 1 }, { gain: plan.txGain }).wave;
      const frames = decodeRecording(wave, sr, plan);
      expect(frames.length, `${p.id} could not carry its own maximum frame`).toBe(1);
      expect(unpack(frames[0]!.body)).toMatchObject({ text });
    }
  });

  it('never returns corrupted bytes: damage is either repaired or the frame is dropped', () => {
    const plan = planFor('robust');
    const text = 'a frame that must never arrive wrong';
    const body = packText(text);
    const clean = renderFrame(plan, body, { flags: 0, sender: 1, target: 255, msgId: 3, chunkIdx: 0, chunkCount: 1 }, { gain: plan.txGain }).wave;
    let dropped = 0;
    let delivered = 0;
    for (let i = 0; i < 14; i++) {
      const rand = mulberry32(0x1234 + i * 977);
      const wave = new Float32Array(clean);
      const at = Math.floor(wave.length * 0.35);
      const len = Math.floor(wave.length * (0.1 + rand() * 0.35));
      for (let k = at; k < Math.min(wave.length, at + len); k++) wave[k] = (rand() * 2 - 1) * 0.9;
      const frames = decodeRecording(wave, sr, plan);
      for (const f of frames) {
        delivered++;
        const e = unpack(f.body);
        expect(e).toMatchObject({ text });
      }
      if (!frames.length) dropped++;
    }
    expect(dropped + delivered).toBe(14);
    expect(delivered).toBeLessThan(14);
  });

  it('measures a resync after an unrelated burst of room tone', () => {
    const plan = planFor('standard');
    const rand = mulberry32(4242);
    const mk = (t: string): Uint8Array => packText(t);
    const wave = renderFrame(plan, mk('after the burst'), { flags: 0, sender: 1, target: 255, msgId: 77, chunkIdx: 0, chunkCount: 1 }, { gain: plan.txGain }).wave;
    const pre = new Float32Array(Math.round(sr * 0.4));
    for (let i = 0; i < pre.length; i++) pre[i] = (rand() * 2 - 1) * 0.05;
    const joined = new Float32Array(pre.length + wave.length);
    joined.set(pre, 0);
    joined.set(wave, pre.length);
    const frames = decodeRecording(joined, sr, plan);
    expect(frames.length).toBe(1);
    expect(unpack(frames[0]!.body)).toMatchObject({ text: 'after the burst' });
  });
});

describe('interleaving and FEC layout', () => {
  it('spreads a burst across codeword positions', () => {
    const plan = planFor('standard');
    const body = packText('burst spread');
    const rendered = renderFrame(plan, body, { flags: 0, sender: 1, target: 255, msgId: 5, chunkIdx: 0, chunkCount: 1 }, { gain: plan.txGain });
    expect(rendered.symbols.length % IL_COLS === 0 || rendered.symbols.length > IL_COLS).toBe(true);
    // The same payload at a different message id scrambles differently on the air.
    const other = renderFrame(plan, body, { flags: 0, sender: 1, target: 255, msgId: 6, chunkIdx: 0, chunkCount: 1 }, { gain: plan.txGain });
    let differ = 0;
    for (let i = plan.preSyms; i < Math.min(rendered.symbols.length, other.symbols.length); i++) if (rendered.symbols[i] !== other.symbols[i]) differ++;
    expect(differ).toBeGreaterThan(0);
  });
});

describe('wav transport', () => {
  it('round-trips 16-bit and float files', () => {
    const rand = mulberry32(11);
    const samples = new Float32Array(4000).map(() => rand() * 2 - 1);
    const pcm = decodeWav(encodeWav(samples, sr));
    expect(pcm.sampleRate).toBe(sr);
    expect(pcm.samples.length).toBe(samples.length);
    let worst = 0;
    for (let i = 0; i < samples.length; i++) worst = Math.max(worst, Math.abs(pcm.samples[i]! - samples[i]!));
    expect(worst).toBeLessThan(1 / 32767 + 1e-6);
    const flt = decodeWav(encodeWav(samples, sr, true));
    expect(signalDelta(samples, flt.samples)).toBeLessThan(1e-6);
  });

  it('carries a whole frame through a file, which is the air-gap path', () => {
    const plan = planFor('standard');
    const text = 'written on a laptop, played into a phone';
    const wave = renderFrame(plan, packText(text), { flags: 0, sender: 3, target: 255, msgId: 40, chunkIdx: 0, chunkCount: 1 }, { gain: plan.txGain }).wave;
    const file = encodeWav(wave, sr);
    const back = decodeWav(file);
    const frames = decodeRecording(back.samples, back.sampleRate, plan);
    expect(frames.length).toBe(1);
    expect(unpack(frames[0]!.body)).toMatchObject({ text });
    // A 44.1 kHz plan cannot decode a 48 kHz file; the receiver says so instead of guessing.
    const foreign = makePlan(profileById('standard'), 44100);
    expect(() => decodeRecording(back.samples, 48000, foreign)).toThrow(/Hz/);
  });

  it('rejects a file that is not RIFF audio', () => {
    expect(() => decodeWav(new TextEncoder().encode('not a wav file at all, not even close to 44 bytes of header'))).toThrow();
  });

  it('lists every room model with a usable description', () => {
    expect(CHANNEL_PRESETS.length).toBeGreaterThanOrEqual(4);
    for (const c of CHANNEL_PRESETS) {
      expect(c.name.length).toBeGreaterThan(2);
      expect(c.model.gainDb ?? 0).toBeLessThanOrEqual(0);
      for (const e of c.model.echoes) expect(e.ms).toBeGreaterThanOrEqual(0);
    }
  });
});
