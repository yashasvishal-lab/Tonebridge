/**
 * Capture batcher (AudioWorklet).
 *
 * Deliberately dumb: the microphone stream is never processed on the main thread, and
 * no deprecated ScriptProcessorNode is involved. This node only repacks 128-sample
 * render quanta into ~21 ms blocks and transfers the underlying buffer to the app, so
 * the demodulator gets a steady flow of audio without per-message allocation churn.
 *
 * Kept as a standalone classic script because AudioWorklet modules are loaded by URL
 * and cannot import from the bundle.
 */
class CaptureBatcher extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    this.blockSize = (options && options.processorOptions && options.processorOptions.blockSize) || 1024;
    this.buf = new Float32Array(this.blockSize);
    this.at = 0;
    this.total = 0;
    this.enabled = true;
    this.port.onmessage = (e) => {
      const m = e.data;
      if (m && m.type === 'config') {
        if (typeof m.enabled === 'boolean') this.enabled = m.enabled;
      }
    };
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const src = input[0];
    if (!this.enabled) return true;
    let i = 0;
    while (i < src.length) {
      const take = Math.min(this.blockSize - this.at, src.length - i);
      this.buf.set(src.subarray(i, i + take), this.at);
      this.at += take;
      i += take;
      if (this.at >= this.blockSize) {
        const out = this.buf;
        const total = this.total;
        this.buf = new Float32Array(this.blockSize);
        this.at = 0;
        this.total += out.length;
        this.port.postMessage({ samples: out, frames: total }, [out.buffer]);
      }
    }
    return true;
  }
}

registerProcessor('tb-capture', CaptureBatcher);
