import AchtungDomain
import Foundation

// Handovers (ADR 0022) as the API has them, one flat shape with nullable fields, into the
// domain's state with exactly the facts it has. A combination the states don't allow is
// an invalid response, not a guess.

extension Components.Schemas.ActionOffer {
    var domain: ActionOffer {
        ActionOffer(
            handler: handler, handlerName: handlerName, action: action, title: title,
            description: description, isAvailable: available, lastSeenAt: lastSeenAt)
    }
}

extension Components.Schemas.Handover {
    func domain() throws -> Handover {
        Handover(
            id: id, occurrenceID: occurrenceId, handler: handler, handlerName: handlerName,
            handlerVersion: handlerVersion, action: action, title: title,
            requestedAt: requestedAt, state: try domainState(),
            progress: progress.map { .init(reportedAt: $0.at, message: $0.message) })
    }

    private func domainState() throws -> Handover.State {
        switch state {
        case .requested:
            try expect(claimedAt == nil && finishedAt == nil, "requested but claimed or ended")
            return .requested
        case .running:
            try expect(finishedAt == nil, "running but ended")
            return .running(
                claimedAt: try have(claimedAt, "claimedAt"),
                deadlineAt: try have(deadlineAt, "deadlineAt"))
        case .succeeded:
            let result = Handover.Result(
                summary: try have(summary, "summary"), body: try have(body, "body"),
                links: try links.map { try $0.domain() })
            return .succeeded(
                claimedAt: try have(claimedAt, "claimedAt"),
                finishedAt: try have(finishedAt, "finishedAt"), result)
        case .failed:
            return .failed(
                claimedAt: try have(claimedAt, "claimedAt"),
                finishedAt: try have(finishedAt, "finishedAt"), error: try have(error, "error"))
        case .cancelled:
            return .cancelled(claimedAt: claimedAt, finishedAt: try have(finishedAt, "finishedAt"))
        case .timedOut:
            return .timedOut(
                claimedAt: try have(claimedAt, "claimedAt"),
                finishedAt: try have(finishedAt, "finishedAt"))
        case .expired:
            try expect(claimedAt == nil, "expired but claimed")
            return .expired(finishedAt: try have(finishedAt, "finishedAt"))
        }
    }

    private func have<Value>(_ value: Value?, _ field: String) throws -> Value {
        guard let value else {
            throw ServerError.invalidResponse(
                "Handover \(id) is \(state.rawValue) without \(field)")
        }
        return value
    }

    private func expect(_ holds: Bool, _ what: String) throws {
        if !holds {
            throw ServerError.invalidResponse("Handover \(id) is \(what)")
        }
    }
}

extension Components.Schemas.Handover.LinksPayloadPayload {
    /// The server takes only http and https links; one that isn't is not passed on as a
    /// link someone might click.
    func domain() throws -> Handover.Link {
        guard let url = URL(string: url), ["http", "https"].contains(url.scheme?.lowercased()),
            url.host() != nil
        else {
            throw ServerError.invalidResponse("A handover's link is not a web URL: \(url)")
        }
        return Handover.Link(title: title, url: url)
    }
}
