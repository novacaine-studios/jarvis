// Jarvis for Safari: wake word -> question -> (camera) -> on-device AI -> spoken reply.
// Jarvis never touches the volume: speech plays at whatever level the phone is set to,
// through AirPods when they're connected.

const $ = (id) => document.getElementById(id);
const ui = {
  wake: $("wake"),
  status: $("status"),
  brain: $("brain"),
  heard: $("heard"),
  reply: $("reply"),
  extra: $("extra"),
  video: $("camera"),
};

// ---------- Brain (runs in a worker so the page stays responsive) ----------

const worker = new Worker("./worker.js", { type: "module" });
const pending = new Map();
let nextId = 1;
const ready = { text: false, vision: false };
const downloads = { text: new Map(), vision: new Map() };

worker.addEventListener("message", ({ data }) => {
  if (data.type === "progress") {
    downloads[data.which].set(data.file, data);
    showDownloadProgress();
    return;
  }
  if (data.type === "ready") {
    ready[data.which] = true;
    showDownloadProgress();
    return;
  }
  const request = pending.get(data.id);
  if (!request) return;
  pending.delete(data.id);
  data.ok ? request.resolve(data.result) : request.reject(new Error(data.error));
});

// If the AI engine can't load (e.g. no internet on first use), say so instead of hanging.
worker.addEventListener("error", (event) => {
  event.preventDefault?.();
  ui.brain.textContent = "Couldn't load Jarvis's AI engine. Check your internet connection and reload.";
  for (const request of pending.values()) request.reject(new Error("the AI engine didn't load"));
  pending.clear();
});

function brain(type, payload = {}, transfer = []) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, type, ...payload }, transfer);
  });
}

function showDownloadProgress() {
  if (ready.text && ready.vision) {
    ui.brain.textContent = "";
    return;
  }
  let loaded = 0;
  let total = 0;
  for (const files of Object.values(downloads)) {
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
  }
  const pct = total ? Math.floor((loaded / total) * 100) : 0;
  ui.brain.textContent = ready.text
    ? `Downloading Jarvis's eyes… ${pct}%`
    : `Downloading Jarvis's brain (one time, use Wi-Fi)… ${pct}%`;
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

// ---------- Ears (speech recognition) ----------

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognizer = null;
let recognizerGeneration = 0;
let wantEars = false;

function startEars() {
  stopEars();
  wantEars = true;
  const generation = ++recognizerGeneration;
  const r = new Recognition();
  r.lang = "en-US";
  r.continuous = true;
  r.interimResults = true;
  r.onresult = (event) => {
    if (generation !== recognizerGeneration) return;
    let transcript = "";
    for (const result of event.results) transcript += result[0].transcript;
    onTranscript(transcript);
  };
  r.onerror = (event) => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      wantEars = false;
      setStatus("Microphone or speech recognition is blocked. Allow it in Settings › Apps › Safari.");
    }
  };
  // Safari ends recognition every so often; quietly start a fresh one.
  r.onend = () => {
    if (wantEars && generation === recognizerGeneration) setTimeout(startEars, 250);
  };
  recognizer = r;
  try {
    r.start();
  } catch {
    // Already starting; onend will retry.
  }
}

function stopEars() {
  wantEars = false;
  recognizerGeneration++;
  try {
    recognizer?.abort();
  } catch {}
  recognizer = null;
}

// ---------- Eyes (camera) ----------

let cameraOn = false;

