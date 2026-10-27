"""Jarvis's brain, running on your Windows PC.

Your iPhone opens a web page served from here and streams its microphone (and, when asked, a camera
picture). This PC does everything heavy with free, local models, so Safari's memory limit no longer
matters:
  - Silero VAD notices when you're talking (tuned for whispers and distance),
  - Whisper writes down what you said,
  - Ollama answers (Qwen3 for questions and maths, Gemma 3 for what the camera sees).
The phone speaks the answer. Nothing is sent to any paid service.

Run it with start-jarvis.bat, which installs what's needed and shows a QR code to scan with the iPhone.
"""
import asyncio
import json
import os
import re
import secrets
import shutil
import subprocess
import sys
import time
from pathlib import Path

import aiohttp
import numpy as np
from aiohttp import web

import voice_match

HERE = Path(__file__).resolve().parent
WEB = HERE.parent / "web"
CONFIG_FILE = HERE / "jarvis_config.json"

DEFAULTS = {
    "port": 8765,
    "text_model": "qwen3:4b",
    "vision_model": "gemma3:4b",
    "whisper_model": "small.en",
    "ollama_url": "http://localhost:11434",
}

SYSTEM = """You are Jarvis, a helpful voice assistant on the user's iPhone. Address the user as "sir".
Everything you write is read aloud, so answer in plain spoken sentences: no markdown, no lists, no emoji, no LaTeX.
Keep answers to one to three sentences unless asked for detail.
Say maths the way a person would, for example "the integral of x from one to two is three halves"."""

SAMPLE_RATE = 16000
CHUNK = 512
CONTEXT = 64
# Lower than usual so quiet or far-away speech still counts as speech.
SPEECH_THRESHOLD = 0.15
EXIT_THRESHOLD = 0.05
MIN_SILENCE_SAMPLES = int(0.4 * SAMPLE_RATE)  # a pause this long ends an utterance
SPEECH_PAD_SAMPLES = int(0.25 * SAMPLE_RATE)
MIN_SPEECH_SAMPLES = int(0.2 * SAMPLE_RATE)
MAX_SPEECH_SAMPLES = 20 * SAMPLE_RATE
# How close a recording must be to a remembered one to count as the same (see voice_match.py).
PHRASE_MATCH = 0.72
WAKE_MATCH_DEFAULT = 0.58
WAKE_SEARCH_FRAMES = 300  # look for "Jarvis" in the first 3 seconds
# Things Whisper tends to "hear" in background noise.
NOISE_PHRASES = {"", "you", "thank you", "thanks for watching", "bye", "okay", "so", "uh", "um", "hmm"}


def load_config():
    config = dict(DEFAULTS)
    if CONFIG_FILE.exists():
        config.update(json.loads(CONFIG_FILE.read_text()))
    # A secret key in the link, so only your phone can use your PC's Jarvis.
    config.setdefault("key", secrets.token_urlsafe(16))
    CONFIG_FILE.write_text(json.dumps(config, indent=2))
    return config


CONFIG = load_config()


def log(*parts):
    print(time.strftime("%H:%M:%S"), *parts, flush=True)


# ---------- Models ----------


def load_vad():
    import faster_whisper
    import onnxruntime

    path = Path(faster_whisper.__file__).parent / "assets" / "silero_vad_v6.onnx"
    options = onnxruntime.SessionOptions()
    options.inter_op_num_threads = 1
    options.intra_op_num_threads = 1
    options.log_severity_level = 4
    return onnxruntime.InferenceSession(str(path), providers=["CPUExecutionProvider"], sess_options=options)


def load_whisper():
    from faster_whisper import WhisperModel

    name = CONFIG["whisper_model"]
    try:
        model = WhisperModel(name, device="cuda", compute_type="float16")
        list(model.transcribe(np.zeros(SAMPLE_RATE, dtype=np.float32))[0])
        log(f"Hearing: Whisper {name} on the graphics card")
        return model
    except Exception:
        model = WhisperModel(name, device="cpu", compute_type="int8")
        log(f"Hearing: Whisper {name} on the processor")
        return model


VAD = None
WHISPER = None
WHISPER_LOCK = asyncio.Lock()


# ---------- Ears: one per connected phone ----------


