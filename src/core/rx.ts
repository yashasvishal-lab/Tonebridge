/**
 * Receiver.
 *
 * Real-time part: a Hann-windowed DFT pass over the incoming audio, at a fraction of
 * the symbol rate, kept in a ring buffer, plus an m-sequence correlation looking for
 * the frame preamble. That is all the "hunt" does, so it can run forever.
 *
 * The expensive part happens *after* a candidate preamble is found: the demodulator
 * re-reads the stored audio, sweeps sampling-phase and clock-rate hypotheses, and lets
 * the header CRC pick the winner. Decoding retrospectively from a buffer beats any
 * live clock-tracking loop here, because a wrong hypothesis costs a retry instead of a
 * corrupt packet - and it is the same entry point the CLI and the tests use on WAV
 * files, so what is proven offline is what runs on air.
 */

import type { FrameHeader, Plan, RxFrame, RxStats } from './types.ts';
import { allocSymbols, levelDb, makeToneBank, readSymbols, type SymbolSet, type ToneBank } from './dsp.ts';
import { bodyCodewordLength, decodeBody, decodeHeader, headerCodewordLength } from './frame.ts';
import { symbolsForBytes } from './interleave.ts';

export type DemodState = 'idle' | 'hunting' | 'body';

export interface DemodHandlers {
  onFrame?: (f: RxFrame) => void;
  onEvent?: (message: string, level: 'info' | 'ok' | 'warn' | 'error') => void;
  /** Maps an absolute sample index to wall-clock ms, to timestamp a frame. */
  timeForSample?: (absSample: number) => number;
}

/** Clock-rate hypotheses tried at lock, as multipliers of the nominal symbol step. */
const RATE_SEARCH = [1, 1.0009, 0.9991, 1.00045, 0.99955, 1.0018, 0.9982, 1.0032, 0.9968];
/** Bounds of the rate sweep, used to decide when enough audio has arrived. */
const RATE_MAX = 1.0032;
/** Sampling-phase hypotheses, in half-substep units. */
const PHASE_SEARCH = [0, 1, -1, 2, -2];

export interface DemodCounters {
  candidates: number;
  headerOk: number;
  bodyOk: number;
  bodyFail: number;
  syncRejects: number;
}

interface Candidate {
  slot: number;
  /** First sample of the preamble. */
  frameStart: number;
  /** First sample of the header field. */
  headerStart: number;
  step: number;
  header: FrameHeader;
  meanRel: number;
  corrected: number;
}

export class Demodulator {
  readonly plan: Plan;
  readonly sr: number;
  readonly outbox: RxFrame[] = [];
  readonly counters: DemodCounters = { candidates: 0, headerOk: 0, bodyOk: 0, bodyFail: 0, syncRejects: 0 };

  private readonly bank: ToneBank;
  private readonly ring: Float32Array;
  private readonly mask: number;
  private readonly coarseIdx: Uint8Array;
  private readonly coarseRel: Float32Array;
  private readonly coarsePow: Float32Array;
  private readonly cMask: number;
  private readonly stride: number;
  private readonly syncNeed: number;
  private readonly handlers: DemodHandlers;
  private readonly probe: SymbolSet;

  private wrote = 0;
  private cN = 0;
  private scan = 0;
  private noisePow = 1e-9;
  private noiseHoldUntil = 0;
  private pending: (Candidate & { bodyStart: number; bodyNSym: number; deadline: number }) | null = null;
  private _state: DemodState = 'idle';
  private _lastRx: RxFrame | null = null;
  private _lastError = '';
  private _lastCarrierAt = 0;

  constructor(plan: Plan, handlers: DemodHandlers = {}, windowSec = 0) {
    this.plan = plan;
    this.sr = plan.sr;
    this.bank = makeToneBank(plan.sr, plan.L, plan.tones);
    const preSym = plan.preSyms;
    const maxSyms = preSym + headerSymbols(plan) + bodySymbols(plan, plan.maxBody);
    // One worst-case frame plus a margin is all the history the decoder needs; the
    // buffer is deliberately capped so a careless caller cannot ask for a gigabyte.
    const wanted = Math.min(20, Math.max(2, windowSec > 0 ? windowSec : ((maxSyms + 8) * plan.L) / plan.sr + 1));
    const holdSec = Math.min(wanted, (32 * 1024 * 1024) / plan.sr);
    let cap = 1;
    while (cap < Math.ceil(holdSec * plan.sr)) cap <<= 1;
    this.ring = new Float32Array(cap);
    this.mask = cap - 1;
    this.stride = Math.max(1, Math.round(plan.L / plan.subStep));
    let cCap = 1;
    while (cCap < Math.ceil(cap / plan.subStep) + 1024) cCap <<= 1;
    this.coarseIdx = new Uint8Array(cCap);
    this.coarseRel = new Float32Array(cCap);
    this.coarsePow = new Float32Array(cCap);
    this.cMask = cCap - 1;
    this.syncNeed = Math.max(11, Math.ceil(plan.preamble.length * 0.7));
    this.probe = allocSymbols(1);
    this.handlers = handlers;
  }

