import AchtungDomain
import Foundation
import OpenAPIRuntime

/// What following the server's change stream (ADR 0019) reports.
public enum ChangeStreamUpdate: Sendable, Equatable {
    /// The stream is open: read everything again, as changes made before it were not sent.
    case ready
    /// Read this part again.
    case changed(ServerChange)
    /// The stream ended or couldn't open; it reconnects after `retryingIn`. `failure` is
    /// why it failed to open, given for the first of a run of failures only, so a server
    /// that stays down doesn't fill a log. A stream that said `ready` and then ended, as
    /// behind a gateway that cuts long requests, didn't fail: it has none.
    case down(retryingIn: Duration, failure: String?)
}

/// One message of the server's change stream.
enum ChangeStreamMessage: Sendable, Equatable {
    case ready
    case changed(ServerChange)
    /// How long to wait before reconnecting after the stream ends.
    case retry(Duration)
}

extension AchtungServer {
    /// Keeps the change stream open until the task is cancelled, and tells `update` what it
    /// says. It reconnects after the server's retry, backing off while connecting fails
    /// (`ChangeStreamSchedule`). Cancelled, it ends without another update. It runs on the
    /// caller's actor, so `update` does too.
    nonisolated(nonsending) public func followChanges(
        sleep: (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        _ update: (ChangeStreamUpdate) -> Void
    ) async {
        var schedule = ChangeStreamSchedule()
        while !Task.isCancelled {
            var saidReady = false
            var failure: String?
            do {
                for try await message in try await changes() {
                    // A message read before a new connection cancelled this one is stale.
                    if Task.isCancelled { return }
                    switch message {
                    case .retry(let delay):
                        schedule.serverAsked(retry: delay)
                    case .ready:
                        saidReady = true
                        update(.ready)
                    case .changed(let change):
                        update(.changed(change))
                    }
                }
            } catch {
                failure = String(describing: error)
            }
            // Cancelled while the stream was open, which ends it without throwing.
            if Task.isCancelled { return }
            let firstFailure = !saidReady && schedule.failures == 0
            schedule.ended(afterReady: saidReady)
            update(.down(retryingIn: schedule.delay, failure: firstFailure ? failure : nil))
            do {
                try await sleep(schedule.delay)
            } catch {
                return
            }
        }
    }

    /// Opens the change stream. Its messages come until the server or the network ends it,
    /// which ends the sequence or throws; a kind of change this client doesn't know is left
    /// out. A server with too many streams open answers 503, thrown as `rejected`.
    func changes() async throws(ServerError) -> AsyncThrowingStream<ChangeStreamMessage, any Error>
    {
        let body = try await call {
            switch try await client.streamChanges() {
            case .ok(let response):
                return try response.body.textEventStream
            case .serviceUnavailable(let response):
                throw ServerError.rejected(try response.body.json.error)
            case .undocumented(let status, _):
                throw ServerError.invalidResponse("HTTP \(status)")
            }
        }
        let events = body.asDecodedServerSentEvents()
        return AsyncThrowingStream { continuation in
            let reading = Task {
                do {
                    for try await event in events {
                        for message in Self.messages(of: event) {
                            continuation.yield(message)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in reading.cancel() }
        }
    }

    private struct Changed: Decodable {
        let kind: String
    }

    static func messages(of event: ServerSentEvent) -> [ChangeStreamMessage] {
        var messages = event.retry.map { [ChangeStreamMessage.retry(.milliseconds($0))] } ?? []
        switch event.event {
        case "ready":
            messages.append(.ready)
        case "changed":
            if let data = event.data?.data(using: .utf8),
                let changed = try? JSONDecoder().decode(Changed.self, from: data),
                let kind = ServerChange(rawValue: changed.kind)
            {
                messages.append(.changed(kind))
            }
        default:
            break
        }
        return messages
    }
}
