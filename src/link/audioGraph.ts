/**
 * Audio graph: microphone in, speaker out, one place where every browser quirk lives.
 *
 * Three capture sources exist because devices differ more than protocols do:
 *   mic      - real acoustics, the honest path (needs permission)
 *   loopback - the transmit bus is patched into the receiver digitally: no microphone,
 *              no permission prompt, still the exact same modulator and demodulator
 *   sim      - the transmit bus goes through the channel model before the receiver,
 *              so a noisy room can be tested on a silent desk
 *
 * If AudioWorklet is missing (very old Safari) a ScriptProcessor is used for capture
 * only; the demodulation never runs on the audio thread either way.
 */

export type CaptureSource = 'mic' | 'loopback' | 'sim';

export interface GraphEvents {
  onSamples: (samples: Float32Array, absFrame: number) => void;
  onState: (s: GraphState) => void;
  onLog: (msg: string, level?: 'info' | 'ok' | 'warn' | 'error') => void;
}

export interface GraphState {
  running: boolean;
  mic: 'off' | 'requesting' | 'on' | 'denied' | 'unsupported';
  sampleRate: number;
  capture: CaptureSource;
  worklet: boolean;
  outputDevice: string | null;
  inputs: MediaDeviceInfo[];
  outputs: MediaDeviceInfo[];
}

export class AudioGraph {
  ctx: AudioContext | null = null;
  analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private micNode: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private fallback: ScriptProcessorNode | null = null;
  private silent: GainNode | null = null;
  private txGain: GainNode | null = null;
  private loopTap: GainNode | null = null;
  private events: GraphEvents;
  private sinkElement: HTMLAudioElement | null = null;
  private sinkDest: MediaStreamAudioDestinationNode | null = null;
  /** Set while a TX is scheduled, so loopback can route it into the receiver. */
  private txActive = false;

  state: GraphState = {
    running: false,
    mic: 'off',
    sampleRate: 48000,
    capture: 'loopback',
    worklet: false,
    outputDevice: null,
    inputs: [],
    outputs: [],
  };

  constructor(events: GraphEvents) {
    this.events = events;
  }

  get supported(): boolean {
    return typeof window !== 'undefined' && !!(window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext);
  }

