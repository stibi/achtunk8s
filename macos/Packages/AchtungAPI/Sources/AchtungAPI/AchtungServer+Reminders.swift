import AchtungDomain
import Foundation

// "Remind Me" (ADR 0025): the server resurfaces the occurrence at a time, for everyone.

extension AchtungServer {
    /// Sets the occurrence's reminder for `date`, replacing one it has, and returns the
    /// occurrence with its `remindAt`. `.rejected` when the time isn't in the future or is
    /// over a year ahead; `.notFound` when the occurrence is gone, or the server is older
    /// than reminders.
    public func remind(occurrenceID id: Int, at date: Date) async throws(ServerError) -> Occurrence
    {
        try await call {
            let output = try await client.setOccurrenceReminder(
                path: .init(id: id), body: .json(.init(remindAt: date)))
            switch output {
            case .ok(let response):
                return try response.body.json.domain()
            case .badRequest(let response):
                throw ServerError.rejected(try response.body.json.error)
            case .notFound:
                throw ServerError.notFound(Self.noReminders)
            case .undocumented(let status, _):
                throw ServerError.invalidResponse("HTTP \(status)")
            }
        }
    }

    /// Cancels the occurrence's pending reminder, if it has one, and returns the occurrence.
    public func cancelReminder(occurrenceID id: Int) async throws(ServerError) -> Occurrence {
        try await call {
            switch try await client.cancelOccurrenceReminder(path: .init(id: id)) {
            case .ok(let response):
                return try response.body.json.domain()
            case .badRequest(let response):
                throw ServerError.rejected(try response.body.json.error)
            case .notFound:
                throw ServerError.notFound(Self.noReminders)
            case .undocumented(let status, _):
                throw ServerError.invalidResponse("HTTP \(status)")
            }
        }
    }

    /// A 404 here is an occurrence that is gone, or a server from before reminders, whose
    /// answer for a path it doesn't know looks the same.
    private static let noReminders =
        "The server doesn't have this alert, or is older than this app and can't remind yet."
}
