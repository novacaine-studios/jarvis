import AVFoundation

/// Speaks replies with the best British English voice installed on the phone.
/// Utterance volume stays at its default, which is relative to the current system volume,
/// so Jarvis is never louder than you've set the phone.
final class Speaker: NSObject, AVSpeechSynthesizerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private var finished: CheckedContinuation<Void, Never>?

    private static let voice: AVSpeechSynthesisVoice? = {
        let british = AVSpeechSynthesisVoice.speechVoices().filter { $0.language == "en-GB" }
        return british.max { $0.quality.rawValue < $1.quality.rawValue }
            ?? AVSpeechSynthesisVoice(language: "en-GB")
    }()

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func speak(_ text: String) async {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.voice
        await withCheckedContinuation { cont in
            finished = cont
            synthesizer.speak(utterance)
        }
    }

    func stop() {
        synthesizer.stopSpeaking(at: .immediate)
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        resume()
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        resume()
    }

    private func resume() {
        finished?.resume()
        finished = nil
    }
}
