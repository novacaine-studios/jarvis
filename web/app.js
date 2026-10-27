// Jarvis for Safari: wake word -> question -> (camera) -> on-device AI -> spoken reply.
// Jarvis never touches the volume: speech plays at whatever level the phone is set to,
// through AirPods when they're connected.
import { PcLink, pcKey } from "./pc-link.js";
import { addTemplate, correct, forgetVoice, knowsMyVoice, learnCorrection, memory } from "./voice-memory.js";

const $ = (id) => document.getElementById(id);
const ui = {
  wake: $("wake"),
  status: $("status"),
  brain: $("brain"),
  heard: $("heard"),
  heardText: $("heard-text"),
  fix: $("fix"),
  fixForm: $("fix-form"),
  fixInput: $("fix-input"),
  fixCancel: $("fix-cancel"),
  teach: $("teach"),
  forget: $("forget"),
  reply: $("reply"),
  extra: $("extra"),
  video: $("camera"),
};

// ---------- Download progress ----------

// Each model reports how much of it has downloaded; the status line shows the total.
const models = {
  ears: { loaded: 0, total: 0, ready: false },
  text: { loaded: 0, total: 0, ready: false },
  vision: { loaded: 0, total: 0, ready: false },
};

function onProgress(which, data) {
  if (data.type === "progress") Object.assign(models[which], { loaded: data.loaded, total: data.total });
  if (data.type === "ready") {
    models[which].ready = true;
    finishedLoading();
    // One download at a time keeps memory low: the brain starts once the ears are done.
    if (which === "ears") loadBrain();
  }
  if (which === "ears" && data.type === "ready" && state === "waiting") setState("waiting");
  showDownloadProgress();
}

const percent = ({ loaded, total }) => (total ? Math.floor((loaded / total) * 100) : 0);

function showDownloadProgress() {
  if (pc) return; // nothing downloads when your PC does the work
  const { ears, text, vision } = models;
  const lighter = textChoice === "light" ? " (a lighter one, after Safari ran short of memory)" : "";
  if (!ears.ready) {
    ui.brain.textContent = `Step 1 of 2: downloading Jarvis's ears… ${percent(ears)}%. One time only; keep this page open on Wi-Fi.`;
  } else if (!text.ready) {
    ui.brain.textContent = `Step 2 of 2: downloading Jarvis's brain${lighter}… ${percent(text)}%. Finished parts are kept if the page reloads.`;
  } else if (vision.total && !vision.ready) {
    ui.brain.textContent = `Downloading Jarvis's eyes (one time only)… ${percent(vision)}%`;
  } else {
    ui.brain.textContent = "";
  }
}

// ---------- Surviving Safari's memory limit ----------
// Safari closes a page that uses too much memory and reloads it. Jarvis notes what it was loading,
// so after such a reload it knows what crashed and loads something lighter instead of crashing again.

const LOADING_KEY = "jarvis-loading";
const CRASHES_KEY = "jarvis-crashes";
const crashes = (() => {
  try {
    const counts = JSON.parse(localStorage.getItem(CRASHES_KEY)) ?? {};
    const crashedWhile = localStorage.getItem(LOADING_KEY);
    if (crashedWhile) {
      counts[crashedWhile] = (counts[crashedWhile] ?? 0) + 1;
      localStorage.setItem(CRASHES_KEY, JSON.stringify(counts));
      localStorage.removeItem(LOADING_KEY);
    }
    return counts;
  } catch {
    return {};
  }
})();
const textChoice = crashes["text-full"] && !pcKey ? "light" : "full";

function startedLoading(stage) {
  if (pcKey) return;
  try {
    localStorage.setItem(LOADING_KEY, stage);
  } catch {}
}

function finishedLoading() {
  try {
    localStorage.removeItem(LOADING_KEY);
  } catch {}
}

// Leaving the page normally isn't a crash.
addEventListener("pagehide", finishedLoading);

// ---------- Brain (runs in a worker so the page stays responsive) ----------

let worker = null;
const pending = new Map();
let nextId = 1;

