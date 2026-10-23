import CoreImage
import Foundation
import FoundationModels
import HuggingFace
import MLX
import MLXHuggingFace
import MLXLMCommon
import MLXVLM
import Tokenizers

/// Jarvis's brain. Everything runs on the iPhone itself: no account, no API, no cost per question.
///
/// - With the app on screen, questions go to a free open-weight vision model (Qwen3-VL 4B) running on
///   the phone's GPU with MLX. It can see through the camera.
/// - With the screen locked, iOS doesn't let apps use the GPU, so questions go to Apple's built-in
///   on-device model (Apple Intelligence), which keeps working in the background. It can't see.
/// - Time, date and reminders are handled directly in code and never touch a model.
actor LocalBrain {
    static let shared = LocalBrain()

    /// Free open-weight vision model, about 3 GB, downloaded once from Hugging Face on first launch.
    static let visionModel = VLMRegistry.qwen3VL4BInstruct4Bit

    private static let instructions = """
    You are Jarvis, a helpful voice assistant on the user's iPhone. Address the user as "sir". \
    Everything you write is read aloud, so answer in plain spoken sentences: no markdown, no lists, \
    no emoji, no LaTeX. Keep answers to one to three sentences unless asked for detail. Say maths \
    the way a person would, for example "the integral of x from one to two is three halves". \
    When a photo is attached, it is what the user's phone camera sees right now.
    """

    private var container: ModelContainer?
    private var visionSession: ChatSession?
    private var appleSession: LanguageModelSession?
    private var lastAskedAt = Date.distantPast
    /// Follow-up questions ("and what about…") keep context for this long.
    private let conversationTimeout: TimeInterval = 5 * 60

    var isVisionModelReady: Bool { container != nil }

    /// Downloads the vision model the first time, then loads it into memory.
    /// `progress` reports 0...1 while downloading.
    func prepare(progress: @escaping @Sendable (Double) -> Void) async throws {
        guard container == nil else { return }
        Memory.cacheLimit = 20 * 1024 * 1024
        container = try await VLMModelFactory.shared.loadContainer(
            from: #hubDownloader(),
            using: #huggingFaceTokenizerLoader(),
            configuration: Self.visionModel
        ) { p in
            progress(p.fractionCompleted)
        }
    }

    /// Answers a spoken question. `cameraFrame` is only passed when the question is about what the
    /// user sees; `inBackground` is true when the screen is locked or another app is open.
    func ask(_ question: String, cameraFrame: CIImage?, inBackground: Bool) async throws -> String {
        if let answer = try await LocalSkills.answer(question) {
            return answer
        }

        if Date().timeIntervalSince(lastAskedAt) > conversationTimeout {
            await visionSession?.clear()
            appleSession = nil
        }
        lastAskedAt = Date()
        let prompt = "[Local time: \(LocalSkills.timeDescription())]\n\(question)"

        if !inBackground, let container {
            let session = visionSession ?? ChatSession(
                container,
                instructions: Self.instructions,
                generateParameters: GenerateParameters(maxTokens: 400, temperature: 0.6),
                processing: .init(resize: CGSize(width: 768, height: 768))
            )
            visionSession = session
            let image = cameraFrame.map { UserInput.Image.ciImage($0) }
            return Self.forSpeech(try await session.respond(to: prompt, image: image))
        }

        if let reply = try await askApple(prompt) {
            return Self.forSpeech(reply)
        }
        if inBackground {
            return "I can only think with the app open, sir. Turn on Apple Intelligence in Settings so I can answer with the screen locked."
        }
        return "I'm still downloading my brain, sir. Keep the app open on Wi-Fi for a few minutes."
    }

    /// Apple's on-device model (needs Apple Intelligence switched on). Returns nil if it isn't available.
    private func askApple(_ prompt: String) async throws -> String? {
        guard case .available = SystemLanguageModel.default.availability else { return nil }
        let session = appleSession ?? LanguageModelSession(instructions: Self.instructions)
        appleSession = session
        return try await session.respond(to: prompt).content
    }

    /// Strips formatting that sounds odd when read aloud.
    private static func forSpeech(_ text: String) -> String {
        var t = text
        for token in ["**", "__", "`", "#", "\\(", "\\)", "\\[", "\\]", "$"] {
            t = t.replacingOccurrences(of: token, with: "")
        }
        return t.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
