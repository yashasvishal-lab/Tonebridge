/**
 * The link engine: everything between the waveform and the user.
 *
 * Responsibilities, in order of how much they matter:
 *   1. never corrupt data - every frame is Reed-Solomon protected, CRC checked and,
 *      when a key exists, AES-GCM authenticated before it becomes a message;
 *   2. never lose data silently - each frame that matters is acknowledged, a frame
 *      nobody acknowledged is retransmitted a bounded number of times, and then it is
 *      reported as a failure with the missing chunk list available for a re-request;
 *   3. stay honest about the radio - every number in the UI is counted here, not
 *      estimated: frames, retries, FEC load, erasures, SNR, airtime.
 *
 * Framework-free, and DOM-free apart from AudioContext, so the identical code runs in
 * the browser, in the Node CLI and inside vitest.
 */

import type { FrameHeader, Plan, Profile, RxFrame, RxStats } from '../core/types.ts';
import { FLAGS, HDR } from '../core/types.ts';
import { FEC_LEVELS, PROFILES, fecById, makePlan, planIsPlayable, profileById, type FecLevel } from '../core/profiles.ts';
import { renderFrame } from '../core/tx.ts';
import { Demodulator, decodeRecording } from '../core/rx.ts';
import { packHeader } from '../core/frame.ts';
import { applyChannel, mulberry32, presetById, describeChannel, CHANNEL_PRESETS, type ChannelModel } from '../core/channel.ts';
import { encodeWav, decodeWav, signalDelta } from '../core/wav.ts';
import { packText, packManifest, packChunk, packAck, packCtrl, packPing, packPong, readU32BE, unpack, chunkBytes, KIND, CTRL } from './messages.ts';
import type { CtrlEnvelope } from './messages.ts';
import { LinkCrypto } from './crypto.ts';
import { sweep, type AdaptResult } from '../core/adapt.ts';
import { Store } from './store.ts';
import { clearTranscripts, loadSettings, loadTranscripts, saveSettings, saveTranscripts, type StoredTranscript } from './storage.ts';
import { AudioGraph, type CaptureSource } from './audioGraph.ts';

export type LogLevel = 'info' | 'ok' | 'warn' | 'error';
export interface LogEntry {
  id: number;
  t: number;
  level: LogLevel;
  msg: string;
}

export interface MsgItem {
  id: string;
  t: number;
  dir: 'rx' | 'tx';
  kind: 'text' | 'file' | 'note';
  text: string;
  from: number;
  to: number;
  msgId: number;
  secure: boolean;
  fileId?: string;
  stats?: Partial<RxStats> & { attempts?: number; airMs?: number };
  error?: string;
}

export interface Transfer {
  id: string;
  msgId: number;
  dir: 'rx' | 'tx';
  name: string;
  size: number;
  mime: string;
  chunks: number;
  chunkSize: number;
  have: number[];
  missing: number[];
  bytes: Uint8Array | null;
  state: 'active' | 'done' | 'failed' | 'cancelled';
  sha256: string;
  gotSha: string;
  error?: string;
  url?: string;
  startedAt: number;
  endedAt?: number;
}

export interface PeerInfo {
  node: number;
  name: string;
  framesOk: number;
  lastSnrDb: number;
  lastLevelDb: number;
  lastSeen: number;
  secure: boolean;
}

export interface Stats {
  framesSent: number;
  framesRecv: number;
  framesRejected: number;
  retries: number;
  acksSent: number;
  acksRecv: number;
  bytesSent: number;
  bytesRecv: number;
  fecSymbols: number;
  erasureSymbols: number;
  airSeconds: number;
  echoes: number;
}

export interface TxState {
  busy: boolean;
  label: string;
  done: number;
  total: number;
  error?: string;
}

export interface SelfTest {
  running: boolean;
  label: string;
  progress: number;
  results: AdaptResult[];
  picked: AdaptResult | null;
  error?: string;
  at?: number;
}

export interface ScopeTelemetry {
  levelDb: number;
  noiseFloorDb: number;
  excessDb: number;
  snrDb: number;
  state: string;
  ppm: number;
  lastConf: number;
  lastMinConf: number;
}

export interface PingResult {
  ok: boolean;
  target: number;
  rttMs: number;
  snrDb: number;
  levelDb: number;
  corrected: number;
  error?: string;
  quality: 'excellent' | 'good' | 'fair' | 'poor' | 'failed';
  t: number;
}

export interface Settings {
  profileId: string;
  fecId: string;
  node: number;
  name: string;
  txGain: number;
  capture: CaptureSource;
  channelPreset: string;
  snrDb: number;
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  autoAck: boolean;
  beacon: boolean;
  saveTranscripts: boolean;
  keepAwake: boolean;
  symMs: number;
  tones: string;
  muted: boolean;
}

export interface AppModel {
  ready: boolean;
  error: string;
  settings: Settings;
  plan: Plan | null;
  profile: Profile | null;
  fec: FecLevel | null;
  playable: { ok: boolean; warning: string };
  graph: { running: boolean; mic: string; sampleRate: number; worklet: boolean; inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[]; outputDevice: string | null };
  rx: { state: string; counters: { candidates: number; headerOk: number; bodyOk: number; bodyFail: number; syncRejects: number }; lastError: string };
  stats: Stats;
  messages: MsgItem[];
  transfers: Transfer[];
  peers: PeerInfo[];
  logs: LogEntry[];
  tx: TxState;
  crypto: { mode: string; label: string; secure: boolean; sas: string; pairState: string; role: string; fingerprint: string };
  selftest: SelfTest;
  scope: ScopeTelemetry;
  wakeLock: boolean;
  matrix: MatrixCell[];
  lastPing: PingResult | null;
}

export interface MatrixCell {
  profileId: string;
  profileName: string;
  channelId: string;
  channelName: string;
  delivered: number;
  frames: number;
  bps: number;
  fec: string;
}

const MAX_MESSAGES = 400;
/** A file this big is buffered in memory and chunked; beyond it, use the WAV export. */
export const FILE_LIMIT = 256 * 1024;

let logSeq = 1;
let msgSeq = 1;

function emptyStats(): Stats {
  return {
    framesSent: 0,
    framesRecv: 0,
    framesRejected: 0,
    retries: 0,
    acksSent: 0,
    acksRecv: 0,
    bytesSent: 0,
    bytesRecv: 0,
    fecSymbols: 0,
    erasureSymbols: 0,
    airSeconds: 0,
    echoes: 0,
  };
}

function hex(b: Uint8Array): string {
  let s = '';
  for (const v of b) s += v.toString(16).padStart(2, '0');
  return s;
}

export class Engine {
  readonly store: Store<AppModel>;
  readonly crypto: LinkCrypto;
  private graph: AudioGraph;
  private demod: Demodulator | null = null;
  private plan: Plan | null = null;
  private rand = mulberry32(0xa17e);
  private seen = new Map<string, number>();
  private awaiting = new Map<string, { resolve: (v: boolean) => void; timer: ReturnType<typeof setTimeout> }>();
  /** Acknowledgements that arrived with nobody waiting, kept briefly. */
  private lateAcks = new Map<string, boolean>();
  private txSeq = 0;
  private abortFlag = false;
  private beaconTimer: ReturnType<typeof setInterval> | null = null;
  private awaitingPing = new Map<number, { resolve: (res: PingResult) => void; timer: ReturnType<typeof setTimeout>; t0: number; target: number }>();
  private wakeLock: { release: () => Promise<void> } | null = null;
  private demodTotal = 0;
  private simChain: Promise<void> = Promise.resolve();
  private bc: BroadcastChannel | null = null;
  /**
   * Harness seam: when set, every waveform is handed to this callback as well as to the
   * local receiver. The test suite uses it to wire two nodes together in one process,
   * and it is what the in-page "two devices on one machine" self-test runs on.
   */
  onEmit: ((wave: Float32Array, sr: number) => void) | null = null;
  private pairRole = 'idle';