async function startCamera() {
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

// ---------- The loop ----------

const END_OF_QUESTION_SILENCE = 1500; // ms after the last word
const YES_SIR_DELAY = 1500; // ms after a bare "Jarvis"
const NO_QUESTION_TIMEOUT = 8000; // ms to wait after "Yes, sir?"

let state = "off"; // off | waiting | listening | thinking | speaking
let heard = "";
let questionFollowsWakeWord = true;
let silenceTimer = null;
let history = [];
let lastAskedAt = 0;

function setStatus(text) {
  ui.status.textContent = text;
}

function setState(next) {
  state = next;
  const labels = {
    off: "Asleep. Tap to wake Jarvis.",
    waiting: "Say “Jarvis”",
    listening: "Listening…",
    thinking: "Thinking…",
    speaking: "Speaking",
  };
  setStatus(labels[next]);
  ui.wake.hidden = next !== "off";
  document.body.dataset.state = next;
}

function textAfterWakeWord(transcript) {
  const i = transcript.toLowerCase().lastIndexOf("jarvis");
  if (i < 0) return null;
  return transcript.slice(i + 6).replace(/^[\s,.!?]+|[\s,.!?]+$/g, "");
}

function onTranscript(transcript) {
  if (state === "waiting") {
    const q = textAfterWakeWord(transcript);
    if (q === null) return;
    state = "listening";
    setStatus("Listening…");
    heard = q;
    navigator.vibrate?.(30);
  } else if (state === "listening") {
    heard = questionFollowsWakeWord
      ? textAfterWakeWord(transcript) ?? heard
      : textAfterWakeWord(transcript) ?? transcript.trim();
  } else {
    return;
  }
  ui.heard.textContent = heard ? `“${heard}”` : "";
  armSilenceTimer();
}

function armSilenceTimer() {
  clearTimeout(silenceTimer);
  const wait = heard ? END_OF_QUESTION_SILENCE : questionFollowsWakeWord ? YES_SIR_DELAY : NO_QUESTION_TIMEOUT;
  silenceTimer = setTimeout(silenceReached, wait);
}

async function silenceReached() {
  stopEars();
  if (heard) {
    await handle(heard);
  } else if (questionFollowsWakeWord) {
    // A bare "Jarvis" and then nothing: answer like a butler, then take the question.
    await say("Yes, sir?");
    if (state === "off") return;
    questionFollowsWakeWord = false;
    heard = "";
    state = "listening";
    setStatus("Listening…");
    startEars();
    armSilenceTimer();
  } else {
    resumeListening();
  }
}

async function say(text) {
  setState("speaking");
  await speak(text);
}

function resumeListening() {
  clearTimeout(silenceTimer);
  if (state === "off") return;
  heard = "";
  questionFollowsWakeWord = true;
  setState("waiting");
  startEars();
}

const SLEEP = /\b(go to sleep|stop listening|goodbye|good night|shut down)\b/;
const CANCEL = /^(never ?mind|cancel|nothing|stop)$/;
const SEES = /\b(look|looking|see|seeing|this|that|these|those|here|camera|read|holding|wearing|front of me|colou?r|identify|picture|photo|screen|sign|label)\b/;
const MATHS = /\b(integral|integrate|derivative|differentiate|solve|equation|calculate|square root|percent|factorial|sum of|times|divided|plus|minus)\b|\d\s*[-+*/^x]\s*\d/;

async function handle(question) {
  const q = question.toLowerCase();
  ui.extra.replaceChildren();
  if (SLEEP.test(q)) {
    await say("Going to sleep, sir.");
    goToSleep();
    return;
  }
  if (CANCEL.test(q.trim())) {
    resumeListening();
    return;
  }

  setState("thinking");
  ui.reply.textContent = "";
  let reply;
  try {
    reply = localSkill(question) ?? (await think(question, q));
  } catch (error) {
    reply = `Sorry, sir, something went wrong. ${error.message}`;
  }
  ui.reply.textContent = reply;
  if (state !== "off") await say(reply);
  resumeListening();
}

async function think(question, q) {
  if (SEES.test(q)) {
    const frame = grabFrame();
    if (!frame) return "I can't see anything, sir. Allow camera access and keep this page open.";
    if (!ready.vision) return "My eyes are still downloading, sir. Give me a minute.";
    return brain("vision", { question, ...frame }, [frame.pixels]);
  }
  if (!ready.text) return "I'm still downloading my brain, sir. Keep this page open on Wi-Fi for a few minutes.";

  if (Date.now() - lastAskedAt > 5 * 60 * 1000) history = [];
  lastAskedAt = Date.now();
  const now = new Date().toLocaleString([], { dateStyle: "full", timeStyle: "short" });
  const reply = await brain("text", {
    question: `[Local time: ${now}]\n${question}`,
    history,
    think: MATHS.test(q),
  });
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
  if (!Recognition) {
    setStatus("This browser can't listen. Open this page in Safari on your iPhone, and turn on Siri & Dictation.");
    return;
  }
  // iOS only allows sound after a tap, so unlock speech now.
  speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  pickVoice();
  await startCamera();
  try {
    wakeLock = await navigator.wakeLock?.request("screen");
  } catch {}
  setState("waiting");
  startEars();
  if (!ready.text) {
    const gpu = await brain("check");
    if (!gpu) {
      ui.brain.textContent = "This browser has no WebGPU, so the AI can't run. Update iOS to 26 or later and use Safari.";
      return;
    }
    showDownloadProgress();
    brain("load").catch((e) => (ui.brain.textContent = `Couldn't download the brain: ${e.message}. Reload on Wi-Fi.`));
  }
}

function goToSleep() {
  clearTimeout(silenceTimer);
  stopEars();
  speechSynthesis.cancel();
  wakeLock?.release?.();
  setState("off");
}

ui.wake.addEventListener("click", wake);
// Safari pauses the page in the background; when it comes back, keep listening.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && state === "waiting") startEars();
});
setState("off");
