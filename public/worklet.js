/**
 * PCM processor: captures mic Float32 samples, resamples to 24 kHz if needed
 * (Safari ignores the sampleRate hint on AudioContext and may run at 48 kHz),
 * converts to Int16 little-endian, and posts 50 ms chunks to the main thread.
 *
 * The main thread base64-encodes each chunk and sends it as { type: "input.audio", audio: "..." }.
 */
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = []; // accumulated resampled samples (Float32)
    this._phase = 0; // fractional read position across input frames
    // 50 ms at 24 kHz = 1200 samples
    this._chunkSize = 1200;
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (!channel || channel.length === 0) return true;

    // sampleRate is the AudioWorkletGlobalScope global — reflects the actual
    // rate the context is running at (may differ from the 24000 we requested).
    const step = sampleRate / 24000; // e.g. 2.0 when Safari gives 48 kHz

    // Linear interpolation resampling: walk through the input frame at `step`
    // increments, interpolating between adjacent samples.
    while (this._phase < channel.length) {
      const i = Math.floor(this._phase);
      const frac = this._phase - i;
      const a = channel[i] ?? 0;
      const b = channel[Math.min(i + 1, channel.length - 1)] ?? a;
      this._buf.push(a + frac * (b - a));
      this._phase += step;
    }
    // Carry the fractional overshoot into the next call.
    this._phase -= channel.length;

    // Emit complete 50 ms chunks.
    while (this._buf.length >= this._chunkSize) {
      const samples = this._buf.splice(0, this._chunkSize);
      const pcm = new Int16Array(this._chunkSize);
      for (let i = 0; i < this._chunkSize; i++) {
        const clamped = Math.max(-1, Math.min(1, samples[i]));
        pcm[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
      }
      // Transfer ownership of the underlying buffer to avoid a copy.
      this.port.postMessage(pcm.buffer, [pcm.buffer]);
    }

    return true; // keep processor alive
  }
}

registerProcessor('pcm-processor', PcmProcessor);
