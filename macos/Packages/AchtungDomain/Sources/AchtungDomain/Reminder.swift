import Foundation

/// The times "Remind Me" offers (ADR 0025). Each is turned into an instant in the user's
/// calendar and time zone here; the server stores instants only.
public enum ReminderPreset: String, CaseIterable, Sendable, Identifiable {
    case laterToday
    case thisEvening
    case tomorrowMorning
    case nextWeek

    /// When a morning starts and an evening begins, for the presets.
    public static let morningHour = 8
    public static let eveningHour = 18
    /// "Later today" is this long from now.
    public static let later: TimeInterval = 3 * 60 * 60

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .laterToday: "Later Today"
        case .thisEvening: "This Evening"
        case .tomorrowMorning: "Tomorrow Morning"
        case .nextWeek: "Next Week"
        }
    }

    /// When this preset reminds, asked at `now`; nil when it has nothing to offer: this
    /// evening once it is evening, and later today when that is tomorrow already.
    public func date(at now: Date, calendar: Calendar) -> Date? {
        let today = calendar.startOfDay(for: now)
        switch self {
        case .laterToday:
            // To the whole minute: nobody means 17:42:31.
            let date = Date(
                timeIntervalSinceReferenceDate: ((now.timeIntervalSinceReferenceDate
                    + Self.later) / 60).rounded(.down) * 60)
            return calendar.isDate(date, inSameDayAs: now) ? date : nil
        case .thisEvening:
            guard let evening = Self.time(Self.eveningHour, on: today, calendar), evening > now
            else { return nil }
            return evening
        case .tomorrowMorning:
            return Self.morning(daysAhead: 1, of: today, calendar)
        case .nextWeek:
            // The next Monday morning that isn't today's.
            return (1...7).lazy
                .compactMap { Self.morning(daysAhead: $0, of: today, calendar) }
                .first { calendar.component(.weekday, from: $0) == 2 }
        }
    }

    /// The presets that have a time at `now`, each once: on a Sunday "Next Week" is
    /// tomorrow morning, and only that one is offered.
    public static func options(at now: Date, calendar: Calendar) -> [Option] {
        var options: [Option] = []
        for preset in allCases {
            if let date = preset.date(at: now, calendar: calendar),
                !options.contains(where: { $0.date == date })
            {
                options.append(Option(preset: preset, date: date))
            }
        }
        return options
    }

    public struct Option: Sendable, Hashable, Identifiable {
        public let preset: ReminderPreset
        public let date: Date

        public var id: String { preset.id }
    }

    /// What "Pick Date and Time…" starts from: tomorrow morning.
    public static func suggestion(at now: Date, calendar: Calendar) -> Date {
        tomorrowMorning.date(at: now, calendar: calendar) ?? now.addingTimeInterval(24 * 60 * 60)
    }

    /// A day's wall-clock hour. Where a clock change skips it, the first time after.
    private static func time(_ hour: Int, on day: Date, _ calendar: Calendar) -> Date? {
        calendar.date(
            bySettingHour: hour, minute: 0, second: 0, of: day, matchingPolicy: .nextTime)
    }

    /// The morning `daysAhead` calendar days after `today`, whatever the days' lengths.
    private static func morning(daysAhead: Int, of today: Date, _ calendar: Calendar) -> Date? {
        calendar.date(byAdding: .day, value: daysAhead, to: today)
            .flatMap { time(morningHour, on: $0, calendar) }
    }
}

/// What the server accepts as a reminder's time (`server/src/domain/reminder.ts`): in the
/// future, at most a year ahead.
public enum ReminderTime {
    public static let furthest: TimeInterval = 365 * 24 * 60 * 60

    public static func range(at now: Date) -> ClosedRange<Date> {
        now.addingTimeInterval(60)...now.addingTimeInterval(furthest - 60)
    }
}