function startBrain() {
  if (worker) return;
  worker = pc ? pc.brain : new Worker("./worker.js", { type: "module" });
  worker.addEventListener("message", ({ data }) => {
    if (data.type) {
      onProgress(data.which, data);
      return;
    }
    const request = pending.get(data.id);
    if (!request) return;
    // Your PC sends the answer a sentence at a time, so Jarvis can start speaking straight away.
    if (data.partial) {
      request.onPartial?.(data.partial);
      return;
    }
    pending.delete(data.id);
    data.ok ? request.resolve(data.result) : request.reject(new Error(data.error));
  });
  // If the AI engine can't load (e.g. no internet on first use), say so instead of hanging.
  worker.addEventListener("error", (event) => {
    event.preventDefault?.();
    if (!pc) ui.brain.textContent = "Couldn't load Jarvis's AI engine. Check your internet connection and reload.";
    for (const request of pending.values()) request.reject(new Error("the AI engine didn't load"));
    pending.clear();
  });
}

let brainLoading = false;
function loadBrain() {
  if (brainLoading || models.text.ready) return;
  brainLoading = true;
  startBrain();
  startedLoading(`text-${textChoice}`);
  brain("load", { choice: textChoice }).catch((e) => {
    finishedLoading();
    brainLoading = false;
    ui.brain.textContent = `Couldn't download the brain: ${e.message}. Reload on Wi-Fi.`;
  });
}

function brain(type, payload = {}, transfer = [], onPartial = null) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, onPartial });
    worker.postMessage({ id, type, ...payload }, transfer);
  });
}

// ---------- Voice out ----------

let voice = null;
function pickVoice() {
  const voices = speechSynthesis.getVoices();
  voice =
    voices.find((v) => v.lang === "en-GB" && /daniel|arthur|male/i.test(v.name)) ??
    voices.find((v) => v.lang === "en-GB") ??
    voices.find((v) => v.lang.startsWith("en")) ??
    null;
}
speechSynthesis.addEventListener?.("voiceschanged", pickVoice);
pickVoice();

function speak(text) {
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    if (voice) u.voice = voice;
    u.onend = resolve;
    u.onerror = resolve;
    speechSynthesis.speak(u);
  });
}

// ---------- Ears ----------
// The microphone stays open the whole time Jarvis is awake, and Jarvis's own speech recognition
// (ears-worker.js) listens continuously, so "Jarvis" works every time, not just once.

let ears = null;
let audioContext = null;
let chunker = null;
let mic = null; // { stream, source }
let wantMic = false;

// ---------- Running on your PC (see pc-link.js) ----------

const pc = pcKey
  ? new PcLink({
      onStatus: (text) => (ui.brain.textContent = text),
      onConnect: () => {
        // The PC starts fresh each time it connects: tell it what Jarvis knows and what it's doing.
        sendVoiceMemory();
        if (state !== "off") setState(state);
      },
    })
  : null;

/** What Jarvis has already learned about your voice, for whatever is doing the listening. */
function sendVoiceMemory() {
  if (!ears) return;
  ears.postMessage({ type: "templates", templates: memory.templates });
  const words = memory.fixes.flatMap((f) => f.to.split(/\s+/)).filter((w) => w.length > 2);
  ears.postMessage({ type: "vocab", words: [...new Set(words)] });
}

function startEarsWorker() {
  if (ears) return;
  startedLoading("ears");
  ears = pc ? pc.ears : new Worker("./ears-worker.js", { type: "module" });
  ears.addEventListener("message", ({ data }) => {
    if (data.type === "progress" || data.type === "ready") onProgress("ears", data);
    else if (data.type === "error") {
      finishedLoading();
      ui.brain.textContent = `Couldn't load Jarvis's ears: ${data.error}. Reload on Wi-Fi.`;
    } else if (data.type === "speech_start") onSpeechStart();
    else if (data.type === "utterance") onUtterance(data);
    else if (data.type === "learned") addTemplate(data.template);
  });
  sendVoiceMemory();
  // The PC's ears are ready as soon as it's connected.
  if (pc?.open) onProgress("ears", { type: "ready" });
  ears.addEventListener("error", (event) => {
    event.preventDefault?.();
    ui.brain.textContent = "Couldn't load Jarvis's ears. Check your internet connection and reload.";
  });
}

/** Must run inside the tap, because iOS only starts audio after a tap. */
function createAudio() {
  if (audioContext) return;
  audioContext = new AudioContext();
  // iOS interrupts audio for calls, Siri and other apps; pick back up when it lets us.
  audioContext.addEventListener("statechange", () => {
    if (audioContext.state !== "running" && state !== "off") audioContext.resume().catch(() => {});
  });
}

