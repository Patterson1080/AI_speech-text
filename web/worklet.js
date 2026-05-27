// AudioWorklet that captures mono PCM frames and posts them as Int16 chunks.
// Browser AudioContext is forced to 16 kHz so the data is already at Gemini's
// required sample rate; we just need to convert float32 -> int16 LE.

class PCMCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = new Int16Array(0);
    this._target = 480; // 30 ms at 16 kHz
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    const out = new Int16Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      let s = Math.max(-1, Math.min(1, ch[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    // concat
    const merged = new Int16Array(this._buf.length + out.length);
    merged.set(this._buf, 0);
    merged.set(out, this._buf.length);
    this._buf = merged;

    while (this._buf.length >= this._target) {
      const chunk = this._buf.slice(0, this._target);
      this.port.postMessage(chunk.buffer, [chunk.buffer]);
      this._buf = this._buf.slice(this._target);
    }
    return true;
  }
}

registerProcessor("pcm-capture", PCMCapture);