  get state(): DemodState {
    return this._state;
  }
  get lastFrame(): RxFrame | null {
    return this._lastRx;
  }
  get lastError(): string {
    return this._lastError;
  }
  /** Wall-clock ms of the most recent preamble-like pattern (0 when never). */
  get lastCarrierMs(): number {
    return this._lastCarrierAt;
  }
  get noiseFloorDb(): number {
    return 10 * Math.log10(this.noisePow + 1e-12);
  }
  /** How far the last second of input sat above the learned noise floor, dB. */
  signalExcessDb(): number {
    const span = Math.max(1, Math.round(this.sr / this.plan.subStep));
    const from = Math.max(0, this.cN - span);
    let acc = 0;
    let n = 0;
    for (let s = from; s < this.cN; s++) {
      acc += this.coarsePow[s & this.cMask]!;
      n++;
    }
    return n ? 10 * Math.log10(acc / n / (this.noisePow + 1e-12) + 1e-9) : -60;
  }

  /**
   * The last `n` coarse symbol slots as the demodulator saw them: winning tone index,
   * discrimination ratio and power. This is the live view the Signal Lab paints - it is
   * the receiver's own memory, not a second measurement that could disagree with it.
   */
  trace(n: number): { idx: Uint8Array; rel: Float32Array; pow: Float32Array; step: number } {
    const m = Math.max(1, Math.min(Math.floor(n), this.cN));
    const idx = new Uint8Array(m);
    const rel = new Float32Array(m);
    const pow = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      const slot = (this.cN - m + i) & this.cMask;
      idx[i] = this.coarseIdx[slot]!;
      rel[i] = this.coarseRel[slot]!;
      pow[i] = this.coarsePow[slot]!;
    }
    return { idx, rel, pow, step: this.plan.subStep };
  }

  reset(keepCounters = false): void {
    this.wrote = 0;
    this.cN = 0;
    this.scan = 0;
    this.pending = null;
    this._state = 'idle';
    this.outbox.length = 0;
    if (!keepCounters) {
      this.counters.candidates = 0;
      this.counters.headerOk = 0;
      this.counters.bodyOk = 0;
      this.counters.bodyFail = 0;
      this.counters.syncRejects = 0;
    }
  }

  /** Feed a block of mono audio. */
  push(input: Float32Array): void {
    for (let i = 0; i < input.length; i++) this.ring[(this.wrote + i) & this.mask] = input[i]!;
    this.wrote += input.length;
    this.process();
  }

  private process(): void {
    const { subStep, L } = this.plan;
    while (this.cN * subStep + L <= this.wrote) {
      const lin = this.snapshot(this.cN * subStep, L);
      if (!lin) break;
      readSymbols(this.bank, lin, 0, L, this.probe);
      const pow = this.probe.pow[0]!;
      if (pow < this.noisePow) {
        // Anything quieter is a better floor estimate, so fall fast...
        this.noisePow = this.noisePow * 0.995 + pow * 0.005;
      } else if (!this.pending && this.cN > this.noiseHoldUntil) {
        // ...while a louder room only nudges it, and a frame in flight freezes it
        // entirely: otherwise the signal itself gets learned as noise and every
        // SNR reading in the UI becomes fiction.
        this.noisePow = this.noisePow * 0.9999 + pow * 0.0001;
      }
      const slot = this.cN & this.cMask;
      this.coarseIdx[slot] = this.probe.idx[0]!;
      this.coarseRel[slot] = this.probe.rel[0]!;
      this.coarsePow[slot] = pow;
      this.cN++;
    }

    // One push can contain several whole frames - the harness feeds recordings in
    // single blocks, a throttled tab may deliver a burst, and a busy room always puts a
    // retransmission right behind the frame it follows. So drain as much as the audio
    // we actually hold allows instead of leaving a complete frame unread until the next
    // push happens to arrive.
    for (let round = 0; round < 64; round++) {
      const p = this.pending;
      if (p) {
        if (this.wrote >= p.frameStart + (this.plan.preSyms + headerSymbols(this.plan) + p.bodyNSym + 1) * L * RATE_MAX) {
          this.finishBody();
          continue;
        }
        if (this.wrote > p.deadline) {
          this.counters.bodyFail++;
          this._lastError = 'lost the tail of the frame';
          this.handlers.onEvent?.('Sync held but the rest of the frame never arrived.', 'warn');
          this.pending = null;
          this._state = 'hunting';
          continue;
        }
        return;
      }

      this._state = 'hunting';
      let armed = false;
      for (let guard = 0; guard < 32; guard++) {
        const slot = this.findSync();
        if (slot < 0) return;
        const cand = this.lockHeader(slot);
        if (!cand) {
          this.counters.syncRejects++;
          continue;
        }
        this.counters.candidates++;
        this.arm(cand);
        armed = true;
        break;
      }
      if (!armed) return;
    }
  }

  private findSync(): number {
    const pre = this.plan.preamble;
    const stride = this.stride;
    const need = Math.round((pre.length - 1) * stride) + 2;
    while (this.scan + need < this.cN) {
      // A candidate is only consumed once the audio behind it is present, otherwise
      // the header sweep would see a short buffer, reject it, and the scanner would
      // walk past the real frame start for good.
      const readyAt =
        (this.scan + 1) * this.plan.subStep +
        (this.plan.preSyms + headerSymbols(this.plan)) * this.plan.L * RATE_MAX +
        this.plan.L +
        this.plan.subStep;
      if (this.wrote < readyAt) return -1;
      const slot = this.scan++;
      if (this.coarsePow[slot & this.cMask]! < this.noisePow * 4) continue;
      let hits = 0;
      let rel = 0;
      for (let j = 0; j < pre.length; j++) {
        const s = slot + Math.round(j * stride);
        if (s >= this.cN) break;
        if (this.coarseIdx[s & this.cMask] === pre[j]!) hits++;
        rel += this.coarseRel[s & this.cMask]!;
      }
      // A loud but mushy preamble (heavy echo) never yields a decodable header, and a
      // header sweep costs nine measurements - so gate on discrimination as well as hits.
      if (hits >= this.syncNeed && rel / pre.length > 1.2) {
        this._lastCarrierAt = Date.now();
        this.noiseHoldUntil = this.cN + Math.round(this.sr / this.plan.subStep) * 3;
        return slot;
      }
    }
    return -1;
  }

  /** Sweep phase and rate hypotheses; keep whichever header looks strongest. */
  private lockHeader(slot: number): Candidate | null {
    const base = slot * this.plan.subStep;
    const nSym = headerSymbols(this.plan);
    let best: Candidate | null = null;
    for (const mul of RATE_SEARCH) {
      const step = this.plan.L * mul;
      const headerStart = base + Math.round(this.plan.preSyms * step);
      const need = Math.round(headerStart + nSym * step + this.plan.L) - base;
      const lin = this.snapshot(base, need);
      if (!lin) continue;
      for (const ph of PHASE_SEARCH) {
        const start = Math.round((ph * this.plan.subStep) / 2);
        const off = Math.max(0, headerStart - base + start);
        if (off + nSym * step + this.plan.L > lin.length) continue;
        const set = allocSymbols(nSym);
        if (!readSymbols(this.bank, lin, off, step, set)) continue;
        const res = decodeHeader(this.plan, set.idx, set.rel);
        if (!res) continue;
        // Ties (and near ties) go to the hypothesis tried first, which is the
        // nominal one: a marginal difference in a saturated metric must not win.
        if (!best || res.meanRel > best.meanRel * 1.1) {
          best = {
            slot,
            frameStart: base,
            headerStart: headerStart + start,
            step,
            header: res.header,
            meanRel: res.meanRel,
            corrected: res.corrected,
          };
        }
        break; // a header CRC pass is a strong enough verdict for this rate
      }
    }
    if (best) this.counters.headerOk++;
    return best;
  }

  private arm(c: Candidate): void {
    const bodyNSym = bodySymbols(this.plan, c.header.bodyLen);
    const total = this.plan.preSyms + headerSymbols(this.plan) + bodyNSym;
    this.pending = {
      ...c,
      bodyStart: c.headerStart + headerSymbols(this.plan) * c.step,
      bodyNSym,
      deadline: this.wrote + Math.ceil(total * this.plan.L * RATE_MAX) + this.sr * 2,
    };
    this._state = 'body';
    this.scan = Math.round((c.frameStart + total * this.plan.L * RATE_MAX) / this.plan.subStep) + 1;
  }

  private finishBody(): void {
    const p = this.pending!;
    const { L } = this.plan;
    const preLen = this.plan.preSyms;
    const nHead = headerSymbols(this.plan);
    const need = Math.ceil(p.bodyNSym * L * RATE_MAX) + L + 8;
    const lin = this.snapshot(p.frameStart, p.bodyStart - p.frameStart + need);
    let delivered = false;
    if (lin) {
      const set = allocSymbols(p.bodyNSym);
      // The header spans only a few symbols, so the clock rate picked there can be
      // one hypothesis off - harmless over 68 symbols, fatal over 900. So the body is
      // retried across the whole rate list, nearest-to-nominal first, and its CRC - not
      // a heuristic - chooses the winner.
      const orders = RATE_SEARCH.map((mul) => L * mul).sort(
        (a, b) => Math.abs(a / L - 1) - Math.abs(b / L - 1),
      );
      for (const step of orders) {
        const bodyStart = p.headerStart - p.frameStart + nHead * step;
        const offset = Math.round(bodyStart);
        if (offset < 0 || offset + p.bodyNSym * step + L > lin.length) continue;
        if (!readSymbols(this.bank, lin, offset, step, set)) continue;
        const res = decodeBody(this.plan, p.header, set.idx, set.rel);
        if (!res) continue;
        let sum = 0;
        let min = Infinity;
        let powSum = 0;
        for (let i = 0; i < p.bodyNSym; i++) {
          const r = set.rel[i]!;
          sum += r;
          if (r < min) min = r;
          powSum += set.pow[i]!;
        }
        const n = Math.max(1, p.bodyNSym);
        const stats: RxStats = {
          snrDb: Math.min(60, 10 * Math.log10(powSum / n / (this.noisePow + 1e-12) + 1e-9)),
          meanConf: (sum + p.meanRel * nHead) / (preLen + nHead + p.bodyNSym),
          minConf: Number.isFinite(min) ? min : 0,
          corrected: p.corrected + res.corrected,
          erasures: res.erasures,
          symbols: preLen + nHead + p.bodyNSym,
          timingPpm: ((step - L) / L) * 1e6,
          levelDb: levelDb(lin, 0, lin.length),
          startSample: p.frameStart,
          clockMs: this.handlers.timeForSample
            ? this.handlers.timeForSample(p.frameStart)
            : Date.now() - ((this.wrote - p.frameStart) / this.sr) * 1000,
        };
        const frame: RxFrame = { header: p.header, body: res.payload, stats };
        this._lastRx = frame;
        this._lastError = '';
        this.counters.bodyOk++;
        this.outbox.push(frame);
        this.handlers.onFrame?.(frame);
        delivered = true;
        break;
      }
    }
    if (!delivered) {
      this.counters.bodyFail++;
      this._lastError = 'forward error correction could not recover the payload';
      this.handlers.onEvent?.('Sync held, but FEC could not recover the payload - waiting for a retransmit.', 'warn');
    }
    this.pending = null;
    this._state = 'hunting';
  }

  private snapshot(from: number, len: number): Float32Array | null {
    if (len <= 0) return null;
    if (from < 0 || from + len > this.wrote) return null;
    if (len > this.ring.length || this.wrote - from > this.ring.length) return null;
    const out = new Float32Array(len);
    const base = from & this.mask;
    if (base + len <= this.ring.length) {
      out.set(this.ring.subarray(base, base + len));
    } else {
      out.set(this.ring.subarray(base));
      out.set(this.ring.subarray(0, base + len - this.ring.length), this.ring.length - base);
    }
    return out;
  }
}

export function headerSymbols(plan: Plan): number {
  return symbolsForBytes(headerCodewordLength(plan), plan.bitsPerSymbol);
}

export function bodySymbols(plan: Plan, bodyLen: number): number {
  return symbolsForBytes(bodyCodewordLength(plan, bodyLen), plan.bitsPerSymbol);
}

/**
 * Decode every frame in a finished recording. Used by WAV import, the CLI, the
 * in-browser self test and the unit tests - the same entry point the live
 * receiver drives, so a passing test means the air path works.
 */
export function decodeRecording(samples: Float32Array, sr: number, plan: Plan): RxFrame[] {
  // Tones are snapped to bins of a specific sample rate, so decoding a 44.1 kHz
  // recording with a 48 kHz plan is not "close enough" - it is a different signal.
  if (Math.abs(sr - plan.sr) > 0.5) throw new RangeError(`recording is ${sr} Hz but the plan expects ${plan.sr} Hz`);
  const demod = new Demodulator(plan, {});
  const block = 8192;
  for (let i = 0; i < samples.length; i += block) {
    demod.push(samples.subarray(i, Math.min(samples.length, i + block)));
  }
  demod.push(new Float32Array(block));
  return demod.outbox.slice();
}