async function startMic() {
  wantMic = true;
  if (mic) return true;
  if (!chunker) {
    await audioContext.audioWorklet.addModule("./vad-processor.js");
    chunker = new AudioWorkletNode(audioContext, "chunk-processor");
    chunker.port.onmessage = ({ data }) => {
      if (models.ears.ready && (state === "waiting" || state === "listening" || state === "teaching")) {
        ears.postMessage({ type: "audio", chunk: data }, [data.buffer]);
      }
    };
    // Some browsers only run audio nodes that lead to the speakers; this path is silent (gain 0).
    const silent = audioContext.createGain();
    silent.gain.value = 0;
    chunker.connect(silent).connect(audioContext.destination);
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        // Boosts quiet and distant voices. Noise suppression is off because it also removes whispers.
        autoGainControl: true,
        noiseSuppression: false,
      },
    });
    if (!wantMic) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(chunker);
    mic = { stream, source };
    // iOS can cut the mic (e.g. a phone call); reopen it when Jarvis should be listening.
    stream.getAudioTracks()[0]?.addEventListener("ended", () => {
      if (mic?.stream === stream) {
        mic = null;
        if (wantMic) setTimeout(() => startMic().catch(() => {}), 500);
      }
    });
    await audioContext.resume().catch(() => {});
    return true;
  } catch (error) {
    if (error?.name === "NotAllowedError") {
      setStatus("Jarvis can't hear you. Allow the microphone: tap aA in the address bar › Website Settings › Microphone › Allow.");
      showWakeButton("Tap to let Jarvis listen");
    }
    return false;
  }
}

/** iPhones send speech to the quiet earpiece while the mic is open, so Jarvis closes it while talking. */
function stopMic() {
  wantMic = false;
  if (!mic) return;
  mic.source.disconnect();
  mic.stream.getTracks().forEach((t) => t.stop());
  mic = null;
}

// ---------- Eyes (camera) ----------

let cameraOn = false;

async function startCamera() {
  if (cameraOn) return;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "environment", width: { ideal: 1280 } },
      audio: false,
    });
    ui.video.srcObject = stream;
    await ui.video.play();
    cameraOn = true;
  } catch {
    cameraOn = false;
  }
}

function grabFrame(maxSide = 512) {
  if (!cameraOn || !ui.video.videoWidth) return null;
  const scale = Math.min(1, maxSide / Math.max(ui.video.videoWidth, ui.video.videoHeight));
  const width = Math.round(ui.video.videoWidth * scale);
  const height = Math.round(ui.video.videoHeight * scale);
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(ui.video, 0, 0, width, height);
  const { data } = ctx.getImageData(0, 0, width, height);
  return { pixels: data.buffer, width, height };
}

// ---------- Hearing the wake word ----------

// Things speech recognition tends to write when someone says "Jarvis" quietly, quickly or from afar.
const WAKE_SOUNDALIKES = new Set([
  "jarvis", "jarvas", "jarves", "jarviss", "jarvus", "jarvi", "javis", "jervis", "jarbis", "jarvys",
  "garvis", "charvis", "darvis", "travis", "jarvie", "jarvey", "jervais", "jarviz", "jarbus", "jaavis",
]);

function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diagonal = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const above = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1));
      diagonal = above;
    }
  }
  return row[b.length];
}

function soundsLikeJarvis(word) {
  if (WAKE_SOUNDALIKES.has(word) || memory.soundalikes.includes(word)) return true;
  if (word.length < 4 || word.length > 8) return false;
  const d = editDistance(word, "jarvis");
  return d <= 1 || (d <= 2 && "jgcdz".includes(word[0]) && /v|b|f/.test(word));
}

/**
 * Finds "Jarvis" (or something that sounds like it) anywhere in what was heard.
 * Returns the words after it ("" for a bare "Jarvis"), or null if it wasn't said.
 */
function textAfterWakeWord(transcript) {
  const words = transcript.split(/\s+/).filter(Boolean);
  const plain = words.map((w) => w.toLowerCase().replace(/[^a-z]/g, ""));
  for (let i = 0; i < words.length; i++) {
    // "jar vis" heard as two words counts too.
    const joined = plain[i] + (plain[i + 1] ?? "");
    let next = -1;
    if (soundsLikeJarvis(plain[i])) next = i + 1;
    else if (plain[i + 1] && soundsLikeJarvis(joined)) next = i + 2;
    if (next >= 0) return words.slice(next).join(" ").replace(/^[\s,.!?]+|[\s,.!?]+$/g, "");
  }
  return null;
}

