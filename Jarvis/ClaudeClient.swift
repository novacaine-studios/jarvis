import Foundation

/// Talks to the Claude API over plain HTTPS (there is no official Swift SDK).
/// Claude does the seeing, reasoning and maths; the phone supplies the camera frame,
/// the local time, and a tool for setting reminders.
actor ClaudeClient {
    static let shared = ClaudeClient()

    static let model = "claude-opus-5-5"
    /// "low" keeps spoken answers quick. Raise to "medium" or "high" for harder questions.
    static let effort = "low"

    private let endpoint = URL(string: "https://api.anthropic.com/v1/messages")!
    private var history: [[String: Any]] = []
    private var lastAskedAt = Date.distantPast
    /// Follow-up questions ("and what about…") keep context for this long.
    private let conversationTimeout: TimeInterval = 5 * 60

    private let system = """
    You are Jarvis, a voice assistant that lives on the user's iPhone. Everything you write \
    is read aloud by a text-to-speech voice, so answer in plain spoken sentences: no markdown, \
    no lists, no emoji, no URLs. Keep answers short (one to three sentences) unless the user \
    asks for detail. Say maths the way a person would ("the integral of x from one to two is \
    three halves"). When a photo from the phone's back camera is attached, it shows what the \
    user is looking at right now; use it for questions like "what am I looking at". If no photo \
    is attached and the question needs one, say the camera is only available while the Jarvis \
    app is open. Use the set_reminder tool for reminders, and web search for current events, \
    weather, scores and other live facts. The user's local time is given with each question.
    """

    private let tools: [[String: Any]] = [
        [
            "name": "set_reminder",
            "description": "Create a reminder in the user's Apple Reminders app. Use for requests like 'remind me to…' or 'set a reminder for…'.",
            "input_schema": [
                "type": "object",
                "properties": [
                    "title": ["type": "string", "description": "What to remind the user about."],
                    "due": ["type": "string", "description": "When to remind them, as ISO 8601 with the user's UTC offset, e.g. 2026-10-24T09:00:00-07:00. Omit for no due time."],
                ],
                "required": ["title"],
                "additionalProperties": false,
            ],
            "strict": true,
        ],
        ["type": "web_search_20260209", "name": "web_search", "max_uses": 3],
    ]

    func ask(_ question: String, cameraJPEG: Data?) async throws -> String {
        if Date().timeIntervalSince(lastAskedAt) > conversationTimeout {
            history = []
        }
        lastAskedAt = Date()

        var content: [[String: Any]] = []
        if let cameraJPEG {
            content.append([
                "type": "image",
                "source": ["type": "base64", "media_type": "image/jpeg", "data": cameraJPEG.base64EncodedString()],
            ])
        }
        content.append(["type": "text", "text": "[Local time: \(Self.localTimeDescription())]\n\(question)"])
        history.append(["role": "user", "content": content])

        // Loop while Claude is calling tools.
        for _ in 0..<6 {
            let response = try await send()
            let assistantContent = response["content"] as? [[String: Any]] ?? []
            // Keep the whole content array (thinking blocks included) so the next request is valid.
            history.append(["role": "assistant", "content": assistantContent])

            switch response["stop_reason"] as? String {
            case "tool_use":
                var results: [[String: Any]] = []
                for block in assistantContent where block["type"] as? String == "tool_use" {
                    let id = block["id"] as? String ?? ""
                    let input = block["input"] as? [String: Any] ?? [:]
                    let (text, isError) = await runTool(named: block["name"] as? String ?? "", input: input)
                    results.append(["type": "tool_result", "tool_use_id": id, "content": text, "is_error": isError])
                }
                history.append(["role": "user", "content": results])
            case "pause_turn":
                continue // a long web search; send again so Claude can finish
            case "refusal":
                return "Sorry, I can't help with that one."
            default:
                let text = assistantContent
                    .filter { $0["type"] as? String == "text" }
                    .compactMap { $0["text"] as? String }
                    .joined()
                    .trimmingCharacters(in: .whitespacesAndNewlines)
                return text.isEmpty ? "Done." : text
            }
        }
        return "Sorry, that took too many steps. Try asking a simpler way."
    }

    private func send() async throws -> [String: Any] {
        guard let apiKey = KeychainStore.apiKey, !apiKey.isEmpty else {
            throw JarvisError("Add your Anthropic API key in Settings first.")
        }
        let body: [String: Any] = [
            "model": Self.model,
            "max_tokens": 16000,
            "system": system,
            "tools": tools,
            "messages": history,
            "output_config": ["effort": Self.effort],
            // If a safety check declines a request, let the API retry it on a fallback model.
            "fallbacks": "default",
        ]
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 120
        request.setValue("application/json", forHTTPHeaderField: "content-type")
        request.setValue(apiKey, forHTTPHeaderField: "x-api-key")
        request.setValue("2026-10-21", forHTTPHeaderField: "anthropic-version")
        request.setValue("server-side-fallback-2026-07-01", forHTTPHeaderField: "anthropic-beta")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)

        let (data, response) = try await URLSession.shared.data(for: request)
        let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            // Drop the question that failed so the conversation stays valid for the next one.
            history.removeAll()
            let message = (json["error"] as? [String: Any])?["message"] as? String ?? "HTTP error"
            throw JarvisError(message)
        }
        return json
    }

    private func runTool(named name: String, input: [String: Any]) async -> (String, Bool) {
        switch name {
        case "set_reminder":
            do {
                let summary = try await Reminders.add(
                    title: input["title"] as? String ?? "Reminder",
                    dueISO8601: input["due"] as? String
                )
                return (summary, false)
            } catch {
                return ("Couldn't create the reminder: \(error.localizedDescription)", true)
            }
        default:
            return ("Unknown tool \(name).", true)
        }
    }

    private static func localTimeDescription() -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEEE d MMMM yyyy, h:mm a"
        let iso = ISO8601DateFormatter()
        iso.timeZone = .current
        return "\(formatter.string(from: Date())) (\(iso.string(from: Date())), \(TimeZone.current.identifier))"
    }
}

struct JarvisError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}