  constructor() {
    const persisted = typeof window === 'undefined' ? {} : loadSettings();
    const profile = profileById(persisted.profileId ?? 'standard');
    const fec = fecById(persisted.fecId ?? 'balanced');
    let sessionNode: number | undefined;
    if (typeof sessionStorage !== 'undefined') {
      const s = sessionStorage.getItem('tonebridge/session_node');
      if (s) {
        const parsed = Number(s);
        if (parsed >= 1 && parsed <= 254) sessionNode = parsed;
      }
    }
    const defaultNode = sessionNode ?? (persisted.node !== undefined ? clamp(persisted.node, 1, 254) : (typeof window !== 'undefined' ? Math.floor(Math.random() * 240) + 2 : 7));
    if (typeof sessionStorage !== 'undefined' && !sessionNode) {
      try {
        sessionStorage.setItem('tonebridge/session_node', String(defaultNode));
      } catch {
        /* storage restricted */
      }
    }
    const defaultName = persisted.name ?? `Bridge-${defaultNode}`;
    const settings: Settings = {
      profileId: profile.id,
      fecId: fec.id,
      node: defaultNode,
      name: defaultName,
      txGain: persisted.txGain ?? 0.3,
      capture: (persisted.capture as CaptureSource) ?? 'loopback',
      channelPreset: persisted.channelPreset ?? 'quiet',
      snrDb: persisted.snrDb ?? 18,
      inputDeviceId: null,
      outputDeviceId: null,
      autoAck: persisted.autoAck ?? true,
      beacon: persisted.beacon ?? false,
      saveTranscripts: persisted.saveTranscripts ?? false,
      keepAwake: false,
      symMs: persisted.symMs ?? 0,
      tones: persisted.tones ?? '',
      muted: persisted.muted ?? false,
    };
    this.store = new Store<AppModel>({
      ready: false,
      error: '',
      settings,
      plan: null,
      profile,
      fec,
      playable: { ok: true, warning: '' },
      graph: { running: false, mic: 'off', sampleRate: 48000, worklet: false, inputs: [], outputs: [], outputDevice: null },
      rx: { state: 'idle', counters: { candidates: 0, headerOk: 0, bodyOk: 0, bodyFail: 0, syncRejects: 0 }, lastError: '' },
      stats: emptyStats(),
      messages: [],
      transfers: [],
      peers: [],
      logs: [],
      tx: { busy: false, label: 'Idle', done: 0, total: 0 },
      crypto: { mode: 'open', label: 'Open channel', secure: false, sas: '', pairState: 'idle', role: '', fingerprint: '' },
      selftest: { running: false, label: '', progress: 0, results: [], picked: null },
      scope: { levelDb: -120, noiseFloorDb: -120, excessDb: 0, snrDb: 0, state: 'idle', ppm: 0, lastConf: 0, lastMinConf: 0 },
      wakeLock: false,
      matrix: [],
      lastPing: null,
    });
    this.crypto = new LinkCrypto((e) => {
      this.log(e.message, e.level);
      this.publishCrypto();
    });
    this.graph = new AudioGraph({
      onSamples: (s, abs) => this.onSamples(s, abs),
      onState: (g) =>
        this.store.set({
          graph: { running: g.running, mic: g.mic, sampleRate: g.sampleRate, worklet: g.worklet, inputs: g.inputs, outputs: g.outputs, outputDevice: g.outputDevice },
        }),
      onLog: (m, l = 'info') => this.log(m, l),
    });
    if (typeof BroadcastChannel !== 'undefined') {
      try {
        this.bc = new BroadcastChannel('tonebridge_air');
        this.bc.onmessage = (e: MessageEvent) => {
          const data = e.data as { type?: string; samples?: ArrayBuffer; sender?: number } | null;
          if (!data || data.type !== 'wave' || !data.samples) return;
          if (data.sender === this.myNode) return;
          const wave = new Float32Array(data.samples);
          this.feedSamples(wave);
        };
      } catch {
        this.bc = null;
      }
    }
    this.rebuildPlan();
    if (typeof window !== 'undefined' && persisted.saveTranscripts) {
      const stored = loadTranscripts();
      if (stored.length) {
        this.store.set({
          messages: stored.map((sm, i): MsgItem => ({
            id: `s${i}`,
            t: sm.t,
            dir: sm.dir,
            kind: sm.kind === 'file' ? 'file' : 'text',
            text: sm.text ?? '',
            from: sm.from ?? 0,
            to: sm.to ?? 255,
            msgId: 0,
            secure: !!sm.secure,
          })),
        });
        this.log(`Restored ${stored.length} stored message(s).`, 'info');
      }
    }
  }

  // ---- setup ---------------------------------------------------------------

  get sr(): number {
    return this.graph.ctx?.sampleRate ?? 48000;
  }

  get currentPlan(): Plan | null {
    return this.plan;
  }