// ---------- The loop ----------

const END_OF_QUESTION_SILENCE = 700; // ms to wait for more after the question was heard
const STILL_SPEAKING_TIMEOUT = 8000; // ms to wait for words being spoken to be written down
const YES_SIR_DELAY = 1200; // ms after a bare "Jarvis"
const NO_QUESTION_TIMEOUT = 8000; // ms to wait after "Yes, sir?"

let state = "off"; // off | waiting | listening | thinking | speaking | teaching
let heard = "";
let shown = { text: "", ids: [] }; // what's on screen as heard, and which recordings it came from
let saidYesSir = false;
let silenceTimer = null;
let history = [];
let lastAskedAt = 0;

function setStatus(text) {
  ui.status.textContent = text;
}

function showWakeButton(label) {
  ui.wake.textContent = label;
  ui.wake.hidden = false;
}

function setState(next) {
  state = next;
  const labels = {
    off: "Asleep. Tap to wake Jarvis.",
    waiting: models.ears.ready ? "Say “Jarvis”" : "Getting my ears ready…",
    listening: "Listening…",
    thinking: "Thinking…",
    speaking: "Speaking",
    teaching: "Learning your voice…",
  };
  setStatus(labels[next]);
  ui.wake.hidden = next !== "off";
  if (next === "off") ui.wake.textContent = "Wake Jarvis";
  document.body.dataset.state = next;
  ears?.postMessage({ type: ["waiting", "listening", "teaching"].includes(next) ? "resume" : "pause" });
  ui.teach.hidden = next !== "waiting" || !models.ears.ready;
  ui.teach.textContent = knowsMyVoice() ? "Teach Jarvis my voice again" : "Teach Jarvis my voice";
  ui.forget.hidden = ui.teach.hidden || (!memory.templates.length && !memory.fixes.length && !memory.soundalikes.length);
}

function armSilenceTimer(ms) {
  clearTimeout(silenceTimer);
  silenceTimer = setTimeout(silenceReached, ms);
}

function onSpeechStart() {
  // More words are coming: don't answer until they've been written down.
  if (state === "listening") armSilenceTimer(STILL_SPEAKING_TIMEOUT);
}

/** What was said, using everything Jarvis has learned about the user's voice. */
function interpret({ text, match, wake }) {
  // Sounded just like something the user corrected before: trust that over the recogniser.
  if (match) return match;
  let result = correct(text);
  // Sounded like the user's own "Jarvis", even if the words came out differently.
  if (wake != null && textAfterWakeWord(result) === null) {
    const words = result.split(/\s+/).filter(Boolean);
    result = ["Jarvis", ...words.slice(Math.round(words.length * wake))].join(" ");
  }
  return result;
}

function showHeard(text, ids) {
  shown = { text, ids };
  ui.heardText.textContent = text ? `“${text}”` : "";
  ui.heard.hidden = !text;
}

function onUtterance(data) {
  if (state === "teaching") {
    learnWakeSample(data);
    return;
  }
  const text = interpret(data);
  if (state === "waiting") {
    if (!text) return;
    showHeard(text, [data.id]);
    const question = textAfterWakeWord(text);
    if (question !== null) startQuestion(question);
  } else if (state === "listening") {
    if (text) {
      showHeard([shown.text, text].filter(Boolean).join(" "), [...shown.ids, data.id]);
      // Drop a repeated "Jarvis" at the start of the follow-on.
      const rest = textAfterWakeWord(text);
      heard = [heard, rest ?? text].filter(Boolean).join(" ");
    }
    armSilenceTimer(heard ? END_OF_QUESTION_SILENCE : saidYesSir ? NO_QUESTION_TIMEOUT : YES_SIR_DELAY);
  }
}

function startQuestion(question) {
  navigator.vibrate?.(30);
  heard = question;
  saidYesSir = false;
  setState("listening");
  armSilenceTimer(heard ? END_OF_QUESTION_SILENCE : YES_SIR_DELAY);
}

// ---------- Learning the user's voice ----------

// Fixing a mishearing: Jarvis remembers the right words, and how that recording sounded.
let fixing = null;

function openFix() {
  fixing = { ...shown };
  ui.fixInput.value = fixing.text;
  ui.fixForm.hidden = false;
  ui.fixInput.focus();
  ui.fixInput.select();
}