class Ears:
    def __init__(self, send):
        self.send = send
        self.paused = False
        self.templates = []  # { kind: "wake" | "phrase", text, feats }
        self.wake_match = WAKE_MATCH_DEFAULT
        self.vocabulary = []
        self.recent = {}  # utterance id -> features, so one can be learned when corrected
        self.next_id = 1
        self.reset_vad()
        self.reset()

    def reset_vad(self):
        self.h = np.zeros((1, 1, 128), dtype=np.float32)
        self.c = np.zeros((1, 1, 128), dtype=np.float32)
        self.context = np.zeros(CONTEXT, dtype=np.float32)
        self.pending = np.zeros(0, dtype=np.float32)

    def reset(self):
        self.speech = []
        self.speech_samples = 0
        self.recording = False
        self.silence = 0
        self.before = []  # a little audio from just before speech started

    def is_speech(self, chunk):
        frame = np.concatenate([self.context, chunk])[None, :]
        prob, self.h, self.c = VAD.run(None, {"input": frame, "h": self.h, "c": self.c})
        self.context = chunk[-CONTEXT:]
        p = float(np.ravel(prob)[0])
        return p > SPEECH_THRESHOLD or (self.recording and p >= EXIT_THRESHOLD)

    async def audio(self, data):
        if self.paused:
            return
        samples = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768
        self.pending = np.concatenate([self.pending, samples])
        while len(self.pending) >= CHUNK:
            chunk, self.pending = self.pending[:CHUNK], self.pending[CHUNK:]
            await self.on_chunk(chunk)

    async def on_chunk(self, chunk):
        was_recording = self.recording
        speech = self.is_speech(chunk)
        if not was_recording and not speech:
            self.before.append(chunk)
            if len(self.before) > SPEECH_PAD_SAMPLES // CHUNK + 1:
                self.before.pop(0)
            return
        self.speech.append(chunk)
        self.speech_samples += len(chunk)
        if self.speech_samples >= MAX_SPEECH_SAMPLES:
            self.finish()
            return
        if speech:
            if not self.recording:
                await self.send({"type": "speech_start"})
            self.recording = True
            self.silence = 0
            return
        self.silence += len(chunk)
        if self.silence < MIN_SILENCE_SAMPLES:
            return
        if self.speech_samples - self.silence < MIN_SPEECH_SAMPLES:
            self.reset()
            return
        self.finish()

    def finish(self):
        audio = np.concatenate(self.before + self.speech)
        self.reset()
        asyncio.create_task(self.transcribe(audio))

    async def transcribe(self, audio):
        await self.send({"type": "speech_end"})
        utterance_id = self.next_id
        self.next_id += 1
        # Boost quiet audio (whispers, distance) to a normal level.
        peak = float(np.abs(audio).max()) if len(audio) else 0
        if peak > 1e-4:
            audio = audio * min(0.9 / peak, 30)
        text, heard, took = "", {"match": None, "wake": None}, 0.0
        try:
            started = time.monotonic()
            async with WHISPER_LOCK:
                text = await asyncio.to_thread(self.whisper, audio)
            took = time.monotonic() - started
            feats = await asyncio.to_thread(voice_match.features, audio)
            self.recent[utterance_id] = feats
            while len(self.recent) > 8:
                self.recent.pop(next(iter(self.recent)))
            if self.templates:
                heard = await asyncio.to_thread(self.recognise, feats)
        except Exception as error:
            log("Couldn't transcribe:", error)
        if text or heard["match"] or heard["wake"] is not None:
            log(f"Heard ({took:.1f}s to write down):", heard["match"] or text)
        if not self.paused:
            await self.send({"type": "utterance", "id": utterance_id, "text": text, **heard})

    def whisper(self, audio):
        # Words you've corrected before, and "Jarvis", are what Whisper should expect to hear.
        words = ", ".join(["Jarvis", *self.vocabulary[-40:]])
        segments, _ = WHISPER.transcribe(
            audio,
            language="en" if CONFIG["whisper_model"].endswith(".en") else None,
            beam_size=1,  # fastest; Whisper is accurate enough without searching alternatives
            without_timestamps=True,
            vad_filter=False,
            condition_on_previous_text=False,
            initial_prompt="Hey Jarvis.",
            hotwords=words,
        )
        kept = [s.text for s in segments if not (s.no_speech_prob > 0.6 and s.avg_logprob < -1)]
        text = " ".join(t.strip() for t in kept).strip()
        if re.sub(r"[^a-z ]", "", text.lower()).strip() in NOISE_PHRASES:
            return ""
        return text

    def set_templates(self, templates):
        self.templates = templates
        # Calibrate "Jarvis" to the user's voice: allow a bit more difference than their own samples had.
        wakes = [t["feats"] for t in templates if t["kind"] == "wake"]
        widest = 0.0
        for i in range(len(wakes)):
            for j in range(i + 1, len(wakes)):
                widest = max(widest, voice_match.compare(wakes[i], wakes[j])[0])
        self.wake_match = min(0.68, max(0.45, widest * 1.15)) if widest else WAKE_MATCH_DEFAULT

    def recognise(self, feats):
        match, best = None, PHRASE_MATCH
        wake, best_wake = None, self.wake_match
        opening = feats[:WAKE_SEARCH_FRAMES]
        for t in self.templates:
            if t["kind"] == "phrase":
                ratio = len(feats) / max(1, len(t["feats"]))
                if not 0.6 <= ratio <= 1.6:
                    continue
                distance, _ = voice_match.compare(t["feats"], feats)
                if distance < best:
                    best, match = distance, t["text"]
            elif t["kind"] == "wake" and len(opening) >= 0.6 * len(t["feats"]):
                distance, end = voice_match.compare(t["feats"], opening, anywhere=True)
                if distance < best_wake:
                    best_wake = distance
                    wake = end * len(opening) / len(feats)  # how far into the utterance "Jarvis" ended
        return {"match": match, "wake": wake}

    async def message(self, data):
        kind = data.get("type")
        if kind == "pause":
            self.paused = True
            self.reset()
        elif kind == "resume":
            self.paused = False
            self.reset()
            self.reset_vad()
        elif kind == "templates":
            self.set_templates([{**t, "feats": voice_match.decode(t["feats"])} for t in data["templates"]])
        elif kind == "vocab":
            self.vocabulary = [w for w in data.get("words", []) if isinstance(w, str)][-200:]
        elif kind == "learn":
            feats = self.recent.get(data["id"])
            if feats is None or not len(feats):
                return
            template = {"kind": data["kind"], "text": data["text"], "feats": feats}
            self.set_templates([*self.templates, template])
            await self.send({"type": "learned", "template": {"kind": data["kind"], "text": data["text"], "feats": voice_match.encode(feats)}})


