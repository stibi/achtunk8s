import Foundation

/// A channel's identity. A channel name is unique only within its instance, the sending
/// system it belongs to (ADR 0006), so two instances can each have a `devops` channel.
public struct ChannelID: Sendable, Hashable, Codable {
    public let instance: String
    public let slug: String

    public init(instance: String, slug: String) {
        self.instance = instance
        self.slug = slug
    }
}

/// A named stream of alerts, with what is firing in it. Mirrors the server's `Channel`.
public struct Channel: Sendable, Hashable, Identifiable {
    public let id: ChannelID
    /// Occurrences in the channel that are firing now.
    public let firing: Int
    /// The latest event in the channel; nil while it has none.
    public let lastEventAt: Date?

    public init(id: ChannelID, firing: Int, lastEventAt: Date?) {
        self.id = id
        self.firing = firing
        self.lastEventAt = lastEventAt
    }
}

/// An occurrence as the server stores it: what the source reported plus what Achtung
/// tracks. Mirrors `server/src/domain/occurrence.ts`.
public struct Occurrence: Sendable, Hashable, Identifiable {
    public let id: Int
    public let channel: ChannelID
    public let source: String
    public let alert: IncomingAlert
    public let firstReceivedAt: Date
    public let lastReceivedAt: Date
    /// When it last fired, resolved, reopened, was resent or reminded of. A repeat
    /// notification moves it only as a resend: when the alert still fires and its last event
    /// is an hour old. Setting or cancelling a reminder doesn't move it (ADR 0025).
    public let lastEventAt: Date
    /// What happened at `lastEventAt`: never `reminderSet` or `reminderCancelled`.
    public let lastEventKind: OccurrenceEvent.Kind
    public let notificationCount: Int
    /// When the Alertmanager silence muting this alert ends; nil when none does, or when
    /// the server couldn't ask its Alertmanager (ADR 0008). Nil means not silenced.
    public let silencedUntil: Date?
    /// When the reminder set on it comes due and resurfaces it; nil when none is pending
    /// (ADR 0025). It is everyone's: the server has no users.
    public let remindAt: Date?

    public init(
        id: Int,
        channel: ChannelID,
        source: String,
        alert: IncomingAlert,
        firstReceivedAt: Date,
        lastReceivedAt: Date,
        lastEventAt: Date,
        lastEventKind: OccurrenceEvent.Kind,
        notificationCount: Int,
        silencedUntil: Date? = nil,
        remindAt: Date? = nil
    ) {
        self.id = id
        self.channel = channel
        self.source = source
        self.alert = alert
        self.firstReceivedAt = firstReceivedAt
        self.lastReceivedAt = lastReceivedAt
        self.lastEventAt = lastEventAt
        self.lastEventKind = lastEventKind
        self.notificationCount = notificationCount
        self.silencedUntil = silencedUntil
        self.remindAt = remindAt
    }

    /// Its last event is a reminder that came due: unread again because someone asked to
    /// get back to it, not because it's new.
    public var isReminded: Bool { lastEventKind == .reminded }

    /// Its last event is a resend: unread again because the source repeated it, not because
    /// it's new.
    public var isResent: Bool { lastEventKind == .resent }

    /// When the silence still muting it at `now` ends, e.g. a broader one after its own was
    /// ended (ADR 0015); nil when none does.
    public func silenceEnd(at now: Date) -> Date? {
        isSilenced(at: now) ? silencedUntil : nil
    }

    /// Muted by an Alertmanager silence at `now`. A silence that ended since the last
    /// refresh no longer counts.
    public func isSilenced(at now: Date) -> Bool {
        guard let silencedUntil else { return false }
        return silencedUntil > now
    }
}

/// Something that happened to an occurrence. Events make up an alert's history.
public struct OccurrenceEvent: Sendable, Hashable, Identifiable {
    public enum Kind: String, Sendable, Hashable {
        case fired
        case resolved
        case reopened
        /// The source repeated an alert that still fires, an hour or more after its last
        /// event. It makes the occurrence unread again.
        case resent
        /// Someone set a reminder for `remindAt` (ADR 0025). Not news: it doesn't make the
        /// occurrence unread.
        case reminderSet = "reminder_set"
        /// Someone cancelled the pending reminder. Not news either.
        case reminderCancelled = "reminder_cancelled"
        /// A reminder came due: the occurrence is unread again and notifies, whatever its
        /// state (ADR 0025).
        case reminded
    }

    /// Why Achtung recorded an event without a notification for it (ADR 0014).
    public enum Cause: String, Sendable, Hashable {
        /// A resolve Achtung recorded itself: the alert was gone from its Alertmanager,
        /// which never sent the resolve (typically a silenced alert that ended).
        case vanished
    }

    public let id: Int
    public let kind: Kind
    /// Nil when a notification caused the event.
    public let cause: Cause?
    public let recordedAt: Date
    /// The time a `reminderSet` event set the reminder for; nil for any other kind.
    public let remindAt: Date?

    public init(id: Int, kind: Kind, cause: Cause? = nil, recordedAt: Date, remindAt: Date? = nil) {
        self.id = id
        self.kind = kind
        self.cause = cause
        self.recordedAt = recordedAt
        self.remindAt = remindAt
    }
}

/// One occurrence with its history and the alert's other occurrences.
public struct OccurrenceDetail: Sendable, Hashable {
    public let occurrence: Occurrence
    /// Oldest first.
    public let events: [OccurrenceEvent]
    /// Other occurrences of the same alert, newest first.
    public let otherOccurrences: [Occurrence]
    /// The graphs the server has for it (ADR 0026); none from a server before graphs.
    public let metricPanels: [MetricPanel]

    public init(
        occurrence: Occurrence, events: [OccurrenceEvent], otherOccurrences: [Occurrence],
        metricPanels: [MetricPanel] = []
    ) {
        self.occurrence = occurrence
        self.events = events
        self.otherOccurrences = otherOccurrences
        self.metricPanels = metricPanels
    }
}
