// Jarvis's ears. Instead of Safari's built-in dictation (which stops after one use without a tap),
// Jarvis keeps the microphone open and runs its own speech recognition on the phone:
// Silero VAD spots when someone is talking (tuned to catch whispers and distant speech),
// then Moonshine turns each utterance into text. Free, on-device, nothing leaves the phone.
import { AutoModel, Tensor, pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1";

const SAMPLE_RATE = 16000;
// Lower than usual so quiet or far-away speech still counts as speech.
const SPEECH_THRESHOLD = 0.15;
const EXIT_THRESHOLD = 0.05;
// A pause this long ends an utterance.
const MIN_SILENCE_SAMPLES = 0.5 * SAMPLE_RATE;
const SPEECH_PAD_SAMPLES = 0.25 * SAMPLE_RATE;
const MIN_SPEECH_SAMPLES = 0.2 * SAMPLE_RATE;
const MAX_BUFFER_SAMPLES = 20 * SAMPLE_RATE;
const CHUNK = 512;

function progress(p) {
  if (p.status === "progress_total") postMessage({ type: "progress", loaded: p.loaded, total: p.total });
}

let vadModel;
let transcriber;
try {
  const device = (await navigator.gpu?.requestAdapter()) ? "webgpu" : "wasm";
  vadModel = await AutoModel.from_pretrained("onnx-community/silero-vad", {
    config: { model_type: "custom" },
    dtype: "fp32",
    progress_callback: progress,
  });
  transcriber = await pipeline("automatic-speech-recognition", "onnx-community/moonshine-base-ONNX", {
    device,
    dtype: device === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q4" } : { encoder_model: "fp32", decoder_model_merged: "q8" },
    progress_callback: progress,
  });
  await transcriber(new Float32Array(SAMPLE_RATE)); // warm up
  postMessage({ type: "ready" });
} catch (error) {
  postMessage({ type: "error", error: String(error?.message ?? error) });
  throw error;
}

let chain = Promise.resolve(); // one inference at a time
const sr = new Tensor("int64", [SAMPLE_RATE], []);
let vadState = new Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);

const buffer = new Float32Array(MAX_BUFFER_SAMPLES);
let pointer = 0;
let recording = false;
let silence = 0;
let prev = []; // a little audio from just before speech started
let paused = false;

async function isSpeech(chunk) {
  const run = chain.then(() => vadModel({ input: new Tensor("float32", chunk, [1, chunk.length]), sr, state: vadState }));
  chain = run.catch(() => {}); // one failed run mustn't block the rest
  const { stateN, output } = await run;
  vadState = stateN;
  const p = output.data[0];
  return p > SPEECH_THRESHOLD || (recording && p >= EXIT_THRESHOLD);
}

/** Boosts quiet audio (whispers, distance) to a normal level before recognition. */
function normalise(audio) {
  let peak = 0;
  for (const s of audio) peak = Math.max(peak, Math.abs(s));
  if (peak < 1e-4) return audio;
  const gain = Math.min(0.9 / peak, 30);
  for (let i = 0; i < audio.length; i++) audio[i] *= gain;
  return audio;
}

function finishUtterance() {
  const padLength = prev.reduce((n, b) => n + b.length, 0);
  const audio = new Float32Array(padLength + pointer);
  let o = 0;
  for (const b of prev) {
    audio.set(b, o);
    o += b.length;
  }
  audio.set(buffer.subarray(0, pointer), o);
  reset();
  postMessage({ type: "speech_end" });
  chain = chain.then(async () => {
    let text = "";
    try {
      text = (await transcriber(normalise(audio))).text.trim();
    } catch {}
    // Sent even when empty, so Jarvis knows the speech it was waiting for has been processed.
    if (!paused) postMessage({ type: "utterance", text });
  });
}

function reset() {
  pointer = 0;
  recording = false;
  silence = 0;
  prev = [];
}

async function onAudio(chunk) {
  if (paused) return;
  const wasRecording = recording;
  const speech = await isSpeech(chunk);

  if (!wasRecording && !speech) {
    prev.push(chunk);
    if (prev.length > Math.ceil(SPEECH_PAD_SAMPLES / CHUNK)) prev.shift();
    return;
  }
  if (pointer + chunk.length >= buffer.length) {
    finishUtterance();
    return;
  }
  buffer.set(chunk, pointer);
  pointer += chunk.length;

  if (speech) {
    if (!recording) postMessage({ type: "speech_start" });
    recording = true;
    silence = 0;
    return;
  }
  silence += chunk.length;
  if (silence < MIN_SILENCE_SAMPLES) return;
  if (pointer - silence < MIN_SPEECH_SAMPLES) {
    reset();
    return;
  }
  finishUtterance();
}

self.addEventListener("message", ({ data }) => {
  if (data.type === "audio") {
    if (transcriber) onAudio(data.chunk).catch(() => {});
  }
  else if (data.type === "pause") {
    paused = true;
    reset();
  } else if (data.type === "resume") {
    paused = false;
    reset();
  }
});