  /** Must run inside a user gesture: browsers refuse to start audio any other way. */
  async init(): Promise<void> {
    if (this.store.get().ready) return;
    try {
      await this.graph.ensureContext();
      this.rebuildPlan();
      this.store.set({ ready: true });
      const ok = await this.startCapture();
      if (ok && this.store.get().settings.beacon) void this.setBeacon(true);
      if (typeof document !== 'undefined') {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') void this.graph.resumeIfNeeded();
        });
      }
      this.log(`Ready. Device rate ${this.sr} Hz, ${this.store.get().profile?.name ?? ''} profile.`, 'ok');
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'audio setup failed';
      this.store.set({ error: msg });
      this.log(`Audio could not start: ${msg}. Everything except live capture still works.`, 'error');
      this.store.set({ ready: true });
    }
  }

  setSettings(patch: Partial<Settings>): void {
    if ('node' in patch && patch.node && typeof sessionStorage !== 'undefined') {
      try {
        sessionStorage.setItem('tonebridge/session_node', String(patch.node));
      } catch {
        /* storage restricted */
      }
    }
    const next = { ...this.store.get().settings, ...patch };
    this.store.set({ settings: next });
    saveSettings({
      profileId: next.profileId,
      fecId: next.fecId,
      node: next.node,
      name: next.name,
      txGain: next.txGain,
      capture: next.capture,
      channelPreset: next.channelPreset,
      snrDb: next.snrDb,
      autoAck: next.autoAck,
      beacon: next.beacon,
      saveTranscripts: next.saveTranscripts,
      symMs: next.symMs,
      tones: next.tones,
      muted: next.muted,
    });
    if ('capture' in patch || 'inputDeviceId' in patch) this.startCapture().catch(() => undefined);
    if ('outputDeviceId' in patch) void this.graph.setOutputDevice(next.outputDeviceId);
    if ('txGain' in patch) this.graph.setTxGain(1);
    this.rebuildPlan();
  }

  private rebuildPlan(): void {
    const s = this.store.get().settings;
    const profile = profileById(s.profileId);
    const fec = fecById(s.fecId);
    const tones = s.tones
      ? s.tones
          .split(/[\s,]+/)
          .map((v) => Number(v))
          .filter((v) => Number.isFinite(v) && v > 20 && v < 24000)
      : [];
    try {
      const plan = makePlan(profile, this.sr, {
        bodyParity: fec.bodyParity,
        headerParity: fec.headerParity,
        txGain: clamp(s.txGain, 0.02, 0.35),
        ...(s.symMs > 0 ? { symMs: s.symMs } : {}),
        ...(tones.length >= 2 ? { tones } : {}),
      });
      const okPlan = planIsPlayable(plan);
      const playable = {
        ok: okPlan,
        warning: okPlan
          ? ''
          : `The highest tone sits at ${(plan.nyquistRatio * 100).toFixed(0)}% of Nyquist. Most laptop and phone tweeters roll off long before that, so the frame will sound right but arrive wrong. Lower the tones or shorten the symbol.`,
      };
      this.plan = plan;
      this.demod = new Demodulator(plan, {
        onFrame: (f) => void this.onFrame(f),
        onEvent: (m, l) => this.log(m, l),
        timeForSample: (n) => Date.now() - ((this.demodTotal - n) / plan.sr) * 1000,
      });
      this.graph.setTxGain(1);
      this.store.set({ plan, profile, fec, playable: { ok: playable.ok, warning: playable.warning }, error: '' });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'invalid air interface';
      this.store.set({ error: msg });
      this.log(msg, 'error');
    }
  }

  private onSamples(samples: Float32Array, absFrame: number): void {
    if (!this.demod) return;
    this.demodTotal = absFrame + samples.length;
    this.demod.push(samples);
    const rx = this.demod;
    const c = rx.counters;
    const prev = this.store.get();
    if (c.bodyOk !== prev.rx.counters.bodyOk || c.candidates !== prev.rx.counters.candidates || rx.state !== prev.rx.state) {
      const last = rx.lastFrame;
      this.store.set({
        rx: { state: rx.state, counters: { ...c }, lastError: rx.lastError },
        scope: {
          levelDb: last ? last.stats.levelDb : prev.scope.levelDb,
          noiseFloorDb: rx.noiseFloorDb,
          excessDb: rx.signalExcessDb(),
          snrDb: last ? last.stats.snrDb : prev.scope.snrDb,
          state: rx.state,
          ppm: last ? last.stats.timingPpm : prev.scope.ppm,
          lastConf: last ? last.stats.meanConf : prev.scope.lastConf,
          lastMinConf: last ? last.stats.minConf : prev.scope.lastMinConf,
        },
      });
    }
  }

  // ---- transmit ------------------------------------------------------------

  private nextMsgId(): number {
    this.txSeq = (this.txSeq % 254) + 1;
    return this.txSeq;
  }

  private get myNode(): number {
    return this.store.get().settings.node;
  }

  private header(h: { flags: number; target: number; msgId: number; chunkIdx: number; chunkCount: number }, bodyLen: number): FrameHeader {
    return { version: 1, flags: h.flags, sender: this.myNode, target: h.target, msgId: h.msgId, chunkIdx: h.chunkIdx, chunkCount: h.chunkCount, bodyLen };
  }

  /** Modulate one frame, emit it, and wait for its acknowledgement if ARQ is on. */
  private async sendFrame(payload: Uint8Array, hdr: { flags: number; target: number; msgId: number; chunkIdx: number; chunkCount: number }, opts: { ack?: boolean; attempts?: number; label?: string } = {}): Promise<boolean> {
    const plan = this.plan;
    if (!plan) throw new Error('no modulation plan');
    if (payload.length + this.crypto.overhead > plan.maxBody) {
      throw new Error(`payload of ${payload.length} bytes exceeds this profile's ${plan.maxBody - this.crypto.overhead} byte frame body`);
    }
    const sealed = await this.crypto.seal(payload, packHeader(plan, this.header(hdr, payload.length + this.crypto.overhead)));
    const wantsAck = (opts.ack ?? true) && this.store.get().settings.autoAck;
    const attempts = Math.max(1, opts.attempts ?? 3);
    let ok = false;
    for (let a = 0; a < attempts && !ok; a++) {
      if (this.abortFlag) break;
      const rendered = renderFrame(plan, sealed, this.header(hdr, sealed.length), {
        gain: plan.txGain,
        // Re-transmissions land on a different point of the symbol grid, which
        // decorrelates them from a fixed room response.
        leadSamples: plan.leadSamples + (a > 0 ? Math.floor(this.rand() * plan.L) : 0),
      });
      // The waiter goes on *before* the frame leaves, because an acknowledgement can
      // arrive the moment the tail does: on a device whose microphone is live while its
      // speaker is playing, "listen then wait" loses the reply that already came.
      const ackTimeoutMs = rendered.durationMs + Math.max(5000, Math.round(rendered.durationMs * 0.8) + 4000);
      const waiter = wantsAck ? this.armAck(hdr.msgId, hdr.chunkIdx, ackTimeoutMs) : null;
      await this.emit(rendered.wave);
      const st = this.store.get().stats;
      this.store.set({ stats: { ...st, framesSent: st.framesSent + 1, airSeconds: st.airSeconds + rendered.durationMs / 1000, bytesSent: st.bytesSent + payload.length } });
      if (!waiter) {
        ok = true;
        break;
      }
      ok = await waiter;
      if (!ok && a < attempts - 1) {
        const st2 = this.store.get().stats;
        this.store.set({ stats: { ...st2, retries: st2.retries + 1 } });
        this.log(`${opts.label ?? 'Frame'} unacknowledged - retransmitting (attempt ${a + 2}/${attempts}).`, 'warn');
      }
    }
    return ok;
  }

  /** Register the promise that `sendFrame` waits on for a given frame. */
  private armAck(msgId: number, chunkIdx: number, ms: number): Promise<boolean> {
    const key = `${msgId}:${chunkIdx}`;
    // An acknowledgement can be decoded before this waiter exists - on a device whose
    // microphone is live while its own speaker is still playing, that is normal. So the
    // answer is parked for a few seconds and consumed here if it already came.
    const late = this.lateAcks.get(key);
    if (late !== undefined) {
      this.lateAcks.delete(key);
      return Promise.resolve(late);
    }
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.awaiting.delete(key);
        resolve(false);
      }, Math.max(120, ms));
      this.awaiting.set(key, { resolve, timer });
    });
  }

  private settleAck(msgId: number, chunkIdx: number, good: boolean): boolean {
    const key = `${msgId}:${chunkIdx}`;
    const w = this.awaiting.get(key);
    if (!w) return false;
    clearTimeout(w.timer);
    this.awaiting.delete(key);
    w.resolve(good);
    return true;
  }

  /** Send a text message, split across frames when it is longer than one holds. */
  async sendText(text: string, targetNode?: number): Promise<{ ok: boolean; frames: number; airMs: number; bytes: number }> {
    const plan = this.plan;
    if (!plan) throw new Error('not ready');
    const trimmed = text.replace(/\r\n/g, '\n');
    const enc = new TextEncoder().encode(trimmed);
    const room = plan.chunkBody - this.crypto.overhead;
    if (room < 1) throw new Error('this air interface leaves no room for payload');
    this.abortFlag = false;
    const msgId = this.nextMsgId();
    const target = targetNode ?? HDR.BROADCAST;
    const flags = (this.crypto.ready ? FLAGS.ENCRYPTED : 0) | (this.store.get().settings.autoAck ? FLAGS.WANTS_ACK : 0);
    const t0 = performance.now();
    let ok: boolean;
    let frames = 1;
    this.store.set({ tx: { busy: true, label: 'Transmitting', done: 0, total: 1, error: undefined } });
    if (enc.length <= room) {
      ok = await this.sendFrame(packText(trimmed), { flags, target, msgId, chunkIdx: 0, chunkCount: 1 }, { label: 'message' });
    } else {
      const parts: Uint8Array[] = [];
      for (let at = 0; at < enc.length; at += room - 3) parts.push(enc.subarray(at, at + room - 3));
      frames = parts.length + 1;
      ok = await this.sendFrame(
        packManifest({ name: `text:${msgId}`, mime: 'text/plain; charset=utf-8', size: enc.length, chunks: parts.length, chunkSize: room - 3, sha256: new Uint8Array(0) }),
        { flags: flags | FLAGS.FILE | FLAGS.MANIFEST, target, msgId, chunkIdx: 255, chunkCount: parts.length },
        { label: 'text manifest' },
      );
      this.store.set({ tx: { busy: true, label: `Message · ${parts.length} frames`, done: 1, total: frames, error: undefined } });
      for (let i = 0; i < parts.length && ok && !this.abortFlag; i++) {
        const good = await this.sendFrame(packChunk(i, prefix(msgId, parts[i]!)), { flags: flags | FLAGS.FILE, target, msgId: this.nextMsgId(), chunkIdx: i & 0xff, chunkCount: parts.length }, { label: `text part ${i + 1}` });
        this.store.set({ tx: { busy: true, label: `Message · frame ${i + 2}/${frames}`, done: i + 2, total: frames, error: undefined } });
        if (!good) ok = false;
      }
    }
    const airMs = performance.now() - t0;
    this.store.set({ tx: { busy: false, label: ok ? 'Sent' : 'Send failed', done: frames, total: frames, error: ok ? undefined : 'no acknowledgement received' } });
    this.pushMessage({ dir: 'tx', kind: 'text', text: trimmed, from: this.myNode, to: target, msgId, secure: this.crypto.secure, error: ok ? undefined : 'no acknowledgement', stats: { airMs } });
    if (this.store.get().settings.saveTranscripts) this.persistTranscripts();
    this.log(ok ? `Sent ${enc.length} byte(s) over ${frames} frame(s) in ${(airMs / 1000).toFixed(1)} s.` : `Sent ${frames} frame(s); at least one was never acknowledged.`, ok ? 'ok' : 'error');
    return { ok, frames, airMs, bytes: enc.length };
  }

  async sendFile(file: { name: string; size: number; mime: string; bytes: Uint8Array }, targetNode?: number): Promise<{ ok: boolean; chunks: number }> {
    const plan = this.plan;
    if (!plan) throw new Error('not ready');
    this.abortFlag = false;
    const chunkSize = Math.max(8, plan.chunkBody - this.crypto.overhead - 5);
    const parts = chunkBytes(file.bytes, chunkSize);
    const msgId = this.nextMsgId();
    const sha = new Uint8Array(await crypto.subtle.digest('SHA-256', file.bytes as unknown as BufferSource));
    const id = `tx${msgId}`;
    const target = targetNode ?? HDR.BROADCAST;
    const flags = (this.crypto.ready ? FLAGS.ENCRYPTED : 0) | FLAGS.FILE | (this.store.get().settings.autoAck ? FLAGS.WANTS_ACK : 0);
    this.store.set({
      transfers: [
        ...this.store.get().transfers,
        { id, msgId, dir: 'tx', name: file.name, size: file.size, mime: file.mime, chunks: parts.length, chunkSize, have: [], missing: [], bytes: file.bytes, state: 'active', sha256: hex(sha), gotSha: '', startedAt: Date.now() },
      ],
    });
    this.pushMessage({ dir: 'tx', kind: 'file', text: `sending ${file.name} · ${file.size} bytes · ${parts.length} chunks`, from: this.myNode, to: target, msgId, secure: this.crypto.secure, fileId: id });
    let ok = await this.sendFrame(packManifest({ name: file.name, mime: file.mime, size: file.size, chunks: parts.length, chunkSize, sha256: sha }), { flags: flags | FLAGS.MANIFEST, target, msgId, chunkIdx: 255, chunkCount: parts.length }, { label: `manifest ${file.name}` });
    this.store.set({ tx: { busy: true, label: file.name, done: 0, total: parts.length } });
    for (let i = 0; i < parts.length && ok && !this.abortFlag; i++) {
      const good = await this.sendFrame(packChunk(i, prefix(msgId, parts[i]!)), { flags, target, msgId: this.nextMsgId(), chunkIdx: i & 0xff, chunkCount: parts.length }, { label: `chunk ${i + 1}/${parts.length}` });
      const t = this.store.get().transfers.find((x) => x.id === id);
      this.setTransfer(id, { have: good ? Array.from(new Set([...(t?.have ?? []), i])).sort((a, b) => a - b) : t?.have ?? [], missing: good ? t?.missing.filter((m) => m !== i) ?? [] : Array.from(new Set([...(t?.missing ?? []), i])).sort((a, b) => a - b) });
      this.store.set({ tx: { ...this.store.get().tx, done: i + 1 } });
      if (!good) ok = false;
    }
    this.setTransfer(id, { state: ok ? 'done' : 'failed', endedAt: Date.now(), error: ok ? undefined : 'unacknowledged chunk' });
    this.store.set({ tx: { busy: false, label: ok ? 'Sent' : 'Stalled', done: parts.length, total: parts.length, error: ok ? undefined : 'one or more chunks were never acknowledged' } });
    this.log(ok ? `"${file.name}" is on the air: ${parts.length} chunks, all acknowledged.` : `"${file.name}" stalled. The receiver can re-request the missing chunks.`, ok ? 'ok' : 'error');
    return { ok, chunks: parts.length };
  }

  /** Re-send chunks the other side NACKed. */
  private async resendChunks(transfer: Transfer, indices: number[]): Promise<void> {
    if (!transfer.bytes) return;
    const parts = chunkBytes(transfer.bytes, transfer.chunkSize);
    for (const i of indices) {
      const part = parts[i];
      if (!part) continue;
      await this.sendFrame(packChunk(i, prefix(transfer.msgId, part)), { flags: FLAGS.FILE | (this.store.get().settings.autoAck ? FLAGS.WANTS_ACK : 0), target: HDR.BROADCAST, msgId: this.nextMsgId(), chunkIdx: i & 0xff, chunkCount: transfer.chunks }, { ack: false, label: `re-send chunk ${i + 1}` });
    }
    this.log(`Re-sent ${indices.length} chunk(s) of "${transfer.name}".`, 'info');
  }

  /** The receiver asks for what it is missing, one NACK per gap. */
  async resendMissing(id: string): Promise<void> {
    const t = this.store.get().transfers.find((x) => x.id === id);
    if (!t) return;
    const have = new Set(t.have);
    const missing = Array.from({ length: t.chunks }, (_, i) => i).filter((i) => !have.has(i)).slice(0, 24);
    if (!missing.length) {
      this.log('Nothing to re-request: every chunk is present.', 'info');
      return;
    }
    this.setTransfer(id, { state: 'active', missing });
    for (const i of missing) {
      await this.sendFrame(packAck(KIND.NACK, t.msgId, i), { flags: FLAGS.NACK, target: HDR.BROADCAST, msgId: this.nextMsgId(), chunkIdx: 0, chunkCount: 1 }, { ack: false });
    }
    this.log(`Asked for ${missing.length} missing chunk(s) of "${t.name}".`, 'info');
  }

  /**
   * Feed the receiver a recording, exactly as the capture path would.
   *
   * A short silence is added on both sides because that is what a real transmission
   * looks like: a frame on the air is preceded by its lead-in and followed by its tail,
   * and a receiver designed for a continuous stream needs the same framing to tell two
   * consecutive frames apart. Handing over a bare concatenated buffer would be testing a
   * channel no device can produce.
   */
  feedSamples(wave: Float32Array): void {
    const gap = Math.round(this.sr * 0.06);
    const pre = new Float32Array(gap);
    const tail = new Float32Array(gap * 2);
    this.onSamples(pre, this.demodTotal);
    this.onSamples(wave, this.demodTotal);
    this.onSamples(tail, this.demodTotal);
  }

  /**
   * Put a frame on the air, then let whoever is supposed to hear it hear it.
   *
   * The local echo (the thing that makes single-device loopback mode a complete demo)
   * is skipped whenever a caller has wired `onEmit`: routing the transmitter to another
   * receiver is a deliberate choice, and hearing *both* your own frame and the peer's
   * answer in one stream would only overlap two transmissions the way a speaker aimed at
   * your own microphone would.
   */
  private async emit(wave: Float32Array): Promise<void> {
    const s = this.store.get().settings;
    const echoLocally = this.onEmit === null;
    this.onEmit?.(wave, this.sr);
    if (this.bc) {
      try {
        const copy = new Float32Array(wave).buffer;
        this.bc.postMessage({ type: 'wave', samples: copy, sender: this.myNode });
      } catch {
        /* ignore buffer transfer failure */
      }
    }
    if (s.capture === 'sim') {
      const preset = presetById(s.channelPreset);
      const model: ChannelModel = { ...preset.model, snrDb: s.snrDb };
      const noisy = applyChannel(wave, this.sr, model, this.rand);
      if (!echoLocally) return;
      this.simChain = this.simChain.then(() => {
        this.onSamples(noisy, this.demodTotal);
        const tail = new Float32Array(Math.round(this.sr * 0.06));
        this.onSamples(tail, this.demodTotal);
      });
      await this.simChain;
      return;
    }
    await this.graph.play(wave, { outputDeviceId: s.outputDeviceId, gain: s.muted ? 0 : 1 });
    if (s.capture === 'loopback' && echoLocally) {
      // The digital copy of exactly what left the speaker, so the loopback demo
      // exercises the same receive path (dedupe, ARQ, FEC) that the microphone does.
      this.onSamples(wave, this.demodTotal);
      this.onSamples(new Float32Array(2048), this.demodTotal);
    }
  }

  abort(): void {
    if (!this.store.get().tx.busy) return;
    this.abortFlag = true;
    for (const [, w] of this.awaiting) {
      clearTimeout(w.timer);
      w.resolve(false);
    }
    this.awaiting.clear();
    this.log('Stopping after the current frame…', 'warn');
  }

  // ---- receive -------------------------------------------------------------

  private async onFrame(f: RxFrame): Promise<void> {
    const plan = this.plan;
    if (!plan) return;
    const s = this.store.get().settings;
    const h = f.header;
    if (h.target !== HDR.BROADCAST && h.target !== s.node) return;
    const self = h.sender === s.node;
    const aad = packHeader(plan, h);
    let payload: Uint8Array | null = null;
    try {
      payload = await this.crypto.open(f.body, aad, h.sender);
    } catch {
      payload = null;
    }
    const st = this.store.get().stats;
    if (!payload) {
      this.store.set({ stats: { ...st, framesRejected: st.framesRejected + 1 } });
      if (this.crypto.ready) this.log(`Frame from node ${h.sender} failed authentication and was dropped.`, 'error');
      return;
    }
    const env = unpack(payload);
    if (!env) {
      this.store.set({ stats: { ...st, framesRejected: st.framesRejected + 1 } });
      this.log(`Frame from node ${h.sender} carried an unknown message type - is the other device on a different protocol version?`, 'warn');
      return;
    }
    this.store.set({
      stats: {
        ...this.store.get().stats,
        framesRecv: this.store.get().stats.framesRecv + 1,
        bytesRecv: this.store.get().stats.bytesRecv + f.body.length,
        fecSymbols: this.store.get().stats.fecSymbols + f.stats.corrected,
        erasureSymbols: this.store.get().stats.erasureSymbols + f.stats.erasures,
      },
    });
    this.notePeer(h.sender, f, self);
    if (self) {
      // Hearing your own transmission is a property of the path, not a second message:
      // count it, let loopback mode complete its acknowledgement, and keep it out of the
      // dedupe table so a real reply is never mistaken for a repeat.
      const st0 = this.store.get().stats;
      this.store.set({ stats: { ...st0, echoes: st0.echoes + 1 } });
      if (s.capture === 'mic') return;
    }
    const key = `${h.sender}:${h.msgId}:${h.chunkIdx}`;
    const dup = this.seen.has(key);
    this.seen.set(key, Date.now());
    if (this.seen.size > 1200) {
      const cutoff = Date.now() - 90000;
      for (const [k, t] of this.seen) if (t < cutoff) this.seen.delete(k);
    }
    // Anything the user should see is recorded before we answer: a transcript must not
    // depend on a packet that may still be dropped. A duplicate frame is not repeated
    // to the user, but it still gets an answer - the thing that got lost is often the
    // acknowledgement, not the message.
    if (env.kind === KIND.TEXT) {
      if (self) this.log(`Echo: heard my own ${f.body.length}-byte frame back on the receiver.`, 'info');
      else if (!dup) {
        this.pushMessage({ dir: 'rx', kind: 'text', text: env.text, from: h.sender, to: s.node, msgId: h.msgId, secure: this.crypto.secure && (h.flags & FLAGS.ENCRYPTED) !== 0, stats: { ...f.stats } });
        if (this.store.get().settings.saveTranscripts) this.persistTranscripts();
      }
    }
    await this.handleEnvelope(env, h, f, self);
  }

  private async handleEnvelope(env: CtrlEnvelope | ReturnType<typeof unpack> & object, h: FrameHeader, f: RxFrame, self: boolean): Promise<void> {
    void f;
    const e = env as NonNullable<ReturnType<typeof unpack>>;
    switch (e.kind) {
      case KIND.ACK:
      case KIND.NACK: {
        const st = this.store.get().stats;
        this.store.set({ stats: { ...st, acksRecv: st.acksRecv + 1 } });
        if (!this.settleAck(e.msgId, e.chunkIdx, e.kind === KIND.ACK)) {
          this.lateAcks.set(`${e.msgId}:${e.chunkIdx}`, e.kind === KIND.ACK);
          if (this.lateAcks.size > 64) this.lateAcks.clear();
        }
        if (e.kind === KIND.NACK && !self) {
          const t = this.store.get().transfers.find((x) => x.dir === 'tx' && x.msgId === e.msgId);
          if (t) await this.resendChunks(t, [e.chunkIdx]);
        }
        return;
      }
      case KIND.CTRL: {
        if (e.sub === CTRL.HELLO) {
          const name = new TextDecoder().decode(e.data).slice(0, 24);
          this.notePeerName(h.sender, name);
          if (!self) this.log(`Node ${h.sender} says it is "${name || 'unnamed'}".`, 'info');
          return;
        }
        if (e.sub === CTRL.BYE) {
          this.log(`Node ${h.sender} signed off.`, 'info');
          return;
        }
        if (e.sub === CTRL.PING) {
          if (!self) {
            this.log(`Node ${h.sender} sent a ping; replying with pong.`, 'info');
            await this.sendFrame(packPong(e.data.length >= 4 ? readU32BE(e.data, 0) : 0), { flags: FLAGS.CTRL, target: h.sender, msgId: this.nextMsgId(), chunkIdx: 0, chunkCount: 1 }, { ack: false, label: 'pong reply' });
          }
          return;
        }
        if (e.sub === CTRL.PONG) {
          const token = e.data.length >= 4 ? readU32BE(e.data, 0) : 0;
          this.settlePing(h.sender, token, f);
          return;
        }
        const reply = await this.crypto.handleCtrl(e as CtrlEnvelope);
        if (reply) await this.sendFrame(reply, { flags: FLAGS.CTRL, target: h.sender, msgId: this.nextMsgId(), chunkIdx: 0, chunkCount: 1 }, { ack: !self, attempts: 4, label: 'pairing step' });
        return;
      }
      case KIND.MANIFEST: {
        const id = `rx${h.msgId}`;
        if (this.store.get().transfers.some((t) => t.id === id)) {
          // A repeated manifest means our first answer never got there, so answer again
          // and keep the transfer exactly as it was.
          await this.ack(h, self);
          return;
        }
        if (e.size > FILE_LIMIT * 8) {
          this.log(`Inbound "${e.name}" is ${e.size} bytes - far past what should go through a loudspeaker. Refusing.`, 'error');
          return;
        }
        this.store.set({
          transfers: [
            ...this.store.get().transfers,
            { id, msgId: h.msgId, dir: 'rx', name: e.name, size: e.size, mime: e.mime, chunks: e.chunks, chunkSize: e.chunkSize, have: [], missing: [], bytes: new Uint8Array(e.size), state: 'active', sha256: hex(e.sha256), gotSha: '', startedAt: Date.now() },
          ],
        });
        if (e.mime.startsWith('text/plain') && e.name.startsWith('text:')) {
          // Long text messages arrive as a manifest + parts; the parts reassemble in
          // completeText() and this placeholder keeps the transcript readable.
          this.log(`Incoming ${e.chunks}-part message from node ${h.sender}.`, 'info');
        } else {
          this.pushMessage({ dir: 'rx', kind: 'file', text: `incoming ${e.name} (${e.size} bytes, ${e.chunks} chunks)`, from: h.sender, to: this.myNode, msgId: h.msgId, secure: this.crypto.secure, fileId: id });
        }
        await this.ack(h, self);
        return;
      }
      case KIND.CHUNK: {
        const tid = (e.data[0]! << 8) | e.data[1]!;
        const body = e.data.subarray(2);
        const t = this.store.get().transfers.find((x) => x.dir === 'rx' && x.msgId === tid && x.state !== 'cancelled');
        if (!t) {
          this.log(`Chunk ${e.index} for an unknown transfer (${tid}); the manifest has not arrived.`, 'warn');
          return;
        }
        if (t.bytes) {
          const at = e.index * t.chunkSize;
          t.bytes.set(body.subarray(0, Math.min(body.length, t.bytes.length - at)), at);
        }
        const have = Array.from(new Set([...t.have, e.index])).sort((a, b) => a - b);
        this.setTransfer(t.id, { have });
        await this.ack(h, self);
        if (have.length >= t.chunks) {
          if (t.mime.startsWith('text/plain') && t.name.startsWith('text:')) await this.completeText(t.id, h.sender);
          else await this.completeTransfer(t.id);
        }
        return;
      }
      case KIND.TEXT: {
        await this.ack(h, self);
        return;
      }
    }
  }

  private async ack(h: FrameHeader, self: boolean): Promise<void> {
    if (!this.store.get().settings.autoAck) return;
    if (self && this.store.get().settings.capture === 'mic') return;
    const st = this.store.get().stats;
    this.store.set({ stats: { ...st, acksSent: st.acksSent + 1 } });
    await this.sendFrame(packAck(KIND.ACK, h.msgId, h.chunkIdx), { flags: FLAGS.ACK, target: h.sender, msgId: this.nextMsgId(), chunkIdx: 0, chunkCount: 1 }, { ack: false });
  }

  private async completeText(id: string, from: number): Promise<void> {
    const t = this.store.get().transfers.find((x) => x.id === id);
    if (!t || !t.bytes) return;
    const text = new TextDecoder('utf-8').decode(t.bytes.subarray(0, t.size));
    this.setTransfer(id, { state: 'done', endedAt: Date.now(), bytes: null });
    this.pushMessage({ dir: 'rx', kind: 'text', text, from, to: this.myNode, msgId: t.msgId, secure: this.crypto.secure });
    if (this.store.get().settings.saveTranscripts) this.persistTranscripts();
    this.log(`Reassembled a ${t.chunks}-part message from node ${from}.`, 'ok');
  }

  private async completeTransfer(id: string): Promise<void> {
    const t = this.store.get().transfers.find((x) => x.id === id);
    if (!t || !t.bytes) return;
    const data = t.bytes.slice(0, t.size);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data as unknown as BufferSource));
    const got = hex(digest);
    if (t.sha256 && got !== t.sha256) {
      const have = new Set(t.have);
      const missing = Array.from({ length: t.chunks }, (_, i) => i).filter((i) => !have.has(i));
      this.setTransfer(id, { state: 'failed', gotSha: got, error: 'SHA-256 mismatch', missing });
      this.log(`"${t.name}" did not match its checksum. ${missing.length} chunk(s) look absent - re-request them.`, 'error');
      return;
    }
    let url: string | undefined;
    try {
      if (typeof URL !== 'undefined' && typeof Blob !== 'undefined' && 'createObjectURL' in URL) url = URL.createObjectURL(new Blob([data as unknown as BlobPart], { type: t.mime || 'application/octet-stream' }));
    } catch {
      url = undefined; // no object URLs here; the transfer is still verified and reported
    }
    this.setTransfer(id, { state: 'done', gotSha: got, url, bytes: data, endedAt: Date.now() });
    this.pushMessage({ dir: 'rx', kind: 'file', text: `received ${t.name} · ${t.size} bytes · SHA-256 verified`, from: 0, to: this.myNode, msgId: t.msgId, secure: this.crypto.secure, fileId: id });
    this.log(`"${t.name}" received intact - the SHA-256 digest matches.`, 'ok');
  }

  private setTransfer(id: string, patch: Partial<Transfer>): void {
    this.store.set({ transfers: this.store.get().transfers.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  }

  cancelTransfer(id: string): void {
    this.setTransfer(id, { state: 'cancelled', endedAt: Date.now() });
    this.log('Transfer cancelled; nothing was kept.', 'warn');
  }

  // ---- capture / devices ---------------------------------------------------

  async startCapture(): Promise<boolean> {
    const s = this.store.get().settings;
    const ok = await this.graph.startCapture(s.capture, s.inputDeviceId);
    if (ok && s.outputDeviceId) await this.graph.setOutputDevice(s.outputDeviceId);
    this.demod?.reset();
    return ok;
  }

  stopCapture(): void {
    this.graph.stopCapture();
    if (this.beaconTimer) {
      clearInterval(this.beaconTimer);
      this.beaconTimer = null;
    }
  }

  async setBeacon(on: boolean): Promise<void> {
    this.setSettings({ beacon: on });
    if (this.beaconTimer) clearInterval(this.beaconTimer);
    this.beaconTimer = null;
    if (!on) return;
    const beat = (): void => {
      void this.sendFrame(packCtrl(CTRL.HELLO, new TextEncoder().encode(this.store.get().settings.name)), { flags: FLAGS.BEACON | FLAGS.CTRL, target: HDR.BROADCAST, msgId: this.nextMsgId(), chunkIdx: 0, chunkCount: 1 }, { ack: false }).catch(() => undefined);
    };
    beat();
    this.beaconTimer = setInterval(beat, 20000);
    this.log('Announcing this node on the air every 20 s.', 'info');
  }

  async announce(): Promise<void> {
    await this.sendFrame(packCtrl(CTRL.HELLO, new TextEncoder().encode(this.store.get().settings.name)), { flags: FLAGS.BEACON | FLAGS.CTRL, target: HDR.BROADCAST, msgId: this.nextMsgId(), chunkIdx: 0, chunkCount: 1 }, { ack: false });
    this.log('Said hello on the air.', 'ok');
  }

  async toggleWakeLock(): Promise<void> {
    if (this.wakeLock) {
      await this.wakeLock.release().catch(() => undefined);
      this.wakeLock = null;
      this.setSettings({ keepAwake: false });
      this.store.set({ wakeLock: false });
      this.log('Wake lock released.', 'info');
      return;
    }
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } };
    if (!nav.wakeLock) {
      this.log('No Wake Lock API here, so the screen may sleep mid-transfer. Keep the tab open and the brightness up.', 'warn');
      return;
    }
    try {
      this.wakeLock = await nav.wakeLock.request('screen');
      this.setSettings({ keepAwake: true });
      this.store.set({ wakeLock: true });
      this.log('Wake lock held: the screen will stay on while the modem runs.', 'ok');
    } catch {
      this.log('The browser refused the wake lock.', 'warn');
    }
  }

  // ---- security ------------------------------------------------------------

  async setPassphrase(pass: string): Promise<string | null> {
    try {
      await this.crypto.setPassphrase(pass);
      this.publishCrypto();
      this.log('Channel key derived in-browser with PBKDF2-SHA256. It is non-extractable and lives only in memory.', 'ok');
      return null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'could not derive a key';
      this.log(msg, 'error');
      return msg;
    }
  }

  clearKey(): void {
    this.crypto.burn();
    this.publishCrypto();
    this.log('Key material destroyed. Frames already sent stay unreadable to anyone else, and the channel is open again.', 'warn');
  }

  async startPairing(initiator: boolean): Promise<void> {
    this.pairRole = initiator ? 'initiator' : 'responder';
    const msg = await this.crypto.startPairing(initiator);
    this.publishCrypto();
    if (msg) {
      this.log('Commitment on the air; waiting for the challenge…', 'info');
      await this.sendFrame(msg, { flags: FLAGS.CTRL, target: HDR.BROADCAST, msgId: this.nextMsgId(), chunkIdx: 0, chunkCount: 1 }, { ack: true, attempts: 4, label: 'pairing commitment' });
    } else {
      this.log('Listening for a pairing commitment.', 'info');
    }
  }

  confirmPairing(ok: boolean): void {
    if (ok) this.crypto.confirmPairing();
    else {
      this.crypto.burn();
      this.log('Codes did not match: key material destroyed, nothing was trusted. Start the handshake again.', 'error');
    }
    this.publishCrypto();
  }

  private publishCrypto(): void {
    const snap = (): AppModel['crypto'] => ({
      mode: this.crypto.mode,
      label: this.crypto.statusLabel,
      secure: this.crypto.secure,
      sas: this.crypto.sas ?? '',
      pairState: this.crypto.pairState,
      role: this.pairRole,
      fingerprint: this.store.get().crypto.fingerprint,
    });
    // The flags update synchronously so a caller that just derived a key sees it
    // immediately; only the fingerprint digest, which needs a microtask, follows.
    this.store.set({ crypto: snap() });
    void this.crypto.fingerprint().then((fp) => this.store.set({ crypto: { ...this.store.get().crypto, fingerprint: fp ?? '' } }));
  }

  // ---- measurement ---------------------------------------------------------

  /** Tune profile + FEC to the room model (Signal Lab button, also used by tests). */
  async runAdapt(frames: number, profiles?: string[], fecLevels?: string[], apply = true): Promise<AdaptResult[]> {
    const s = this.store.get().settings;
    const preset = presetById(s.channelPreset);
    this.store.set({ selftest: { running: true, label: `tuning ${preset.name} · ${frames} frames per candidate`, progress: 0, results: [], picked: null, error: undefined } });
    try {
      const results = await sweep({
        sr: this.sr,
        channel: { ...preset.model, snrDb: s.snrDb },
        frames,
        profiles,
        fecLevels,
        coalesce: true,
        payloadBytes: 40,
        onProgress: (done, total) => this.store.set({ selftest: { ...this.store.get().selftest, progress: done / total } }),
      });
      const best = results[0] ?? null;
      this.store.set({ selftest: { running: false, label: best && best.delivered === best.frames ? `clean: ${best.profileName} + ${best.fecName} FEC` : 'no configuration held every frame', progress: 1, results, picked: best, at: Date.now() } });
      if (best && best.delivered === best.frames && apply) {
        this.setSettings({ profileId: best.profileId, fecId: best.fecId });
        this.log(`Adapted to ${best.profileName} + ${best.fecName} FEC: ${best.delivered}/${best.frames} frames, ${best.throughputBps.toFixed(0)} bps.`, 'ok');
      } else if (best) {
        this.log(`Best candidate measured: ${best.profileName} + ${best.fecName} at ${best.delivered}/${best.frames} frames.`, best.delivered === best.frames ? 'ok' : 'warn');
      } else {
        this.log('Nothing was flawless in that channel. The ranking is in the Signal Lab - back off the gain, move closer, or send a WAV.', 'warn');
      }
      return results;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'tuning failed';
      this.store.set({ selftest: { running: false, label: msg, progress: 1, results: [], picked: null, error: msg } });
      return [];
    }
  }

  /** Every profile against every room model, at the current FEC. The reliability map. */
  async runMatrix(frames: number): Promise<void> {
    const s = this.store.get().settings;
    const fec = fecById(s.fecId);
    const cells: MatrixCell[] = [];
    const chans = CHANNEL_PRESETS;
    const total = chans.length;
    this.store.set({ selftest: { running: true, label: `reliability map: ${PROFILES.length} air interfaces × ${total} rooms`, progress: 0, results: this.store.get().selftest.results, picked: this.store.get().selftest.picked, matrix: [] } as SelfTest & { matrix?: MatrixCell[] } });
    for (let ci = 0; ci < chans.length; ci++) {
      const preset = chans[ci]!;
      const results = await sweep({ sr: this.sr, channel: { ...preset.model, snrDb: s.snrDb }, frames, fecLevels: [s.fecId], coalesce: true, payloadBytes: 40, onProgress: (d, t) => this.store.set({ selftest: { ...this.store.get().selftest, progress: (ci + d / t) / total } }) });
      for (const r of results) cells.push({ profileId: r.profileId, profileName: r.profileName, channelId: preset.id, channelName: preset.name, delivered: r.delivered, frames: r.frames, bps: r.throughputBps, fec: fec.name });
      this.store.set({ matrix: [...cells] });
    }
    this.store.set({ selftest: { ...this.store.get().selftest, running: false, progress: 1, label: `reliability map done at ${fec.name} FEC`, at: Date.now() } });
    const perfect = cells.filter((c) => c.delivered === c.frames).length;
    this.log(`Reliability map: ${perfect}/${cells.length} combinations delivered every frame with ${fec.name} FEC.`, perfect === cells.length ? 'ok' : 'warn');
  }

  /** Export the current message as a WAV the other device can play at it. */
  async encodeWavFor(text: string): Promise<{ bytes: Uint8Array; ms: number; frames: number; bytesOut: number }> {
    const plan = this.plan;
    if (!plan) throw new Error('not ready');
    const enc = new TextEncoder().encode(text);
    const room = plan.chunkBody - this.crypto.overhead;
    const parts: Uint8Array[] = [];
    for (let at = 0; at < enc.length; at += Math.max(1, room)) parts.push(enc.subarray(at, at + Math.max(1, room)));
    if (!parts.length) parts.push(new TextEncoder().encode(''));
    const chunks: Float32Array[] = [];
    let ms = 0;
    for (const p of parts) {
      const msgId = this.nextMsgId();
      const i = parts.indexOf(p);
      const body = parts.length === 1 ? packText(new TextDecoder().decode(p)) : packChunk(i, prefix(msgId, p));
      const flags = FLAGS.WANTS_ACK | (this.crypto.ready ? FLAGS.ENCRYPTED : 0) | (parts.length === 1 ? 0 : FLAGS.FILE) | (parts.length === 1 ? 0 : FLAGS.MANIFEST);
      // Exported audio is sealed exactly like live audio: a WAV of a keyed conversation
      // must not be a plaintext copy of it.
      const hdr = this.header({ flags, target: HDR.BROADCAST, msgId, chunkIdx: i, chunkCount: parts.length }, body.length + this.crypto.overhead);
      const sealed = await this.crypto.seal(body, packHeader(plan, hdr));
      const rendered = renderFrame(plan, sealed, { ...hdr, bodyLen: sealed.length }, { gain: plan.txGain });
      chunks.push(rendered.wave);
      ms += rendered.durationMs + 120;
    }
    const total = new Float32Array(Math.floor((ms / 1000) * plan.sr));
    let at = 0;
    for (const c of chunks) {
      total.set(c, at);
      at += c.length + Math.floor((120 / 1000) * plan.sr);
    }
    return { bytes: encodeWav(total, plan.sr), ms, frames: parts.length, bytesOut: total.length };
  }

  /** Decode a WAV dropped onto the app, then report how faithful it was. */
  async decodeWavBytes(bytes: Uint8Array): Promise<{ frames: number; detail: string }> {
    let wave: Float32Array;
    let sr: number;
    try {
      const w = decodeWav(bytes);
      wave = w.samples;
      sr = w.sampleRate;
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'not a WAV file';
      this.log(`Could not read that file: ${msg}`, 'error');
      return { frames: 0, detail: msg };
    }
    const s = this.store.get().settings;
    const plan = makePlan(profileById(s.profileId), sr, { bodyParity: fecById(s.fecId).bodyParity, headerParity: fecById(s.fecId).headerParity });
    const frames = decodeRecording(wave, sr, plan);
    for (const f of frames) await this.onFrame({ ...f, header: { ...f.header, sender: f.header.sender === s.node ? 254 : f.header.sender } });
    const delta = signalDelta(wave, wave);
    this.log(`Read ${frames.length} frame(s) from a ${sr} Hz file (self-delta ${delta.toFixed(2)}).`, frames.length ? 'ok' : 'warn');
    return { frames: frames.length, detail: `${frames.length} frame(s), ${sr} Hz, ${(wave.length / sr).toFixed(2)} s` };
  }

  /** Encode then decode without touching a device: proves the modem, not the room. */
  async roundTrip(text: string, channel?: string): Promise<{ ok: boolean; detail: string }> {
    const plan = this.plan;
    if (!plan) return { ok: false, detail: 'not ready' };
    const body = packText(text);
    const msgId = this.nextMsgId();
    const hdr = this.header({ flags: 0, target: HDR.BROADCAST, msgId, chunkIdx: 0, chunkCount: 1 }, body.length + this.crypto.overhead);
    const sealed = await this.crypto.seal(body, packHeader(plan, hdr));
    const rendered = renderFrame(plan, sealed, { ...hdr, bodyLen: sealed.length }, { gain: plan.txGain });
    const model = { ...presetById(channel ?? this.store.get().settings.channelPreset).model, snrDb: this.store.get().settings.snrDb };
    const noisy = applyChannel(rendered.wave, plan.sr, model, this.rand);
    const frames = decodeRecording(noisy, plan.sr, plan);
    let ok = false;
    for (const f of frames) {
      const opened = await this.crypto.open(f.body, packHeader(plan, f.header), this.myNode);
      if (!opened) continue;
      const env = unpack(opened);
      if (env && env.kind === KIND.TEXT && env.text === text.replace(/\r\n/g, '\n')) ok = true;
    }
    const first = frames[0];
    const detail = `${frames.length} frame(s) found, ${ok ? 'payload bit-exact' : 'payload did not match'}${first ? `, snr ${first.stats.snrDb.toFixed(1)} dB, conf ${first.stats.meanConf.toFixed(1)}` : ''}`;
    // Also feed to live demodulator so the waterfall and scope light up
    this.feedSamples(noisy);
    return { ok, detail };
  }

  /** Inject an inbound simulated transmission from a remote node through the channel model. */
  async simulateInbound(text = 'Signal link check: all systems operational', fromNode?: number): Promise<{ ok: boolean; frames: number }> {
    const plan = this.plan;
    if (!plan) return { ok: false, frames: 0 };
    const sender = fromNode ?? (this.myNode === 42 ? 43 : 42);
    const body = packText(text);
    const msgId = this.nextMsgId();
    const hdr: FrameHeader = { version: 1, flags: 0, sender, target: this.myNode, msgId, chunkIdx: 0, chunkCount: 1, bodyLen: body.length };
    const rendered = renderFrame(plan, body, hdr, { gain: plan.txGain });
    const model = { ...presetById(this.store.get().settings.channelPreset).model, snrDb: this.store.get().settings.snrDb };
    const noisy = applyChannel(rendered.wave, plan.sr, model, this.rand);
    this.feedSamples(noisy);
    this.log(`Injected simulated transmission from node ${sender} through ${presetById(this.store.get().settings.channelPreset).name} room model.`, 'info');
    return { ok: true, frames: 1 };
  }

  /** Feed the receiver a recorded file's samples for lab display. */
  analyzeWave(wave: Float32Array): { found: number; ppm: number; snrDb: number } {
    const plan = this.plan;
    if (!plan) return { found: 0, ppm: 0, snrDb: 0 };
    const frames = decodeRecording(wave, plan.sr, plan);
    const f = frames[0];
    return { found: frames.length, ppm: f?.stats.timingPpm ?? 0, snrDb: f?.stats.snrDb ?? 0 };
  }

  // ---- misc ----------------------------------------------------------------

  private pushMessage(m: Omit<MsgItem, 'id' | 't'>): void {
    const item: MsgItem = { ...m, id: `m${msgSeq++}`, t: Date.now() };
    const list = [...this.store.get().messages, item];
    this.store.set({ messages: list.length > MAX_MESSAGES ? list.slice(list.length - MAX_MESSAGES) : list });
  }

  private persistTranscripts(): void {
    const items: StoredTranscript[] = this.store.get()
      .messages.filter((m) => m.kind === 'text')
      .map((m) => ({ t: m.t, dir: m.dir, from: m.from, to: m.to, text: m.text, kind: m.kind, secure: m.secure }));
    saveTranscripts(items);
  }

  clearTranscripts(): void {
    clearTranscripts();
    this.store.set({ messages: [] });
    this.log('Transcript cleared from this device.', 'info');
  }

  resetStats(): void {
    this.store.set({ stats: emptyStats(), transfers: [] });
    this.demod?.reset(true);
    this.log('Counters zeroed.', 'info');
  }

  private notePeer(node: number, f: RxFrame, self: boolean): void {
    const peers = this.store.get().peers;
    const i = peers.findIndex((p) => p.node === node);
    const cur = i >= 0 ? peers[i]! : { node, name: `node ${node}`, framesOk: 0, lastSnrDb: 0, lastLevelDb: -120, lastSeen: 0, secure: false };
    const next: PeerInfo = { ...cur, framesOk: cur.framesOk + (self ? 0 : 1), lastSnrDb: f.stats.snrDb, lastLevelDb: f.stats.levelDb, lastSeen: Date.now(), secure: this.crypto.secure };
    const copy = [...peers];
    if (i >= 0) copy[i] = next;
    else copy.push(next);
    this.store.set({ peers: copy.sort((a, b) => b.lastSeen - a.lastSeen) });
  }

  private notePeerName(node: number, name: string): void {
    const trimmed = name.trim();
    if (!trimmed) return;
    this.store.set({ peers: this.store.get().peers.map((p) => (p.node === node ? { ...p, name: trimmed } : p)) });
  }

  log(msg: string, level: LogLevel = 'info'): void {
    const entry: LogEntry = { id: logSeq++, t: Date.now(), level, msg };
    const list = [...this.store.get().logs, entry];
    this.store.set({ logs: list.length > 400 ? list.slice(list.length - 400) : list });
  }

  get demodulator(): Demodulator | null {
    return this.demod;
  }

  get audio(): AudioGraph {
    return this.graph;
  }

  get profileList(): Profile[] {
    return PROFILES;
  }

  get fecList(): FecLevel[] {
    return FEC_LEVELS;
  }

  get channelList(): { id: string; name: string; blurb: string }[] {
    return CHANNEL_PRESETS.map((c) => ({ id: c.id, name: c.name, blurb: c.blurb }));
  }

  describeChannel(): string {
    const s = this.store.get().settings;
    return describeChannel({ ...presetById(s.channelPreset).model, snrDb: s.snrDb });
  }

  /** Ping a remote node or broadcast to measure round-trip latency and link SNR. */
  async ping(targetNode?: number): Promise<PingResult> {
    const plan = this.plan;
    if (!plan) return { ok: false, target: 0, rttMs: 0, snrDb: 0, levelDb: -120, corrected: 0, quality: 'failed', t: Date.now(), error: 'modem not ready' };
    const target = targetNode ?? (this.store.get().peers[0]?.node ?? HDR.BROADCAST);
    const token = Math.floor(Math.random() * 0xffffffff) >>> 0;
    this.log(`Sending ping to ${target === HDR.BROADCAST ? 'all nodes (broadcast)' : `node ${target}`}…`, 'info');
    this.store.set({ tx: { busy: true, label: `Ping node ${target}`, done: 0, total: 1 } });

    const pingPromise = new Promise<PingResult>((resolve) => {
      const timer = setTimeout(() => {
        this.awaitingPing.delete(token);
        const res: PingResult = {
          ok: false,
          target,
          rttMs: 0,
          snrDb: 0,
          levelDb: -120,
          corrected: 0,
          quality: 'failed',
          t: Date.now(),
          error: `Ping to node ${target} timed out (no reply)`,
        };
        this.store.set({ lastPing: res, tx: { busy: false, label: 'Ping timed out', done: 1, total: 1 } });
        this.log(`Ping to node ${target} timed out.`, 'warn');
        resolve(res);
      }, Math.max(7000, plan.L * 30 + 5000));
      this.awaitingPing.set(token, { resolve, timer, t0: performance.now(), target });
    });

    const payload = packPing(token);
    try {
      await this.sendFrame(payload, { flags: FLAGS.CTRL, target, msgId: this.nextMsgId(), chunkIdx: 0, chunkCount: 1 }, { ack: false, label: 'ping packet' });
      // In local loopback/sim mode without external peers, simulate an inbound pong response
      if ((this.store.get().settings.capture === 'loopback' || this.store.get().settings.capture === 'sim') && this.onEmit === null) {
        setTimeout(() => {
          const pongPayload = packPong(token);
          const pongHdr: FrameHeader = { version: 1, flags: FLAGS.CTRL, sender: target === HDR.BROADCAST ? (this.myNode === 42 ? 43 : 42) : target, target: this.myNode, msgId: this.nextMsgId(), chunkIdx: 0, chunkCount: 1, bodyLen: pongPayload.length };
          const renderedPong = renderFrame(plan, pongPayload, pongHdr, { gain: plan.txGain });
          this.feedSamples(renderedPong.wave);
        }, 120);
      }
    } catch (err) {
      const w = this.awaitingPing.get(token);
      if (w) {
        clearTimeout(w.timer);
        this.awaitingPing.delete(token);
      }
      this.store.set({ tx: { busy: false, label: 'Ping failed', done: 0, total: 1 } });
      const res: PingResult = {
        ok: false,
        target,
        rttMs: 0,
        snrDb: 0,
        levelDb: -120,
        corrected: 0,
        quality: 'failed',
        t: Date.now(),
        error: err instanceof Error ? err.message : 'transmission error',
      };
      this.store.set({ lastPing: res });
      return res;
    }

    return pingPromise;
  }

  private settlePing(sender: number, token: number, f: RxFrame): void {
    const w = this.awaitingPing.get(token);
    if (!w) return;
    clearTimeout(w.timer);
    this.awaitingPing.delete(token);
    const rttMs = Math.max(1, Math.round(performance.now() - w.t0));
    const snr = f.stats.snrDb;
    const quality: PingResult['quality'] =
      snr >= 18 && f.stats.corrected === 0 ? 'excellent' : snr >= 12 ? 'good' : snr >= 6 ? 'fair' : 'poor';
    const res: PingResult = {
      ok: true,
      target: sender,
      rttMs,
      snrDb: snr,
      levelDb: f.stats.levelDb,
      corrected: f.stats.corrected,
      quality,
      t: Date.now(),
    };
    this.store.set({ lastPing: res, tx: { busy: false, label: `Pong received (${rttMs} ms)`, done: 1, total: 1 } });
    this.log(`🏓 Ping reply from node ${sender}: RTT ${rttMs} ms · SNR ${snr.toFixed(1)} dB · Quality: ${quality}`, 'ok');
    this.pushMessage({
      dir: 'rx',
      kind: 'note',
      text: `🏓 Ping reply from node ${sender}: ${rttMs} ms round-trip · ${snr.toFixed(1)} dB SNR · quality: ${quality}`,
      from: sender,
      to: this.myNode,
      msgId: 0,
      secure: false,
      stats: { ...f.stats, airMs: rttMs },
    });
    w.resolve(res);
  }

  toggleMute(): void {
    const next = !this.store.get().settings.muted;
    this.setSettings({ muted: next });
    this.log(`Modem audio output ${next ? 'muted (silent)' : 'unmuted (audible)'}.`, 'info');
  }

  exportTranscript(): void {
    const msgs = this.store.get().messages;
    if (!msgs.length) {
      this.log('Transcript is empty; nothing to export.', 'info');
      return;
    }
    const lines = [
      `Tonebridge Acoustic Link Transcript`,
      `Exported at: ${new Date().toISOString()}`,
      `Node: ${this.myNode} (${this.store.get().settings.name})`,
      `Profile: ${this.store.get().profile?.name ?? 'standard'} · FEC: ${this.store.get().fec?.name ?? 'balanced'}`,
      `----------------------------------------`,
      ...msgs.map((m) => {
        const time = new Date(m.t).toLocaleTimeString();
        const dir = m.dir === 'tx' ? `[TX] Me → Node ${m.to}` : `[RX] Node ${m.from} → Me`;
        const snr = m.stats?.snrDb !== undefined ? ` [SNR: ${m.stats.snrDb.toFixed(1)} dB]` : '';
        const sec = m.secure ? ' [SEALED]' : '';
        return `[${time}] ${dir}${sec}${snr}: ${m.text}`;
      }),
    ];
    const text = lines.join('\n');
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tonebridge-transcript-${Date.now()}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    this.log(`Exported transcript (${msgs.length} messages) to text file.`, 'ok');
  }
}

/** Small helpers, kept private to this module. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(v)));
}

function prefix(id: number, bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(2 + bytes.length);
  out[0] = (id >> 8) & 0xff;
  out[1] = id & 0xff;
  out.set(bytes, 2);
  return out;
}


