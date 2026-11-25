import Foundation

/// What the server's change stream says changed (ADR 0019): the client reads that part
/// again, through the same routes as a poll.
public enum ServerChange: String, Sendable, Hashable, CaseIterable {
    /// A notification arrived, or occurrences resolved as vanished (ADR 0014).
    case occurrences
    /// A silence was set or ended through Achtung.
    case silences
    /// The shared settings, e.g. the ignored alert names (ADR 0011).
    case settings
    /// A handover was asked for or moved on, or the actions offered for alerts changed
    /// (ADR 0022).
    case handovers
}

/// When to reconnect the change stream, and how often to poll beside it (ADR 0019).
public struct ChangeStreamSchedule: Sendable, Equatable {
    /// Repeated failures back off up to this.
    public static let longestDelay = Duration.seconds(60)

    /// The server's `retry`: 5 s until it says otherwise.
    public private(set) var retry = Duration.seconds(5)
    /// Connections in a row that failed before the server said `ready`.
    public private(set) var failures = 0

    public init() {}

    public mutating func serverAsked(retry: Duration) {
        self.retry = retry
    }

    /// A stream that ended. One that said `ready` first worked, and ended cleanly (e.g. a
    /// gateway's request timeout), so it doesn't count as a failure.
    public mutating func ended(afterReady: Bool) {
        failures = afterReady ? 0 : failures + 1
    }

    /// How long to wait before connecting again: the server's retry, doubled for each
    /// failure after the first, at most `longestDelay`.
    public var delay: Duration {
        guard failures > 1 else { return retry }
        return min(retry * (1 << min(failures - 1, 10)), Self.longestDelay)
    }

    /// The poll refreshes once the last refresh is older than this. Every 30 s while the
    /// stream is down; about every 2 minutes while it's live, for what it doesn't announce
    /// (silences set in Alertmanager itself, Home's Alertmanager and IRM reads).
    public static func pollAge(isLive: Bool) -> TimeInterval {
        isLive ? 115 : 20
    }
}