# ---------- Brain ----------


def for_speech(reply):
    # Drop any reasoning the model wrote before its answer, and formatting that sounds odd aloud.
    reply = reply.split("</think>")[-1]
    reply = re.sub(r"<think>[\s\S]*", "", reply)
    return re.sub(r"[*#`$_]|\\[()[\]]", "", reply).strip()


# Keep the models loaded between questions, so they don't have to warm up every time.
KEEP_ALIVE = "2h"
LIGHT_TEXT_MODEL = "qwen3:1.7b"
# Long answers (especially maths "thinking") can take a while; never give up on one too early.
OLLAMA_TIMEOUT = aiohttp.ClientTimeout(total=None, sock_connect=10, sock_read=300)
SENTENCE_END = re.compile(r"(?<=[.!?])\s+")


async def ollama_chat(body, on_sentence=None):
    """Asks Ollama, streaming the answer so each finished sentence can be spoken straight away."""
    answer = ""
    spoken = 0  # how much of the answer has been passed to on_sentence
    async with aiohttp.ClientSession(timeout=OLLAMA_TIMEOUT) as session:
        async with session.post(
            f"{CONFIG['ollama_url']}/api/chat", json={**body, "stream": True, "keep_alive": KEEP_ALIVE}
        ) as response:
            if response.status != 200:
                data = await response.json(content_type=None)
                raise RuntimeError(data.get("error", f"Ollama answered {response.status}"))
            async for line in response.content:
                if not line.strip():
                    continue
                data = json.loads(line)
                if data.get("error"):
                    raise RuntimeError(data["error"])
                answer += data.get("message", {}).get("content", "")
                if not on_sentence or ("<think>" in answer and "</think>" not in answer):
                    continue
                if "</think>" in answer:
                    spoken = max(spoken, answer.index("</think>") + len("</think>"))
                # Pass on every complete sentence (one followed by more text).
                for part in SENTENCE_END.split(answer[spoken:])[:-1]:
                    spoken += len(part)
                    while spoken < len(answer) and answer[spoken].isspace():
                        spoken += 1
                    sentence = for_speech(part)
                    if sentence:
                        await on_sentence(sentence)
    if on_sentence:
        rest = for_speech(answer[spoken:])
        if rest:
            await on_sentence(rest)
    return for_speech(answer)


async def ask_text(question, history, think, on_sentence):
    messages = [{"role": "system", "content": SYSTEM}, *history, {"role": "user", "content": question}]
    body = {
        "model": CONFIG["text_model"],
        "messages": messages,
        "options": {"temperature": 0.6 if think else 0.7, "num_predict": 4000 if think else 400},
    }
    try:
        return await ollama_chat({**body, "think": bool(think)}, on_sentence)
    except RuntimeError as error:
        if "think" not in str(error):
            raise
        return await ollama_chat(body, on_sentence)  # a model that can't "think" step by step