function closeFix() {
  ui.fixForm.hidden = true;
  fixing = null;
}

function saveFix(event) {
  event.preventDefault();
  const meant = ui.fixInput.value.trim();
  const { text, ids } = fixing ?? shown;
  closeFix();
  if (!meant || meant === text) return;
  learnCorrection(text, meant);
  sendVoiceMemory();
  // A single recording can be remembered by sound, so the same words in the same voice are heard right.
  if (ids.length === 1) ears?.postMessage({ type: "learn", id: ids[0], text: meant, kind: "phrase" });
  showHeard(meant, ids);
  ui.reply.textContent = "Got it, sir. I'll hear that properly next time.";
  setState(state); // refresh the "Forget" button
  // If it was meant for Jarvis and he missed it, answer it now.
  const question = textAfterWakeWord(meant);
  if (state === "waiting" && question !== null) startQuestion(question);
}

// "Teach Jarvis my voice": the user says "Jarvis" a few ways, and Jarvis remembers how each sounds.
const TEACH_PROMPTS = [
  "Say Jarvis, the way you normally would.",
  "Now say it quietly.",
  "Now whisper it.",
  "Once more, from a little further away.",
];
const TEACH_TIMEOUT = 15000;
let teachStep = -1;
let teachTimer = null;

async function teach() {
  teachStep = 0;
  await promptTeach();
}

async function promptTeach() {
  await say(TEACH_PROMPTS[teachStep]);
  if (state === "off") return;
  setState("teaching");
  setStatus(`Learning your voice (${teachStep + 1} of ${TEACH_PROMPTS.length})`);
  ui.reply.textContent = TEACH_PROMPTS[teachStep];
  await startMic();
  clearTimeout(teachTimer);
  teachTimer = setTimeout(async () => {
    teachStep = -1;
    await say("I didn't hear anything, sir. We can try again later.");
    resumeListening();
  }, TEACH_TIMEOUT);
}

async function learnWakeSample({ id }) {
  clearTimeout(teachTimer);
  if (teachStep < 0) return;
  ears.postMessage({ type: "learn", id, text: "jarvis", kind: "wake" });
  teachStep++;
  if (teachStep < TEACH_PROMPTS.length) {
    await promptTeach();
    return;
  }
  teachStep = -1;
  ui.reply.textContent = "";
  await say("Thank you, sir. I know your voice now.");
  resumeListening();
}

function forgetMyVoice() {
  forgetVoice();
  ears?.postMessage({ type: "templates", templates: [] });
  ui.reply.textContent = "I've forgotten everything I learned about your voice, sir.";
  setState(state);
}

async function silenceReached() {
  if (state !== "listening") return;
  if (heard) {
    await handle(heard);
  } else if (!saidYesSir) {
    // A bare "Jarvis" and then nothing: answer like a butler, then take the question.
    await say("Yes, sir?");
    if (state === "off") return;
    saidYesSir = true;
    heard = "";
    await startMic();
    setState("listening");
    armSilenceTimer(NO_QUESTION_TIMEOUT);
  } else {
    resumeListening();
  }
}

async function say(text) {
  setState("speaking");
  stopMic();
  await speak(text);
}

async function resumeListening() {
  clearTimeout(silenceTimer);
  if (state === "off") return;
  heard = "";
  saidYesSir = false;
  setState("waiting");
  const listening = await startMic();
  if (!listening && state === "waiting") showWakeButton("Tap to keep listening");
}

const SLEEP = /\b(go to sleep|stop listening|goodbye|good night|shut down)\b/;
const CANCEL = /^(never ?mind|cancel|nothing|stop)$/;
const SEES = /\b(look|looking|see|seeing|this|that|these|those|here|camera|read|holding|wearing|front of me|colou?r|identify|picture|photo|screen|sign|label)\b/;
const MATHS = /\b(integral|integrate|derivative|differentiate|solve|equation|calculate|square root|percent|factorial|sum of|times|divided|plus|minus)\b|\d\s*[-+*/^x]\s*\d/;

