# Jarvis for iPhone

A voice and vision assistant. Say "Jarvis" or "Hey Jarvis", ask anything, and it answers out loud.
Everything works by voice, including with the screen locked and the phone in your pocket.

**Completely free.** All the AI runs on the iPhone itself. There's no account, no API key, no
Anthropic or OpenAI service, and no cost per question. After the first download it works offline.

## Talking to Jarvis

| You say | Jarvis |
|---|---|
| "Jarvis, what time is it?" | Answers straight away |
| "Jarvis" … (pause) | "Yes, sir?" and then listens for your question, no second "Jarvis" needed |
| "Jarvis, what am I looking at?" | Looks through the back camera (app must be on screen) |
| "Jarvis, remind me to call Mum at 6" | Adds it to Apple Reminders |
| "Jarvis, never mind" | Goes back to waiting quietly |
| "Jarvis, go to sleep" | "Going to sleep, sir." and turns the microphone off |
| "Hey Siri, start Jarvis" | Opens Jarvis and starts listening again (after sleep, a restart, or iOS closing it) |
| "Hey Siri, ask Jarvis" | Siri says "Yes, sir?", asks Jarvis, and reads the answer. Works even when Jarvis isn't running |

Jarvis starts listening by itself as soon as the app opens; there's nothing to tap.

## How it works

```
mic ──► on-device speech recognition ──► hears "Jarvis"? ──► collects your question
                                                               (ends after 1.5 s of silence)
                                                                        │
          time, date, "remind me…" ──► answered in code ◄───────────────┤
                                                                        │
  app on screen ──► Qwen3-VL 4B on the iPhone GPU (sees the camera when you ask about it)
  screen locked ──► Apple Intelligence on-device model (no camera)
                                                                        │
                        spoken reply (British voice) ──► AirPods if connected, else loudspeaker
```

**Which AI?** Training a vision-language model from scratch takes thousands of GPUs and millions of
dollars, so Jarvis uses free open-weight models instead. Their weights are published for anyone to
use and they run locally on your phone:

- **Qwen3-VL 4B** (open-weight, from Alibaba's Qwen team), run with Apple's free MLX library. It
  understands camera images and handles maths and general questions. It downloads once (about 3 GB,
  use Wi-Fi) the first time you open Jarvis.
- **Apple's on-device model**, built into iOS 26 on the iPhone 17 Pro. Jarvis uses it with the screen
  locked, because iOS doesn't let apps use the GPU in the background. Apple Intelligence must be turned on
  in Settings.

These are smaller than the big cloud AIs, so expect them to be a little less sharp on hard questions,
and they can't look things up online (no live news, weather or scores).

| File | Job |
|---|---|
| `JarvisEngine.swift` | The loop: wait for wake word, capture question, ask, speak, listen again |
| `SpeechListener.swift` | Continuous on-device speech recognition; keeps the mic alive when the screen locks |
| `LocalBrain.swift` | The on-device AI models and conversation memory (5 min) |
| `LocalSkills.swift` | Time, date and reminders, answered instantly without a model |
| `SiriShortcuts.swift` | "Hey Siri, start Jarvis" and "Hey Siri, ask Jarvis" |
| `CameraService.swift` | Keeps the newest back-camera frame; it never leaves the phone |
| `Reminders.swift` | Adds reminders to Apple Reminders |
| `Speaker.swift` | Text to speech |
| `AudioRouting.swift` | Audio session: AirPods or speaker, never touches volume |

## Volume and audio output

- Jarvis never reads or changes the system volume. Speech plays at whatever level your phone is set to.
- With AirPods connected, Jarvis listens through the AirPods microphone and replies in your ears,
  so the phone can stay locked in your pocket. Otherwise it uses the phone's mic and loudspeaker.
- Trade-off: while Jarvis is listening through AirPods, they run in headset mode, so music you play
  through them sounds like phone-call quality. Say "Jarvis, go to sleep" when you want full-quality music.
- If the phone volume is all the way down and no headphones are connected, the reply is only shown on screen.
- iOS gives apps no way to read the ring/silent switch, so Jarvis uses "volume at zero" as its "sound off" signal.
- Music and podcasts keep playing while Jarvis listens.

## Limits you should know about

- **The camera can't run 24/7.** iOS shuts off the camera whenever an app leaves the screen. Jarvis keeps
  the camera live while the app is open. Vision questions only work with the app on screen.
- **"Phone off" means screen off, not powered off.** Once Jarvis has started (the app opened at least
  once), it keeps listening with the screen locked or while you use other apps; you'll see the orange
  mic dot. A powered-off phone can't run anything.
- **iOS can still close Jarvis**, for example after a restart or under memory pressure. iOS also never
  lets an app switch the mic on from the lock screen by itself, so to bring Jarvis back say
  "Hey Siri, start Jarvis" (you may need to unlock with Face ID). After a phone call, Jarvis
  picks up listening again on its own.
- **Battery.** Camera plus continuous speech recognition costs real battery, roughly like recording video.
  Use it in sessions rather than all day.
- **Memory.** The vision model needs about 3 GB of RAM. If iOS closes Jarvis in the background to free
  memory, say "Hey Siri, start Jarvis".
- **Cost.** None. The only download is the model, once.

## Installing from Windows (no Mac)

1. Every push to `main` runs the **Build iPhone app** workflow on GitHub's Macs. Open the Actions tab, pick the latest run, and download
   **Jarvis-ipa** under Artifacts. Unzip it to get `Jarvis.ipa`.
2. On Windows, install iTunes (the version from apple.com, not the Microsoft Store) and
   [Sideloadly](https://sideloadly.io).
3. Plug in your iPhone, drag `Jarvis.ipa` into Sideloadly, sign in with your Apple ID, and press Start.
4. On the iPhone: Settings › General › VPN & Device Management › trust your Apple ID.
   Then Settings › Privacy & Security › Developer Mode › on (the phone restarts).
5. Open Jarvis on Wi-Fi and wait for the one-time brain download (shown at the top), then talk.

With a free Apple ID the app stops opening after 7 days. Re-run step 3 to renew it.
With the paid Apple Developer Program ($99/yr) you can use TestFlight instead, and builds last 90 days.

## Running it on your iPhone 17 Pro from a Mac

You need a Mac with Xcode 26 or newer.

1. Clone this repo on your Mac.
2. Run `brew install xcodegen`, then `xcodegen` inside the folder. This creates `Jarvis.xcodeproj`.
3. Open `Jarvis.xcodeproj`, choose your team under Signing & Capabilities, plug in your iPhone, and press Run.
4. On first launch, allow mic, speech, and camera access, and wait for the brain download.
5. Jarvis starts listening right away. Say "Hey Jarvis, what am I looking at?"

## Settings worth tweaking

- `LocalBrain.visionModel`: swap in another model from MLX's `VLMRegistry`, e.g. `gemma4_E4B_it_4bit`,
  or a smaller one like `gemma4_E2B_it_4bit` if memory is tight.
- `JarvisEngine.endOfQuestionSilence`: how long a pause ends your question.
- `JarvisEngine.yesSirDelay`: how long after a bare "Jarvis" he says "Yes, sir?".
