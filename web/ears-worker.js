// Jarvis's ears. Instead of Safari's built-in dictation (which stops after one use without a tap),
// Jarvis keeps the microphone open and runs its own speech recognition on the phone:
// Silero VAD spots when someone is talking (tuned to catch whispers and distant speech),
// then Moonshine turns each utterance into text. Free, on-device, nothing leaves the phone.
// On top of that, recordings the user has corrected are remembered by sound (voice-match.js),
// so the next time they say the same thing in the same voice, Jarvis hears it right.
import { AutoModel, Tensor, pipeline } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1";
import { compare, decode, encode, features } from "./voice-match.js";

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
// How close (average distance per 10 ms) a recording must be to a remembered one to count as the same.
const PHRASE_MATCH = 0.72;
const WAKE_MATCH_DEFAULT = 0.58;
const WAKE_SEARCH_FRAMES = 300; // look for "Jarvis" in the first 3 seconds

let vadModel = null;
let transcriber = null;
let chain = Promise.resolve(); // one inference at a time
const sr = new Tensor("int64", [SAMPLE_RATE], []);
let vadState = new Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);

const buffer = new Float32Array(MAX_BUFFER_SAMPLES);
let pointer = 0;
let recording = false;
let silence = 0;
let prev = []; // a little audio from just before speech started
let paused = false;

// What the user has taught Jarvis: { kind: "wake" | "phrase", text, feats }.
let templates = [];
let wakeMatch = WAKE_MATCH_DEFAULT;
// The last few utterances, so one can be learned when the user corrects it.
const recent = new Map();
let nextId = 1;

// Registered before the models load, so nothing sent meanwhile is lost.
self.addEventListener("message", ({ data }) => {
  if (data.type === "audio") {
    if (transcriber) onAudio(data.chunk).catch(() => {});
  } else if (data.type === "pause") {
    paused = true;
    reset();
  } else if (data.type === "resume") {
    paused = false;
    reset();
  } else if (data.type === "templates") {
    setTemplates(data.templates.map((t) => ({ ...t, feats: decode(t.feats) })));
  } else if (data.type === "learn") {
    learn(data);
  }
});

function progress(p) {
  if (p.status === "progress_total") postMessage({ type: "progress", loaded: p.loaded, total: p.total });
}

try {
  vadModel = await AutoModel.from_pretrained("onnx-community/silero-vad", {
    config: { model_type: "custom" },
    dtype: "fp32",
    progress_callback: progress,
  });
  // On the CPU, so the GPU's memory is left for the brain (Safari closes pages that use too much).
  const asr = await pipeline("automatic-speech-recognition", "onnx-community/moonshine-base-ONNX", {
    device: "wasm",
    dtype: { encoder_model: "fp32", decoder_model_merged: "q8" },
    progress_callback: progress,
  });
  await asr(new Float32Array(SAMPLE_RATE)); // warm up
  transcriber = asr;
  postMessage({ type: "ready" });
} catch (error) {
  postMessage({ type: "error", error: String(error?.message ?? error) });
}

function setTemplates(list) {
  templates = list;
  // Calibrate "Jarvis" to the user's voice: allow a bit more difference than their own samples had between them.
  const wakes = templates.filter((t) => t.kind === "wake");
  let widest = 0;
  for (let i = 0; i < wakes.length; i++) {
    for (let j = i + 1; j < wakes.length; j++) widest = Math.max(widest, compare(wakes[i].feats, wakes[j].feats).distance);
  }
  wakeMatch = widest ? Math.min(0.68, Math.max(0.45, widest * 1.15)) : WAKE_MATCH_DEFAULT;
}

function learn({ id, text, kind }) {
  const feats = recent.get(id);
  if (!feats?.frames) return;
  const template = { kind, text, feats };
  setTemplates([...templates, template]);
  postMessage({ type: "learned", template: { kind, text, feats: encode(feats) } });
}

/** Compares what was just said with what the user has taught Jarvis. */
function recognise(feats) {
  let match = null;
  let best = PHRASE_MATCH;
  let wake = null;
  let bestWake = wakeMatch;
  const opening = { frames: Math.min(feats.frames, WAKE_SEARCH_FRAMES), data: feats.data };
  for (const t of templates) {
    if (t.kind === "phrase") {
      const ratio = feats.frames / t.feats.frames;
      if (ratio < 0.6 || ratio > 1.6) continue;
      const { distance } = compare(t.feats, feats);
      if (distance < best) {
        best = distance;
        match = t.text;
      }
    } else if (t.kind === "wake" && opening.frames >= t.feats.frames * 0.6) {
      const { distance, end } = compare(t.feats, opening, { anywhere: true });
      if (distance < bestWake) {
        bestWake = distance;
        wake = (end * opening.frames) / feats.frames; // how far into the utterance "Jarvis" ended
      }
    }
  }
  return { match, wake };
}

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
    const id = nextId++;
    let text = "";
    let heard = { match: null, wake: null };
    try {
      normalise(audio);
      text = (await transcriber(audio)).text.trim();
      const feats = features(audio);
      recent.set(id, feats);
      if (recent.size > 8) recent.delete(recent.keys().next().value);
      if (templates.length) heard = recognise(feats);
    } catch {}
    // Sent even when empty, so Jarvis knows the speech it was waiting for has been processed.
    if (!paused) postMessage({ type: "utterance", id, text, ...heard });
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