async function handle(question) {
  clearTimeout(silenceTimer);
  const q = question.toLowerCase();
  ui.extra.replaceChildren();
  if (SLEEP.test(q)) {
    await say("Going to sleep, sir.");
    goToSleep();
    return;
  }
  if (CANCEL.test(q.trim().replace(/[.!?]+$/, ""))) {
    resumeListening();
    return;
  }

  setState("thinking");
  ui.reply.textContent = "";
  // Speak each sentence as soon as it arrives, while the rest is still being worked out.
  let streamed = false;
  let speaking = Promise.resolve();
  const speakSentence = (sentence) => {
    if (state === "off") return;
    if (!streamed) {
      streamed = true;
      setState("speaking");
      stopMic();
    }
    ui.reply.textContent = [ui.reply.textContent, sentence].filter(Boolean).join(" ");
    speaking = speaking.then(() => speak(sentence));
  };
  let reply;
  try {
    reply = localSkill(question) ?? (await think(question, q, speakSentence));
  } catch (error) {
    reply = `Sorry, sir, something went wrong. ${error.message}`;
    streamed = false;
  }
  if (streamed) {
    await speaking;
  } else {
    await speaking;
    ui.reply.textContent = reply;
    if (state !== "off") await say(reply);
  }
  resumeListening();
}

async function think(question, q, onSentence) {
  if (SEES.test(q)) {
    const frame = grabFrame(pc ? 768 : 512);
    if (!frame) return "I can't see anything, sir. Allow camera access and keep this page open.";
    if (!pc && (crashes.vision ?? 0) >= 2) {
      return "I'm sorry, sir. My eyes need more memory than Safari gives me on this phone, so I can't see right now.";
    }
    if (!models.vision.ready && !pc) {
      // The eyes download the first time they're needed, so the brain and ears load faster.
      await say("One moment, sir. Opening my eyes for the first time.");
      setState("thinking");
      startedLoading("vision");
    }
    try {
      const reply = await brain("vision", { question, ...frame }, [frame.pixels], onSentence);
      onProgress("vision", { type: "ready" });
      return reply;
    } catch (error) {
      finishedLoading();
      if (!models.vision.ready) Object.assign(models.vision, { loaded: 0, total: 0 });
      showDownloadProgress();
      throw error;
    }
  }
  if (!models.text.ready) return "I'm still downloading my brain, sir. Keep this page open on Wi-Fi for a few minutes.";

  if (Date.now() - lastAskedAt > 5 * 60 * 1000) history = [];
  lastAskedAt = Date.now();
  const now = new Date().toLocaleString([], { dateStyle: "full", timeStyle: "short" });
  const reply = await brain("text", {
    question: `[Local time: ${now}]\n${question}`,
    history,
    think: MATHS.test(q),
  }, [], onSentence);
  history.push({ role: "user", content: question }, { role: "assistant", content: reply });
  history = history.slice(-8);
  return reply;
}

// ---------- Things answered instantly, without the AI ----------

