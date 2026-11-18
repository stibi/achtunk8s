import AchtungDomain
import Foundation
import HTTPTypes
import OpenAPIRuntime
import Synchronization
import Testing

@testable import AchtungAPI

/// Answers every request with this status and body, as the change stream would.
private struct EventStreamTransport: ClientTransport {
    let status: Int
    let contentType: String
    let body: String

    func send(_ request: HTTPRequest, body _: HTTPBody?, baseURL: URL, operationID: String)
        async throws -> (HTTPResponse, HTTPBody?)
    {
        (
            HTTPResponse(status: .init(code: status), headerFields: [.contentType: contentType]),
            HTTPBody(body)
        )
    }
}

private func server(_ status: Int, _ contentType: String, _ body: String) -> AchtungServer {
    AchtungServer(
        baseURL: URL(string: "http://achtung.test")!,
        transport: EventStreamTransport(status: status, contentType: contentType, body: body))
}

@Test func theStreamSaysReadyThenWhatChanged() async throws {
    let stream = """
        retry: 5000
        event: ready
        data: {}

        : keepalive

        event: changed
        data: {"kind":"occurrences"}

        event: changed
        data: {"kind":"weather"}

        event: changed
        data: {"kind":
        data: "silences"}

        event: changed
        data: {"kind":"settings"}
        """
    var messages: [ChangeStreamMessage] = []
    for try await message in try await server(200, "text/event-stream", stream).changes() {
        messages.append(message)
    }

    // An unknown kind is left out; data on several lines is joined; an event cut off before
    // its blank line isn't one.
    #expect(
        messages == [.retry(.seconds(5)), .ready, .changed(.occurrences), .changed(.silences)])
}

@Test func tooManyStreamsIsARejection() async {
    await #expect(throws: ServerError.rejected("Too many event streams")) {
        _ = try await server(
            503, "application/json", #"{"error":"Too many event streams"}"#
        ).changes()
    }
}

// MARK: - Following the stream

/// The network or a gateway ending a stream in the middle.
private struct Cut: Error {}

/// One answer to a connection attempt.
private enum Attempt: Sendable {
    /// An event stream that ends cleanly after `text`, is cut, or stays open.
    case stream(String, then: Ending = .end)
    case status(Int, String)
    case unreachable

    enum Ending { case end, cut, open }
}

/// Answers each connection with the next scripted attempt.
private final class ScriptedTransport: ClientTransport {
    private let attempts: Mutex<[Attempt]>

    init(_ attempts: [Attempt]) {
        self.attempts = Mutex(attempts)
    }

    func send(_ request: HTTPRequest, body _: HTTPBody?, baseURL: URL, operationID: String)
        async throws -> (HTTPResponse, HTTPBody?)
    {
        switch attempts.withLock({ $0.removeFirst() }) {
        case .stream(let text, let ending):
            let bytes = AsyncThrowingStream<ArraySlice<UInt8>, any Error> { continuation in
                continuation.yield(ArraySlice(text.utf8))
                switch ending {
                case .end: continuation.finish()
                case .cut: continuation.finish(throwing: Cut())
                case .open: break
                }
            }
            return (
                HTTPResponse(status: .ok, headerFields: [.contentType: "text/event-stream"]),
                HTTPBody(bytes, length: .unknown, iterationBehavior: .single)
            )
        case .status(let status, let json):
            return (
                HTTPResponse(
                    status: .init(code: status), headerFields: [.contentType: "application/json"]),
                HTTPBody(json)
            )
        case .unreachable:
            throw Cut()
        }
    }
}

/// Follows the stream through `attempts`; it stops at the wait after the last. The updates,
/// with any failure as "failed", and the waits.
private func follow(_ attempts: [Attempt]) async -> (
    updates: [ChangeStreamUpdate], waits: [Duration]
) {
    let server = AchtungServer(
        baseURL: URL(string: "http://achtung.test")!, transport: ScriptedTransport(attempts))
    var updates: [ChangeStreamUpdate] = []
    var waits: [Duration] = []
    await server.followChanges(
        sleep: { delay in
            waits.append(delay)
            if waits.count == attempts.count { throw CancellationError() }
        },
        { update in
            if case .down(let delay, .some) = update {
                updates.append(.down(retryingIn: delay, failure: "failed"))
            } else {
                updates.append(update)
            }
        })
    return (updates, waits)
}

private let ready = "retry: 5000\nevent: ready\ndata: {}\n\n"

@Test func aStreamCutAfterReadyReconnectsAfterTheRetryAndReadsEverythingAgain() async {
    // A gateway that cuts every request after its timeout: a stream that worked, so no
    // failure and no backoff, however often it happens.
    let changed = "event: changed\ndata: {\"kind\":\"occurrences\"}\n\n"
    let (updates, waits) = await follow([
        .stream(ready + changed, then: .cut),
        .stream(ready, then: .cut),
        .stream(ready, then: .end),
    ])

    #expect(
        updates == [
            .ready, .changed(.occurrences), .down(retryingIn: .seconds(5), failure: nil),
            .ready, .down(retryingIn: .seconds(5), failure: nil),
            .ready, .down(retryingIn: .seconds(5), failure: nil),
        ])
    #expect(waits == [.seconds(5), .seconds(5), .seconds(5)])
}

@Test func failingToConnectBacksOffAndSaysWhyOnce() async {
    let (updates, waits) = await follow([
        .unreachable,
        .status(503, #"{"error":"Too many event streams are open"}"#),
        .status(502, #"{"error":"Bad gateway"}"#),
        // Cut before ready: the gateway, or the server, failed it.
        .stream("", then: .cut),
        .stream("retry: 2000\nevent: ready\ndata: {}\n\n", then: .end),
    ])

    #expect(
        updates == [
            .down(retryingIn: .seconds(5), failure: "failed"),
            .down(retryingIn: .seconds(10), failure: nil),
            .down(retryingIn: .seconds(20), failure: nil),
            .down(retryingIn: .seconds(40), failure: nil),
            .ready, .down(retryingIn: .seconds(2), failure: nil),
        ])
    #expect(waits == [.seconds(5), .seconds(10), .seconds(20), .seconds(40), .seconds(2)])
}

@Test func cancelledItEndsWithoutAnotherUpdate() async {
    let server = AchtungServer(
        baseURL: URL(string: "http://achtung.test")!,
        transport: ScriptedTransport([.stream(ready, then: .open)]))

    // Its own task: cancelled by the first update, as a new connection cancels the last.
    let updates = await Task {
        var updates: [ChangeStreamUpdate] = []
        await server.followChanges { update in
            updates.append(update)
            withUnsafeCurrentTask { $0?.cancel() }
        }
        return updates
    }.value

    #expect(updates == [.ready])
}