async def ask_vision(question, image, on_sentence):
    messages = [
        {"role": "system", "content": SYSTEM},
        {"role": "user", "content": f"{question}\nAnswer in one or two short spoken sentences.", "images": [image]},
    ]
    body = {"model": CONFIG["vision_model"], "messages": messages, "options": {"num_predict": 200}}
    return await ollama_chat(body, on_sentence)


async def brain(data, send):
    kind = data.get("type")
    request_id = data.get("id")
    started = time.monotonic()

    async def on_sentence(sentence):
        if not hasattr(on_sentence, "first"):
            on_sentence.first = time.monotonic() - started
        await send({"id": request_id, "partial": sentence})

    try:
        result = None
        if kind == "check":
            result = True
        elif kind == "load":
            await send({"type": "ready", "which": "text"})
        elif kind == "text":
            log("Thinking about:", data["question"].splitlines()[-1])
            result = await ask_text(data["question"], data.get("history", []), data.get("think", False), on_sentence)
        elif kind == "vision":
            log("Looking:", data["question"])
            result = await ask_vision(data["question"], data["image"], on_sentence)
        if kind in ("text", "vision"):
            first = getattr(on_sentence, "first", time.monotonic() - started)
            log(f"Answered: started speaking after {first:.1f}s, finished after {time.monotonic() - started:.1f}s")
        await send({"id": request_id, "ok": True, "result": result})
    except Exception as error:
        message = str(error) or type(error).__name__
        log("Brain error:", message)
        await send({"id": request_id, "ok": False, "error": message})


async def warm_up():
    """Loads the brain into memory now, and says whether it's on the graphics card (fast) or not."""
    model = CONFIG["text_model"]
    try:
        async with aiohttp.ClientSession(timeout=OLLAMA_TIMEOUT) as session:
            await session.post(f"{CONFIG['ollama_url']}/api/generate", json={"model": model, "keep_alive": KEEP_ALIVE})
            async with session.get(f"{CONFIG['ollama_url']}/api/ps") as response:
                running = (await response.json()).get("models", [])
        info = next((m for m in running if m.get("name", "").startswith(model)), None)
        if info is None:
            return
        on_gpu = info.get("size_vram", 0) / max(1, info.get("size", 1))
        if on_gpu > 0.9:
            log(f"Brain: {model} on the graphics card")
        elif model == DEFAULTS["text_model"]:
            # Without a big enough graphics card, a smaller brain answers several times faster.
            log(f"{model} doesn't fit on this PC's graphics card, so switching to the faster {LIGHT_TEXT_MODEL}…")
            exe = shutil.which("ollama") or "ollama"
            await asyncio.to_thread(subprocess.run, [exe, "pull", LIGHT_TEXT_MODEL])
            CONFIG["text_model"] = LIGHT_TEXT_MODEL
            CONFIG_FILE.write_text(json.dumps(CONFIG, indent=2))
            await warm_up()
        else:
            log(f"Brain: {model} is running {'partly ' if on_gpu else ''}on the processor, so answers will be slow.")
    except Exception as error:
        log("Couldn't warm up the brain:", error)


# ---------- Web server ----------


async def socket(request):
    if request.query.get("key") != CONFIG["key"]:
        raise web.HTTPForbidden(text="Wrong key. Scan the QR code shown on your PC again.")
    ws = web.WebSocketResponse(heartbeat=20, max_msg_size=20 * 1024 * 1024)
    await ws.prepare(request)
    log("Phone connected")
    lock = asyncio.Lock()

    def sender(channel):
        async def send(message):
            if ws.closed:
                return
            async with lock:
                await ws.send_str(json.dumps({"ch": channel, **message}))

        return send

    ears = Ears(sender("ears"))
    await ears.send({"type": "ready"})
    async for message in ws:
        if message.type == aiohttp.WSMsgType.BINARY:
            await ears.audio(message.data)
        elif message.type == aiohttp.WSMsgType.TEXT:
            data = json.loads(message.data)
            if data.get("ch") == "ears":
                await ears.message(data)
            elif data.get("ch") == "brain":
                asyncio.create_task(brain(data, sender("brain")))
    log("Phone disconnected")
    return ws


async def index(request):
    return web.FileResponse(WEB / "index.html")


