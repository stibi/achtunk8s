import AchtungDomain
import Foundation

// Handovers (ADR 0022) as the API has them, one flat shape with nullable fields, into the
// domain's state with exactly the facts it has. A combination the states don't allow is
// an invalid response, not a guess.

/// A handler's text without the characters that reorder what is shown (bidirectional
/// controls): with them, a link's spelled-out target or a title could read as something
/// it isn't.
func displayable(_ text: String) -> String {
    let controls: Set<Unicode.Scalar> = [
        "\u{061C}", "\u{200E}", "\u{200F}", "\u{202A}", "\u{202B}", "\u{202C}", "\u{202D}",
        "\u{202E}", "\u{2066}", "\u{2067}", "\u{2068}", "\u{2069}",
    ]
    return String(String.UnicodeScalarView(text.unicodeScalars.filter { !controls.contains($0) }))
}

extension Components.Schemas.ActionOffer {
    var domain: ActionOffer {
        ActionOffer(
            handler: handler, handlerName: displayable(handlerName), action: action,
            title: displayable(title), description: displayable(description),
            isAvailable: available, lastSeenAt: lastSeenAt)
    }
}

extension Components.Schemas.Handover {
    func domain() throws -> Handover {
        Handover(
            id: id, occurrenceID: occurrenceId, handler: handler,
            handlerName: displayable(handlerName), handlerVersion: displayable(handlerVersion),
            action: action, title: displayable(title),
            requestedAt: requestedAt, state: try domainState(),
            progress: progress.map { .init(reportedAt: $0.at, message: displayable($0.message)) })
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
                summary: displayable(try have(summary, "summary")),
                body: displayable(try have(body, "body")),
                links: try links.map { try $0.domain() })
            return .succeeded(
                claimedAt: try have(claimedAt, "claimedAt"),
                finishedAt: try have(finishedAt, "finishedAt"), result)
        case .failed:
            return .failed(
                claimedAt: try have(claimedAt, "claimedAt"),
                finishedAt: try have(finishedAt, "finishedAt"),
                error: displayable(try have(error, "error")))
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
        return Handover.Link(title: displayable(title), url: url)
    }
}
