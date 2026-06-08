/**
 * PCM processor — resamples mic input to a configurable target sample rate
 * (handles Safari's tendency to ignore the sampleRate hint on AudioContext),
 * converts Float32 → Int16 little-endian, and posts 50 ms chunks.
 *
 * Usage: new AudioWorkletNode(ctx, 'pcm-processor', {
 *   processorOptions: { targetSampleRate: 16000 }
 * })
 *
 * The main thread receives raw ArrayBuffer chunks and can send them directly
 * as binary WebSocket frames (AssemblyAI Streaming STT) or base64-encode them
 * for other APIs.
 */
class PcmProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super(options);
    const opts = (options && options.processorOptions) || {};
    this._targetRate = opts.targetSampleRate || 16000;
    // 50 ms of output samples
    this._chunkSize  = Math.floor(this._targetRate * 0.05);
    this._buf        = [];
    this._phase      = 0; // fractional read position into current input frame
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel || channel.length === 0) return true;

    // sampleRate is the AudioWorkletGlobalScope global — actual context rate.
    const step = sampleRate / this._targetRate;

    // Linear interpolation resampling
    while (this._phase < channel.length) {
      const i    = Math.floor(this._phase);
      const frac = this._phase - i;
      const a    = channel[i] !== undefined ? channel[i] : 0;
      const b    = channel[Math.min(i + 1, channel.length - 1)] !== undefined
                     ? channel[Math.min(i + 1, channel.length - 1)]
                     : a;
      this._buf.push(a + frac * (b - a));
      this._phase += step;
    }
    this._phase -= channel.length;

    // Emit complete 50 ms chunks
    while (this._buf.length >= this._chunkSize) {
      const samples = this._buf.splice(0, this._chunkSize);
      const pcm     = new Int16Array(this._chunkSize);
      for (let i = 0; i < this._chunkSize; i++) {
        const c = Math.max(-1, Math.min(1, samples[i]));
        pcm[i]  = c < 0 ? c * 32768 : c * 32767;
      }
      // Transfer ownership — zero-copy
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm-processor', PcmProcessor);