@web.middleware
async def no_cache(request, handler):
    response = await handler(request)
    response.headers["Cache-Control"] = "no-store"
    return response


def make_app():
    app = web.Application(middlewares=[no_cache])
    app.router.add_get("/ws", socket)
    app.router.add_get("/", index)
    app.router.add_static("/", WEB)
    return app


# ---------- Starting up ----------


async def ollama_running():
    try:
        async with aiohttp.ClientSession() as session:
            async with session.get(f"{CONFIG['ollama_url']}/api/version", timeout=aiohttp.ClientTimeout(total=2)) as r:
                return r.status == 200
    except Exception:
        return False


async def prepare_ollama():
    if not await ollama_running():
        exe = shutil.which("ollama") or str(Path(os.environ.get("LOCALAPPDATA", "")) / "Programs" / "Ollama" / "ollama.exe")
        if not Path(exe).exists() and not shutil.which("ollama"):
            sys.exit("Ollama isn't installed. Get it free from https://ollama.com/download, then run this again.")
        log("Starting Ollama…")
        subprocess.Popen([exe, "serve"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(30):
            if await ollama_running():
                break
            await asyncio.sleep(1)
    exe = shutil.which("ollama") or "ollama"
    for model in {CONFIG["text_model"], CONFIG["vision_model"]}:
        log(f"Making sure {model} is downloaded (the first time takes a while)…")
        # Shows Ollama's own progress bar; does nothing if it's already downloaded.
        await asyncio.to_thread(subprocess.run, [exe, "pull", model])


def find_cloudflared():
    candidates = [
        shutil.which("cloudflared"),
        r"C:\Program Files (x86)\cloudflared\cloudflared.exe",
        r"C:\Program Files\cloudflared\cloudflared.exe",
        str(HERE / "cloudflared.exe"),
        str(Path(os.environ.get("LOCALAPPDATA", "")) / "Microsoft" / "WinGet" / "Links" / "cloudflared.exe"),
    ]
    return next((c for c in candidates if c and Path(c).exists()), None)


async def open_tunnel(port):
    """A free Cloudflare quick tunnel gives the PC a secure https:// address that the iPhone can reach
    from anywhere (Safari only allows the microphone on secure pages)."""
    exe = find_cloudflared()
    if not exe:
        return None
    process = await asyncio.create_subprocess_exec(
        exe, "tunnel", "--no-autoupdate", "--url", f"http://localhost:{port}",
        stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.PIPE,
    )
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            line = await asyncio.wait_for(process.stderr.readline(), timeout=deadline - time.time())
        except asyncio.TimeoutError:
            break
        if not line:
            break
        found = re.search(rb"https://[a-z0-9-]+\.trycloudflare\.com", line)
        if found:
            # Keep reading its output so it never blocks.
            asyncio.create_task(drain(process.stderr))
            return found.group().decode()
    return None


async def drain(stream):
    while await stream.readline():
        pass


def show_link(url):
    import qrcode

    link = f"{url}/?key={CONFIG['key']}"
    print()
    print("=" * 64)
    print("  Jarvis is ready. On your iPhone, open the Camera app and scan this,")
    print("  then tap Wake Jarvis. Keep this window open while you use Jarvis.")
    print("=" * 64)
    qr = qrcode.QRCode(border=2)
    qr.add_data(link)
    try:
        qr.print_ascii(invert=True)
    except Exception:
        pass
    # Also as a picture, in case the window can't draw the code above.
    picture = HERE / "jarvis-link.png"
    try:
        qr.make_image().save(picture)
        if hasattr(os, "startfile"):
            os.startfile(picture)
    except Exception:
        pass
    print(f"  Or type this into Safari: {link}")
    print("  (The address changes every time you start Jarvis, so scan the new code each time.)")
    print()


async def main():
    global VAD, WHISPER
    port = int(CONFIG["port"])
    await prepare_ollama()
    log("Loading hearing models…")
    VAD = load_vad()
    WHISPER = await asyncio.to_thread(load_whisper)
    await warm_up()
    runner = web.AppRunner(make_app())
    await runner.setup()
    await web.TCPSite(runner, "0.0.0.0", port).start()
    log(f"Jarvis server running on port {port}")
    url = await open_tunnel(port)
    if url:
        show_link(url)
    else:
        print(
            "\nCouldn't start the secure tunnel. Install cloudflared (start-jarvis.bat does this),\n"
            "or open the page through Tailscale or another https address pointing at port "
            f"{port}, adding ?key={CONFIG['key']} to it.\n"
        )
    await asyncio.Event().wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
