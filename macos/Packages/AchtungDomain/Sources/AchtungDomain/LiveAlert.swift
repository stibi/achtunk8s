import Foundation

/// An alert's identity, which every one of its occurrences shares (ADR 0007): its source,
/// its channel (with the channel's instance) and the source's stable key, for Alertmanager
/// the fingerprint of the full label set. Never the alert's name: the same name with other
/// labels is another alert. Only ever compared, so its parts stay inside.
public struct AlertIdentity: Sendable, Hashable {
    private let source: String
    private let channel: ChannelID
    private let sourceKey: String

    init(of occurrence: Occurrence) {
        source = occurrence.source
        channel = occurrence.channel
        sourceKey = occurrence.alert.sourceKey
    }

    // Written out rather than synthesized, which reads the parts where dead-code analysis
    // can see it.
    public static func == (lhs: Self, rhs: Self) -> Bool {
        (lhs.source, lhs.channel, lhs.sourceKey) == (rhs.source, rhs.channel, rhs.sourceKey)
    }

    public func hash(into hasher: inout Hasher) {
        hasher.combine(source)
        hasher.combine(channel)
        hasher.combine(sourceKey)
    }
}

extension Occurrence {
    public var alertIdentity: AlertIdentity { AlertIdentity(of: self) }
}

/// One alert as Live shows it: the occurrences of one `AlertIdentity` the client has
/// loaded, folded into one card. The card shows the latest occurrence; the earlier ones are
/// its history. Only what is loaded is folded, so the count can be lower than the server's;
/// `isCountComplete` says when it is the whole truth since `since`.
public struct LiveAlert: Sendable, Hashable, Identifiable, Changing {
    public let id: AlertIdentity
    /// Newest first: by when they started, then by id. Never empty.
    public let occurrences: [Occurrence]
    /// The latest change to any of its occurrences: where the card sits in the stream, so
    /// that any change (a new firing, a resolve, a resend, a reminder on an older
    /// occurrence) moves it to the top.
    public let lastEventAt: Date
    /// Whether every occurrence that started since `since` is loaded, so its count is the
    /// whole truth for that span.
    public let isCountComplete: Bool

    /// The one the card shows: the occurrence that started last.
    public var latest: Occurrence { occurrences[0] }
    /// The history: the occurrences folded into the card besides the latest, newest first.
    public var earlier: ArraySlice<Occurrence> { occurrences.dropFirst() }
    /// When its oldest loaded occurrence started: the start of the span its count covers.
    public var since: Date { occurrences[occurrences.count - 1].alert.startsAt }

    /// Read when every occurrence folded into it is: one unread occurrence makes the card
    /// unread.
    public func isRead(in readState: ReadState) -> Bool {
        occurrences.allSatisfy(readState.isRead)
    }

    /// The occurrence that made it unread, the one changed last among the unread ones; nil
    /// when it's read. Its last event says why (`Occurrence.isResent`, `isReminded`).
    public func lastUnread(in readState: ReadState) -> Occurrence? {
        occurrences.filter { !readState.isRead($0) }.max { $0.lastEventAt < $1.lastEventAt }
    }

    /// Earlier occurrences with a pending reminder, soonest first. The card's reminder acts
    /// on the latest; these stay in view in the history.
    public var earlierReminders: [Occurrence] {
        earlier.filter { $0.remindAt != nil }
            .sorted { ($0.remindAt ?? .distantFuture) < ($1.remindAt ?? .distantFuture) }
    }

    /// The alerts of `occurrences`, most recently changed first, each with every
    /// occurrence of its identity. `loadedSince` is how far back the loaded occurrences
    /// reach for certain: the oldest loaded `lastEventAt` while older pages remain, nil
    /// once everything is loaded. An occurrence that started after it changed after it
    /// too, so it is loaded: a count back to there is complete.
    public static func fold(_ occurrences: [Occurrence], loadedSince: Date?) -> [LiveAlert] {
        var byIdentity: [AlertIdentity: [Int: Occurrence]] = [:]
        for occurrence in occurrences {
            byIdentity[occurrence.alertIdentity, default: [:]][occurrence.id] = occurrence
        }
        return byIdentity.map { identity, byID in
            let folded = byID.values.sorted {
                ($0.alert.startsAt, $0.id) > ($1.alert.startsAt, $1.id)
            }
            let oldestStart = folded[folded.count - 1].alert.startsAt
            return LiveAlert(
                id: identity, occurrences: folded,
                lastEventAt: folded.map(\.lastEventAt).max() ?? folded[0].lastEventAt,
                isCountComplete: loadedSince.map { oldestStart >= $0 } ?? true)
        }
        .sorted { ($0.lastEventAt, $0.latest.id) > ($1.lastEventAt, $1.latest.id) }
    }

    /// What Live shows of `alerts`: all of them, or with read alerts hidden
    /// (`ReadState.hidesRead`) the unread ones and `kept`, the card the user has open,
    /// like `ReadState.shown` for occurrences. A card shown because something in it is
    /// unread still holds all its occurrences: the history is the alert's, read or not.
    public static func shown(
        _ alerts: [LiveAlert], readState: ReadState, keeping kept: AlertIdentity?
    ) -> [LiveAlert] {
        guard readState.hidesRead(in: .allChannels) else { return alerts }
        return alerts.filter { !$0.isRead(in: readState) || $0.id == kept }
    }
}
