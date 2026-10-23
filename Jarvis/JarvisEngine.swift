import AVFoundation
import Speech
import UIKit

/// Ties everything together:
/// wake word -> collect the question -> grab a camera frame -> ask Claude -> speak the answer -> listen again.
/// Once started, the microphone stays on (including with the screen locked) until you say
/// "Jarvis, go to sleep".
@MainActor
final class JarvisEngine: ObservableObject {
    static let shared = JarvisEngine()

    enum State {
        case off, waitingForWakeWord, listening, thinking, speaking

        var label: String {
            switch self {
            case .off: "Asleep: say “Hey Siri, start Jarvis”"
            case .waitingForWakeWord: "Say “Jarvis”"
            case .listening: "Listening…"
            case .thinking: "Thinking…"
            case .speaking: "Speaking"
            }
        }

        var icon: String {
            switch self {
            case .off: "moon.zzz"
            case .waitingForWakeWord: "ear"
            case .listening: "waveform"
            case .thinking: "sparkles"
            case .speaking: "speaker.wave.2"
            }
        }
    }

    @Published private(set) var state: State = .off
    @Published private(set) var heardText = ""
    @Published private(set) var replyText = ""
    /// Shown while the free vision model downloads on first launch.
    @Published private(set) var brainStatus = ""

    let camera = CameraService()
    private let listener = SpeechListener()
    private let speaker = Speaker()
    private var silenceTimer: Timer?
    private var starting = false
    /// True until Jarvis has said "Yes, sir?": the question is whatever follows "Jarvis".
    /// After "Yes, sir?" the next thing you say is the question, no wake word needed.
    private var questionFollowsWakeWord = true

    /// Pause after the last word before we treat the question as finished.
    private let endOfQuestionSilence: TimeInterval = 1.5
    /// Pause after a bare "Jarvis" before he says "Yes, sir?".
    private let yesSirDelay: TimeInterval = 1.5
    /// How long to wait for a question after "Yes, sir?" before going back to waiting for "Jarvis".
    private let noQuestionTimeout: TimeInterval = 8

    private static let sleepCommands = ["go to sleep", "stop listening", "goodbye", "good night", "shut down"]
    private static let cancelCommands = ["never mind", "nevermind", "cancel", "nothing", "stop"]

    var isRunning: Bool { state != .off }

    private init() {
        listener.onTranscript = { [weak self] text in
            Task { @MainActor in self?.handleTranscript(text) }
        }
        // Only recycle the recognizer while nobody is mid-question.
        listener.mayRestart = { [weak self] in
            MainActor.assumeIsolated { self?.state == .waitingForWakeWord }
        }
    }

    /// Turns the microphone on. Must run while the app is on screen (iOS won't start a mic from
    /// the background); after that it keeps listening with the screen locked.
    func start() {
        guard state == .off, !starting else { return }
        starting = true
        Task {
            defer { starting = false }
            guard await Permissions.requestAll() else {
                replyText = "Jarvis needs microphone, speech recognition and camera access. Turn them on in Settings."
                return
            }
            do {
                try AudioRouting.configure()
                camera.start()
                try listener.startAudio()
                resumeListening()
                loadBrain()
            } catch {
                replyText = "Couldn't start listening: \(error.localizedDescription)"
            }
        }
    }

    private func loadBrain() {
        Task {
            let ready = await LocalBrain.shared.isVisionModelReady
            guard !ready else { return }
            brainStatus = "Downloading Jarvis's brain…"
            do {
                try await LocalBrain.shared.prepare { fraction in
                    Task { @MainActor in
                        JarvisEngine.shared.brainStatus = "Downloading Jarvis's brain: \(Int(fraction * 100))%"
                    }
                }
                brainStatus = ""
            } catch {
                brainStatus = "Couldn't download the brain: \(error.localizedDescription). Reopen the app on Wi-Fi to retry."
            }
        }
    }

    func stop() {
        silenceTimer?.invalidate()
        listener.stopAudio()
        speaker.stop()
        camera.stop()
        state = .off
    }