function localSkill(question) {
  const q = question.toLowerCase();
  if (/\b(what('s| is) the time|what time is it|time is it)\b/.test(q)) {
    return `It's ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}, sir.`;
  }
  if (/\b(what('s| is)( the)? date|what day is (it|today)|today'?s date)\b/.test(q)) {
    return `It's ${new Date().toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" })}, sir.`;
  }
  if (q.includes("remind me") || /\bset (a |an |me a )?reminder/.test(q)) {
    return setReminder(question);
  }
  return null;
}

/** "remind me to call Mum at 6pm", "remind me in 20 minutes to stretch", "remind me tomorrow at 9 to…" */
function parseWhen(text) {
  const q = text.toLowerCase();
  const now = new Date();
  let m = q.match(/\bin (\d+|an?|one) (minute|min|hour|hr)s?\b/);
  if (m) {
    const n = /^\d+$/.test(m[1]) ? Number(m[1]) : 1;
    const ms = m[2].startsWith("h") ? n * 3600e3 : n * 60e3;
    return { date: new Date(now.getTime() + ms), phrase: m[0] };
  }
  m = q.match(/\b(tomorrow )?(at )?(\d{1,2})(?::(\d{2}))? ?(am|pm|a\.m\.|p\.m\.)?( tomorrow)?\b/);
  if (m && (m[2] || m[5])) {
    let hour = Number(m[3]);
    const minute = Number(m[4] ?? 0);
    const ampm = m[5]?.replace(/\./g, "");
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
    const date = new Date(now);
    date.setHours(hour, minute, 0, 0);
    if (m[1] || m[6]) date.setDate(date.getDate() + 1);
    else if (date <= now) {
      // "at 6" without am/pm: assume the next 6 o'clock.
      if (!ampm && hour < 12 && date.getTime() + 12 * 3600e3 > now.getTime()) date.setHours(hour + 12);
      else date.setDate(date.getDate() + 1);
    }
    return { date, phrase: m[0] };
  }
  return null;
}

function setReminder(question) {
  const when = parseWhen(question);
  let title = question;
  if (when) title = title.replace(new RegExp(when.phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"), " ");
  title = title
    .replace(/^\s*(please\s+)?(can you\s+)?(set\s+(a|an|me a)\s+reminder(\s+(for|to|that|about))?|remind me(\s+(to|that|about))?)\s*/i, "")
    .replace(/\s+/g, " ")
    .replace(/^[\s,.]+|[\s,.]+$/g, "");
  if (!title) title = "Reminder";
  if (!when) return `I need a time for that, sir. Try "remind me to ${title} at 6 pm".`;

  // While this page is open, Jarvis says the reminder out loud.
  const delay = when.date.getTime() - Date.now();
  if (delay < 24 * 3600e3) {
    setTimeout(() => speak(`Sir, a reminder: ${title}.`), delay);
  }
  // For when it isn't open: a one-tap button to put it in your Calendar with an alert.
  ui.extra.replaceChildren(calendarButton(title, when.date));
  const at = when.date.toLocaleString([], { weekday: "long", hour: "numeric", minute: "2-digit" });
  return `Done, sir. I'll remind you to ${title} ${at}. Tap "Add to Calendar" so you get it even when I'm closed.`;
}

function calendarButton(title, date) {
  const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const end = new Date(date.getTime() + 15 * 60e3);
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Jarvis//EN",
    "BEGIN:VEVENT",
    `UID:${crypto.randomUUID()}@jarvis`,
    `DTSTAMP:${stamp(new Date())}`,
    `DTSTART:${stamp(date)}`,
    `DTEND:${stamp(end)}`,
    `SUMMARY:${title.replace(/[,;\\]/g, " ")}`,
    "BEGIN:VALARM",
    "TRIGGER:PT0M",
    "ACTION:DISPLAY",
    `DESCRIPTION:${title.replace(/[,;\\]/g, " ")}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const a = document.createElement("a");
  a.className = "button";
  a.href = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  a.download = "reminder.ics";
  a.textContent = "Add to Calendar";
  return a;
}

// ---------- Waking and sleeping ----------

let wakeLock = null;

async function wake() {
  // iOS only allows sound after a tap, so unlock speech and audio now, before anything is awaited.
  speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  pickVoice();
  createAudio();
  audioContext.resume().catch(() => {});
  if (state !== "off") {
    // "Tap to keep listening": just reopen the mic.
    resumeListening();
    return;
  }
  // Ask Safari to keep the downloaded models instead of clearing them when space is low.
  navigator.storage?.persist?.().catch(() => {});
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {}

  if (!pc && (!navigator.gpu || !(await navigator.gpu.requestAdapter().catch(() => null)))) {
    setStatus("This browser has no WebGPU, so Jarvis can't think. Update to iOS 26 or later and use Safari.");
    return;
  }
  // The ears download first, then the brain (see onProgress), so there's only one big download at a time.
  startEarsWorker();
  if (models.ears.ready) loadBrain();
  showDownloadProgress();
  setState("waiting");
  await startCamera();
  await resumeListening();
}

function goToSleep() {
  clearTimeout(silenceTimer);
  clearTimeout(teachTimer);
  teachStep = -1;
  closeFix();
  stopMic();
  speechSynthesis.cancel();
  wakeLock?.release?.();
  wakeLock = null;
  setState("off");
}

ui.wake.addEventListener("click", wake);
ui.fix.addEventListener("click", openFix);
ui.fixForm.addEventListener("submit", saveFix);
ui.fixCancel.addEventListener("click", closeFix);
ui.teach.addEventListener("click", teach);
ui.forget.addEventListener("click", forgetMyVoice);
// Safari pauses the page in the background; when it comes back, pick up listening again.
document.addEventListener("visibilitychange", async () => {
  if (document.visibilityState !== "visible" || state === "off") return;
  audioContext?.resume().catch(() => {});
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {}
  if (state === "waiting" || state === "listening") resumeListening();
});
if (textChoice === "light" && !pc) ui.brain.textContent = "Safari ran out of memory last time, so I'll use a lighter brain. Tap Wake Jarvis to carry on.";
setState("off");
