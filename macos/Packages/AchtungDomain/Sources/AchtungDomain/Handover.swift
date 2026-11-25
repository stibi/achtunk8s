import Foundation

// Handing an alert over to a plugin (ADR 0022): a handler, a program outside Achtung,
// offers actions for an alert, and a handover is one occurrence given to one action.

/// An action a handler offers for an occurrence: a button.
public struct ActionOffer: Sendable, Hashable, Identifiable {
    /// The handler offering it, and the action's id within that handler.
    public let handler: String
    public let handlerName: String
    public let action: String
    public let title: String
    public let description: String
    /// Whether the handler is connected; the server refuses a handover for one that isn't.
    public let isAvailable: Bool
    public let lastSeenAt: Date

    public var id: String { "\(handler)/\(action)" }

    public init(
        handler: String, handlerName: String, action: String, title: String,
        description: String, isAvailable: Bool, lastSeenAt: Date
    ) {
        self.handler = handler
        self.handlerName = handlerName
        self.action = action
        self.title = title
        self.description = description
        self.isAvailable = isAvailable
        self.lastSeenAt = lastSeenAt
    }
}

/// One occurrence handed over to one action of one handler, with what came of it.
public struct Handover: Sendable, Hashable, Identifiable {
    /// A link a result points to; only http and https ones exist.
    public struct Link: Sendable, Hashable {
        public let title: String
        public let url: URL

        public init(title: String, url: URL) {
            self.title = title
            self.url = url
        }
    }

    /// What a handler answered: text from another program, to show as text.
    public struct Result: Sendable, Hashable {
        /// One line of plain text.
        public let summary: String
        /// Markdown.
        public let body: String
        public let links: [Link]

        public init(summary: String, body: String, links: [Link] = []) {
            self.summary = summary
            self.body = body
            self.links = links
        }
    }

    /// Where the handover is, with exactly the facts that state has.
    public enum State: Sendable, Hashable {
        /// Waiting for its handler to take it.
        case requested
        case running(claimedAt: Date, deadlineAt: Date)
        case succeeded(claimedAt: Date, finishedAt: Date, Result)
        /// The handler's own failure, or it stopped answering.
        case failed(claimedAt: Date, finishedAt: Date, error: String)
        /// By a client; `claimedAt` is nil when no handler had taken it.
        case cancelled(claimedAt: Date?, finishedAt: Date)
        /// It ran past its action's deadline.
        case timedOut(claimedAt: Date, finishedAt: Date)
        /// No handler took it in time.
        case expired(finishedAt: Date)
    }

    public struct Progress: Sendable, Hashable {
        public let reportedAt: Date
        public let message: String

        public init(reportedAt: Date, message: String) {
            self.reportedAt = reportedAt
            self.message = message
        }
    }

    public let id: Int
    public let occurrenceID: Int
    public let handler: String
    /// The handler's name and version, and the action's title, as they were when asked.
    public let handlerName: String
    public let handlerVersion: String
    public let action: String
    public let title: String
    public let requestedAt: Date
    public let state: State
    /// What the handler reported while working, oldest first.
    public let progress: [Progress]

    public init(
        id: Int, occurrenceID: Int, handler: String, handlerName: String,
        handlerVersion: String, action: String, title: String, requestedAt: Date, state: State,
        progress: [Progress] = []
    ) {
        self.id = id
        self.occurrenceID = occurrenceID
        self.handler = handler
        self.handlerName = handlerName
        self.handlerVersion = handlerVersion
        self.action = action
        self.title = title
        self.requestedAt = requestedAt
        self.state = state
        self.progress = progress
    }

    /// Requested or running: it may still bring a result, and can be cancelled.
    public var isActive: Bool {
        switch state {
        case .requested, .running: true
        default: false
        }
    }

    /// The same action of the same handler.
    public func isOf(_ offer: ActionOffer) -> Bool {
        handler == offer.handler && action == offer.action
    }

    /// When a handler took it, if one did.
    public var claimedAt: Date? {
        switch state {
        case .requested, .expired: nil
        case .running(let claimedAt, _), .succeeded(let claimedAt, _, _),
            .failed(let claimedAt, _, _), .timedOut(let claimedAt, _):
            claimedAt
        case .cancelled(let claimedAt, _): claimedAt
        }
    }

    /// When it ended, once it has.
    public var finishedAt: Date? {
        switch state {
        case .requested, .running: nil
        case .succeeded(_, let finishedAt, _), .failed(_, let finishedAt, _),
            .cancelled(_, let finishedAt), .timedOut(_, let finishedAt), .expired(let finishedAt):
            finishedAt
        }
    }

    /// One calm line saying where it is, for the card's headline when there is no result.
    public var statusLine: String {
        switch state {
        case .requested: "Waiting for \(handlerName)…"
        case .running: progress.last?.message ?? "\(handlerName) is working on it…"
        case .succeeded(_, _, let result): result.summary
        case .failed(_, _, let error): error
        case .cancelled: "Cancelled"
        case .timedOut: "\(handlerName) didn't finish in time"
        case .expired: "\(handlerName) didn't take it"
        }
    }
}

extension OccurrenceDetail {
    /// The newest handover of each action that was ever asked for, newest first: one card
    /// each. The rest are `earlierHandovers`.
    public var latestHandovers: [Handover] {
        var seen: Set<String> = []
        return handovers.filter { seen.insert("\($0.handler)/\($0.action)").inserted }
    }

    /// The handovers that a newer one of the same action replaced, newest first.
    public var earlierHandovers: [Handover] {
        let latest = Set(latestHandovers.map(\.id))
        return handovers.filter { !latest.contains($0.id) }
    }

    /// The action's handover that is requested or running, if there is one: its button
    /// would only return that one.
    public func activeHandover(of offer: ActionOffer) -> Handover? {
        handovers.first { $0.isActive && $0.isOf(offer) }
    }
}
