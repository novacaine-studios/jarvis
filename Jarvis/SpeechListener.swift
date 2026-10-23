import AVFoundation
import Speech

/// Continuous on-device speech recognition. Audio stays on the phone; only the final
/// question text is sent to Claude.
///
/// The microphone (`startAudio`) and the recognizer (`startRecognition`) are separate on purpose:
/// iOS lets a running microphone keep going when the screen locks, but won't let an app turn the
/// microphone on from the background. So the mic stays on for the whole session and only the
/// recognition task is swapped between questions.
final class SpeechListener {
    var onTranscript: ((String) -> Void)?
    /// Asked before the periodic restart, so a question isn't cut off halfway.
    var mayRestart: (() -> Bool)?

    private let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US"))
    private let audioEngine = AVAudioEngine()
    private let requestLock = NSLock()
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var restartTimer: Timer?
    private var wantsAudio = false
    /// Bumped on every start/stop so callbacks from an old task are ignored.
    private var generation = 0
    private var observers: [NSObjectProtocol] = []

    init() {
        let center = NotificationCenter.default
        // Connecting or disconnecting AirPods changes the mic format and stops the engine.
        observers.append(center.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: audioEngine, queue: .main
        ) { [weak self] _ in
            self?.recoverAudio()
        })
        // A phone call or Siri interrupts the mic; pick up again when it's over.
        observers.append(center.addObserver(
            forName: AVAudioSession.interruptionNotification, object: nil, queue: .main
        ) { [weak self] note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .ended else { return }
            try? AVAudioSession.sharedInstance().setActive(true)
            self?.recoverAudio()
        })
    }

    // MARK: - Microphone

    func startAudio() throws {
        wantsAudio = true
        guard !audioEngine.isRunning else { return }
        let input = audioEngine.inputNode
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: input.outputFormat(forBus: 0)) { [weak self] buffer, _ in
            self?.currentRequest()?.append(buffer)
        }
        audioEngine.prepare()
        try audioEngine.start()
    }

    func stopAudio() {
        wantsAudio = false
        stopRecognition()
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
    }

    private func recoverAudio() {
        guard wantsAudio else { return }
        let wasRecognizing = currentRequest() != nil
        audioEngine.stop()
        try? startAudio()
        if wasRecognizing {
            startRecognition()
        }
    }

    // MARK: - Recognition

    func startRecognition() {
        stopRecognition()
        generation += 1
        let myGeneration = generation

        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true
        request.contextualStrings = ["Jarvis", "Hey Jarvis"]
        if recognizer?.supportsOnDeviceRecognition == true {
            request.requiresOnDeviceRecognition = true
        }
        requestLock.withLock { self.request = request }

        task = recognizer?.recognitionTask(with: request) { [weak self] result, error in
            DispatchQueue.main.async {
                guard let self, self.generation == myGeneration else { return }
                if let result {
                    self.onTranscript?(result.bestTranscription.formattedString)
                }
                // Recognition tasks end on their own after a while; start a fresh one.
                if error != nil || result?.isFinal == true {
                    self.startRecognition()
                }
            }
        }

        // Recycle the task regularly so the transcript doesn't grow forever.
        restartTimer = Timer.scheduledTimer(withTimeInterval: 50, repeats: true) { [weak self] _ in
            guard let self, self.mayRestart?() ?? true else { return }
            self.startRecognition()
        }
    }

    func stopRecognition() {
        generation += 1
        restartTimer?.invalidate()
        restartTimer = nil
        task?.cancel()
        task = nil
        requestLock.withLock {
            request?.endAudio()
            request = nil
        }
    }

    private func currentRequest() -> SFSpeechAudioBufferRecognitionRequest? {
        requestLock.withLock { request }
    }
}
