import EventKit

enum Reminders {
    private static let store = EKEventStore()

    /// Adds a reminder to the default Reminders list and returns a sentence for Claude to confirm.
    static func add(title: String, dueISO8601: String?) async throws -> String {
        guard try await store.requestFullAccessToReminders() else {
            throw JarvisError("Reminders access is turned off for Jarvis in Settings.")
        }
        let reminder = EKReminder(eventStore: store)
        reminder.title = title
        reminder.calendar = store.defaultCalendarForNewReminders()

        var dueText = "with no due time"
        if let dueISO8601, let due = ISO8601DateFormatter().date(from: dueISO8601) {
            reminder.dueDateComponents = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute], from: due
            )
            reminder.addAlarm(EKAlarm(absoluteDate: due))
            dueText = "for " + due.formatted(date: .abbreviated, time: .shortened)
        }
        try store.save(reminder, commit: true)
        return "Reminder \"\(title)\" saved \(dueText)."
    }
}
