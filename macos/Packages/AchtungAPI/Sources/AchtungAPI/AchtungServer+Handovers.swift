import AchtungDomain
import Foundation

// Handing an alert over to a plugin (ADR 0022): a handler takes it and reports back.

extension AchtungServer {
    /// Hands the occurrence over to a handler's action and returns the handover: a new
    /// one, or the one already requested or running. `.rejected` with the server's reason
    /// when the action isn't offered (any more), its handler isn't connected, or too many
    /// handovers are active; `.notFound` when the occurrence is gone or the server is older
    /// than handovers.
    public func handOver(occurrenceID id: Int, to offer: ActionOffer) async throws(ServerError)
        -> Handover
    {
        try await call {
            let output = try await client.createHandover(
                path: .init(id: id),
                body: .json(.init(handler: offer.handler, action: offer.action)))
            switch output {
            case .ok(let response):
                return try response.body.json.domain()
            case .created(let response):
                return try response.body.json.domain()
            case .badRequest(let response):
                throw ServerError.rejected(try response.body.json.error)
            case .notFound:
                throw ServerError.notFound(Self.noHandovers)
            case .conflict(let response):
                throw ServerError.rejected(try response.body.json.error)
            case .serviceUnavailable(let response):
                throw ServerError.rejected(try response.body.json.error)
            case .undocumented(let status, _):
                throw ServerError.invalidResponse("HTTP \(status)")
            }
        }
    }

    /// Cancels a handover that is requested or running, and returns it. `.rejected` when it
    /// had ended already.
    public func cancelHandover(id: Int) async throws(ServerError) -> Handover {
        try await call {
            switch try await client.cancelHandover(path: .init(id: id)) {
            case .ok(let response):
                return try response.body.json.domain()
            case .badRequest(let response):
                throw ServerError.rejected(try response.body.json.error)
            case .notFound:
                throw ServerError.notFound(Self.noHandovers)
            case .conflict(let response):
                throw ServerError.rejected(try response.body.json.error)
            case .undocumented(let status, _):
                throw ServerError.invalidResponse("HTTP \(status)")
            }
        }
    }

    /// One handover as it is now: its state, progress and result.
    public func handover(id: Int) async throws(ServerError) -> Handover {
        try await call {
            switch try await client.getHandover(path: .init(id: id)) {
            case .ok(let response):
                return try response.body.json.domain()
            case .badRequest(let response):
                throw ServerError.rejected(try response.body.json.error)
            case .notFound:
                throw ServerError.notFound(Self.noHandovers)
            case .undocumented(let status, _):
                throw ServerError.invalidResponse("HTTP \(status)")
            }
        }
    }

    /// A 404 here is an alert or handover that is gone, or a server from before handovers,
    /// whose answer for a path it doesn't know looks the same.
    private static let noHandovers =
        "The server doesn't have this, or is older than this app and can't hand alerts over yet."
}
