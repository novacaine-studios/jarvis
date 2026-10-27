// Runs on the audio thread: resamples the microphone to 16 kHz and collects 512-sample chunks
// for the ears worker. (iPhones record at 44.1 or 48 kHz; the speech models expect 16 kHz.)
const CHUNK = 512;
const TARGET_RATE = 16000;

class ChunkProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / TARGET_RATE; // input samples per output sample
    this.position = 0; // where the next output sample falls, relative to the current input block
    this.last = 0; // final sample of the previous block, for interpolating across blocks
    this.chunk = new Float32Array(CHUNK);
    this.filled = 0;
  }

  push(sample) {
    this.chunk[this.filled++] = sample;
    if (this.filled === CHUNK) {
      this.port.postMessage(this.chunk, [this.chunk.buffer]);
      this.chunk = new Float32Array(CHUNK);
      this.filled = 0;
    }
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    // Linear interpolation; index -1 is the last sample of the previous block.
    while (this.position < input.length - 1) {
      const i = Math.floor(this.position);
      const frac = this.position - i;
      const a = i < 0 ? this.last : input[i];
      const b = input[i + 1];
      this.push(a + (b - a) * frac);
      this.position += this.step;
    }
    this.position -= input.length;
    this.last = input[input.length - 1];
    return true;
  }
}

registerProcessor("chunk-processor", ChunkProcessor);