    // MARK: - Wake word and question capture

    private func handleTranscript(_ transcript: String) {
        switch state {
        case .waitingForWakeWord:
            guard let question = Self.textAfterWakeWord(in: transcript) else { return }
            state = .listening
            heardText = question
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            armSilenceTimer()
        case .listening:
            if questionFollowsWakeWord {
                heardText = Self.textAfterWakeWord(in: transcript) ?? heardText
            } else {
                heardText = Self.textAfterWakeWord(in: transcript)
                    ?? transcript.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            armSilenceTimer()
        default:
            break
        }
    }

    private func armSilenceTimer() {
        silenceTimer?.invalidate()
        let wait: TimeInterval
        if !heardText.isEmpty {
            wait = endOfQuestionSilence
        } else {
            wait = questionFollowsWakeWord ? yesSirDelay : noQuestionTimeout
        }
        silenceTimer = Timer.scheduledTimer(withTimeInterval: wait, repeats: false) { [weak self] _ in
            Task { @MainActor in self?.silenceReached() }
        }
    }

    private func silenceReached() {
        listener.stopRecognition()
        let question = heardText

        if !question.isEmpty {
            Task { await handle(question) }
        } else if questionFollowsWakeWord {
            // A bare "Jarvis" and then nothing: answer him like a butler, then take the question.
            Task {
                await say("Yes, sir?")
                guard state != .off else { return }
                questionFollowsWakeWord = false
                heardText = ""
                listener.startRecognition()
                state = .listening
                armSilenceTimer()
            }
        } else {
            // Still nothing after "Yes, sir?": go back to waiting for "Jarvis".
            resumeListening()
        }
    }

    /// Returns the words spoken after the last "Jarvis" (or nil if the wake word wasn't said).
    static func textAfterWakeWord(in transcript: String) -> String? {
        guard let range = transcript.range(of: "jarvis", options: [.caseInsensitive, .backwards]) else {
            return nil
        }
        return transcript[range.upperBound...]
            .trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
    }

    // MARK: - Answering

    private func handle(_ question: String) async {
        let command = question.lowercased()
        if Self.sleepCommands.contains(where: { command.contains($0) }) {
            await say("Going to sleep, sir.")
            stop()
            return
        }
        if Self.cancelCommands.contains(command) {
            resumeListening()
            return
        }

        state = .thinking
        replyText = ""
        let inBackground = UIApplication.shared.applicationState == .background
        let frame = Self.isAboutWhatISee(command) ? camera.latestImage() : nil

        let reply: String
        do {
            reply = try await LocalBrain.shared.ask(question, cameraFrame: frame, inBackground: inBackground)
        } catch {
            reply = "Sorry, sir, something went wrong. \(error.localizedDescription)"
        }
        replyText = reply
        await say(reply)
        resumeListening()
    }

    /// Questions that need the camera, e.g. "what am I looking at", "read this", "what colour is that".
    private static func isAboutWhatISee(_ command: String) -> Bool {
        let pattern = #"\b(look|looking|see|seeing|this|that|these|those|here|camera|read|holding|wearing|front of me|colou?r|identify|picture|photo|screen|sign|label)\b"#
        return command.range(of: pattern, options: .regularExpression) != nil
    }

    private func say(_ text: String) async {
        guard AudioRouting.canSpeakAloud else { return }
        state = .speaking
        await speaker.speak(text)
    }

    private func resumeListening() {
        silenceTimer?.invalidate()
        guard state != .off || starting else { return }
        heardText = ""
        questionFollowsWakeWord = true
        listener.startRecognition()
        state = .waitingForWakeWord
    }
}

enum Permissions {
    static func requestAll() async -> Bool {
        let speech = await withCheckedContinuation { cont in
            SFSpeechRecognizer.requestAuthorization { cont.resume(returning: $0 == .authorized) }
        }
        let mic = await AVAudioApplication.requestRecordPermission()
        let camera = await AVCaptureDevice.requestAccess(for: .video)
        return speech && mic && camera
    }
}
