import EventKit

enum Reminders {
    private static let store = EKEventStore()

    /// Adds a reminder to the default Reminders list, with an alert at `due` if given.
    static func add(title: String, due: Date?) async throws {
        guard try await store.requestFullAccessToReminders() else {
            throw JarvisError("Reminders access is turned off for Jarvis in Settings.")
        }
        let reminder = EKReminder(eventStore: store)
        reminder.title = title
        reminder.calendar = store.defaultCalendarForNewReminders()
        if let due {
            reminder.dueDateComponents = Calendar.current.dateComponents(
                [.year, .month, .day, .hour, .minute], from: due
            )
            reminder.addAlarm(EKAlarm(absoluteDate: due))
        }
        try store.save(reminder, commit: true)
    }
}

struct JarvisError: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}
