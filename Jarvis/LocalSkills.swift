import Foundation

/// Things Jarvis answers instantly in code, without a model: the time, the date, and reminders.
enum LocalSkills {
    static func answer(_ question: String) async throws -> String? {
        let q = question.lowercased()

        if q.contains("remind me") || matches(q, #"\bset (a |an |me a )?reminder"#) {
            return try await setReminder(from: question)
        }
        if matches(q, #"\b(what('s| is) the time|what time is it|time is it)\b"#) {
            return "It's \(Date().formatted(date: .omitted, time: .shortened)), sir."
        }
        if matches(q, #"\b(what('s| is)( the)? date|what day is (it|today)|today'?s date)\b"#) {
            return "It's \(Date().formatted(.dateTime.weekday(.wide).day().month(.wide))), sir."
        }
        return nil
    }

    /// "Remind me to call Mum at 6pm tomorrow" -> a reminder titled "call Mum", due tomorrow at 6pm.
    private static func setReminder(from question: String) async throws -> String {
        var title = question
        var due: Date?

        let detector = try NSDataDetector(types: NSTextCheckingResult.CheckingType.date.rawValue)
        let range = NSRange(question.startIndex..., in: question)
        if let match = detector.firstMatch(in: question, range: range), let date = match.date,
           let dateRange = Range(match.range, in: question) {
            due = date
            title.removeSubrange(dateRange)
        }

        title = title.replacingOccurrences(
            of: #"^\s*(please\s+)?(can you\s+)?(set\s+(a|an|me a)\s+reminder(\s+(for|to|that|about))?|remind me(\s+(to|that|about))?)\s*"#,
            with: "", options: [.regularExpression, .caseInsensitive]
        )
        title = title.trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
        if title.isEmpty { title = "Reminder" }

        try await Reminders.add(title: title, due: due)
        if let due {
            return "Done, sir. I'll remind you to \(title) \(due.formatted(date: .abbreviated, time: .shortened))."
        }
        return "Done, sir. I've added \(title) to your reminders."
    }

    static func timeDescription() -> String {
        Date().formatted(.dateTime.weekday(.wide).day().month(.wide).year().hour().minute())
            + " (\(TimeZone.current.identifier))"
    }

    private static func matches(_ text: String, _ pattern: String) -> Bool {
        text.range(of: pattern, options: .regularExpression) != nil
    }
}
