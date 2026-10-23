import AppIntents

/// "Hey Siri, start Jarvis": opens the app and turns the microphone on. This is the voice way to
/// bring Jarvis back after "go to sleep", a restart of the phone, or iOS closing the app.
struct StartJarvisIntent: AppIntent {
    static let title: LocalizedStringResource = "Start Jarvis"
    static let description = IntentDescription("Opens Jarvis and starts listening for “Jarvis”.")
    // iOS only lets an app turn the microphone on while it's on screen.
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        JarvisEngine.shared.start()
        return .result()
    }
}

/// "Hey Siri, ask Jarvis": works from the lock screen even when Jarvis isn't running.
/// Siri says "Yes, sir?", takes your question, and reads out the answer. This uses Apple's
/// on-device model (Apple Intelligence), since iOS doesn't allow the camera or GPU in the background.
struct AskJarvisIntent: AppIntent {
    static let title: LocalizedStringResource = "Ask Jarvis"
    static let description = IntentDescription("Ask Jarvis a question and hear the answer.")

    @Parameter(title: "Question", requestValueDialog: "Yes, sir?")
    var question: String

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let reply = try await LocalBrain.shared.ask(question, cameraFrame: nil, inBackground: true)
        return .result(dialog: "\(reply)")
    }
}

struct JarvisShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartJarvisIntent(),
            phrases: ["Start \(.applicationName)", "Wake up \(.applicationName)", "Turn on \(.applicationName)"],
            shortTitle: "Start Jarvis",
            systemImageName: "ear"
        )
        AppShortcut(
            intent: AskJarvisIntent(),
            phrases: ["Ask \(.applicationName)", "Ask \(.applicationName) a question"],
            shortTitle: "Ask Jarvis",
            systemImageName: "sparkles"
        )
    }
}