  async ensureContext(): Promise<AudioContext> {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      return this.ctx;
    }
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) throw new Error('Web Audio is not available in this browser');
    const ctx = new Ctor({ latencyHint: 'interactive' });
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
    this.ctx = ctx;
    this.state = { ...this.state, sampleRate: ctx.sampleRate };
    // A silent path keeps the graph alive on browsers that throttle silent contexts,
    // and gives the transmitter somewhere to connect that we can also tap.
    this.silent = ctx.createGain();
    this.silent.gain.value = 0;
    this.silent.connect(ctx.destination);
    this.txGain = ctx.createGain();
    this.txGain.gain.value = 1;
    this.loopTap = ctx.createGain();
    this.loopTap.gain.value = 1;
    this.loopTap.connect(ctx.destination);
    this.txGain.connect(this.loopTap);
    this.loopTap.connect(this.silent);
    void this.detectDevices();
    this.events.onState({ ...this.state });
    return ctx;
  }

  async detectDevices(): Promise<void> {
    if (!navigator.mediaDevices?.enumerateDevices) {
      this.events.onLog('This browser will not list audio devices; using the system default.', 'warn');
      return;
    }
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      this.state = {
        ...this.state,
        inputs: all.filter((d) => d.kind === 'audioinput'),
        outputs: all.filter((d) => d.kind === 'audiooutput'),
      };
      this.events.onState({ ...this.state });
    } catch {
      /* permission is needed for labels; the default device still works */
    }
  }

  setTxGain(v: number): void {
    if (this.txGain) this.txGain.gain.value = Math.max(0, Math.min(1, v));
  }

  /** Route TX into the receiver digitally. Called by the engine for loopback mode. */
  feedLoopback(samples: Float32Array, absFrame: number): void {
    this.events.onSamples(samples, absFrame);
  }

  async startCapture(source: CaptureSource, deviceId: string | null): Promise<boolean> {
    const ctx = await this.ensureContext();
    this.stopCapture();
    this.state = { ...this.state, capture: source };
    if (source === 'loopback') {
      // The transmitter bus is already connected; nothing to open, so no prompt.
      this.state = { ...this.state, running: true, mic: 'off' };
      this.events.onState({ ...this.state });
      return true;
    }
    if (source === 'sim') {
      this.state = { ...this.state, running: true, mic: 'off' };
      this.events.onState({ ...this.state });
      return true;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      this.state = { ...this.state, mic: 'unsupported' };
      this.events.onState({ ...this.state });
      this.events.onLog('getUserMedia is unavailable here. Switch capture to loopback or the room simulator.', 'error');
      return false;
    }
    this.state = { ...this.state, mic: 'requesting' };
    this.events.onState({ ...this.state });
    const base: MediaTrackConstraints = {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    };
    let stream: MediaStream | null = null;
    const attempts: MediaStreamConstraints[] = deviceId
      ? [{ audio: { ...base, deviceId: { exact: deviceId } }, video: false }, { audio: { ...base, deviceId: { ideal: deviceId } }, video: false }, { audio: base, video: false }, { audio: true, video: false }]
      : [{ audio: base, video: false }, { audio: true, video: false }];
    for (const c of attempts) {
      try {
        stream = await navigator.mediaDevices.getUserMedia(c);
        break;
      } catch (err) {
        const name = err instanceof DOMException ? err.name : '';
        if (name === 'NotAllowedError' || name === 'SecurityError') {
          this.state = { ...this.state, mic: 'denied' };
          this.events.onState({ ...this.state });
          this.events.onLog('Microphone permission was refused. Allow it in the address bar, or use loopback / simulator mode.', 'error');
          return false;
        }
        if (name === 'OverconstrainedError' || name === 'NotFoundError' || name === 'NotReadableError') continue;
        this.events.onLog(`Microphone open failed (${name || 'unknown'}); trying a looser constraint set.`, 'warn');
      }
    }
    if (!stream) {
      this.state = { ...this.state, mic: 'denied' };
      this.events.onState({ ...this.state });
      this.events.onLog('No microphone could be opened.', 'error');
      return false;
    }
    this.stream = stream;
    this.micNode = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.55;
    this.analyser.minDecibels = -105;
    this.analyser.maxDecibels = -12;
    this.micNode.connect(this.analyser);

    let wired = false;
    if (ctx.audioWorklet) {
      try {
        // Served from `public/` at a base-url-relative path: bundlers inline small
        // assets as data: URLs, and an AudioWorklet module must be a real same-origin
        // script. A bare relative path would 404 under a subdirectory deployment.
        await ctx.audioWorklet.addModule(import.meta.env.BASE_URL + 'capture-worklet.js');
        const node = new AudioWorkletNode(ctx, 'tb-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          processorOptions: { blockSize: 1024 },
        });
        node.port.onmessage = (e: MessageEvent) => {
          const { samples, frames } = e.data as { samples: Float32Array; frames: number };
          this.events.onSamples(samples, frames);
        };
        this.micNode.connect(node);
        node.connect(this.silent!);
        this.worklet = node;
        wired = true;
        this.state = { ...this.state, worklet: true };
      } catch (err) {
        this.events.onLog(`AudioWorklet unavailable (${err instanceof Error ? err.message : 'error'}); falling back to a script processor for capture.`, 'warn');
      }
    }
    if (!wired) {
      const proc = ctx.createScriptProcessor(1024, 1, 1);
      let total = 0;
      proc.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        const copy = new Float32Array(input.length);
        copy.set(input);
        this.events.onSamples(copy, total);
        total += input.length;
      };
      this.micNode.connect(proc);
      proc.connect(this.silent!);
      this.fallback = proc;
      this.state = { ...this.state, worklet: false };
    }
    // Loopback taps must see the microphone too, or echo cancellation-free monitoring
    // would double-count; keep mic out of the speakers entirely.
    this.state = { ...this.state, running: true, mic: 'on' };
    this.events.onState({ ...this.state });
    this.events.onLog(`Capturing at ${ctx.sampleRate} Hz via ${this.state.worklet ? 'AudioWorklet' : 'script processor'}.`, 'ok');
    void this.detectDevices();
    return true;
  }

  stopCapture(): void {
    try {
      this.worklet?.disconnect();
      this.fallback?.disconnect();
      this.fallback && (this.fallback.onaudioprocess = null);
      this.micNode?.disconnect();
    } catch {
      /* already gone */
    }
    this.worklet = null;
    this.fallback = null;
    this.micNode = null;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
      this.stream = null;
    }
    this.state = { ...this.state, running: false, mic: 'off' };
    this.events.onState({ ...this.state });
  }

  /** Play a rendered waveform. Resolves when the last sample has left the device. */
  async play(wave: Float32Array, opts: { outputDeviceId?: string | null; gain?: number } = {}): Promise<void> {
    const ctx = await this.ensureContext();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
    const buf = ctx.createBuffer(1, Math.max(1, wave.length), ctx.sampleRate);
    buf.copyToChannel(wave as Float32Array<ArrayBuffer>, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = opts.gain ?? 1;
    src.connect(g);
    const useSink = !!opts.outputDeviceId && !!this.sinkElement;
    if (useSink && this.sinkDest) g.connect(this.sinkDest);
    else g.connect(this.loopTap!);
    this.txActive = true;
    await new Promise<void>((resolve) => {
      src.onended = () => {
        this.txActive = false;
        try {
          src.disconnect();
          g.disconnect();
        } catch {
          /* fine */
        }
        resolve();
      };
      src.start();
      if (useSink) void this.sinkElement!.play().catch(() => undefined);
    });
  }

  /** Direct digital playback for the simulator/loopback path: no audio device at all. */
  get isTxActive(): boolean {
    return this.txActive;
  }

  async setOutputDevice(id: string | null): Promise<void> {
    const ctx = await this.ensureContext();
    if (!id) {
      this.sinkElement = null;
      this.state = { ...this.state, outputDevice: null };
      this.events.onState({ ...this.state });
      return;
    }
    const el = document.createElement('audio');
    el.setAttribute('aria-hidden', 'true');
    if (!('setSinkId' in el)) {
      this.events.onLog('This browser cannot pick an output device, so the system default will be used.', 'warn');
      this.sinkElement = null;
      return;
    }
    try {
      if (!this.sinkDest) this.sinkDest = ctx.createMediaStreamDestination();
      el.srcObject = this.sinkDest.stream;
      await (el as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId(id);
      this.sinkElement = el;
      this.state = { ...this.state, outputDevice: id };
      this.events.onState({ ...this.state });
      this.events.onLog('Output device selected; playback is routed through it.', 'ok');
    } catch (err) {
      this.events.onLog(`Could not select that output device (${err instanceof Error ? err.message : 'error'}).`, 'error');
      this.sinkElement = null;
    }
  }

  /** Keep the context unlocked across tab switches on mobile. */
  async resumeIfNeeded(): Promise<void> {
    if (this.ctx && this.ctx.state !== 'running') {
      await this.ctx.resume().catch(() => undefined);
    }
  }

  get pendingTx(): boolean {
    return this.txActive;
  }
}
